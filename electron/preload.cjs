const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('quickhide', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  browseLootFilter: () => ipcRenderer.invoke('settings:browseLootFilter'),
  setLootFilterPath: (value) => ipcRenderer.invoke('settings:setLootFilterPath', value),
  testAppend: () => ipcRenderer.invoke('quickhide:testAppend'),
  confirmHide: () => ipcRenderer.invoke('quickhide:confirmHide'),
  cancelHide: () => ipcRenderer.invoke('quickhide:cancelHide'),
  onCaptured: (cb) => ipcRenderer.on('quickhide:captured', (_event, payload) => cb(payload)),
  onAppended: (cb) => ipcRenderer.on('quickhide:appended', (_event, payload) => cb(payload)),
  onError: (cb) => ipcRenderer.on('quickhide:error', (_event, payload) => cb(payload)),
})
