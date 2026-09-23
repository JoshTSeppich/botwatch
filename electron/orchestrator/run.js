// One orchestrator run: a goal, a worktree per task, a queue, and a budget.
//
// The model drives this through MCP, but it does not own it. Every entry point
// asks policy.js first, so "spawn twelve workers" or "merge now" fails here
// rather than in the user's repo.

import { execFile as execFileCb } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

import * as budget from './budget.js';
import * as policy from './policy.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

import * as refguard from './refguard.js';
import { guardSettings } from './settings.js';
import * as worktrees from './worktrees.js';
import { Worker } from './worker.js';

const TERMINAL = new Set(['done', 'errored', 'stopped']);

export class Run extends EventEmitter {
  // drain() emits the event that triggers drain(), so it needs to know when it
  // is already inside itself.
  #draining = false;

  constructor({ repo, goal, model, maxWorkers = 2, budgetTokens = 1_000_000, permissionCeiling = 'default' }) {
    super();
    Object.assign(this, { repo, goal, model, permissionCeiling });
    this.limits = { maxWorkers };
    this.ledger = budget.createLedger(budgetTokens);
    this.workers = [];
    this.queue = [];
    this.stopped = false;
    this.userApprovedMerge = false;
    this.pendingQuestion = null;
    this.nextId = 1;
    // Five minutes, not fifteen seconds: the orchestrator messaging a worker
    // that has finished its turn is ordinary use, not a leak, and reaping it
    // out from under a conversation would be worse than the leak was.
    this.reaper = setInterval(() => this.reap(), 60_000);
    this.reaper.unref?.();
  }

  // The ref-level guard has to exist before any worker does.
  async arm() {
    await refguard.install(this.repo);
    return this;
  }

  // Releasing closes the worker's stdin, which is what makes the CLI exit. It
  // does not just free the slot: the slot was already free when the task
  // finished, and that is exactly why the processes piled up.
  close() {
    clearInterval(this.reaper);
    for (const worker of this.workers) worker.release();
    return refguard.uninstall(this.repo).catch(() => {});
  }

  // How the orchestrator session should be launched.
  //
  // It must not run in the user's checkout. It is the most dangerous session in
  // the system — a shell, broad permissions, and the user's uncommitted work
  // sitting next to it — and it has no reason to write there: it delegates work
  // to workers and merges through pilld. So it gets its own directory, and the
  // same deny rules workers get.
  launchSpec() {
    const cwd = join(homedir(), '.claude', 'botwatch', 'runs', String(this.id ?? 'run'));
    return {
      cwd,
      settings: guardSettings({ protect: [this.repo] }),
      env: refguard.guardedEnv(),
      note: 'the orchestrator reads the repo through its workers, and never writes to it',
    };
  }

  // The user clicked Merge. BotWatch runs the merge itself, in the repo, from
  // an environment without BOTWATCH_GUARD — so the hook lets it through for the
  // same reason it lets the user's own git through. No permission has to be
  // handed to a session, which is why there is no token to forge.
  async merge(order = []) {
    const verdict = policy.canMerge(this.state);
    if (!verdict.ok) return { error: verdict.reason };

    const branches = order.length ? order : this.workers.map((w) => w.branch);
    const merged = [];
    for (const branch of branches) {
      if (!branch?.startsWith('bw/')) return { error: `refusing to merge ${branch}: not a worker branch` };
      try {
        await execFile('git', ['-C', this.repo, 'merge', '--no-ff', '-m', `botwatch: merge ${branch}`, branch]);
        merged.push(branch);
      } catch (err) {
        return { error: `merge of ${branch} failed: ${String(err.message).split('\n')[0]}`, merged };
      }
    }
    return { merged };
  }

  get budgetExhausted() {
    return budget.exhausted(this.ledger);
  }

  get state() {
    return {
      stopped: this.stopped,
      budgetExhausted: this.budgetExhausted,
      userApprovedMerge: this.userApprovedMerge,
      workers: this.workers,
    };
  }

  async spawn(task, model = this.model, permissionMode = 'default') {
    const verdict = policy.canSpawn(this.state, this.limits);
    if (!verdict.ok && !verdict.queue) return { error: verdict.reason };

    const id = `w${this.nextId++}`;
    const { branch, path, base } = await worktrees.create(this.repo, `${id}-${task}`);
    const worker = new Worker({
      id,
      task,
      cwd: path,
      branch,
      base,
      model,
      permissionMode: policy.clampPermission(permissionMode, this.permissionCeiling),
      // A worker works in its worktree. The user's checkout is not its
      // business, and cwd is not a boundary.
      protect: [this.repo],
    });

    worker.on('tokens', (_w, tokens) => {
      budget.record(this.ledger, id, tokens);
      if (this.budgetExhausted) this.pauseAll('budget');
      this.emit('change', this);
    });
    worker.on('change', () => {
      if (TERMINAL.has(worker.state)) this.drain();
      this.emit('change', this);
    });
    this.workers.push(worker);

    if (verdict.queue) {
      this.queue.push(worker);
      this.emit('change', this);
      return { id, state: 'queued', branch };
    }
    worker.start();
    this.emit('change', this);
    return { id, state: 'running', branch };
  }

  list() {
    return this.workers.map((w) => ({
      id: w.id,
      task: w.task,
      state: w.state,
      branch: w.branch,
      model: w.model,
      tokens: w.tokens,
      summary: w.summary ?? null,
      sessionId: w.sessionId,
    }));
  }

  find(id) {
    return this.workers.find((w) => w.id === id) ?? null;
  }

  ask(question, options = []) {
    this.pendingQuestion = { question, options, at: Date.now() };
    this.emit('change', this);
    return this.pendingQuestion;
  }

  answer(text) {
    this.pendingQuestion = null;
    this.emit('change', this);
    return text;
  }

  // A worker that finished and has not been spoken to since is just a live
  // process holding memory. `now` is a parameter so this is testable without
  // waiting five minutes.
  reap(now = Date.now(), idleMs = 300_000) {
    let released = 0;
    for (const worker of this.workers) {
      if (worker.doneAt && now - worker.doneAt > idleMs) {
        worker.release();
        released += 1;
      }
    }
    return released;
  }

  pauseAll(reason = 'user') {
    this.pauseReason = reason;
    for (const w of this.workers) if (w.state === 'running') w.stop();
    this.emit('change', this);
  }

  stop() {
    this.stopped = true;
    this.pauseAll('stopped');
  }

  // Starts whatever the concurrency limit now has room for.
  drain() {
    if (this.#draining) return 0;
    this.#draining = true;
    // A slot is wanted, so this is the moment finished processes are worth
    // releasing.
    this.reap();
    let started = 0;
    while (this.queue.length && policy.canSpawn(this.state, this.limits).ok) {
      this.queue.shift()?.start();
      started += 1;
    }
    this.#draining = false;
    if (started) this.emit('change', this);
    return started;
  }
}
