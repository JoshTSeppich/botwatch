// Builds the two pills once and patches them in place on every tick. Rebuilding
// the DOM each second would drop hover and restart the pulse, and the spec is
// strict about what is allowed to move.

const STATE_CLASSES = ['is-working', 'is-waiting', 'is-errored', 'is-idle'];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function handle() {
  const node = el('div', 'handle');
  for (let i = 0; i < 4; i += 1) node.append(el('i'));
  return node;
}

function setState(node, state) {
  node.classList.remove(...STATE_CLASSES);
  node.classList.add(`is-${state}`);
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function show(node, visible) {
  node.style.display = visible ? '' : 'none';
}

export function createStatusPill() {
  const pill = el('div', 'pill pill--status');
  const hdr = el('div', 'hdr');
  const badge = el('div', 'hdr__badge');
  const dot = el('i', 'dot');
  const count = el('div', 'count');
  const chip = el('div', 'chip');
  const prose = el('div', 'prose');
  const model = el('div', 'model');
  const divider = el('div', 'div');
  const eta = el('div', 'eta');
  const rows = el('div', 'rows');

  badge.append(dot, count);
  hdr.append(handle(), badge, chip, prose, model, divider, eta);
  pill.append(hdr, rows);

  let renderedIds = '';
  const rowNodes = new Map();

  function buildRows(list) {
    rows.textContent = '';
    rowNodes.clear();
    for (const row of list) {
      const node = el('div', 'row');
      const body = el('div', 'row__body');
      const parts = {
        dot: el('i', 'dot dot--row'),
        idx: el('div', 'row__idx'),
        prose: el('div', 'row__prose'),
        meta: el('div', 'row__meta'),
        eta: el('div', 'row__eta'),
        close: el('div', 'row__x', '×'),
      };
      body.append(parts.prose, parts.meta);
      node.append(parts.dot, parts.idx, body, parts.eta, parts.close);
      node.dataset.sessionId = row.id;
      parts.close.dataset.dismiss = row.id;
      rows.append(node);
      rowNodes.set(row.id, { node, parts });
    }
  }

  function update(view) {
    setState(pill, view.state);
    // A notice replaces the whole pill: there is nothing to report until it is
    // dealt with, so it borrows the empty state's intrinsic-width layout.
    pill.classList.toggle('is-notice', Boolean(view.notice));
    pill.classList.toggle('is-empty', view.rows.length === 0);
    pill.classList.toggle('is-wide', view.wide && view.rows.length > 0);
    setState(dot, view.state);

    show(count, view.rows.length > 0);
    show(eta, view.rows.length > 0);
    show(chip, Boolean(view.wide && view.repo));
    show(model, Boolean(view.wide && view.model));
    show(divider, Boolean(view.wide && view.rows.length > 0));

    setText(count, String(view.rows.length));
    setText(prose, view.notice ?? view.headline);
    setText(eta, view.eta ?? '');
    setText(chip, view.repo ?? '');
    setText(model, view.model ?? '');

    const ids = view.rows.map((r) => r.id).join('|');
    if (ids !== renderedIds) {
      buildRows(view.rows);
      renderedIds = ids;
    }
    for (const row of view.rows) {
      const { node, parts } = rowNodes.get(row.id);
      node.classList.toggle('row--waiting', row.state === 'waiting');
      node.classList.toggle('row--stale', Boolean(row.stale));
      setState(parts.dot, row.state);
      setText(parts.idx, String(row.index));
      setText(parts.prose, row.summary);
      setText(parts.meta, row.meta);
      setText(parts.eta, row.eta);
    }
    pill.style.setProperty('--rows-h', `${view.rows.length * 52}px`);
  }

  return { el: pill, header: hdr, rows, update };
}

export function createUsagePill() {
  const pill = el('div', 'pill pill--usage');
  const hdr = el('div', 'hdr');
  const unit = el('div', 'usage__unit', 'wk');
  const bar = el('div', 'bar');
  const fill = el('div', 'bar__fill');
  const pct = el('div', 'usage__pct');
  const divider = el('div', 'div hdr__collapsed');
  const tokens = el('div', 'usage__tokens hdr__collapsed');
  const list = el('div', 'ulist');

  // Five rows, fixed order, never scrolling: position is how you read it.
  const figures = {};
  for (const [key, label, tone] of [
    ['session', 'This session', ''],
    ['today', 'All sessions today', ''],
    ['left', 'Left this week', 'ulist__row--primary'],
    ['burn', 'Burn rate', 'ulist__row--muted'],
    ['reset', 'Resets', 'ulist__row--muted'],
  ]) {
    const row = el('div', `ulist__row ${tone}`.trim());
    const figure = el('div', 'ulist__fig');
    row.append(el('div', 'ulist__label', label), figure);
    list.append(row);
    figures[key] = figure;
  }

  bar.append(fill);
  hdr.append(unit, bar, pct, divider, tokens);
  pill.append(hdr, list);

  function update(view) {
    fill.style.width = `${Math.min(100, Math.max(0, view.percent))}%`;
    fill.classList.remove(...STATE_CLASSES);
    fill.classList.add(`is-${view.tone}`);
    pct.classList.toggle('is-errored', view.tone === 'errored');
    setText(pct, `${Math.round(view.percent)}%`);
    setText(tokens, view.session);
    setText(figures.session, view.session);
    setText(figures.today, view.today);
    setText(figures.left, view.left);
    setText(figures.burn, view.burn);
    setText(figures.reset, view.reset);
  }

  return { el: pill, header: hdr, update };
}
