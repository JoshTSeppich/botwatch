// Integration: Pause all / Resume all against the real CLI.
//
//   node tools/it-pause.mjs
//
// Spends tokens (haiku). Exits non-zero if a check fails.
//   1. Pause all mid-turn: every running worker goes to paused, and for 10s
//      nothing moves — no tool calls, no files, no tokens.
//   2. Resume all: the same sessions carry on and finish, and are snapshotted.
//   3. A small budget: the run pauses itself when it's spent, Resume is refused
//      until the budget is raised, then it carries on.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serveControl } from '../electron/orchestrator/control.js';
import { createPilot } from '../electron/orchestrator/pilot.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), 'bw-it-pause-'));
  const repo = join(root, 'greeter');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'it@example.com');
  git(repo, 'config', 'user.name', 'IT');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'greeter', type: 'module', scripts: { test: 'node --test' } }));
  writeFileSync(join(repo, 'src/greet.js'), 'export const greet = (n) => `Hello, ${n}!`;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'greeter');
  return { root, repo };
}

// Many small files, one Write each: a turn long enough to pause in the middle.
const MANY = (prefix) =>
  `Create twelve files, src/${prefix}1.js through src/${prefix}12.js, one at a time with the Write tool, each exporting its number. Nothing else.`;

async function startRun(repo, { budgetTokens = 2_000_000 } = {}) {
  const control = join(repo, '..', 'control.sock');
  const pilot = createPilot({ controlPath: control });
  const server = await serveControl(pilot.current, control);
  await pilot.start({
    repo,
    goal: `Two tasks, one worker each, started at once, task text passed word for word. Task "a": ${MANY('a')} Task "b": ${MANY('b')}`,
    model: 'haiku',
    maxWorkers: 2,
    budgetTokens,
    permissionCeiling: 'acceptEdits',
    testCommand: null,
  });
  return { pilot, server, run: pilot.current().run };
}

const files = (repo) =>
  readdirSync(join(repo, '..', '.botwatch-worktrees'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(repo, '..', '.botwatch-worktrees', d.name, 'src')));
const tools = (run) => run.workers.reduce((n, w) => n + w.log.items.filter((i) => i.kind === 'tool').length, 0);
const tokens = (run) => run.workers.reduce((n, w) => n + w.tokens, 0);

async function scenarioPauseResume() {
  console.log('\n1–2. Pause all mid-turn, then Resume all');
  const { repo } = scratchRepo();
  const { pilot, server, run } = await startRun(repo);
  for (let i = 0; i < 120; i += 1) {
    if (run.workers.length === 2 && run.workers.every((w) => w.state === 'running') && files(repo).length >= 4) break;
    await sleep(500);
  }
  check('two workers mid-turn', run.workers.filter((w) => w.state === 'running').length === 2, `${files(repo).length} files so far`);

  pilot.pauseAll();
  await sleep(2500); // let the interrupted turns report
  check('both paused', run.workers.every((w) => w.state === 'paused'), run.workers.map((w) => w.state).join(','));
  const before = { files: files(repo).length, tools: tools(run), tokens: tokens(run) };
  await sleep(10_000);
  const after = { files: files(repo).length, tools: tools(run), tokens: tokens(run) };
  check('nothing moves for 10s while paused', JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  check('not errored, not snapshotted', run.workers.every((w) => w.state === 'paused' && !w.snapshot));

  const out = pilot.resumeAll();
  check('resume all', out.resumed === 2, JSON.stringify(out));
  for (let i = 0; i < 240 && !run.workers.every((w) => w.snapshot); i += 1) await sleep(500);
  const done = files(repo).filter((f) => /^[ab]\d+\.js$/.test(f)).length;
  check('the same sessions finished the work', run.workers.every((w) => w.state === 'done') && done === 24, `${done} of 24 files, states ${run.workers.map((w) => w.state)}`);
  check('and were snapshotted', run.workers.every((w) => w.snapshot?.sha), run.workers.map((w) => w.snapshot?.sha?.slice(0, 7)).join(','));
  await pilot.close({ stop: true });
  server.close();
}

async function scenarioBudget() {
  console.log('\n3. A small budget pauses the run; Resume waits for a raise');
  const { repo } = scratchRepo();
  const { pilot, server, run } = await startRun(repo, { budgetTokens: 60_000 });
  for (let i = 0; i < 240 && !run.budgetExhausted; i += 1) await sleep(500);
  await sleep(2500);
  check('budget reached from counted tokens', run.budgetExhausted, `${run.ledger.spent} / ${run.ledger.limitTokens}`);
  check('the run paused itself', run.paused && run.pauseReason === 'budget');
  check('Resume is refused', /budget is spent/.test(pilot.resumeAll().error ?? ''));
  const raised = pilot.raiseBudget(500_000);
  check('+500k raises it', raised.limit === 560_000, JSON.stringify(raised));
  const out = pilot.resumeAll();
  check('then Resume works', !out.error, JSON.stringify(out));
  await sleep(8000);
  check('and work continues', run.workers.some((w) => w.state === 'running' || w.state === 'done'), run.workers.map((w) => w.state).join(','));
  await pilot.close({ stop: true });
  server.close();
}

await scenarioPauseResume();
await scenarioBudget();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
