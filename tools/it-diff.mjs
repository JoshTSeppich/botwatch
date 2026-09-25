// Integration: a worker's edits must show up in worker_diff. Workers don't
// commit (the sandbox keeps them out of .git; BotWatch snapshots their
// worktree), so worker_diff reports the uncommitted work.
import assert from 'node:assert/strict';
import { Run } from '../electron/orchestrator/run.js';
import * as worktrees from '../electron/orchestrator/worktrees.js';

const run = new Run({ repo: process.argv[2], goal: 'diff', model: 'haiku', maxWorkers: 1,
  budgetTokens: 5_000_000, permissionCeiling: 'acceptEdits' });

const { id } = await run.spawn(
  'Create a file named greeting.txt containing exactly the word hello. Nothing else.',
  'haiku',
  'acceptEdits',
);
const worker = run.find(id);
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('worker never finished')), 180_000);
  run.on('change', () => {
    if (['done', 'errored', 'stopped'].includes(worker.state)) { clearTimeout(t); resolve(); }
  });
});

console.log('  worker state :', worker.state, '| branch:', worker.branch);
const diff = await worktrees.diff(worker.cwd, worker.base);
console.log('  worker_diff  :', JSON.stringify(diff));
assert.ok(diff.files.length > 0, 'worker_diff should list the files the worker changed');
assert.ok(diff.added > 0, 'worker_diff should count added lines');
console.log('  PASS');
run.close();
process.exit(0);
