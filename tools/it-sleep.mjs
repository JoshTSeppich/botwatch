// Integration: a live lease across a real system sleep, with Electron's
// powerMonitor, as pilld has it.
//
//   npx electron tools/it-sleep.mjs <out.json>
//
// Puts the Mac to sleep with `pmset sleepnow` a few seconds in. Wake it by
// hand; the result is written a few seconds after. The lease is real (pilld's
// own object and clock); the sessions are stand-ins, so no model runs while
// the machine sleeps. The lease has 20 seconds left when the machine goes to
// sleep, so a sleep longer than that shows the difference: without the fix
// it would expire on waking.

import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, powerMonitor } from 'electron';

import { createFleetHost } from '../electron/fleet/host.js';

const out = process.argv.at(-1).endsWith('.json') ? process.argv.at(-1) : join(tmpdir(), 'bw-it-sleep.json');

class Idle extends EventEmitter {
  constructor(o) {
    super();
    Object.assign(this, o);
    this.state = 'queued';
  }
  start() {
    this.state = 'running';
  }
  pause() {
    this.state = 'paused';
    return true;
  }
  resume() {
    this.state = 'running';
    return true;
  }
  stop() {
    this.state = 'stopped';
  }
}

class StandInRun extends EventEmitter {
  constructor(o) {
    super();
    Object.assign(this, o);
    this.workers = [];
    this.ledger = { limitTokens: o.budgetTokens, spent: 0 };
    this.limits = { maxWorkers: o.maxWorkers };
  }
  pauseAll() {}
  drain() {}
  list() {
    return [];
  }
  stop() {}
  async close() {}
}

const stamp = (t) => new Date(t).toISOString();

app.whenReady().then(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-it-sleep-'));
  const host = createFleetHost({ controlPath: join(dir, 'c.sock'), enforcePath: join(dir, 'e.sock'), runsDir: join(dir, 'runs'), power: powerMonitor });
  await host.start({ id: 'sleep', goals: [{ id: 'g1', goal: 'x', repo: dir, priority: 1 }], budgetTokens: 100_000, maxSessions: 3, dir: join(dir, 'fleet'), session: (o) => new Idle(o), run: (o) => new StandInRun(o) });
  const fleet = host.fleet;
  // The lease outlasts the lead-in by 20 seconds: any sleep longer than
  // that would expire it on waking, were the time asleep counted.
  const lead = Number(process.env.SLEEP_AFTER_MS) || 5000;
  await fleet.spawnOrchestrator({ goal: 'g1', brief: 'b', tokens: 10_000, slots: 1, expires: (lead + 20_000) / 60_000 });
  const lease = fleet.leases.get('O1');
  const result = { before: { at: stamp(Date.now()), expiresAt: stamp(lease.expiresAt) } };
  powerMonitor.on('suspend', () => (result.suspend = stamp(Date.now())));
  powerMonitor.on('resume', () => {
    result.resume = stamp(Date.now());
    setTimeout(() => {
      result.after = { at: stamp(Date.now()), expiresAt: stamp(lease.expiresAt), expired: lease.expired };
      result.asleepSeconds = Math.round((Date.parse(result.resume) - Date.parse(result.suspend)) / 1000);
      result.extendedBySeconds = Math.round((Date.parse(result.after.expiresAt) - Date.parse(result.before.expiresAt)) / 1000);
      result.decisions = fleet.decisions.list({ kind: 'lease' }).map((d) => d.text);
      writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
      fleet.stop();
      app.quit();
    }, 5000);
  });
  // A lead-in, so nobody is still typing when it sleeps: input at that moment
  // cancels the sleep (seen: powerMonitor reported suspend, then resume 1.4s later).
  setTimeout(() => execFile('pmset', ['sleepnow'], (err) => err && (result.pmsetError = String(err.message))), lead);
});
