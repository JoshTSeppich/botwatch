// Integration: what BotWatch recovers from, with real processes.
//
//   node tools/it-recovery.mjs
//
// Not part of `npm test`: it spends tokens (haiku) and needs a logged-in CLI.
// Each scenario prints what it did and what it found, and the script exits
// non-zero if any check failed.
//
//   1. pilld killed mid-run (SIGKILL): processes orphaned, ref hook left in
//      the repo. Then a worktree folder is deleted by hand. recover() stops
//      the orphans, removes the hook, prunes the missing worktree, keeps
//      every branch.
//   2. a worker crashes (kill -9): its partial work is snapshotted and
//      reviewable, and it cannot be merged.
//   3. a session file whose pid now belongs to another process is ignored.
//   4. a merge after a git process was killed mid-write (index.lock) is
//      refused with a message that says so, and works once the lock is gone.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveControl } from '../electron/orchestrator/control.js';
import { createPilot } from '../electron/orchestrator/pilot.js';
import { recover, RUNS_DIR } from '../electron/orchestrator/recovery.js';
import { read as readSessions } from '../electron/sessions.live.js';

const here = dirname(fileURLToPath(import.meta.url));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), 'bw-it-recovery-'));
  const repo = join(root, 'greeter');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'test'));
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'it@example.com');
  git(repo, 'config', 'user.name', 'IT');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'greeter', type: 'module', scripts: { test: 'node --test' } }));
  writeFileSync(join(repo, 'src/greet.js'), 'export const greet = (n) => `Hello, ${n}!`;\n');
  writeFileSync(join(repo, 'test/greet.test.js'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { greet } from '../src/greet.js';\ntest('greet', () => assert.equal(greet('A'), 'Hello, A!'));\n");
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'greeter');
  return { root, repo, hook: join(repo, '.git', 'hooks', 'reference-transaction') };
}

// A task that keeps a worker busy long enough to be killed mid-turn: a shell
// loop the sandbox runs without asking, then a small edit.
const SLOW = (file) =>
  `First run this with the Bash tool, in the foreground, with timeout 300000: for i in $(seq 1 150); do npm test >/dev/null 2>&1; done. Then create ${file} exporting a function, and a test for it.`;

async function scenarioKilledHost() {
  console.log('\n1. pilld killed mid-run, then a worktree folder deleted by hand');
  const { root, repo, hook } = scratchRepo();
  const control = join(root, 'control.sock');
  const goal = `Two tasks, one worker each, started at once, task text passed word for word. Task "a": ${SLOW('src/a.js')} Task "b": ${SLOW('src/b.js')}`;
  const host = spawn(process.execPath, [join(here, 'it-recovery-host.mjs'), repo, control, goal], { stdio: ['ignore', 'pipe', 'inherit'] });
  let last = null;
  host.stdout.setEncoding('utf8');
  host.stdout.on('data', (d) => {
    for (const line of d.split('\n').filter(Boolean)) {
      try {
        last = JSON.parse(line);
      } catch {
        // partial line
      }
    }
  });
  for (let i = 0; i < 180; i += 1) {
    if (last?.workers?.filter((w) => w.state === 'running' && w.pid).length >= 2) break;
    await sleep(1000);
  }
  await sleep(8000); // well into the loop
  const workers = last?.workers ?? [];
  const pids = workers.map((w) => w.pid).filter(Boolean);
  check('two workers running before the kill', workers.filter((w) => w.state === 'running').length === 2, JSON.stringify(workers.map((w) => [w.id, w.state, w.pid])));

  host.kill('SIGKILL');
  await sleep(1000);
  check('host is gone', !alive(host.pid));
  check('ref hook left behind in the repo', existsSync(hook) && readFileSync(hook, 'utf8').includes('Installed by BotWatch'));
  const orphans = pids.filter(alive);
  check('worker processes orphaned', orphans.length > 0, `${orphans.length} of ${pids.length} still alive`);

  const gone = workers.find((w) => w.id === 'w1')?.cwd;
  if (gone) rmSync(gone, { recursive: true, force: true });
  console.log(`  deleted worktree folder ${gone}`);

  const reports = (await recover()).filter((r) => r.id === last.id);
  const report = reports[0];
  console.log(`  recover(): ${JSON.stringify(report)}`);
  check('recover found the run', Boolean(report));
  await sleep(3000);
  check('orphaned workers stopped', pids.every((pid) => !alive(pid)), pids.map((p) => `${p}:${alive(p) ? 'alive' : 'gone'}`).join(' '));
  check('ref hook removed', !existsSync(hook));
  check('missing worktree pruned', (report?.pruned ?? []).length === 1 && !git(repo, 'worktree', 'list').includes('w1-'));
  const branches = git(repo, 'branch', '--list', 'bw/*');
  check('every branch kept', workers.every((w) => branches.includes(w.branch)), branches.replace(/\s+/g, ' '));
  check('recover runs once', (await recover()).every((r) => r.id !== last.id));
}

