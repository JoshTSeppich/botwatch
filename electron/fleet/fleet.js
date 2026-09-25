// v4: the fleet. One hypervisor session, orchestrators under it (one per
// goal), and their workers. pilld holds all of it: the models decide within
// limits, and every limit is here, in code, never in a prompt.
//
// The core rule, and where each part of it lives:
// - the global token budget and each lease's share: leases.js (grants exact)
//   and the ledgers below (spending detected, then paused)
// - the maximum number of sessions running at once, across all levels:
//   leases.underCap, checked before anything starts
// - the permission ceiling: clampPermission on every session started
// - path locks and protected paths: claims.js, a settings deny at spawn for
//   other orchestrators' claims, the enforcement hook for a worker's own claim
//   and for claims made later, and a diff of the worktree for Bash
// - no merge into the user's branches and no push without their approval:
//   queue.js (staging is BotWatch's; only the user's click merges it), the
//   ref guard and the sandbox, as in v3
// - the decision log: decisions.js
//
// The hypervisor reads orchestrator summaries only: no tool returns a worker
// transcript, and its settings deny reading them.

import { EventEmitter } from 'node:events';
import { execFile as execFileCb } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { newToken } from '../orchestrator/control.js';
import { clampPermission } from '../orchestrator/policy.js';
import { Run } from '../orchestrator/run.js';
import { scriptCommand } from '../orchestrator/runtime.js';
import * as tools from '../orchestrator/tools.js';
import { Worker } from '../orchestrator/worker.js';
import * as worktrees from '../orchestrator/worktrees.js';
import * as claims from './claims.js';
import { chain, createDecisionLog } from './decisions.js';
import { grantable, leaseLive, runningSessions, underCap } from './leases.js';
import { MergeQueue } from './queue.js';

const execFile = promisify(execFileCb);
export const FLEETS_DIR = join(homedir(), '.claude', 'botwatch', 'fleets');
const STALL_MS = 5 * 60_000;

export const HYPERVISOR_TOOLS = [
  ['list_orchestrators', 'Every orchestrator: goal, state, lease, claim, health, open questions, lease requests and lock conflicts. With wait_seconds, waits up to that long for something to change first.', { wait_seconds: 'number' }],
  ['read_summary', "One orchestrator's latest report and pilld's facts about it: workers, tokens, lease, health, questions and answers. Never a transcript.", { id: 'string' }],
  ['spawn_orchestrator', 'Start an orchestrator on one of the goals, with your brief and its first lease. expires is minutes from now.', { goal: 'string', brief: 'string', tokens: 'number', slots: 'number', expires: 'number' }],
  ['grant_lease', "Set an orchestrator's lease: total tokens (at least what it has spent), worker slots, and expiry in minutes from now. Refused if the leases would exceed the global budget.", { id: 'string', tokens: 'number', slots: 'number', expires: 'number' }],
  ['revoke_lease', 'Revoke a lease: the orchestrator and its workers are paused and nothing new starts under it.', { id: 'string' }],
  ['resolve_lock', 'Resolve a path conflict: "sequence" (the waiting claim waits for the other to finish), "narrow <id> <glob>,<glob>" (replace one side\'s claim), or "give <id>" (the overlap goes to that orchestrator).', { conflict: 'string', decision: 'string' }],
  ['pause', 'Pause an orchestrator and its workers.', { id: 'string' }],
  ['resume', 'Resume a paused orchestrator and its workers. Refused while its lease is not live.', { id: 'string' }],
  ['answer', "Answer an orchestrator's question. Say which rule you used.", { question_id: 'string', text: 'string', rule: 'string' }],
  ['ask_human', 'Pass questions to the user as one card: the ids (duplicates together), your suggestion, and why you could not decide. Returns at once; the answer goes to every orchestrator that asked.', { question_ids: 'array', suggestion: 'string', reason: 'string' }],
  ['order_merge_queue', 'Set the order of the merge queue for a repo: every queued entry id, once each.', { repo: 'string', ids: 'array' }],
];

const V3_ORCHESTRATOR_TOOLS = tools.TOOLS.filter(([name]) => !['ask_human', 'merge_worktrees'].includes(name)).map(([name, description, params]) =>
  name === 'message_worker' ? [name, `${description} When it answers a worker's question, say which rule you used.`, { ...params, rule: 'string' }] : [name, description, params],
);
export const ORCHESTRATOR_TOOLS = [
  ...V3_ORCHESTRATOR_TOOLS,
  ['claim_paths', 'Claim the repo paths your workers will change, as globs (src/ui/**). Required before spawn_worker. Waits for the hypervisor if another orchestrator holds an overlapping claim.', { paths: 'array' }],
  ['report', 'Your summary for the hypervisor: progress, problems, what is next.', { summary: 'string' }],
  ['ask_up', 'Pass a question up to the hypervisor. Waits for the answer and returns it.', { question: 'string', options: 'array', suggestion: 'string', worker: 'string' }],
  ['request_lease', 'Ask the hypervisor for more tokens, slots or time. Returns at once; the hypervisor decides.', { tokens: 'number', slots: 'number', minutes: 'number', reason: 'string' }],
  ['enqueue_merge', "Put your finished workers' branches in the merge queue. The user approves merges; you can't.", {}],
];

