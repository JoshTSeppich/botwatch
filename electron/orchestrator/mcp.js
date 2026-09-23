#!/usr/bin/env node
// The MCP server attached to the orchestrator session, and only to it.
//
// These tools are the orchestrator's controls. Every one of them goes through
// run.js, which asks policy.js first — so the limits hold whether the call came
// from a careful model or a confused one.
//
// Plain JSON-RPC over stdio. An SDK would be a dependency for about sixty lines
// of framing.

import { createInterface } from 'node:readline';

import { Run } from './run.js';
import * as policy from './policy.js';
import * as worktrees from './worktrees.js';

const config = JSON.parse(process.env.BOTWATCH_RUN ?? '{}');
const run = new Run({
  repo: config.repo ?? process.cwd(),
  goal: config.goal ?? '',
  model: config.model ?? 'sonnet',
  maxWorkers: config.maxWorkers ?? 2,
  budgetTokens: config.budgetTokens ?? 1_000_000,
  permissionCeiling: config.permissionCeiling ?? 'default',
});

const TOOLS = [
  ['spawn_worker', 'Start a worker on a task in its own git worktree.', { task: 'string', model: 'string' }],
  ['list_workers', 'Every worker with its state, branch, tokens and summary.', {}],
  ['wait_for', 'Wait until the given workers reach a state.', { ids: 'array', until: 'string' }],
  ['read_worker', 'The latest summary and state for one worker.', { id: 'string' }],
  ['message_worker', 'Send a message to a running worker.', { id: 'string', text: 'string' }],
  ['worker_diff', 'Lines added and removed on a worker branch.', { id: 'string' }],
  ['stop_worker', 'Stop a worker.', { id: 'string' }],
  ['ask_human', 'Put a question to the user through the pill.', { question: 'string', options: 'array' }],
  ['merge_worktrees', 'Merge worker branches. Requires the user to have clicked Merge.', { order: 'array' }],
];

function schema(params) {
  const properties = {};
  for (const [name, type] of Object.entries(params)) properties[name] = { type };
  return { type: 'object', properties, required: Object.keys(params).slice(0, 1) };
}

async function call(name, args) {
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
    return delivered
      ? { delivered: true }
      : { error: `worker ${args.id} has been released; spawn a new one` };
  }
  if (name === 'worker_diff') {
    const worker = run.find(args.id);
    if (!worker) return { error: 'no such worker' };
    return worktrees.diff(worker.cwd, worker.base ?? 'main');
  }
  if (name === 'ask_human') return run.ask(args.question, args.options ?? []);
  if (name === 'wait_for') return waitFor(args.ids ?? [], args.until ?? 'done');
  if (name === 'merge_worktrees') {
    const verdict = policy.canMerge(run.state);
    // The model is told plainly that this is the user's decision, so it stops
    // asking and says so instead of retrying.
    return verdict.ok ? { merged: args.order ?? [] } : { error: verdict.reason };
  }
  return { error: `unknown tool ${name}` };
}

function waitFor(ids, until) {
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

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'botwatch', version: '0.1.0' },
      },
    });
  }
  if (method === 'tools/list') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: TOOLS.map(([name, description, params]) => ({
          name,
          description,
          inputSchema: schema(params),
        })),
      },
    });
  }
  if (method === 'tools/call') {
    const result = await call(params?.name, params?.arguments ?? {}).catch((err) => ({
      error: String(err?.message ?? err),
    }));
    return send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
    });
  }
  if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
});
