// v3 in the live pill: the setup panel (⌥⌘O), the run's tree while it works,
// and the review panel that is the only way anything merges.
//
// Nothing here decides anything about a repo. The panels show what pilld
// reports and send back what the user chose; pilld checks it all again.

import { abbrevTokens, formatElapsed } from './format.js';
import { orchestratorPill } from './orchestrator-view.js';

const WORKER_CHOICES = [2, 4, 6];
const BUDGET_CHOICES = [1_000_000, 2_000_000, 5_000_000];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const node = el('button', `btn ${className ?? ''}`.trim(), label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

// A row of mutually exclusive chips. Returns the element and a getter.
function chips(name, options, initial, format = String) {
  const row = el('div', 'chips');
  row.dataset.field = name;
  let value = initial;
  for (const option of options) {
    const chip = button(format(option), 'chip-btn', () => {
      value = option;
      for (const c of row.children) c.classList.toggle('is-on', c === chip);
    });
    chip.dataset.value = String(option);
    if (option === initial) chip.classList.add('is-on');
    row.append(chip);
  }
  return { el: row, get: () => value };
}

function field(label, control, note) {
  const wrap = el('div', 'field');
  wrap.append(el('div', 'field__label', label), control);
  if (note) wrap.append(el('div', 'field__note', note));
  return wrap;
}

function time(at) {
  return at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

export function createOrchestrate({ dock, host, statusEl }) {
  const api = host.orch;
  if (!api) return { update() {}, open() {} };

  const runEl = el('div', 'run-slot');
  const panel = el('div', 'panel');
  panel.hidden = true;
  dock.prepend(runEl);
  dock.append(panel);
  let panelKind = null;
  let lastRun = null;
  // The tree is rebuilt only when what it shows has changed, and never under
  // a pressed pointer: rebuilding every tick replaced buttons between mouse
  // down and up, and the click went nowhere.
  let drawn = '';
  let pressed = false;
  runEl.addEventListener('pointerdown', () => {
    pressed = true;
  });
  window.addEventListener('pointerup', () => {
    pressed = false;
  });

  function closePanel() {
    panel.hidden = true;
    panel.textContent = '';
    panelKind = null;
    host.keyboard?.(false);
  }

  function showPanel(kind, content) {
    panel.textContent = '';
    panel.append(content);
    panel.hidden = false;
    panelKind = kind;
  }

  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanel();
  });

  // ---- setup -------------------------------------------------------------

  async function openSetup(repo) {
    if (lastRun && !lastRun.closed) return openReviewOrNothing();
    const info = await api.setup(repo ?? null);
    host.keyboard?.(true);

    const form = el('form', 'setup');
    form.append(el('div', 'panel__title', 'Orchestrate'));

    const goal = el('textarea', 'setup__goal');
    goal.name = 'goal';
    goal.placeholder = 'What should the workers get done?';
    goal.rows = 3;
    form.append(field('Goal', goal));

    const repoInput = el('input', 'setup__repo');
    repoInput.name = 'repo';
    repoInput.value = info.repo ?? '';
    repoInput.placeholder = '/path/to/a/git/repo';
    const repoChips = el('div', 'chips');
    for (const r of info.repos) {
      repoChips.append(
        button(r.split('/').pop(), 'chip-btn', async () => {
          repoInput.value = r;
          const next = await api.setup(r);
          testInput.value = next.testCommand ?? '';
        }),
      );
    }
    const repoWrap = el('div');
    repoWrap.append(repoChips, repoInput);
    form.append(field('Repo', repoWrap));

    const model = chips('model', info.models, info.models.includes('sonnet') ? 'sonnet' : info.models[0]);
    form.append(field('Model', model.el));
    const workers = chips('workers', WORKER_CHOICES, 2);
    form.append(field('Workers at once', workers.el));
    const budget = chips('budget', BUDGET_CHOICES, 1_000_000, abbrevTokens);
    form.append(field('Token budget', budget.el));

    // Never wider than the user's own, and starting on acceptEdits: pilld
    // decides both (setup.js permissionChoices).
    const permission = chips('permission', info.offered, info.start);
    form.append(field('Workers may', permission.el, `Your own sessions run as ${info.ceiling}; workers get no more.`));

    const testInput = el('input', 'setup__test');
    testInput.name = 'testCommand';
    testInput.value = info.testCommand ?? '';
    testInput.placeholder = 'none';
    form.append(
      field('Test command', testInput, "Run on each worker's snapshot, sandboxed: no network, no writes outside its worktree."),
    );
    form.append(el('div', 'field__note', 'Each worker gets its own worktree and a branch under bw/.'));

    const error = el('div', 'panel__error');
    const actions = el('div', 'panel__actions');
    const start = el('button', 'btn btn--accent', 'Start');
    start.type = 'submit';
    actions.append(button('Cancel', '', closePanel), el('div', 'footer__spacer'), start);
    form.append(error, actions);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      start.disabled = true;
      error.textContent = '';
      const outcome = await api.start({
        goal: goal.value,
        repo: repoInput.value,
        model: model.get(),
        maxWorkers: workers.get(),
        budgetTokens: budget.get(),
        permissionCeiling: permission.get(),
        testCommand: testInput.value.trim() || null,
      });
      start.disabled = false;
      if (outcome?.error) error.textContent = outcome.error;
      else closePanel();
    });

    showPanel('setup', form);
    goal.focus();
  }

  function openReviewOrNothing() {
    if (lastRun?.ready) return openReview();
    return null;
  }

  // ---- review ------------------------------------------------------------

  async function openReview() {
    host.keyboard?.(true);
    const { reviews = [], error: failed } = await api.review();
    const root = el('div', 'review');
    root.append(el('div', 'panel__title', `Review · ${lastRun?.repo ?? ''}`));
    if (failed) root.append(el('div', 'panel__error', failed));

    // One checkbox per flagged file: acknowledging is naming each file, not
    // waving them all through. Merge stays clickable, because the refusal
    // that counts is pilld's, and it names what is still unacknowledged.
    const acks = [];
    const merge = el('button', 'btn btn--accent', `Merge ${reviews.length} branch${reviews.length === 1 ? '' : 'es'}`);
    merge.type = 'button';
    const refresh = () => {
      merge.disabled = !reviews.length;
    };

    for (const r of reviews) {
      const card = el('section', 'review__branch');
      card.dataset.branch = r.branch;
      const head = el('div', 'review__head');
      head.append(el('span', 'review__id', r.id), el('span', 'review__task', r.task ?? ''));
      card.append(head);

      const prov = el('dl', 'review__prov');
      const add = (k, v, cls) => {
        prov.append(el('dt', null, k));
        prov.append(el('dd', cls, v));
      };
      add('branch', `${r.branch} ← ${r.base}`);
      add('snapshot', r.sha ? `${r.sha.slice(0, 10)} · ${time(r.snapshot?.at)}` : 'not snapshotted');
      if (!r.test?.command) add('tests', 'no test command set', 'is-muted');
      else if (r.test.running) add('tests', `${r.test.command} · running…`);
      else {
        const verdict = r.test.passed ? 'passed' : r.test.timedOut ? 'timed out' : `failed (exit ${r.test.exitCode})`;
        const stale = r.test.sha && r.sha && r.test.sha !== r.sha ? ' · ran on an older snapshot' : '';
        add('tests', `${r.test.command} · ${verdict} · ${time(r.test.finishedAt)}${stale}`, r.test.passed ? 'is-pass' : 'is-fail');
      }
      card.append(prov);
      if (r.test?.tail && !r.test.passed) {
        const out = el('details', 'review__tail');
        out.append(el('summary', null, 'test output'), el('pre', null, r.test.tail));
        card.append(out);
      }

      const flaggedBy = new Map(r.flagged.map((f) => [f.file, f.reason]));
      const list = (title, entries) => {
        const block = el('div', 'review__files');
        block.append(el('div', 'review__files-title', `${title} · ${entries.length}`));
        if (!entries.length) block.append(el('div', 'review__none', 'none'));
        for (const entry of entries) {
          const line = el('div', 'review__file');
          line.append(el('span', 'review__path', entry.file));
          line.append(el('span', 'review__delta', entry.deleted ? 'deleted' : `+${entry.added} −${entry.removed}`));
          const reason = flaggedBy.get(entry.file);
          if (reason) {
            line.classList.add('is-flagged');
            const ack = el('label', 'review__ack');
            const box = el('input');
            box.type = 'checkbox';
            box.dataset.ack = `${r.id}:${entry.file}`;
            box.addEventListener('change', refresh);
            acks.push(box);
            ack.append(box, el('span', null, `${reason} — merge it anyway`));
            line.append(ack);
          }
          block.append(line);
        }
        return block;
      };
      card.append(list('Edits', r.edits), list('New files', r.added));
      root.append(card);
    }

    const result = el('div', 'panel__error');
    merge.addEventListener('click', async () => {
      merge.disabled = true;
      result.className = 'panel__error';
      const outcome = await api.merge({
        reviewed: reviews.map((r) => ({ branch: r.branch, sha: r.sha })),
        acknowledged: acks.filter((b) => b.checked).map((b) => b.dataset.ack),
      });
      if (outcome?.error) {
        const files = (outcome.flagged ?? []).map((f) => `${f.worker}:${f.file}`).join(', ');
        result.textContent = files ? `${outcome.error}: ${files}` : outcome.error;
        refresh();
        return;
      }
      result.className = 'panel__ok';
      result.textContent = outcome.merged.map((m) => `merged ${m.branch} @ ${m.sha.slice(0, 7)}`).join(' · ');
    });
    refresh();

    const actions = el('div', 'panel__actions');
    actions.append(button('Close', '', closePanel), el('div', 'footer__spacer'), merge);
    root.append(result, actions);
    showPanel('review', root);
  }

  // ---- the tree ----------------------------------------------------------

  function pillModel(run) {
    const aggregate = run.workers.some((w) => w.state === 'errored')
      ? 'errored'
      : run.ready
        ? 'done'
        : 'working';
    return {
      aggregate,
      activeWorkers: run.activeWorkers,
      repo: run.repo,
      sentence: run.sentence,
      tasks: run.workers,
      model: run.model,
      time: formatElapsed(run.elapsedMs / 1000),
      orchestrator: { state: run.orchestrator.state, summary: run.orchestrator.summary },
      workers: run.workers.map((w) => ({
        ...w,
        summary: w.test?.running ? 'running the tests' : w.summary,
        time: abbrevTokens(w.tokens),
      })),
      budget: run.budget,
      paused: false,
    };
  }

  function update(run) {
    lastRun = run;
    const active = Boolean(run && !run.closed);
    statusEl.style.display = active ? 'none' : '';
    if (!active) {
      runEl.textContent = '';
      drawn = '';
      return;
    }
    const model = pillModel(run);
    // The clock ticks every second and is patched in place; only a change in
    // what the tree says is a reason to rebuild it.
    const signature = JSON.stringify([{ ...model, time: null }, run.ready, run.stopped, run.merges.length]);
    if (signature === drawn || pressed) {
      const clock = runEl.querySelector('.hdr .eta');
      if (clock && clock.textContent !== model.time) clock.textContent = model.time;
      return;
    }
    drawn = signature;
    runEl.textContent = '';

    const pill = orchestratorPill(model);
    // The footer the view draws is generic; these are the actions this run has.
    const footer = pill.querySelector('.footer');
    footer.textContent = '';
    if (run.stopped || run.merges.length) footer.append(button('Close run', '', () => api.close()));
    else footer.append(holdToStop());
    footer.append(el('div', 'footer__spacer'));
    const review = button(run.ready ? 'Review and merge' : 'Review', 'btn--accent', openReview);
    review.disabled = !run.ready;
    footer.append(review);
    runEl.append(pill);
  }

  // Stop is destructive, so it needs a 600ms hold; a click does nothing.
  function holdToStop() {
    const stop = el('button', 'btn btn--danger', 'Stop');
    stop.type = 'button';
    stop.append(el('span', 'hold'));
    let timer = null;
    stop.addEventListener('pointerdown', () => {
      stop.classList.add('is-holding');
      timer = setTimeout(() => api.stop(), 600);
    });
    const cancel = () => {
      stop.classList.remove('is-holding');
      clearTimeout(timer);
    };
    stop.addEventListener('pointerup', cancel);
    stop.addEventListener('pointerleave', cancel);
    return stop;
  }

  api.onOpen(() => (panelKind ? closePanel() : openSetup()));

  return { update, open: openSetup, review: openReview };
}
