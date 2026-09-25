// A stand-in for BotWatch's main process holding a v4 fleet: the same host,
// control socket and enforcement socket, without the window.
// tools/it-fleet-recovery.mjs starts it, lets the fleet get going, and kills
// it with SIGKILL, which is the point.
//
//   node tools/it-fleet-host.mjs <repo> <sockDir> <runsDir> <fleetDir>
//
// Prints one JSON line per second: every session with its pid.

import { join } from 'node:path';

import { serveControl } from '../electron/orchestrator/control.js';
import { serveEnforcement } from '../electron/fleet/enforce-server.js';
import { createFleetHost } from '../electron/fleet/host.js';

const [repo, sockDir, runsDir, dir] = process.argv.slice(2);
const controlPath = join(sockDir, 'control.sock');
const enforcePath = join(sockDir, 'enforce.sock');
const host = createFleetHost({ controlPath, enforcePath, runsDir });
await serveControl(() => host.current(), controlPath);
await serveEnforcement(() => host.current(), enforcePath);
const long = (what, prefix) =>
  `${what} Claim only src/${prefix}/**. Start two workers at once, each told: "Create src/${prefix}/<yourname>N.js for N from 1 to 200, one file at a time with the Write tool, each exporting N." Then wait for them.`;
const started = await host.start({
  id: `kill${Date.now().toString(36)}`,
  goals: [
    { id: 'g1', priority: 1, repo, goal: long('Number files, part one.', 'one') },
    { id: 'g2', priority: 2, repo, goal: long('Number files, part two.', 'two') },
  ],
  budgetTokens: 3_000_000,
  maxSessions: 7,
  permissionCeiling: 'acceptEdits',
  model: 'haiku',
  dir,
});
if (started.error) {
  console.log(JSON.stringify({ error: started.error }));
  process.exit(1);
}

setInterval(() => {
  const f = host.fleet;
  const sessions = [{ id: 'H', level: 'hypervisor', pid: f.hypervisor?.child?.pid ?? null, state: f.hypervisor?.state }];
  for (const o of f.orchestrators.values()) {
    sessions.push({ id: o.id, level: 'orchestrator', pid: o.session?.child?.pid ?? null, state: o.session?.state });
    for (const w of o.run.workers) sessions.push({ id: `${o.id}/${w.id}`, level: 'worker', pid: w.child?.pid ?? null, state: w.state, branch: w.branch, cwd: w.cwd });
  }
  console.log(JSON.stringify({ pid: process.pid, fleet: f.id, sessions }));
}, 1000);
