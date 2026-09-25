// Integration: two tasks, one slot, through the real MCP relay. The second
// must queue, then start when the first finishes, and wait_for must not
// return until both are done.
//
//   node tools/it-waitfor.mjs [repo]
//
// Spends tokens (haiku). Without a repo it makes a scratch one. The run is
// hosted the way pilld hosts it: a Run behind the control socket, with
// mcp.js relaying JSON-RPC to it using the run's token.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newToken, serveControl } from '../electron/orchestrator/control.js';
import { Run } from '../electron/orchestrator/run.js';

function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), 'bw-it-waitfor-'));
  const repo = join(root, 'greeter');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, ...a]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'src/greet.js'), 'export const greet = (n) => `Hello, ${n}!`;\n');
  git('add', '-A');
  git('-c', 'user.email=it@example.com', '-c', 'user.name=IT', 'commit', '-q', '-m', 'greeter');
  return { root, repo };
}

const scratch = process.argv[2] ? null : scratchRepo();
const repo = process.argv[2] ?? scratch.repo;
const sockDir = mkdtempSync(join(tmpdir(), 'bw-sock-'));
const sock = join(sockDir, 'control.sock');

const run = new Run({ repo, goal: 'waitfor', model: 'haiku', maxWorkers: 1, budgetTokens: 5_000_000, permissionCeiling: 'acceptEdits' });
await run.arm();
const token = newToken();
const server = await serveControl(() => ({ run, token }), sock);

const mcp = spawn(process.execPath, [new URL('../electron/orchestrator/mcp.js', import.meta.url).pathname], {
  env: { ...process.env, BOTWATCH_CONTROL_SOCK: sock, BOTWATCH_RUN_TOKEN: token },
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

// A relayed call from anyone without the token is refused.
const { controlClient } = await import('../electron/orchestrator/control.js');
const stranger = controlClient(sock, 'not-the-token');
const refused = await stranger.call('list_workers', {});
console.log('  wrong token:', JSON.stringify(refused));
assert.equal(refused.error, 'not this run');

const waited = await Promise.race([
  call('wait_for', { ids: [a.id, b.id], until: 'done' }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('wait_for never returned within 150s')), 150_000)),
]);
console.log('  wait_for returned:', JSON.stringify(waited.map((w) => [w.id, w.state])));
assert.equal(waited.length, 2);
for (const w of waited) assert.equal(w.state, 'done', `${w.id} should be done, was ${w.state}`);
console.log('  PASS');

mcp.kill();
server.close();
await run.close();
rmSync(sockDir, { recursive: true, force: true });
if (scratch) rmSync(scratch.root, { recursive: true, force: true });
process.exit(0);
