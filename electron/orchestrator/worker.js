// One worker: a headless Claude Code session in its own worktree.
//
// Workers BotWatch starts are the easy case — we own the process, so status and
// tokens come straight off its stream-json stdout. No hooks, no transcript
// tailing, no guessing whether a silent tool is stuck or thinking.

import { spawn } from 'node:child_process';

import { appendLog, logEntries } from './log.js';
import { phrase, plain } from './phrase.js';
import { guardSettings } from './settings.js';
import { guardedEnv } from './refguard.js';
import { createMeter } from '../tokens.js';
import { EventEmitter } from 'node:events';

// Turns stream-json lines into the handful of facts a worker row shows.
export function readEvent(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.type === 'system' && record.subtype === 'init') {
    return { kind: 'started', sessionId: record.session_id ?? null };
  }
  if (record.type === 'assistant') {
    const content = record.message?.content ?? [];
    const call = Array.isArray(content) ? content.find((p) => p.type === 'tool_use') : null;
    return {
      kind: 'progress',
      tool: call?.name ?? null,
      input: call?.input ?? null,
      text: Array.isArray(content) ? content.find((p) => p.type === 'text')?.text ?? null : null,
    };
  }
  if (record.type === 'result') {
    return { kind: 'finished', error: Boolean(record.is_error), result: record.result ?? null };
  }
  // The real plan windows, straight from the CLI. The handoff assumed these
  // were unavailable and fell back to counting tokens against a number the user
  // types in; they are not, so nothing has to be guessed.
  if (record.type === 'rate_limit_event') {
    const windows = record.rate_limit_info?.unifiedWindows ?? {};
    return {
      kind: 'limits',
      fiveHour: windows.five_hour ?? null,
      sevenDay: windows.seven_day ?? null,
    };
  }
  return null;
}

// The task is deliberately absent from these arguments. With
// --input-format stream-json the CLI waits for its prompt on stdin, so passing
// it positionally leaves the worker hanging forever with no session and no
// events — which is exactly what it did the first time I ran it.
// Models commit by habit. Without this a worker spends tokens fighting
// index.lock, and a determined one goes looking for a way around the sandbox.
// Telling it plainly is cheaper than letting it find out.
export const WORKER_BRIEF = [
  'You are a BotWatch worker in a git worktree on your own branch.',
  'Do not run git commit, git add, git merge, git push, git rebase or git reset.',
  'You cannot commit: the repository is read-only to you and the attempt will fail.',
  'BotWatch snapshots your working tree to your branch when you finish. Just edit files.',
  'git status and git diff are fine, and are how you check your own work.',
  'Keep shell commands plain: single commands and pipes run without asking, but loops and $(…)',
  'substitutions are refused here, because nobody is present to approve them.',
  'If you need a decision you cannot make from the task, do not guess: end your turn with one line',
  "starting 'QUESTION:' followed by the question, and wait. The answer will come as your next message.",
  '',
  'Your task:',
].join('\n');

// Said up front, so a worker that needs a package asks instead of spending its
// turn on retries. The sandbox's own refusal names the host as well.
export const NO_INSTALLS = [
  'Package installs are off for this run: your shell cannot reach the network at all, so npm, PyPI',
  'and crates.io are unreachable. Use what is already installed. If the task cannot be',
  "done without installing something, don't work around it: end your turn with 'QUESTION:' naming",
  'the package and why, so the user can rerun with installs allowed.',
].join('\n');

// The worker's own words after "QUESTION:", or null.
export function questionIn(text) {
  const match = /^\s*QUESTION:\s*(.+)$/im.exec(String(text ?? ''));
  return match ? match[1].trim() : null;
}

export function workerArgs({ model, permissionMode, protect = [], allowInstalls = false }) {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    '--permission-mode',
    permissionMode,
    // The guard travels with every worker. Without it, permissionMode is the
    // only limit and a worker can merge its own branch.
    '--settings',
    JSON.stringify(guardSettings({ protect, allowInstalls })),
    // None of the user's MCP servers: a browser, mail, docs — each a way out
    // the sandbox never sees. The orchestrator adds BotWatch's own.
    '--strict-mcp-config',
  ];
}

export class Worker extends EventEmitter {
  // `brief` and `extraArgs` are how the orchestrator session reuses this: it
  // is the same kind of process with a different job and an MCP server.
  constructor({
    id,
    task,
    cwd,
    branch,
    base,
    model,
    permissionMode,
    protect = [],
    gitDir = null,
    brief = WORKER_BRIEF,
    extraArgs = [],
    allowInstalls = false,
  }) {
    super();
    Object.assign(this, { id, task, cwd, branch, base, model, permissionMode, protect, gitDir, brief, extraArgs, allowInstalls });
    this.state = 'queued';
    // Counted once per API message, trued up at each result: see tokens.js.
    this.meter = createMeter();
    this.tokens = 0;
    // What the log panel shows; see log.js.
    this.log = { seq: 0, items: [] };
    this.sessionId = null;
    this.child = null;
  }

