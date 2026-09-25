// Integration: a v4 fleet end to end, against the real CLI.
//
//   node tools/it-fleet.mjs
//
// Spends tokens (haiku). Exits non-zero if a check fails. A real hypervisor
// gets two goals in one repo, starts an orchestrator for each with a lease,
// they claim paths, start workers, and queue their work; one worker has to
// ask a question, which climbs to the hypervisor or to the user's card. Then
// staging is built and tested, and merged only on the user's click.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { serveControl } from '../electron/orchestrator/control.js';
import { serveEnforcement } from '../electron/fleet/enforce-server.js';
import { createFleetHost } from '../electron/fleet/host.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// Not under the temp directory: the sandbox always lets a shell write there.
const root = mkdtempSync(join(homedir(), '.bw-it-fleet-'));
const repo = join(root, 'greeter');
mkdirSync(join(repo, 'src'), { recursive: true });
mkdirSync(join(repo, 'test'), { recursive: true });
git(root, 'init', '-q', '-b', 'main', repo);
git(repo, 'config', 'user.email', 'it@example.com');
git(repo, 'config', 'user.name', 'IT');
writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'greeter', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
writeFileSync(join(repo, 'src/greet.js'), 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n');
writeFileSync(join(repo, 'test/greet.test.js'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { greet } from '../src/greet.js';\n\ntest('greet', () => assert.equal(greet('Ada'), 'Hello, Ada!'));\n");
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'greeter');
const mainBefore = git(repo, 'rev-parse', 'main');

const sockDir = mkdtempSync(join(tmpdir(), 'bw-fleet-sock-'));
const controlPath = join(sockDir, 'control.sock');
const enforcePath = join(sockDir, 'enforce.sock');
const host = createFleetHost({ controlPath, enforcePath, runsDir: join(root, 'runs') });
const control = await serveControl(() => host.current(), controlPath);
const enforcement = await serveEnforcement(() => host.current(), enforcePath);

const BUDGET = 1_500_000;
const started = await host.start({
  id: `it${Date.now().toString(36)}`,
  goals: [
    { id: 'g1', priority: 1, repo, goal: 'Add src/farewell.js exporting farewell(name) that returns `Goodbye, ${name}!`, with a test in test/farewell.test.js. One worker is enough. Claim only src/farewell.js and test/farewell.test.js.' },
    {
      id: 'g2',
      priority: 2,
      repo,
      goal: 'Write docs/USAGE.md explaining greet(). One worker is enough. Claim only docs/**. The worker must not choose the heading style itself: it has to ask, with QUESTION:, whether headings are Title Case or sentence case, and wait for the answer. That choice is the user\'s.',
    },
  ],
  budgetTokens: BUDGET,
  maxSessions: 5,
  permissionCeiling: 'acceptEdits',
  model: 'haiku',
  testCommand: 'npm test',
  dir: join(root, 'fleet'),
});
check('the fleet started', started.ok, started.error);
const fleet = host.fleet;

// Answer any card that reaches the user, the way the pill's question card would.
const answered = [];
let maxRunning = 0;
const deadline = Date.now() + 25 * 60_000;
while (Date.now() < deadline) {
  const view = host.view();
  maxRunning = Math.max(maxRunning, view.sessions.running);
  for (const card of host.questions()) {
    answered.push(card);
    host.answer(card.id, 'Sentence case.');
  }
  const done = view.orchestrators.length === 2 && view.orchestrators.every((o) => o.state === 'queued');
  if (done && (fleet.hypervisor.state !== 'running' || view.queues[0]?.entries.length === 2)) break;
  if (fleet.hypervisorGone && !view.orchestrators.some((o) => o.state === 'running')) break;
  await sleep(2000);
}

const view = host.view();
console.log(`  info orchestrators: ${view.orchestrators.map((o) => `${o.id} ${o.goal} ${o.state} lease ${o.lease.tokens.toLocaleString()} spent ${o.lease.spent.toLocaleString()}`).join('; ')}`);
check('an orchestrator per goal, each with a lease', view.orchestrators.length === 2 && view.orchestrators.every((o) => o.lease.tokens > 0));
check('the leases never exceeded the global budget', view.budget.leased <= BUDGET, `${view.budget.leased.toLocaleString()} of ${BUDGET.toLocaleString()}`);
check('sessions never exceeded the cap', maxRunning <= 5, `peak ${maxRunning} of 5`);
check('both claims were granted', view.orchestrators.every((o) => o.claim?.state === 'granted'), view.orchestrators.map((o) => `${o.id}: ${o.claim?.globs.join(',')}`).join('; '));
check('both queued their work', view.queues[0]?.entries.length === 2, JSON.stringify(view.queues[0]?.entries.map((e) => e.id)));

const decisions = host.decisions();
const answers = decisions.filter((d) => ['answer', 'human'].includes(d.kind));
console.log(`  info decisions logged: ${decisions.length} (${[...new Set(decisions.map((d) => d.kind))].join(', ')}); cards that reached the user: ${answered.length}`);
check('the heading question was answered somewhere up the chain, and logged with its chain', answers.some((d) => /case/i.test(`${d.question} ${d.text}`) && d.chain.startsWith('H')), answers.map((d) => `${d.chain}: ${d.text.slice(0, 40)} [rule: ${d.rule ?? 'none'}]`).join(' | ') || '(none)');

console.log('\nThe merge queue');
const built = await host.build(repo);
check('staging built, each entry tested on top of the ones before', built.entries?.every((e) => e.built?.sha && e.built.test?.passed), JSON.stringify(built.entries?.map((e) => ({ id: e.id, sha: e.built?.sha?.slice(0, 7), passed: e.built?.test?.passed, conflict: e.built?.conflict }))));
check('main has not moved', git(repo, 'rev-parse', 'main') === mainBefore);
const last = built.entries?.at(-1);
const q = fleet.queues.get(repo);
const refused = await q.approve({ upTo: last?.id, sha: last?.built?.sha });
check('without the click, staging does not merge', /click Merge/.test(refused.error ?? ''), refused.error);
const merged = await host.approve(repo, { upTo: last?.id, sha: last?.built?.sha });
check('with the click, main moves to exactly the tested staging commit', !merged.error && git(repo, 'rev-parse', 'main') === last?.built?.sha, merged.error ?? merged.sha?.slice(0, 7));
check('the work is on main', existsSync(join(repo, 'src/farewell.js')) && existsSync(join(repo, 'docs/USAGE.md')));

console.log('\nThe hypervisor');
const hvDir = join(homedir(), '.claude', 'projects', join(root, 'fleet', 'H').replace(/[^A-Za-z0-9]/g, '-'));
const used = new Set();
for (const f of existsSync(hvDir) ? readdirSync(hvDir).filter((x) => x.endsWith('.jsonl')) : []) {
  for (const line of readFileSync(join(hvDir, f), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    for (const part of Array.isArray(r.message?.content) ? r.message.content : []) if (part.type === 'tool_use') used.add(part.name);
  }
}
console.log(`  info tools it used: ${[...used].join(', ')}`);
check('it used only BotWatch tools (and tool search)', [...used].every((t) => t.startsWith('mcp__botwatch__') || t === 'ToolSearch'));

await host.close();
control.close();
enforcement.close();
rmSync(root, { recursive: true, force: true });
rmSync(sockDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
