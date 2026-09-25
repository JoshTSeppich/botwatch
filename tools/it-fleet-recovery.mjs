// Integration: pilld killed with SIGKILL while a v4 fleet runs, then a
// relaunch, against the real CLI.
//
//   node tools/it-fleet-recovery.mjs
//
// Spends tokens (haiku). Exits non-zero if a check fails.
//
// Before the fleet starts, the repo gets things that are the user's: their
// own reference-transaction hook, a branch, uncommitted edits, a worktree,
// and a claude session of their own. The fleet (a hypervisor, two
// orchestrators, their workers) runs in a separate host process, which is
// killed mid-run. A second process then does what BotWatch does on launch:
// recover(). Checks that every fleet session was stopped, that nothing of the
// user's was touched, and what happened in between.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

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

// Not under the temp directory: the sandbox always lets a shell write there.
const root = mkdtempSync(join(homedir(), '.bw-it-fleet-kill-'));
const repo = join(root, 'greeter');
mkdirSync(join(repo, 'src'), { recursive: true });
git(root, 'init', '-q', '-b', 'main', repo);
git(repo, 'config', 'user.email', 'it@example.com');
git(repo, 'config', 'user.name', 'IT');
writeFileSync(join(repo, 'src/greet.js'), 'export const greet = (n) => `Hello, ${n}!`;\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'greeter');

// ---- the user's own things --------------------------------------------------------
const MY_HOOK = '#!/bin/sh\n# the user\'s own reference-transaction hook\nexit 0\n';
const hookPath = join(repo, '.git', 'hooks', 'reference-transaction');
writeFileSync(hookPath, MY_HOOK, { mode: 0o755 });
git(repo, 'branch', 'feature/mine');
git(repo, 'worktree', 'add', '-q', join(root, 'mine-wt'), '-b', 'feature/wt');
writeFileSync(join(repo, 'src/greet.js'), 'export const greet = (n) => `Hi, ${n}!`; // my uncommitted edit\n');
writeFileSync(join(repo, 'mine.txt'), 'untracked, mine\n');
const mine = {
  main: git(repo, 'rev-parse', 'main'),
  branch: git(repo, 'rev-parse', 'feature/mine'),
  status: git(repo, 'status', '--porcelain'),
};
// A claude session of the user's own, started outside BotWatch, left waiting.
mkdirSync(join(root, 'my-session'));
const myClaude = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'], { cwd: join(root, 'my-session'), stdio: ['pipe', 'ignore', 'ignore'] });

// ---- the fleet, in a host we can kill ------------------------------------------------
const sockDir = mkdtempSync(join(tmpdir(), 'bw-kill-'));
const runsDir = join(root, 'runs');
const host = spawn(process.execPath, [new URL('./it-fleet-host.mjs', import.meta.url).pathname, repo, sockDir, runsDir, join(root, 'fleet')], { stdio: ['ignore', 'pipe', 'inherit'] });
let latest = null;
let buffer = '';
host.stdout.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    try {
      latest = JSON.parse(line);
    } catch {}
  }
});

console.log('\n1. The fleet gets going');
for (let i = 0; i < 300; i += 1) {
  const running = (latest?.sessions ?? []).filter((s) => s.level === 'worker' && s.state === 'running');
  const orchestrators = new Set(running.map((s) => s.id.split('/')[0]));
  if (orchestrators.size >= 2) break;
  await sleep(1000);
}
const sessions = latest?.sessions ?? [];
const pids = sessions.filter((s) => s.pid && alive(s.pid));
console.log(`  info live sessions: ${pids.map((s) => `${s.id} (${s.level}) pid ${s.pid}`).join(', ')}`);
check('a hypervisor, two orchestrators and their workers were running', pids.some((s) => s.level === 'hypervisor') && pids.filter((s) => s.level === 'orchestrator').length === 2 && pids.some((s) => s.level === 'worker'));
const worktreesDir = join(root, '.botwatch-worktrees');
const count = () => (existsSync(worktreesDir) ? Number(execFileSync('sh', ['-c', `find '${worktreesDir}' -path '*/src/*' -name '*.js' | wc -l`], { encoding: 'utf8' }).trim()) : 0);

