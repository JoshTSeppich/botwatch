// The orchestrator's line into pilld. mcp.js connects here and relays each
// tool call; pilld answers from the run it holds.
//
// One JSON request per line, one JSON response per line, matched by id. Every
// request carries the run's token, which only the orchestrator's MCP server
// is given, so a worker that finds the socket still cannot drive the run.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { call } from './tools.js';

export const CONTROL_PATH =
  process.env.BOTWATCH_CONTROL_SOCK || join(homedir(), '.claude', 'botwatch', 'control.sock');

export function newToken() {
  return randomBytes(24).toString('hex');
}

function sameToken(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

// `current()` returns { run, token } for the live run, or null. Looked up per
// request, so a run can start and end without restarting the socket.
export async function serveControl(current, path = CONTROL_PATH) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await clearStale(path);

  const server = createServer((socket) => {
    let pending = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      pending += chunk;
      let cut = pending.indexOf('\n');
      while (cut !== -1) {
        const line = pending.slice(0, cut);
        pending = pending.slice(cut + 1);
        void answer(line, current, socket);
        cut = pending.indexOf('\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(path, 0o600).catch(() => {});
  return server;
}

async function answer(line, current, socket) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const live = current();
  let result;
  if (!live) result = { error: 'no orchestrator run is active in BotWatch' };
  else if (!sameToken(request.token, live.token)) result = { error: 'not this run' };
  else {
    result = await call(live.run, request.tool, request.args ?? {}).catch((err) => ({
      error: String(err?.message ?? err),
    }));
  }
  if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
}

// A socket that answers belongs to a running BotWatch; one that does not is
// left over from a crash.
async function clearStale(path) {
  const answered = await new Promise((resolve) => {
    const probe = connect(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
  if (answered) throw new Error(`another BotWatch is serving ${path}`);
  await unlink(path).catch(() => {});
}

// The client half, for mcp.js. One connection, requests multiplexed by id,
// because wait_for can be outstanding for minutes while other calls go by.
export function controlClient(path, token, onClose = null) {
  const socket = connect(path);
  const waiting = new Map();
  let nextId = 1;
  let pending = '';
  let failure = null;
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    pending += chunk;
    let cut = pending.indexOf('\n');
    while (cut !== -1) {
      const line = pending.slice(0, cut);
      pending = pending.slice(cut + 1);
      try {
        const { id, result } = JSON.parse(line);
        waiting.get(id)?.(result);
        waiting.delete(id);
      } catch {
        // A line that isn't a response has nobody to go to.
      }
      cut = pending.indexOf('\n');
    }
  });
  const fail = (reason) => {
    failure = reason;
    for (const resolve of waiting.values()) resolve({ error: reason });
    waiting.clear();
  };
  socket.on('error', () => fail('BotWatch is not running, so the run it held is gone'));
  socket.on('close', () => {
    fail('BotWatch closed the connection');
    onClose?.();
  });

  return {
    call(tool, args) {
      if (failure) return Promise.resolve({ error: failure });
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        socket.write(`${JSON.stringify({ id, token, tool, args })}\n`);
      });
    },
    close: () => socket.destroy(),
  };
}
