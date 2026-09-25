// Recovering from a BotWatch that died mid-run, against real git repos. The
// live-process scenarios (kill -9 of pilld, a crashed worker) are in
// tools/it-recovery.mjs, which spends tokens.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import * as refguard from '../electron/orchestrator/refguard.js';
import { isOurs, recover, writeRecord } from '../electron/orchestrator/recovery.js';
import { processStart } from '../electron/orchestrator/proc.js';
import { Run } from '../electron/orchestrator/run.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'bw-rec-'));
  const r = join(root, 'repo');
  mkdirSync(r);
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 't@example.com');
  git(r, 'config', 'user.name', 'T');
  writeFileSync(join(r, 'a.js'), '1\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'init');
  return { root, repo: r, hook: join(r, '.git', 'hooks', 'reference-transaction') };
}

function record(runsDir, id, body) {
  mkdirSync(join(runsDir, id), { recursive: true });
  writeFileSync(join(runsDir, id, 'run.json'), JSON.stringify({ id, ...body }));
}

test("uninstall removes BotWatch's hook and restores yours, and never deletes yours alone", async () => {
  const { repo: r, hook } = repo();
  writeFileSync(hook, '#!/bin/sh\n# the user\'s own hook\nexit 0\n', { mode: 0o755 });
  await refguard.install(r);
  assert.match(readFileSync(hook, 'utf8'), /Installed by BotWatch/);
  assert.equal(await refguard.uninstall(r), true);
  assert.match(readFileSync(hook, 'utf8'), /the user's own hook/, 'chained hook put back');
  assert.equal(await refguard.uninstall(r), false, 'a second uninstall is a no-op');
  assert.match(readFileSync(hook, 'utf8'), /the user's own hook/, 'and did not delete the user hook');
});

test('recover cleans up a run whose BotWatch is dead, once, and keeps its branches', async () => {
  const { root, repo: r, hook } = repo();
  git(r, 'branch', 'bw/w1-task');
  await refguard.install(r);
  const runsDir = join(root, 'runs');
  record(runsDir, 'dead', { repo: r, owner: 999_001, workers: [{ id: 'w1', branch: 'bw/w1-task', pid: 999_002 }] });
  record(runsDir, 'live', { repo: r, owner: 999_003, workers: [] });
  record(runsDir, 'closed', { repo: r, owner: 999_004, closed: true, workers: [] });
  const isAlive = (pid) => pid === 999_003;

  const reports = await recover({ runsDir, self: 1, isAlive });
  assert.deepEqual(reports.map((x) => x.id), ['dead'], 'only the dead, unclosed run');
  assert.equal(reports[0].hookRemoved, true);
  assert.deepEqual(reports[0].kept, ['bw/w1-task']);
  assert.deepEqual(reports[0].stopped, [], 'a pid that is not alive is not killed');
  assert.equal(existsSync(hook), false);
  assert.equal(git(r, 'branch', '--list', 'bw/w1-task').includes('bw/w1-task'), true, 'branch kept');
  assert.ok(JSON.parse(readFileSync(join(runsDir, 'dead', 'run.json'), 'utf8')).recoveredAt);
  assert.deepEqual(await recover({ runsDir, self: 1, isAlive }), [], 'done once');
});

test('recover never kills a live pid that is not claude', async () => {
  const { root, repo: r } = repo();
  const runsDir = join(root, 'runs');
  // This test process is alive and is node, not claude: a reused pid.
  record(runsDir, 'reused', { repo: r, owner: 999_005, workers: [{ id: 'w1', branch: 'bw/x', pid: process.pid }] });
  const reports = await recover({ runsDir, self: 1, isAlive: (pid) => pid === process.pid });
  assert.deepEqual(reports[0].stopped, []);
  assert.deepEqual(reports[0].spared, ['w1']);
});

test("recover prunes a BotWatch worktree whose folder is gone, but not a user's", async () => {
  const { root, repo: r } = repo();
  const ours = join(root, '.botwatch-worktrees', 'bw-w1');
  git(r, 'worktree', 'add', '-q', '-b', 'bw/w1', ours);
  execFileSync('rm', ['-rf', ours]);
  const runsDir = join(root, 'runs');
  record(runsDir, 'r1', { repo: r, owner: 999_006, workers: [{ id: 'w1', branch: 'bw/w1' }] });
  const [report] = await recover({ runsDir, self: 1, isAlive: () => false });
  assert.equal(report.pruned.length, 1);
  assert.equal(git(r, 'worktree', 'list').includes('bw-w1'), false);
  assert.equal(git(r, 'branch', '--list', 'bw/w1').includes('bw/w1'), true, 'the branch holds the work');

  // A user's missing worktree alongside: nothing is pruned.
  const { root: root2, repo: r2 } = repo();
  const users = join(root2, 'elsewhere');
  git(r2, 'worktree', 'add', '-q', '-b', 'mine', users);
  const ours2 = join(root2, '.botwatch-worktrees', 'bw-w2');
  git(r2, 'worktree', 'add', '-q', '-b', 'bw/w2', ours2);
  execFileSync('rm', ['-rf', users, ours2]);
  record(runsDir, 'r2', { repo: r2, owner: 999_007, workers: [] });
  const [report2] = (await recover({ runsDir, self: 1, isAlive: () => false })).filter((x) => x.id === 'r2');
  assert.deepEqual(report2.pruned, []);
  assert.equal(git(r2, 'worktree', 'list').includes('elsewhere'), true, "the user's record is untouched");
});

test('a leftover index.lock stops the merge with a message that says what it is', async () => {
  const { repo: r } = repo();
  git(r, 'branch', 'bw/w1-task');
  const run = new Run({ repo: r, goal: 'g', model: 'haiku' });
  const sha = git(r, 'rev-parse', 'bw/w1-task');
  run.workers.push({ id: 'w1', branch: 'bw/w1-task', base: 'main', cwd: r, state: 'done', snapshot: { sha } });
  run.reviewAll = async () => [{ id: 'w1', branch: 'bw/w1-task', sha, flagged: [] }];
  run.userApprovedMerge = true;
  writeFileSync(join(r, '.git', 'index.lock'), '');
  const out = await run.merge({ reviewed: [{ branch: 'bw/w1-task', sha }] });
  assert.match(out.error, /git is locked: .*index\.lock exists/);
  clearInterval(run.reaper);
});

// A real process to point records at: alive, and not ours to lose.
function sleeper() {
  const child = spawn('sleep', ['60']);
  return child;
}
const alivePid = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a pid that is alive and is claude but started later is left alone', async () => {
  const { root, repo: r } = repo();
  const target = sleeper();
  await new Promise((res) => setTimeout(res, 200));
  const runsDir = join(root, 'runs');
  // The record says w1 started a year ago; this pid started just now.
  record(runsDir, 'reused', {
    repo: r,
    owner: 999_010,
    ownerStart: 'Mon Jan 1 00:00:00 2024',
    workers: [{ id: 'w1', branch: 'bw/w1', pid: target.pid, start: 'Mon Jan 1 00:05:00 2024' }],
  });
  const reports = await recover({ runsDir, self: 1, isAlive: alivePid, claude: async () => true });
  assert.deepEqual(reports[0].stopped, []);
  assert.deepEqual(reports[0].spared, ['w1']);
  assert.equal(alivePid(target.pid), true, 'still running');
  target.kill();
});

