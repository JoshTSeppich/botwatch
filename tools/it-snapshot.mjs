// Integration: snapshots against the real CLI.
//
//   node tools/it-snapshot.mjs
//
// Spends tokens (haiku). Exits non-zero if a check fails.
//   1. A worker starts a subagent in the background and ends its turn at
//      once. The snapshot waits: it is taken after the subagent's files
//      exist, and contains them.
//   2. A file written into the finished worktree after the snapshot (by
//      nothing BotWatch knows about) gets it snapshotted again, and the old
//      review no longer merges.
//   3. Its tokens: what the run counted against what the transcripts say,
//      one count per API message, subagents included.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Run } from '../electron/orchestrator/run.js';
import { countUsage } from '../electron/tokens.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// Not under the temp directory: the sandbox always lets a shell write there.
const root = mkdtempSync(join(homedir(), '.bw-it-snapshot-'));
const repo = join(root, 'greeter');
mkdirSync(join(repo, 'src'), { recursive: true });
git(root, 'init', '-q', '-b', 'main', repo);
git(repo, 'config', 'user.email', 'it@example.com');
git(repo, 'config', 'user.name', 'IT');
writeFileSync(join(repo, 'src/greet.js'), 'export const greet = (n) => `Hello, ${n}!`;\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'greeter');

// The per-message truth from a session's transcripts, subagents included.
function transcriptTokens(cwd, sessionId) {
  const dir = join(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  const files = [join(dir, `${sessionId}.jsonl`)];
  const subs = join(dir, sessionId, 'subagents');
  if (existsSync(subs)) files.push(...readdirSync(subs).filter((f) => f.endsWith('.jsonl')).map((f) => join(subs, f)));
  let total = 0;
  for (const file of files) {
    const seen = new Map();
    for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      if (r.type === 'assistant' && r.message?.id) seen.set(r.message.id, Math.max(seen.get(r.message.id) ?? 0, countUsage(r.message.usage)));
    }
    for (const v of seen.values()) total += v;
  }
  return { total, files: files.length };
}

const run = new Run({ repo, goal: 'it', model: 'haiku', maxWorkers: 1, permissionCeiling: 'acceptEdits' });
await run.arm();
const task = [
  'Use the Agent tool to start ONE general-purpose subagent with run_in_background set to true.',
  'Its task, word for word: "Create src/b1.js through src/b8.js one at a time with the Write tool, each exporting its number."',
  'Do not write any files yourself and do not wait for it: as soon as it is launched, end your turn with one line saying it is running.',
].join(' ');
const { id } = await run.spawn(task);
const worker = run.find(id);

console.log('\n1. The snapshot waits for background tasks');
let sawWaiting = false;
for (let i = 0; i < 480 && !worker.snapshot?.sha; i += 1) {
  if (worker.backgroundTasks?.length && worker.state === 'running' && /background/.test(worker.summary ?? '')) sawWaiting = true;
  await sleep(500);
}
const files = (sha) => (sha ? git(worker.cwd, 'ls-tree', '-r', '--name-only', sha).split('\n').filter((f) => /^src\/b\d\.js$/.test(f)) : []);
check('the turn ended while its subagent was still running, and the worker waited', sawWaiting, `summary seen: waiting for background task`);
check('snapshotted after the subagent finished', Boolean(worker.snapshot?.sha), `${worker.state} ${worker.snapshot?.sha?.slice(0, 7) ?? 'no snapshot'}`);
check("the snapshot holds the subagent's files", files(worker.snapshot?.sha).length === 8, `${files(worker.snapshot?.sha).length} of 8`);
while (worker.test?.running) await sleep(200);

console.log('\n2. A worktree that changes after its snapshot');
const [reviewed] = await run.reviewAll();
writeFileSync(join(worker.cwd, 'src/late.js'), 'export const late = true;\n');
run.userApprovedMerge = true;
const refused = await run.merge({ reviewed: [{ branch: reviewed.branch, sha: reviewed.sha }] });
check('merge refuses the reviewed commit', /worktree changed after the snapshot/.test(refused.error ?? ''), refused.error);
for (let i = 0; i < 60 && worker.snapshot.sha === reviewed.sha; i += 1) await sleep(500);
check('it is snapshotted again, with the late file', worker.snapshot.sha !== reviewed.sha && git(worker.cwd, 'ls-tree', '-r', '--name-only', worker.snapshot.sha).includes('src/late.js'), `${reviewed.sha.slice(0, 7)} -> ${worker.snapshot.sha.slice(0, 7)}`);
while (worker.test?.running) await sleep(200);
const again = await run.merge({ reviewed: [{ branch: reviewed.branch, sha: reviewed.sha }] });
check('the old review still does not merge', Boolean(again.error), again.error);
const [fresh] = await run.reviewAll();
const merged = await run.merge({ reviewed: [{ branch: fresh.branch, sha: fresh.sha }] });
check('the new review merges', !merged.error && existsSync(join(repo, 'src/late.js')), merged.error ?? 'merged');

console.log('\n3. Tokens, in one count per API message');
worker.release();
await sleep(3000);
const truth = transcriptTokens(worker.cwd, worker.sessionId);
const off = Math.abs(worker.tokens - truth.total) / truth.total;
check('counted within 1% of the transcripts', off < 0.01, `counted ${worker.tokens.toLocaleString()}, transcripts ${truth.total.toLocaleString()} across ${truth.files} files`);

await run.close();
rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
