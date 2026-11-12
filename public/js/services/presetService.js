// client-side preset persistence & sync service: indexeddb + rest api + .reel.json import/export
(function () {
  'use strict';

  const DB_NAME = 'samplevis_db';
  const DB_VERSION = 1;
  const STORE_NAME = 'custom_presets';

  let dbPromise = null;

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof window.indexedDB === 'undefined') {
        return resolve(null);
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => {
        console.warn('[PresetService] IndexedDB open error, falling back to in-memory:', e);
        resolve(null);
      };
    });
    return dbPromise;
  }

  class PresetService {
    constructor() {
      this.inMemoryCache = new Map();
      this.listeners = [];
    }

    onPresetsChange(fn) {
      if (typeof fn === 'function') this.listeners.push(fn);
    }

    _notify() {
      this.listeners.forEach((fn) => {
        try {
          fn();
        } catch (err) {
          console.error('[PresetService] Listener error:', err);
        }
      });
    }

    async getAllLocal() {
      const db = await openDatabase();
      if (!db) {
        return Array.from(this.inMemoryCache.values());
      }
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve(Array.from(this.inMemoryCache.values()));
        } catch {
          resolve(Array.from(this.inMemoryCache.values()));
        }
      });
    }

    async saveLocal(preset) {
      if (!preset || !preset.id) return;
      this.inMemoryCache.set(preset.id, preset);
      const db = await openDatabase();
      if (!db) return;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.put(preset);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }

    async deleteLocal(id) {
      this.inMemoryCache.delete(id);
      const db = await openDatabase();
      if (!db) return;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }

    async syncWithBackend() {
      // 1. load indexeddb presets first
      const localPresets = await this.getAllLocal();
      localPresets.forEach((p) => {
        this.inMemoryCache.set(p.id, p);
        if (window.templateRegistry) {
          window.templateRegistry.registerPreset(p);
        }
      });

      // 2. attempt to sync from server api
      try {
        const res = await fetch('/api/presets');
        if (res.ok) {
          const data = await res.json();
          const remoteList = Array.isArray(data.presets) ? data.presets : [];
          for (const p of remoteList) {
            await this.saveLocal(p);
            if (window.templateRegistry) {
              window.templateRegistry.registerPreset(p);
            }
          }
        }
      } catch (err) {
        console.warn('[PresetService] Backend preset sync offline or unavailable:', err.message);
      }

      this._notify();
      return Array.from(this.inMemoryCache.values());
    }

    async savePreset(presetData) {
      if (!presetData || typeof presetData !== 'object') {
        throw new Error('Invalid preset data');
      }

      const rawId = presetData.id || presetData.meta?.name || `custom_${Date.now()}`;
      const id = String(rawId)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');

      const normalized = {
        version: presetData.version || '1.0',
        id,
        meta: {
          name: presetData.meta?.name || id,
          title: presetData.meta?.title || presetData.meta?.name || id,
          description: presetData.meta?.description || 'Custom 3-box visual preset',
          aspectRatio: presetData.meta?.aspectRatio || '9:16',
          badge: presetData.meta?.badge || 'Custom',
          author: presetData.meta?.author || 'local',
          createdAt: presetData.meta?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        features: presetData.features || {
          timeline: {
            markers: [{ id: 'drop', label: 'drop', color: '#83ca90' }]
          }
        },
        shaderBox: {
          fragmentShader: presetData.shaderBox?.fragmentShader || ''
        },
        frontUiBox: {
          initScript: presetData.frontUiBox?.initScript || '',
          drawScript: presetData.frontUiBox?.drawScript || ''
        },
        controlsBox: {
          fields: Array.isArray(presetData.controlsBox?.fields) ? presetData.controlsBox.fields : [],
          values: presetData.controlsBox?.values && typeof presetData.controlsBox.values === 'object' ? presetData.controlsBox.values : {}
        }
      };

      // save to indexeddb immediately
      await this.saveLocal(normalized);

      // sync to server filesystem
      try {
        await fetch('/api/presets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(normalized)
        });
      } catch (err) {
        console.warn('[PresetService] Could not persist preset to backend (saved locally):', err.message);
      }

      // register in template registry
      if (window.templateRegistry) {
        window.templateRegistry.registerPreset(normalized);
      }

      this._notify();
      return normalized;
    }

    async deletePreset(id) {
      await this.deleteLocal(id);
      try {
        await fetch(`/api/presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (err) {
        console.warn('[PresetService] Could not delete preset on backend:', err.message);
      }

      if (window.templateRegistry && window.templateRegistry.templates) {
        window.templateRegistry.templates.delete(id);
      }

      this._notify();
    }

    exportPreset(presetId) {
      let preset = this.inMemoryCache.get(presetId);
      if (!preset && window.templateRegistry) {
        const tpl = window.templateRegistry.get(presetId);
        if (tpl && tpl.preset) preset = tpl.preset;
      }

      if (!preset) {
        alert('Preset could not be found for export.');
        return;
      }

      const jsonStr = JSON.stringify(preset, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${preset.id || 'samplevis-design'}.reel.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async importPresetFile(file) {
      if (!file) return null;
      const text = await file.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new Error('Invalid JSON file format');
      }

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Empty or invalid preset file');
      }

      // ensure id uniqueness if imported from elsewhere
      const baseId = parsed.id || parsed.meta?.name || 'imported-design';
      const cleanId = String(baseId).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      parsed.id = cleanId;

      return await this.savePreset(parsed);
    }
  }

  window.presetService = new PresetService();
})();

