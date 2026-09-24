// One worker: a headless Claude Code session in its own worktree.
//
// Workers BotWatch starts are the easy case — we own the process, so status and
// tokens come straight off its stream-json stdout. No hooks, no transcript
// tailing, no guessing whether a silent tool is stuck or thinking.

import { spawn } from 'node:child_process';

import { phrase, plain } from './phrase.js';
import { guardSettings } from './settings.js';
import { guardedEnv } from './refguard.js';
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
    const usage = record.message?.usage;
    return {
      kind: 'progress',
      tool: call?.name ?? null,
      input: call?.input ?? null,
      text: Array.isArray(content) ? content.find((p) => p.type === 'text')?.text ?? null : null,
      tokens: usage
        ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        : 0,
    };
  }
  if (record.type === 'result') {
    const usage = record.usage;
    return {
      kind: 'finished',
      error: Boolean(record.is_error),
      result: record.result ?? null,
      // The result record carries the run's own usage totals, which is where
      // the last turn's tokens actually show up.
      tokens: usage
        ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        : 0,
    };
  }
  // The real plan windows, straight from the CLI. The handoff assumed these
  // were unavailable and fell back to counting tokens against a number the user
  // types in; they are not, so nothing has to be guessed.
  if (record.type === 'rate_limit_event') {
    const windows = record.rate_limit_info?.unifiedWindows ?? {};
    return {
      kind: 'limits',
      tokens: 0,
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
  '',
  'Your task:',
].join('\n');

export function workerArgs({ model, permissionMode, protect = [] }) {
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
    JSON.stringify(guardSettings({ protect })),
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
  }) {
    super();
    Object.assign(this, { id, task, cwd, branch, base, model, permissionMode, protect, gitDir, brief, extraArgs });
    this.state = 'queued';
    this.tokens = 0;
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
    this.message(`${this.brief}\n${this.task}`);

    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) this.#absorb(line);
    });

    this.child.on('exit', (code) => {
      if (this.state !== 'stopped') this.state = code === 0 ? 'done' : 'errored';
      this.emit('change', this);
    });
    return this;
  }

  #absorb(line) {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    const event = readEvent(record);
    if (!event) return;
    if (event.kind === 'started') this.sessionId = event.sessionId;
    if (event.tokens) {
      this.tokens += event.tokens;
      this.emit('tokens', this, event.tokens);
    }
    if (event.kind === 'progress' && (event.tool || event.text)) {
      this.summary = event.tool ? phrase(event.tool, event.input ?? {}) : plain(event.text);
    }
    if (event.kind === 'limits') {
      this.limits = { fiveHour: event.fiveHour, sevenDay: event.sevenDay };
      this.emit('limits', this, this.limits);
    }
    if (event.kind === 'finished') {
      this.state = event.error ? 'errored' : 'done';
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
    // candidate for reaping.
    this.doneAt = null;
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    return this.child.stdin.write(`${line}\n`);
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
