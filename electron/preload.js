const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  appVersion: '0.1.1',
  appLabel: 'samplevis 0.1.1 (beta)',
  platform: process.platform,
  listPresets: () => ipcRenderer.invoke('samplevis:presets:list'),
  getPreset: (id) => ipcRenderer.invoke('samplevis:presets:get', id),
  savePreset: (preset) => ipcRenderer.invoke('samplevis:presets:save', preset),
  deletePreset: (id) => ipcRenderer.invoke('samplevis:presets:delete', id),
  getPresetsDir: () => ipcRenderer.invoke('samplevis:presets:dir'),
  openPresetsFolder: () => ipcRenderer.invoke('samplevis:presets:open-folder'),
  consumePendingFiles: (extensions) => ipcRenderer.invoke('samplevis:files:consume-pending', extensions),
  onOpenFile: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => {
      try {
        callback(payload);
      } catch (err) {
        console.error('[ElectronPreload] onOpenFile handler error:', err);
      }
    };
    ipcRenderer.on('samplevis:open-file', handler);
    return () => ipcRenderer.removeListener('samplevis:open-file', handler);
  }
});
