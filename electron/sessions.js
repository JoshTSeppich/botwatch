// The adapter boundary. The overlay reads sessions from exactly one place, and
// this file decides whether that place is the machine or the fixture.
//
// Live is the default. PILL_MOCK=1 forces the fixture, which is how the demo
// stays reproducible and how you see the states that are rare in real life.

import * as live from './sessions.live.js';
import { listen } from './pilld.js';
import { read as readFixture, isStale } from '../src/source.mock.js';

const useFixture = process.env.PILL_MOCK === '1';

const trace = process.env.PILL_TRACE === '1';
let listed = new Set();

export async function read() {
  if (useFixture) return readFixture();
  const snapshot = await live.read();
  // PILL_TRACE=1 also logs each row arriving and leaving: the moment the
  // renderer's next paint will add or drop it.
  if (trace) {
    const now = new Set(snapshot.sessions.map((s) => s.id));
    const stamp = new Date().toISOString();
    for (const s of snapshot.sessions) {
      if (!listed.has(s.id)) console.log(`${stamp} ${s.id.slice(0, 8)} row + pid ${s.pid} ${s.state}/${s.needs ?? '-'} (${s.source})`);
    }
    for (const id of listed) if (!now.has(id)) console.log(`${stamp} ${id.slice(0, 8)} row -`);
    listed = now;
  }
  return snapshot;
}

// The app that owns the window, plus the tty that tells its windows and tabs
// apart. Fixture sessions raise nothing: one of them has no target at all,
// which is how the stale-handle path stays reachable.
export function targetFor(sessionId) {
  if (!useFixture) return live.targetFor(sessionId);
  return isStale(sessionId) ? null : { mock: true };
}

// Starts pilld: bw-hook's events go straight into the live registry. The
// fixture has no sessions to hear about, so it does not take the socket.
// Failing to listen is not fatal — the transcript still says what it can.
export async function startHooks() {
  if (useFixture) return null;
  return listen((event, at) => {
    live.registry.apply(event, at);
    // PILL_TRACE=1: one line per hook event and the state it left, which is how
    // you see the pipeline work without trusting the pill's paint.
    if (trace) {
      const s = live.registry.get(event.session_id, at);
      const what = event.notification_type ?? event.tool_name ?? '';
      console.log(`${new Date(at).toISOString()} ${String(event.session_id).slice(0, 8)} ${event.hook_event_name} ${what} -> ${s ? `${s.state}/${s.needs ?? '-'} "${s.summary}"` : 'gone'}`);
    }
  }).catch((error) => {
    console.error(`pilld: not listening (${error.message}); state comes from transcripts only`);
    return null;
  });
}
