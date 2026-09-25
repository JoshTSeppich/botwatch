// What survives BotWatch dying mid-run, and what it cleans up next time.
//
// A clean quit closes the run: workers stopped, ref hook removed. A kill -9, a
// crash or a power cut does none of that. So every run keeps a record on disk
// (runs/<id>/run.json), and on the next launch recover() reads the records of
// runs whose BotWatch is gone and:
//
//   - stops worker processes still running from that run (checked to be
//     `claude`, so a reused pid is never killed)
//   - takes BotWatch's ref hook back out of the repo (only BotWatch's — a hook
//     that isn't ours is left alone)
//   - prunes git's records of BotWatch worktrees whose directory is gone
//   - keeps every branch and worktree: they are the work
//
// and marks the record recovered, so it's done once.

import { execFile as execFileCb } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { processStart, sameStart } from './proc.js';
import * as refguard from './refguard.js';

const execFile = promisify(execFileCb);

export const RUNS_DIR = join(homedir(), '.claude', 'botwatch', 'runs');

export function runRecord(run, { owner = process.pid, closed = false, orchestrator = null } = {}) {
  const sessions = orchestrator ? [orchestrator, ...run.workers] : run.workers;
  return {
    id: run.id,
    repo: run.repo,
    owner,
    startedAt: run.startedAt ?? null,
    closed,
    workers: sessions.map((w) => ({
      id: w.id,
      branch: w.branch,
      cwd: w.cwd,
      pid: w.child?.pid ?? null,
      state: w.state,
    })),
  };
}

// pid -> start time, for this process's own children and itself. Looked up
// once: a process's start time never changes, and a record is written often.
const starts = new Map();
async function startOf(pid) {
  if (!pid) return null;
  if (!starts.has(pid)) starts.set(pid, await processStart(pid));
  return starts.get(pid);
}

// The record carries each pid's start time, so a later recovery can tell the
// process it recorded from a stranger that was given the same pid.
export async function writeRecord(dir, record, { lookup = startOf } = {}) {
  const withStarts = {
    ...record,
    ownerStart: record.ownerStart ?? (await lookup(record.owner)),
    workers: await Promise.all(
      (record.workers ?? []).map(async (w) => ({ ...w, start: w.start ?? (await lookup(w.pid)) })),
    ),
  };
  await writeFile(join(dir, 'run.json'), JSON.stringify(withStarts, null, 2), { mode: 0o600 });
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isClaude(pid) {
  const { stdout } = await execFile('ps', ['-o', 'command=', '-p', String(pid)]).catch(() => ({ stdout: '' }));
  return /^(\S*\/)?claude(\s|$)/.test(stdout.trim());
}

// The only processes recovery signals: alive, still claude, and started at the
// moment the record says. A pid that is claude but started at another time is
// somebody else's session — possibly the user's own — and is left alone. So is
// one with no recorded start: not knowing is a reason not to kill.
export async function isOurs(pid, recordedStart, { isAliveFn = alive, claude = isClaude, lookup = processStart } = {}) {
  if (!pid || !recordedStart || !isAliveFn(pid)) return false;
  if (!sameStart(await lookup(pid), recordedStart)) return false;
  return claude(pid);
}

// Worktrees git lists as prunable (directory gone) are pruned only when every
// one of them is BotWatch's: `git worktree prune` has no per-path form, and
// the user's own worktree on an unplugged drive must not go with ours.
async function pruneOurs(repo) {
  const { stdout } = await execFile('git', ['-C', repo, 'worktree', 'list', '--porcelain']).catch(() => ({ stdout: '' }));
  const prunable = [];
  let path = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    if (line.startsWith('prunable') && path) prunable.push(path);
  }
  if (!prunable.length) return [];
  if (!prunable.every((p) => p.includes('/.botwatch-worktrees/'))) return [];
  await execFile('git', ['-C', repo, 'worktree', 'prune']);
  return prunable;
}

export async function recover({ runsDir = RUNS_DIR, self = process.pid, isAlive = alive, claude = isClaude, lookup = processStart } = {}) {
  const reports = [];
  for (const id of await readdir(runsDir).catch(() => [])) {
    const dir = join(runsDir, id);
    const record = await readFile(join(dir, 'run.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    if (!record || record.closed || record.recoveredAt) continue;
    if (record.owner === self) continue;
    // The owner counts as alive only if it is the same process: its pid may
    // belong to something else by now. Without a recorded start, a live pid is
    // given the benefit of the doubt, and the run is left for later.
    if (isAlive(record.owner)) {
      if (!record.ownerStart) continue;
      if (sameStart(await lookup(record.owner), record.ownerStart)) continue;
    }

    const stopped = [];
    const spared = [];
    for (const w of record.workers ?? []) {
      if (!w.pid || !isAlive(w.pid)) continue;
      if (!(await isOurs(w.pid, w.start, { isAliveFn: isAlive, claude, lookup }))) {
        spared.push(w.id);
        continue;
      }
      try {
        process.kill(w.pid, 'SIGTERM');
        stopped.push(w.id);
      } catch {
        // Gone between the check and the kill: nothing to stop.
      }
    }
    const hookRemoved = await refguard.uninstall(record.repo).catch(() => false);
    const pruned = await pruneOurs(record.repo).catch(() => []);
    const kept = (record.workers ?? []).map((w) => w.branch).filter(Boolean); // the orchestrator has none

    const report = { id: record.id, repo: record.repo, stopped, spared, hookRemoved, pruned, kept };
    await writeRecord(dir, { ...record, recoveredAt: Date.now(), recovery: report });
    reports.push(report);
  }
  return reports;
}
