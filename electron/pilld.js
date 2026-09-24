// The listening end of bw-hook. Every Claude Code hook writes one JSON line to
// this socket and hangs up; this reads the lines and hands each event to the
// registry. Pure Node, no Electron, so a test can drive it with a real socket.

import { connect, createServer } from 'node:net';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Must match bw-hook's default. BOTWATCH_SOCK overrides both, for tests.
export const SOCKET_PATH = process.env.BOTWATCH_SOCK || join(homedir(), '.claude', 'botwatch', 'pilld.sock');

// A PreToolUse for Write carries the whole file. Past this a line is dropped
// rather than buffered: the registry never needs a payload that size.
const MAX_LINE_BYTES = 4 * 1024 * 1024;

export async function listen(onEvent, path = SOCKET_PATH) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await clearStale(path);

  const server = createServer((socket) => {
    let pending = '';
    let skipping = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      pending += chunk;
      let cut = pending.indexOf('\n');
      while (cut !== -1) {
        const line = pending.slice(0, cut);
        pending = pending.slice(cut + 1);
        if (!skipping) deliver(line, onEvent);
        skipping = false;
        cut = pending.indexOf('\n');
      }
      if (pending.length > MAX_LINE_BYTES) {
        pending = '';
        skipping = true;
      }
    });
    // bw-hook writes and closes; a line without its newline is still a line.
    socket.on('end', () => {
      if (pending && !skipping) deliver(pending, onEvent);
      pending = '';
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
  // Anything that can write here can tell the pill a session needs you.
  await chmod(path, 0o600).catch(() => {});
  return server;
}

function deliver(line, onEvent) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  onEvent(event, Date.now());
}

// A socket file outlives a crashed daemon. If something answers on it, another
// BotWatch owns it and this one must not steal it; if nothing does, it is
// debris.
async function clearStale(path) {
  const answered = await new Promise((resolve) => {
    const probe = connect(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
  if (answered) throw new Error(`another pilld is listening on ${path}`);
  await unlink(path).catch(() => {});
}
