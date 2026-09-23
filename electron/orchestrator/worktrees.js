// Git worktrees for workers. The brief requires them for two or more workers:
// without one, parallel workers edit the same files and the run is nonsense.
//
// Every worker gets its own branch under bw/, and nothing here ever touches the
// user's checked-out branch.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);

export function branchName(task) {
  const slug = String(task)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `bw/${slug || 'task'}`;
}

// Worktrees live beside the repo, not inside it: a worktree under the repo root
// shows up in the user's own status and file watchers.
export function worktreePath(repo, branch) {
  return join(repo, '..', `.botwatch-worktrees`, branch.replace(/\//g, '-'));
}

// Worker ids restart at w1 on every run, so a second run over the same repo
// asks for branches the first run already made. Suffix rather than fail: the
// alternative is an orchestrator that works once per repo.
export async function branchExists(repo, branch) {
  return run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    .then(() => true)
    .catch(() => false);
}

export async function uniqueBranch(repo, task, exists = branchExists) {
  const base = branchName(task);
  if (!(await exists(repo, base))) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if (!(await exists(repo, candidate))) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

// The branch the worktree forks from, captured at creation. Hardcoding `main`
// meant every diff on a `master` repo came back silently empty.
export async function currentBranch(repo) {
  const { stdout } = await run('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']).catch(
    () => ({ stdout: 'main' }),
  );
  return stdout.trim() || 'main';
}

export async function create(repo, task) {
  const branch = await uniqueBranch(repo, task);
  const path = worktreePath(repo, branch);
  const base = await currentBranch(repo);
  await run('git', ['-C', repo, 'worktree', 'add', '-b', branch, path], { timeout: 30_000 });
  return { branch, path, base };
}

export async function remove(repo, path) {
  // --force because a worker may have left the tree dirty; the branch survives
  // either way, so nothing a worker did is lost by removing the checkout.
  await run('git', ['-C', repo, 'worktree', 'remove', '--force', path]).catch(() => {});
}

export async function list(repo) {
  const { stdout } = await run('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
  const trees = [];
  let current = {};
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = { path: line.slice(9) };
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === '' && current.path) {
      trees.push(current);
      current = {};
    }
  }
  if (current.path) trees.push(current);
  return trees;
}

// What a worker actually changed, for the review-and-merge screen.
//
// Read inside the worktree, not the main repo, and against the base branch
// rather than a committed tip: a worker edits files and often never commits, so
// a committed-only diff shows nothing for a worker that did a full day's work.
// Untracked files are counted too, for the same reason.
export async function diff(worktreePath, base = 'main') {
  const tracked = await run('git', ['-C', worktreePath, 'diff', '--numstat', base]).catch(() => ({
    stdout: '',
  }));

  let added = 0;
  let removed = 0;
  const files = [];
  for (const line of tracked.stdout.trim().split('\n').filter(Boolean)) {
    const [a, r, file] = line.split('\t');
    added += Number(a) || 0;
    removed += Number(r) || 0;
    files.push(file);
  }

  const untracked = await run('git', [
    '-C',
    worktreePath,
    'ls-files',
    '--others',
    '--exclude-standard',
  ]).catch(() => ({ stdout: '' }));

  for (const file of untracked.stdout.trim().split('\n').filter(Boolean)) {
    // awk, not `wc -l`: wc counts newlines, so a file written without a
    // trailing one reports zero lines and a real change looks like nothing.
    const counted = await run('awk', ['END{print NR}', `${worktreePath}/${file}`]).catch(() => ({
      stdout: '0',
    }));
    added += Number(counted.stdout.trim()) || 0;
    files.push(file);
  }

  return { added, removed, files };
}
