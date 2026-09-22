// macOS will not let an app read another window's position or bring another
// app's window forward without permission, and the pill's whole job is both of
// those. So the first run has to ask, and the app has to notice the moment it
// is granted rather than making you relaunch.
//
// Two separate grants, in two separate places in System Settings:
//   Accessibility  reading window geometry, setting frontmost
//   Automation     sending Apple Events to Terminal, iTerm and System Events
//
// Nothing here is needed off macOS, where probe() reports everything granted.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shell, systemPreferences } from 'electron';

const run = promisify(execFile);

// Spawning osascript once a second to re-ask a question whose answer rarely
// changes is wasteful, so the automation answer is cached — briefly while
// denied, so a grant shows up almost at once, and longer once it is granted.
const RECHECK_DENIED_MS = 5000;
const RECHECK_GRANTED_MS = 30_000;

const PANES = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
};

let automation = { granted: false, checkedAt: 0 };

export async function probe() {
  if (process.platform !== 'darwin') return { ok: true, missing: [] };

  const accessibility = systemPreferences.isTrustedAccessibilityClient(false);
  const missing = [];
  if (!accessibility) missing.push('accessibility');
  if (!(await checkAutomation())) missing.push('automation');
  return { ok: missing.length === 0, missing };
}

// Asks for both, which is all an app is allowed to do: macOS shows its own
// dialog and the user decides. A second click lands them in the right pane,
// because a denied grant is never re-prompted.
export async function request() {
  if (process.platform !== 'darwin') return;
  const accessibility = systemPreferences.isTrustedAccessibilityClient(true);
  automation = { granted: false, checkedAt: 0 };
  const granted = await checkAutomation();
  if (!accessibility) await shell.openExternal(PANES.accessibility);
  else if (!granted) await shell.openExternal(PANES.automation);
}

async function checkAutomation() {
  const stale = automation.granted ? RECHECK_GRANTED_MS : RECHECK_DENIED_MS;
  if (Date.now() - automation.checkedAt < stale) return automation.granted;

  // The cheapest possible Apple Event. Sending one is the only way to find out
  // whether we are allowed to send one: error -1743 is the refusal.
  const granted = await run('osascript', ['-e', 'tell application "System Events" to return name'])
    .then(() => true)
    .catch(() => false);
  automation = { granted, checkedAt: Date.now() };
  return granted;
}
