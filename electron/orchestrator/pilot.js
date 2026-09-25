// The live orchestrator run, held by pilld in the main process.
//
// The setup panel starts it, the MCP relay drives it through control.js, and
// the review panel is the only thing that can approve a merge. Holding the run
// here rather than in the MCP server is what lets the pill and the model act on
// the same one.

import { execFile as execFileCb } from 'node:child_process';
import { saveLimits } from './limits.js';
import { logSince } from './log.js';
import { trustFolder } from './trust.js';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import * as budget from './budget.js';
import { CONTROL_PATH, newToken } from './control.js';
import { clampPermission } from './policy.js';
import { createRecorder, runRecord } from './recovery.js';
import { Run } from './run.js';
import { scriptCommand } from './runtime.js';
import { Worker } from './worker.js';

const execFile = promisify(execFileCb);

export const ORCHESTRATOR_BRIEF = (maxWorkers) =>
  [
    'You are the BotWatch orchestrator. Your only tools are the botwatch MCP tools.',
    `Split the goal into independent tasks, at most ${maxWorkers} running at once, and start one worker per task with spawn_worker.`,
    'Then call wait_for with every worker id. When they are done, check each with worker_diff and read_worker.',
    'If a worker failed, you may message_worker it once with what to fix, then wait_for it again.',
    "If a worker is asking (state 'asking', its question in the list), answer it with message_worker if the goal settles it.",
    'If it does not, call ask_human with the question, the worker id, why you are passing it up, and the answer you would suggest.',
    'ask_human returns the user\'s answer: send it to that worker with message_worker, then wait_for again. The other workers carry on meanwhile.',
    'Do not finish while any worker is asking.',
    'You cannot edit files, run commands or merge. The user reviews every branch in the BotWatch pill and merges from there.',
    'Finish with one short line per worker saying what it did.',
    '',
    'The goal:',
  ].join('\n');