  start() {
    const args = [...workerArgs(this), ...this.extraArgs];
    this.child = spawn('claude', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: guardedEnv(),
    });
    this.state = 'running';
    this.message(`${this.brief}${this.allowInstalls ? '' : `\n${NO_INSTALLS}`}\n${this.task}`);

    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) this.#absorb(line);
    });

    this.child.on('exit', (code) => {
      if (this.state !== 'stopped') this.state = code === 0 ? 'done' : 'errored';
      // A crash mid-turn never reports a finished turn, so nothing marked the
      // moment its work stopped. Marking it here is what gets that partial
      // work snapshotted and reviewable. (It still can't merge: it isn't done.)
      if (this.state === 'errored' && !this.doneAt) this.doneAt = Date.now();
      this.emit('change', this);
    });
    return this;
  }

  // For tests: feed one stream record as if the CLI had written it.
  _feed(record) {
    this.#absorb(JSON.stringify(record));
  }

  #absorb(line) {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    const entries = logEntries(record);
    if (entries.length) {
      appendLog(this.log, entries);
      this.emit('log', this);
    }
    const tokens = this.meter.absorb(record);
    if (tokens) {
      this.tokens += tokens;
      this.emit('tokens', this, tokens);
    }
    const event = readEvent(record);
    if (!event) return;
    if (event.kind === 'started') this.sessionId = event.sessionId;
    if (event.kind === 'progress' && (event.tool || event.text)) {
      this.summary = event.tool ? phrase(event.tool, event.input ?? {}) : plain(event.text);
    }
    if (event.kind === 'limits') {
      this.limits = { fiveHour: event.fiveHour, sevenDay: event.sevenDay };
      this.emit('limits', this, this.limits);
    }
    if (event.kind === 'finished' && this.pausing) {
      // The turn our interrupt ended. It reports as an error, but nothing
      // went wrong: the worker is paused, not errored, and its work is not
      // finished, so nothing is snapshotted.
      this.pausing = false;
      this.emit('change', this);
      return;
    }
    if (event.kind === 'finished') {
      // A turn that ends on a question is not finished work: nothing is
      // snapshotted, it cannot merge, and the orchestrator is told.
      this.question = event.error ? null : questionIn(event.result);
      this.state = event.error ? 'errored' : this.question ? 'asking' : 'done';
      // The process stays alive and answerable after its turn, which is how
      // message_worker works at all. It also means a finished worker is a live
      // `claude` holding memory until something releases it.
      this.doneAt = Date.now();
    }
    this.emit('change', this);
  }

  // Realtime input is why the worker is spawned with --input-format stream-json:
  // the orchestrator can answer a worker without restarting it.
  message(text) {
    if (!this.child?.stdin.writable) return false;
    // Talking to a finished worker puts it back in use, so it is no longer a
    // candidate for reaping — and an answered question is work again.
    this.doneAt = null;
    if (this.state === 'asking' || this.state === 'done') {
      this.state = 'running';
      this.question = null;
      this.emit('change', this);
    }
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    return this.child.stdin.write(`${line}\n`);
  }

  // Pause: interrupt the turn in flight, the way the Agent SDK does, over the
  // same stream-json stdin. Measured on 2.1.281: acknowledged at once, the turn
  // ends, the session stays alive, and a later message continues it.
  pause() {
    if (this.state !== 'running' || !this.child?.stdin.writable) return false;
    this.pausing = true;
    this.child.stdin.write(
      `${JSON.stringify({ type: 'control_request', request_id: `pause-${Date.now()}`, request: { subtype: 'interrupt' } })}\n`,
    );
    this.state = 'paused';
    this.emit('change', this);
    return true;
  }

  resume() {
    if (this.state !== 'paused') return false;
    this.state = 'running';
    const sent = this.message('Continue where you left off.');
    this.emit('change', this);
    return Boolean(sent);
  }

  // Ends the session politely: closing stdin lets the CLI exit on its own.
  release() {
    this.doneAt = null;
    if (this.child?.stdin.writable) this.child.stdin.end();
  }

  stop() {
    this.state = 'stopped';
    this.child?.kill('SIGTERM');
    this.emit('change', this);
  }
}