test('the same pid with the recorded start time is stopped', async () => {
  const { root, repo: r } = repo();
  const target = sleeper();
  await new Promise((res) => setTimeout(res, 200));
  const runsDir = join(root, 'runs');
  record(runsDir, 'ours', {
    repo: r,
    owner: 999_011,
    workers: [{ id: 'w1', branch: 'bw/w1', pid: target.pid, start: await processStart(target.pid) }],
  });
  const exited = new Promise((res) => target.on('exit', res));
  const reports = await recover({ runsDir, self: 1, isAlive: alivePid, claude: async () => true });
  assert.deepEqual(reports[0].stopped, ['w1']);
  await exited;
});

test('with no recorded start time, nothing is signalled', async () => {
  const target = sleeper();
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(await isOurs(target.pid, null, { claude: async () => true }), false);
  target.kill();
});

test("a live owner pid with a different start time is not the owner: the run is recovered", async () => {
  const { root, repo: r } = repo();
  const stranger = sleeper();
  await new Promise((res) => setTimeout(res, 200));
  const runsDir = join(root, 'runs');
  record(runsDir, 'orphan', { repo: r, owner: stranger.pid, ownerStart: 'Mon Jan 1 00:00:00 2024', workers: [] });
  const reports = await recover({ runsDir, self: 1, isAlive: alivePid });
  assert.deepEqual(reports.map((x) => x.id), ['orphan']);
  assert.equal(alivePid(stranger.pid), true, 'the stranger holding the old owner pid is untouched');
  stranger.kill();
});

test('the record written for a run carries each pid\'s start time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-rec-write-'));
  await writeRecord(dir, { id: 'x', owner: process.pid, workers: [{ id: 'w1', pid: process.pid }] });
  const written = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  assert.equal(written.ownerStart, await processStart(process.pid));
  assert.equal(written.workers[0].start, await processStart(process.pid));
});

test('a run closed while a record write is scheduled stays closed', async () => {
  const { createRecorder } = await import('../electron/orchestrator/recovery.js');
  const writes = [];
  const recorder = createRecorder('/dir', () => ({ closed: false }), { delayMs: 30, write: async (_d, r) => writes.push(r) });
  recorder.schedule();
  await recorder.close({ closed: true });
  recorder.schedule();
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(writes, [{ closed: true }], 'the scheduled write was cancelled, and nothing followed the close');
});
