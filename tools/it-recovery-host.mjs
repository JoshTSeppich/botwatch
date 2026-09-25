// A stand-in for BotWatch's main process: the same pilot and control socket,
// without the window. tools/it-recovery.mjs starts it, lets a run get going,
// and kills it with SIGKILL, which is the point.
//
//   node tools/it-recovery-host.mjs <repo> <control.sock> <goal>
//
// Prints one JSON line per second: the run's workers with their pids.

import { serveControl } from '../electron/orchestrator/control.js';
import { createPilot } from '../electron/orchestrator/pilot.js';

const [repo, controlPath, goal] = process.argv.slice(2);
const pilot = createPilot({ controlPath });
await serveControl(pilot.current, controlPath);
const started = await pilot.start({
  repo,
  goal,
  model: 'haiku',
  maxWorkers: 2,
  budgetTokens: 2_000_000,
  permissionCeiling: 'acceptEdits',
  testCommand: 'npm test',
});
if (started.error) {
  console.log(JSON.stringify({ error: started.error }));
  process.exit(1);
}

setInterval(() => {
  const view = pilot.view();
  const live = pilot.current();
  console.log(
    JSON.stringify({
      id: started.id,
      workers: live.run.workers.map((w) => ({ id: w.id, state: w.state, pid: w.child?.pid ?? null, branch: w.branch, cwd: w.cwd })),
      orchestratorState: view.orchestrator.state,
    }),
  );
}, 1000);
