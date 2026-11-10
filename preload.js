const { contextBridge, ipcRenderer: ipc } = require('electron');
const call = ch => (...a) => ipc.invoke(ch, ...a);
contextBridge.exposeInMainWorld('api', {
  win: call('win'), getConfig: call('config:get'), check: call('admin:check'), isAdmin: call('admin:isAdmin'),
  save: (password, config) => ipc.invoke('admin:save', { password, config }), pick: call('admin:pickFile'),
  login: call('login'), launch: call('launch'), server: call('server:status'), open: call('open'),
  settingsGet: call('settings:get'), settingsSet: call('settings:set'),
  onProgress: cb => ipc.on('progress', (_, v) => cb(v)), onStatus: cb => ipc.on('status', (_, v) => cb(v)),
  onClosed: cb => ipc.on('closed', cb)
});
