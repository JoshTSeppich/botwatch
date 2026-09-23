// Spawns one real worker against a throwaway repo and prints what came back.
// Not part of `npm test`: it costs tokens and needs a logged-in CLI. Run it
// after touching worker.js, because the unit tests cannot tell you that the
// process actually talks.
//
//   node tools/smoke-worker.mjs /path/to/a/git/repo

import { Worker } from '../electron/orchestrator/worker.js';

const cwd = process.argv[2];
if (!cwd) {
  console.error('usage: node tools/smoke-worker.mjs <repo>');
  process.exit(1);
}

const worker = new Worker({
  id: 'w1',
  task: 'Reply with exactly: ok',
  cwd,
  branch: 'bw/smoke',
  model: 'haiku',
  permissionMode: 'plan',
});

const done = new Promise((resolve) =>
  worker.on('change', () => ['done', 'errored', 'stopped'].includes(worker.state) && resolve()),
);
worker.start();
await Promise.race([done, new Promise((r) => setTimeout(r, 90_000))]);

console.log('state    :', worker.state);
console.log('session  :', worker.sessionId ?? '(none — the worker never started)');
console.log('tokens   :', worker.tokens);
console.log('limits   :', JSON.stringify(worker.limits ?? null));
worker.stop();
process.exit(worker.state === 'done' ? 0 : 1);
