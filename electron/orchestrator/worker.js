// One worker: a headless Claude Code session in its own worktree.
//
// Workers BotWatch starts are the easy case — we own the process, so status and
// tokens come straight off its stream-json stdout. No hooks, no transcript
// tailing, no guessing whether a silent tool is stuck or thinking.

import { spawn } from 'node:child_process';
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
      text: Array.isArray(content) ? content.find((p) => p.type === 'text')?.text ?? null : null,
      tokens: usage
        ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        : 0,
    };
  }
  if (record.type === 'result') {
    return {
      kind: 'finished',
      error: Boolean(record.is_error),
      result: record.result ?? null,
      tokens: 0,
    };
  }
  return null;
}

export class Worker extends EventEmitter {
  constructor({ id, task, cwd, branch, model, permissionMode }) {
    super();
    Object.assign(this, { id, task, cwd, branch, model, permissionMode });
    this.state = 'queued';
    this.tokens = 0;
    this.sessionId = null;
    this.child = null;
  }

  start() {
    const args = [
      '-p',
      this.task,
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--model',
      this.model,
      '--permission-mode',
      this.permissionMode,
    ];
    this.child = spawn('claude', args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.state = 'running';

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
      this.summary = event.tool ? `running ${event.tool}` : event.text;
    }
    if (event.kind === 'finished') this.state = event.error ? 'errored' : 'done';
    this.emit('change', this);
  }

  // Realtime input is why the worker is spawned with --input-format stream-json:
  // the orchestrator can answer a worker without restarting it.
  message(text) {
    if (!this.child?.stdin.writable) return false;
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    return this.child.stdin.write(`${line}\n`);
  }

  stop() {
    this.state = 'stopped';
    this.child?.kill('SIGTERM');
    this.emit('change', this);
  }
}
