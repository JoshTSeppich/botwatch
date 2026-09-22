// The renderer gets five verbs and no Node. Everything the pill can do to the
// window or to a terminal goes through this list.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pillHost', {
  read: () => ipcRenderer.invoke('pill:read'),
  raise: (sessionId) => ipcRenderer.invoke('pill:raise', sessionId),
  grant: () => ipcRenderer.invoke('pill:grant'),
  beginDrag: () => ipcRenderer.send('pill:dragStart'),
  dragTo: (dx, dy) => ipcRenderer.send('pill:dragTo', dx, dy),
  endDrag: () => ipcRenderer.send('pill:endDrag'),
  resetDock: () => ipcRenderer.send('pill:resetDock'),
  setInteractive: (on) => ipcRenderer.send('pill:interactive', on),
});
