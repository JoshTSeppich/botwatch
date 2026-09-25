// The cap on what one step can read, for the guard hook.
//
// A budget is enforced from tokens as they are reported, so the step that
// crosses the line is already spent. How much a step can spend is mostly how
// much tool output enters the context at once: five parallel 60KB reads made
// one step of 112,553 tokens (measured on 2.1.282). So a Read is capped in
// size, and the Reads of one model message are capped in number and in total.
//
// Grouping calls by message. The hook payload doesn't say which message a
// call came from, the calls of one message run one after another (each
// PreToolUse and PostToolUse pair finishes before the next begins), and the
// message itself isn't in the transcript yet when the hook fires. What is
// measurably constant across one message's calls, and changes between
// messages, is the number of distinct assistant messages already in the
// session's transcript — for the main thread (written after the calls) and a
// subagent's own transcript (written before them) alike. That count is the
// step's key.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const MAX_READ_BYTES = 32_000;
export const MAX_READS_PER_STEP = 4;
export const MAX_STEP_BYTES = 64_000;

// Claude Code's Read: 2,000 lines unless told otherwise, each line cut at
// 2,000 characters, and each prefixed with its number and a tab.
const DEFAULT_LINES = 2000;
const LINE_CHARS = 2000;
const PREFIX = 7;
const BINARY = /\.(png|jpe?g|gif|webp|bmp|tiff?|pdf|ipynb)$/i;

// Roughly what a Read brings into the context, in bytes. An estimate from
// the file itself, erring high: the line-number prefix is counted.
export function readBytes(text, { offset, limit } = {}) {
  const lines = String(text).split('\n');
  const start = Math.max(0, (Number(offset) || 1) - 1);
  const count = Number(limit) > 0 ? Number(limit) : DEFAULT_LINES;
  let bytes = 0;
  for (const line of lines.slice(start, start + count)) bytes += Math.min(line.length, LINE_CHARS) + PREFIX;
  return bytes;
}

// One decision, pure: the step's ledger in, the verdict and the new ledger out.
export function decide(ledger, key, bytes, limits = {}) {
  const maxRead = limits.maxRead ?? MAX_READ_BYTES;
  const maxReads = limits.maxReads ?? MAX_READS_PER_STEP;
  const maxStep = limits.maxStep ?? MAX_STEP_BYTES;
  const step = ledger && ledger.key === key ? ledger : { key, reads: 0, bytes: 0 };
  if (bytes > maxRead) {
    return { ok: false, ledger: step, reason: `this Read would bring in about ${bytes.toLocaleString('en-US')} bytes; one Read may bring in ${maxRead.toLocaleString('en-US')}. Read it in parts with offset and limit.` };
  }
  if (step.reads + 1 > maxReads) {
    return { ok: false, ledger: step, reason: `one message may make ${maxReads} Reads; read the rest in your next message.` };
  }
  if (step.bytes + bytes > maxStep) {
    return { ok: false, ledger: step, reason: `the Reads in this message would bring in about ${(step.bytes + bytes).toLocaleString('en-US')} bytes; one message may bring in ${maxStep.toLocaleString('en-US')}. Read the rest in your next message.` };
  }
  return { ok: true, ledger: { key, reads: step.reads + 1, bytes: step.bytes + bytes } };
}

// The transcript the calling session writes: a subagent's own, or the main one.
export function transcriptFor(event) {
  const main = event?.transcript_path;
  if (!main) return null;
  if (!event.agent_id) return main;
  return join(dirname(main), basename(main, '.jsonl'), 'subagents', `agent-${event.agent_id}.jsonl`);
}

// Counts distinct assistant message ids, reading only what was appended
// since the last look. `seen` is kept in the ledger between calls.
export function countMessages(path, seen = { offset: 0, ids: [] }) {
  if (!path || !existsSync(path)) return { offset: 0, ids: [] };
  const size = statSync(path).size;
  const ids = new Set(size < seen.offset ? [] : seen.ids);
  let offset = size < seen.offset ? 0 : seen.offset;
  if (size > offset) {
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(size - offset);
      readSync(fd, buffer, 0, buffer.length, offset);
      const text = buffer.toString('utf8');
      const cut = text.lastIndexOf('\n');
      if (cut !== -1) {
        for (const line of text.slice(0, cut).split('\n')) {
          if (!line.includes('"assistant"')) continue;
          try {
            const r = JSON.parse(line);
            if (r.type === 'assistant' && r.message?.id) ids.add(r.message.id);
          } catch {}
        }
        offset += Buffer.byteLength(text.slice(0, cut + 1), 'utf8');
      }
    } finally {
      closeSync(fd);
    }
  }
  return { offset, ids: [...ids] };
}

export const LEDGER_DIR = join(homedir(), '.claude', 'botwatch', 'steps');

// The whole check for one Read call. Returns { ok } or { ok: false, reason }.
// Anything unexpected throws, and the hook's `|| exit 2` makes that a refusal.
export function checkRead(event, { dir = LEDGER_DIR, limits } = {}) {
  const input = event?.tool_input ?? {};
  const file = input.file_path ? resolve(event.cwd ?? '/', input.file_path) : null;
  // A file that isn't there, or that the session may not read, is the
  // tool's own business to refuse: this only measures what would come in.
  if (!file || !existsSync(file)) return { ok: true };
  let bytes;
  try {
    bytes = BINARY.test(file) ? statSync(file).size : readBytes(readFileSync(file, 'utf8'), input);
  } catch {
    return { ok: true };
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${String(event.session_id ?? 'unknown').replace(/[^\w-]/g, '')}${event.agent_id ? `-${String(event.agent_id).replace(/[^\w-]/g, '')}` : ''}.json`;
  const path = join(dir, name);
  const known = existsSync(path);
  // A session's first Read clears ledgers nobody has touched for a day.
  if (!known) prune(dir);
  const saved = known ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const seen = countMessages(transcriptFor(event), saved.seen);
  const verdict = decide(saved.step, seen.ids.length, bytes, limits);
  writeFileSync(path, JSON.stringify({ seen, step: verdict.ledger }));
  return verdict.ok ? { ok: true } : { ok: false, reason: `BotWatch caps what one step can read: ${verdict.reason}` };
}

function prune(dir, now = Date.now()) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > 86_400_000) rmSync(path, { force: true });
    } catch {}
  }
}
