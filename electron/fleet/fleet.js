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
export const FIRST_STEP_DEFAULT = 22_000;
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
  ['claim_paths', 'Claim the repo paths your workers will change, as globs (src/ui/**). Required before spawn_worker. If another orchestrator holds an overlapping claim, this waits until the hypervisor resolves it, then returns your granted claim (which may be narrower).', { paths: 'array' }],
  ['report', 'Your summary for the hypervisor: progress, problems, what is next.', { summary: 'string' }],
  ['ask_up', 'Pass a question up to the hypervisor. Waits for the answer and returns it.', { question: 'string', options: 'array', suggestion: 'string', worker: 'string' }],
  ['request_lease', 'Ask the hypervisor for more tokens, slots or time. Returns at once; the hypervisor decides.', { tokens: 'number', slots: 'number', minutes: 'number', reason: 'string' }],
  ['enqueue_merge', "Put your finished workers' branches in the merge queue. The user approves merges; you can't.", {}],
];

// An adopted v3 orchestrator keeps its tools and gains claim_paths.
export const ADOPTED_TOOLS = [...tools.TOOLS, ORCHESTRATOR_TOOLS.find(([name]) => name === 'claim_paths')];

export const HYPERVISOR_BRIEF = [
  'You are the BotWatch hypervisor. Your only tools are the botwatch MCP tools. You never edit code and never read worker transcripts.',
  'For each goal below, write a brief and start one orchestrator with spawn_orchestrator, giving it a lease: tokens, worker slots and minutes.',
  'The leases together can never exceed the global budget; pilld refuses any that would. Split it by priority.',
  'Then call list_orchestrators with wait_seconds (60 is fine) in a loop and act on what it shows:',
  '- a lease request: grant_lease, take tokens from a lower-priority goal with grant_lease on it, or tell it to wrap up with answer;',
  '- a lock conflict: resolve_lock (run them in sequence, narrow one claim, or give the shared change to one). A claim is held until its entry is merged or rejected by the user, so a sequenced orchestrator starts after that;',
  '- a question: answer it if it is cross-goal ordering, a budget trade-off, or already answered for another orchestrator, and say which rule you used;',
  '  pass product decisions, anything destructive, and anything the user reserved to ask_human, with your suggestion and why you could not decide;',
  '  put duplicates in one ask_human call;',
  '- a health flag (stalled, errors, repeated calls, tokens with nothing finished): pause, resume, shrink its lease, or tell the user through ask_human;',
  '- entries in the merge queue: order_merge_queue by dependency and priority. The user approves merges; you cannot.',
  'Finish when every orchestrator has finished and its work is queued, with one line per goal.',
  '',
  'The goals, with the user\'s priority (1 is highest):',
].join('\n');

export const FLEET_ORCHESTRATOR_BRIEF = (slots, project = null) =>
  [
    'You are a BotWatch orchestrator under a hypervisor. Your only tools are the botwatch MCP tools.',
    'First plan, then call claim_paths with the repo paths your workers will change. You cannot spawn workers before your claim is granted.',
    `Split the goal into independent tasks, at most ${slots} running at once (your lease's slots), and start one worker per task with spawn_worker.`,
    'Call wait_for with every worker id. When they are done, check each with worker_diff and read_worker.',
    'If a worker failed, you may message_worker it once with what to fix, then wait_for it again.',
    "If a worker is asking, answer it with message_worker if your goal and repo settle it (naming, approach, tests), and say which rule you used.",
    'If pilld paused a worker for changing files outside your claim (outsideClaim in its entry), it stays paused: stop_worker it and start a new one with a clearer task, or ask_up.',
    'Pass up with ask_up: deleting shared files, schema changes, and anything touching another claim, with your suggestion. Send the answer on to the worker.',
    'Call report with a short summary after each milestone. If your lease runs low, call request_lease with a reason.',
    'When the work is done and checked, call enqueue_merge, then report, then finish with one line per worker. Your claim stays held until the user merges or rejects your entry.',
    'You cannot edit files, run commands or merge.',
    "Workers cannot commit, and must not be told to: pilld commits each worker's tree when its turn ends, with the message the worker writes after a line 'COMMIT:'. Where the repository says how commits are written, ask for that in the worker's COMMIT: message, not for git commands.",
    ...(project
      ? [
          '',
          `The repository's own instructions, its CLAUDE.md at ${project.ref}. Your workers read them in their worktrees. Plan the work and write their tasks so they can follow them:`,
          '',
          project.text,
        ]
      : []),
    '',
    'Your brief from the hypervisor:',
  ].join('\n');

