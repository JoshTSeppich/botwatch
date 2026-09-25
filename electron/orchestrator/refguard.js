// The barrier that does not depend on reading the command.
//
// A worktree is not containment: it shares refs with the repo it came from, so
// a worker can move refs/heads/main from inside its own tree, and the
// orchestrator is not in a worktree at all. Denying `git merge` by pattern
// stops the obvious spelling and nothing else.
//
// git's reference-transaction hook fires on every ref update whatever produced
// it — merge, reset, branch -f, update-ref, a push, or a command spelled so the
// regex misses it. Protected refs cannot move from a spawned session at all:
// BotWatch performs the merge itself when the user clicks Merge, from outside
// the guarded environment, so no session ever needs permission and there is no
// permission file to forge.

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const HOOK = `#!/bin/sh
# Installed by BotWatch. Refuses to let a session it spawned move any protected
# branch, with no exception: BotWatch performs the merge itself, from outside
# this environment, when the user clicks Merge. Your own git is untouched —
# the check only applies when BOTWATCH_GUARD is set.
input=$(cat)
common=\${GIT_COMMON_DIR:-\${GIT_DIR:-.git}}
chained="$common/hooks/reference-transaction.botwatch-chained"
marker="$common/botwatch-abort-cleanup"

if [ -x "$chained" ]; then
  printf '%s\\n' "$input" | "$chained" "$@" || exit $?
fi

# A rejected fast-forward has already written the index and working tree by the
# time the ref move is refused, leaving the worker's files staged on the user's
# branch. Undo exactly the paths that merge wrote — never the whole index, which
# would throw away whatever else the user had in progress.
if [ "$1" = "aborted" ]; then
  if [ -f "$marker" ]; then
    while read -r old new; do
      [ -n "$new" ] || continue
      # Both ends must be real commits. A single-ended diff compares the
      # WORKING TREE against a commit, which lists every file the user has in
      # progress — and "restoring" those is how this cleanup destroyed staged
      # and unstaged work the first time.
      git rev-parse --verify --quiet "$old^{commit}" >/dev/null 2>&1 || continue
      git rev-parse --verify --quiet "$new^{commit}" >/dev/null 2>&1 || continue
      git diff --name-only "$old" "$new" 2>/dev/null | while IFS= read -r path; do
        [ -n "$path" ] || continue
        if git cat-file -e "HEAD:$path" 2>/dev/null; then
          git checkout -q HEAD -- "$path" 2>/dev/null
        else
          git reset -q HEAD -- "$path" 2>/dev/null
          rm -f "$path"
        fi
      done
    done < "$marker"
    rm -f "$marker"
  fi
  exit 0
fi

[ "$1" = "prepared" ] || exit 0
[ -n "$BOTWATCH_GUARD" ] || exit 0

blocked=0
: > "$marker.tmp"
while read -r old new ref; do
  [ -n "$ref" ] || continue
  case "$ref" in
    refs/heads/bw/*) ;;
    refs/heads/*)
      echo "BotWatch: refusing to move $ref from an agent session." >&2
      echo "Branches move when the user clicks Merge, and BotWatch performs it." >&2
      # Only a transaction that wrote the tree needs undoing. update-ref and
      # friends move a ref and nothing else, so there is nothing to restore and
      # every reason not to touch the user's files.
      if [ "$(git rev-parse --verify --quiet HEAD 2>/dev/null)" = "$old" ] && [ "$ref" = "$(git symbolic-ref -q HEAD 2>/dev/null)" ]; then
        printf '%s %s\\n' "$old" "$new" >> "$marker.tmp"
      fi
      blocked=1
      ;;
  esac
done <<INPUT
$input
INPUT

if [ "$blocked" -eq 1 ]; then mv "$marker.tmp" "$marker"; else rm -f "$marker.tmp"; fi
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

// Only ever removes BotWatch's own hook. Recovery calls this on repos whose
// state it doesn't know, and a hook that isn't ours is the user's.
export async function uninstall(repo) {
  const common = await commonDir(repo);
  const path = join(common, 'hooks', 'reference-transaction');
  const chained = `${path}.botwatch-chained`;
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current == null || !current.includes('Installed by BotWatch')) return false;
  await rm(path, { force: true });
  await rename(chained, path).catch(() => {});
  return true;
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
