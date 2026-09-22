// Raising a session's terminal to the front. The hard part is not the app —
// it is picking the right window or tab inside it, because two sessions in one
// terminal share a pid and differ only by tty. Scriptable terminals can be
// asked directly; the rest get the app raised and nothing more.
//
// Returns "stale" when the target no longer resolves, which is the only
// failure the UI reports.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { targetFor } from './sessions.js';

const run = promisify(execFile);

// The spec says raise and fullscreen. Fullscreen is off by default because on
// macOS the overlay cannot draw over another app's fullscreen Space, so obeying
// that line makes the pill vanish the moment you use it. Opt in if you want it.
const FULLSCREEN = process.env.PILL_FULLSCREEN === '1';

export async function raise(sessionId) {
  const target = targetFor(sessionId);
  if (!target) return 'stale';
  if (target.mock) return 'ok';

  try {
    if (process.platform === 'darwin') await raiseDarwin(target);
    else if (process.platform === 'win32') await raiseWindows(target.appPid);
    else await raiseLinux(target.appPid);
    return 'ok';
  } catch {
    return 'stale';
  }
}

async function raiseDarwin(target) {
  const selected = await selectWindow(target);
  if (!selected) await activateApp(target.appPid);
  if (FULLSCREEN) await fullscreenFront(target.appPid);
}

// Each terminal names its parts differently, so there is one script per
// terminal rather than one clever abstraction over three dictionaries.
async function selectWindow(target) {
  if (!target.tty) return false;
  if (target.appName === 'Terminal') return applescript(terminalScript(target.tty));
  if (target.appName === 'iTerm') return applescript(itermScript(target.tty));
  if (target.appName === 'WezTerm') return wezterm(target);
  if (target.appName === 'kitty') return kitty(target);
  return false;
}

// Terminal.app exposes tty on every tab, which is the whole trick.
function terminalScript(tty) {
  return `
tell application "Terminal"
  set hit to false
  repeat with w from 1 to count of windows
    repeat with t from 1 to count of tabs of window w
      if (tty of tab t of window w) is "${tty}" then
        set selected of tab t of window w to true
        set index of window w to 1
        set hit to true
      end if
    end repeat
  end repeat
  if hit then activate
  return hit
end tell`;
}

function itermScript(tty) {
  return `
tell application "iTerm"
  set hit to false
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (tty of s) is "${tty}" then
          select s
          select t
          select w
          set hit to true
        end if
      end repeat
    end repeat
  end repeat
  if hit then activate
  return hit
end tell`;
}

async function applescript(script) {
  const { stdout } = await run('osascript', ['-e', script]);
  return stdout.trim() === 'true';
}

// WezTerm and kitty have no AppleScript dictionary but do have a CLI that can
// name a pane by its tty.
async function wezterm(target) {
  const { stdout } = await run('wezterm', ['cli', 'list', '--format', 'json']);
  const pane = JSON.parse(stdout).find((p) => p.tty_name === target.tty);
  if (!pane) return false;
  await run('wezterm', ['cli', 'activate-pane', '--pane-id', String(pane.pane_id)]);
  await activateApp(target.appPid);
  return true;
}

async function kitty(target) {
  // kitty matches on the process, not the tty, and only when the user has
  // turned remote control on.
  await run('kitty', ['@', 'focus-window', '--match', `pid:${target.appPid}`]);
  await activateApp(target.appPid);
  return true;
}

async function activateApp(pid) {
  await applescript(`
tell application "System Events"
  set procs to (every application process whose unix id is ${pid})
  if procs is {} then error "stale"
  set frontmost of item 1 of procs to true
  return true
end tell`);
}

// Accessibility permission is required for this; activation alone still works
// without it, so a refusal here is not a failure.
async function fullscreenFront(pid) {
  await applescript(`
tell application "System Events"
  set procs to (every application process whose unix id is ${pid})
  if procs is {} then error "stale"
  try
    set value of attribute "AXFullScreen" of front window of item 1 of procs to true
  end try
  return true
end tell`).catch(() => false);
}

async function raiseWindows(pid) {
  const script = `
$sig = '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);'
Add-Type -Namespace Pill -Name Win -MemberDefinition $sig
$p = Get-Process -Id ${pid} -ErrorAction Stop
if ($p.MainWindowHandle -eq 0) { throw 'stale' }
[Pill.Win]::ShowWindow($p.MainWindowHandle, 3)
[Pill.Win]::SetForegroundWindow($p.MainWindowHandle)`;
  await run('powershell', ['-NoProfile', '-Command', script]);
}

// X11 only. Wayland has no client-initiated activation without a compositor
// protocol, so this is the one platform path I have not made work.
async function raiseLinux(pid) {
  const { stdout } = await run('xdotool', ['search', '--pid', String(pid)]);
  const id = stdout.trim().split('\n').filter(Boolean).pop();
  if (!id) throw new Error('stale');
  await run('xdotool', ['windowactivate', '--sync', id]);
}
