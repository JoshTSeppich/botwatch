// The always-on-top overlay window: transparent, click-through everywhere the
// pills are not, docked to the top edge of the frontmost terminal. This file
// owns window geometry and nothing else — data comes from sessions.js, raising
// from raise.js.

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, Tray, net, protocol, screen } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { read as readSessions, startHooks } from './sessions.js';
import { raise } from './raise.js';
import { probe as probePermissions, request as requestPermissions } from './permissions.js';
import { trackTerminal } from './tracker.js';
import { serveControl } from './orchestrator/control.js';
import { createPilot } from './orchestrator/pilot.js';
import { setupInfo } from './orchestrator/setup.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// Tall enough for the setup and review panels, which hang below the pill. The
// window is transparent and click-through, so its size costs nothing visible.
const WINDOW = { width: 820, height: 720 };
const DOCK_Y = -8;
const SNAP_PX = 24;
const POLL_MS = 1000;

let win = null;
let terminal = null;
let offsets = {};
let offsetsPath = '';
// Set for the length of a drag. While it is set the window follows the pointer
// and nothing else is allowed to move it or write to disk.
let drag = null;
// Last known permission state. The tracker reads it so it stays silent until
// macOS has said yes.
let permitted = process.platform !== 'darwin';
let tray = null;
// The orchestrator run, if one is going. Its view rides along on every read.
const pilot = createPilot();

function currentDisplayKey() {
  if (!terminal) return 'primary';
  return String(screen.getDisplayNearestPoint({ x: terminal.x, y: terminal.y }).id);
}

function offset() {
  return offsets[currentDisplayKey()] ?? { x: 0, y: 0 };
}

// Persisting is a separate decision from moving: a drag moves the window sixty
// times a second, and writing the file that often was most of the jank.
function setOffset(next, persist) {
  offsets[currentDisplayKey()] = next;
  if (persist) void writeFile(offsetsPath, JSON.stringify(offsets), 'utf8').catch(() => {});
}

// Where the pill sits with no offset applied: centred on the terminal's x axis,
// straddling its top edge.
function dockBase() {
  return {
    x: Math.round(terminal.x + (terminal.width - WINDOW.width) / 2),
    y: Math.round(terminal.y + DOCK_Y),
  };
}

// The dock position plus whatever the user dragged on this monitor. Never
// while a drag is in flight: re-docking mid-gesture yanks the window out from
// under the pointer.
function redock() {
  if (!win || !terminal || drag) return;
  const base = dockBase();
  const { x, y } = offset();
  win.setBounds({ x: base.x + x, y: base.y + y, ...WINDOW });
}

// The renderer is ES modules, and a file:// page has an opaque origin that
// Chromium refuses to load modules into. A tiny app:// handler gives it a real
// origin without loosening webSecurity.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function serveRenderer() {
  protocol.handle('app', async (request) => {
    const target = resolve(root, `.${new URL(request.url).pathname}`);
    if (relative(root, target).startsWith('..')) return new Response('forbidden', { status: 403 });
    const file = await net.fetch(pathToFileURL(target).toString());
    // Never cache a local file. Chromium's cache lives in userData and outlives
    // a restart, so a cached stylesheet makes an edit look like it did nothing.
    const headers = new Headers(file.headers);
    headers.set('cache-control', 'no-store');
    return new Response(file.body, { status: file.status, headers });
  });
}

function createWindow() {
  win = new BrowserWindow({
    ...WINDOW,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    // Never takes keyboard focus: focus belongs to the terminal it raises.
    focusable: false,
    fullscreenable: false,
    // On macOS only a panel floats above another app's native fullscreen
    // Space. Without this the pill vanishes the moment the terminal it just
    // raised goes fullscreen, which is the one time you need it most.
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: { preload: join(here, 'preload.cjs'), sandbox: true },
  });

  // Order matters on macOS: setVisibleOnAllWorkspaces resets the window level,
  // so asking for always-on-top afterwards is the only way it sticks.
  // skipTransformProcessType keeps Electron from bouncing the process type,
  // which otherwise undoes the panel behaviour the next line depends on.
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Forwarded move events still reach the page, which is how the renderer
  // notices the pointer arriving and asks for the clicks back.
  win.setIgnoreMouseEvents(true, { forward: true });
  void win.loadURL('app://pill/index.html');
}