// A repository's CLAUDE.md as committed at HEAD, for an orchestrator, which
// runs outside the repository and so never loads it. From the commit, not the
// working tree: nothing uncommitted, and nothing a worker wrote, reaches it.
export const PROJECT_INSTRUCTIONS_MAX = 32 * 1024;

export async function projectInstructions(repo) {
  const ref = await execFile('git', ['-C', repo, 'rev-parse', '--short', 'HEAD']).then((r) => r.stdout.trim(), () => null);
  if (!ref) return null;
  const text = await execFile('git', ['-C', repo, 'show', `${ref}:CLAUDE.md`], { maxBuffer: 4 * PROJECT_INSTRUCTIONS_MAX }).then((r) => r.stdout.trim(), () => '');
  if (!text) return null;
  return { ref, text: text.length > PROJECT_INSTRUCTIONS_MAX ? `${text.slice(0, PROJECT_INSTRUCTIONS_MAX)}\n[cut at ${PROJECT_INSTRUCTIONS_MAX.toLocaleString('en-US')} characters]` : text };
}

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
    instructions = projectInstructions,
    // Until the fleet has seen a first step: the largest measured so far
    // (21,339 tokens, a haiku worker in it-fleet-attacks overshoot, 2026-09-28),
    // rounded up.
    firstStepFloor = FIRST_STEP_DEFAULT,
  }) {
    super();
    Object.assign(this, { id, goals, budgetTokens, maxSessions, permissionCeiling, model, testCommand, allowInstalls, controlPath, enforcePath, dir, now });
    this.makeSession = session;
    this.makeRun = run;
    this.projectInstructions = instructions;
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
    this.deferred = []; // wake-ups waiting for room under the cap
    this.decisions = createDecisionLog(join(dir, 'decisions.jsonl'));
    this.firstStepDefault = firstStepFloor;
    // Largest first step seen, per role. A hypervisor plans; a worker may
    // read five files in its first message: one says nothing of the other.
    this.firstSeen = { hypervisor: 0, orchestrator: 0, worker: 0 };
    this.nextO = 1;
    this.nextQ = 1;
    this.nextC = 1;
    this.stopped = false;
    this.paused = false;
    this.clock = setInterval(() => this.tick(), 1000);
    this.clock.unref?.();
  }

  emit(event, ...args) {
    if (event === 'change' && this.deferred?.length && !this.flushing) {
      this.flushing = true;
      try {
        this.#flushDeferred();
      } finally {
        this.flushing = false;
      }
    }
    return super.emit(event, ...args);
  }

  // ---- accounting ---------------------------------------------------------

  get spent() {
    let n = this.hypervisorSpent;
    for (const lease of this.leases.values()) n += lease.spent;
    return n;
  }

  // The first-step floor, per role: the larger of the default and the
  // largest first step seen from that role. It never goes down: a smaller
  // first step seen later lowers nothing. Each gates what that role's first
  // step is spent from: the worker floor, what is left of a lease when a
  // worker starts; the orchestrator floor, a lease itself; the hypervisor
  // floor, the global budget.
  floorFor(role) {
    return Math.max(this.firstStepDefault, this.firstSeen[role] ?? 0);
  }

  // What a lease must be at least: its orchestrator's first step comes out
  // of it at once.
  get leaseFloor() {
    return this.floorFor('orchestrator');
  }

  #seeFirst(session, role) {
    const first = session?.firstStep ?? 0;
    if (first > this.firstSeen[role]) this.firstSeen[role] = first;
  }

  get budgetExhausted() {
    return this.spent >= this.budgetTokens;
  }

  // System sleep. Every session is asleep too, so nothing runs under a lease
  // while the machine sleeps, and the time asleep doesn't count against it.
  // The clock stops on suspend, so no tick on waking can expire a lease
  // before the resume that gives the time back.
  sleep(at = this.now()) {
    if (this.suspendedAt != null) return;
    this.suspendedAt = at;
    clearInterval(this.clock);
    this.decisions.record({ by: 'pilld', level: 'pilld', chain: 'H', kind: 'lease', text: 'the machine is going to sleep; leases stop' });
  }

  wake(at = this.now()) {
    if (this.suspendedAt == null) return;
    const asleep = Math.max(0, at - this.suspendedAt);
    this.suspendedAt = null;
    for (const lease of this.leases.values()) if (!lease.expired && !lease.revoked) lease.expiresAt += asleep;
    this.decisions.record({ by: 'pilld', level: 'pilld', chain: 'H', kind: 'lease', text: `the machine woke after ${Math.round(asleep / 1000)}s asleep; every live lease was extended by that` });
    this.clock = setInterval(() => this.tick(), 1000);
    this.clock.unref?.();
    this.tick(at);
    this.emit('change');
  }

  // Everything that has to happen on a clock rather than on an event: leases
  // expire on pilld's time, with or without a hypervisor.
  tick(now = this.now()) {
    if (this.suspendedAt != null) return;
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

  // ---- the session cap, for everything that sets a session running ----------

  // A session that isn't running (done, asking, paused) starts running again
  // when it is sent a message or resumed. That counts against the cap like
  // a start, so it goes through here: now if there is room, otherwise when a
  // session ends. Found by the cap attack: nudges, answers and resumes had
  // taken the fleet to 7 sessions against a cap of 3.
  #wake(session, act) {
    if (!session) return;
    if (session.state === 'running' || underCap(this).ok) {
      act();
      return;
    }
    this.deferred.push({ session, act });
  }

  #flushDeferred() {
    while (this.deferred.length && underCap(this).ok) {
      const { session, act } = this.deferred.shift();
      if (session.state === 'stopped' || this.stopped) continue;
      act();
    }
  }

  // ---- the gate every start goes through -------------------------------------

  // Whether anything new may start under an orchestrator. `queue` means wait.
  gate(id) {
    if (this.stopped) return { ok: false, reason: 'the fleet was stopped' };
    if (this.budgetExhausted) return { ok: false, reason: 'the global budget is spent' };
    const o = this.orchestrators.get(id);
    if (!o) return { ok: false, reason: `${id} is not an orchestrator of this fleet` };
    const live = leaseLive(this.leases.get(id), this.now());
    if (!live.ok) return live;
    // A new worker's first step has to fit in what is left.
    const lease = this.leases.get(id);
    const left = lease.tokens - lease.spent;
    const workerFloor = this.floorFor('worker');
    if (left < workerFloor) {
      return { ok: false, reason: `the lease has ${left.toLocaleString('en-US')} left, under the workers' first-step floor (${workerFloor.toLocaleString('en-US')}): a new worker's first step could overrun it` };
    }
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
    if (this.budgetTokens < this.floorFor('hypervisor')) return { error: `the global budget is under the hypervisor's first-step floor (${this.floorFor('hypervisor').toLocaleString('en-US')})` };
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
      enforce: this.enforcePath ? { socket: this.enforcePath, session: 'H' } : null,
      brief: HYPERVISOR_BRIEF,
      extraArgs: ['--mcp-config', await this.#mcpConfig(dir, token), '--allowedTools', 'mcp__botwatch', '--disallowedTools', 'Bash,Write,Edit,NotebookEdit,Agent,Task'],
    });
    this.hypervisor.on('tokens', (s, n) => {
      this.#seeFirst(s, 'hypervisor');
      this.#charge('H', n);
    });
    this.hypervisor.on('change', () => {
      this.#afterHypervisorTurn();
      // Its process ended: no new orchestrator and no new lease. The ones
      // running carry on within their leases, which run out on pilld's clock.
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
    this.decisions.record({ by: 'pilld', level: 'pilld', chain: 'H', kind: 'spawn', text: 'the hypervisor ended; orchestrators carry on within their leases until they expire; no new orchestrator or lease' });
    this.emit('change');
  }

  async spawnOrchestrator({ goal: goalId, brief, tokens, slots, expires }) {
    if (this.hypervisorGone || this.stopped) return { error: 'no new orchestrator: the hypervisor is gone' };
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
      enforce: this.enforcePath ? { socket: this.enforcePath, session: id } : null,
      brief: FLEET_ORCHESTRATOR_BRIEF(lease.slots, await this.projectInstructions(goal.repo)),
      extraArgs: ['--mcp-config', await this.#mcpConfig(dir, token), '--allowedTools', 'mcp__botwatch', '--disallowedTools', 'Bash,Write,Edit,NotebookEdit,Agent,Task'],
    });
    entry.session.on('tokens', (s, n) => {
      this.#seeFirst(s, 'orchestrator');
      this.#charge(id, n);
    });
    // Workers' tokens go to the run's ledger; the lease is charged from it.
    run.on('tokens', (n, workerId) => {
      this.#seeFirst(run.find?.(workerId), 'worker');
      this.#charge(id, n);
    });
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
    // Checked again after the awaits above, like a worker's start: room may
    // have gone meanwhile. If so it starts when a session ends.
    this.#wake(entry.session, () => entry.session.start());
    this.emit('change');
    return { id, lease: this.leaseView(id), ...(entry.session.state === 'running' ? {} : { state: 'queued: the session cap is reached' }) };
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
    run.on('tokens', (n, workerId) => {
      this.#seeFirst(run.find?.(workerId), 'worker');
      this.#charge(id, n);
    });
    run.on('toolResult', (worker) => void this.#checkClaim(id, worker));
    session?.on('tokens', (s, n) => {
      this.#seeFirst(s, 'orchestrator');
      this.#charge(id, n);
    });
    this.tokens.set(token, { role: 'V3', id });
    // It declares its claim like any other orchestrator, with claim_paths,
    // which its tools now include. Until then it can't start workers.
    this.#wake(session, () => session?.message?.(
      'You are now under a BotWatch hypervisor. Before you start any more workers, call claim_paths with the repo paths ' +
        'your workers will change (globs like src/ui/**). Workers already running carry on. Questions for the user now go through ask_human as before.',
    ));
    this.decisions.record({ by: 'pilld', level: 'pilld', chain: chain('H', id), kind: 'spawn', text: `adopted a v3 orchestrator as ${id}, lease ${lease.tokens.toLocaleString('en-US')} tokens, ${lease.slots} slots; asked to claim its paths` });
    this.emit('change');
    return { id, lease: this.leaseView(id) };
  }

  async callAdopted(id, name, args = {}) {
    const o = this.orchestrators.get(id);
    if (name === 'claim_paths') return this.claimPaths(id, args.paths);
    if (name === 'spawn_worker') {
      const verdict = this.gate(id);
      if (!verdict.ok && !verdict.queue) return { error: verdict.reason };
    }
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
    // Only live claims: a released one (its orchestrator queued its work) is
    // free again. Found in a real run, where it locked a sequenced worker out
    // of the very paths its own claim had just been granted.
    const denyGlobs = this.granted(o.goal.repo)
      .filter((c) => c.owner !== orchestratorId)
      .flatMap((c) => c.globs);
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
        if (out?.answer != null) this.#wake(s, () => s.message(`Answer (from ${out.by === 'human' ? 'the user' : 'the hypervisor'}): ${out.answer}`));
      });
      return;
    }
    if (s.state === 'done' && !o.finished && (o.nudges ?? 0) < 2) {
      o.nudges = (o.nudges ?? 0) + 1;
      this.#wake(s, () =>
        s.message(
          'Your turn ended, but your goal is not queued yet. Nobody reads your closing text. ' +
            'If you need a decision, call ask_up. Otherwise carry on: claim_paths, spawn_worker, wait_for, and enqueue_merge when the work is done.',
        ),
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
    this.#wake(h, () => h.message(`Your turn ended with work still open: ${waiting.join('; ')}. Nobody reads your closing text; use ask_human for the user. Carry on with list_orchestrators.`));
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

  // claim_paths as the orchestrator calls it: a claim that has to wait
  // waits, and returns once it is granted (as asked, narrowed or given).
  async claimAndWait(id, paths) {
    const first = this.claimPaths(id, paths);
    if (!first.waiting) return first;
    const o = this.orchestrators.get(id);
    await new Promise((settle) => {
      const check = () => {
        if (o.claim?.state === 'granted' || this.stopped) {
          this.off('change', check);
          settle();
        }
      };
      this.on('change', check);
    });
    return o.claim?.state === 'granted' ? { granted: o.claim.globs, after: first.waiting } : { error: 'the fleet was stopped' };
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

  // May this session use a tool at all? For the enforcement hook, on every
  // tool call of every session the fleet starts: the hypervisor ('H'), an
  // orchestrator ('O1') or a worker ('O1/w2'). Refused for a session pilld
  // doesn't know, under a lease that isn't live, or when what is left is
  // under the session's largest step so far (the reserve): the tool call
  // would bring on another step, and it wouldn't fit. A session stopped at
  // the reserve is paused with its lease, so nothing nudges it on. (With
  // pilld gone, the hook itself refuses.)
  mayUse(session) {
    const [oid, wid] = String(session ?? '').split('/');
    if (oid === 'H') {
      if (!this.hypervisor) return { ok: false, reason: 'unknown session' };
      return this.#reserve(null, this.hypervisor);
    }
    const o = this.orchestrators.get(oid);
    const s = wid ? o?.run.find?.(wid) : o?.session;
    if (!s) return { ok: false, reason: 'unknown session' };
    const live = leaseLive(this.leases.get(oid), this.now());
    if (!live.ok) return { ok: false, reason: `nothing more under this lease: ${live.reason}` };
    return this.#reserve(oid, s);
  }

  #reserve(oid, session) {
    const step = session.largestStep ?? 0;
    const globalLeft = this.budgetTokens - this.spent;
    if (step && globalLeft < step) {
      if (!this.paused) this.pauseAll('global budget reserve');
      return { ok: false, reason: `the global budget has ${Math.max(0, globalLeft).toLocaleString('en-US')} tokens left, under this session's largest step (${step.toLocaleString('en-US')})` };
    }
    if (!oid) return { ok: true };
    const lease = this.leases.get(oid);
    const left = lease.tokens - lease.spent;
    if (step && left < step) {
      if (!lease.reserveHit) {
        lease.reserveHit = { at: this.now(), left, step };
        this.decisions.record({ by: 'pilld', level: 'pilld', chain: chain('H', oid), kind: 'lease', text: `${oid}'s lease has ${left.toLocaleString('en-US')} left, under a step of ${step.toLocaleString('en-US')}: no more tool calls, and it is paused` });
        this.#halt(oid, 'lease reserve reached');
      }
      return { ok: false, reason: `the lease has ${Math.max(0, left).toLocaleString('en-US')} tokens left, under this session's largest step (${step.toLocaleString('en-US')})` };
    }
    return { ok: true };
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
    if (this.hypervisorGone) return { error: 'no new lease: the hypervisor is gone' };
    const lease = this.leases.get(id);
    if (!lease) return { error: `no orchestrator ${id}` };
    const next = { tokens: Number(tokens), slots: Number(slots), expiresAt: this.now() + minutes(expires) };
    const ok = grantable(this, id, next, this.now());
    if (!ok.ok) return { error: ok.reason };
    Object.assign(lease, next, { revoked: false, expired: false, reserveHit: null });
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
    o.run.paused = false;
    o.run.pauseReason = null;
    // Each paused session resumes when there is room under the cap.
    this.#wake(o.session, () => o.session.resume());
    for (const w of o.run.workers) if (w.state === 'paused' && !w.claimViolations?.length) this.#wake(w, () => w.resume());
    o.run.drain?.();
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
    // A question is on one card at a time. If any of these is already on an
    // open card, the others join that card rather than a second one: the
    // user must not see the same question twice (found in a real run, where
    // q1 went on one card alone and then on another with q2).
    const open = this.cards.find((c) => !c.answered && list.some((q) => c.questions.includes(q)));
    if (open) {
      for (const q of list) {
        // Already on this card, or on another open one: it stays where it is.
        const current = this.cards.find((c) => !c.answered && c.questions.includes(q));
        if (current) continue;
        open.questions.push(q);
        this.questions.get(q).card = open.id;
      }
      if (suggestion) open.suggestion = String(suggestion);
      if (reason) open.reason = String(reason);
      this.emit('change');
      return { queued: open.id, joined: true, questions: open.questions, position: this.humanQueue().findIndex((c) => c.id === open.id) + 1 };
    }
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
      this.#wake(this.hypervisor, () => this.hypervisor.message(`The user answered: ${text}`));
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
      // The claim stays held until the entry is merged or rejected: anything
      // sequenced behind it starts only after it lands, and forks from the
      // updated base. So every worker branches from the base, and nothing
      // in staging can conflict with what was queued before it.
      o.finished = true;
      this.decisions.record({ by: id, level: 'O', chain: chain('H', id), kind: 'queue', text: `queued ${branches.map((b) => b.branch).join(', ')}` });
    }
    this.emit('change');
    return out;
  }

  // The user's click on the queue. Only the host calls this, with the
  // approval set for the one call. Merged entries release their claims.
  async approveQueue(repo, { upTo, sha, override = null }) {
    const q = this.queues.get(repo);
    if (!q) return { error: 'nothing is queued for that repo' };
    const out = await q.approve({ upTo, sha, override });
    if (out.error) return out;
    for (const owner of new Set(out.owners)) this.release(owner);
    const logged = q.log.at(-1);
    this.decisions.record({ by: 'human', level: 'human', chain: 'H', kind: 'queue', text: `${logged.kind === 'override' ? `merged ${out.merged.join(', ')} despite failing tests (${logged.failing.join(', ')}); reason: ${logged.reason}` : `merged ${out.merged.join(', ')}`} at ${out.sha.slice(0, 7)}` });
    this.emit('change');
    return out;
  }

  rejectEntry(repo, id, reason) {
    const q = this.queues.get(repo);
    if (!q) return { error: 'nothing is queued for that repo' };
    const out = q.reject(id, reason);
    if (out.error) return out;
    this.release(out.owner);
    this.decisions.record({ by: 'human', level: 'human', chain: chain('H', out.owner), kind: 'queue', text: `rejected ${id}; reason: ${reason}` });
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
    if (o.session?.reconcileFailure) flags.push(`the orchestrator's token count may be low: ${o.session.reconcileFailure.reason}`);
    for (const w of o.run.workers) {
      if (quiet(w)) flags.push(`${w.id} stalled`);
      if (w.state === 'errored') flags.push(`${w.id} errored`);
      const last = w.log?.items.filter((i) => i.kind === 'tool').slice(-3).map((i) => i.text) ?? [];
      if (last.length === 3 && last.every((t) => t === last[0])) flags.push(`${w.id} repeating: ${last[0].slice(0, 60)}`);
      if (w.claimViolations?.length) flags.push(`${w.id} wrote outside its claim`);
      if (w.reconcileFailure) flags.push(`${w.id}'s token count may be low: ${w.reconcileFailure.reason}`);
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
    if (role.role === 'V3') return { tools: ADOPTED_TOOLS, call: (name, args) => this.callAdopted(role.id, name, args) };
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
    if (name === 'claim_paths') return this.claimAndWait(id, args.paths);
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
    if (name === 'message_worker' && o.run.find(args.id) && o.run.find(args.id).state !== 'running' && !underCap(this).ok) {
      return { error: `${args.id} isn't running, and waking it would pass the session cap (${this.maxSessions}); try again when a session finishes` };
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
