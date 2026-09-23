// Integration: the orchestrator must be able to talk to a running worker.
// Send a second message after the first turn and expect a second answer.
import assert from 'node:assert/strict';
import { Worker } from '../electron/orchestrator/worker.js';

const worker = new Worker({ id: 'w1', task: 'Reply with exactly: one', cwd: process.argv[2],
  branch: 'bw/msg', model: 'haiku', permissionMode: 'plan' });

const replies = [];
worker.on('change', () => { if (worker.summary) replies.push(worker.summary); });
worker.start();

const settle = () => new Promise((r) => setTimeout(r, 25_000));
await settle();
console.log('  after task 1 : state =', worker.state, '| replies =', JSON.stringify([...new Set(replies)]));

const delivered = worker.message('Reply with exactly: two');
console.log('  second message delivered to stdin:', delivered);
await settle();
console.log('  after task 2 : state =', worker.state, '| replies =', JSON.stringify([...new Set(replies)]));

assert.ok(delivered, 'stdin should still be writable for a second message');
assert.ok(
  [...new Set(replies)].some((r) => /two/i.test(r)),
  'the worker should answer the second message',
);
console.log('  PASS');
worker.stop();
process.exit(0);
