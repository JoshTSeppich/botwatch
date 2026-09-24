// The orchestrator's MCP tools, as pilld carries them out. mcp.js only relays:
// the run lives here, in the same process as the pill, so the model and the
// user act on one run — and only the user's click, which never passes through
// here, can approve a merge.

import * as policy from './policy.js';
import * as worktrees from './worktrees.js';

export const TOOLS = [
  ['spawn_worker', 'Start a worker on a task in its own git worktree.', { task: 'string', model: 'string' }],
  ['list_workers', 'Every worker with its state, branch, tokens and summary.', {}],
  ['wait_for', 'Wait until the given workers reach a state.', { ids: 'array', until: 'string' }],
  ['read_worker', 'The latest summary and state for one worker.', { id: 'string' }],
  ['message_worker', 'Send a message to a running worker.', { id: 'string', text: 'string' }],
  ['worker_diff', 'Lines added and removed on a worker branch.', { id: 'string' }],
  ['stop_worker', 'Stop a worker.', { id: 'string' }],
  ['ask_human', 'Put a question to the user through the pill.', { question: 'string', options: 'array' }],
  ['merge_worktrees', 'Merge worker branches. Only the user can, by clicking Merge in the pill.', { order: 'array' }],
];

export async function call(run, name, args = {}) {
  if (name === 'spawn_worker') return run.spawn(args.task, args.model ?? run.model, args.permissionMode);
  if (name === 'list_workers') return run.list();
  if (name === 'read_worker') return run.find(args.id) ? run.list().find((w) => w.id === args.id) : { error: 'no such worker' };
  if (name === 'stop_worker') {
    run.find(args.id)?.stop();
    run.drain();
    return { stopped: args.id };
  }
  if (name === 'message_worker') {
    const worker = run.find(args.id);
    if (!worker) return { error: 'no such worker' };
    // A released worker cannot be reached. Say so plainly rather than
    // reporting a quiet false the model has to interpret.
    const delivered = worker.message(args.text);
    return delivered ? { delivered: true } : { error: `worker ${args.id} has been released; spawn a new one` };
  }
  if (name === 'worker_diff') {
    const worker = run.find(args.id);
    if (!worker) return { error: 'no such worker' };
    return worktrees.diff(worker.cwd, worker.base ?? 'main');
  }
  if (name === 'ask_human') return run.ask(args.question, args.options ?? []);
  if (name === 'wait_for') return waitFor(run, args.ids ?? [], args.until ?? 'done');
  if (name === 'merge_worktrees') {
    // Never merges, even after the click: merging is the pill's job, done with
    // the review the user actually looked at. The model is told plainly, so it
    // stops asking instead of retrying.
    const verdict = policy.canMerge(run.state);
    return verdict.ok
      ? { error: 'the user merges from the pill, after reviewing each branch; there is nothing for you to do' }
      : { error: verdict.reason };
  }
  return { error: `unknown tool ${name}` };
}

export function waitFor(run, ids, until) {
  return new Promise((resolve) => {
    const settled = () =>
      ids.every((id) => {
        const worker = run.find(id);
        return !worker || worker.state === until || ['done', 'errored', 'stopped'].includes(worker.state);
      });
    if (settled()) return resolve(run.list().filter((w) => ids.includes(w.id)));
    const check = () => {
      if (!settled()) return;
      run.off('change', check);
      resolve(run.list().filter((w) => ids.includes(w.id)));
    };
    run.on('change', check);
  });
}
