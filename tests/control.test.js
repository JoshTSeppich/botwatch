// The orchestrator's line into pilld: the relay reaches the run the pill
// holds, only with the run's token, and nothing it can call merges.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { controlClient, serveControl } from '../electron/orchestrator/control.js';
import { runView } from '../electron/orchestrator/pilot.js';
import { Run } from '../electron/orchestrator/run.js';
import { scriptPath, scriptShellCommand } from '../electron/orchestrator/runtime.js';
import { call } from '../electron/orchestrator/tools.js';

const sock = () => join(mkdtempSync(join(tmpdir(), 'bw-ctl-')), 'control.sock');
const fakeRun = () => new Run({ repo: '/tmp', goal: 'g', model: 'haiku' });
// The workers here are plain records, so the run is disposed of, not closed.
const dispose = (run) => clearInterval(run.reaper);

test('the relay reaches the run with its token, and not without it', async () => {
  const path = sock();
  const run = fakeRun();
  run.workers.push({ id: 'w1', task: 't', state: 'done', branch: 'bw/t', model: 'haiku', tokens: 5 });
  const server = await serveControl(() => ({ run, token: 'right' }), path);
  try {
    const good = controlClient(path, 'right');
    assert.deepEqual((await good.call('list_workers', {})).map((w) => w.id), ['w1']);
    const bad = controlClient(path, 'wrong');
    assert.deepEqual(await bad.call('list_workers', {}), { error: 'not this run' });
    good.close();
    bad.close();
  } finally {
    dispose(run);
    server.close();
  }
});

test('with no run going, every tool says so', async () => {
  const path = sock();
  const server = await serveControl(() => null, path);
  try {
    const client = controlClient(path, 'x');
    assert.match((await client.call('list_workers', {})).error, /no orchestrator run/);
    client.close();
  } finally {
    server.close();
  }
});

test('with BotWatch down, the relay answers with an error instead of hanging', async () => {
  const client = controlClient(sock(), 'x');
  assert.match((await client.call('list_workers', {})).error, /not running|closed/);
});

test('merge_worktrees never merges, even in the moment the user has clicked', async () => {
  const run = fakeRun();
  let merged = false;
  run.merge = async () => {
    merged = true;
    return { merged: [] };
  };
  run.userApprovedMerge = true;
  const out = await call(run, 'merge_worktrees', { order: ['bw/x'] });
  assert.match(out.error, /user merges from the pill/);
  assert.equal(merged, false);
  dispose(run);
});

test('mcp.js relays tools/call to pilld over the socket, as a real process', async () => {
  const path = sock();
  const run = fakeRun();
  run.workers.push({ id: 'w1', task: 't', state: 'running', branch: 'bw/t', model: 'haiku', tokens: 0 });
  const server = await serveControl(() => ({ run, token: 'tok' }), path);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../electron/orchestrator/mcp.js', import.meta.url))], {
    env: { ...process.env, BOTWATCH_CONTROL_SOCK: path, BOTWATCH_RUN_TOKEN: 'tok' },
  });
  try {
    const lines = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => lines.push(...d.split('\n').filter(Boolean)));
    const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    send({ id: 1, method: 'tools/list' });
    send({ id: 2, method: 'tools/call', params: { name: 'list_workers', arguments: {} } });
    for (let i = 0; i < 100 && lines.length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
    const byId = new Map(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
    assert.ok(byId.get(1).result.tools.some((t) => t.name === 'spawn_worker'));
    assert.deepEqual(JSON.parse(byId.get(2).result.content[0].text).map((w) => w.id), ['w1']);
  } finally {
    child.kill();
    dispose(run);
    server.close();
  }
});

test('a run is ready to review only once every worker is finished, snapshotted and tested', () => {
  const run = fakeRun();
  const live = { run, orchestrator: { state: 'done' }, startedAt: 0, closed: false };
  run.workers.push({ id: 'w1', state: 'done', snapshot: { sha: 'a' }, test: { running: true } });
  run.workers.push({ id: 'w2', state: 'running' });
  let view = runView(live, 1000);
  assert.equal(view.ready, false);
  assert.equal(view.sentence, '1 of 2 tasks done');

  run.workers[0].test = { passed: true };
  run.workers[1].state = 'done';
  assert.equal(runView(live, 1000).ready, false, 'w2 has no snapshot yet');
  run.workers[1].snapshot = { sha: 'b' };
  view = runView(live, 1000);
  assert.equal(view.ready, true);
  assert.equal(view.sentence, 'Ready to review · 2 branches');
  dispose(run);
});

test('scripts outside the asar are addressed where the packaged app unpacks them', () => {
  const url = new URL('file:///Applications/BotWatch.app/Contents/Resources/app.asar/electron/orchestrator/guard.mjs');
  assert.equal(scriptPath(url), '/Applications/BotWatch.app/Contents/Resources/app.asar.unpacked/electron/orchestrator/guard.mjs');
  // In a checkout nothing changes, and the command runs on this runtime, not a `node` on PATH.
  const here = new URL('../electron/orchestrator/guard.mjs', import.meta.url);
  assert.equal(scriptShellCommand(here), `${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(here))}`);
});
