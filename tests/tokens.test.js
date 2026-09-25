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
