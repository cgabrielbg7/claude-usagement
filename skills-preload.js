// Puente IPC de la ventana del catalogo. Expone solo lo que esa ventana necesita:
// nada de quit, togglePin ni fetchData.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skills', {
  scan:  () => ipcRenderer.invoke('scan-skills'),
  close: () => ipcRenderer.send('close-skills'),
});
