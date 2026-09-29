import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { countUsage, createMessageCounter, createMeter, sessionTotal } from '../electron/tokens.js';
import { Worker } from '../electron/orchestrator/worker.js';

const usage = (input, output, write = 0, read = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
});
const assistant = (id, u, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id, usage: u, content: [] } });

test('cache reads are never counted', () => {
  assert.equal(countUsage(usage(10, 5, 2, 999_999)), 17);
});

test('one message written as several records counts once', () => {
  const c = createMessageCounter();
  // The measured shape: three content blocks, three records, the same usage.
  const added = [c.add('m1', usage(8, 1, 23_796)), c.add('m1', usage(8, 1, 23_796)), c.add('m1', usage(8, 1, 23_796))];
  assert.deepEqual(added, [23_805, 0, 0]);
});

test('a later, larger sighting of a message adds only the difference', () => {
  const c = createMessageCounter();
  c.add('m1', usage(8, 1, 100));
  assert.equal(c.add('m1', usage(8, 1080, 100)), 1079);
  assert.equal(c.add('m1', usage(8, 3, 100)), 0, 'an early record read late does not take it back');
});

test('the session total is modelUsage across models, subagents included', () => {
  assert.equal(
    sessionTotal({
      a: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 2, cacheReadInputTokens: 1e9 },
      b: { inputTokens: 1, outputTokens: 1 },
    }),
    19,
  );
  assert.equal(sessionTotal(undefined), null);
});

test('the meter reproduces the measured turn: 9 records, 3 messages, trued up to the session total', () => {
  const m = createMeter();
  let sum = 0;
  // Stream records carry output as it stood when the message began.
  for (const [id, u] of [
    ['m1', usage(10, 3, 5_651)],
    ['m1', usage(10, 3, 5_651)],
    ['m2', usage(8, 2, 23_796)],
    ['m2', usage(8, 2, 23_796)],
    ['m2', usage(8, 2, 23_796)],
    ['m3', usage(8, 1, 1_819)],
    ['m3', usage(8, 1, 1_819)],
    ['m3', usage(8, 1, 1_819)],
    ['m3', usage(8, 1, 1_819)],
  ]) sum += m.absorb(assistant(id, u));
  assert.equal(sum, 5_664 + 23_806 + 1_828, 'each message once, before its output is known');
  // The result's modelUsage is the session's own total; the gap is output.
  sum += m.absorb({ type: 'result', modelUsage: { haiku: { inputTokens: 26, outputTokens: 1_398, cacheCreationInputTokens: 31_266 } } });
  assert.equal(sum, 32_690);
  assert.equal(m.total, 32_690);
});

test('subagent messages count too, and the result trues them up', () => {
  const m = createMeter();
  m.absorb(assistant('main1', usage(10, 1, 1_000)));
  m.absorb(assistant('sub1', usage(10, 1, 5_000), 'toolu_1'));
  m.absorb(assistant('sub1', usage(10, 1, 5_000), 'toolu_1'));
  assert.equal(m.total, 6_022);
  m.absorb({ type: 'result', modelUsage: { haiku: { inputTokens: 20, outputTokens: 500, cacheCreationInputTokens: 6_000 } } });
  assert.equal(m.total, 6_520);
});

test('after a result, new messages add on top of it; the meter never goes down', () => {
  const m = createMeter();
  m.absorb(assistant('m1', usage(10, 1, 1_000)));
  m.absorb({ type: 'result', modelUsage: { x: { inputTokens: 10, outputTokens: 200, cacheCreationInputTokens: 1_000 } } });
  assert.equal(m.total, 1_210);
  m.absorb(assistant('m2', usage(5, 1, 100)));
  assert.equal(m.total, 1_316);
  // A total below what was already counted (it shouldn't happen) takes nothing back.
  m.absorb({ type: 'result', modelUsage: { x: { inputTokens: 1, outputTokens: 1 } } });
  assert.equal(m.total, 1_316);
});

