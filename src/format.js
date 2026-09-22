// Every number-to-text rule in the spec lives here. Pure functions, no DOM, no
// clock of its own: the caller passes `now` so a test can pin time.

// The spec's cap is a ceiling for Latin copy, not a fit guarantee — CSS
// text-overflow is what actually keeps the pill from growing. Back up to a
// space only if one is close to the cut, so we never strand one letter.
const SPACE_BACKUP = 8;

export function truncate(text, cap) {
  if (text.length <= cap) return text;
  let cut = text.slice(0, cap - 1).trimEnd();
  const space = cut.lastIndexOf(' ');
  if (space > 0 && cut.length - space <= SPACE_BACKUP) cut = cut.slice(0, space);
  return `${cut}…`;
}

// The tilde is part of the format, not decoration: every duration in this UI is
// an estimate and must read as one.
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, seconds);
  if (s < 60) return `~${Math.max(1, Math.round(s))}s`;
  if (s < 3600) return `~${Math.max(1, Math.round(s / 60))}m`;
  return `~${Math.max(1, Math.round(s / 3600))}h`;
}

// Elapsed time carries no tilde on purpose. It is measured, not estimated, and
// the tilde is the only thing marking the difference.
export function formatElapsed(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  if (s < 60) return `${Math.max(1, s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function abbrevTokens(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  const [value, unit] = n < 1e6 ? [n / 1e3, 'k'] : [n / 1e6, 'M'];
  return `${trimZero(value.toFixed(1))}${unit}`;
}

// "40M", not "40.0M" — the trailing zero buys nothing and costs a glyph.
function trimZero(text) {
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatReset(resetsAt, now) {
  const at = new Date(resetsAt);
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  const days = Math.max(0, Math.ceil((at - now) / 86400000));
  return `${DAYS[at.getDay()]} ${hh}:${mm} · ${days}d`;
}

// Basename of the git root, capped so the chip never pushes the prose slot.
export function repoBasename(path, cap = 14) {
  const base = String(path).replace(/\/+$/, '').split('/').pop() || path;
  return truncate(base, cap);
}
