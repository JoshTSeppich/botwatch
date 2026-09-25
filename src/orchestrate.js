// v3 in the live pill: the setup panel (⌥⌘O), the run's tree while it works,
// and the review panel that is the only way anything merges.
//
// Nothing here decides anything about a repo. The panels show what pilld
// reports and send back what the user chose; pilld checks it all again.

import { abbrevTokens, formatElapsed, truncate } from './format.js';
import { plain } from '../electron/orchestrator/phrase.js';
import { createRoller, escalationStage } from './motion.js';
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
  // The tree is rebuilt as the run changes; the question card is not, so a
  // reply half-typed survives every redraw.
  const treeEl = el('div');
  const questionEl = el('div', 'question');
  questionEl.hidden = true;
  runEl.append(treeEl, questionEl);
  // The worker log: beside the card, outside the rebuilt tree, polled while open.
  const logEl = el('div', 'logpanel');
  logEl.hidden = true;
  dock.append(logEl);
  let logFor = null;
  let logAfter = 0;
  let logTimer = null;
  let asked = null;
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
  // The collapsed line outlives the tree around it, so the wheel can turn it.
  let lineEl = null;
  let lineRoller = null;
  // "w1 finished: …" for 2.6s when a worker's turn finishes (from the demo).
  let flash = null;
  const seenState = new Map();
  // F6 for the question card: when it appeared or was last hovered.
  let questionSince = null;
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
    // A run that was interrupted last time: say what was cleaned up and
    // which branches still hold its work.
    for (const r of info.recovered ?? []) {
      const parts = [`Recovered an interrupted run in ${r.repo.split('/').pop()}`];
      if (r.stopped.length) parts.push(`stopped ${r.stopped.join(', ')}`);
      if (r.hookRemoved) parts.push('removed its ref hook');
      if (r.kept.length) parts.push(`its branches are kept: ${r.kept.join(', ')}`);
      form.append(el('div', 'field__note', `${parts.join('; ')}.`));
    }

    const goal = el('textarea', 'setup__goal');
    goal.name = 'goal';
    goal.placeholder = 'What should the workers get done?';
    goal.rows = 3;
    form.append(field('Goal', goal));

    // Repos as the spec draws them: chips for the ones you're working in, and
    // a folder picker. Folder names only — a path would put your home
    // directory on screen, and on every screen recording of it.
    let chosenRepo = info.repo ?? null;
    const repoChips = el('div', 'chips');
    const pickRepo = async (path) => {
      chosenRepo = path;
      for (const c of repoChips.querySelectorAll('.chip-btn[data-repo]')) c.classList.toggle('is-on', c.dataset.repo === path);
      const next = await api.setup(path);
      testInput.value = next.testCommand ?? '';
    };
    const addRepoChip = (path) => {
      if (repoChips.querySelector(`.chip-btn[data-repo="${CSS.escape(path)}"]`)) return;
      const chip = button(path.split('/').pop(), 'chip-btn', () => pickRepo(path));
      chip.dataset.repo = path;
      chip.title = path;
      repoChips.insertBefore(chip, chooser);
    };
    const chooser = button('Choose folder\u2026', 'chip-btn chip-btn--quiet', async () => {
      const path = await api.chooseFolder();
      if (!path) return;
      addRepoChip(path);
      await pickRepo(path);
    });
    repoChips.append(chooser);
    for (const r of info.repos) addRepoChip(r);
    if (chosenRepo) {
      addRepoChip(chosenRepo);
      for (const c of repoChips.querySelectorAll('.chip-btn[data-repo]')) c.classList.toggle('is-on', c.dataset.repo === chosenRepo);
    }
    form.append(field('Repo', repoChips));

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
    const installs = chips('installs', ['off', 'on'], 'off');
    form.append(
      field('Package installs', installs.el, 'Off: workers reach Anthropic only. On: also npm, PyPI and crates.io.'),
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
        repo: chosenRepo ?? '',
        model: model.get(),
        maxWorkers: workers.get(),
        budgetTokens: budget.get(),
        permissionCeiling: permission.get(),
        testCommand: testInput.value.trim() || null,
        allowInstalls: installs.get() === 'on',
      });
      start.disabled = false;
      if (outcome?.error) error.textContent = outcome.error;
      else closePanel();
    });

    showPanel('setup', form);
    goal.focus();
  }

  function openReviewOrNothing() {
    if (lastRun?.reviewable) return openReview();
    return null;
  }

  // ---- review ------------------------------------------------------------

  async function openReview() {
    host.keyboard?.(true);
    const { reviews = [], error: failed } = await api.review();
    const byId = new Map((lastRun?.workers ?? []).map((w) => [w.id, w]));
    const landed = new Map((lastRun?.merges ?? []).map((m) => [m.branch, m]));
    const root = el('div', 'review');
    root.append(el('div', 'panel__title', `Review · ${lastRun?.repo ?? ''}`));
    if (failed) root.append(el('div', 'panel__error', failed));

    // Merge is per worker: a finished worker's branch can land while others
    // still run, and each lands as its own merge commit.
    for (const r of reviews) root.append(reviewCard(r, byId.get(r.id), landed.get(r.branch)));

    const actions = el('div', 'panel__actions');
    actions.append(button('Close', '', closePanel));
    root.append(actions);
    showPanel('review', root);
  }

  function reviewCard(r, worker, landed) {
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
    add('snapshot', r.snapshot?.sha ? `${r.snapshot.sha.slice(0, 10)} · ${time(r.snapshot.at)}` : 'not snapshotted yet');
    if (!r.test?.command) add('tests', r.snapshot ? 'no test command set' : '—', 'is-muted');
    else if (r.test.running) add('tests', `${r.test.command} · running…`);
    else {
      const verdict = r.test.passed ? 'passed' : r.test.timedOut ? 'timed out' : `failed (exit ${r.test.exitCode})`;
      add('tests', `${r.test.command} · ${verdict} · ${time(r.test.finishedAt)}`, r.test.passed ? 'is-pass' : 'is-fail');
    }
    card.append(prov);
    if (r.test?.tail && r.test.passed === false) {
      const out = el('details', 'review__tail');
      out.append(el('summary', null, 'test output'), el('pre', null, r.test.tail));
      card.append(out);
    }

    const acks = [];
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
          acks.push(box);
          ack.append(box, el('span', null, `${reason} — merge it anyway`));
          line.append(ack);
        }
        block.append(line);
      }
      return block;
    };
    card.append(list('Edits', r.edits), list('New files', r.added));

    const foot = el('div', 'review__foot');
    const result = el('div', 'panel__error');
    // The changes themselves, not just their names: the reviewed commit's
    // diff in a terminal, next to whatever Merge is offering.
    const inTerminal = r.sha
      ? button('Review in terminal', '', async () => {
          const outcome = await api.reviewInTerminal(r.branch, r.sha);
          if (outcome?.error) {
            result.className = 'panel__error';
            result.textContent = outcome.error;
          }
        })
      : null;
    if (landed) {
      result.className = 'panel__ok';
      result.textContent = `merged @ ${landed.sha.slice(0, 7)} · ${time(landed.at)}`;
      foot.append(result);
      if (inTerminal) foot.append(el('div', 'footer__spacer'), inTerminal);
    } else if (worker?.state !== 'done' || !r.snapshot || r.test?.running) {
      foot.append(el('div', 'review__none', `${r.id} is ${worker?.state ?? 'not ready'} — it can merge once it has finished and been tested`));
      if (inTerminal) foot.append(el('div', 'footer__spacer'), inTerminal);
    } else {
      const merge = button(`Merge ${r.id}`, 'btn--accent', async () => {
        merge.disabled = true;
        result.className = 'panel__error';
        const outcome = await api.merge({
          reviewed: [{ branch: r.branch, sha: r.sha }],
          acknowledged: acks.filter((b) => b.checked).map((b) => b.dataset.ack),
        });
        if (outcome?.error) {
          const files = (outcome.flagged ?? []).map((f) => `${f.worker}:${f.file}`).join(', ');
          result.textContent = files ? `${outcome.error}: ${files}` : outcome.error;
          merge.disabled = false;
          return;
        }
        const [m] = outcome.merged;
        result.className = 'panel__ok';
        result.textContent = `merged @ ${m.sha.slice(0, 7)} · ${time(m.at)}`;
        merge.remove();
      });
      merge.dataset.merge = r.id;
      foot.append(result, el('div', 'footer__spacer'), ...(inTerminal ? [inTerminal] : []), merge);
    }
    card.append(foot);
    return card;
  }

  // ---- the tree ----------------------------------------------------------

  function noteFinished(run, now) {
    for (const w of run.workers) {
      const before = seenState.get(w.id);
      if (before && before !== 'done' && w.state === 'done') {
        const name = truncate(plain(w.task), 40);
        flash = { text: `${w.id} finished: ${name}`, until: now + 2600 };
      }
      seenState.set(w.id, w.state);
    }
    if (flash && now >= flash.until) flash = null;
  }

  function pillModel(run, now = Date.now()) {
    const flashing = flash && now < flash.until;
    const aggregate = flashing
      ? 'done'
      : run.workers.some((w) => w.state === 'errored')
      ? 'errored'
      : run.question
        ? 'waiting'
        : run.ready
        ? 'done'
        : 'working';
    return {
      aggregate,
      activeWorkers: run.activeWorkers,
      repo: run.repo,
      sentence: flashing ? flash.text : run.sentence,
      tasks: run.workers,
      model: run.model,
      time: formatElapsed(run.elapsedMs / 1000),
      orchestrator: { state: run.orchestrator.state, summary: run.orchestrator.summary },
      workers: run.workers.map((w) => ({
        ...w,
        summary: w.question ? `Asks: ${w.question}` : w.test?.running ? 'running the tests' : w.summary,
        flash: Boolean(w.finishedAt && now - w.finishedAt < 1600),
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
    showQuestion(active ? run.question : null);
    escalateQuestion(active ? run.question : null);
    if (active) noteFinished(run, Date.now());
    if (!active) {
      treeEl.textContent = '';
      drawn = '';
      lineEl = null;
      lineRoller = null;
      seenState.clear();
      flash = null;
      return;
    }
    const model = pillModel(run);
    // The clock ticks every second and is patched in place; only a change in
    // what the tree says is a reason to rebuild it.
    const signature = JSON.stringify([{ ...model, time: null }, run.ready, run.stopped, run.merges.length]);
    if (signature === drawn || pressed) {
      const clock = treeEl.querySelector('.hdr .eta');
      if (clock && clock.textContent !== model.time) clock.textContent = model.time;
      return;
    }
    drawn = signature;
    treeEl.textContent = '';

    const pill = orchestratorPill(model);
    // Keep one collapsed line across rebuilds, and let the roller decide when
    // what it says changes.
    const fresh = pill.querySelector('.hdr');
    const lineKey = JSON.stringify([model.aggregate, model.sentence, model.repo, model.model, model.tasks.map((t) => t.state)]);
    if (!lineEl) {
      lineEl = fresh;
      lineRoller = createRoller(lineEl.querySelector('.drum'));
      lineRoller.change(lineKey, () => {});
    } else {
      pill.replaceChild(lineEl, fresh);
      lineRoller.change(lineKey, () => {
        lineEl.querySelector('.hdr__badge').replaceWith(fresh.querySelector('.hdr__badge'));
        lineEl.querySelector('.face:not(.face--old)').replaceChildren(...fresh.querySelector('.face').childNodes);
      });
      const clock = lineEl.querySelector('.eta');
      if (clock) clock.textContent = model.time;
    }
    // The footer the view draws is generic; these are the actions this run has.
    const footer = pill.querySelector('.footer');
    footer.textContent = '';
    if (run.stopped || run.merges.length) footer.append(button('Close run', '', () => api.close()));
    else footer.append(holdToStop());
    footer.append(el('div', 'footer__spacer'));
    const review = button(run.ready ? 'Review and merge' : 'Review', 'btn--accent', openReview);
    review.disabled = !run.reviewable;
    footer.append(review);
    treeEl.append(pill);
  }

  function escalateQuestion(q) {
    if (!q) {
      questionSince = null;
      questionEl.classList.remove('is-esc-2', 'is-esc-3');
      return;
    }
    if (questionSince == null) questionSince = q.at ?? Date.now();
    const stage = escalationStage(Date.now() - questionSince);
    questionEl.classList.toggle('is-esc-2', stage === 2);
    questionEl.classList.toggle('is-esc-3', stage === 3);
  }
  questionEl.addEventListener('pointerenter', () => {
    if (questionSince != null) questionSince = Date.now();
  });

  // A worker's question, passed up by the orchestrator with its reason and
  // what it would suggest. Chips fill the reply; Send is the answer.
  function showQuestion(q) {
    const key = q ? `${q.at}:${q.question}` : null;
    if (key === asked) return;
    asked = key;
    questionEl.textContent = '';
    questionEl.hidden = !q;
    if (!q) {
      if (!panelKind) host.keyboard?.(false);
      return;
    }
    const head = el('div', 'question__head');
    head.append(el('span', 'badge is-waiting', '?'), el('span', 'question__who', `${q.worker ?? 'A worker'} asks`));
    questionEl.append(head, el('div', 'question__text', q.question));
    if (q.reason) questionEl.append(el('div', 'question__meta', `Orchestrator: ${q.reason}`));
    if (q.suggestion) questionEl.append(el('div', 'question__meta', `Suggests: ${q.suggestion}`));

    const reply = el('input', 'setup__repo question__reply');
    reply.placeholder = 'Your answer';
    reply.addEventListener('focus', () => host.keyboard?.(true));
    const chipRow = el('div', 'chips');
    const choices = [...q.options];
    if (q.suggestion && !choices.includes(q.suggestion)) choices.unshift(q.suggestion);
    for (const option of choices) chipRow.append(button(option, 'chip-btn question__chip', () => (reply.value = option)));
    const status = el('div', 'panel__error');
    const send = button('Send', 'btn--accent', async () => {
      if (!reply.value.trim()) return;
      send.disabled = true;
      const outcome = await api.answer(reply.value.trim());
      if (outcome?.error) {
        status.textContent = outcome.error;
        send.disabled = false;
      }
    });
    reply.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') send.click();
    });
    const row = el('div', 'panel__actions');
    row.append(reply, send);
    questionEl.append(chipRow, row, status);
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

  treeEl.addEventListener('click', (event) => {
    const row = event.target.closest('.row--worker');
    if (row?.dataset.worker) openLog(row.dataset.worker);
  });

  function closeLog() {
    clearInterval(logTimer);
    logTimer = null;
    logFor = null;
    logEl.hidden = true;
    logEl.textContent = '';
  }

  function openLog(id) {
    if (logFor === id) return closeLog();
    closeLog();
    logFor = id;
    logAfter = 0;
    const head = el('div', 'logpanel__head');
    const title = el('div', 'logpanel__title', id);
    const meta = el('div', 'logpanel__meta', '');
    const take = el('button', 'btn btn--accent', 'Take over');
    take.type = 'button';
    const close = button('\u00d7', 'logpanel__close', closeLog);
    head.append(title, meta, el('div', 'footer__spacer'), take, close);
    const body = el('div', 'logpanel__body');
    const note = el('div', 'panel__error');
    logEl.append(head, body, note);
    logEl.hidden = false;

    // Take over is a hand-off: two clicks, the second one says what happens.
    let armed = false;
    take.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        take.textContent = 'Stop it and open in Terminal';
        return;
      }
      take.disabled = true;
      const outcome = await api.takeOver(id);
      note.className = outcome?.error ? 'panel__error' : 'panel__ok';
      note.textContent = outcome?.error ?? 'Opened in Terminal. The orchestrator will leave it alone; its branch is yours to finish and merge.';
    });

    async function poll() {
      if (logFor !== id) return;
      const res = await api.log(id, logAfter);
      if (logFor !== id || res?.error) return;
      meta.textContent = `${res.branch} \u00b7 ${res.state}`;
      take.disabled = res.state === 'taken over' || res.state === 'queued';
      if (res.state === 'taken over' && !note.textContent) note.textContent = 'Taken over: it runs in your terminal now.';
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
      for (const item of res.items) {
        const line = el('div', `logline logline--${item.kind}${item.error ? ' is-error' : ''}`, item.text);
        body.append(line);
        logAfter = item.seq;
      }
      // Follow the tail unless you've scrolled up to read.
      if (atBottom && res.items.length) body.scrollTop = body.scrollHeight;
    }
    void poll();
    logTimer = setInterval(poll, 1000);
  }

  api.onOpen(() => (panelKind ? closePanel() : openSetup()));

  return { update, open: openSetup, review: openReview };
}
