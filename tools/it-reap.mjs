// Integration: ten tasks over two slots must not leave ten claude processes.
// Counts real processes before, during and after.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Run } from '../electron/orchestrator/run.js';

const run = promisify(execFile);
const count = async () =>
  run('sh', ['-c', 'pgrep -f "claude -p --output-format stream-json" | wc -l'])
    .then(({ stdout }) => Number(stdout.trim()))
    .catch(() => 0);

const before = await count();
const r = new Run({ repo: process.argv[2], goal: 'reap', model: 'haiku', maxWorkers: 2, budgetTokens: 50_000_000 });

const ids = [];
for (let i = 1; i <= 10; i += 1) ids.push((await r.spawn(`Reply with exactly: ${i}`)).id);
console.log('  spawned:', ids.length, 'tasks over', r.limits.maxWorkers, 'slots');

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('run did not finish in 8 minutes')), 480_000);
  const check = () => {
    if (r.workers.every((w) => ['done', 'errored', 'stopped'].includes(w.state))) {
      clearTimeout(timer);
      resolve();
    }
  };
  r.on('change', check);
});

const peak = await count();
console.log('  live claude workers right after the last task:', peak);

// Reap with a zero idle window rather than waiting out the real one.
const released = r.reap(Date.now(), 0);
console.log('  released by reap:', released);
await new Promise((res) => setTimeout(res, 8000));

const after = await count();
console.log('  live claude workers after reap:', after, '(was', before, 'before the run)');

const stranded = r.workers.find((w) => w.doneAt === null && w.child?.stdin.writable === false);
console.log('  message to a released worker:', JSON.stringify(stranded ? stranded.message('hello') : 'n/a'));

assert.equal(after, before, 'no worker processes should survive the reap');
console.log('  PASS');
r.close();
process.exit(0);
