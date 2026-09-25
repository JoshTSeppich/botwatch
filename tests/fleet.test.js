// v4: every limit of the core rule, attacked through the MCP boundary.
// Sessions and runs are stand-ins; the rules are the real ones.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Fleet, HYPERVISOR_TOOLS, ORCHESTRATOR_TOOLS } from '../electron/fleet/fleet.js';

class FakeSession extends EventEmitter {
  constructor(opts) {
    super();
    Object.assign(this, opts);
    this.state = 'queued';
  }
  start() {
    this.state = 'running';
    this.lastEventAt = Date.now();
  }
  pause() {
    if (this.state !== 'running') return false;
    this.state = 'paused';
    return true;
  }
  resume() {
    if (this.state !== 'paused') return false;
    this.state = 'running';
    return true;
  }
  stop() {
    this.state = 'stopped';
  }
}

class FakeRun extends EventEmitter {
  constructor(opts) {
    super();
    Object.assign(this, opts);
    this.workers = [];
    this.ledger = { limitTokens: opts.budgetTokens, spent: 0 };
    this.limits = { maxWorkers: opts.maxWorkers };
    this.paused = false;
    this.next = 1;
  }
  async spawn(task, model, permissionMode) {
    const verdict = this.gate?.() ?? { ok: true };
    if (!verdict.ok && !verdict.queue) return { error: verdict.reason };
    const id = `w${this.next++}`;
    const w = new FakeSession({ id, task, permissionMode, cwd: this.cwd ?? '/tmp', base: 'main' });
    w.message = () => true;
    this.workers.push(w);
    if (verdict.queue) return { id, state: 'queued' };
    w.start();
    return { id, state: 'running' };
  }
  find(id) {
    return this.workers.find((w) => w.id === id);
  }
  list() {
    return this.workers.map((w) => ({ id: w.id, state: w.state }));
  }
  pauseAll(reason) {
    this.paused = true;
    this.pauseReason = reason;
    for (const w of this.workers) w.pause();
  }
  resumeAll() {
    this.paused = false;
    for (const w of this.workers) w.resume();
    return { resumed: this.workers.length };
  }
  drain() {}
  stop() {
    for (const w of this.workers) w.stop();
  }
  async close() {}
  get state() {
    return { workers: this.workers, paused: this.paused };
  }
}

function fleet(overrides = {}) {
  let clock = 1_000_000;
  const f = new Fleet({
    id: 't',
    goals: [
      { id: 'g1', goal: 'theme', repo: '/r', priority: 1 },
      { id: 'g2', goal: 'docs', repo: '/r', priority: 2 },
    ],
    budgetTokens: 100_000,
    maxSessions: 4,
    permissionCeiling: 'acceptEdits',
    dir: mkdtempSync(join(tmpdir(), 'bw-fleet-')),
    now: () => clock,
    session: (opts) => new FakeSession(opts),
    run: (opts) => new FakeRun(opts),
    ...overrides,
  });
  f.advance = (ms) => {
    clock += ms;
    f.tick(clock);
  };
  return f;
}

async function started(overrides) {
  const f = fleet(overrides);
  await f.start();
  const hv = (name, args) => f.callHypervisor(name, args);
  return { f, hv };
}

// ---- the MCP boundary: each limit, attacked -----------------------------------

test('attack: a lease that would push the total over the global budget, by spawn or by grant', async () => {
  const { f, hv } = await started();
  assert.ok((await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 70_000, slots: 2, expires: 60 })).id);
  const spawn = await hv('spawn_orchestrator', { goal: 'g2', brief: 'b', tokens: 30_001, slots: 1, expires: 60 });
  assert.match(spawn.error, /global budget/);
  const grow = await hv('grant_lease', { id: 'O1', tokens: 100_001, slots: 2, expires: 60 });
  assert.match(grow.error, /global budget/);
  // Negative, fractional and string numbers don't slip through.
  for (const tokens of [-5, 0.5, '1e9', null]) assert.ok((await hv('grant_lease', { id: 'O1', tokens, slots: 2, expires: 60 })).error, String(tokens));
  assert.equal(f.leases.get('O1').tokens, 70_000);
});

