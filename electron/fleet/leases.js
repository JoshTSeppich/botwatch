// Leases: tokens, worker slots and an expiry, granted by the hypervisor to
// one orchestrator and enforced by pilld. Pure rules; fleet.js holds state.
//
// What is prevented and what is detected:
// - A grant is exact. pilld refuses any grant that would let the leases
//   together, plus what the hypervisor has spent, exceed the global budget.
// - Spending is not. Tokens are counted as they are reported, and a lease
//   that runs out is paused, so the step that crosses it is already spent:
//   up to one step per running session (see the design doc's rulings).
// - Expiry is pilld's clock, not the hypervisor's: it holds with the
//   hypervisor dead.

export function grantable(fleet, id, { tokens, slots, expiresAt }, now = Date.now()) {
  if (!Number.isInteger(tokens) || tokens <= 0) return { ok: false, reason: 'tokens must be a whole number above zero' };
  if (!Number.isInteger(slots) || slots < 1) return { ok: false, reason: 'slots must be a whole number, at least 1' };
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { ok: false, reason: 'the expiry must be in the future' };
  const current = fleet.leases.get(id);
  // A lease can shrink, but not below what its orchestrator already spent.
  if (current && tokens < current.spent) {
    return { ok: false, reason: `${id} has already spent ${current.spent.toLocaleString('en-US')}; a lease can't be smaller than that` };
  }
  const others = [...fleet.leases.entries()].filter(([k]) => k !== id).reduce((n, [, l]) => n + l.tokens, 0);
  const total = others + tokens + fleet.hypervisorSpent;
  if (total > fleet.budgetTokens) {
    const room = fleet.budgetTokens - others - fleet.hypervisorSpent;
    return {
      ok: false,
      reason: `that would put the leases at ${total.toLocaleString('en-US')} against a global budget of ${fleet.budgetTokens.toLocaleString('en-US')}; at most ${Math.max(0, room).toLocaleString('en-US')} can go to ${id}`,
    };
  }
  if (slots > fleet.maxSessions) return { ok: false, reason: `slots can't exceed the global session cap (${fleet.maxSessions})` };
  return { ok: true };
}

// Whether an orchestrator may start anything new under its lease right now.
export function leaseLive(lease, now = Date.now()) {
  if (!lease) return { ok: false, reason: 'no lease: the hypervisor has to grant one' };
  if (lease.revoked) return { ok: false, reason: 'the lease was revoked' };
  if (now >= lease.expiresAt) return { ok: false, reason: 'the lease has expired' };
  if (lease.spent >= lease.tokens) return { ok: false, reason: 'the lease is spent' };
  if (lease.reserveHit) return { ok: false, reason: "the lease's reserve is reached: what is left is under one step" };
  return { ok: true };
}

// Sessions running across every level: the hypervisor, orchestrators and
// workers. Paused and finished ones don't count; they aren't running.
export function runningSessions(fleet) {
  let n = fleet.hypervisor?.state === 'running' ? 1 : 0;
  for (const o of fleet.orchestrators.values()) {
    if (o.session?.state === 'running') n += 1;
    for (const w of o.run?.workers ?? []) if (w.state === 'running') n += 1;
  }
  return n;
}

export function underCap(fleet) {
  const n = runningSessions(fleet);
  return n < fleet.maxSessions ? { ok: true } : { ok: false, reason: `the global session cap is reached (${n} of ${fleet.maxSessions} running)`, queue: true };
}
