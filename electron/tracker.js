// Where the terminal window is. The overlay has to follow it on move, resize
// and focus change, and disappear when there is nothing to sit on.
//
// macOS reads the real frontmost window through System Events, which needs
// accessibility permission. Everywhere else this falls back to the top centre
// of the primary work area — correct dock position, wrong window.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { screen } from 'electron';

const run = promisify(execFile);

const TERMINALS = new Set([
  // The Claude desktop app hosts sessions too, so it counts as a terminal here.
  'Claude',
  'Terminal',
  'iTerm2',
  'Ghostty',
  'WezTerm',
  'Alacritty',
  'kitty',
  'Warp',
  'Hyper',
  'Code',
]);

// `permitted` is a getter, not a flag: permission can arrive at any poll, and
// until it does this must not send a single Apple Event. Every denied event is
// another permission dialog in the user's face.
export function trackTerminal(intervalMs, permitted, onChange) {
  let last = null;
  const tick = async () => {
    const next = permitted() ? await probe(last) : workAreaFallback();
    if (JSON.stringify(next) !== JSON.stringify(last)) {
      last = next;
      onChange(next);
    }
  };
  void tick();
  return setInterval(tick, intervalMs);
}

async function probe(last) {
  if (process.platform !== 'darwin') return workAreaFallback();
  try {
    const bounds = await frontmostDarwinWindow();
    // Not a terminal in front: keep the last known dock rather than chasing an
    // unrelated window around the screen.
    return bounds ?? last ?? workAreaFallback();
  } catch {
    return workAreaFallback();
  }
}

async function frontmostDarwinWindow() {
  const script = `
tell application "System Events"
  set p to first application process whose frontmost is true
  set n to name of p
  if (count of windows of p) is 0 then return "none"
  set w to front window of p
  set {x, y} to position of w
  set {ww, hh} to size of w
  return n & "|" & x & "|" & y & "|" & ww & "|" & hh
end tell`;
  const { stdout } = await run('osascript', ['-e', script]);
  const [name, x, y, width, height] = stdout.trim().split('|');
  if (name === 'none' || !TERMINALS.has(name)) return null;
  return { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
}

function workAreaFallback() {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
}
