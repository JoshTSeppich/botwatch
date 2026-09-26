// Integration: a v4 fleet end to end, against the real CLI.
//
//   node tools/it-fleet.mjs [basic|collide ...]
//
// collide: two goals that need the same file and ask the same question.
// The hypervisor has to resolve the path conflict, and the two questions
// have to reach the user as one card, ranked by blocked work.
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
function setup(name) {
  const root = mkdtempSync(join(homedir(), `.bw-it-fleet-${name}-`));
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
  return { root, repo };
}

async function serve(root) {
  const sockDir = mkdtempSync(join(tmpdir(), 'bw-fleet-sock-'));
  const controlPath = join(sockDir, 'control.sock');
  const enforcePath = join(sockDir, 'enforce.sock');
  const host = createFleetHost({ controlPath, enforcePath, runsDir: join(root, 'runs') });
  const control = await serveControl(() => host.current(), controlPath);
  const enforcement = await serveEnforcement(() => host.current(), enforcePath);
  return {
    host,
    async close() {
      await host.close();
      control.close();
      enforcement.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(sockDir, { recursive: true, force: true });
    },
  };
}

async function basic() {
  console.log('\nbasic: two goals, a question, the merge queue');
  const { root, repo } = setup('basic');
  const mainBefore = git(repo, 'rev-parse', 'main');
  const served = await serve(root);
  const { host } = served;

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
  let built = await host.build(repo);
  const describe = (b) => JSON.stringify(b.entries?.map((e) => ({ id: e.id, sha: e.built?.sha?.slice(0, 7), passed: e.built?.test?.passed, conflict: e.built?.conflict })));
  check('staging built: each entry tested on top of the ones before, or its conflict named', built.entries?.every((e) => (e.built?.sha && e.built.test) || e.built?.conflict?.files?.length), describe(built));
  // An entry whose own workers collided (an orchestrator's split, not a
  // limit) can't merge. Reorder the ones that built to the front, as the
  // hypervisor would, and rebuild.
  if (built.entries?.some((e) => e.built?.conflict)) {
    const order = [...built.entries.filter((e) => e.built?.sha), ...built.entries.filter((e) => !e.built?.sha)].map((e) => e.id);
    fleet.orderQueue(repo, order);
    built = await host.build(repo);
    console.log(`  info an entry conflicted; reordered to ${order.join(', ')} and rebuilt: ${describe(built)}`);
  }
  const clean = [];
  for (const e of built.entries ?? []) {
    if (!e.built?.sha) break;
    clean.push(e);
  }
  check('main has not moved', git(repo, 'rev-parse', 'main') === mainBefore);
  const last = clean.at(-1);
  const q = fleet.queues.get(repo);
  const refused = await q.approve({ upTo: last?.id, sha: last?.built?.sha });
  check('without the click, staging does not merge', /click Merge/.test(refused.error ?? ''), refused.error);
  const merged = await host.approve(repo, { upTo: last?.id, sha: last?.built?.sha });
  check('with the click, main moves to exactly the tested staging commit', !merged.error && git(repo, 'rev-parse', 'main') === last?.built?.sha, merged.error ?? merged.sha?.slice(0, 7));
  const owners = new Set(clean.map((e) => e.owner));
  const ownerOf = (goal) => [...fleet.orchestrators.values()].find((o) => o.goal.id === goal)?.id;
  const expected = [
    [ownerOf('g1'), 'src/farewell.js'],
    [ownerOf('g2'), 'docs/USAGE.md'],
  ];
  check("each merged entry's work is on main", clean.length > 0 && expected.filter(([o]) => owners.has(o)).every(([, f]) => existsSync(join(repo, f))), `merged ${clean.map((e) => `${e.id} (${e.owner})`).join(', ') || 'nothing'}`);

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

  await served.close();
}

