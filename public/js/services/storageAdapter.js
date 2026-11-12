// storage adapter interface & runtime detection
// enables zero-server offline desktop operation (electron/local persistent storage)
// while providing a clean pluggable port for cloudflare d1 in the saas edition
(function () {
  'use strict';

  class StorageAdapter {
    async listPresets() {
      throw new Error('Not implemented');
    }
    async getPreset(id) {
      throw new Error('Not implemented');
    }
    async savePreset(preset) {
      throw new Error('Not implemented');
    }
    async deletePreset(id) {
      throw new Error('Not implemented');
    }
  }

  // desktop / offline indexeddb & local disk adapter
  class LocalStorageAdapter extends StorageAdapter {
    constructor() {
      super();
      this.isElectron = Boolean(window.electronAPI && typeof window.electronAPI.savePreset === 'function');
    }

    async listPresets() {
      if (this.isElectron) {
        return await window.electronAPI.listPresets();
      }
      if (window.presetService) {
        return await window.presetService.getAllLocal();
      }
      return [];
    }

    async getPreset(id) {
      if (this.isElectron) {
        return await window.electronAPI.getPreset(id);
      }
      if (window.presetService) {
        const presets = await window.presetService.getAllLocal();
        return presets.find((p) => p.id === id) || null;
      }
      return null;
    }

    async savePreset(preset) {
      if (this.isElectron) {
        return await window.electronAPI.savePreset(preset);
      }
      if (window.presetService) {
        return await window.presetService.savePreset(preset);
      }
    }

    async deletePreset(id) {
      if (this.isElectron) {
        return await window.electronAPI.deletePreset(id);
      }
      if (window.presetService) {
        return await window.presetService.deletePreset(id);
      }
    }
  }

  // active adapter provider
  window.storageAdapter = new LocalStorageAdapter();
})();

