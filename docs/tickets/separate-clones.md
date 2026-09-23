# Ticket: separate clones instead of shared worktrees

**Status:** not built. Written down so the decision gets made deliberately rather than mid-build.

## The problem

A git worktree is not a containment boundary. Worktrees share `.git` with the repo they came from,
so a worker can move `refs/heads/main` from inside its own tree. The orchestrator session isn't in
a worktree at all — it runs in the repo.

Three layers stand in the way today, and all three live where the agent can reach them:

| Layer | Beaten by |
| --- | --- |
| PreToolUse pattern deny | `g=merge; git $g main` |
| `reference-transaction` hook | `rm .git/hooks/reference-transaction`, or `BOTWATCH_GUARD= git merge` |
| Merge token outside the repo, bound to ref + SHA | forging it — the agent runs as the user |
| No push target in the environment | `git -c remote.origin.pushurl=… push` |

Each is a speed bump for a model doing its job, not a barrier against one that goes looking.

## The change

Give each worker a **separate clone**. `git clone --shared` is not enough: it shares the object
store and still leaves a path to the origin. A full clone with the origin removed, or one whose
origin is a bare mirror BotWatch owns.

Merging becomes: on the user's click, BotWatch **fetches** from the worker's clone into the user's
repo and merges there. The worker never holds a reference that can reach the user's branches, so
none of the three layers above has to hold.

## The cost

- **Deviates from the handoff**, which specifies worktrees and branch `bw/<task>` explicitly.
- Disk: a clone per worker. On a large repo with six workers that is real.
- Slower to start a worker — a clone is not a worktree.
- `worker_diff` changes: no shared object store, so the diff is computed in the worker's clone.
- The base branch can move under a worker, same as today, but reconciling it is a fetch rather
  than a shared ref.

## Recommendation

Do it before anyone runs this on a repo they care about. Don't do it silently: it is a product
decision against a written spec, and the honest interim is what the README says now — the layers,
and what beats each one.
