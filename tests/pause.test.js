// Pause and Resume keep every session: a pause interrupts the turn in flight
// and a resume continues it. Measured on the real CLI in tools/it-pause.mjs.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { allowanceLabel, measuredWeekLabel, weeklyAllowance } from '../electron/orchestrator/allowance.js';
import { canSpawn } from '../electron/orchestrator/policy.js';
import { Run } from '../electron/orchestrator/run.js';
import { call } from '../electron/orchestrator/tools.js';
import { Worker } from '../electron/orchestrator/worker.js';

// A Worker whose process is a stub: what it's sent is recorded, and stream
// records can be fed back in as if the CLI wrote them.
function stubWorker() {
  const w = new Worker({ id: 'w1', task: 't', cwd: '/tmp', model: 'haiku', permissionMode: 'acceptEdits' });
  const sent = [];
  const stdout = new EventEmitter();
  w.child = { stdin: { writable: true, write: (s) => sent.push(JSON.parse(s)) }, stdout, kill() {} };
  w.state = 'running';
  const feed = (record) => w._feed(record);
  return { w, sent, feed };
}

test('pause sends the interrupt, and the interrupted turn is not an error or a finish', () => {
  const { w, sent, feed } = stubWorker();
  assert.equal(w.pause(), true);
  assert.equal(w.state, 'paused');
  assert.equal(sent[0].type, 'control_request');
  assert.equal(sent[0].request.subtype, 'interrupt');
  feed({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: { input_tokens: 10, output_tokens: 5 } });
  assert.equal(w.state, 'paused', 'not errored');
  assert.equal(w.doneAt, undefined, 'not finished, so nothing is snapshotted');
  assert.equal(w.tokens, 15, "the interrupted turn's tokens are still counted");
});

test('resume continues the same session', () => {
  const { w, sent } = stubWorker();
  w.pause();
  assert.equal(w.resume(), true);
  assert.equal(w.state, 'running');
  assert.equal(sent.at(-1).type, 'user');
  assert.match(sent.at(-1).message.content[0].text, /Continue where you left off/);
});

function runWithStubs(n = 2) {
  const run = new Run({ repo: '/tmp', goal: 'g', model: 'haiku', budgetTokens: 1000 });
  const stubs = Array.from({ length: n }, (_, i) => {
    const s = stubWorker();
    s.w.id = `w${i + 1}`;
    run.workers.push(s.w);
    return s;
  });
  return { run, stubs };
}

test('pause all pauses every running worker; while paused nothing new starts', () => {
  const { run } = runWithStubs();
  run.pauseAll('user');
  assert.deepEqual(run.workers.map((w) => w.state), ['paused', 'paused']);
  assert.deepEqual(canSpawn(run.state, run.limits), { ok: false, reason: 'paused by the user', queue: true });
  clearInterval(run.reaper);
});

test('the orchestrator cannot message a paused worker awake', async () => {
  const { run } = runWithStubs(1);
  run.pauseAll('user');
  assert.match((await call(run, 'message_worker', { id: 'w1', text: 'go on' })).error, /paused by the user/);
  assert.equal(run.workers[0].state, 'paused');
  clearInterval(run.reaper);
});

test('resume all continues them; after a budget pause it waits for a raise', () => {
  const { run } = runWithStubs();
  run.pauseAll('user');
  assert.deepEqual(run.resumeAll(), { resumed: 2 });
  assert.deepEqual(run.workers.map((w) => w.state), ['running', 'running']);

  run.ledger.spent = 1000;
  run.pauseAll('budget');
  assert.match(run.resumeAll().error, /budget is spent/);
  assert.deepEqual(run.raiseBudget(500), { limit: 1500 });
  assert.deepEqual(run.resumeAll(), { resumed: 2 });
  clearInterval(run.reaper);
});

test('stop still ends every process, running or paused', () => {
  const { run } = runWithStubs();
  const stopped = [];
  for (const w of run.workers) w.stop = () => stopped.push(w.id);
  run.workers[1].state = 'paused';
  run.stop();
  assert.deepEqual(stopped, ['w1', 'w2']);
  clearInterval(run.reaper);
});

test("the allowance line uses a limit you set, or says only what was measured, or nothing", () => {
  const now = 1_000_000_000;
  const measured = weeklyAllowance({ cached: { sevenDay: { utilization: 0.47 }, at: now - 12 * 60_000 }, now });
  assert.equal(allowanceLabel(1_000_000, measured, null), null, 'no limit in tokens: no share of it');
  assert.equal(measuredWeekLabel(measured), 'Week 47% used · measured 12m ago');
  const entered = weeklyAllowance({ enteredLimit: 10_000_000, spent: 5_000_000 });
  assert.equal(allowanceLabel(1_000_000, entered, 10_000_000), "≈ 20% of what's left this week · from the limit you set");
  assert.equal(measuredWeekLabel(weeklyAllowance({})), null);
});
