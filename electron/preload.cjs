const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('quickhide', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  browseLootFilter: () => ipcRenderer.invoke('settings:browseLootFilter'),
  setLootFilterPath: (value) => ipcRenderer.invoke('settings:setLootFilterPath', value),
  testAppend: () => ipcRenderer.invoke('quickhide:testAppend'),
  onAppended: (cb) => ipcRenderer.on('quickhide:appended', (_event, payload) => cb(payload)),
  onError: (cb) => ipcRenderer.on('quickhide:error', (_event, payload) => cb(payload)),
})