export const HYPERVISOR_BRIEF = [
  'You are the BotWatch hypervisor. Your only tools are the botwatch MCP tools. You never edit code and never read worker transcripts.',
  'For each goal below, write a brief and start one orchestrator with spawn_orchestrator, giving it a lease: tokens, worker slots and minutes.',
  'The leases together can never exceed the global budget; pilld refuses any that would. Split it by priority.',
  'Then call list_orchestrators with wait_seconds (60 is fine) in a loop and act on what it shows:',
  '- a lease request: grant_lease, take tokens from a lower-priority goal with grant_lease on it, or tell it to wrap up with answer;',
  '- a lock conflict: resolve_lock (run them in sequence, narrow one claim, or give the shared change to one);',
  '- a question: answer it if it is cross-goal ordering, a budget trade-off, or already answered for another orchestrator, and say which rule you used;',
  '  pass product decisions, anything destructive, and anything the user reserved to ask_human, with your suggestion and why you could not decide;',
  '  put duplicates in one ask_human call;',
  '- a health flag (stalled, errors, repeated calls, tokens with nothing finished): pause, resume, shrink its lease, or tell the user through ask_human;',
  '- entries in the merge queue: order_merge_queue by dependency and priority. The user approves merges; you cannot.',
  'Finish when every orchestrator has finished and its work is queued, with one line per goal.',
  '',
  'The goals, with the user\'s priority (1 is highest):',
].join('\n');

export const FLEET_ORCHESTRATOR_BRIEF = (slots) =>
  [
    'You are a BotWatch orchestrator under a hypervisor. Your only tools are the botwatch MCP tools.',
    'First plan, then call claim_paths with the repo paths your workers will change. You cannot spawn workers before your claim is granted.',
    `Split the goal into independent tasks, at most ${slots} running at once (your lease's slots), and start one worker per task with spawn_worker.`,
    'Call wait_for with every worker id. When they are done, check each with worker_diff and read_worker.',
    'If a worker failed, you may message_worker it once with what to fix, then wait_for it again.',
    "If a worker is asking, answer it with message_worker if your goal and repo settle it (naming, approach, tests), and say which rule you used.",
    'Pass up with ask_up: deleting shared files, schema changes, and anything touching another claim, with your suggestion. Send the answer on to the worker.',
    'Call report with a short summary after each milestone. If your lease runs low, call request_lease with a reason.',
    'When the work is done and checked, call enqueue_merge, then report, then finish with one line per worker.',
    'You cannot edit files, run commands or merge.',
    '',
    'Your brief from the hypervisor:',
  ].join('\n');

function minutes(n) {
  return Number(n) * 60_000;
}

export class Fleet extends EventEmitter {
  constructor({
    id = Date.now().toString(36),
    goals = [], // [{ id: 'g1', goal, repo, priority }]
    budgetTokens,
    maxSessions,
    permissionCeiling = 'acceptEdits',
    model = 'sonnet',
    testCommand = null,
    allowInstalls = false,
    controlPath,
    enforcePath,
    dir = join(FLEETS_DIR, id),
    now = () => Date.now(),
    session = (opts) => new Worker(opts),
    run = (opts) => new Run(opts),
  }) {
    super();
    Object.assign(this, { id, goals, budgetTokens, maxSessions, permissionCeiling, model, testCommand, allowInstalls, controlPath, enforcePath, dir, now });
    this.makeSession = session;
    this.makeRun = run;
    this.hypervisor = null;
    this.hypervisorSpent = 0;
    this.hypervisorGone = false;
    this.orchestrators = new Map(); // O1 -> entry
    this.leases = new Map(); // O1 -> { tokens, slots, expiresAt, spent, revoked, expired }
    this.questions = new Map(); // q1 -> question
    this.cards = []; // human question cards
    this.requests = []; // lease requests
    this.conflicts = new Map(); // c1 -> { claimant, holders, pairs }
    this.queues = new Map(); // repo -> MergeQueue
    this.tokens = new Map(); // token -> role
    this.decisions = createDecisionLog(join(dir, 'decisions.jsonl'));
    this.nextO = 1;
    this.nextQ = 1;
    this.nextC = 1;
    this.stopped = false;
    this.paused = false;
    this.clock = setInterval(() => this.tick(), 1000);
    this.clock.unref?.();
  }

  // ---- accounting ---------------------------------------------------------

  get spent() {
    let n = this.hypervisorSpent;
    for (const lease of this.leases.values()) n += lease.spent;
    return n;
  }

  get budgetExhausted() {
    return this.spent >= this.budgetTokens;
  }

  // Everything that has to happen on a clock rather than on an event: leases
  // expire on pilld's time, with or without a hypervisor.
  tick(now = this.now()) {
    for (const [id, lease] of this.leases) {
      if (!lease.expired && !lease.revoked && now >= lease.expiresAt) {
        lease.expired = true;
        this.decisions.record({ by: 'pilld', level: 'pilld', chain: chain('H', id), kind: 'lease', text: `${id}'s lease expired; ${id} and its workers are paused` });
        this.#halt(id, 'lease expired');
      }
    }
  }

