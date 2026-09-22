// The adapter boundary. The overlay reads sessions from exactly one place, and
// this file decides whether that place is the machine or the fixture.
//
// Live is the default. PILL_MOCK=1 forces the fixture, which is how the demo
// stays reproducible and how you see the states that are rare in real life.

import * as live from './sessions.live.js';
import { read as readFixture, isStale } from '../src/source.mock.js';

const useFixture = process.env.PILL_MOCK === '1';

export function read() {
  return useFixture ? readFixture() : live.read();
}

// The app that owns the window, plus the tty that tells its windows and tabs
// apart. Fixture sessions raise nothing: one of them has no target at all,
// which is how the stale-handle path stays reachable.
export function targetFor(sessionId) {
  if (!useFixture) return live.targetFor(sessionId);
  return isStale(sessionId) ? null : { mock: true };
}
