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

export async function review(worktreePath, base = 'main') {
  const edits = await changed(worktreePath, ['diff', '--numstat', base]);
  const added = [];
  const untracked = await execFile('git', ['-C', worktreePath, 'ls-files', '--others', '--exclude-standard'])
    .then(({ stdout }) => stdout.trim().split('\n').filter(Boolean))
    .catch(() => []);

  for (const file of untracked) {
    added.push({ file, added: await countLines(worktreePath, file), removed: 0 });
  }

  const flagged = [];
  for (const entry of [...edits, ...added]) {
    const reason = await suspect(worktreePath, entry.file);
    if (reason) flagged.push({ file: entry.file, reason });
  }

  return { edits, added, flagged, safe: flagged.length === 0 };
}

async function changed(worktreePath, args) {
  const { stdout } = await execFile('git', ['-C', worktreePath, ...args]).catch(() => ({ stdout: '' }));
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [a, r, file] = line.split('\t');
      return { file, added: Number(a) || 0, removed: Number(r) || 0 };
    });
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
