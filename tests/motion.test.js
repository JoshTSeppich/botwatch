// Motion rules from the spec: the per-line cylinder projection, when the
// wheel may turn, and the escalation stages. The timing rules are tested with
// a fake clock and scheduler; the animation itself is stood in for.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRoller, escalationStage, MIN_GAP_MS, RADIUS, wheelFrame } from '../src/motion.js';

test('facing you, a line is flat, full size and opaque', () => {
  assert.deepEqual(wheelFrame(0), { translateY: -0, scaleY: 1, opacity: 1 });
});

test('over the top it has risen by the radius and vanished; the projection follows the spec', () => {
  const top = wheelFrame(Math.PI / 2);
  assert.ok(Math.abs(top.translateY + RADIUS) < 1e-9, 'translateY(−R·sin θ)');
  assert.ok(top.scaleY < 1e-9 && top.opacity < 1e-9);
  const mid = wheelFrame(Math.PI / 4);
  assert.ok(Math.abs(mid.scaleY - Math.cos(Math.PI / 4)) < 1e-9, 'scaleY(cos θ)');
  assert.ok(Math.abs(mid.opacity - Math.cos(Math.PI / 4) ** 2.2) < 1e-9, 'opacity cos^2.2 θ');
  assert.ok(wheelFrame(-Math.PI / 4).translateY > 0, 'the outgoing line goes down');
});

// A drum without a DOM: enough for the roller's bookkeeping.
function harness() {
  let clock = 0;
  const timers = [];
  const turns = [];
  const face = { cloneNode: () => ({ classList: { add() {} }, remove() {} }) };
  const drum = { querySelector: () => face, append() {} };
  const roller = createRoller(drum, {
    now: () => clock,
    later: (fn, wait) => timers.push({ fn, at: clock + wait }),
    animate: async () => {
      turns.push(clock);
    },
  });
  const advance = async (ms) => {
    clock += ms;
    const due = timers.filter((x) => x.at <= clock);
    for (const t of due) timers.splice(timers.indexOf(t), 1);
    for (const t of due) await t.fn();
  };
  return { roller, turns, timers, advance, tick: (ms) => (clock += ms) };
}

test('the first content is shown without a turn, and the clock ticks in place', () => {
  const { roller, turns } = harness();
  const shown = [];
  roller.change('a', () => shown.push('a'));
  roller.change('a', () => shown.push('a, next second'));
  assert.deepEqual(shown, ['a', 'a, next second']);
  assert.deepEqual(turns, []);
});

test('a new sentence turns the wheel, at most once every 1.6s, and lands on the newest', async () => {
  const { roller, turns, advance } = harness();
  const shown = [];
  roller.change('a', () => shown.push('a'));
  await advance(10_000);
  roller.change('b', () => shown.push('b'));
  await advance(0);
  assert.deepEqual(turns, [10_000], 'turned at once');
  roller.change('c', () => shown.push('c'));
  roller.change('d', () => shown.push('d'));
  await advance(500);
  assert.equal(turns.length, 1, 'not again within 1.6s');
  await advance(MIN_GAP_MS);
  assert.deepEqual(shown, ['a', 'b', 'd'], 'c was skipped: the turn goes to the newest');
  assert.equal(turns.length, 2);
});

test('a change that reverts before its turn causes no turn', async () => {
  const { roller, turns, advance } = harness();
  roller.change('a', () => {});
  await advance(10_000);
  roller.change('b', () => {});
  await advance(0);
  roller.change('c', () => {});
  roller.change('b', () => {});
  await advance(MIN_GAP_MS * 2);
  assert.equal(turns.length, 1);
});

test('escalation: normal pulse to 30s, brighter to 2 minutes, then the rim', () => {
  assert.equal(escalationStage(0), 1);
  assert.equal(escalationStage(29_999), 1);
  assert.equal(escalationStage(30_000), 2);
  assert.equal(escalationStage(119_999), 2);
  assert.equal(escalationStage(120_000), 3);
  assert.equal(escalationStage(NaN), 0);
});

test('under reduced motion a change is a crossfade: opacity only, no transform', async () => {
  const { turn, FADE_MS } = await import('../src/motion.js');
  const el = () => ({ style: { transform: '', opacity: '' }, removed: false, remove() { this.removed = true; } });
  const face = el();
  const old = el();
  const seen = [];
  let clock = performance.now();
  // Each frame is 40ms later; record what the faces look like on each.
  const frame = (cb) => setTimeout(() => { clock += 40; cb(clock); seen.push([old.style.opacity, face.style.opacity, old.style.transform, face.style.transform]); }, 0);
  await turn(null, face, old, { reduced: true, frame });
  assert.ok(seen.length <= Math.ceil(FADE_MS / 40) + 1, `about ${FADE_MS}ms of frames, got ${seen.length}`);
  assert.ok(seen.every(([, , a, b]) => a === '' && b === ''), 'no transform on either face');
  assert.equal(old.removed, true);
  assert.equal(face.style.opacity, '', 'the new face is left fully shown');
});
