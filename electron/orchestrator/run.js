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
import { review } from './review.js';
import { runTests } from './testrun.js';
import { guardSettings } from './settings.js';
import * as worktrees from './worktrees.js';
import { Worker } from './worker.js';

const TERMINAL = new Set(['done', 'errored', 'stopped']);

function lastLine(text) {
  return String(text ?? '').trim().split('\n').pop() ?? '';
}

// A commit subject, not a transcript of the prompt. First line, first sentence,
// trimmed to something a git log can show.
export function snapshotMessage(worker) {
  const first = String(worker.task ?? worker.branch ?? 'work').split('\n')[0].trim();
  const sentence = first.split(/(?<=[.!?])\s/)[0].replace(/[.\s]+$/, '');
  const subject = sentence.length > 60 ? `${sentence.slice(0, 59).trimEnd()}\u2026` : sentence;
  return `botwatch(${worker.id ?? 'w'}): ${subject || 'worker changes'}`;
}

export class Run extends EventEmitter {
  // drain() emits the event that triggers drain(), so it needs to know when it
  // is already inside itself.
  #draining = false;

  constructor({
    repo,
    goal,
    model,
    maxWorkers = 2,
    budgetTokens = 1_000_000,
    permissionCeiling = 'default',
    testCommand = null,
  }) {
    super();
    Object.assign(this, { repo, goal, model, permissionCeiling, testCommand });
    this.merges = [];
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

  // Snapshots a worker's tree the moment its turn ends, not when the user
  // clicks Merge. Review, the test result and the diff all need a real commit
  // to point at before anyone decides whether to merge — and a follow-up
  // message produces a follow-up turn, which gets its own snapshot.
  async snapshot(worker) {
    if (!worker?.doneAt || worker.snapshottedFor === worker.doneAt) return null;
    worker.snapshottedFor = worker.doneAt;
    const result = await this.commitWorktree(worker.branch).catch((err) => ({
      error: String(err?.message ?? err),
    }));
    if (result?.error) return result;
    // Provenance: which commit this is, when it was taken, and what the tests
    // said about that exact commit. The review panel shows all of it, and
    // merge() refuses a branch that has moved on from it.
    worker.snapshot = { sha: await this.tip(worker.branch).catch(() => null), at: Date.now() };
    worker.test = { command: this.testCommand, running: Boolean(this.testCommand) };
    this.emit('change', this);
    worker.test = await this.testWorktree(worker);
    this.emit('change', this);
    return result;
  }

  // Separate so tests can stand in for a real test run.
  testWorktree(worker) {
    return runTests(worker.cwd, this.testCommand);
  }

  async tip(branch) {
    const { stdout } = await execFile('git', ['-C', this.repo, 'rev-parse', '--verify', `refs/heads/${branch}`]);
    return stdout.trim();
  }

  // Turns a worker's edits into a commit on its own branch. Runs as pilld, not
  // as the worker, so nothing in the sandbox has to be loosened for it.
  async commitWorktree(branch) {
    const worker = this.workers.find((w) => w.branch === branch);
    if (!worker?.cwd) return { error: `no worktree for ${branch}` };
    const { stdout } = await execFile('git', ['-C', worker.cwd, 'status', '--porcelain']);
    if (!stdout.trim()) return { committed: false, reason: 'nothing to commit' };
    await execFile('git', ['-C', worker.cwd, 'add', '-A']);
    // Author is the worker, committer is the user. pilld does the committing,
    // but it did not write the code, and `git blame` should not say it did.
    await execFile('git', [
      '-C',
      worker.cwd,
      'commit',
      '--author',
      `BotWatch (${worker.id ?? 'worker'}) <botwatch@localhost>`,
      '-m',
      snapshotMessage(worker),
    ]);
    return { committed: true };
  }

  // What Merge is about to bring in, per worker. The UI shows this; merge()
  // also refuses on it, so the gate is not only a disabled button.
  async reviewAll() {
    const out = [];
    for (const worker of this.workers) {
      if (!worker.cwd) continue;
      out.push({
        id: worker.id,
        task: worker.task,
        branch: worker.branch,
        base: worker.base ?? 'main',
        sha: await this.tip(worker.branch).catch(() => null),
        snapshot: worker.snapshot ?? null,
        test: worker.test ?? null,
        ...(await review(worker.cwd, worker.base ?? 'main')),
      });
    }
    return out;
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
  //
  // `reviewed` is what the user was shown: each branch and the commit it was
  // at. What merges is that commit, and only if the branch is still there —
  // a worker that ran another turn after the review has changed what Merge
  // would bring in. `acknowledged` names each flagged file the user ticked,
  // as "w1:.env"; a flag nobody ticked stops the merge.
  async merge({ reviewed = [], acknowledged = [] } = {}) {
    const verdict = policy.canMerge(this.state);
    if (!verdict.ok) return { error: verdict.reason };
    if (!reviewed.length) return { error: 'nothing was reviewed' };

    for (const { branch } of reviewed) {
      if (!branch?.startsWith('bw/')) return { error: `refusing to merge ${branch}: not a worker branch` };
    }

    const reviews = await this.reviewAll();
    const byBranch = new Map(reviews.map((r) => [r.branch, r]));
    const ticked = new Set(acknowledged);
    const landed = new Set(this.merges.map((m) => m.branch));
    for (const { branch, sha } of reviewed) {
      const current = byBranch.get(branch);
      if (!current) return { error: `${branch} is not a branch of this run` };
      const worker = this.workers.find((w) => w.branch === branch);
      const verdict = policy.canMergeBranch(worker, { reviewedSha: sha, tipSha: current.sha, merged: landed.has(branch) });
      if (!verdict.ok) return { error: verdict.reason };
    }
    const unacknowledged = reviewed
      .flatMap(({ branch }) => byBranch.get(branch).flagged.map((f) => ({ worker: byBranch.get(branch).id, ...f })))
      .filter((f) => !ticked.has(`${f.worker}:${f.file}`));
    if (unacknowledged.length) {
      return { error: 'review flagged files that should probably not be merged', flagged: unacknowledged };
    }

    // The cleanup below aborts a failed merge. If the checkout was already
    // mid-merge, that abort would throw away the user's own.
    const midMerge = await execFile('git', ['-C', this.repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'])
      .then(() => true)
      .catch(() => false);
    if (midMerge) return { error: 'your checkout is in the middle of a merge; finish or abort it first' };

    const merged = [];
    for (const { branch, sha } of reviewed) {
      const worker = byBranch.get(branch);
      try {
        await execFile('git', [
          '-C',
          this.repo,
          'merge',
          '--no-ff',
          '-m',
          `botwatch: merge ${branch} (${worker.id} @ ${sha.slice(0, 7)})`,
          sha,
        ]);
        merged.push({ branch, sha, worker: worker.id, at: Date.now() });
      } catch (err) {
        // Say what collided before putting the checkout back: once aborted,
        // git no longer knows.
        const conflicted = await execFile('git', ['-C', this.repo, 'diff', '--name-only', '--diff-filter=U'])
          .then(({ stdout }) => stdout.trim().split('\n').filter(Boolean))
          .catch(() => []);
        await execFile('git', ['-C', this.repo, 'merge', '--abort']).catch(() => {});
        this.merges.push(...merged);
        const why = conflicted.length
          ? `conflicts with what is already on your branch in ${conflicted.join(', ')}`
          : lastLine(err.stderr) || 'git refused it';
        return { error: `merge of ${branch} failed: ${why}. Nothing was changed.`, conflicted, merged };
      }
    }
    this.merges.push(...merged);
    this.emit('change', this);
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

  // The mode the user chose in setup is what a worker gets unless the
  // orchestrator asks for less. Defaulting to 'default' instead left headless
  // workers unable to edit anything: in -p there is nobody to approve a write.
  async spawn(task, model = this.model, permissionMode = this.permissionCeiling) {
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
      if (TERMINAL.has(worker.state)) {
        this.drain();
        void this.snapshot(worker);
      }
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
