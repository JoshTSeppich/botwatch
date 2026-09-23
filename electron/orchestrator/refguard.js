// The barrier that does not depend on reading the command.
//
// A worktree is not containment: it shares refs with the repo it came from, so
// a worker can move refs/heads/main from inside its own tree, and the
// orchestrator is not in a worktree at all. Denying `git merge` by pattern
// stops the obvious spelling and nothing else.
//
// git's reference-transaction hook fires on every ref update whatever produced
// it — merge, reset, branch -f, update-ref, a push, or a command spelled so the
// regex misses it. Protected refs can only move while a one-time token issued
// by the user's Merge click is present.

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const HOOK = `#!/bin/sh
# Installed by BotWatch. Rejects moves of protected branches from sessions it
# spawned. Your own git is untouched: the check only applies when BOTWATCH_GUARD
# is set, which BotWatch puts in the worker and orchestrator environment.
input=$(cat)
common=\${GIT_COMMON_DIR:-\${GIT_DIR:-.git}}
chained="$common/hooks/reference-transaction.botwatch-chained"

if [ -x "$chained" ]; then
  printf '%s\\n' "$input" | "$chained" "$@" || exit $?
fi

[ "$1" = "prepared" ] || exit 0
[ -n "$BOTWATCH_GUARD" ] || exit 0

blocked=0
while read -r old new ref; do
  [ -n "$ref" ] || continue
  case "$ref" in
    refs/heads/bw/*) ;;
    refs/heads/*)
      if [ ! -f "$common/botwatch-merge-token" ]; then
        echo "BotWatch: refusing to move $ref from an agent session." >&2
        echo "Branches reach $ref by the user clicking Merge, not from a session." >&2
        blocked=1
      fi
      ;;
  esac
done <<INPUT
$input
INPUT

exit $blocked
`;

async function commonDir(repo) {
  const { stdout } = await run('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  return stdout.trim();
}

export async function install(repo) {
  const common = await commonDir(repo);
  const hooks = join(common, 'hooks');
  await mkdir(hooks, { recursive: true });
  const path = join(hooks, 'reference-transaction');

  // Somebody else's hook is chained, not replaced.
  const existing = await readFile(path, 'utf8').catch(() => null);
  if (existing && !existing.includes('Installed by BotWatch')) {
    await rename(path, `${path}.botwatch-chained`);
    await chmod(`${path}.botwatch-chained`, 0o755).catch(() => {});
  }

  await writeFile(path, HOOK, 'utf8');
  await chmod(path, 0o755);
  return path;
}

export async function uninstall(repo) {
  const common = await commonDir(repo);
  const path = join(common, 'hooks', 'reference-transaction');
  const chained = `${path}.botwatch-chained`;
  await rm(path, { force: true });
  await rename(chained, path).catch(() => {});
}

// Issued on the user's click and consumed by the merge. A file rather than an
// env var because the hook runs in git's environment, not ours.
export async function issueToken(repo) {
  const common = await commonDir(repo);
  const token = join(common, 'botwatch-merge-token');
  await writeFile(token, `${Date.now()}\n`, 'utf8');
  return token;
}

export async function consumeToken(repo) {
  const common = await commonDir(repo);
  await rm(join(common, 'botwatch-merge-token'), { force: true });
}

// The environment every spawned session gets: marks it as an agent session for
// the hook, and takes away the ability to push at all.
export function guardedEnv(base = process.env) {
  return {
    ...base,
    BOTWATCH_GUARD: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'remote.origin.pushurl',
    GIT_CONFIG_VALUE_0: '/dev/null/botwatch-push-disabled',
  };
}