test('attack: the hypervisor spending counts, so leases shrink to fit', async () => {
  const { f, hv } = await started();
  f.hypervisor.emit('tokens', f.hypervisor, 40_000);
  const out = await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 60_001, slots: 1, expires: 60 });
  assert.match(out.error, /at most 60,000/);
});

test('attack: more sessions than the global cap, across every level', async () => {
  const { f, hv } = await started({ maxSessions: 3 });
  const o = await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 3, expires: 60 });
  assert.ok(o.id);
  f.orchestrators.get('O1').run.cwd = '/r';
  await f.callOrchestrator('O1', 'claim_paths', { paths: ['src/**'] });
  // H + O1 running: one slot left under the cap of 3.
  const w1 = await f.callOrchestrator('O1', 'spawn_worker', { task: 'a' });
  assert.equal(w1.state, 'running');
  const w2 = await f.callOrchestrator('O1', 'spawn_worker', { task: 'b' });
  assert.equal(w2.state, 'queued', 'at the cap a worker waits rather than starts');
  const o2 = await hv('spawn_orchestrator', { goal: 'g2', brief: 'b', tokens: 10_000, slots: 1, expires: 60 });
  assert.match(o2.error, /session cap/);
  assert.equal(f.listOrchestrators().sessions.running, 3);
});

