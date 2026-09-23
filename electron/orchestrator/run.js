// One orchestrator run: a goal, a worktree per task, a queue, and a budget.
//
// The model drives this through MCP, but it does not own it. Every entry point
// asks policy.js first, so "spawn twelve workers" or "merge now" fails here
// rather than in the user's repo.

import { EventEmitter } from 'node:events';

import * as budget from './budget.js';
import * as policy from './policy.js';
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
    const { branch, path } = await worktrees.create(this.repo, `${id}-${task}`);
    const worker = new Worker({
      id,
      task,
      cwd: path,
      branch,
      model,
      // Never wider than the user's own, whatever was asked for.
      permissionMode: policy.clampPermission(permissionMode, this.permissionCeiling),
    });

    worker.on('tokens', (_w, tokens) => {
      budget.record(this.ledger, id, tokens);
      // Reaching the budget pauses the run rather than letting it drift past.
      if (this.budgetExhausted) this.pauseAll('budget');
      this.emit('change', this);
    });
    worker.on('change', () => {
      // A finished worker frees its slot. Without this the queue only moved
      // when somebody stopped a worker by hand, so a run with more tasks than
      // slots would sit there forever with work waiting.
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

  // The orchestrator asks the human through pilld, never directly: the brief is
  // explicit that worker questions go up the tree, not to the user's face.
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
  // waiting two minutes.
  reap(now = Date.now(), idleMs = 120_000) {
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