app.whenReady().then(async () => {
  // An accessory process, not an app: no dock icon, no app switcher entry, and
  // on macOS this is also what lets the panel sit over a fullscreen Space.
  app.dock?.hide();

  offsetsPath = join(app.getPath('userData'), 'dock-offsets.json');
  offsets = await readFile(offsetsPath, 'utf8').then(JSON.parse).catch(() => ({}));

  // Listening before the window exists, so the first paint already has
  // whatever the hooks have said.
  await startHooks();
  await serveControl(pilot.current).catch((error) => {
    console.error(`control: not listening (${error.message}); orchestrator runs are unavailable`);
  });
  serveRenderer();
  createWindow();

  trackTerminal(POLL_MS, () => permitted, (bounds) => {
    terminal = bounds;
    if (!win) return;
    // No terminal window means minimised or occluded: the pill goes away
    // rather than floating over something it knows nothing about.
    if (!bounds) win.hide();
    else {
      redock();
      if (!win.isVisible()) win.showInactive();
    }
  });

  ipcMain.handle('pill:read', async () => {
    // Probed on every poll so the pill recovers the moment a grant lands,
    // without a relaunch.
    const permission = await probePermissions();
    permitted = permission.ok;
    if (!permission.ok) return { sessions: [], usage: null, terminal: {}, permission };
    return {
      ...(await readSessions()),
      terminal: { width: terminal?.width ?? 0 },
      permission,
      run: pilot.view(),
    };
  });

  // v3. The renderer opens the setup panel; everything that touches a repo
  // happens here, in pilld.
  ipcMain.handle('orch:setup', async (_event, repo) => setupInfo(repo, (await readSessions()).sessions ?? []));
  ipcMain.handle('orch:start', (_event, config) => pilot.start(config));
  ipcMain.handle('orch:review', () => pilot.review());
  ipcMain.handle('orch:merge', (_event, selection) => pilot.merge(selection));
  ipcMain.handle('orch:answer', (_event, text) => pilot.answer(text));
  ipcMain.handle('orch:stop', () => pilot.stop());
  ipcMain.handle('orch:close', () => pilot.close());

  // A panel with a text field needs the keyboard, and this window never takes
  // it otherwise. Lent while a panel is open, returned when it closes.
  ipcMain.on('pill:keyboard', (_event, on) => {
    if (!win) return;
    win.setFocusable(on);
    if (on) win.focus();
  });

  globalShortcut.register('Alt+Command+O', () => win?.webContents.send('orch:open'));

  ipcMain.handle('pill:grant', () => requestPermissions());

  // No Dock icon and a window that never takes focus, so without this there is
  // no way to quit the app at all. The menu bar is the one place an accessory
  // app is guaranteed to be reachable.
  tray = new Tray(join(here, 'assets', 'trayTemplate.png'));
  tray.setToolTip('BotWatch');
  tray.setContextMenu(pillMenu());

  // Right-clicking the pill offers the same menu, for when the pill is what
  // your hand is already on.
  ipcMain.on('pill:menu', () => {
    if (!win) return;
    // A menu needs a window that can take focus, and this one deliberately
    // cannot. Lend it focus for exactly as long as the menu is open.
    win.setFocusable(true);
    pillMenu().popup({ window: win, callback: () => win?.setFocusable(false) });
  });

  ipcMain.handle('pill:raise', (_event, sessionId) => raise(sessionId));

  ipcMain.on('pill:interactive', (_event, on) => {
    win?.setIgnoreMouseEvents(!on, { forward: true });
  });

  ipcMain.on('pill:dragStart', () => {
    if (win) drag = { from: win.getBounds() };
  });

  // The renderer sends the total distance from where the drag began, so this is
  // a plain assignment. Nothing accumulates, so nothing drifts.
  ipcMain.on('pill:dragTo', (_event, dx, dy) => {
    if (!win || !drag) return;
    win.setBounds({ x: Math.round(drag.from.x + dx), y: Math.round(drag.from.y + dy), ...WINDOW });
  });

  // Release is where the offset is finally worked out, snapped to a nearby
  // edge, and written down. One calculation, one disk write, one move.
  ipcMain.on('pill:endDrag', () => {
    drag = null;
    if (!win || !terminal) return;
    const box = win.getBounds();
    const base = dockBase();
    const next = { x: box.x - base.x, y: box.y - base.y };
    const area = screen.getDisplayNearestPoint({ x: box.x, y: box.y }).workArea;
    if (Math.abs(box.x - area.x) <= SNAP_PX) next.x += area.x - box.x;
    else if (Math.abs(area.x + area.width - (box.x + box.width)) <= SNAP_PX) {
      next.x += area.x + area.width - (box.x + box.width);
    }
    if (Math.abs(box.y - area.y) <= SNAP_PX) next.y += area.y - box.y;
    setOffset(next, true);
    redock();
  });

  ipcMain.on('pill:resetDock', () => {
    drag = null;
    setOffset({ x: 0, y: 0 }, true);
    redock();
  });
});

function pillMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Reset position',
      click: () => {
        drag = null;
        setOffset({ x: 0, y: 0 }, true);
        redock();
      },
    },
    { type: 'separator' },
    { label: 'Quit BotWatch', click: () => app.quit() },
  ]);
}

// An overlay has no windows to come back to, so the usual macOS re-activate
// dance does not apply; quitting is the only exit.
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());

// Quitting mid-run stops the orchestrator and every worker and takes the ref
// hook back out of the repo, once; the branches and worktrees stay.
let closing = false;
app.on('before-quit', (event) => {
  if (closing || !pilot.current()) return;
  closing = true;
  event.preventDefault();
  void pilot.close({ stop: true }).finally(() => app.quit());
});
