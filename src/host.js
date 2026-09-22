// Where the pill gets its snapshot and how it is allowed to move. Two hosts,
// same shape: the Electron one drives a real always-on-top window, the browser
// one moves a div so the whole thing is reviewable without a native build.

import * as mock from './source.mock.js';

const SNAP_PX = 24;
const SNAP_MS = 120;
const DEFAULT_OFFSET = { x: 0, y: -8 };

export function createHost(dock) {
  return window.pillHost ? nativeHost(dock) : browserHost(dock);
}

function nativeHost(dock) {
  const bridge = window.pillHost;
  return {
    isNative: true,
    read: () => bridge.read(),
    raise: (id) => bridge.raise(id),
    grant: () => bridge.grant(),
    menu: () => bridge.menu(),
    beginDrag: () => {
      dock.classList.remove('is-snapping');
      bridge.beginDrag();
    },
    dragTo: (dx, dy) => bridge.dragTo(dx, dy),
    endDrag: () => bridge.endDrag(),
    resetDock: () => bridge.resetDock(),
    setInteractive: (on) => bridge.setInteractive(on),
  };
}

function browserHost(dock) {
  const key = `pill.dock.${window.screen.width}x${window.screen.height}`;
  let offset = load(key);
  let anchor = { ...offset };
  apply(dock, offset);

  return {
    isNative: false,
    read: () => mock.read(),
    raise: (id) => Promise.resolve(mock.isStale(id) ? 'stale' : 'ok'),
    grant: () => Promise.resolve(),
    menu: () => {},
    beginDrag() {
      dock.classList.remove('is-snapping');
      anchor = { ...offset };
    },
    dragTo(dx, dy) {
      offset = { x: anchor.x + dx, y: anchor.y + dy };
      apply(dock, offset);
    },
    endDrag() {
      offset = snap(dock, offset);
      dock.classList.add('is-snapping');
      apply(dock, offset);
      setTimeout(() => dock.classList.remove('is-snapping'), SNAP_MS);
      save(key, offset);
    },
    resetDock() {
      offset = { ...DEFAULT_OFFSET };
      dock.classList.add('is-snapping');
      apply(dock, offset);
      setTimeout(() => dock.classList.remove('is-snapping'), SNAP_MS);
      localStorage.removeItem(key);
    },
    setInteractive() {},
  };
}

function apply(dock, offset) {
  dock.style.setProperty('--dock-x', `${offset.x}px`);
  dock.style.setProperty('--dock-y', `${offset.y}px`);
}

// Release snaps to whichever edge of the host surface is within 24px, so a
// rough drag still lands flush.
function snap(dock, offset) {
  const parent = dock.offsetParent ?? document.body;
  const box = dock.getBoundingClientRect();
  const bounds = parent.getBoundingClientRect();
  let { x, y } = offset;
  if (Math.abs(box.left - bounds.left) <= SNAP_PX) x += bounds.left - box.left;
  else if (Math.abs(bounds.right - box.right) <= SNAP_PX) x += bounds.right - box.right;
  if (Math.abs(box.top - bounds.top) <= SNAP_PX) y += bounds.top - box.top + DEFAULT_OFFSET.y;
  else if (Math.abs(bounds.bottom - box.bottom) <= SNAP_PX) y += bounds.bottom - box.bottom;
  return { x, y };
}

function load(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved;
  } catch {
    // A corrupt offset is not worth a crash; fall back to the default dock.
  }
  return { ...DEFAULT_OFFSET };
}

function save(key, offset) {
  try {
    localStorage.setItem(key, JSON.stringify(offset));
  } catch {
    // Private-mode storage failures just cost us the persisted offset.
  }
}
