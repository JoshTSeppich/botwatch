// The rules pilld enforces on the orchestrator, whatever the model asks for.
//
// This module exists because an orchestrator is a language model holding the
// controls. Everything here is a limit it cannot talk its way past: it is
// enforced on this side of the MCP boundary, not described to the model and
// hoped for. Every function is pure so the rules can be tested without spawning
// anything.

// Ordered least to most powerful. A worker may never be given a mode above the
// ceiling the user themselves is running under.
const PERMISSION_RANK = ['plan', 'default', 'acceptEdits', 'bypassPermissions'];

export function clampPermission(requested, ceiling) {
  const wanted = PERMISSION_RANK.indexOf(requested);
  const limit = PERMISSION_RANK.indexOf(ceiling);
  if (limit === -1) return 'plan';
  if (wanted === -1) return ceiling;
  return PERMISSION_RANK[Math.min(wanted, limit)];
}

// Commands no "Always allow" is ever offered for, from the brief, plus the
// user's own additions. Matching is deliberately loose: a near-miss that asks
// the human is cheap, a miss that does not is not.
const PROTECTED = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bgit\s+push\b[^|;]*--force/i,
  /\bgit\s+push\b[^|;]*\s-f\b/i,
  /\bsudo\b/i,
  /\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b/i,
  /\bDROP\s+TABLE\b/i,
];

export function isProtected(command, extraPatterns = []) {
  const text = String(command ?? '');
  return [...PROTECTED, ...extraPatterns].some((p) => p.test(text));
}

// Workers never push. The brief allows merging into the orchestrator's own
// worktrees on an explicit click, but nothing leaves the machine.
export function isPush(command) {
  return /\bgit\s+push\b/i.test(String(command ?? ''));
}

// Refusing the merge_worktrees tool is not enforcement while the shell is open.
// Asked to get a branch onto main "by any means", a model reaches straight for
// `git merge`, and it works. These are the commands that move commits between
// branches or rewrite them, and a PreToolUse hook denies every one.
const REPO_WRITES = [
  /\bgit\s+merge\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+rebase\b/i,
  /\bgit\s+reset\b/i,
  /\bgit\s+cherry-pick\b/i,
  /\bgit\s+branch\b[^|;]*\s-[a-zA-Z]*[fFdDmM]/,
  /\bgit\s+update-ref\b/i,
];

// A subagent that would run somewhere else. "remote" launches it in a cloud
// environment (Claude Code's own Agent schema says so, measured on 2.1.282):
// a session with none of this sandbox, none of these hooks and no budget.
// "worktree" puts it in a git worktree of its own, outside the one the
// worker was given. Plain subagents stay in the worker's session and sandbox.
export function refusedIsolation(toolInput) {
  const isolation = toolInput?.isolation;
  return isolation === 'remote' || isolation === 'worktree' ? isolation : null;
}

export function isRepoWrite(command) {
  const text = String(command ?? '');
  return REPO_WRITES.some((p) => p.test(text));
}

export function canSpawn(state, limits) {
  if (state.stopped) return { ok: false, reason: 'orchestrator stopped' };
  if (state.budgetExhausted) return { ok: false, reason: 'token budget reached' };
  // Paused: a new worker waits in the queue for Resume, it doesn't start.
  if (state.paused) return { ok: false, reason: 'paused by the user', queue: true };
  const running = state.workers.filter((w) => w.state === 'running').length;
  if (running >= limits.maxWorkers) {
    return { ok: false, reason: `worker limit reached (${limits.maxWorkers})`, queue: true };
  }
  return { ok: true };
}

// A merge is the one action that touches the user's branch, so it needs a
// click. The model can ask; only the click decides.
export function canMerge(state) {
  if (!state.userApprovedMerge) return { ok: false, reason: 'merge needs the user to click Merge' };
  return { ok: true };
}

// Whether one worker's branch may merge. Per branch, not per run: a finished
// worker's work can land while others are still going. Finished, snapshotted,
// tested, not merged already, and still at the commit the user reviewed.
export function canMergeBranch(worker, { reviewedSha, tipSha, merged = false, worktreeChanged = false }) {
  if (!worker) return { ok: false, reason: 'not a worker of this run' };
  if (merged) return { ok: false, reason: `${worker.branch} is already merged` };
  if (worker.takenOver) return { ok: false, reason: `${worker.id} was taken over; its branch is yours to finish and merge` };
  if (worker.state !== 'done') return { ok: false, reason: `${worker.id} has not finished (${worker.state})` };
  if (!worker.snapshot?.sha) return { ok: false, reason: `${worker.id} has no snapshot yet` };
  if (worker.test?.running) return { ok: false, reason: `${worker.id}'s tests are still running` };
  if (worker.snapshotting) return { ok: false, reason: `${worker.id} is being snapshotted` };
  // The reviewed commit is still the tip, but the worktree has moved on from
  // it: something wrote after the snapshot. It gets a new snapshot, and a
  // new review.
  if (worktreeChanged) {
    return { ok: false, reason: `${worker.id}'s worktree changed after the snapshot you reviewed; it is being snapshotted again — review it again` };
  }
  if (tipSha !== reviewedSha || worker.snapshot.sha !== reviewedSha) {
    return { ok: false, reason: `${worker.branch} changed since you reviewed it; review it again` };
  }
  return { ok: true };
}
