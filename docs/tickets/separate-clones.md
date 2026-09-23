# Ticket: separate clones instead of shared worktrees

**Status:** not built. Written down so the decision is made deliberately rather than mid-build.

## The problem

A git worktree is not a containment boundary. Worktrees share `.git` with the repo they came
from, so a worker can move `refs/heads/main` from inside its own tree. The orchestrator session
isn't in a worktree at all — it runs in the repo.

Today three layers stand in the way, and all three live inside the repo the agent can reach:

| Layer | Beaten by |
| --- | --- |
| PreToolUse pattern deny | `g=merge; git $g main` |
| `reference-transaction` hook | `rm .git/hooks/reference-transaction`, or `BOTWATCH_GUARD= git merge` |
| No push target in the environment | `git -c remote.origin.pushurl=... push` |

Each is a speed bump for a model doing its job, not a barrier against one that goes looking.

## The change

Give each worker a **separate clone** (`git clone --shared` is *not* enough — it shares the object
store and, more to the point, an agent can still reach the origin path). A full clone with the
origin removed, or a clone whose origin is a bare mirror BotWatch owns.

Merging becomes: on the user's click, BotWatch **fetches** from the worker's clone into the user's
repo and merges there. The worker never has a path back.

## The cost

- **Deviates from the handoff**, which specifies worktrees and branch `bw/<task>` explicitly.
- Disk: a clone per worker instead of a worktree. On a large repo with six workers that is real.
- Slower to start a worker — a clone is not a worktree.
- `worker_diff` changes: no shared object store, so the diff comes from the worker's clone.

## Recommendation

Worth doing before anyone runs this on a repo they care about, and worth *not* doing silently:
it's a product decision against a written spec. The honest interim is what's in the README now —
the layers, and what beats them.
