// Boots the overlay: one snapshot per second, one render per snapshot. This is
// the only module that holds state, and it holds exactly two pieces of it —
// which sessions the user dismissed, and which raise attempts went stale.

import { abbrevTokens, formatReset, repoBasename } from './format.js';
import {
  aggregateState,
  headerEta,
  headline,
  modelLabel,
  proseForPill,
  repoLabel,
  rowEta,
  useWidePill,
  usageRemaining,
  usageTone,
} from './model.js';
import { createHost } from './host.js';
import { wireClickThrough, wireDrag, wireExpand, wireRaise } from './interact.js';
import { createStatusPill, createUsagePill } from './render.js';

const TICK_MS = 1000;

export function start(dock) {
  const host = createHost(dock);
  const status = createStatusPill();
  const usage = createUsagePill();
  dock.append(status.el, usage.el);

  // Dismissal is a view decision: it hides the row and never signals the
  // process, so it lives here and not in the adapter.
  const dismissed = new Set();
  const stale = new Set();
  let latest = { sessions: [], usage: null, terminal: {} };

  // Hover does not expand an empty pill, or one showing a notice: there is
  // nothing to list in either case.
  const statusExpand = wireExpand(
    status,
    () => visible(latest, dismissed).length > 0 && !(latest.permission && !latest.permission.ok),
  );
  wireExpand(usage, () => true);
  // Only the status pill has a handle. Dragging it carries the usage pill,
  // because they are laid out as one row.
  const drag = wireDrag(status, host);

  wireRaise(status, statusExpand, {
    dragJustHappened: drag.dragJustHappened,
    // While blocked, the whole pill is the button that asks for permission.
    onNotice: () => host.grant(),
    isBlocked: () => Boolean(latest.permission && !latest.permission.ok),
    defaultSessionId: () => longestRunningId(visible(latest, dismissed)),
    onDismiss: (id) => {
      dismissed.add(id);
      paint();
    },
    onRaise: async (id) => {
      const outcome = await host.raise(id);
      if (outcome === 'stale') {
        stale.add(id);
        paint();
      }
      return outcome;
    },
  });

  wireClickThrough(dock, host);

  async function tick() {
    latest = await host.read();
    stale.clear();
    paint();
  }

  function paint() {
    const sessions = visible(latest, dismissed);
    const blocked = latest.permission && !latest.permission.ok;
    status.update(
      blocked ? noticeView() : statusView(sessions, latest, stale, Date.now()),
    );
    // The usage pill is meaningless while blocked, and two pills saying nothing
    // is worse than one.
    usage.el.style.display = blocked ? 'none' : '';
    if (latest.usage && !blocked) usage.update(usageView(latest.usage));
  }

  void tick();
  setInterval(tick, TICK_MS);
  return { tick };
}

// macOS will not hand over window geometry or let us raise another app until
// the user says so, and this pill is the only place to say it.
function noticeView() {
  return {
    state: 'waiting',
    wide: false,
    repo: null,
    model: null,
    headline: '',
    notice: 'Allow access to your terminal',
    eta: null,
    rows: [],
  };
}

function visible(snapshot, dismissed) {
  return (snapshot.sessions ?? []).filter((s) => !dismissed.has(s.id));
}

function longestRunningId(sessions) {
  let oldest = null;
  for (const s of sessions) if (!oldest || s.startedAt < oldest.startedAt) oldest = s;
  return oldest?.id ?? null;
}

function statusView(sessions, snapshot, stale, now) {
  const wide = useWidePill(snapshot.terminal?.width);
  return {
    state: aggregateState(sessions),
    wide,
    repo: repoLabel(sessions),
    model: modelLabel(sessions),
    headline: proseForPill(headline(sessions, snapshot.headline), wide),
    eta: headerEta(sessions, now),
    rows: sessions.map((s) => ({
      id: s.id,
      index: s.index,
      state: s.state,
      summary: s.summary,
      meta: `${repoBasename(s.repo)} · ${s.model}`,
      eta: rowEta(s, now),
      stale: stale.has(s.id),
    })),
  };
}

function usageView(usage) {
  const percent = (usage.weeklyUsed / usage.weeklyLimit) * 100;
  return {
    percent,
    tone: usageTone(percent),
    session: abbrevTokens(usage.sessionTokens),
    today: abbrevTokens(usage.todayTokens),
    left: usageRemaining(usage),
    burn: `~${abbrevTokens(usage.burnRatePerHour)}/hr`,
    reset: formatReset(usage.resetsAt, new Date()),
  };
}
