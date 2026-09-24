// What the setup screen is allowed to say about your weekly allowance.
//
// The reference mockup states "≈ 13% of what's left this week" flatly. BotWatch
// cannot: there is no live weekly limit to read. The only real numbers are a
// rate_limit_event captured while a worker ran, which goes stale, or a limit the
// user typed in. So the label carries its source and its age, and when there is
// neither it says nothing rather than inventing a denominator.

const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export function weeklyAllowance({ cached = null, enteredLimit = null, spent = 0, now = Date.now() } = {}) {
  // Measured beats entered: it came from the CLI rather than from memory.
  if (cached?.sevenDay && Number.isFinite(cached.sevenDay.utilization)) {
    const age = now - (cached.at ?? 0);
    return {
      remainingFraction: Math.max(0, 1 - cached.sevenDay.utilization),
      source: 'measured',
      ageMs: age,
      stale: age > STALE_AFTER_MS,
    };
  }
  if (Number.isFinite(enteredLimit) && enteredLimit > 0) {
    return {
      remainingFraction: Math.max(0, 1 - spent / enteredLimit),
      source: 'entered',
      ageMs: null,
      stale: false,
    };
  }
  return null;
}

// The line under "Token budget". Null means show nothing — an unlabelled
// percentage is worse than no percentage.
export function allowanceLabel(budgetTokens, allowance, weeklyLimit = null) {
  if (!allowance) return null;
  const limit = allowance.source === 'entered' ? weeklyLimit : weeklyLimit ?? null;
  if (!Number.isFinite(limit) || limit <= 0) return null;

  const remaining = limit * allowance.remainingFraction;
  if (remaining <= 0) return null;
  const percent = Math.round((budgetTokens / remaining) * 100);

  if (allowance.source === 'entered') return `≈ ${percent}% of what's left this week · from the limit you set`;
  const age = describeAge(allowance.ageMs);
  return allowance.stale
    ? `≈ ${percent}% of what's left this week · measured ${age}, may be out of date`
    : `≈ ${percent}% of what's left this week · measured ${age}`;
}

function describeAge(ms) {
  if (!Number.isFinite(ms)) return 'just now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

// The reference mockup shows `opus 4.6`. That is a label in a picture. Model
// chips come from the session data, through the same formatter the pill uses,
// so they say what is actually running.
export function modelChip(modelId) {
  if (!modelId) return null;
  const parts = String(modelId).replace(/^claude-/, '').split('-');
  const family = parts.shift() ?? '';
  const version = parts.filter((p) => /^\d+$/.test(p)).join('.');
  return version ? `${family} ${version}` : family || null;
}
