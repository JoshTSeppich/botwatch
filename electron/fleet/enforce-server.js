// pilld's side of the enforcement hook: "may this session use a tool?" and
// "may it write this path?", answered from the fleet's live state. Read-only: it
// changes nothing, so a forged question gets an answer and nothing more.
// 0600 in BotWatch's own directory, where a worker's sandbox can't reach.

import { chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname } from 'node:path';

export async function serveEnforcement(fleetOf, path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await unlink(path).catch(() => {});
  const server = createServer((socket) => {
    let pending = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      pending += chunk;
      const cut = pending.indexOf('\n');
      if (cut === -1) return;
      let answer;
      try {
        const q = JSON.parse(pending.slice(0, cut));
        const fleet = fleetOf();
        answer = !fleet ? { ok: false, reason: 'no fleet is running' } : q.path ? fleet.mayWrite(q.session, q.path) : fleet.mayUse(q.session);
      } catch (err) {
        answer = { ok: false, reason: `could not decide: ${String(err?.message ?? err)}` };
      }
      socket.end(`${JSON.stringify(answer)}\n`);
    });
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