console.log('\n2. pilld is killed');
host.kill('SIGKILL');
await sleep(2000);
const orphans = pids.filter((s) => alive(s.pid));
check('the host is gone and its sessions are orphaned, still alive', !alive(host.pid) && orphans.length > 0, `${orphans.length} of ${pids.length} alive`);
const atKill = count();
await sleep(20_000);
const beforeRelaunch = count();
console.log(`  info files in the workers' worktrees: ${atKill} two seconds after the kill, ${beforeRelaunch} twenty seconds later`);
check("with pilld gone, every tool call is refused, so the orphans write nothing more", beforeRelaunch === atKill, `${beforeRelaunch - atKill} written meanwhile`);
// With pilld's end of their stdin gone, a session exits by itself once its
// turn ends. Which did, before the relaunch:
const exitedOnTheirOwn = pids.filter((s) => !alive(s.pid)).map((s) => s.id);
console.log(`  info exited by themselves before the relaunch (stdin closed, turn over): ${exitedOnTheirOwn.join(', ') || 'none'}`);

console.log('\n3. BotWatch relaunches and recovers');
const relaunch = spawn(process.execPath, ['--input-type=module', '-e', `
  import { recover } from '${new URL('../electron/orchestrator/recovery.js', import.meta.url).pathname}';
  console.log(JSON.stringify(await recover({ runsDir: ${JSON.stringify(runsDir)} })));
`], { stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
relaunch.stdout.on('data', (c) => (out += c));
await new Promise((r) => relaunch.on('exit', r));
const reports = JSON.parse(out.trim().split('\n').pop());
for (const r of reports) console.log(`  info ${r.id}: stopped ${r.stopped.join(', ') || 'none'}; spared ${r.spared.join(', ') || 'none'}; ref hook removed ${r.hookRemoved}; pruned ${r.pruned.length}; branches kept ${r.kept.length}`);
await sleep(5000);
const survivors = pids.filter((s) => alive(s.pid));
check('every fleet session was stopped: hypervisor, orchestrators, workers', survivors.length === 0, survivors.map((s) => `${s.id} ${s.pid}`).join(', ') || `${pids.length} stopped`);
// A record's orchestrator is listed under its own id (O1), its workers as w1, w2.
const stoppedByRecovery = reports.flatMap((r) => {
  const owner = r.id.split('-').pop();
  return r.stopped.map((w) => (w === owner || owner === 'H' ? w : `${owner}/${w}`));
});
console.log(`  info stopped by recovery: ${stoppedByRecovery.join(', ') || 'none'}`);
check("the hypervisor has its own record, and is gone: by itself or stopped by recovery", reports.some((r) => r.id.endsWith('-H')) && !alive(pids.find((s) => s.id === 'H').pid), exitedOnTheirOwn.includes('H') ? 'it exited by itself' : 'recovery stopped it');
check('each orchestrator record was recovered', reports.filter((r) => /-O\d+$/.test(r.id)).length === 2);

console.log('\n4. Nothing of the user\'s was touched');
check('their own claude session is still running', alive(myClaude.pid), `pid ${myClaude.pid}`);
check('their own reference-transaction hook is back, byte for byte', existsSync(hookPath) && readFileSync(hookPath, 'utf8') === MY_HOOK && !existsSync(`${hookPath}.botwatch-chained`));
check('main and their branch are where they were', git(repo, 'rev-parse', 'main') === mine.main && git(repo, 'rev-parse', 'feature/mine') === mine.branch);
check('their uncommitted edits and untracked file are intact', git(repo, 'status', '--porcelain') === mine.status && readFileSync(join(repo, 'mine.txt'), 'utf8') === 'untracked, mine\n');
check('their worktree is intact', existsSync(join(root, 'mine-wt')) && git(repo, 'worktree', 'list').includes('mine-wt'));
const bw = git(repo, 'branch', '--list', 'bw/*').split('\n').filter(Boolean);
check("the fleet's branches are kept, because they are the work", bw.length >= 2, `${bw.length} bw/ branches`);

myClaude.kill('SIGTERM');
rmSync(root, { recursive: true, force: true });
rmSync(sockDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