test('a result with no modelUsage leaves the per-message count standing', () => {
  const m = createMeter();
  m.absorb(assistant('m1', usage(10, 5, 0)));
  assert.equal(m.absorb({ type: 'result', usage: usage(10, 50, 0) }), 0);
  assert.equal(m.total, 15);
});

function stubWorker() {
  const w = new Worker({ id: 'w1', task: 't', cwd: '/tmp', model: 'haiku', permissionMode: 'acceptEdits' });
  w.child = { stdin: { writable: true, write() {} }, stdout: new EventEmitter(), kill() {} };
  w.state = 'running';
  return w;
}

test('a worker counts each message once, not once per record', () => {
  const w = stubWorker();
  let emitted = 0;
  w.on('tokens', (_w, t) => (emitted += t));
  for (let i = 0; i < 3; i += 1) w._feed(assistant('m1', usage(10, 1, 100)));
  assert.equal(w.tokens, 111);
  assert.equal(emitted, 111);
});

test('a turn that ends with background tasks still running is not finished', () => {
  const w = stubWorker();
  w._feed({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1' }] });
  w._feed({ type: 'result', is_error: false, result: 'launched, waiting' });
  assert.equal(w.state, 'running');
  assert.equal(w.doneAt, undefined, 'nothing to snapshot yet');
  w._feed({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(w.state, 'running', 'the session reports back in a turn of its own');
  w._feed({ type: 'result', is_error: false, result: 'done' });
  assert.equal(w.state, 'done');
  assert.ok(w.doneAt);
});

test("the meter knows a session's largest step", () => {
  const m = createMeter();
  m.absorb(assistant('m1', usage(10, 1, 1_000)));
  m.absorb(assistant('m2', usage(10, 1, 9_000)));
  m.absorb(assistant('m2', usage(10, 1, 9_000)));
  m.absorb(assistant('m3', usage(10, 1, 200)));
  assert.equal(m.largestStep, 9_011);
});

test("the meter knows a session's first step", () => {
  const m = createMeter();
  m.absorb(assistant('m1', usage(10, 1, 15_000)));
  m.absorb(assistant('m2', usage(10, 1, 30_000)));
  m.absorb(assistant('m1', usage(10, 400, 15_000)));
  assert.equal(m.firstStep, 15_410, 'the first message, at its largest sighting');
  assert.equal(createMeter().firstStep, 0);
});

test('after an interrupt the count is raised to the transcript, never lowered, and later messages still count', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'bw-reconcile-'));
  const cwd = '/Users/x/wt';
  const dir = join(root, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(join(dir, 's1', 'subagents'), { recursive: true });
  const line = (id, u) => `${JSON.stringify({ type: 'assistant', message: { id, usage: u } })}\n`;
  // The stream saw m1 and m2 at their start; the transcript has their final output.
  writeFileSync(join(dir, 's1.jsonl'), line('m1', usage(10, 1, 1_000)) + line('m1', usage(10, 900, 1_000)) + line('m2', usage(5, 700, 200)));
  writeFileSync(join(dir, 's1', 'subagents', 'agent-a.jsonl'), line('x1', usage(5, 100, 400)));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const w = stubWorker();
    w.cwd = cwd;
    w.sessionId = 's1';
    let emitted = 0;
    w.on('tokens', (_w, t) => (emitted += t));
    w._feed(assistant('m1', usage(10, 1, 1_000)));
    w._feed(assistant('m2', usage(5, 1, 200)));
    assert.equal(w.tokens, 1_217);
    const added = w.reconcile();
    assert.equal(added, 1_910 + 905 + 505 - 1_217, 'main and subagent transcripts, each message once');
    assert.equal(w.tokens, 3_320);
    assert.equal(emitted, 3_320, 'the ledger hears it as tokens');
    assert.equal(w.reconcile(), 0, 'a second look adds nothing');
    w._feed(assistant('m3', usage(10, 1, 300)));
    assert.equal(w.tokens, 3_631, 'a later message still counts in full');
  } finally {
    if (before == null) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});