async function collide() {
  console.log('\ncollide: two goals on the same file, asking the same question');
  const { root, repo } = setup('collide');
  const served = await serve(root);
  const { host } = served;
  const QUESTION = 'Should a loud greeting end with "!!!" or with "!"?';
  // g1 claims first and then asks; g2 asks first and claims after the answer.
  // So both questions wait at once (one card), and g2's claim meets g1's
  // live one (a conflict), whatever the timing.
  const rule = (what, order) =>
    `${what} in src/greet.js, with a test. One worker. Claim only src/greet.js and test/**. ` +
    'Hypervisor: start the orchestrators for both goals before acting on any question, and pass these orchestrator instructions word for word in the brief. ' +
    `Orchestrator: ${order} ` +
    `The question, exactly: ${QUESTION} ` +
    'It is a product decision the user reserved: the hypervisor must not answer it, and must pass it to the user with ask_human. Wait for the answer, then do the work.';
  const started = await host.start({
    id: `itc${Date.now().toString(36)}`,
    goals: [
      // g1's work is long (40 test files, one at a time), so its claim is
      // held long enough for the hypervisor to see the conflict and act:
      // in a shorter run g1 finished first and pilld granted g2's claim
      // on release, before the hypervisor had done anything.
      { id: 'g1', priority: 1, repo, goal: `${rule('Add shout(name), a loud greeting,', 'first call claim_paths, then call ask_up with the question below, before starting any worker.')} Also, one worker writes test/shout1.test.js through test/shout40.test.js, one at a time with the Write tool, each testing shout on one name.` },
      { id: 'g2', priority: 2, repo, goal: rule('Add yell(name), a loud greeting,', 'first call ask_up with the question below, and only after the answer call claim_paths, then start the worker.') },
    ],
    budgetTokens: 1_500_000,
    maxSessions: 5,
    permissionCeiling: 'acceptEdits',
    // Sonnet: the scenario tests pilld's conflict and card handling, and a
    // haiku hypervisor's planning made it a coin toss (it started one
    // orchestrator alone, then revoked its lease).
    model: 'sonnet',
    testCommand: 'npm test',
    dir: join(root, 'fleet'),
  });
  check('the fleet started', started.ok, started.error);
  const fleet = host.fleet;

  // Answer the user's card once, the way the pill would, when it arrives;
  // first see what the queue looked like.
  let seenCards = [];
  let answeredAt = null;
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) {
    const cards = host.questions();
    if (cards.length && !answeredAt) {
      // Give the hypervisor a little time to put both questions on it.
      const open = fleet.listOrchestrators().questions.filter((q) => !q.card).length;
      const asked = [...fleet.questions.values()].filter((q) => /loud greeting end with/.test(q.question)).length;
      if ((open === 0 && asked >= 2) || Date.now() - cards[0].at > 300_000) {
        seenCards = cards.map((c) => ({ id: c.id, questions: c.questions, text: c.text, blocked: c.blocked }));
        for (const c of cards) host.answer(c.id, '"!!!"');
        answeredAt = Date.now();
      }
    }
    const view = host.view();
    if (view.orchestrators.length === 2 && view.orchestrators.every((o) => o.state === 'queued')) break;
    await sleep(2000);
  }
  const view = host.view();
  const decisions = host.decisions();
  console.log(`  info cards the user saw: ${JSON.stringify(seenCards)}`);
  const sameQ = [...fleet.questions.values()].filter((q) => /loud greeting end with/.test(q.question));
  check('both orchestrators asked the question', sameQ.length === 2, `${sameQ.length} asked: ${sameQ.map((q) => q.from).join(', ')}`);
  check('the two questions reached the user as one card', seenCards.length === 1 && seenCards[0].questions.length === 2, seenCards.map((c) => `${c.id}: ${c.questions.join('+')}`).join('; '));
  check('the card is ranked by blocked work pilld counted: both orchestrators wait on it', seenCards[0]?.blocked >= 2, `blocked ${seenCards[0]?.blocked}`);
  check('one answer reached both', sameQ.every((q) => q.answered?.by === 'human'), sameQ.map((q) => `${q.from}: ${q.answered?.text}`).join(', '));
  const locks = decisions.filter((d) => d.kind === 'lock');
  check('the path conflict was raised and the hypervisor resolved it', locks.length >= 1, locks.map((d) => d.text).join(' | ') || `conflicts open: ${JSON.stringify(view.conflicts)}`);
  check('both orchestrators finished and queued', view.orchestrators.every((o) => o.state === 'queued'), view.orchestrators.map((o) => `${o.id} ${o.state}`).join(', '));
  const built = await host.build(repo);
  console.log(`  info staging: ${JSON.stringify(built.entries?.map((e) => ({ id: e.id, owner: e.owner, sha: e.built?.sha?.slice(0, 7) ?? null, conflict: e.built?.conflict ?? null, passed: e.built?.test?.passed ?? null })))}`);
  console.log(`  info decisions: ${decisions.map((d) => `${d.kind} ${d.chain}`).join('; ')}`);
  await served.close();
}

const SCENARIOS = { basic, collide };
const wanted = process.argv.slice(2);
for (const [name, fn] of Object.entries(SCENARIOS)) if (!wanted.length || wanted.includes(name)) await fn();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
