// Runs the repo's tests against a worker's snapshot, for the review panel.
//
// The test code is code a worker may have written, and pilld runs outside the
// sandbox the workers are held in. Running it bare would hand a worker
// everything the sandbox took away. So it runs under a Seatbelt profile of its
// own: no network beyond loopback, and writes only inside the worktree and the
// temp directories. Reads are not narrowed — tests read the toolchain — and
// with no network and no writes outside the worktree, anything read has no way
// out except into the worktree, where the review sees it.

import { execFile as execFileCb, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const TIMEOUT_MS = 5 * 60_000;
const TAIL_LINES = 30;

// What a user would type. Only the obvious ones: a wrong guess runs the wrong
// thing, and the setup panel lets the user say otherwise.
export async function detectTestCommand(repo) {
  const pkg = await readFile(join(repo, 'package.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  const script = pkg?.scripts?.test;
  if (script && !/no test specified/.test(script)) return 'npm test';
  if (existsSync(join(repo, 'Cargo.toml'))) return 'cargo test';
  const makefile = await readFile(join(repo, 'Makefile'), 'utf8').catch(() => '');
  if (/^test\s*:/m.test(makefile)) return 'make test';
  return null;
}

// Seatbelt matches real paths, and on macOS /tmp and /var are symlinks.
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function sandboxProfile(worktree) {
  const quote = (p) => JSON.stringify(real(p));
  return [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound)',
    '(allow network-outbound (remote ip "localhost:*") (remote unix-socket))',
    '(deny file-write*)',
    `(allow file-write* (subpath ${quote(worktree)}) (subpath ${quote(tmpdir())}) (subpath "/private/tmp")`,
    '  (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/"))',
  ].join('\n');
}

// Resolves with the result, never rejects: a failing test run is a result.
export async function runTests(worktree, command, { timeoutMs = TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  const sha = await execFile('git', ['-C', worktree, 'rev-parse', 'HEAD'])
    .then(({ stdout }) => stdout.trim())
    .catch(() => null);
  if (!command) return { command: null, sha, startedAt, finishedAt: startedAt, exitCode: null, passed: null, tail: '' };

  const sandboxed = process.platform === 'darwin';
  const [bin, args] = sandboxed
    ? ['sandbox-exec', ['-p', sandboxProfile(worktree), 'sh', '-c', command]]
    : ['sh', ['-c', command]];

  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: worktree, env: { ...process.env, CI: '1' } });
    let output = '';
    const keep = (chunk) => {
      output = (output + chunk).slice(-64_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        command,
        sha,
        sandboxed,
        startedAt,
        finishedAt: Date.now(),
        exitCode: timedOut ? null : code,
        passed: !timedOut && code === 0,
        timedOut,
        tail: output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n'),
      });
    });
  });
}