test('attack: workers before a claim, and a claim that overlaps another', async () => {
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  await hv('spawn_orchestrator', { goal: 'g2', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  assert.match((await f.callOrchestrator('O1', 'spawn_worker', { task: 'a' })).error, /claim your paths/);
  assert.deepEqual((await f.callOrchestrator('O1', 'claim_paths', { paths: ['src/ui/**'] })).granted, ['src/ui/**']);
  const waiting = await f.callOrchestrator('O2', 'claim_paths', { paths: ['src/**'] });
  assert.equal(waiting.waiting, 'c1');
  assert.match((await f.callOrchestrator('O2', 'spawn_worker', { task: 'b' })).error, /waiting on a conflict/);
  assert.match((await f.callOrchestrator('O2', 'claim_paths', { paths: ['/etc/**'] })).error, /repo-relative/);
  // The hypervisor narrows O2; then it may start.
  const resolved = await hv('resolve_lock', { conflict: 'c1', decision: 'narrow O2 docs/**' });
  assert.equal(resolved.resolved, 'c1');
  assert.equal(f.orchestrators.get('O2').claim.state, 'granted');
  assert.equal((await f.callOrchestrator('O2', 'spawn_worker', { task: 'b' })).state, 'running');
});

test('a sequenced claim waits until the holder finishes, then is granted', async () => {
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  await hv('spawn_orchestrator', { goal: 'g2', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  await f.callOrchestrator('O1', 'claim_paths', { paths: ['src/**'] });
  await f.callOrchestrator('O2', 'claim_paths', { paths: ['src/api/**'] });
  await hv('resolve_lock', { conflict: 'c1', decision: 'sequence' });
  assert.equal(f.orchestrators.get('O2').claim.state, 'waiting');
  f.release('O1');
  assert.equal(f.orchestrators.get('O2').claim.state, 'granted');
});

test('attack: a write outside the claim is refused by the hook, live, including a claim made later', async () => {
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  await hv('spawn_orchestrator', { goal: 'g2', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  f.orchestrators.get('O1').run.cwd = '/wt/w1';
  await f.callOrchestrator('O1', 'claim_paths', { paths: ['src/**'] });
  await f.callOrchestrator('O1', 'spawn_worker', { task: 'a' });
  assert.equal(f.mayWrite('O1/w1', '/wt/w1/src/a.js').ok, true);
  assert.match(f.mayWrite('O1/w1', '/wt/w1/docs/a.md').reason, /outside your claim/);
  assert.match(f.mayWrite('O1/w1', '/Users/me/.zshrc').reason, /outside your worktree/);
  assert.match(f.mayWrite('O1/w1', '../../escape.js').reason, /outside your worktree/);
  assert.match(f.mayWrite('O9/w1', '/wt/w1/src/a.js').reason, /unknown session/);
  // O1 narrows to src/ui, O2 takes src/api later: O1's worker is refused there now.
  f.orchestrators.get('O1').claim.globs = ['src/ui/**'];
  await f.callOrchestrator('O2', 'claim_paths', { paths: ['src/api/**'] });
  assert.match(f.mayWrite('O1/w1', '/wt/w1/src/api/x.js').reason, /outside your claim|claimed by O2/);
});

test("the other orchestrators' claims are in a worker's settings at spawn", async () => {
  const { f, hv } = await started({ enforcePath: '/tmp/enforce.sock' });
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  await hv('spawn_orchestrator', { goal: 'g2', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  await f.callOrchestrator('O1', 'claim_paths', { paths: ['src/**'] });
  await f.callOrchestrator('O2', 'claim_paths', { paths: ['docs/**'] });
  const opts = f.orchestrators.get('O2').run.workerOptions('w1', '/wt/O2-w1');
  assert.deepEqual(opts.denyWrites, ['/wt/O2-w1/src/**']);
  assert.deepEqual(opts.enforce, { socket: '/tmp/enforce.sock', session: 'O2/w1' });
});

test('attack: an expired lease, used through every tool, including after the hypervisor dies', async () => {
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 3, expires: 1 });
  await f.callOrchestrator('O1', 'claim_paths', { paths: ['src/**'] });
  await f.callOrchestrator('O1', 'spawn_worker', { task: 'a' });
  // The hypervisor dies. O1 carries on within its lease; nothing new above it.
  f.hypervisor.child = { exitCode: 1 };
  f.hypervisor.emit('change');
  assert.equal(f.hypervisorGone, true);
  assert.equal((await f.callOrchestrator('O1', 'spawn_worker', { task: 'b' })).state, 'running', 'a worker within the lease still starts');
  assert.match((await hv('spawn_orchestrator', { goal: 'g2', brief: 'b', tokens: 1_000, slots: 1, expires: 5 })).error, /no new orchestrator/);
  // Its lease still runs out on pilld's clock.
  f.advance(61_000);
  const o = f.orchestrators.get('O1');
  assert.equal(o.session.state, 'paused');
  assert.equal(o.run.workers[0].state, 'paused');
  for (const [name, args] of [['spawn_worker', { task: 'b' }], ['message_worker', { id: 'w1', text: 'go on' }], ['stop_worker', { id: 'w1' }]]) {
    assert.match((await f.callOrchestrator('O1', name, args)).error, /expired|nothing new/, name);
  }
  assert.match((await hv('resume', { id: 'O1' })).error, /expired/);
  assert.match((await hv('grant_lease', { id: 'O1', tokens: 10_000, slots: 1, expires: 60 })).error, /no new lease/);
  assert.equal(f.mayWrite('O1/w1', '/tmp/src/a.js').ok, false, 'the hook refuses writes too');
  assert.match(f.decisions.list({ kind: 'lease' }).at(-1).text, /expired/);
});

test('attack: a spent lease pauses its orchestrator; the global budget pauses everything', async () => {
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  const o = f.orchestrators.get('O1');
  o.session.emit('tokens', o.session, 10_000);
  assert.equal(o.session.state, 'paused');
  assert.match(o.haltReason, /spent/);
  assert.match((await f.callOrchestrator('O1', 'spawn_worker', { task: 'x' })).error, /spent|claim/);
  f.hypervisor.emit('tokens', f.hypervisor, 95_000);
  assert.equal(f.paused, true);
  assert.equal(f.hypervisor.state, 'paused');
});

test('attack: no MCP tool at any level merges or pushes', async () => {
  const { f, hv } = await started();
  const names = [...HYPERVISOR_TOOLS, ...ORCHESTRATOR_TOOLS].map(([n]) => n);
  assert.equal(names.some((n) => /merge_worktrees|approve|push/.test(n)), false);
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  assert.match((await f.callOrchestrator('O1', 'merge_worktrees', {})).error, /isn't yours/);
  assert.match((await hv('merge', {})).error, /unknown tool/);
  assert.match((await f.callOrchestrator('O1', 'grant_lease', { id: 'O1', tokens: 1, slots: 1, expires: 1 })).error, /unknown tool/, 'an orchestrator has no hypervisor tools');
});

test('attack: tokens decide the role; an unknown token gets nothing', async () => {
  const { f } = await started();
  assert.equal(f.resolve('forged'), null);
  const [token] = [...f.tokens.entries()].find(([, r]) => r.role === 'H');
  assert.deepEqual(f.resolve(token).tools.map(([n]) => n), HYPERVISOR_TOOLS.map(([n]) => n));
});

test('attack: no session gets a permission wider than the ceiling', async () => {
  const { f, hv } = await started({ permissionCeiling: 'default' });
  assert.equal(f.hypervisor.permissionMode, 'default');
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 60, permissionMode: 'bypassPermissions' });
  const o = f.orchestrators.get('O1');
  assert.equal(o.session.permissionMode, 'default');
  assert.equal(o.run.permissionCeiling, 'default', "the run clamps every worker to it (policy.clampPermission)");
});

test('the hypervisor is denied reading transcripts and worktrees at spawn', async () => {
  const { f } = await started();
  assert.ok(f.hypervisor.unreadable.some((p) => p.endsWith('.claude/projects')));
  assert.ok(f.hypervisor.unreadable.some((p) => p.endsWith('.botwatch-worktrees')));
  assert.match(f.hypervisor.extraArgs.join(' '), /--disallowedTools Bash,Write,Edit,NotebookEdit,Agent,Task/);
});

// ---- questions and the decision log -------------------------------------------

test('a question climbs to the hypervisor, is answered, and the answer and its cited rule are logged', async () => {
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  const pending = f.callOrchestrator('O1', 'ask_up', { question: 'Drop the old theme file?', suggestion: 'yes', worker: 'w2' });
  const [q] = f.listOrchestrators().questions;
  assert.equal(q.id, 'q1');
  assert.equal((await hv('answer', { question_id: 'q1', text: 'Keep it.', rule: 'destructive changes need the user' })).answered, 'q1');
  assert.deepEqual(await pending, { answer: 'Keep it.', by: 'H' });
  const [entry] = f.decisions.list({ kind: 'answer' });
  assert.equal(entry.chain, 'H › O1 › w2');
  assert.equal(entry.rule, 'destructive changes need the user');
  assert.equal(entry.verified, false, 'recorded as said, never as followed');
  assert.match((await hv('answer', { question_id: 'q1', text: 'again' })).error, /already/);
});

test('questions for the user: duplicates on one card, ranked by blocked work, one answer to all', async () => {
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 3, expires: 60 });
  await hv('spawn_orchestrator', { goal: 'g2', brief: 'b', tokens: 10_000, slots: 3, expires: 60 });
  const a = f.callOrchestrator('O1', 'ask_up', { question: 'Which date format?' });
  const b = f.callOrchestrator('O2', 'ask_up', { question: 'Date format: ISO or US?' });
  const c = f.callOrchestrator('O2', 'ask_up', { question: 'Delete legacy API?' });
  f.orchestrators.get('O2').run.workers.push({ id: 'w1', state: 'asking' }, { id: 'w2', state: 'asking' });
  await hv('ask_human', { question_ids: ['q1'], suggestion: 'ISO', reason: 'product' });
  await hv('ask_human', { question_ids: ['q3'], suggestion: 'no', reason: 'destructive' });
  assert.match((await hv('ask_human', { question_ids: ['q9'] })).error, /not open/);
  // q2 duplicates q1: attach it to a card with q1 by asking again together.
  const card = await hv('ask_human', { question_ids: ['q2'], suggestion: 'ISO', reason: 'same question' });
  const queue = f.humanQueue();
  assert.equal(queue[0].blocked >= queue.at(-1).blocked, true);
  assert.equal(queue[0].questions.includes('q3') || queue[0].questions.includes('q2'), true, 'O2 blocks more work, so it comes first');
  assert.equal(f.answerHuman(card.queued, 'ISO 8601').answered, card.queued);
  assert.deepEqual(await b, { answer: 'ISO 8601', by: 'human' });
  f.answerHuman('h1', 'ISO 8601');
  f.answerHuman('h2', 'Keep it');
  assert.equal((await a).by, 'human');
  assert.equal((await c).answer, 'Keep it');
  assert.equal(f.decisions.list({ kind: 'human' }).length, 3);
});

test('an orchestrator answering its worker is logged with the rule it cited', async () => {
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  await f.callOrchestrator('O1', 'claim_paths', { paths: ['src/**'] });
  await f.callOrchestrator('O1', 'spawn_worker', { task: 'a' });
  const w = f.orchestrators.get('O1').run.workers[0];
  w.state = 'asking';
  w.question = 'camelCase or snake_case?';
  await f.callOrchestrator('O1', 'message_worker', { id: 'w1', text: 'camelCase', rule: 'naming is inside my goal' });
  const [entry] = f.decisions.list({ by: 'O1', kind: 'answer' });
  assert.equal(entry.question, 'camelCase or snake_case?');
  assert.equal(entry.rule, 'naming is inside my goal');
});

// ---- what the hypervisor sees ---------------------------------------------------

test('health is facts pilld counted: stalls, errors, repeated calls, spend with nothing finished', async () => {
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  const o = f.orchestrators.get('O1');
  o.run.workers.push(
    { id: 'w1', state: 'running', lastEventAt: 1_000_000 - 6 * 60_000, log: { items: [] } },
    { id: 'w2', state: 'errored', log: { items: [] } },
    { id: 'w3', state: 'running', lastEventAt: 1_000_000, log: { items: [1, 2, 3].map(() => ({ kind: 'tool', text: '$ npm test' })) } },
  );
  f.leases.get('O1').spent = 6_000;
  const flags = f.health(o);
  assert.ok(flags.includes('w1 stalled'));
  assert.ok(flags.includes('w2 errored'));
  assert.ok(flags.some((x) => x.startsWith('w3 repeating')));
  assert.ok(flags.includes('half the lease spent with no worker finished'));
});

test('read_summary never carries a transcript', async () => {
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  await f.callOrchestrator('O1', 'report', { summary: 'two of three done' });
  const s = await hv('read_summary', { id: 'O1' });
  assert.equal(s.report, 'two of three done');
  assert.equal(JSON.stringify(s).includes('transcript'), false);
  assert.equal('log' in (s.workers[0] ?? {}), false);
});

// ---- the relay ------------------------------------------------------------------

test('the control socket routes by token: each role sees and calls only its own tools', async () => {
  const { serveControl, controlClient } = await import('../electron/orchestrator/control.js');
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  const path = join(mkdtempSync(join(tmpdir(), 'bw-ctl-')), 'c.sock');
  const server = await serveControl(() => f, path);
  const tokenOf = (role) => [...f.tokens.entries()].find(([, r]) => r.role === role)[0];
  const h = controlClient(path, tokenOf('H'));
  const o = controlClient(path, tokenOf('O'));
  const stranger = controlClient(path, 'forged');
  try {
    assert.ok((await h.call('__list', {})).tools.some(([n]) => n === 'grant_lease'));
    assert.equal((await o.call('__list', {})).tools.some(([n]) => n === 'grant_lease'), false);
    assert.match((await o.call('grant_lease', { id: 'O1', tokens: 99_000, slots: 4, expires: 600 })).error, /unknown tool/);
    assert.equal((await stranger.call('list_orchestrators', {})).error, 'not this run');
    assert.equal((await o.call('claim_paths', { paths: ['src/**'] })).granted[0], 'src/**');
  } finally {
    h.close();
    o.close();
    stranger.close();
    server.close();
  }
});

// ---- turns that end ----------------------------------------------------------------

test("an orchestrator's turn that ends on QUESTION: climbs like ask_up, and the answer comes back to it", async () => {
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  const o = f.orchestrators.get('O1');
  const said = [];
  o.session.message = (t) => said.push(t);
  o.session.state = 'asking';
  o.session.question = 'Title Case or sentence case?';
  o.session.emit('change');
  o.session.emit('change');
  const open = f.listOrchestrators().questions;
  assert.equal(open.length, 1, 'relayed once');
  hv('answer', { question_id: open[0].id, text: 'Sentence case.', rule: 'the user said so earlier' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(said, ['Answer (from the hypervisor): Sentence case.']);
});

test('an orchestrator that stops short is nudged, twice at most', async () => {
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  const o = f.orchestrators.get('O1');
  const said = [];
  o.session.message = (t) => said.push(t);
  for (let i = 0; i < 4; i += 1) {
    o.session.state = 'done';
    o.session.emit('change');
  }
  assert.equal(said.length, 2);
  assert.match(said[0], /ask_up/);
});

test("the hypervisor's own question goes to the user's card; its answer comes back", async () => {
  const { f } = await started();
  const said = [];
  f.hypervisor.message = (t) => said.push(t);
  f.hypervisor.state = 'asking';
  f.hypervisor.question = 'Which goal matters more?';
  f.hypervisor.emit('change');
  const [card] = f.humanQueue();
  assert.deepEqual(card.text, ['Which goal matters more?']);
  f.answerHuman(card.id, 'g2');
  assert.deepEqual(said, ['The user answered: g2']);
  assert.equal(f.decisions.list({ kind: 'human' })[0].chain, 'H');
});

test('a hypervisor that stops with work open is told what is open', async () => {
  const { f } = await started();
  const said = [];
  f.hypervisor.message = (t) => said.push(t);
  f.hypervisor.state = 'done';
  f.hypervisor.emit('change');
  assert.match(said[0], /goal g1 has no orchestrator/);
});

test('waiting on list_orchestrators ignores token counts and wakes on what matters', async () => {
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 60 });
  let woke = false;
  const waiting = f.waitForChange(5).then(() => (woke = true));
  f.orchestrators.get('O1').session.emit('tokens', null, 500);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(woke, false, 'tokens alone do not wake it');
  f.claimPaths('O1', ['src/**']);
  await waiting;
  assert.equal(woke, true);
});

// ---- adopting a v3 orchestrator -------------------------------------------------

test('a v3 orchestrator is adopted under a lease from its budget, declares its claim, its questions climbing', async () => {
  const { f } = await started();
  const run = new FakeRun({ repo: '/r', goal: 'v3 goal', budgetTokens: 50_000, maxWorkers: 2 });
  run.ledger.spent = 12_000;
  const session = new FakeSession({ id: 'O' });
  const told = [];
  session.message = (t) => told.push(t);
  const out = f.adopt({ run, session, token: 'v3-token' });
  assert.equal(out.id, 'O1');
  assert.equal(f.leases.get('O1').tokens, 50_000);
  assert.equal(f.leases.get('O1').spent, 12_000);
  assert.match(told[0], /claim_paths/, 'it is asked to declare its claim');
  const role = f.resolve('v3-token');
  assert.ok(role.tools.some(([n]) => n === 'ask_human'), 'it keeps the tools it was started with');
  assert.ok(role.tools.some(([n]) => n === 'claim_paths'), 'and gains claim_paths');
  assert.match((await role.call('spawn_worker', { task: 'x' })).error, /claim your paths/, 'no workers before its claim');
  assert.deepEqual((await role.call('claim_paths', { paths: ['api/**'] })).granted, ['api/**']);
  assert.equal((await role.call('spawn_worker', { task: 'x' })).state, 'running');
  const asked = role.call('ask_human', { question: 'Which DB?', worker: 'w1' });
  assert.equal(f.listOrchestrators().questions[0].question, 'Which DB?');
  f.answer('q1', 'Postgres', 'already decided for O2');
  assert.deepEqual(await asked, { answer: 'Postgres', by: 'H' });
  // Its starts now go through the fleet's gate.
  f.advance(121 * 60_000);
  assert.match((await role.call('spawn_worker', { task: 'x' })).error, /expired/);
});

test("adoption is refused when the run's budget doesn't fit what's left", async () => {
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 90_000, slots: 2, expires: 60 });
  const run = new FakeRun({ repo: '/r', goal: 'v3', budgetTokens: 20_000, maxWorkers: 1 });
  run.ledger.spent = 0;
  assert.match(f.adopt({ run, session: new FakeSession({}), token: 't' }).error, /can't adopt/);
});

// ---- recovery after pilld is killed ---------------------------------------------

test("the host records the hypervisor and every orchestrator for recovery, and recover() handles them", async () => {
  const { createFleetHost } = await import('../electron/fleet/host.js');
  const { recover } = await import('../electron/orchestrator/recovery.js');
  const { readdirSync, readFileSync: read } = await import('node:fs');
  const runsDir = mkdtempSync(join(tmpdir(), 'bw-fleet-runs-'));
  const host = createFleetHost({ controlPath: '/tmp/unused-c.sock', enforcePath: '/tmp/unused-e.sock', runsDir });
  let pid = 90_000;
  const session = (opts) => Object.assign(new FakeSession(opts), { child: { pid: pid++ } });
  await host.start({ id: 'rec', goals: [{ id: 'g1', goal: 'x', repo: '/r', priority: 1 }], budgetTokens: 100_000, maxSessions: 4, dir: mkdtempSync(join(tmpdir(), 'bw-fleet-')), session, run: (o) => new FakeRun(o) });
  await host.fleet.callHypervisor('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 1, expires: 60 });
  await new Promise((r) => setTimeout(r, 700));
  const dirs = readdirSync(runsDir).sort();
  assert.deepEqual(dirs, ['rec-H', 'rec-O1']);
  const hv = JSON.parse(read(join(runsDir, 'rec-H', 'run.json'), 'utf8'));
  assert.equal(hv.workers[0].id, 'H');
  assert.equal(hv.workers[0].pid, 90_000);
  // A later launch finds them: nothing is alive, so nothing is signalled,
  // and the hypervisor's record (no repo) is handled like any other.
  const reports = await recover({ runsDir, self: -1, isAlive: () => false });
  assert.deepEqual(reports.map((r) => r.id).sort(), ['rec-H', 'rec-O1']);
  host.fleet.stop();
  await host.fleet.close();
});

// ---- system sleep ------------------------------------------------------------------

test('leases stop while the machine sleeps and resume on wake, extended by the time asleep', async () => {
  const { f, hv } = await started();
  await hv('spawn_orchestrator', { goal: 'g1', brief: 'b', tokens: 10_000, slots: 2, expires: 10 });
  const before = f.leases.get('O1').expiresAt;
  const t0 = f.now();
  f.sleep(t0);
  // A tick on waking, before the resume event, must not expire it.
  f.advance(30 * 60_000);
  assert.equal(f.leases.get('O1').expired, false);
  f.wake(t0 + 30 * 60_000);
  assert.equal(f.leases.get('O1').expiresAt, before + 30 * 60_000);
  assert.equal(f.leases.get('O1').expired, false);
  f.advance(10 * 60_000);
  assert.equal(f.leases.get('O1').expired, true, 'the lease still runs out, after its awake minutes');
  assert.match(f.decisions.list({ kind: 'lease' }).find((d) => /woke/.test(d.text)).text, /1800s asleep/);
});

test("the host follows the power monitor's suspend and resume", async () => {
  const { createFleetHost } = await import('../electron/fleet/host.js');
  const power = new EventEmitter();
  const host = createFleetHost({ controlPath: '/tmp/u-c.sock', enforcePath: '/tmp/u-e.sock', runsDir: mkdtempSync(join(tmpdir(), 'bw-runs-')), power });
  await host.start({ id: 'pw', goals: [{ id: 'g1', goal: 'x', repo: '/r', priority: 1 }], budgetTokens: 100_000, maxSessions: 4, dir: mkdtempSync(join(tmpdir(), 'bw-fleet-')), session: (o) => new FakeSession(o), run: (o) => new FakeRun(o) });
  power.emit('suspend');
  assert.notEqual(host.fleet.suspendedAt, null);
  power.emit('resume');
  assert.equal(host.fleet.suspendedAt, null);
  await host.close();
  assert.equal(power.listenerCount('suspend'), 0);
});