async function scenarioCrashedWorker() {
  console.log('\n2. a worker crashes mid-turn');
  const { root, repo } = scratchRepo();
  const control = join(root, 'control.sock');
  const pilot = createPilot({ controlPath: control });
  const server = await serveControl(pilot.current, control);
  await pilot.start({
    repo,
    goal: `One task, one worker, text passed word for word: first create src/partial.js exporting a constant, then ${SLOW('src/after.js')}`,
    model: 'haiku',
    maxWorkers: 1,
    budgetTokens: 1_000_000,
    permissionCeiling: 'acceptEdits',
    testCommand: 'npm test',
  });
  const run = pilot.current().run;
  let worker = null;
  for (let i = 0; i < 240; i += 1) {
    worker = run.workers[0];
    if (worker?.child?.pid && existsSync(join(worker.cwd, 'src/partial.js'))) break;
    await sleep(1000);
  }
  check('worker wrote partial work before the crash', Boolean(worker) && existsSync(join(worker.cwd, 'src/partial.js')));
  process.kill(worker.child.pid, 'SIGKILL');
  for (let i = 0; i < 60 && !(worker.snapshot && !worker.test?.running); i += 1) await sleep(1000);
  check('worker marked errored', worker.state === 'errored', worker.state);
  check('its partial work snapshotted', Boolean(worker.snapshot?.sha) && git(repo, 'show', '--stat', '--format=', worker.branch).includes('src/partial.js'));
  const { reviews } = await pilot.review();
  check('review shows it', reviews[0]?.added.some((f) => f.file === 'src/partial.js'));
  const merged = await pilot.merge({ reviewed: [{ branch: worker.branch, sha: reviews[0].sha }] });
  check('merge refused', /has not finished \(errored\)/.test(merged.error ?? ''), merged.error);
  await pilot.close({ stop: true });
  server.close();
}

async function scenarioStaleSession() {
  console.log('\n3. a session file whose pid now belongs to another process');
  const file = join(homedir(), '.claude', 'sessions', `${process.pid}.json`);
  writeFileSync(
    file,
    JSON.stringify({ pid: process.pid, sessionId: 'bw-it-stale', cwd: '/tmp', startedAt: Date.now(), kind: 'interactive', procStart: 'Mon Jan  1 00:00:00 2024' }),
  );
  try {
    const { sessions } = await readSessions();
    check('the pid is alive, but the session is not listed', alive(process.pid) && !sessions.some((s) => s.id === 'bw-it-stale'));
  } finally {
    rmSync(file, { force: true });
  }
}

async function scenarioLockedMerge() {
  console.log('\n4. a merge after a git process was killed mid-write');
  const { repo } = scratchRepo();
  const { Run } = await import('../electron/orchestrator/run.js');
  const wt = join(dirname(repo), 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'bw/w1-x', wt);
  writeFileSync(join(wt, 'src/x.js'), 'export const x = 1;\n');
  const run = new Run({ repo, goal: 'g', model: 'haiku' });
  run.testWorktree = async () => ({ passed: true });
  run.workers.push({ id: 'w1', task: 'x', branch: 'bw/w1-x', base: 'main', cwd: wt, state: 'done', doneAt: 1 });
  await run.snapshot(run.workers[0]);
  const [r] = await run.reviewAll();
  writeFileSync(join(repo, '.git', 'index.lock'), '');
  run.userApprovedMerge = true;
  const locked = await run.merge({ reviewed: [{ branch: r.branch, sha: r.sha }] });
  check('refused, naming the lock', /git is locked: .*index\.lock exists/.test(locked.error ?? ''), locked.error);
  rmSync(join(repo, '.git', 'index.lock'));
  const ok = await run.merge({ reviewed: [{ branch: r.branch, sha: r.sha }] });
  check('merges once the lock is gone', !ok.error && existsSync(join(repo, 'src/x.js')), ok.error);
  clearInterval(run.reaper);
}

console.log(`runs are recorded in ${RUNS_DIR}`);
await scenarioKilledHost();
await scenarioCrashedWorker();
await scenarioStaleSession();
await scenarioLockedMerge();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
