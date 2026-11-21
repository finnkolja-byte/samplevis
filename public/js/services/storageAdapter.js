// storage adapter interface & runtime detection
// routes preset persistence to electron disk ipc (~/Documents/SampleVis/Presets)
// or local http backend (/api/presets)
(function () {
  'use strict';

  class StorageAdapter {
    get mode() {
      return 'abstract';
    }
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

  class LocalStorageAdapter extends StorageAdapter {
    constructor() {
      super();
      this.isElectron = Boolean(window.electronAPI && window.electronAPI.isElectron);
    }

    get mode() {
      return this.isElectron ? 'electron-disk' : 'http-local';
    }

    async listPresets() {
      if (this.isElectron) {
        return await window.electronAPI.listPresets();
      }
      const res = await fetch('/api/presets');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return Array.isArray(data.presets) ? data.presets : [];
    }

    async getPreset(id) {
      if (!id) return null;
      if (this.isElectron) {
        return await window.electronAPI.getPreset(id);
      }
      const res = await fetch(`/api/presets/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data?.preset || null;
    }

    async savePreset(preset) {
      if (this.isElectron) {
        return await window.electronAPI.savePreset(preset);
      }
      const serialized = JSON.stringify(preset);
      const serverRes = await fetch('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: serialized
      });
      if (!serverRes.ok) {
        let serverErrMsg = serverRes.statusText;
        try {
          const rawBody = await serverRes.text();
          const parsedErr = JSON.parse(rawBody);
          serverErrMsg = parsedErr?.error || rawBody || serverErrMsg;
        } catch { }
        const err = new Error(serverErrMsg);
        err.status = serverRes.status;
        throw err;
      }
      const data = await serverRes.json().catch(() => null);
      return data?.preset || preset;
    }

    async deletePreset(id) {
      if (this.isElectron) {
        return await window.electronAPI.deletePreset(id);
      }
      const res = await fetch(`/api/presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json().catch(() => ({ ok: true, id }));
    }

    async openPresetsFolder() {
      if (this.isElectron && typeof window.electronAPI.openPresetsFolder === 'function') {
        return await window.electronAPI.openPresetsFolder();
      }
      return null;
    }
  }

  window.StorageAdapter = StorageAdapter;
  window.storageAdapter = new LocalStorageAdapter();
})();