export function createPilot({ onChange = () => {}, controlPath = CONTROL_PATH } = {}) {
  let live = null;

  async function start(config) {
    if (live && !live.closed) return { error: 'a run is already going; stop it first' };
    const repo = await execFile('git', ['-C', config.repo, 'rev-parse', '--show-toplevel'])
      .then(({ stdout }) => stdout.trim())
      .catch(() => null);
    if (!repo) return { error: `${config.repo} is not a git repository` };
    if (!String(config.goal ?? '').trim()) return { error: 'the goal is empty' };

    const run = new Run({
      repo,
      goal: config.goal,
      model: config.model,
      maxWorkers: config.maxWorkers,
      budgetTokens: config.budgetTokens,
      permissionCeiling: config.permissionCeiling,
      testCommand: config.testCommand || null,
      allowInstalls: config.allowInstalls === true,
    });
    run.id = `${Date.now().toString(36)}`;
    run.startedAt = Date.now();
    await run.arm();

    const token = newToken();
    const spec = run.launchSpec();
    await mkdir(spec.cwd, { recursive: true, mode: 0o700 });
    const mcp = scriptCommand(new URL('./mcp.js', import.meta.url));
    const mcpConfig = join(spec.cwd, 'mcp.json');
    await writeFile(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          botwatch: {
            command: mcp.command,
            args: mcp.args,
            env: { ...mcp.env, BOTWATCH_RUN_TOKEN: token, BOTWATCH_CONTROL_SOCK: controlPath },
          },
        },
      }),
      { mode: 0o600 },
    );
    await chmod(mcpConfig, 0o600);

    const orchestrator = new Worker({
      id: 'O',
      task: config.goal,
      cwd: spec.cwd,
      model: config.model,
      permissionMode: clampPermission('default', config.permissionCeiling),
      protect: [repo],
      brief: ORCHESTRATOR_BRIEF(config.maxWorkers),
      extraArgs: [
        '--mcp-config',
        mcpConfig,
        '--strict-mcp-config',
        '--allowedTools',
        'mcp__botwatch',
        '--disallowedTools',
        'Bash,Write,Edit,NotebookEdit',
      ],
    });
    orchestrator.on('tokens', (_w, tokens) => {
      budget.record(run.ledger, 'O', tokens);
      if (run.budgetExhausted) {
        run.pauseAll('budget');
        orchestrator.pause();
      }
      onChange();
    });
    // The record a later launch recovers from if this process dies mid-run.
    // Written on every change, at most twice a second, and closed last.
    const recorder = createRecorder(spec.cwd, () => runRecord(run, { orchestrator }));
    const record = () => recorder.schedule();
    orchestrator.on('change', () => {
      relayQuestion(run, orchestrator);
      nudge(run, orchestrator);
      record();
      onChange();
    });
    run.on('change', () => {
      record();
      onChange();
    });
    // Keep the newest measured week for the setup panel's allowance line.
    const keepLimits = (limits) => void saveLimits(limits).catch(() => {});
    run.on('limits', keepLimits);
    orchestrator.on('limits', (_w, limits) => keepLimits(limits));

    live = { run, token, orchestrator, startedAt: Date.now(), closed: false, dir: spec.cwd, recorder };
    orchestrator.start();
    await recorder.now();
    onChange();
    return { ok: true, id: run.id };
  }

  // What control.js needs: the run and the token its relay must present.
  function current() {
    return live && !live.closed ? { run: live.run, token: live.token } : null;
  }

  async function review() {
    if (!live) return { error: 'no run' };
    return { reviews: await live.run.reviewAll() };
  }

  // The click. Approval lasts for this one merge call and no longer, so an
  // MCP call that happens to arrive at the same moment gains nothing.
  async function merge(selection) {
    if (!live) return { error: 'no run' };
    live.run.userApprovedMerge = true;
    try {
      return await live.run.merge(selection);
    } finally {
      live.run.userApprovedMerge = false;
    }
  }

  // The worker's log after entry `after`, for the panel's live tail.
  function log(id, after = 0) {
    const worker = live?.run.find(id);
    if (!worker) return { error: 'no such worker' };
    return { id, state: worker.takenOver ? 'taken over' : worker.state, branch: worker.branch, items: logSince(worker.log, after) };
  }

  // Take over: the worker stops being BotWatch's and becomes yours. The
  // headless process is stopped first and waited for, so two processes never
  // write one session; then the same session is resumed in a terminal, in its
  // worktree. From then on the orchestrator may not message it, and the pill
  // will not merge it: the branch is yours to finish and merge.
  async function takeOver(id, options) {
    if (!live) return { error: 'no run' };
    const outcome = await takeOverWorker(live.run, id, options);
    onChange();
    return outcome;
  }

  // Review in terminal: the exact reviewed commit's diff, in Terminal.
  async function reviewInTerminal(branch, sha, { open = openInTerminal } = {}) {
    if (!live) return { error: 'no run' };
    const built = await live.run.diffCommand(branch, sha, shellQuote);
    if (built.error) return built;
    await open(built.command);
    return { ok: true, command: built.command };
  }

  function answer(text) {
    if (!live) return { error: 'no run' };
    return live.run.answer(text);
  }

  function pauseAll() {
    if (!live || live.closed) return { error: 'no run' };
    live.run.pauseAll('user');
    live.orchestrator.pause();
    onChange();
    return { paused: true };
  }

  function resumeAll() {
    if (!live || live.closed) return { error: 'no run' };
    const out = live.run.resumeAll();
    if (!out.error) live.orchestrator.resume();
    onChange();
    return out;
  }

  function raiseBudget(tokens) {
    if (!live || live.closed) return { error: 'no run' };
    const out = live.run.raiseBudget(tokens);
    onChange();
    return out;
  }

  function stop() {
    if (!live) return;
    live.run.stop();
    live.orchestrator.stop();
    onChange();
  }

  // Ends the run and takes the ref hook back out. Branches and worktrees
  // stay, so nothing a worker did is lost by closing.
  //
  // `stop` is for quitting. Releasing only closes stdin, which lets a session
  // exit after its turn — and an orchestrator waiting on workers that will
  // never report back has no end to its turn. Measured: quitting mid-run left
  // it and its relay orphaned. So a quit stops every process outright.
  async function close({ stop: kill = false } = {}) {
    if (!live) return;
    live.closed = true;
    if (kill) {
      live.run.stop();
      live.orchestrator.stop();
    } else live.orchestrator.release();
    await live.run.close();
    await live.recorder.close(runRecord(live.run, { closed: true, orchestrator: live.orchestrator })).catch(() => {});
    onChange();
  }

  function view(now = Date.now()) {
    return live ? runView(live, now) : null;
  }

  return { start, current, review, merge, reviewInTerminal, answer, log, takeOver, pauseAll, resumeAll, raiseBudget, stop, close, view };
}

const TERMINAL = new Set(['done', 'errored', 'stopped']);

export async function takeOverWorker(run, id, { open = openInTerminal, waitMs = 5000, trust = trustFolder } = {}) {
  const worker = run.find(id);
  if (!worker) return { error: 'no such worker' };
  if (worker.takenOver) return { error: `${id} is already taken over` };
  if (!worker.sessionId) return { error: `${id} has no session yet; wait for it to start` };
  worker.takenOver = true;
  const exited =
    worker.child && worker.child.exitCode === null
      ? new Promise((resolve) => worker.child.once('exit', resolve))
      : Promise.resolve();
  worker.stop();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, waitMs))]);
  run.drain();
  // The click is the consent; without this the session stops at the trust
  // prompt for a folder nobody has opened interactively before.
  const trusted = trust(worker.cwd);
  const command = `cd ${shellQuote(worker.cwd)} && claude --resume ${shellQuote(worker.sessionId)}`;
  await open(command);
  return { ok: true, command, trusted };
}