  #charge(id, tokens) {
    if (!(tokens > 0)) return;
    if (id === 'H') this.hypervisorSpent += tokens;
    else {
      const lease = this.leases.get(id);
      if (lease) lease.spent += tokens;
      if (lease && lease.spent >= lease.tokens) this.#halt(id, 'lease spent');
    }
    if (this.budgetExhausted && !this.paused) this.pauseAll('global budget spent');
    this.emit('change');
  }

  // Paused, not stopped: the sessions stay and can carry on under a new lease.
  #halt(id, reason) {
    const o = this.orchestrators.get(id);
    if (!o) return;
    o.haltReason = reason;
    o.run.pauseAll(reason);
    o.session?.pause();
    this.emit('change');
  }

  pauseAll(reason = 'user') {
    this.paused = true;
    this.pauseReason = reason;
    this.hypervisor?.pause();
    for (const id of this.orchestrators.keys()) this.#halt(id, reason);
    this.emit('change');
  }

  // ---- the gate every start goes through -------------------------------------

  // Whether anything new may start under an orchestrator. `queue` means wait.
  gate(id) {
    if (this.stopped) return { ok: false, reason: 'the fleet was stopped' };
    if (this.hypervisorGone) return { ok: false, reason: 'the hypervisor is gone, so nothing new starts' };
    if (this.budgetExhausted) return { ok: false, reason: 'the global budget is spent' };
    const o = this.orchestrators.get(id);
    if (!o) return { ok: false, reason: `${id} is not an orchestrator of this fleet` };
    const live = leaseLive(this.leases.get(id), this.now());
    if (!live.ok) return live;
    if (o.claim?.state !== 'granted') {
      return { ok: false, reason: o.claim ? 'your claim is waiting on a conflict the hypervisor has to resolve' : 'claim your paths with claim_paths before spawning workers' };
    }
    return underCap(this);
  }

  // ---- starting sessions -----------------------------------------------------

  async #mcpConfig(dir, token) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const mcp = scriptCommand(new URL('../orchestrator/mcp.js', import.meta.url));
    const path = join(dir, 'mcp.json');
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: { botwatch: { command: mcp.command, args: mcp.args, env: { ...mcp.env, BOTWATCH_RUN_TOKEN: token, BOTWATCH_CONTROL_SOCK: this.controlPath } } },
      }),
      { mode: 0o600 },
    );
    await chmod(path, 0o600);
    return path;
  }

  // Transcripts and worktrees, for the hypervisor's deny rules.
  #unreadable() {
    const paths = [join(homedir(), '.claude', 'projects')];
    for (const g of this.goals) paths.push(resolve(g.repo, '..', '.botwatch-worktrees'));
    return paths;
  }

  async start() {
    const cap = underCap(this);
    if (!cap.ok) return { error: cap.reason };
    const token = newToken();
    this.tokens.set(token, { role: 'H' });
    const dir = join(this.dir, 'H');
    const goals = this.goals.map((g) => `- ${g.id} (priority ${g.priority}, repo ${g.repo}): ${g.goal}`).join('\n');
    this.hypervisor = this.makeSession({
      id: 'H',
      task: `${goals}\n\nGlobal budget: ${this.budgetTokens.toLocaleString('en-US')} tokens. Session cap: ${this.maxSessions} running at once, you included.`,
      cwd: dir,
      model: this.model,
      permissionMode: clampPermission('default', this.permissionCeiling),
      protect: this.goals.map((g) => g.repo),
      unreadable: this.#unreadable(),
      brief: HYPERVISOR_BRIEF,
      extraArgs: ['--mcp-config', await this.#mcpConfig(dir, token), '--allowedTools', 'mcp__botwatch', '--disallowedTools', 'Bash,Write,Edit,NotebookEdit,Agent,Task'],
    });
    this.hypervisor.on('tokens', (_s, n) => this.#charge('H', n));
    this.hypervisor.on('change', () => {
      this.#afterHypervisorTurn();
      // Its process ended: nothing new starts, and the leases run out on
      // pilld's clock.
      if (!this.hypervisorGone && this.hypervisor.child && this.hypervisor.child.exitCode !== null) this.#hypervisorGone();
      this.emit('change');
    });
    this.hypervisor.start();
    this.hypervisor.child?.once?.('exit', () => this.#hypervisorGone());
    return { ok: true, id: this.id };
  }

  #hypervisorGone() {
    if (this.hypervisorGone) return;
    this.hypervisorGone = true;
    this.decisions.record({ by: 'pilld', level: 'pilld', chain: 'H', kind: 'spawn', text: 'the hypervisor ended; orchestrators run until their leases expire, and nothing new starts' });
    this.emit('change');
  }

  async spawnOrchestrator({ goal: goalId, brief, tokens, slots, expires }) {
    if (this.hypervisorGone || this.stopped) return { error: 'nothing new starts now' };
    const goal = this.goals.find((g) => g.id === goalId);
    if (!goal) return { error: `no goal ${goalId}; the goals are ${this.goals.map((g) => g.id).join(', ')}` };
    if ([...this.orchestrators.values()].some((o) => o.goal.id === goalId && !o.finished)) return { error: `${goalId} already has an orchestrator` };
    const id = `O${this.nextO}`;
    const lease = { tokens: Number(tokens), slots: Number(slots), expiresAt: this.now() + minutes(expires) };
    const ok = grantable(this, id, lease, this.now());
    if (!ok.ok) return { error: ok.reason };
    const cap = underCap(this);
    if (!cap.ok) return { error: cap.reason };
    this.nextO += 1;
    this.leases.set(id, { ...lease, spent: 0, revoked: false, expired: false });

    const run = this.makeRun({
      repo: goal.repo,
      goal: goal.goal,
      model: this.model,
      maxWorkers: lease.slots,
      budgetTokens: lease.tokens,
      permissionCeiling: this.permissionCeiling,
      testCommand: this.testCommand,
      allowInstalls: this.allowInstalls,
    });
    run.id = `${this.id}-${id}`;
    run.startedAt = this.now();
    run.gate = () => this.gate(id);
    run.workerOptions = (workerId, cwd) => this.#workerOptions(id, workerId, cwd);
    await run.arm?.();
    const token = newToken();
    this.tokens.set(token, { role: 'O', id });
    const dir = join(this.dir, id);
    const entry = { id, goal, brief: String(brief ?? ''), run, token, session: null, claim: null, summary: null, reports: [], finished: false, violations: [] };
    this.orchestrators.set(id, entry);

    entry.session = this.makeSession({
      id,
      task: String(brief ?? goal.goal),
      cwd: dir,
      model: this.model,
      permissionMode: clampPermission('default', this.permissionCeiling),
      protect: [goal.repo],
      brief: FLEET_ORCHESTRATOR_BRIEF(lease.slots),
      extraArgs: ['--mcp-config', await this.#mcpConfig(dir, token), '--allowedTools', 'mcp__botwatch', '--disallowedTools', 'Bash,Write,Edit,NotebookEdit,Agent,Task'],
    });
    entry.session.on('tokens', (_s, n) => this.#charge(id, n));
    // Workers' tokens go to the run's ledger; the lease is charged from it.
    run.on('tokens', (n) => this.#charge(id, n));
    run.on('change', () => {
      for (const o of this.orchestrators.values()) o.run.drain?.();
      this.emit('change');
    });
    run.on('toolResult', (worker, part) => void this.#checkClaim(id, worker, part));
    entry.session.on('change', () => {
      this.#afterTurn(entry);
      this.emit('change');
    });
    this.decisions.record({ by: 'H', level: 'H', chain: chain('H', id), kind: 'spawn', text: `started ${id} on ${goalId} with ${lease.tokens.toLocaleString('en-US')} tokens, ${lease.slots} slots, ${expires} minutes` });
    entry.session.start();
    this.emit('change');
    return { id, lease: this.leaseView(id) };
  }

  // A v3 orchestrator the user started before the fleet, brought under it.
  // It keeps its own tools (its relay's token is the v3 one), and from now on
  // its starts go through the fleet's gate: a lease made from its budget, the
  // global cap, and a claim of its whole repo, since it can't state a
  // narrower one. Its questions climb the chain like ask_up.
  adopt({ run, session, token, goal = run.goal, expires = 120 }) {
    if (this.hypervisorGone || this.stopped) return { error: 'nothing new starts now' };
    const id = `O${this.nextO}`;
    const lease = { tokens: Math.max(run.ledger.limitTokens, run.ledger.spent + 1), slots: run.limits.maxWorkers, expiresAt: this.now() + minutes(expires) };
    const ok = grantable(this, id, lease, this.now());
    if (!ok.ok) return { error: `can't adopt: ${ok.reason}` };
    this.nextO += 1;
    this.leases.set(id, { ...lease, spent: run.ledger.spent, revoked: false, expired: false });
    const entry = { id, goal: { id: `v3-${run.id ?? id}`, goal, repo: run.repo, priority: null }, brief: '', run, token, session, claim: null, summary: null, reports: [], finished: false, violations: [], adopted: true };
    this.orchestrators.set(id, entry);
    run.gate = () => this.gate(id);
    run.workerOptions = (workerId, cwd) => this.#workerOptions(id, workerId, cwd);
    run.on('tokens', (n) => this.#charge(id, n));
    run.on('toolResult', (worker) => void this.#checkClaim(id, worker));
    session?.on('tokens', (_s, n) => this.#charge(id, n));
    this.tokens.set(token, { role: 'V3', id });
    const claim = this.claimPaths(id, ['**']);
    this.decisions.record({ by: 'pilld', level: 'pilld', chain: chain('H', id), kind: 'spawn', text: `adopted a v3 orchestrator as ${id}, lease ${lease.tokens.toLocaleString('en-US')} tokens, ${lease.slots} slots; claim ${claim.granted ? 'granted' : 'waiting'}` });
    this.emit('change');
    return { id, lease: this.leaseView(id), claim };
  }

  async callAdopted(id, name, args = {}) {
    const o = this.orchestrators.get(id);
    const live = leaseLive(this.leases.get(id), this.now());
    if (['spawn_worker', 'message_worker', 'stop_worker'].includes(name) && !live.ok) return { error: live.reason };
    if (name === 'ask_human') return this.askUp(id, { question: args.question, options: args.options, suggestion: args.suggestion, worker: args.worker });
    return tools.call(o.run, name, args);
  }

  // What a worker is started with: the other orchestrators' claims denied in
  // its settings (prevented, tools and Bash), its identity for the
  // enforcement hook, and the hook itself.
  #workerOptions(orchestratorId, workerId, cwd) {
    const o = this.orchestrators.get(orchestratorId);
    const denyGlobs = [];
    for (const other of this.orchestrators.values()) {
      if (other.id === orchestratorId || other.goal.repo !== o.goal.repo || other.claim?.state !== 'granted') continue;
      denyGlobs.push(...other.claim.globs);
    }
    return {
      denyWrites: denyGlobs.map((g) => join(cwd, g)),
      enforce: this.enforcePath ? { socket: this.enforcePath, session: `${orchestratorId}/${workerId}` } : null,
    };
  }

  // An orchestrator's turn ended. A turn that ends on "QUESTION:" is a
  // question: it goes up the chain like ask_up, and the answer comes back as
  // its next message. A turn that ends with the goal unfinished gets a nudge
  // (twice at most): nobody reads an orchestrator's closing text.
  #afterTurn(o) {
    const s = o.session;
    if (!s || this.stopped || o.haltReason) return;
    if (s.state === 'asking' && s.question && o.relayed !== s.question) {
      o.relayed = s.question;
      void this.askUp(o.id, { question: s.question }).then((out) => {
        if (out?.answer != null) s.message(`Answer (from ${out.by === 'human' ? 'the user' : 'the hypervisor'}): ${out.answer}`);
      });
      return;
    }
    if (s.state === 'done' && !o.finished && (o.nudges ?? 0) < 2) {
      o.nudges = (o.nudges ?? 0) + 1;
      s.message(
        'Your turn ended, but your goal is not queued yet. Nobody reads your closing text. ' +
          'If you need a decision, call ask_up. Otherwise carry on: claim_paths, spawn_worker, wait_for, and enqueue_merge when the work is done.',
      );
    }
  }

  // The hypervisor's turn ended. On "QUESTION:" its question goes to the
  // user's card; with orchestrators still working or things waiting on it,
  // it is told what is waiting (three times at most).
  #afterHypervisorTurn() {
    const h = this.hypervisor;
    if (!h || this.stopped || this.hypervisorGone) return;
    if (h.state === 'asking' && h.question && this.hRelayed !== h.question) {
      this.hRelayed = h.question;
      this.cards.push({ id: `h${this.cards.length + 1}`, questions: [], own: h.question, from: 'H', suggestion: '', reason: '', at: this.now(), answered: null });
      this.emit('change');
      return;
    }
    if (h.state !== 'done' || (this.hNudges ?? 0) >= 3) return;
    const view = this.listOrchestrators();
    const waiting = [
      ...view.orchestrators.filter((o) => !['queued'].includes(o.state) && !String(o.state).startsWith('paused')).map((o) => `${o.id} is ${o.state}`),
      ...view.questions.filter((q) => !q.card).map((q) => `question ${q.id} from ${q.from}`),
      ...view.requests.map((r) => `a lease request from ${r.id}`),
      ...view.conflicts.map((c) => `lock conflict ${c.id}`),
    ];
    const unstarted = this.goals.filter((g) => !this.orchestrators.size || ![...this.orchestrators.values()].some((o) => o.goal.id === g.id));
    for (const g of unstarted) waiting.push(`goal ${g.id} has no orchestrator`);
    if (!waiting.length) return;
    this.hNudges = (this.hNudges ?? 0) + 1;
    h.message(`Your turn ended with work still open: ${waiting.join('; ')}. Nobody reads your closing text; use ask_human for the user. Carry on with list_orchestrators.`);
  }

  // ---- claims ----------------------------------------------------------------

  granted(repo) {
    return [...this.orchestrators.values()]
      .filter((o) => o.goal.repo === repo && o.claim?.state === 'granted' && !o.claim.released)
      .map((o) => ({ owner: o.id, repo, globs: o.claim.globs }));
  }

  claimPaths(id, paths) {
    const o = this.orchestrators.get(id);
    const globs = (Array.isArray(paths) ? paths : [paths]).map(claims.normalize);
    if (!globs.length || globs.some((g) => !g)) return { error: 'paths must be repo-relative globs, like src/ui/**' };
    const found = claims.conflictsWith(this.granted(o.goal.repo), { owner: id, repo: o.goal.repo, globs });
    if (!found.length) {
      o.claim = { globs, state: 'granted', at: this.now() };
      this.emit('change');
      return { granted: globs };
    }
    const conflict = `c${this.nextC++}`;
    o.claim = { globs, state: 'waiting', conflict, at: this.now() };
    this.conflicts.set(conflict, { id: conflict, claimant: id, holders: found.map((f) => f.owner), pairs: found.flatMap((f) => f.pairs.map((p) => ({ with: f.owner, mine: p[0], theirs: p[1] }))) });
    this.emit('change');
    return { waiting: conflict, overlaps: this.conflicts.get(conflict).pairs, note: 'the hypervisor resolves it; spawn_worker is refused until then' };
  }

  // Re-checks every waiting claim: after a release, a narrowing or a give.
  #reconsider() {
    for (const o of this.orchestrators.values()) {
      if (o.claim?.state !== 'waiting') continue;
      const found = claims.conflictsWith(this.granted(o.goal.repo), { owner: o.id, repo: o.goal.repo, globs: o.claim.globs });
      if (!found.length) {
        this.conflicts.delete(o.claim.conflict);
        o.claim = { globs: o.claim.globs, state: 'granted', at: this.now() };
      }
    }
    this.emit('change');
  }

  resolveLock(conflictId, decision) {
    const c = this.conflicts.get(conflictId);
    if (!c) return { error: `no conflict ${conflictId}` };
    const text = String(decision ?? '').trim();
    const [kind, who, list] = text.split(/\s+/);
    if (kind === 'sequence') {
      c.sequenced = true;
    } else if (kind === 'narrow') {
      const o = this.orchestrators.get(who);
      if (!o || (who !== c.claimant && !c.holders.includes(who))) return { error: `narrow names one side of ${conflictId}: ${[c.claimant, ...c.holders].join(', ')}` };
      const globs = String(list ?? '').split(',').map(claims.normalize);
      if (!globs.length || globs.some((g) => !g)) return { error: 'narrow needs repo-relative globs, comma-separated' };
      o.claim = { ...o.claim, globs };
    } else if (kind === 'give') {
      const winner = this.orchestrators.get(who);
      if (!winner || (who !== c.claimant && !c.holders.includes(who))) return { error: `give names one side of ${conflictId}: ${[c.claimant, ...c.holders].join(', ')}` };
      for (const id of [c.claimant, ...c.holders]) {
        if (id === who) continue;
        const loser = this.orchestrators.get(id);
        loser.claim = { ...loser.claim, globs: loser.claim.globs.filter((g) => !winner.claim.globs.some((w) => claims.overlaps(g, w))) };
      }
      if (who === c.claimant) this.orchestrators.get(who).claim = { ...winner.claim, state: 'granted' };
    } else {
      return { error: 'decision is "sequence", "narrow <id> <globs>" or "give <id>"' };
    }
    this.decisions.record({ by: 'H', level: 'H', chain: chain('H', c.claimant), kind: 'lock', text: `${conflictId}: ${text}` });
    this.#reconsider();
    return { resolved: conflictId, claims: [c.claimant, ...c.holders].map((id) => ({ id, ...this.orchestrators.get(id).claim })) };
  }

  release(id) {
    const o = this.orchestrators.get(id);
    if (o?.claim) o.claim.released = true;
    this.#reconsider();
  }

  // May this session write this path? For the enforcement hook, answered
  // from live state, so claims made after a worker started still hold.
  mayWrite(session, path) {
    const [oid, wid] = String(session ?? '').split('/');
    const o = this.orchestrators.get(oid);
    const worker = o?.run.find?.(wid);
    if (!worker) return { ok: false, reason: 'unknown session' };
    const live = leaseLive(this.leases.get(oid), this.now());
    if (!live.ok) return { ok: false, reason: `no writes: ${live.reason}` };
    const abs = resolve(worker.cwd, String(path ?? ''));
    const rel = relative(worker.cwd, abs);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || resolve(rel) === rel) return { ok: false, reason: `${abs} is outside your worktree` };
    if (o.claim?.state !== 'granted' || !claims.matches(rel, o.claim.globs)) return { ok: false, reason: `${rel} is outside your claim (${(o.claim?.globs ?? []).join(', ')})` };
    const holder = this.granted(o.goal.repo).find((c) => c.owner !== oid && claims.matches(rel, c.globs));
    if (holder) return { ok: false, reason: `${rel} is claimed by ${holder.owner}` };
    return { ok: true };
  }

  // Detection, for what the hook can't see: after any tool call, the
  // worktree's changes against the claim. A change outside it pauses the
  // worker, and the orchestrator is told.
  async #checkClaim(id, worker) {
    const o = this.orchestrators.get(id);
    if (!o?.claim || !worker?.cwd) return;
    const { stdout } = await execFile('git', ['-C', worker.cwd, 'status', '--porcelain', '--untracked-files=all']).catch(() => ({ stdout: '' }));
    const changed = stdout.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop());
    const others = this.granted(o.goal.repo).filter((c) => c.owner !== id);
    const bad = changed.filter((p) => !claims.matches(p, o.claim.globs) || others.some((c) => claims.matches(p, c.globs)));
    const fresh = bad.filter((p) => !(worker.claimViolations ?? []).includes(p));
    if (!fresh.length) return;
    worker.claimViolations = [...(worker.claimViolations ?? []), ...fresh];
    o.violations.push({ worker: worker.id, paths: fresh, at: this.now() });
    worker.pause?.();
    this.decisions.record({ by: 'pilld', level: 'pilld', chain: chain('H', id, worker.id), kind: 'pause', text: `${worker.id} changed ${fresh.join(', ')} outside its claim; paused (detected after the tool call, not prevented)` });
    this.emit('change');
  }

  // ---- leases ----------------------------------------------------------------

  leaseView(id) {
    const l = this.leases.get(id);
    if (!l) return null;
    return { tokens: l.tokens, spent: l.spent, slots: l.slots, expiresAt: l.expiresAt, minutesLeft: Math.max(0, Math.round((l.expiresAt - this.now()) / 60_000)), revoked: l.revoked, expired: l.expired };
  }

  grantLease({ id, tokens, slots, expires }) {
    if (this.hypervisorGone) return { error: 'nothing new starts now' };
    const lease = this.leases.get(id);
    if (!lease) return { error: `no orchestrator ${id}` };
    const next = { tokens: Number(tokens), slots: Number(slots), expiresAt: this.now() + minutes(expires) };
    const ok = grantable(this, id, next, this.now());
    if (!ok.ok) return { error: ok.reason };
    Object.assign(lease, next, { revoked: false, expired: false });
    const o = this.orchestrators.get(id);
    o.run.ledger.limitTokens = lease.tokens;
    o.run.limits.maxWorkers = lease.slots;
    this.requests = this.requests.filter((r) => r.id !== id);
    this.decisions.record({ by: 'H', level: 'H', chain: chain('H', id), kind: 'lease', text: `granted ${id} ${lease.tokens.toLocaleString('en-US')} tokens, ${lease.slots} slots, ${expires} minutes` });
    this.emit('change');
    return { lease: this.leaseView(id) };
  }

  revokeLease(id) {
    const lease = this.leases.get(id);
    if (!lease) return { error: `no orchestrator ${id}` };
    lease.revoked = true;
    this.decisions.record({ by: 'H', level: 'H', chain: chain('H', id), kind: 'lease', text: `revoked ${id}'s lease` });
    this.#halt(id, 'lease revoked');
    return { revoked: id };
  }

  requestLease(id, { tokens, slots, minutes: mins, reason }) {
    this.requests = this.requests.filter((r) => r.id !== id);
    this.requests.push({ id, tokens: Number(tokens) || null, slots: Number(slots) || null, minutes: Number(mins) || null, reason: String(reason ?? ''), at: this.now() });
    this.emit('change');
    return { requested: true, note: 'the hypervisor decides; carry on within your lease' };
  }

  pause(id) {
    if (!this.orchestrators.has(id)) return { error: `no orchestrator ${id}` };
    this.decisions.record({ by: 'H', level: 'H', chain: chain('H', id), kind: 'pause', text: `paused ${id}` });
    this.#halt(id, 'paused by the hypervisor');
    return { paused: id };
  }

  resume(id) {
    const o = this.orchestrators.get(id);
    if (!o) return { error: `no orchestrator ${id}` };
    const live = leaseLive(this.leases.get(id), this.now());
    if (!live.ok) return { error: `can't resume ${id}: ${live.reason}` };
    if (this.budgetExhausted) return { error: 'the global budget is spent' };
    o.haltReason = null;
    const out = o.run.resumeAll();
    if (out.error) return out;
    o.session?.resume();
    this.decisions.record({ by: 'H', level: 'H', chain: chain('H', id), kind: 'resume', text: `resumed ${id}` });
    this.emit('change');
    return { resumed: id };
  }

  // ---- questions -------------------------------------------------------------

  // Blocked work: the orchestrator itself, and its workers that are asking or
  // waiting on it. A count pilld makes, not an estimate.
  blocked(id) {
    const o = this.orchestrators.get(id);
    return 1 + (o?.run.workers.filter((w) => w.state === 'asking').length ?? 0);
  }

  askUp(id, { question, options = [], suggestion = '', worker = null }) {
    const qid = `q${this.nextQ++}`;
    return new Promise((settle) => {
      this.questions.set(qid, { id: qid, from: id, worker, chain: chain('H', id, worker), question: String(question ?? ''), options: (options ?? []).map(String), suggestion: String(suggestion ?? ''), at: this.now(), settle, answered: null });
      this.emit('change');
    });
  }

  answer(qid, text, rule, by = 'H') {
    const q = this.questions.get(qid);
    if (!q) return { error: `no question ${qid}` };
    if (q.answered) return { error: `${qid} was already answered` };
    q.answered = { text: String(text ?? ''), by, at: this.now() };
    this.decisions.record({ by, level: by === 'human' ? 'human' : 'H', chain: q.chain, kind: by === 'human' ? 'human' : 'answer', question: q.question, text, rule });
    q.settle({ answer: String(text ?? ''), by });
    this.emit('change');
    return { answered: qid };
  }

  askHuman(ids, { suggestion = '', reason = '' }) {
    const list = (ids ?? []).map(String);
    const missing = list.filter((q) => !this.questions.get(q) || this.questions.get(q).answered);
    if (!list.length || missing.length) return { error: `not open questions: ${missing.join(', ') || '(none given)'}` };
    const card = { id: `h${this.cards.length + 1}`, questions: list, suggestion: String(suggestion), reason: String(reason), at: this.now(), answered: null };
    this.cards.push(card);
    for (const q of list) this.questions.get(q).card = card.id;
    this.emit('change');
    return { queued: card.id, position: this.humanQueue().findIndex((c) => c.id === card.id) + 1 };
  }

  // The user's queue, ranked by how much work waits on each card.
  humanQueue() {
    return this.cards
      .filter((c) => !c.answered)
      .map((c) => ({
        ...c,
        // The hypervisor's own question holds up the whole fleet's planning.
        blocked: c.own ? this.orchestrators.size + 1 : c.questions.reduce((n, q) => n + this.blocked(this.questions.get(q).from), 0),
        text: c.own ? [c.own] : c.questions.map((q) => this.questions.get(q).question),
      }))
      .sort((a, b) => b.blocked - a.blocked || a.at - b.at);
  }

  // The existing question card's answer, from the pill.
  answerHuman(cardId, text) {
    const card = this.cards.find((c) => c.id === cardId && !c.answered);
    if (!card) return { error: 'no such question waiting' };
    card.answered = { text: String(text), at: this.now() };
    if (card.own) {
      this.decisions.record({ by: 'human', level: 'human', chain: 'H', kind: 'human', question: card.own, text });
      this.hypervisor?.message(`The user answered: ${text}`);
      this.emit('change');
    }
    for (const q of card.questions) this.answer(q, text, null, 'human');
    return { answered: card.id };
  }

  // ---- merge queue -----------------------------------------------------------

  queueFor(repo) {
    if (!this.queues.has(repo)) {
      this.queues.set(repo, new MergeQueue({ repo, id: this.id, base: this.orchestratorsFor(repo)[0]?.run.workers[0]?.base ?? 'main', testCommand: this.testCommand }));
    }
    return this.queues.get(repo);
  }

  orchestratorsFor(repo) {
    return [...this.orchestrators.values()].filter((o) => o.goal.repo === repo);
  }

  async enqueue(id) {
    const o = this.orchestrators.get(id);
    await o.run.resnapshotAll?.();
    const ready = o.run.workers.filter((w) => w.state === 'done' && w.snapshot?.sha && !w.takenOver);
    // A branch with changes outside the claim never reaches the queue.
    const branches = [];
    for (const w of ready) {
      const { stdout } = await execFile('git', ['-C', o.goal.repo, 'diff', '--name-only', `${w.base ?? 'main'}...${w.snapshot.sha}`]).catch(() => ({ stdout: '' }));
      const outside = claims.outside(stdout.split('\n').filter(Boolean), o.claim?.globs ?? []);
      if (outside.length) return { error: `${w.id}'s branch changes ${outside.join(', ')}, outside your claim; it can't be queued` };
      branches.push({ branch: w.branch, sha: w.snapshot.sha, worker: w.id });
    }
    const out = this.queueFor(o.goal.repo).enqueue(id, branches);
    if (!out.error) {
      o.finished = true;
      this.release(id);
      this.decisions.record({ by: id, level: 'O', chain: chain('H', id), kind: 'queue', text: `queued ${branches.map((b) => b.branch).join(', ')}` });
    }
    this.emit('change');
    return out;
  }

  orderQueue(repo, ids) {
    const q = this.queues.get(repo);
    if (!q) return { error: `nothing queued for ${repo}` };
    const out = q.order((ids ?? []).map(String));
    if (!out.error) this.decisions.record({ by: 'H', level: 'H', chain: 'H', kind: 'queue', text: `ordered ${repo}: ${ids.join(', ')}` });
    this.emit('change');
    return out;
  }

  // ---- what the hypervisor sees ------------------------------------------------

  health(o, now = this.now()) {
    const flags = [];
    const quiet = (s) => s?.state === 'running' && s.lastEventAt && now - s.lastEventAt > STALL_MS;
    if (quiet(o.session)) flags.push('orchestrator stalled');
    for (const w of o.run.workers) {
      if (quiet(w)) flags.push(`${w.id} stalled`);
      if (w.state === 'errored') flags.push(`${w.id} errored`);
      const last = w.log?.items.filter((i) => i.kind === 'tool').slice(-3).map((i) => i.text) ?? [];
      if (last.length === 3 && last.every((t) => t === last[0])) flags.push(`${w.id} repeating: ${last[0].slice(0, 60)}`);
      if (w.claimViolations?.length) flags.push(`${w.id} wrote outside its claim`);
    }
    const done = o.run.workers.filter((w) => w.state === 'done').length;
    const lease = this.leases.get(o.id);
    if (lease && lease.spent > 0 && done === 0 && lease.spent > lease.tokens / 2) flags.push('half the lease spent with no worker finished');
    return flags;
  }

  listOrchestrators() {
    return {
      budget: { tokens: this.budgetTokens, spent: this.spent, leased: [...this.leases.values()].reduce((n, l) => n + l.tokens, 0) + this.hypervisorSpent },
      sessions: { running: runningSessions(this), cap: this.maxSessions },
      goals: this.goals.map((g) => ({ ...g, orchestrator: [...this.orchestrators.values()].find((o) => o.goal.id === g.id)?.id ?? null })),
      orchestrators: [...this.orchestrators.values()].map((o) => ({
        id: o.id,
        goal: o.goal.id,
        state: o.haltReason ? `paused: ${o.haltReason}` : o.finished ? 'queued' : o.session?.state,
        lease: this.leaseView(o.id),
        claim: o.claim,
        workers: o.run.workers.map((w) => `${w.id} ${w.state}`),
        health: this.health(o),
        summary: o.summary,
      })),
      questions: [...this.questions.values()].filter((q) => !q.answered).map((q) => ({ id: q.id, from: q.from, worker: q.worker, question: q.question, options: q.options, suggestion: q.suggestion, blocked: this.blocked(q.from), card: q.card ?? null })),
      requests: this.requests,
      conflicts: [...this.conflicts.values()],
      queues: [...this.queues.entries()].map(([repo, q]) => ({ repo, ...q.view() })),
      hypervisorGone: this.hypervisorGone,
    };
  }

  // What the hypervisor would act on. Token counts move all the time and
  // are not in it, so waiting doesn't turn into polling.
  digest() {
    return JSON.stringify({
      o: [...this.orchestrators.values()].map((o) => [o.id, o.session?.state, o.haltReason, o.finished, o.claim?.state, o.run.workers.map((w) => w.state), this.health(o)]),
      q: [...this.questions.values()].filter((q) => !q.answered).map((q) => q.id),
      r: this.requests.map((r) => `${r.id}@${r.at}`),
      c: [...this.conflicts.keys()],
      m: [...this.queues.values()].map((q) => q.pending().map((e) => e.id)),
      g: this.hypervisorGone,
    });
  }

  // Waits until something the hypervisor would act on changes, or the time is up.
  waitForChange(seconds) {
    const ms = Math.min(Math.max(Number(seconds) || 0, 0), 300) * 1000;
    if (!ms) return Promise.resolve(this.listOrchestrators());
    const before = this.digest();
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer);
        this.off('change', check);
        done(this.listOrchestrators());
      };
      const check = () => {
        if (this.digest() !== before) finish();
      };
      const timer = setTimeout(finish, ms);
      this.on('change', check);
    });
  }

  readSummary(id) {
    const o = this.orchestrators.get(id);
    if (!o) return { error: `no orchestrator ${id}` };
    return {
      id,
      goal: o.goal,
      report: o.summary,
      reports: o.reports.slice(-5),
      lease: this.leaseView(id),
      claim: o.claim,
      health: this.health(o),
      // pilld's own facts about the workers: state, tokens, one-line summary.
      // Never a transcript.
      workers: o.run.list(),
      violations: o.violations,
      questions: [...this.questions.values()].filter((q) => q.from === id).map((q) => ({ id: q.id, question: q.question, answered: q.answered })),
    };
  }

  report(id, summary) {
    const o = this.orchestrators.get(id);
    o.summary = String(summary ?? '');
    o.reports.push({ at: this.now(), summary: o.summary });
    this.emit('change');
    return { reported: true };
  }

  // ---- the MCP boundary --------------------------------------------------------

  // What a relay's token may do. Unknown tokens get nothing.
  resolve(token) {
    const role = this.tokens.get(token);
    if (!role) return null;
    if (role.role === 'H') return { tools: HYPERVISOR_TOOLS, call: (name, args) => this.callHypervisor(name, args) };
    if (role.role === 'V3') return { tools: tools.TOOLS, call: (name, args) => this.callAdopted(role.id, name, args) };
    return { tools: ORCHESTRATOR_TOOLS, call: (name, args) => this.callOrchestrator(role.id, name, args) };
  }

  async callHypervisor(name, args = {}) {
    if (name === 'list_orchestrators') return this.waitForChange(args.wait_seconds);
    if (name === 'read_summary') return this.readSummary(args.id);
    if (name === 'spawn_orchestrator') return this.spawnOrchestrator(args);
    if (name === 'grant_lease') return this.grantLease(args);
    if (name === 'revoke_lease') return this.revokeLease(args.id);
    if (name === 'resolve_lock') return this.resolveLock(args.conflict, args.decision);
    if (name === 'pause') return this.pause(args.id);
    if (name === 'resume') return this.resume(args.id);
    if (name === 'answer') return this.answer(args.question_id, args.text, args.rule, 'H');
    if (name === 'ask_human') return this.askHuman(args.question_ids, args);
    if (name === 'order_merge_queue') return this.orderQueue(args.repo, args.ids);
    return { error: `unknown tool ${name}` };
  }

  async callOrchestrator(id, name, args = {}) {
    const o = this.orchestrators.get(id);
    if (!o) return { error: 'not an orchestrator of this fleet' };
    if (name === 'claim_paths') return this.claimPaths(id, args.paths);
    if (name === 'report') return this.report(id, args.summary);
    if (name === 'ask_up') return this.askUp(id, args);
    if (name === 'request_lease') return this.requestLease(id, args);
    if (name === 'enqueue_merge') return this.enqueue(id);
    if (name === 'spawn_worker') {
      const verdict = this.gate(id);
      if (!verdict.ok && !verdict.queue) return { error: verdict.reason };
    }
    if (['message_worker', 'stop_worker'].includes(name) || name === 'spawn_worker') {
      const live = leaseLive(this.leases.get(id), this.now());
      if (!live.ok) return { error: live.reason };
    }
    if (name === 'message_worker' && o.run.find(args.id)?.state === 'asking') {
      const worker = o.run.find(args.id);
      this.decisions.record({ by: id, level: 'O', chain: chain('H', id, args.id), kind: 'answer', question: worker.question, text: args.text, rule: args.rule });
    }
    if (['ask_human', 'merge_worktrees'].includes(name)) return { error: `${name} isn't yours under a hypervisor: use ask_up, or enqueue_merge` };
    return tools.call(o.run, name, args);
  }

  // ---- ending ------------------------------------------------------------------

  stop() {
    this.stopped = true;
    for (const q of this.questions.values()) if (!q.answered) q.settle({ error: 'the fleet was stopped' });
    for (const o of this.orchestrators.values()) {
      o.run.stop();
      o.session?.stop();
    }
    this.hypervisor?.stop();
    this.emit('change');
  }

  async close() {
    clearInterval(this.clock);
    for (const o of this.orchestrators.values()) await o.run.close?.();
    for (const q of this.queues.values()) await q.close();
  }
}
