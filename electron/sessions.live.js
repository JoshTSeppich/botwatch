// Real session discovery. Three sources, each for what only it knows:
//
//   ~/.claude/sessions/<pid>.json          which sessions exist: pid, sessionId, cwd, startedAt
//   hook events, via bw-hook and pilld     what each one is doing, and whether it needs you
//   ~/.claude/projects/<slug>/<id>.jsonl   model and per-turn token usage
//
// The transcript still says what a session is doing until its first hook event
// arrives — a session started before BotWatch, or one with the plugin not
// installed. Once a hook has spoken for a session, the transcript never
// overrides it.
//
// It deliberately does not read ~/.claude/stats-cache.json: on this machine
// that file was five months stale, so today's numbers come from the transcripts
// themselves.
//
// Two fields are not written down anywhere and are not invented here: a
// remaining-time estimate (nothing reports one — the view falls back to elapsed)
// and the spec's plain-language summary (the honest version is the tool in
// flight).

import { execFile } from 'node:child_process';
import { readdir, readFile, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { firstSentence, phrase } from './phrase.js';
import { createRegistry, STALL_AFTER_MS } from './registry.js';

const run = promisify(execFile);
const CLAUDE = join(homedir(), '.claude');

const WEEK_MS = 7 * 86_400_000;
const SLOT_MS = 600_000;
const BURN_SLOTS = 6;
const WEEKLY_LIMIT = Number(process.env.PILL_WEEKLY_TOKEN_LIMIT) || 40_000_000;

// path -> tail state. Transcripts run to megabytes, so every poll after the
// first reads only the bytes appended since the last one.
const tails = new Map();
// sessionId -> { appPid, appName, tty }. Resolved once, at discovery: the spec
// wants the window handle cached then, not looked up on the click.
const targets = new Map();
let transcriptIndex = null;
let weekScan = null;

// Fed by pilld from the main process; read here on every poll.
export const registry = createRegistry();

export async function read() {
  const sessions = [];
  const listed = await discover();
  registry.prune(new Set(listed.map((e) => e.sessionId)), Date.now());
  for (const entry of listed) {
    registry.answered(entry.sessionId, entry.status, entry.statusAt);
    const path = await locate(entry.sessionId);
    const tail = path ? await follow(path) : null;
    sessions.push(describe(entry, tail));
  }
  sessions.sort((a, b) => a.startedAt - b.startedAt);
  sessions.forEach((s, i) => {
    s.index = i + 1;
  });

  // The week's totals need every transcript, not just the live ones. That is
  // ~80MB on first pass, so it runs in the background and the usage figures
  // fill in a second later rather than holding up the first paint.
  if (!weekScan) weekScan = scanWeek();

  return { headline: null, sessions, usage: usage(sessions) };
}

// What the raise needs to find one window among several: the app that owns it,
// and the tty that tells its tabs apart.
export function targetFor(sessionId) {
  return targets.get(sessionId) ?? null;
}

async function discover() {
  const dir = join(CLAUDE, 'sessions');
  const found = [];
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    const entry = await readFile(join(dir, name), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    if (!entry?.sessionId || entry.kind !== 'interactive') continue;
    const pid = Number(entry.pid);
    // The file outlives the process, so liveness is the pid, not the file.
    if (!alive(pid)) continue;
    found.push({
      sessionId: entry.sessionId,
      pid,
      cwd: entry.cwd ?? '',
      name: entry.name ?? '',
      startedAt: Number(entry.startedAt) || Date.now(),
      // Claude Code's own idle/busy/waiting. Used for one thing: noticing a
      // prompt was answered before the tool it allowed has finished.
      status: entry.status ?? null,
      statusAt: Number(entry.statusUpdatedAt) || 0,
    });
    if (!targets.has(entry.sessionId)) targets.set(entry.sessionId, await resolveTarget(pid));
  }
  return found;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Walk up the process tree to the first ancestor that is an app bundle: that is
// the app that owns the window. The tty comes from the session process itself,
// and is the only thing that distinguishes one of its windows or tabs from
// another.
async function resolveTarget(pid) {
  const tty = await run('ps', ['-o', 'tty=', '-p', String(pid)])
    .then(({ stdout }) => stdout.trim())
    .catch(() => '');

  let current = pid;
  for (let hop = 0; hop < 8; hop += 1) {
    const { stdout } = await run('ps', ['-o', 'ppid=,comm=', '-p', String(current)]).catch(() => ({
      stdout: '',
    }));
    const line = stdout.trim();
    if (!line) return null;
    const parent = Number(line.split(/\s+/)[0]);
    const command = line.slice(line.indexOf(String(parent)) + String(parent).length).trim();
    const bundle = /\/([^/]+)\.app\/Contents\/MacOS\//.exec(command);
    if (bundle) {
      return {
        appPid: current,
        appName: bundle[1],
        tty: tty && tty !== '??' ? `/dev/${tty}` : null,
      };
    }
    if (!Number.isFinite(parent) || parent <= 1) return null;
    current = parent;
  }
  return null;
}

// Transcripts live in a directory named after the cwd, but the slug rules are
// not mine to guess: find the file by session id instead.
async function locate(sessionId) {
  if (!transcriptIndex) transcriptIndex = await buildIndex();
  if (transcriptIndex.has(sessionId)) return transcriptIndex.get(sessionId);
  transcriptIndex = await buildIndex();
  return transcriptIndex.get(sessionId) ?? null;
}

async function buildIndex() {
  const root = join(CLAUDE, 'projects');
  const index = new Map();
  for (const project of await readdir(root).catch(() => [])) {
    for (const file of await readdir(join(root, project)).catch(() => [])) {
      if (file.endsWith('.jsonl')) index.set(file.slice(0, -6), join(root, project, file));
    }
  }
  return index;
}

async function scanWeek() {
  if (!transcriptIndex) transcriptIndex = await buildIndex();
  const cutoff = Date.now() - WEEK_MS;
  for (const path of transcriptIndex.values()) {
    const touched = await stat(path)
      .then((s) => s.mtimeMs)
      .catch(() => 0);
    if (touched >= cutoff) await follow(path);
  }
}

function emptyTail() {
  return {
    offset: 0,
    tokens: 0,
    byDay: new Map(),
    bySlot: new Map(),
    // `last` is the newest record of any kind and answers "when did anything
    // happen". `lastTurn` is the newest actual conversation turn and answers
    // "whose move is it" — transcripts also carry system, attachment and
    // summary records, which are bookkeeping and say nothing about either.
    last: null,
    lastTurn: null,
    lastAssistant: null,
    model: null,
  };
}

async function follow(path) {
  const size = await stat(path)
    .then((s) => s.size)
    .catch(() => null);
  if (size == null) return null;

  let state = tails.get(path);
  if (!state || size < state.offset) {
    state = emptyTail();
    tails.set(path, state);
  }
  if (size === state.offset) return state;

  const handle = await open(path, 'r');
  try {
    const length = size - state.offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, state.offset);
    const text = buffer.toString('utf8');
    // A poll can land mid-line; leave the partial line for the next read.
    const cut = text.lastIndexOf('\n');
    if (cut === -1) return state;
    for (const line of text.slice(0, cut).split('\n')) {
      if (line.trim()) absorb(state, line);
    }
    state.offset += Buffer.byteLength(text.slice(0, cut + 1), 'utf8');
  } finally {
    await handle.close();
  }
  return state;
}

function absorb(state, line) {
  const record = safeParse(line);
  if (!record) return;
  state.last = record;
  const role = record.message?.role;
  if (role === 'user' || role === 'assistant') state.lastTurn = record;
  if (role === 'assistant') state.lastAssistant = record;
  // The model is only on assistant records, so it has to be remembered: the
  // newest record is often a tool result, which carries none.
  if (record.message?.model) state.model = record.message.model;

  const tokens = tokensIn(record);
  if (tokens === 0) return;
  state.tokens += tokens;
  const at = record.timestamp ? Date.parse(record.timestamp) : Date.now();
  bump(state.byDay, dayKey(new Date(at)), tokens);
  bump(state.bySlot, Math.floor(at / SLOT_MS), tokens);
}

function bump(map, key, amount) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Cache reads are re-billed every turn, so summing them would report billions.
// Input, output and cache writes are the tokens a session actually added.
function tokensIn(record) {
  const u = record?.message?.usage;
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

function describe(entry, tail) {
  const last = tail?.last ?? null;
  const turn = tail?.lastTurn ?? null;
  const at = last?.timestamp ? Date.parse(last.timestamp) : entry.startedAt;
  const hooked = registry.get(entry.sessionId, Date.now());
  return {
    id: entry.sessionId,
    index: 0,
    pid: entry.pid,
    repo: entry.cwd,
    model: modelName(tail?.model ?? hooked?.model),
    state: hooked?.state ?? stateOf(turn, at),
    // permission, question or turn — what kind of "needs you" this is.
    needs: hooked ? hooked.needs : null,
    source: hooked ? 'hook' : 'transcript',
    summary: hookSummary(hooked) ?? summaryOf(turn, tail?.lastAssistant),
    etaSeconds: null,
    startedAt: entry.startedAt,
    tokens: tail?.tokens ?? 0,
  };
}

// A Stop hook that did not carry the reply leaves only "waiting for you"; the
// transcript has the reply itself by then.
function hookSummary(hooked) {
  if (!hooked) return null;
  if (hooked.needs === 'turn' && hooked.summary === 'waiting for you') return null;
  return hooked.summary;
}

// claude-opus-5 -> opus 5. Family plus version, lowercase, no vendor prefix.
export function modelName(id) {
  if (!id) return 'unknown';
  const parts = String(id).replace(/^claude-/, '').split('-');
  const family = parts.shift() ?? '';
  // Short numbers only: a date stamp like 20251001 is not a version.
  const version = parts.filter((p) => /^\d{1,2}$/.test(p)).join('.');
  return version ? `${family} ${version}` : family;
}

// A record's content is sometimes an array of parts and sometimes a bare
// string. Normalising here keeps every caller from having to care.
function contentOf(record) {
  const content = record?.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string' && content.trim()) return [{ type: 'text', text: content }];
  return [];
}

// A turn that has ended is the session's way of asking for you. A turn still
// open is work, unless nothing has moved for two minutes.
function stateOf(turn, at) {
  if (!turn) return 'idle';
  const parts = contentOf(turn);
  const open = parts.some((p) => p.type === 'tool_use') || turn.message?.role === 'user';
  if (!open) return 'waiting';
  if (Date.now() - at < STALL_AFTER_MS) return 'working';
  return failed(turn) ? 'errored' : 'stalled';
}

function failed(record) {
  if (record?.toolUseResult?.is_error) return true;
  return contentOf(record).some((p) => p.is_error);
}

// The spec wants a plain sentence. What is knowable is the tool in flight, so
// that is what this says rather than a prettier invention.
function summaryOf(turn, lastAssistant) {
  const last = turn;
  const ended = last && last.message?.role === 'assistant' && !contentOf(last).some((p) => p.type === 'tool_use');
  if (ended) {
    const text = contentOf(last).find((p) => p.type === 'text')?.text;
    if (text) return firstSentence(text);
  }
  if (ended) return 'waiting for you';
  const call = contentOf(lastAssistant).find((p) => p.type === 'tool_use');
  if (call) return phrase(call.name, call.input ?? {});
  if (last) return 'working';
  return 'idle';
}

function usage(sessions) {
  const today = dayKey(new Date());
  const weekStart = startOfWeek();
  const slotFloor = Math.floor((Date.now() - BURN_SLOTS * SLOT_MS) / SLOT_MS);

  let todayTokens = 0;
  let weeklyUsed = 0;
  let recent = 0;
  for (const tail of tails.values()) {
    for (const [day, amount] of tail.byDay) {
      if (day === today) todayTokens += amount;
      if (Date.parse(`${day}T00:00:00`) >= weekStart) weeklyUsed += amount;
    }
    for (const [slot, amount] of tail.bySlot) {
      if (slot >= slotFloor) recent += amount;
    }
  }

  const longest = sessions.reduce((a, b) => (!a || b.startedAt < a.startedAt ? b : a), null);
  return {
    weeklyUsed,
    weeklyLimit: WEEKLY_LIMIT,
    sessionTokens: longest?.tokens ?? 0,
    todayTokens,
    // A real trailing hour, from the ten-minute buckets.
    burnRatePerHour: recent,
    resetsAt: weekStart + WEEK_MS,
  };
}

function dayKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, '0')}`;
}

function startOfWeek() {
  const at = new Date();
  at.setHours(0, 0, 0, 0);
  at.setDate(at.getDate() - ((at.getDay() + 6) % 7));
  return at.getTime();
}
