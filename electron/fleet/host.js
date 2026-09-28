// pilld's hold on a v4 fleet: the fleet itself, the control socket its
// sessions' relays call (routed by token), the enforcement socket its hooks
// ask, and the records recovery reads if pilld is killed.
//
// The user's actions come in here and nowhere else: answering a question
// card, building the merge queue, and the click that merges staging.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CONTROL_PATH } from '../orchestrator/control.js';
import { createRecorder, runRecord, RUNS_DIR } from '../orchestrator/recovery.js';
import { Fleet } from './fleet.js';

export const ENFORCE_PATH = join(CONTROL_PATH, '..', 'enforce.sock');

// `power` is Electron's powerMonitor in pilld (anything with on/off for
// 'suspend' and 'resume'): system sleep stops the leases' clock.
export function createFleetHost({ controlPath = CONTROL_PATH, enforcePath = ENFORCE_PATH, runsDir = RUNS_DIR, onChange = () => {}, power = null } = {}) {
  let fleet = null;
  const onSuspend = () => fleet?.sleep();
  const onResume = () => fleet?.wake();
  power?.on('suspend', onSuspend);
  power?.on('resume', onResume);
  const recorders = new Map();

  function record(fleetNow) {
    // The hypervisor, as a run with no repo and no workers of its own.
    const hv = { id: `${fleetNow.id}-H`, repo: null, workers: [], startedAt: fleetNow.startedAt };
    const entries = [[hv.id, () => runRecord(hv, { orchestrator: fleetNow.hypervisor })]];
    for (const o of fleetNow.orchestrators.values()) entries.push([o.run.id, () => runRecord(o.run, { orchestrator: o.session })]);
    for (const [id, snapshot] of entries) {
      if (!recorders.has(id)) {
        const dir = join(runsDir, id);
        recorders.set(id, { dir, recorder: createRecorder(dir, snapshot), ready: mkdir(dir, { recursive: true, mode: 0o700 }) });
      }
      const r = recorders.get(id);
      void r.ready.then(() => r.recorder.schedule());
    }
  }

  async function start(config) {
    if (fleet && !fleet.stopped) return { error: 'a fleet is already running; stop it first' };
    if (!config.goals?.length) return { error: 'no goals' };
    fleet = new Fleet({ ...config, controlPath, enforcePath });
    fleet.startedAt = Date.now();
    fleet.on('change', () => {
      record(fleet);
      onChange();
    });
    const out = await fleet.start();
    record(fleet);
    return out;
  }

  // What control.js and the enforcement server ask for.
  function current() {
    return fleet && !fleet.stopped ? fleet : null;
  }

  // The user's click. Nothing else sets the approval, and it lasts one call.
  // `override` ({ reason }) is its own, separate choice: merging entries
  // whose tests failed.
  async function approve(repo, { upTo, sha, override = null }) {
    const q = fleet?.queues.get(repo);
    if (!q) return { error: 'nothing is queued for that repo' };
    q.userApprovedMerge = true;
    try {
      return await fleet.approveQueue(repo, { upTo, sha, override });
    } finally {
      q.userApprovedMerge = false;
    }
  }

  function reject(repo, id, reason) {
    return fleet ? fleet.rejectEntry(repo, id, reason) : { error: 'no fleet' };
  }

  async function build(repo) {
    const q = fleet?.queues.get(repo);
    if (!q) return { error: 'nothing is queued for that repo' };
    return q.build();
  }

  async function close({ stop = true } = {}) {
    if (!fleet) return;
    if (stop) fleet.stop();
    await fleet.close();
    for (const [id, r] of recorders) {
      const final = id.endsWith('-H')
        ? runRecord({ id, repo: null, workers: [] }, { closed: true, orchestrator: fleet.hypervisor })
        : runRecord([...fleet.orchestrators.values()].find((o) => o.run.id === id)?.run ?? { id, workers: [] }, { closed: true });
      await r.ready.then(() => r.recorder.close(final)).catch(() => {});
    }
    recorders.clear();
    power?.off('suspend', onSuspend);
    power?.off('resume', onResume);
    onChange();
  }

  return {
    start,
    current,
    approve,
    reject,
    build,
    answer: (card, text) => fleet?.answerHuman(card, text) ?? { error: 'no fleet' },
    questions: () => fleet?.humanQueue() ?? [],
    view: () => fleet?.listOrchestrators() ?? null,
    decisions: () => fleet?.decisions.list() ?? [],
    pauseAll: () => fleet?.pauseAll('user'),
    stop: () => fleet?.stop(),
    close,
    get fleet() {
      return fleet;
    },
  };
}
