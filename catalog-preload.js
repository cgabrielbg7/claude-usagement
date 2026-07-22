// Puente IPC de la ventana del catalogo. Expone solo lo que esa ventana necesita:
// nada de quit, togglePin ni fetchData.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('catalog', {
  scanSkills: () => ipcRenderer.invoke('scan-skills'),
  scanMcps:   () => ipcRenderer.invoke('scan-mcps'),
  close:      () => ipcRenderer.send('close-skills'),
});
