const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claude', {
  fetchData:     ()          => ipcRenderer.invoke('fetch-data'),
  close:         ()          => ipcRenderer.send('close-window'),
  togglePin:     ()          => ipcRenderer.invoke('toggle-pin'),
  dragStart:     ()          => ipcRenderer.send('drag-start'),
  dragMove:      (dx, dy)    => ipcRenderer.send('drag-move', { dx, dy }),
  dragEnd:       ()          => ipcRenderer.send('drag-end'),
  panelState:    (expanded, height) => ipcRenderer.send('panel-state', { expanded, height }),
  restart:       ()          => ipcRenderer.send('restart-widget'),
  quit:          ()          => ipcRenderer.send('quit-app'),
  onAutoRefresh: (cb)        => ipcRenderer.on('auto-refresh', cb),
});
