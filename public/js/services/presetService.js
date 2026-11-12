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

  const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

  class PresetService {
    constructor() {
      this.inMemoryCache = new Map();
      this.listeners = [];
      this.channel = typeof BroadcastChannel === 'function'
        ? new BroadcastChannel('samplevis_presets')
        : null;
      if (this.channel) {
        this.channel.onmessage = () => {
          this.syncWithBackend();
        };
      }
    }

    generatePresetId(length = 12) {
      let out = '';
      if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        // rejection sampling (248 = 62 * 4) prevents modulo bias
        while (out.length < length) {
          const bytes = new Uint8Array(length);
          crypto.getRandomValues(bytes);
          for (let i = 0; i < bytes.length && out.length < length; i++) {
            if (bytes[i] < 248) {
              out += BASE62_ALPHABET[bytes[i] % 62];
            }
          }
        }
      } else {
        for (let i = 0; i < length; i++) {
          out += BASE62_ALPHABET[Math.floor(Math.random() * 62)];
        }
      }
      return out;
    }

    onPresetsChange(fn) {
      if (typeof fn === 'function') this.listeners.push(fn);
    }

    _notify(broadcast = false) {
      this.listeners.forEach((fn) => {
        try {
          fn();
        } catch (err) {
          console.error('[PresetService] Listener error:', err);
        }
      });
      if (broadcast && this.channel) {
        try {
          this.channel.postMessage({ type: 'PRESETS_UPDATED', ts: Date.now() });
        } catch {
          // ignore closed channel
        }
      }
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

    captureThumbnail(canvas, maxWidth = 360) {
      if (!canvas || !canvas.width || !canvas.height) return null;
      try {
        const scale = Math.min(1, maxWidth / canvas.width);
        const w = Math.max(1, Math.round(canvas.width * scale));
        const h = Math.max(1, Math.round(canvas.height * scale));
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = w;
        thumbCanvas.height = h;
        const ctx = thumbCanvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(canvas, 0, 0, w, h);
        const webp = thumbCanvas.toDataURL('image/webp', 0.74);
        if (webp && webp.startsWith('data:image/webp')) return webp;
        return thumbCanvas.toDataURL('image/jpeg', 0.78);
      } catch (err) {
        console.warn('[PresetService] Thumbnail capture skipped:', err.message);
        return null;
      }
    }

    isOfficialOrReadOnly(id, presetData) {
      if (window.STARTER_PRESET_DEFINITIONS && window.STARTER_PRESET_DEFINITIONS[id]) {
        return true;
      }
      if (window.STARTER_PRESETS && window.STARTER_PRESETS[id]) {
        return true;
      }
      if (presetData?.meta?.ownerId && presetData.meta.ownerId !== 'local') {
        return true;
      }
      return false;
    }

    async getPresetById(id) {
      if (!id) return null;
      if (this.inMemoryCache.has(id)) {
        return this.inMemoryCache.get(id);
      }

      const localPresets = await this.getAllLocal();
      const foundLocal = localPresets.find((p) => p.id === id);
      if (foundLocal) {
        this.inMemoryCache.set(foundLocal.id, foundLocal);
        if (window.templateRegistry) {
          window.templateRegistry.registerPreset(foundLocal);
        }
        return foundLocal;
      }

      try {
        const res = await fetch(`/api/presets/${encodeURIComponent(id)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.preset && data.preset.id) {
            await this.saveLocal(data.preset);
            if (window.templateRegistry) {
              window.templateRegistry.registerPreset(data.preset);
            }
            return data.preset;
          }
        }
      } catch (err) {
        console.warn('[PresetService] Direct fetch preset failed:', err.message);
      }
      return null;
    }

    async savePreset(presetData, canvasEl = null) {
      if (!presetData || typeof presetData !== 'object') {
        throw new Error('Invalid preset data');
      }

      const rawId = presetData.id || this.generatePresetId(12);
      let id = String(rawId)
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');

      // fork-on-save: never overwrite official or another user's template; mint new alphanumeric id
      let forkedFrom = presetData.meta?.forkedFrom || null;
      if (!id || this.isOfficialOrReadOnly(id, presetData)) {
        if (id && this.isOfficialOrReadOnly(id, presetData)) {
          forkedFrom = {
            id,
            name: presetData.meta?.name || id,
            author: presetData.meta?.author || 'official'
          };
        }
        id = this.generatePresetId(12);
      }

      const capturedThumb = canvasEl ? this.captureThumbnail(canvasEl) : null;
      const thumbnail = capturedThumb ||
        (typeof presetData.meta?.thumbnail === 'string' && presetData.meta.thumbnail.startsWith('data:image/')
          ? presetData.meta.thumbnail
          : null);

      const normalized = {
        version: presetData.version || '1.0',
        id,
        meta: {
          name: forkedFrom && (!presetData.meta?.name || presetData.meta.name === forkedFrom.name)
            ? `${forkedFrom.name} (copy)`
            : (presetData.meta?.name || 'Untitled Preset'),
          title: presetData.meta?.title || presetData.meta?.name || 'Untitled Preset',
          description: presetData.meta?.description || 'custom visual preset',
          aspectRatio: presetData.meta?.aspectRatio || '9:16',
          badge: 'Custom',
          ownerId: 'local',
          author: presetData.meta?.author === 'official' ? 'local' : (presetData.meta?.author || 'local'),
          forkedFrom,
          thumbnail,
          createdAt: forkedFrom ? new Date().toISOString() : (presetData.meta?.createdAt || new Date().toISOString()),
          updatedAt: new Date().toISOString()
        },
        modules: presetData.modules && typeof presetData.modules === 'object' ? presetData.modules : {},
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

      this._notify(true);
      return normalized;
    }

    async deletePreset(id) {
      if (this.isOfficialOrReadOnly(id, null)) {
        throw new Error('Cannot delete built-in official template');
      }
      await this.deleteLocal(id);
      try {
        await fetch(`/api/presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (err) {
        console.warn('[PresetService] Could not delete preset on backend:', err.message);
      }

      if (window.templateRegistry && window.templateRegistry.templates) {
        window.templateRegistry.templates.delete(id);
      }

      this._notify(true);
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

