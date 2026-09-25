// What the user is being asked to accept when they click Merge.
//
// A snapshot commits everything a worker left in its worktree, which is not
// only the work: build output, a .env it wrote while experimenting, a
// node_modules that .gitignore does not cover. All of it reaches the user's
// branch on Merge. So the review separates new files from edits — a new file
// is the thing nobody asked for — and flags what looks like it should not be
// committed at all.

import { execFile as execFileCb } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const LARGE_BYTES = 1_000_000;

// Name-based first, because the cheapest signal is usually right.
const SUSPECT = [
  [/(^|\/)\.env(\.|$)/i, 'environment file'],
  [/(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.|$)/i, 'private key'],
  [/\.(pem|key|p12|pfx|keystore|jks)$/i, 'key material'],
  [/(^|\/)(credentials|secrets?|\.netrc|\.npmrc|\.pypirc)(\.|$)/i, 'credential file'],
  [/(^|\/)(node_modules|vendor|\.venv|venv)\//i, 'dependency directory'],
  [/(^|\/)(dist|build|out|target|coverage|\.next|\.turbo)\//i, 'build output'],
  [/(^|\/)\.DS_Store$/i, 'macOS noise'],
  [/\.(log|tmp|swp)$/i, 'scratch file'],
];

// A short content sniff for the shapes that are obviously a secret even in a
// file with an innocent name.
const SECRET_CONTENT = [
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, 'API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
];

// Where the branch left its base. Diffing against the base's tip instead
// shows, as this worker "undoing" them, every change merged to the base since
// — the first merge of a run made every other worker's review wrong.
export async function forkPoint(worktreePath, base = 'main', head = 'HEAD') {
  return execFile('git', ['-C', worktreePath, 'merge-base', base, head])
    .then(({ stdout }) => stdout.trim())
    .catch(() => base);
}

export async function review(worktreePath, base = 'main') {
  // Against the fork point, not the last commit: once pilld snapshots a
  // worker, its new files are committed, and `ls-files --others` alone would
  // file every one of them under edits. The status letter is what says new.
  const from = await forkPoint(worktreePath, base);
  const counts = await numstat(worktreePath, from);
  const status = await nameStatus(worktreePath, from);
  const edits = [];
  const added = [];
  for (const [file, letter] of status) {
    const entry = { file, ...(counts.get(file) ?? { added: 0, removed: 0 }) };
    if (letter === 'A') added.push(entry);
    else edits.push({ ...entry, deleted: letter === 'D' });
  }
  // Still-uncommitted new files: a worker that is mid-turn, or a review taken
  // before the snapshot.
  const untracked = await execFile('git', ['-C', worktreePath, 'ls-files', '--others', '--exclude-standard'])
    .then(({ stdout }) => stdout.trim().split('\n').filter(Boolean))
    .catch(() => []);
  for (const file of untracked) {
    if (!status.has(file)) added.push({ file, added: await countLines(worktreePath, file), removed: 0 });
  }

  const flagged = [];
  for (const entry of [...edits, ...added]) {
    if (entry.deleted) continue;
    const reason = await suspect(worktreePath, entry.file);
    if (reason) flagged.push({ file: entry.file, reason });
  }

  return { edits, added, flagged, safe: flagged.length === 0 };
}

async function numstat(worktreePath, base) {
  const { stdout } = await execFile('git', ['-C', worktreePath, 'diff', '--numstat', '--no-renames', base]).catch(
    () => ({ stdout: '' }),
  );
  const out = new Map();
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const [a, r, file] = line.split('\t');
    out.set(file, { added: Number(a) || 0, removed: Number(r) || 0 });
  }
  return out;
}

async function nameStatus(worktreePath, base) {
  const { stdout } = await execFile('git', ['-C', worktreePath, 'diff', '--name-status', '--no-renames', base]).catch(
    () => ({ stdout: '' }),
  );
  const out = new Map();
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const [letter, file] = line.split('\t');
    out.set(file, letter[0]);
  }
  return out;
}

async function countLines(worktreePath, file) {
  // awk, not `wc -l`: a file written without a trailing newline is not zero
  // lines, and a worker writes those constantly.
  const { stdout } = await execFile('awk', ['END{print NR}', `${worktreePath}/${file}`]).catch(() => ({
    stdout: '0',
  }));
  return Number(stdout.trim()) || 0;
}

export function suspectByName(file) {
  for (const [pattern, reason] of SUSPECT) if (pattern.test(file)) return reason;
  return null;
}

export function suspectByContent(text) {
  for (const [pattern, reason] of SECRET_CONTENT) if (pattern.test(text)) return reason;
  return null;
}

async function suspect(worktreePath, file) {
  const byName = suspectByName(file);
  if (byName) return byName;

  const path = `${worktreePath}/${file}`;
  const size = await stat(path).then((s) => s.size).catch(() => 0);
  if (size > LARGE_BYTES) return `large file (${Math.round(size / 1000)}kB)`;

  const head = await execFile('head', ['-c', '8000', path]).then(({ stdout }) => stdout).catch(() => '');
  return suspectByContent(head);
}
