const { contextBridge, ipcRenderer: ipc } = require('electron');
contextBridge.exposeInMainWorld('api', {
  win: a => ipc.invoke('win', a),
  getConfig: () => ipc.invoke('config:get'),
  save: (password, config) => ipc.invoke('admin:save', { password, config }),
  check: pw => ipc.invoke('admin:check', pw),
  pick: k => ipc.invoke('admin:pickFile', k),
  login: () => ipc.invoke('login'),
  launch: () => ipc.invoke('launch'),
  onProgress: cb => ipc.on('progress', (_, v) => cb(v)),
  onStatus: cb => ipc.on('status', (_, v) => cb(v)),
  onClosed: cb => ipc.on('closed', cb)
});
