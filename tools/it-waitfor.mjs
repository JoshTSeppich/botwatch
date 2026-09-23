// Integration: two tasks, one slot. The second must queue, then start when the
// first finishes, and wait_for must not return until both are done.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const repo = process.argv[2];
const mcp = spawn('node', [new URL('../electron/orchestrator/mcp.js', import.meta.url).pathname], {
  env: { ...process.env, BOTWATCH_RUN: JSON.stringify({ repo, model: 'haiku', maxWorkers: 1, budgetTokens: 5_000_000 }) },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map();
mcp.stdout.on('data', (c) => {
  buf += c;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    const msg = JSON.parse(l);
    pending.get(msg.id)?.(JSON.parse(msg.result.content[0].text));
    pending.delete(msg.id);
  }
});
let id = 0;
const call = (name, args = {}) =>
  new Promise((res) => {
    const rid = ++id;
    pending.set(rid, res);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });

const a = await call('spawn_worker', { task: 'Reply with exactly: a' });
const b = await call('spawn_worker', { task: 'Reply with exactly: b' });
console.log('  first  :', JSON.stringify(a));
console.log('  second :', JSON.stringify(b));
assert.equal(a.state, 'running');
assert.equal(b.state, 'queued', 'second worker must queue when the slot is full');

const waited = await Promise.race([
  call('wait_for', { ids: [a.id, b.id], until: 'done' }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('wait_for never returned within 150s')), 150_000)),
]);
console.log('  wait_for returned:', JSON.stringify(waited.map((w) => [w.id, w.state])));
assert.equal(waited.length, 2);
for (const w of waited) assert.equal(w.state, 'done', `${w.id} should be done, was ${w.state}`);
console.log('  PASS');
mcp.kill();
process.exit(0);
