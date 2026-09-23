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

export function canSpawn(state, limits) {
  if (state.stopped) return { ok: false, reason: 'orchestrator stopped' };
  if (state.budgetExhausted) return { ok: false, reason: 'token budget reached' };
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
  if (state.workers.some((w) => w.state === 'running')) {
    return { ok: false, reason: 'workers still running' };
  }
  return { ok: true };
}
