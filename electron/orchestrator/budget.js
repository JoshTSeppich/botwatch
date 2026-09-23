// The token ledger for a run. Separate from the usage pill's ledger: this one
// governs a single orchestrator run and is what pauses the workers.

export function createLedger(limitTokens) {
  return { limitTokens, startedAt: Date.now(), spent: 0, byWorker: new Map() };
}

export function record(ledger, workerId, tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return ledger;
  ledger.spent += tokens;
  ledger.byWorker.set(workerId, (ledger.byWorker.get(workerId) ?? 0) + tokens);
  return ledger;
}

export function exhausted(ledger) {
  return ledger.spent >= ledger.limitTokens;
}

// Straight-line projection from the burn so far. The brief shows this as a
// hatched bar beside the solid one, with an amber note when it overruns — so
// it has to be able to exceed the limit rather than clamp to it.
export function projected(ledger, tasksDone, tasksTotal) {
  if (!tasksDone || !tasksTotal) return ledger.spent;
  return Math.round((ledger.spent / tasksDone) * tasksTotal);
}

export function fits(ledger, tasksDone, tasksTotal) {
  return projected(ledger, tasksDone, tasksTotal) <= ledger.limitTokens;
}
