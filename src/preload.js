const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  browseExecutable: () => ipcRenderer.invoke('settings:browse'),

  createProfile: (data) => ipcRenderer.invoke('profiles:create', data),
  editData: (id) => ipcRenderer.invoke('profiles:editData', id),
  updateProfile: (data) => ipcRenderer.invoke('profiles:update', data),
  regenerateProfile: (id) => ipcRenderer.invoke('profiles:regenerate', id),
  checkProxy: (id) => ipcRenderer.invoke('profiles:checkProxy', id),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  launchProfile: (id) => ipcRenderer.invoke('profiles:launch', id),
  stopProfile: (id) => ipcRenderer.invoke('profiles:stop', id),

  onStatus: (cb) => ipcRenderer.on('profiles:status', (_e, data) => cb(data)),
  onError: (cb) => ipcRenderer.on('profiles:error', (_e, data) => cb(data)),
});
