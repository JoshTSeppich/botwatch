// Which process a pid is. A pid alone is not an identity: macOS reuses them,
// so "the process that wrote this record" is the pid plus its start time.

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// `ps -o lstart` in UTC with the C locale, e.g. "Thu Sep 24 13:42:48 2026" —
// the same form Claude Code writes as procStart in its session files.
export async function processStart(pid) {
  if (!pid) return null;
  const { stdout } = await execFile('ps', ['-o', 'lstart=', '-p', String(pid)], {
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  }).catch(() => ({ stdout: '' }));
  return normalise(stdout) || null;
}

export function normalise(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

export function sameStart(a, b) {
  return Boolean(a) && Boolean(b) && normalise(a) === normalise(b);
}
