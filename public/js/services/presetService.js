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
  const MAX_PRESET_BYTES = 50 * 1024 * 1024;

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
      const prev = this.inMemoryCache.get(preset.id);
      const db = await openDatabase();
      if (!db) {
        this.inMemoryCache.set(preset.id, preset);
        return;
      }
      return new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.put(preset);
          tx.oncomplete = () => {
            this.inMemoryCache.set(preset.id, preset);
            resolve();
          };
          tx.onerror = () => {
            if (prev !== undefined) this.inMemoryCache.set(preset.id, prev);
            reject(tx.error || new Error('browser storage write failed (quota may be full)'));
          };
          tx.onabort = () => {
            if (prev !== undefined) this.inMemoryCache.set(preset.id, prev);
            reject(tx.error || new Error('browser storage transaction aborted'));
          };
        } catch (err) {
          if (prev !== undefined) this.inMemoryCache.set(preset.id, prev);
          reject(err);
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
      const localMap = new Map();
      localPresets.forEach((p) => {
        localMap.set(p.id, p);
        this.inMemoryCache.set(p.id, p);
        if (window.templateRegistry) {
          window.templateRegistry.registerPreset(p);
        }
      });

      // 2. sync from storage adapter (electron disk folder or backend api) without clobbering newer local saves
      try {
        if (window.storageAdapter && typeof window.storageAdapter.listPresets === 'function') {
          const remoteList = await window.storageAdapter.listPresets();
          const remoteIds = new Set();
          for (const p of (Array.isArray(remoteList) ? remoteList : [])) {
            if (!p || !p.id) continue;
            remoteIds.add(p.id);
            const existingLocal = localMap.get(p.id);
            const remoteTs = Date.parse(p?.meta?.updatedAt || 0) || 0;
            const localTs = Date.parse(existingLocal?.meta?.updatedAt || 0) || 0;
            if (existingLocal && localTs > remoteTs && !window.storageAdapter.isElectron) {
              continue;
            }
            await this.saveLocal(p);
            if (window.templateRegistry) {
              window.templateRegistry.registerPreset(p);
            }
          }
          // in desktop mode, disk folder ~/Documents/SampleVis/Presets is authoritative
          if (window.storageAdapter.isElectron) {
            for (const localPreset of localPresets) {
              if (!localPreset?.id || remoteIds.has(localPreset.id)) continue;
              await this.deleteLocal(localPreset.id);
              if (window.templateRegistry?.templates) {
                window.templateRegistry.templates.delete(localPreset.id);
              }
            }
          }
        }
      } catch (err) {
        console.warn('[PresetService] Storage adapter sync offline or unavailable:', err.message);
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

    /**
     * Lets an installed media vault resolve remote slot refs into local ones before the studio
     * renders. A no-op when the build has no vault: local refs are already what the engine wants.
     */
    async hydrateMedia(preset) {
      const vault = window.projectVault;
      if (!preset || typeof vault?.hydrate !== 'function') return preset;
      return vault.hydrate(preset);
    }

    async getPresetById(id) {
      if (!id) return null;
      if (this.inMemoryCache.has(id)) {
        return this.inMemoryCache.get(id);
      }

      const localPresets = await this.getAllLocal();
      const foundLocal = localPresets.find((p) => p.id === id);
      if (foundLocal) {
        const hydrated = await this.hydrateMedia(foundLocal);
        if (hydrated !== foundLocal) {
          await this.saveLocal(hydrated);
        }
        this.inMemoryCache.set(hydrated.id, hydrated);
        if (window.templateRegistry) {
          window.templateRegistry.registerPreset(hydrated);
        }
        return hydrated;
      }

      try {
        if (window.storageAdapter && typeof window.storageAdapter.getPreset === 'function') {
          const fetched = await window.storageAdapter.getPreset(id);
          if (fetched && fetched.id) {
            const hydrated = await this.hydrateMedia(fetched);
            await this.saveLocal(hydrated);
            if (window.templateRegistry) {
              window.templateRegistry.registerPreset(hydrated);
            }
            return hydrated;
          }
        }
      } catch (err) {
        console.warn('[PresetService] Storage adapter getPreset failed:', err.message);
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
          const officialTpl = window.STARTER_PRESET_DEFINITIONS?.[id] || window.STARTER_PRESETS?.[id];
          const sourceName = officialTpl?.meta?.name || officialTpl?.name || presetData.meta?.name || id;
          forkedFrom = {
            id,
            name: sourceName,
            author: presetData.meta?.author || 'official'
          };
        }
        id = this.generatePresetId(12);
      }

      const bundleSvc = typeof window !== 'undefined' ? window.projectBundleService : null;
      if (bundleSvc && rawId && rawId !== id && typeof bundleSvc.migratePresetMedia === 'function') {
        await bundleSvc.migratePresetMedia(rawId, id);
      }

      const capturedThumb = canvasEl ? this.captureThumbnail(canvasEl) : null;
      const thumbnail = capturedThumb ||
        (typeof presetData.meta?.thumbnail === 'string' && presetData.meta.thumbnail.startsWith('data:image/')
          ? presetData.meta.thumbnail
          : null);

      const controlFields = Array.isArray(presetData.controlsBox?.fields) ? presetData.controlsBox.fields : [];
      const controlValues = presetData.controlsBox?.values && typeof presetData.controlsBox.values === 'object'
        ? { ...presetData.controlsBox.values }
        : {};
      controlFields.forEach((f) => {
        if (f && f.id && controlValues[f.id] === undefined && f.defaultValue !== undefined) {
          controlValues[f.id] = f.defaultValue;
        }
      });

      // keep uploaded media slots in indexeddb and replace inline blobs with lightweight idb:// refs
      for (const f of controlFields) {
        if (!f) continue;
        if (f.type === 'media_pool' && Array.isArray(controlValues[f.id])) {
          controlValues[f.id] = controlValues[f.id].map((item, idx) => {
            if (!item || typeof item !== 'object') return item;
            if (bundleSvc && typeof item.src === 'string' && item.src.startsWith('idb://')) {
              const parsed = bundleSvc.parseIdbRef?.(item.src);
              const slotId = parsed?.slotId || `${f.id}__${item.id || idx}`;
              return { ...item, src: bundleSvc.makeIdbRef(id, slotId) };
            }
            return { ...item };
          });
          continue;
        }
        if (f.type !== 'image' && f.type !== 'video') continue;
        const val = controlValues[f.id];
        if (typeof val !== 'string' || !val) continue;
        if (bundleSvc && val.startsWith('data:')) {
          const blob = bundleSvc.dataUrlToBlob(val);
          if (blob) {
            const savedSlot = await bundleSvc.saveSlotMedia(id, f.id, blob, {
              kind: f.type,
              name: `${f.id}.${f.type === 'video' ? 'mp4' : 'png'}`,
              mimeType: blob.type
            });
            if (savedSlot?.idbRef) controlValues[f.id] = savedSlot.idbRef;
          }
        } else if (bundleSvc && val.startsWith('idb://')) {
          const parsed = bundleSvc.parseIdbRef?.(val);
          controlValues[f.id] = bundleSvc.makeIdbRef(id, parsed?.slotId || f.id);
        }
      }

      let normalizedCustomImage = null;
      const rawCustomImage = presetData.assets?.customImage;
      if (typeof rawCustomImage === 'string' && rawCustomImage) {
        if (rawCustomImage.startsWith('data:image/')) {
          if (bundleSvc) {
            const blob = bundleSvc.dataUrlToBlob(rawCustomImage);
            if (blob) {
              const savedCustom = await bundleSvc.saveSlotMedia(id, 'customImage', blob, {
                kind: 'image',
                name: 'customImage.png',
                mimeType: blob.type || 'image/png'
              });
              normalizedCustomImage = savedCustom?.idbRef || null;
            }
          } else {
            normalizedCustomImage = rawCustomImage;
          }
        } else if (rawCustomImage.startsWith('idb://') && bundleSvc) {
          normalizedCustomImage = bundleSvc.makeIdbRef(id, 'customImage');
        }
      }

      const fontDataUrlRe = /^data:(?:font\/[a-z0-9.+-]+|application\/(?:font-[a-z0-9.+-]+|x-font-[a-z0-9.+-]+|vnd\.ms-fontobject|octet-stream));base64,/i;
      const normalizedCustomFonts = Array.isArray(presetData.assets?.customFonts)
        ? presetData.assets.customFonts
          .filter((f) => (
            f &&
            typeof f.family === 'string' &&
            f.family.trim() &&
            typeof f.dataUrl === 'string' &&
            f.dataUrl.length <= 8 * 1024 * 1024 &&
            fontDataUrlRe.test(f.dataUrl)
          ))
          .slice(0, 12)
          .map((f) => ({
            family: f.family.trim().slice(0, 120),
            ...(f.name ? { name: String(f.name).slice(0, 160) } : {}),
            ...(f.mimeType ? { mimeType: String(f.mimeType).slice(0, 80) } : {}),
            dataUrl: f.dataUrl
          }))
        : [];

      const starterPresetId =
        presetData.meta?.starterPresetId ||
        (forkedFrom?.id && this.isOfficialOrReadOnly(forkedFrom.id) ? forkedFrom.id : null);

      const rawNotes = typeof presetData.meta?.notes === 'string' ? presetData.meta.notes : '';
      const normalizedNotes = typeof window !== 'undefined' && window.ByokAiProvider?.normalizeProjectNotes
        ? window.ByokAiProvider.normalizeProjectNotes(rawNotes)
        : rawNotes.replace(/\r\n?/g, '\n').trim().split('\n').slice(0, 100).join('\n').slice(0, 4000).trimEnd();

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
          ...(starterPresetId ? { starterPresetId } : {}),
          ...(normalizedNotes ? { notes: normalizedNotes } : {}),
          thumbnail,
          createdAt: forkedFrom ? new Date().toISOString() : (presetData.meta?.createdAt || new Date().toISOString()),
          updatedAt: new Date().toISOString()
        },
        modules: presetData.modules && typeof presetData.modules === 'object'
          ? JSON.parse(JSON.stringify(presetData.modules))
          : {},
        features: presetData.features
          ? JSON.parse(JSON.stringify(presetData.features))
          : undefined,
        shaderBox: {
          fragmentShader: presetData.shaderBox?.fragmentShader || '',
          ...(typeof presetData.shaderBox?.postShader === 'string' && presetData.shaderBox.postShader.trim()
            ? { postShader: presetData.shaderBox.postShader }
            : {})
        },
        frontUiBox: {
          initScript: presetData.frontUiBox?.initScript || '',
          drawScript: presetData.frontUiBox?.drawScript || ''
        },
        controlsBox: {
          fields: JSON.parse(JSON.stringify(controlFields)),
          values: controlValues
        },
        ...(presetData.projectState && typeof presetData.projectState === 'object'
          ? { projectState: JSON.parse(JSON.stringify(presetData.projectState)) }
          : {}),
        ...((normalizedCustomImage || normalizedCustomFonts.length > 0)
          ? {
            assets: {
              ...(normalizedCustomImage ? { customImage: normalizedCustomImage } : {}),
              ...(normalizedCustomFonts.length > 0 ? { customFonts: normalizedCustomFonts } : {})
            }
          }
          : {})
      };

      const serialized = JSON.stringify(normalized);
      const payloadBytes = typeof Blob === 'function' ? new Blob([serialized]).size : serialized.length;
      if (payloadBytes > MAX_PRESET_BYTES) {
        const mb = (payloadBytes / (1024 * 1024)).toFixed(1);
        throw new Error(`preset is ${mb} mb, which exceeds the 50 mb save limit. remove or resize embedded images and try again.`);
      }

      // persist to storage adapter (electron disk or backend api) before committing local cache.
      // a refused remote save must never cost the user their work: the local copy is written anyway
      // and the rejection travels back as `remoteError` so the studio can say what happened.
      let savedResult = normalized;
      let remoteError = null;
      if (window.storageAdapter && typeof window.storageAdapter.savePreset === 'function') {
        try {
          const adapterRes = await window.storageAdapter.savePreset(normalized);
          if (adapterRes && adapterRes.id) {
            savedResult = adapterRes;
          }
        } catch (err) {
          if (window.storageAdapter.isElectron) {
            throw err;
          }
          const status = Number(err?.status) || 0;
          remoteError = {
            status,
            code: err?.code || 'remote_save_failed',
            message: status === 413
              ? 'this preset is too large to save - remove or resize its embedded files'
              : (err?.message || 'save failed')
          };
          console.warn('[PresetService] remote save rejected, keeping the local copy:', remoteError.message);
        }
      }

      // commit to indexeddb and clear stale per-preset knob overrides only after validation & storage save succeed
      const localResult = remoteError ? normalized : savedResult;
      await this.saveLocal(localResult);
      try {
        localStorage.removeItem(`samplevis_preset_${id}`);
        localStorage.removeItem(`samplevis_template_${id}`);
      } catch { }

      // register in template registry
      if (window.templateRegistry) {
        window.templateRegistry.registerPreset(localResult);
      }

      this._notify(true);
      return remoteError ? { ...localResult, remoteError } : localResult;
    }

    async duplicatePreset(sourceIdOrPreset, options = {}) {
      let sourcePreset = null;
      if (typeof sourceIdOrPreset === 'string') {
        sourcePreset =
          (await this.getPresetById(sourceIdOrPreset)) ||
          window.STARTER_PRESET_DEFINITIONS?.[sourceIdOrPreset] ||
          window.STARTER_PRESETS?.[sourceIdOrPreset] ||
          window.templateRegistry?.get?.(sourceIdOrPreset)?.preset ||
          null;
      } else if (sourceIdOrPreset && typeof sourceIdOrPreset === 'object') {
        sourcePreset = sourceIdOrPreset;
      }
      if (!sourcePreset) {
        throw new Error('source preset not found');
      }

      const sourceId = sourcePreset.id || options.sourceId || null;
      const newId = this.generatePresetId(12);
      const clone = JSON.parse(JSON.stringify(sourcePreset));
      const baseName = (clone.meta?.name || clone.meta?.title || sourceId || 'untitled preset').trim();
      const targetName = typeof options.name === 'string' && options.name.trim()
        ? options.name.trim()
        : `${baseName} (copy)`;
      const targetDescription = typeof options.description === 'string'
        ? options.description.trim()
        : (clone.meta?.description || 'custom visual preset');
      const includeProjectState = options.includeProjectState !== false;
      if (!includeProjectState) {
        delete clone.projectState;
      }
      const now = new Date().toISOString();

      clone.id = newId;
      clone.meta = {
        ...(clone.meta || {}),
        name: targetName,
        title: targetName,
        description: targetDescription || 'custom visual preset',
        badge: 'Custom',
        ownerId: 'local',
        author: 'local',
        createdAt: now,
        updatedAt: now
      };
      if (sourceId) {
        clone.meta.forkedFrom = {
          id: sourceId,
          name: baseName,
          author: sourcePreset.meta?.author || 'local'
        };
        if (!clone.meta.starterPresetId && this.isOfficialOrReadOnly(sourceId, sourcePreset)) {
          clone.meta.starterPresetId = sourceId;
        }
      }

      const bundleSvc = typeof window !== 'undefined' ? window.projectBundleService : null;
      if (bundleSvc && sourceId && sourceId !== newId && typeof bundleSvc.migratePresetMedia === 'function') {
        await bundleSvc.migratePresetMedia(sourceId, newId, { includeProjectState });
      }

      return await this.savePreset(clone, options.canvasEl || null);
    }

    async deletePreset(id) {
      if (this.isOfficialOrReadOnly(id, null)) {
        throw new Error('Cannot delete built-in official template');
      }
      await this.deleteLocal(id);
      try {
        await window.projectBundleService?.deletePresetData?.(id);
      } catch { }
      try {
        if (window.storageAdapter && typeof window.storageAdapter.deletePreset === 'function') {
          await window.storageAdapter.deletePreset(id);
        }
      } catch (err) {
        console.warn('[PresetService] Could not delete preset via storage adapter:', err.message);
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
      const isZip = /\.zip$/i.test(file.name || '') ||
        file.type === 'application/zip' ||
        file.type === 'application/x-zip-compressed';
      if (isZip) {
        if (!window.projectBundleService?.importProjectZip) {
          throw new Error('zip bundle importer is unavailable.');
        }
        const { preset, projectState } = await window.projectBundleService.importProjectZip(file);
        if (preset && projectState) {
          Object.defineProperty(preset, '__importedProjectState', {
            value: projectState,
            enumerable: false,
            configurable: true
          });
        }
        return preset;
      }
      if (Number.isFinite(file.size) && file.size > MAX_PRESET_BYTES) {
        const mb = (file.size / (1024 * 1024)).toFixed(1);
        throw new Error(`preset file is ${mb} mb, which exceeds the 50 mb import/save limit.`);
      }
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

      // ensure clean id formatting on import
      const baseId = parsed.id || parsed.meta?.name || 'imported-design';
      const cleanId = String(baseId)
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      parsed.id = cleanId || this.generatePresetId(12);

      return await this.savePreset(parsed);
    }
  }

  window.presetService = new PresetService();
})();

