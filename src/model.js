// Derivations that turn a snapshot of sessions into the handful of values the
// pill actually renders. This module owns the precedence rules (which colour
// wins, which session's estimate is shown); it does not own any formatting or
// any DOM.

import { abbrevTokens, formatDuration, formatElapsed, repoBasename, truncate } from './format.js';

export const PROSE_CAP = { narrow: 34, wide: 46 };
export const WIDE_MIN_TERMINAL_WIDTH = 900;

// Red beats amber beats green. A stopped session is the one thing you must not
// miss, and a question beats work in progress because work needs nothing.
export function aggregateState(sessions) {
  if (sessions.some((s) => s.state === 'errored' || s.state === 'stalled')) return 'errored';
  if (sessions.some((s) => s.state === 'waiting')) return 'waiting';
  if (sessions.some((s) => s.state === 'working')) return 'working';
  return 'idle';
}

export function isBlocked(session) {
  return session.state === 'waiting';
}

// "Longest-running" is oldest start, not largest estimate: the estimate can be
// missing, the start time never is.
export function longestRunning(sessions) {
  let oldest = null;
  for (const s of sessions) {
    if (!oldest || s.startedAt < oldest.startedAt) oldest = s;
  }
  return oldest;
}

export function headerEta(sessions, now) {
  if (sessions.length === 0) return null;
  if (sessions.some(isBlocked)) return 'now';
  const top = longestRunning(sessions);
  return top ? timeFor(top, now) : null;
}

export function rowEta(session, now) {
  if (isBlocked(session)) return 'now';
  return timeFor(session, now);
}

// Three branches in order of honesty: a reported estimate gets the spec's
// tilde, otherwise measured elapsed time with no tilde, otherwise nothing is
// claimed. A stopped session shows nothing either way — its clock is not running.
function timeFor(session, now) {
  if (session.state === 'errored' || session.state === 'stalled') return '—';
  if (session.etaSeconds != null) return formatDuration(session.etaSeconds);
  if (session.startedAt != null) return formatElapsed((now - session.startedAt) / 1000);
  return '—';
}

// The source owns this sentence when it can write a better one — it is the only
// place in the UI where copy is editorial. These fallbacks keep the slot honest
// when it cannot.
export function headline(sessions, supplied) {
  if (supplied) return supplied;
  if (sessions.length === 0) return 'idle';
  // Same precedence as the dot, so the sentence and the colour never disagree.
  const broken = sessions.find((s) => s.state === 'errored' || s.state === 'stalled');
  if (broken) return `Session ${broken.index} stopped — the last command failed`;
  const blocked = sessions.find(isBlocked);
  if (blocked) return `Waiting for your answer in session ${blocked.index}`;
  const top = longestRunning(sessions);
  return top?.summary ?? 'idle';
}

export function proseForPill(text, wide) {
  return truncate(text, wide ? PROSE_CAP.wide : PROSE_CAP.narrow);
}

export function repoLabel(sessions) {
  const repos = new Set(sessions.map((s) => s.repo));
  if (repos.size === 0) return null;
  if (repos.size === 1) return repoBasename([...repos][0]);
  return `${repos.size} repos`;
}

export function modelLabel(sessions) {
  const models = new Set(sessions.map((s) => s.model));
  if (models.size === 0) return null;
  return models.size === 1 ? [...models][0] : 'mixed';
}

export function useWidePill(terminalWidth) {
  return (terminalWidth ?? 0) > WIDE_MIN_TERMINAL_WIDTH;
}

export function usageTone(percent) {
  if (percent >= 90) return 'errored';
  if (percent >= 75) return 'waiting';
  return 'working';
}

export function usageRemaining(usage) {
  return `${abbrevTokens(usage.weeklyLimit - usage.weeklyUsed)} / ${abbrevTokens(usage.weeklyLimit)}`;
}
