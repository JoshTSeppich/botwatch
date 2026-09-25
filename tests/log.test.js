// The worker log panel and take-over.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appendLog, LOG_CAP, logEntries, logSince } from '../electron/orchestrator/log.js';
import { canMergeBranch } from '../electron/orchestrator/policy.js';
import { takeOverWorker } from '../electron/orchestrator/pilot.js';
import { Run } from '../electron/orchestrator/run.js';
import { call } from '../electron/orchestrator/tools.js';

const assistant = (...content) => ({ type: 'assistant', message: { role: 'assistant', content } });
const user = (...content) => ({ type: 'user', message: { role: 'user', content } });

test('a tool call reads as what it ran', () => {
  assert.deepEqual(logEntries(assistant({ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } })), [{ kind: 'tool', text: '$ npm test' }]);
  assert.deepEqual(logEntries(assistant({ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.js' } })), [{ kind: 'tool', text: 'Edit src/a.js' }]);
  assert.deepEqual(logEntries(assistant({ type: 'tool_use', name: 'mcp__botwatch__wait_for', input: {} })), [{ kind: 'tool', text: 'wait_for' }]);
});

test('a tool result keeps its last lines, where the verdict usually is', () => {
  const output = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
  const [entry] = logEntries(user({ type: 'tool_result', content: output }));
  assert.equal(entry.kind, 'result');
  assert.equal(entry.text, '… 16 more lines\nline 17\nline 18\nline 19\nline 20');
  const [failed] = logEntries(user({ type: 'tool_result', content: 'boom', is_error: true }));
  assert.equal(failed.error, true);
});

test('what the model says, the session start and the turn end are logged; bookkeeping is not', () => {
  assert.deepEqual(logEntries(assistant({ type: 'text', text: 'Running the tests now.' })), [{ kind: 'text', text: 'Running the tests now.' }]);
  assert.deepEqual(logEntries({ type: 'system', subtype: 'init', session_id: 's' }), [{ kind: 'system', text: 'session started' }]);
  assert.deepEqual(logEntries({ type: 'result', is_error: false }), [{ kind: 'system', text: 'turn finished', error: false }]);
  assert.deepEqual(logEntries({ type: 'rate_limit_event' }), []);
});

test('the log is capped, and the panel asks for what is new by sequence', () => {
  const log = { seq: 0, items: [] };
  for (let i = 0; i < LOG_CAP + 50; i += 1) appendLog(log, [{ kind: 'text', text: String(i) }], i);
  assert.equal(log.items.length, LOG_CAP);
  assert.equal(log.items[0].seq, 51, 'the oldest dropped off the front');
  assert.deepEqual(logSince(log, log.seq - 2).map((x) => x.text), [String(LOG_CAP + 48), String(LOG_CAP + 49)]);
});

function runWithWorker(extra = {}) {
  const run = new Run({ repo: '/tmp', goal: 'g', model: 'haiku' });
  const worker = { id: 'w1', branch: 'bw/w1', cwd: "/tmp/it's here", sessionId: 'sess-1', state: 'running', stopped: false, ...extra };
  worker.stop = () => {
    worker.stopped = true;
    worker.state = 'stopped';
  };
  run.workers.push(worker);
  return { run, worker };
}

test('take over stops the worker, then resumes its session in its worktree', async () => {
  const { run, worker } = runWithWorker();
  const opened = [];
  const out = await takeOverWorker(run, 'w1', { open: async (c) => opened.push(c), waitMs: 10, trust: () => ({ trusted: 'x' }) });
  assert.equal(worker.stopped, true, 'stopped before the terminal opens');
  assert.equal(worker.takenOver, true);
  assert.deepEqual(opened, ["cd '/tmp/it'\\''s here' && claude --resume 'sess-1'"]);
  assert.equal(out.ok, true);
  assert.match((await takeOverWorker(run, 'w1', { open: async () => {}, trust: () => ({}) })).error, /already taken over/);
  clearInterval(run.reaper);
});

test('a worker with no session yet cannot be taken over', async () => {
  const { run } = runWithWorker({ sessionId: null });
  assert.match((await takeOverWorker(run, 'w1', { open: async () => {} })).error, /no session yet/);
  clearInterval(run.reaper);
});

test('after take over the orchestrator may not message or stop it, and the pill will not merge it', async () => {
  const { run, worker } = runWithWorker();
  await takeOverWorker(run, 'w1', { open: async () => {}, waitMs: 10, trust: () => ({}) });
  assert.match((await call(run, 'message_worker', { id: 'w1', text: 'hi' })).error, /taken over by the user; leave it/);
  assert.match((await call(run, 'stop_worker', { id: 'w1' })).error, /taken over/);
  const verdict = canMergeBranch({ ...worker, state: 'done', snapshot: { sha: 'a' } }, { reviewedSha: 'a', tipSha: 'a' });
  assert.match(verdict.reason, /taken over; its branch is yours/);
  clearInterval(run.reaper);
});

test("take over trusts only the worker's worktree, touching nothing else in Claude Code's config", async () => {
  const { trustFolder } = await import('../electron/orchestrator/trust.js');
  const { mkdtempSync, writeFileSync, readFileSync, realpathSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'bw-trust-'));
  const worktree = mkdtempSync(join(tmpdir(), 'bw-wt-'));
  const configPath = join(dir, 'claude.json');
  const original = { numStartups: 7, projects: { '/other': { hasTrustDialogAccepted: false, allowedTools: ['x'] } } };
  writeFileSync(configPath, JSON.stringify(original), { mode: 0o600 });

  const out = trustFolder(worktree, { configPath });
  assert.equal(out.changed, true);
  const after = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(after.projects[realpathSync(worktree)].hasTrustDialogAccepted, true);
  assert.deepEqual(after.projects['/other'], original.projects['/other'], 'other projects untouched');
  assert.equal(after.numStartups, 7, 'other keys untouched');
  assert.equal(statSync(configPath).mode & 0o777, 0o600, 'file mode kept');
  assert.equal(trustFolder(worktree, { configPath }).changed, false, 'idempotent');

  writeFileSync(configPath, '{ not json');
  assert.match(trustFolder(worktree, { configPath }).error, /left untouched/);
  assert.equal(readFileSync(configPath, 'utf8'), '{ not json', 'an unreadable config is never overwritten');
});
