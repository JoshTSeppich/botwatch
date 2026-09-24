// The renderer gets a short list of verbs and no Node. Everything the pill can
// do to the window, a terminal or a repo goes through this list.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pillHost', {
  read: () => ipcRenderer.invoke('pill:read'),
  raise: (sessionId) => ipcRenderer.invoke('pill:raise', sessionId),
  grant: () => ipcRenderer.invoke('pill:grant'),
  menu: () => ipcRenderer.send('pill:menu'),
  beginDrag: () => ipcRenderer.send('pill:dragStart'),
  dragTo: (dx, dy) => ipcRenderer.send('pill:dragTo', dx, dy),
  endDrag: () => ipcRenderer.send('pill:endDrag'),
  resetDock: () => ipcRenderer.send('pill:resetDock'),
  setInteractive: (on) => ipcRenderer.send('pill:interactive', on),
  keyboard: (on) => ipcRenderer.send('pill:keyboard', on),
  // v3. Merge takes the branches and commits the user reviewed and the flagged
  // files they acknowledged; pilld checks both again before touching the repo.
  orch: {
    setup: (repo) => ipcRenderer.invoke('orch:setup', repo),
    start: (config) => ipcRenderer.invoke('orch:start', config),
    review: () => ipcRenderer.invoke('orch:review'),
    merge: (selection) => ipcRenderer.invoke('orch:merge', selection),
    answer: (text) => ipcRenderer.invoke('orch:answer', text),
    stop: () => ipcRenderer.invoke('orch:stop'),
    close: () => ipcRenderer.invoke('orch:close'),
    onOpen: (fn) => ipcRenderer.on('orch:open', () => fn()),
  },
});
