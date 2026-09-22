// All pointer behaviour. Kept apart from render.js because the rules here are
// about time and intent (grace periods, drag versus click) and read better in
// one place than scattered through the markup builders.

const COLLAPSE_GRACE_MS = 240;
const DRAG_SUPPRESS_MS = 250;

// Hover expands, leaving collapses after a grace period so a diagonal exit
// across the pill's own rows does not slam it shut.
export function wireExpand(pill, canExpand) {
  let timer = null;

  function open() {
    clearTimeout(timer);
    if (canExpand()) pill.el.classList.add('is-open');
  }

  function close() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Re-docking the window under a stationary cursor synthesizes a
      // pointerleave, which would otherwise collapse the pill in your hand.
      // :hover is the truth at the moment the grace expires.
      if (!pill.el.matches(':hover')) pill.el.classList.remove('is-open');
    }, COLLAPSE_GRACE_MS);
  }

  pill.el.addEventListener('pointerenter', open);
  pill.el.addEventListener('pointerleave', close);
  return {
    collapse() {
      clearTimeout(timer);
      pill.el.classList.remove('is-open');
    },
  };
}

// The raise fires on click-up, never on mouse-down: a press that turns into a
// drag must not surface a terminal.
export function wireRaise(pill, expand, deps) {
  pill.el.addEventListener('click', async (event) => {
    if (deps.dragJustHappened()) return;
    if (event.target.closest('.handle')) return;
    if (deps.isBlocked()) {
      await deps.onNotice();
      return;
    }
    const dismiss = event.target.closest('[data-dismiss]');
    if (dismiss) {
      event.stopPropagation();
      deps.onDismiss(dismiss.dataset.dismiss);
      return;
    }
    const row = event.target.closest('.row');
    const id = row ? row.dataset.sessionId : deps.defaultSessionId();
    if (!id) return;

    const outcome = await deps.onRaise(id);
    if (outcome === 'stale') return;
    expand.collapse();
  });
}

// The four-dot square is the only draggable region, and pressing it suppresses
// both the expand and the raise for as long as the gesture lasts.
export function wireDrag(pill, host) {
  const handle = pill.el.querySelector('.handle');
  let origin = null;
  let pending = null;
  let frame = 0;
  let endedAt = 0;

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    // Screen coordinates, not client ones. The window moves out from under the
    // pointer as you drag, which makes every client-relative delta wrong by
    // however far the window just went.
    origin = { x: event.screenX, y: event.screenY };
    handle.classList.add('is-dragging');
    handle.setPointerCapture(event.pointerId);
    pill.el.classList.remove('is-open');
    host.beginDrag();
  });

  handle.addEventListener('pointermove', (event) => {
    if (!origin) return;
    // Total offset from where the drag started, never a sum of steps: an
    // absolute figure cannot drift, and a dropped frame costs nothing.
    pending = { x: event.screenX - origin.x, y: event.screenY - origin.y };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (pending) host.dragTo(pending.x, pending.y);
    });
  });

  function finish(event) {
    if (!origin) return;
    origin = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (pending) host.dragTo(pending.x, pending.y);
    pending = null;
    endedAt = Date.now();
    handle.classList.remove('is-dragging');
    if (event) handle.releasePointerCapture(event.pointerId);
    host.endDrag();
  }

  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    host.resetDock();
  });

  return {
    dragJustHappened() {
      return origin !== null || Date.now() - endedAt < DRAG_SUPPRESS_MS;
    },
  };
}

// The overlay window is bigger than the pills. Everything outside them has to
// stay click-through or the terminal below loses its top edge.
export function wireClickThrough(dock, host) {
  dock.addEventListener('pointerenter', () => host.setInteractive(true));
  dock.addEventListener('pointerleave', () => host.setInteractive(false));
  host.setInteractive(false);
}