export function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

// Terminal.app, because it is on every Mac and scriptable. The session opens
// in a new window, in front.
export async function openInTerminal(command) {
  const script = `tell application "Terminal"
  do script ${JSON.stringify(command)}
  activate
end tell`;
  await execFile('osascript', ['-e', script]);
}

// Measured: instead of calling ask_human, an orchestrator ended its own turn
// with 'QUESTION: …', the workers' convention. That is a question passed up
// all the same, so it gets the same card, and the answer goes back to it.
export function relayQuestion(run, orchestrator) {
  if (orchestrator.state !== 'asking' || !orchestrator.question || run.pendingQuestion || run.stopped) return false;
  if (orchestrator.relayed === orchestrator.question) return false;
  orchestrator.relayed = orchestrator.question;
  const worker = run.workers.find((w) => w.state === 'asking');
  void run
    .ask({ question: orchestrator.question, worker: worker?.id ?? null, reason: 'the orchestrator could not settle it itself' })
    .then((reply) => {
      if (reply?.answer != null) orchestrator.message(`The user answered: ${reply.answer}`);
    });
  return true;
}

// Measured: an orchestrator finished its turn with a worker still asking,
// and the question never reached the user. Its turn ending is the moment to
// catch that. One reminder per question, through the orchestrator, because
// worker questions are the orchestrator's to answer or pass up.
export function nudge(run, orchestrator) {
  if (orchestrator.state !== 'done' || run.pendingQuestion || run.stopped) return false;
  const asking = run.workers.find((w) => w.state === 'asking' && w.question && w.nudged !== w.question);
  if (!asking) return false;
  asking.nudged = asking.question;
  return orchestrator.message(
    `Worker ${asking.id} is still asking: "${asking.question}". Answer it with message_worker, or pass it up with ask_human. Then wait_for again. Do not finish while a worker is asking.`,
  );
}

// Everything the tree and the review button need, as plain data. Pure, so the
// sentence and the readiness rule are testable without a process.
export function runView({ run, orchestrator, startedAt, closed }, now) {
  const workers = run.workers.map((w) => ({
    id: w.id,
    task: w.task,
    state: w.takenOver ? 'takenover' : w.state === 'running' ? 'running' : w.state,
    summary: w.summary ?? w.task,
    branch: w.branch,
    model: w.model,
    tokens: w.tokens ?? 0,
    progress: TERMINAL.has(w.state) ? 1 : 0.5,
    snapshot: w.snapshot ?? null,
    test: w.test ?? null,
    question: w.question ?? null,
    // When its turn finished, for the 1.6s row flash and the 2.6s line.
    finishedAt: w.state === 'done' ? w.doneAt ?? null : null,
  }));
  const q = run.pendingQuestion;
  const done = workers.filter((w) => TERMINAL.has(w.state)).length;
  // One finished, snapshotted, tested worker is enough to open the review:
  // merging is per branch.
  const reviewable = workers.some((w) => w.state === 'done' && w.snapshot && !w.test?.running);
  const settled = workers.every((w) => TERMINAL.has(w.state) && w.snapshot && !w.test?.running);
  const ready = workers.length > 0 && settled;
  const spent = run.ledger.spent;
  return {
    closed,
    repo: basename(run.repo),
    repoPath: run.repo,
    goal: run.goal,
    model: run.model,
    testCommand: run.testCommand,
    allowInstalls: run.allowInstalls,
    stopped: run.stopped,
    paused: Boolean(run.paused),
    pauseReason: run.pauseReason ?? null,
    budgetHit: run.budgetExhausted,
    orchestrator: {
      state: q ? 'waiting' : orchestrator.state === 'running' ? 'working' : orchestrator.state,
      summary: q ? `Needs your answer: ${q.worker ?? 'a worker'} asks` : orchestrator.summary ?? 'planning the work',
    },
    // Plain data: the promise machinery stays in pilld.
    question: q
      ? { question: q.question, worker: q.worker, reason: q.reason, suggestion: q.suggestion, options: q.options, at: q.at }
      : null,
    workers,
    activeWorkers: workers.filter((w) => w.state === 'running').length,
    sentence: ready
      ? `Ready to review · ${workers.length} branch${workers.length === 1 ? '' : 'es'}`
      : workers.length
        ? `${done} of ${workers.length} tasks done`
        : 'Planning the work',
    ready,
    reviewable,
    budget: {
      used: spent,
      limit: run.ledger.limitTokens,
      projected: budget.projected(run.ledger, done, workers.length),
    },
    merges: run.merges,
    elapsedMs: now - startedAt,
  };
}
