// The v3 screens: the orchestrator's collapsed line and its expanded tree.
//
// Separate from render.js because the orchestrator is a different shape of
// thing. v1 shows sessions side by side; v3 shows one session that owns the
// others, and the tree, the task strip and the budget only exist here.

import { abbrevTokens } from './format.js';

const MAX_SEGMENTS = 8;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// One segment per task, until there are too many for a segment to mean
// anything, at which point it becomes a single bar. Pure, so the decision can
// be tested without a DOM.
export function stripPlan(tasks) {
  if (tasks.length > MAX_SEGMENTS) {
    const done = tasks.filter((t) => t.state === 'done').length;
    return { kind: 'bar', fraction: done / tasks.length };
  }
  return {
    kind: 'segments',
    states: tasks.map((t) => (['done', 'running', 'asking'].includes(t.state) ? t.state : 'queued')),
  };
}

// Colour is never the only signal, so every non-working state has a glyph.
export function badgeTone(state) {
  if (['working', 'running', 'queued'].includes(state)) return { kind: 'dot', tone: state === 'queued' ? 'is-idle' : 'is-working' };
  const glyphs = {
    asking: ['?', 'is-accent'],
    waiting: ['?', 'is-waiting'],
    errored: ['!', 'is-errored'],
    done: ['\u2713', 'is-turn'],
    // Handed to the user in a terminal: out of BotWatch's hands, not failed.
    takenover: ['\u2197', 'is-idle'],
  };
  const [glyph, tone] = glyphs[state] ?? ['?', 'is-waiting'];
  return { kind: 'badge', glyph, tone };
}

export function taskStrip(tasks) {
  const plan = stripPlan(tasks);
  if (plan.kind === 'bar') {
    const strip = el('div', 'strip is-summarised');
    const fill = el('b');
    fill.style.width = `${Math.round(plan.fraction * 100)}%`;
    strip.append(fill);
    return strip;
  }
  const strip = el('div', 'strip');
  for (const state of plan.states) {
    const seg = el('i');
    if (state !== 'queued') seg.className = `is-${state}`;
    strip.append(seg);
  }
  return strip;
}

export function badge(state) {
  const plan = badgeTone(state);
  if (plan.kind === 'dot') {
    const dot = el('i', 'dot dot--row');
    dot.classList.add(plan.tone);
    return dot;
  }
  return el('div', `badge ${plan.tone}`, plan.glyph);
}

// "3 of 5 tasks done", the count, the strip and the time — the orchestrator
// owns the collapsed line while it runs.
export function collapsedLine(run) {
  const line = el('div', 'hdr');
  const handle = el('div', 'handle');
  for (let i = 0; i < 4; i += 1) handle.append(el('i'));
  line.append(handle);

  const badgeWrap = el('div', 'hdr__badge');
  badgeWrap.append(badge(run.aggregate), el('div', 'count', String(run.activeWorkers)));
  line.append(badgeWrap);

  if (run.repo) line.append(el('div', 'chip', run.repo));
  line.append(el('div', 'prose', run.sentence));
  line.append(taskStrip(run.tasks));
  if (run.model) line.append(el('div', 'model', run.model));
  line.append(el('div', 'eta', run.time));
  return line;
}

function workerRow(worker) {
  const row = el('div', `row row--worker${worker.state === 'queued' ? ' row--queued' : ''}`);
  // Clicking a worker opens its log.
  row.dataset.worker = worker.id;
  row.append(badge(worker.state));
  row.append(el('div', 'row__idx', worker.id));

  const body = el('div', 'row__body');
  body.append(el('div', 'row__prose', worker.summary));
  body.append(el('div', 'row__meta', `${worker.branch} · ${worker.model}`));
  if (worker.state === 'running' || worker.state === 'done') {
    const progress = el('div', 'progress');
    const fill = el('b');
    fill.style.width = `${Math.round((worker.progress ?? 0) * 100)}%`;
    progress.append(fill);
    body.append(progress);
  }
  row.append(body);
  row.append(el('div', 'row__eta', worker.time ?? ''));
  return row;
}

export function tree(run) {
  const rows = el('div', 'rows');

  const orchestrator = el('div', 'row row--orchestrator');
  orchestrator.append(badge(run.orchestrator.state));
  // The spec's `O`, in the sans font: in the mono font it reads as a zero.
  orchestrator.append(el('div', 'row__idx row__idx--o', 'O'));
  const body = el('div', 'row__body');
  body.append(el('div', 'row__prose', run.orchestrator.summary));
  body.append(el('div', 'row__meta', `${run.repo} · ${run.model}`));
  orchestrator.append(body);
  orchestrator.append(el('div', 'row__eta', run.orchestrator.time ?? ''));
  rows.append(orchestrator);

  for (const worker of run.workers) rows.append(workerRow(worker));
  return rows;
}

// Spent solid, projected hatched. The projection is allowed to run past the
// limit, because that overrun is the warning.
export function budgetRow(budget) {
  const row = el('div', 'budget');
  const over = budget.projected > budget.limit;
  if (over) row.classList.add('is-over');
  row.append(el('div', null, 'Budget'));

  const track = el('div', 'budget__track');
  const used = el('div', 'budget__used');
  used.style.width = `${percent(budget.used, budget.limit)}%`;
  const projected = el('div', 'budget__projected');
  projected.style.left = `${percent(budget.used, budget.limit)}%`;
  projected.style.width = `${Math.max(0, percent(budget.projected - budget.used, budget.limit))}%`;
  track.append(used, projected);
  row.append(track);

  row.append(el('div', 'budget__figure', `${abbrevTokens(budget.used)} / ${abbrevTokens(budget.limit)}`));
  return row;
}

function percent(value, limit) {
  if (!limit) return 0;
  return Math.min(100, Math.max(0, Math.round((value / limit) * 100)));
}

export function footer({ paused = false } = {}) {
  const bar = el('div', 'footer');
  bar.append(el('button', 'btn', paused ? 'Resume all' : 'Pause all'));
  const stop = el('button', 'btn btn--danger', 'Stop');
  stop.append(el('span', 'hold'));
  bar.append(stop);
  bar.append(el('div', 'footer__spacer'));
  bar.append(el('button', 'btn btn--accent', 'Open orchestrator'));
  return bar;
}

const ROW_H = 52;
const WORKER_ROW_H = 56;

export function orchestratorPill(run) {
  const pill = el('div', 'pill pill--status is-xwide is-open');
  pill.append(collapsedLine(run));
  // .rows is driven by --rows-h; without it the tree is present but zero high.
  pill.style.setProperty('--rows-h', `${ROW_H + run.workers.length * WORKER_ROW_H}px`);
  pill.append(tree(run));
  if (run.budget) pill.append(budgetRow(run.budget));
  pill.append(footer({ paused: run.paused }));
  return pill;
}
