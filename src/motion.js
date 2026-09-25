// The pill's motion, from the spec: the cylinder roll of the collapsed line,
// and the escalation of an ignored question. Nothing else moves.
//
// The roll: when what the line *says* changes (sentence, repo, model, status —
// never the clock), the content right of the status mark turns like a
// horizontal cylinder of radius 18px, the new line coming over the top. At
// most one turn every 1.6s; changes in between wait and the turn goes to the
// newest. Reduced motion: a 120ms crossfade instead.

export const RADIUS = 18;
export const MIN_GAP_MS = 1600;
export const TURN_MS = 420;
export const FADE_MS = 120;

// One line on the cylinder at angle θ (0 = facing you, +π/2 = over the top):
// the spec's per-line projection. Pure, so it's testable.
export function wheelFrame(theta, radius = RADIUS) {
  const t = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, theta));
  const c = Math.cos(t);
  return {
    translateY: -radius * Math.sin(t),
    scaleY: Math.max(0, c),
    opacity: Math.max(0, c) ** 2.2,
  };
}

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function place(node, frame) {
  node.style.transform = `translateY(${frame.translateY.toFixed(2)}px) scaleY(${frame.scaleY.toFixed(3)})`;
  node.style.opacity = frame.opacity.toFixed(3);
}

function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Animates `drum`'s current face in, and `old` (a snapshot of the previous
// face, already placed over it) out. Resolves when done.
export function turn(drum, face, old, { reduced = prefersReducedMotion(), frame = requestAnimationFrame } = {}) {
  return new Promise((resolve) => {
    const start = performance.now();
    const duration = reduced ? FADE_MS : TURN_MS;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      if (reduced) {
        old.style.opacity = String(1 - t);
        face.style.opacity = String(t);
      } else {
        const e = easeInOutCubic(t);
        place(old, wheelFrame(-e * (Math.PI / 2)));
        place(face, wheelFrame((1 - e) * (Math.PI / 2)));
      }
      if (t < 1) frame(step);
      else {
        old.remove();
        face.style.transform = '';
        face.style.opacity = '';
        resolve();
      }
    };
    frame(step);
  });
}

// A roller for one drum. `change(key, apply)`: `apply` puts new content into
// the face; `key` is what the content means. Same key: applied in place.
// New key: turned to, now or when the 1.6s gap allows. The clock and the
// scheduler are injectable so the timing rules can be tested.
export function createRoller(drum, { now = () => performance.now(), later = setTimeout, animate = turn } = {}) {
  let shownKey;
  let lastTurn = -Infinity;
  let pending = null;
  let timer = null;
  let busy = false;

  const face = () => drum.querySelector('.face');

  async function run() {
    timer = null;
    if (!pending || busy) return;
    const { key, apply } = pending;
    pending = null;
    busy = true;
    lastTurn = now();
    const current = face();
    const old = current.cloneNode(true);
    old.classList.add('face--old');
    drum.append(old);
    apply();
    shownKey = key;
    await animate(drum, current, old);
    busy = false;
    if (pending) schedule();
  }

  function schedule() {
    if (timer || busy) return;
    const wait = Math.max(0, lastTurn + MIN_GAP_MS - now());
    timer = later(run, wait);
  }

  return {
    change(key, apply) {
      if (shownKey === undefined) {
        apply();
        shownKey = key;
        return;
      }
      if (key === shownKey && !pending) {
        apply();
        return;
      }
      pending = { key, apply };
      if (key === shownKey) {
        // Changed and changed back before the turn: no turn at all.
        pending = null;
        apply();
        return;
      }
      schedule();
    },
    get shownKey() {
      return shownKey;
    },
  };
}

// F6: the amber "needs you" state escalates if nobody responds. Stage 1 is
// the normal pulse, stage 2 from 30s, stage 3 from 2 minutes.
export function escalationStage(elapsedMs) {
  if (!(elapsedMs >= 0)) return 0;
  if (elapsedMs < 30_000) return 1;
  if (elapsedMs < 120_000) return 2;
  return 3;
}
