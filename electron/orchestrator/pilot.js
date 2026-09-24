// The live orchestrator run, held by pilld in the main process.
//
// The setup panel starts it, the MCP relay drives it through control.js, and
// the review panel is the only thing that can approve a merge. Holding the run
// here rather than in the MCP server is what lets the pill and the model act on
// the same one.

import { execFile as execFileCb } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import * as budget from './budget.js';
import { CONTROL_PATH, newToken } from './control.js';
import { clampPermission } from './policy.js';
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
    });
    run.id = `${Date.now().toString(36)}`;
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
      if (run.budgetExhausted) run.pauseAll('budget');
      onChange();
    });
    orchestrator.on('change', onChange);
    run.on('change', onChange);

    live = { run, token, orchestrator, startedAt: Date.now(), closed: false };
    orchestrator.start();
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
    onChange();
  }

  function view(now = Date.now()) {
    return live ? runView(live, now) : null;
  }

  return { start, current, review, merge, stop, close, view };
}

const TERMINAL = new Set(['done', 'errored', 'stopped']);

// Everything the tree and the review button need, as plain data. Pure, so the
// sentence and the readiness rule are testable without a process.
export function runView({ run, orchestrator, startedAt, closed }, now) {
  const workers = run.workers.map((w) => ({
    id: w.id,
    task: w.task,
    state: w.state === 'running' ? 'running' : w.state,
    summary: w.summary ?? w.task,
    branch: w.branch,
    model: w.model,
    tokens: w.tokens ?? 0,
    progress: TERMINAL.has(w.state) ? 1 : 0.5,
    snapshot: w.snapshot ?? null,
    test: w.test ?? null,
  }));
  const done = workers.filter((w) => TERMINAL.has(w.state)).length;
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
    stopped: run.stopped,
    orchestrator: {
      state: orchestrator.state === 'running' ? 'working' : orchestrator.state,
      summary: orchestrator.summary ?? 'planning the work',
    },
    workers,
    activeWorkers: workers.filter((w) => w.state === 'running').length,
    sentence: ready
      ? `Ready to review · ${workers.length} branch${workers.length === 1 ? '' : 'es'}`
      : workers.length
        ? `${done} of ${workers.length} tasks done`
        : 'Planning the work',
    ready,
    budget: {
      used: spent,
      limit: run.ledger.limitTokens,
      projected: budget.projected(run.ledger, done, workers.length),
    },
    merges: run.merges,
    elapsedMs: now - startedAt,
  };
}
