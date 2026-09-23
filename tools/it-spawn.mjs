// Integration: Run.spawn must create a worktree, start a worker in it, record
// its tokens against the ledger, and leave the task's branch behind.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Run } from '../electron/orchestrator/run.js';
import * as budget from '../electron/orchestrator/budget.js';

const repo = process.argv[2];
const run = new Run({ repo, goal: 'smoke', model: 'haiku', maxWorkers: 2, budgetTokens: 5_000_000 });

const result = await run.spawn('Reply with exactly: ok');
console.log('  spawn returned :', JSON.stringify(result));
assert.equal(result.state, 'running', 'spawn should start the worker, not queue it');
assert.match(result.branch, /^bw\//, 'worker should get a bw/ branch');

const worker = run.find(result.id);
assert.ok(existsSync(worker.cwd), `worktree should exist at ${worker.cwd}`);

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('worker never finished within 90s')), 90_000);
  run.on('change', () => {
    if (['done', 'errored', 'stopped'].includes(worker.state)) {
      clearTimeout(timer);
      resolve();
    }
  });
});

console.log('  worker state   :', worker.state);
console.log('  worker tokens  :', worker.tokens);
console.log('  ledger spent   :', run.ledger.spent);
console.log('  limits seen    :', JSON.stringify(worker.limits ?? null));
assert.equal(worker.state, 'done', 'worker should finish cleanly');
assert.ok(worker.tokens > 0, 'worker should report tokens');
assert.equal(run.ledger.spent, worker.tokens, 'ledger should match the worker');
assert.equal(budget.exhausted(run.ledger), false);
console.log('  PASS');
process.exit(0);
