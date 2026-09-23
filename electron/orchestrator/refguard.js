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
import { homedir } from 'node:os';
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
marker="$common/botwatch-abort-cleanup"
token="$HOME/.claude/botwatch/merge-token"

if [ -x "$chained" ]; then
  printf '%s\\n' "$input" | "$chained" "$@" || exit $?
fi

# A rejected fast-forward has already written the index and working tree by the
# time the ref move is refused, which leaves the worker's files staged on the
# user's branch. Undo exactly that, once the transaction is over.
if [ "$1" = "aborted" ]; then
  if [ -f "$marker" ]; then
    rm -f "$marker"
    git read-tree --reset -u HEAD 2>/dev/null
  fi
  exit 0
fi

[ "$1" = "prepared" ] || exit 0
[ -n "$BOTWATCH_GUARD" ] || exit 0

now=$(date +%s)
blocked=0
while read -r old new ref; do
  [ -n "$ref" ] || continue
  case "$ref" in
    refs/heads/bw/*) ;;
    refs/heads/*)
      if awk -v r="$ref" -v s="$new" -v n="$now" \
        '$1==r && ($2==s || $2=="*") && $3>n { ok=1 } END { exit !ok }' "$token" 2>/dev/null; then
        continue
      fi
      echo "BotWatch: refusing to move $ref from an agent session." >&2
      echo "Branches reach $ref by the user clicking Merge, not from a session." >&2
      blocked=1
      ;;
  esac
done <<INPUT
$input
INPUT

[ "$blocked" -eq 1 ] && : > "$marker"
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

// The token lives outside the repo. Inside it, an agent finds it by listing
// .git and forges it with one echo — and the refusal message tells it what to
// look for. Outside is not out of reach (a shell runs as the same user), but it
// is no longer discoverable from the tree the agent is working in.
export function tokenPath() {
  return join(homedir(), '.claude', 'botwatch', 'merge-token');
}

// Bound to one ref and one target commit, with a short life. A token issued to
// fast-forward main to abc123 will not move main anywhere else, and will not
// move any other branch. `sha` may be '*' for a true merge, whose commit does
// not exist until git makes it — a wider grant, and the reason the window is
// measured in seconds.
export async function issueToken(repo, { ref, sha = '*', ttlMs = 60_000 } = {}) {
  if (!ref) throw new Error('a merge token must name the ref it is for');
  const path = tokenPath();
  await mkdir(join(homedir(), '.claude', 'botwatch'), { recursive: true });
  const expiry = Math.floor((Date.now() + ttlMs) / 1000);
  await writeFile(path, `${ref} ${sha} ${expiry}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

export async function consumeToken() {
  await rm(tokenPath(), { force: true });
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
