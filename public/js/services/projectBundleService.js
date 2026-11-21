// client-side indexeddb media persistence and portable .samplevis.zip bundle service
(function () {
  'use strict';

  const DB_NAME = 'samplevis_media_db';
  const DB_VERSION = 1;
  const STORE_ASSETS = 'preset_assets';
  const STORE_STATES = 'project_states';
  const STORE_CLIPS = 'clip_cache';

  let dbPromise = null;
  const slotUrlCache = new Map();
  const clipUrlCache = new Map();

  function openMediaDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (typeof window === 'undefined' || typeof window.indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_ASSETS)) {
          db.createObjectStore(STORE_ASSETS, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_STATES)) {
          db.createObjectStore(STORE_STATES, { keyPath: 'presetId' });
        }
        if (!db.objectStoreNames.contains(STORE_CLIPS)) {
          db.createObjectStore(STORE_CLIPS, { keyPath: 'clipId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = (err) => {
        console.warn('[ProjectBundleService] indexeddb unavailable:', err);
        resolve(null);
      };
    });
    return dbPromise;
  }

  function makeAssetKey(presetId, slotId) {
    return `${presetId || 'default'}::${slotId}`;
  }

  function makeIdbRef(presetId, slotId) {
    return `idb://preset/${encodeURIComponent(presetId || 'default')}/${encodeURIComponent(slotId)}`;
  }

  function parseIdbRef(ref) {
    if (typeof ref !== 'string' || !ref.startsWith('idb://preset/')) return null;
    const rest = ref.slice('idb://preset/'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    try {
      return {
        presetId: decodeURIComponent(rest.slice(0, slash)),
        slotId: decodeURIComponent(rest.slice(slash + 1))
      };
    } catch {
      return null;
    }
  }

  function safeFilename(name, fallback = 'file') {
    const clean = String(name || fallback)
      .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 96);
    return clean || fallback;
  }

  function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const header = dataUrl.slice(5, comma);
    const body = dataUrl.slice(comma + 1);
    const isBase64 = /;base64$/i.test(header);
    const mimeType = header.replace(/;base64$/i, '') || 'application/octet-stream';
    if (!isBase64) {
      return new Blob([decodeURIComponent(body)], { type: mimeType });
    }
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      if (!blob) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('could not read blob'));
      reader.readAsDataURL(blob);
    });
  }

  function setCachedSlotEntry(key, record) {
    const prev = slotUrlCache.get(key);
    if (prev && prev.objectUrl && prev.blob !== record.blob) {
      try {
        URL.revokeObjectURL(prev.objectUrl);
      } catch { }
    }
    const objectUrl = prev && prev.blob === record.blob && prev.objectUrl
      ? prev.objectUrl
      : URL.createObjectURL(record.blob);
    const entry = {
      ...record,
      objectUrl
    };
    slotUrlCache.set(key, entry);
    return entry;
  }

  async function materializeBlob(fileOrBlob, mimeType) {
    let blob = fileOrBlob instanceof Blob
      ? fileOrBlob
      : new Blob([fileOrBlob], { type: mimeType || 'application/octet-stream' });
    // materialize browser file handles into self-contained blobs so indexeddb reads never fail across sessions
    if (typeof File === 'function' && blob instanceof File && blob.size <= 150 * 1024 * 1024) {
      try {
        const buf = await blob.arrayBuffer();
        blob = new Blob([buf], { type: mimeType || blob.type || 'application/octet-stream' });
      } catch (err) {
        console.warn('[ProjectBundleService] could not materialize file blob:', err?.message || err);
      }
    }
    return blob;
  }

  function putIdbRecords(db, storeName, records, label) {
    if (!db) return Promise.resolve();
    const list = Array.isArray(records) ? records : [records];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        list.forEach((rec) => store.put(rec));
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          console.warn(`[ProjectBundleService] ${label} save failed:`, tx.error?.message || tx.error);
          resolve();
        };
        tx.onabort = () => {
          console.warn(`[ProjectBundleService] ${label} save aborted:`, tx.error?.message || tx.error);
          resolve();
        };
      } catch (err) {
        console.warn(`[ProjectBundleService] ${label} transaction error:`, err?.message || err);
        resolve();
      }
    });
  }

  async function saveSlotMedia(presetId, slotId, fileOrBlob, meta = {}) {
    if (!slotId || !fileOrBlob) return null;
    const pid = presetId || 'default';
    const key = makeAssetKey(pid, slotId);
    const initialMime = meta.mimeType || fileOrBlob.type || (meta.kind === 'video' ? 'video/mp4' : 'image/png');
    const blob = await materializeBlob(fileOrBlob, initialMime);
    const mimeType = meta.mimeType || blob.type || (meta.kind === 'video' ? 'video/mp4' : 'image/png');
    const kind = meta.kind || (mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'image');
    const name = meta.name || (typeof fileOrBlob.name === 'string' ? fileOrBlob.name : `${slotId}.${kind === 'video' ? 'mp4' : 'png'}`);

    const record = {
      key,
      presetId: pid,
      slotId,
      kind,
      name,
      mimeType,
      blob,
      updatedAt: new Date().toISOString()
    };

    const cached = setCachedSlotEntry(key, record);
    const db = await openMediaDatabase();
    await putIdbRecords(db, STORE_ASSETS, record, 'asset');

    return {
      idbRef: makeIdbRef(pid, slotId),
      objectUrl: cached.objectUrl,
      name,
      mimeType,
      kind,
      size: blob.size
    };
  }

  /**
   * Merges extra fields onto a stored slot record. Used by surfaces that keep their own metadata
   * alongside the bytes (a remote copy of the same file, for one) so the bundle layer does not have
   * to know what that metadata means.
   */
  async function updateSlotMeta(presetId, slotId, patch) {
    if (!slotId || !patch) return null;
    const record = await getSlotMedia(presetId, slotId);
    if (!record?.blob) return null;
    const { objectUrl, ...rest } = record;
    const next = { ...rest, ...patch };
    const db = await openMediaDatabase();
    if (!db) return null;
    await putIdbRecords(db, STORE_ASSETS, next, 'asset');
    // the same-session read path goes through the cache, so it has to learn the patch too
    return setCachedSlotEntry(makeAssetKey(presetId || 'default', slotId), next);
  }

  /**
   * Same for a cached clip: the clip cache is the only place a local upload is identified, so extra
   * metadata rides on that record.
   */
  async function updateClipMeta(clipId, patch) {
    if (!clipId || !patch) return null;
    const record = await getCachedClipRecord(clipId);
    if (!record?.blob) return null;
    const { objectUrl, ...rest } = record;
    const next = { ...rest, ...patch };
    const db = await openMediaDatabase();
    if (!db) return null;
    await putIdbRecords(db, STORE_CLIPS, next, 'clip cache');
    return next;
  }

  async function getSlotMedia(presetId, slotId) {
    if (!slotId) return null;
    const pid = presetId || 'default';
    const key = makeAssetKey(pid, slotId);
    if (slotUrlCache.has(key)) {
      return slotUrlCache.get(key);
    }

    const db = await openMediaDatabase();
    if (!db) return null;

    const record = await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_ASSETS, 'readonly');
        const req = tx.objectStore(STORE_ASSETS).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });

    if (!record || !record.blob) return null;
    return setCachedSlotEntry(key, record);
  }

  async function listPresetMedia(presetId) {
    const pid = presetId || 'default';
    const bySlot = new Map();

    for (const entry of slotUrlCache.values()) {
      if (entry.presetId === pid) {
        bySlot.set(entry.slotId, entry);
      }
    }

    const db = await openMediaDatabase();
    if (db) {
      const all = await new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_ASSETS, 'readonly');
          const req = tx.objectStore(STORE_ASSETS).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });
      for (const rec of all) {
        if (rec && rec.presetId === pid && rec.blob && !bySlot.has(rec.slotId)) {
          const key = makeAssetKey(pid, rec.slotId);
          bySlot.set(rec.slotId, setCachedSlotEntry(key, rec));
        }
      }
    }

    return Array.from(bySlot.values());
  }

  async function deleteSlotMedia(presetId, slotId) {
    if (!slotId) return;
    const pid = presetId || 'default';
    const key = makeAssetKey(pid, slotId);
    const existing = slotUrlCache.get(key);
    if (existing?.objectUrl) {
      try {
        URL.revokeObjectURL(existing.objectUrl);
      } catch { }
    }
    slotUrlCache.delete(key);

    const db = await openMediaDatabase();
    if (!db) return;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_ASSETS, 'readwrite');
        tx.objectStore(STORE_ASSETS).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async function migratePresetMedia(fromPresetId, toPresetId, opts = {}) {
    if (!fromPresetId || !toPresetId || fromPresetId === toPresetId) return;
    const includeProjectState = opts?.includeProjectState !== false;
    const assets = await listPresetMedia(fromPresetId);
    for (const item of assets) {
      if (!includeProjectState && (item.slotId === '__project_audio__' || item.slotId === '__project_midi__')) {
        continue;
      }
      await saveSlotMedia(toPresetId, item.slotId, item.blob, {
        kind: item.kind,
        name: item.name,
        mimeType: item.mimeType
      });
      // metadata the bundle layer does not interpret (a record of where else these bytes live, for
      // one) has to survive an id change, or the migrated project looks unsynced and re-uploads
      // files that are already stored
      const carried = {};
      for (const [key, value] of Object.entries(item)) {
        if (['key', 'presetId', 'slotId', 'kind', 'name', 'mimeType', 'blob', 'objectUrl', 'updatedAt'].includes(key)) continue;
        carried[key] = value;
      }
      if (Object.keys(carried).length > 0) {
        await updateSlotMeta(toPresetId, item.slotId, carried);
      }
    }

    if (!includeProjectState) return;

    const db = await openMediaDatabase();
    if (!db) return;
    const oldState = await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_STATES, 'readonly');
        const req = tx.objectStore(STORE_STATES).get(fromPresetId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });

    if (oldState) {
      const migrated = {
        ...oldState,
        presetId: toPresetId,
        updatedAt: new Date().toISOString()
      };
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_STATES, 'readwrite');
          tx.objectStore(STORE_STATES).put(migrated);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }
  }

  async function cacheClipBlob(clipId, fileOrBlob, meta = {}) {
    if (!clipId || !fileOrBlob) return null;
    const mimeType = meta.mimeType || fileOrBlob.type || 'video/mp4';
    const blob = await materializeBlob(fileOrBlob, mimeType);
    const record = {
      clipId: String(clipId),
      title: meta.title || String(clipId),
      vibe: meta.vibe || 'custom',
      source: meta.source || 'local',
      tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 16) : [],
      mimeType,
      blob,
      updatedAt: new Date().toISOString()
    };

    const prevUrl = clipUrlCache.get(record.clipId);
    if (prevUrl) {
      try {
        URL.revokeObjectURL(prevUrl);
      } catch { }
    }
    const objectUrl = URL.createObjectURL(blob);
    clipUrlCache.set(record.clipId, objectUrl);

    const db = await openMediaDatabase();
    await putIdbRecords(db, STORE_CLIPS, record, 'clip cache');

    return {
      ...record,
      objectUrl
    };
  }

  async function getCachedClipRecord(clipId) {
    if (!clipId) return null;
    const db = await openMediaDatabase();
    if (!db) return null;
    const record = await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_CLIPS, 'readonly');
        const req = tx.objectStore(STORE_CLIPS).get(String(clipId));
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    if (!record || !record.blob) return null;
    let objectUrl = clipUrlCache.get(record.clipId);
    if (!objectUrl) {
      objectUrl = URL.createObjectURL(record.blob);
      clipUrlCache.set(record.clipId, objectUrl);
    }
    return { ...record, objectUrl };
  }

  async function getCachedClipUrl(clipId) {
    if (!clipId) return null;
    if (clipUrlCache.has(String(clipId))) {
      return clipUrlCache.get(String(clipId));
    }
    const rec = await getCachedClipRecord(clipId);
    return rec?.objectUrl || null;
  }

  async function listCachedClips() {
    const db = await openMediaDatabase();
    if (!db) return [];
    const all = await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_CLIPS, 'readonly');
        const req = tx.objectStore(STORE_CLIPS).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
    return all
      .filter((rec) => rec && rec.clipId && rec.blob)
      .map((rec) => {
        let objectUrl = clipUrlCache.get(rec.clipId);
        if (!objectUrl) {
          objectUrl = URL.createObjectURL(rec.blob);
          clipUrlCache.set(rec.clipId, objectUrl);
        }
        return { ...rec, objectUrl };
      });
  }

  const STATE_CHECKPOINT_SUFFIX = '::saved';

  function makeStateCheckpointKey(presetId) {
    return `${presetId}${STATE_CHECKPOINT_SUFFIX}`;
  }

  function normalizePlaylistsByCutMode(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const [mode, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.ids)) continue;
      const ids = entry.ids.filter((id) => typeof id === 'string' && id.length > 0);
      const starts = Array.isArray(entry.startTimes) ? entry.startTimes : [];
      const ends = Array.isArray(entry.endTimes) ? entry.endTimes : [];
      const speeds = Array.isArray(entry.speeds) ? entry.speeds : [];
      out[mode] = {
        ids,
        startTimes: ids.map((_, i) => Math.max(0, Number(starts[i]) || 0)),
        endTimes: ids.map((_, i) => (ends[i] !== null && ends[i] !== undefined && Number(ends[i]) > 0 ? Number(ends[i]) : null)),
        speeds: ids.map((_, i) => Math.round(Math.max(25, Math.min(400, Number(speeds[i]) || 100))))
      };
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  async function saveProjectState(presetId, payload = {}, opts = {}) {
    if (!presetId) return;
    if (payload.audioBlob instanceof Blob) {
      await saveSlotMedia(presetId, '__project_audio__', payload.audioBlob, {
        kind: 'audio',
        name: payload.audioName || 'sample.wav',
        mimeType: payload.audioBlob.type || 'audio/wav'
      });
    }
    if (payload.midiBlob instanceof Blob) {
      await saveSlotMedia(presetId, '__project_midi__', payload.midiBlob, {
        kind: 'midi',
        name: payload.midiName || 'project.mid',
        mimeType: payload.midiBlob.type || 'application/octet-stream'
      });
    }

    function serializeClipMeta(c) {
      return {
        id: c.id,
        sourceId: c.sourceId || c.id,
        title: c.title || 'clip',
        vibe: c.vibe || 'custom',
        source: c.source || (c.isLocal ? 'local' : 'remote'),
        isLocal: Boolean(c.isLocal || c.source === 'local'),
        streamOnly: Boolean(c.streamOnly),
        _archivedFromPicker: Boolean(c._archivedFromPicker),
        url: (c.isLocal || c.source === 'local') ? null : (c.url || null),
        remoteUrl: c.remoteUrl || null,
        manualFocalX: c.manualFocalX,
        startTime: Number.isFinite(c.startTime) ? Number(c.startTime) : 0,
        favorite: Boolean(c.favorite),
        favoritedAt: c.favoritedAt || null,
        addedAt: c.addedAt || null,
        fetchedAt: c.fetchedAt || null,
        matchedQuery: c.matchedQuery || null,
        score: c.score,
        width: c.width,
        height: c.height,
        tags: Array.isArray(c.tags) ? c.tags.slice(0, 40) : []
      };
    }

    const customClipsMeta = Array.isArray(payload.customClips)
      ? payload.customClips.map(serializeClipMeta)
      : [];
    const favoriteClipsMeta = Array.isArray(payload.favoriteClips)
      ? payload.favoriteClips.map((c) => serializeClipMeta({ ...c, favorite: true }))
      : [];

    const db = await openMediaDatabase();
    if (!db) return;

    const record = {
      presetId,
      projectMeta: payload.projectMeta ? JSON.parse(JSON.stringify(payload.projectMeta)) : null,
      lyricsData: payload.lyricsData ? JSON.parse(JSON.stringify(payload.lyricsData)) : null,
      selectedClipIds: Array.isArray(payload.selectedClipIds) ? [...payload.selectedClipIds] : null,
      selectedClipStartTimes: Array.isArray(payload.selectedClipIds) && Array.isArray(payload.selectedClipStartTimes)
        ? payload.selectedClipStartTimes.map((n) => Math.max(0, Number(n) || 0))
        : null,
      selectedClipEndTimes: Array.isArray(payload.selectedClipIds) && Array.isArray(payload.selectedClipEndTimes)
        ? payload.selectedClipEndTimes.map((n) => (n !== null && n !== undefined && Number(n) > 0 ? Number(n) : null))
        : null,
      selectedClipSpeeds: Array.isArray(payload.selectedClipIds) && Array.isArray(payload.selectedClipSpeeds)
        ? payload.selectedClipSpeeds.map((n) => Math.round(Math.max(25, Math.min(400, Number(n) || 100))))
        : null,
      playlistsByCutMode: normalizePlaylistsByCutMode(payload.playlistsByCutMode),
      customClipsMeta,
      favoriteClips: favoriteClipsMeta,
      clipSource: typeof payload.clipSource === 'string' ? payload.clipSource : null,
      clipQuery: typeof payload.clipQuery === 'string' ? payload.clipQuery : null,
      audioFileName: payload.audioName || null,
      midiFileName: payload.midiName || null,
      updatedAt: new Date().toISOString()
    };

    const recordsToSave = opts?.checkpoint
      ? [record, { ...record, presetId: makeStateCheckpointKey(presetId) }]
      : [record];
    await putIdbRecords(db, STORE_STATES, recordsToSave, 'project state');
  }

  async function loadProjectState(presetId, opts = {}) {
    if (!presetId) return null;
    const isCheckpoint = Boolean(opts?.checkpoint);
    const stateKey = isCheckpoint ? makeStateCheckpointKey(presetId) : presetId;
    const db = await openMediaDatabase();
    let saved = null;
    if (db) {
      saved = await new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_STATES, 'readonly');
          const req = tx.objectStore(STORE_STATES).get(stateKey);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    if (isCheckpoint && !saved) {
      return null;
    }

    const mediaList = await listPresetMedia(presetId);
    const slotAssets = {};
    let audioAsset = null;
    let midiAsset = null;
    for (const item of mediaList) {
      if (item.slotId === '__project_audio__') {
        audioAsset = item;
      } else if (item.slotId === '__project_midi__') {
        midiAsset = item;
      } else {
        slotAssets[item.slotId] = item;
      }
    }

    const customClips = [];
    if (saved && Array.isArray(saved.customClipsMeta)) {
      for (const meta of saved.customClipsMeta) {
        if (!meta || !meta.id) continue;
        const cachedUrl = await getCachedClipUrl(meta.id);
        const isTrulyLocal = Boolean(meta.isLocal || meta.source === 'local');
        if (cachedUrl) {
          customClips.push({
            ...meta,
            url: cachedUrl,
            isLocal: isTrulyLocal
          });
        } else {
          const remoteFallback =
            meta.url ||
            (meta.remoteUrl ? `/api/clips/stream?url=${encodeURIComponent(meta.remoteUrl)}` : null);
          if (remoteFallback) {
            customClips.push({
              ...meta,
              url: remoteFallback,
              isLocal: isTrulyLocal
            });
          }
        }
      }
    }

    const favoriteClips = [];
    if (saved && Array.isArray(saved.favoriteClips)) {
      for (const meta of saved.favoriteClips) {
        if (!meta || !meta.id) continue;
        const cachedUrl = await getCachedClipUrl(meta.id);
        const resolvedUrl =
          cachedUrl ||
          meta.url ||
          (meta.remoteUrl ? `/api/clips/stream?url=${encodeURIComponent(meta.remoteUrl)}` : null);
        if (resolvedUrl) {
          favoriteClips.push({
            ...meta,
            url: resolvedUrl,
            favorite: true
          });
        }
      }
    }

    if (!saved && Object.keys(slotAssets).length === 0 && !audioAsset && !midiAsset) {
      return null;
    }

    return {
      ...(saved || { presetId }),
      presetId,
      slotAssets,
      audioAsset,
      midiAsset,
      customClips,
      favoriteClips
    };
  }

  async function ensureProjectStateCheckpoint(presetId) {
    if (!presetId) return false;
    const db = await openMediaDatabase();
    if (!db) return false;
    const checkpointKey = makeStateCheckpointKey(presetId);
    return new Promise((resolve) => {
      let hasCheckpoint = false;
      try {
        const tx = db.transaction(STORE_STATES, 'readwrite');
        const store = tx.objectStore(STORE_STATES);
        const cpReq = store.get(checkpointKey);
        cpReq.onsuccess = () => {
          if (cpReq.result) {
            hasCheckpoint = true;
            return;
          }
          const draftReq = store.get(presetId);
          draftReq.onsuccess = () => {
            if (!draftReq.result) return;
            hasCheckpoint = true;
            store.put({
              ...draftReq.result,
              presetId: checkpointKey
            });
          };
        };
        tx.oncomplete = () => resolve(hasCheckpoint);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  async function revertProjectStateToCheckpoint(presetId) {
    if (!presetId) return null;
    const db = await openMediaDatabase();
    if (db) {
      const checkpointKey = makeStateCheckpointKey(presetId);
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_STATES, 'readwrite');
          const store = tx.objectStore(STORE_STATES);
          const cpReq = store.get(checkpointKey);
          cpReq.onsuccess = () => {
            if (cpReq.result) {
              store.put({
                ...cpReq.result,
                presetId
              });
            } else {
              store.delete(presetId);
            }
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }
    return loadProjectState(presetId);
  }

  async function deletePresetData(presetId) {
    if (!presetId) return;
    const media = await listPresetMedia(presetId);
    for (const item of media) {
      await deleteSlotMedia(presetId, item.slotId);
    }
    const db = await openMediaDatabase();
    if (!db) return;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_STATES, 'readwrite');
        const store = tx.objectStore(STORE_STATES);
        store.delete(presetId);
        store.delete(makeStateCheckpointKey(presetId));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async function hasCustomMedia(presetId, presetObj = null, appState = null) {
    if (presetObj?.assets?.customImage) {
      const ci = String(presetObj.assets.customImage);
      if (ci.startsWith('data:image/') || ci.startsWith('idb://') || ci.startsWith('blob:')) {
        return true;
      }
    }
    const fields = Array.isArray(presetObj?.controlsBox?.fields) ? presetObj.controlsBox.fields : [];
    const values = presetObj?.controlsBox?.values || {};
    for (const f of fields) {
      if (f && (f.type === 'image' || f.type === 'video') && values[f.id]) {
        return true;
      }
      if (f && f.type === 'media_pool' && Array.isArray(values[f.id]) && values[f.id].length > 0) {
        return true;
      }
    }
    if (appState?.hasCustomAudio || appState?.hasCustomMidi) {
      return true;
    }
    if (appState?.project?.audioUrl?.startsWith('blob:') && !appState?.project?.serverAudioUrl) {
      return true;
    }
    const selectedIds = new Set(appState?.selectedClipIds || []);
    if (Array.isArray(appState?.clips)) {
      for (const c of appState.clips) {
        if ((c.isLocal || c.source === 'local') && (selectedIds.size === 0 || selectedIds.has(c.id))) {
          return true;
        }
      }
    }
    if (presetId) {
      const assets = await listPresetMedia(presetId);
      if (assets.some((a) => a && a.blob && a.blob.size > 0)) {
        return true;
      }
    }
    return false;
  }

  // ieee 802.3 crc32 lookup table for standard pkzip containers
  const CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC_TABLE[i] = c >>> 0;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function toDosTimeDate(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime =
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      ((date.getSeconds() >> 1) & 0x1f);
    const dosDate =
      (((year - 1980) & 0x7f) << 9) |
      (((date.getMonth() + 1) & 0x0f) << 5) |
      (date.getDate() & 0x1f);
    return { dosTime, dosDate };
  }

  async function buildZipBlob(entries) {
    const encoder = new TextEncoder();
    const { dosTime, dosDate } = toDosTimeDate();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBytes = encoder.encode(String(entry.path));
      let dataBytes;
      if (entry.data instanceof Uint8Array) {
        dataBytes = entry.data;
      } else if (entry.data instanceof Blob) {
        dataBytes = new Uint8Array(await entry.data.arrayBuffer());
      } else {
        dataBytes = encoder.encode(typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2));
      }

      const crc = crc32(dataBytes);
      const size = dataBytes.length;

      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      localHeader.set(nameBytes, 30);

      localParts.push(localHeader, dataBytes);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(centralHeader.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);

      centralParts.push(centralHeader);
      offset += localHeader.length + size;
    }

    const centralOffset = offset;
    let centralSize = 0;
    for (const part of centralParts) centralSize += part.length;

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralOffset, true);
    ev.setUint16(20, 0, true);

    return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
  }

  async function parseZipFile(fileOrBuffer) {
    const buffer = fileOrBuffer instanceof ArrayBuffer
      ? fileOrBuffer
      : await fileOrBuffer.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const decoder = new TextDecoder('utf-8');

    let eocdOffset = -1;
    const minSearch = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= minSearch; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) {
      throw new Error('invalid .zip archive (missing central directory)');
    }

    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const result = new Map();

    let ptr = cdOffset;
    for (let idx = 0; idx < totalEntries; idx++) {
      if (ptr + 46 > bytes.length || view.getUint32(ptr, true) !== 0x02014b50) {
        throw new Error('corrupted .zip central directory header');
      }
      const method = view.getUint16(ptr + 10, true);
      const compSize = view.getUint32(ptr + 20, true);
      const nameLen = view.getUint16(ptr + 28, true);
      const extraLen = view.getUint16(ptr + 30, true);
      const commentLen = view.getUint16(ptr + 32, true);
      const localOffset = view.getUint32(ptr + 42, true);
      const path = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
      ptr += 46 + nameLen + extraLen + commentLen;

      if (path.endsWith('/')) continue;
      if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error(`corrupted local file header for "${path}"`);
      }

      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const slice = bytes.subarray(dataStart, dataStart + compSize);

      let outBytes;
      if (method === 0) {
        outBytes = new Uint8Array(slice);
      } else if (method === 8) {
        if (typeof DecompressionStream !== 'function') {
          throw new Error('browser lacks deflate decompression support for compressed .zip files');
        }
        const stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const ab = await new Response(stream).arrayBuffer();
        outBytes = new Uint8Array(ab);
      } else {
        throw new Error(`unsupported zip compression method (${method}) for "${path}"`);
      }
      result.set(path, outBytes);
    }

    return result;
  }

  async function exportProjectZip({
    preset,
    project,
    lyricsData = null,
    selectedClipIds = [],
    selectedClipStartTimes = [],
    selectedClipEndTimes = [],
    selectedClipSpeeds = [],
    playlistsByCutMode = null,
    clips = [],
    favoriteClips = [],
    clipSource = null,
    clipQuery = null,
    audioBlob = null,
    audioName = null,
    midiBlob = null,
    midiName = null
  }) {
    if (!preset || typeof preset !== 'object') {
      throw new Error('no active preset to export');
    }

    const presetCopy = JSON.parse(JSON.stringify(preset));
    const presetId = presetCopy.id || presetCopy.meta?.name || 'default';
    const entries = [];
    const slotManifest = [];
    const seenSlots = new Set();

    const storedAssets = await listPresetMedia(presetId);
    for (const item of storedAssets) {
      if (item.slotId === '__project_audio__' || item.slotId === '__project_midi__') continue;
      const filename = safeFilename(item.name, `${item.slotId}.bin`);
      const zipPath = `media/${item.slotId}__${filename}`;
      entries.push({ path: zipPath, data: item.blob });
      slotManifest.push({
        slotId: item.slotId,
        kind: item.kind,
        name: item.name,
        mimeType: item.mimeType,
        zipPath
      });
      seenSlots.add(item.slotId);
    }

    if (!seenSlots.has('customImage') && typeof presetCopy.assets?.customImage === 'string' && presetCopy.assets.customImage.startsWith('data:')) {
      const blob = dataUrlToBlob(presetCopy.assets.customImage);
      if (blob) {
        const zipPath = 'media/customImage__customImage.png';
        entries.push({ path: zipPath, data: blob });
        slotManifest.push({
          slotId: 'customImage',
          kind: 'image',
          name: 'customImage.png',
          mimeType: blob.type || 'image/png',
          zipPath
        });
        presetCopy.assets.customImage = makeIdbRef(presetId, 'customImage');
      }
    }

    const fields = Array.isArray(presetCopy.controlsBox?.fields) ? presetCopy.controlsBox.fields : [];
    const values = presetCopy.controlsBox?.values || {};
    for (const field of fields) {
      if (!field) continue;
      if (field.type === 'media_pool' && Array.isArray(values[field.id])) {
        values[field.id] = values[field.id].map((item, idx) => {
          if (!item || typeof item !== 'object') return item;
          const nextItem = { ...item };
          if (typeof nextItem.src === 'string' && nextItem.src.startsWith('data:') && !nextItem.src.startsWith('data:image/svg+xml')) {
            const slotId = `${field.id}__${nextItem.id || idx}`;
            if (!seenSlots.has(slotId)) {
              const blob = dataUrlToBlob(nextItem.src);
              if (blob) {
                const ext = nextItem.kind === 'video' ? 'mp4' : 'png';
                const zipPath = `media/${slotId}.${ext}`;
                entries.push({ path: zipPath, data: blob });
                slotManifest.push({
                  slotId,
                  kind: nextItem.kind || 'image',
                  name: nextItem.name || `${slotId}.${ext}`,
                  mimeType: blob.type || (nextItem.kind === 'video' ? 'video/mp4' : 'image/png'),
                  zipPath
                });
                seenSlots.add(slotId);
                nextItem.src = makeIdbRef(presetId, slotId);
              }
            }
          }
          return nextItem;
        });
        continue;
      }
      if (field.type !== 'image' && field.type !== 'video') continue;
      const val = values[field.id];
      if (!seenSlots.has(field.id) && typeof val === 'string' && val.startsWith('data:')) {
        const blob = dataUrlToBlob(val);
        if (blob) {
          const ext = field.type === 'video' ? 'mp4' : 'png';
          const zipPath = `media/${field.id}__${field.id}.${ext}`;
          entries.push({ path: zipPath, data: blob });
          slotManifest.push({
            slotId: field.id,
            kind: field.type,
            name: `${field.id}.${ext}`,
            mimeType: blob.type || (field.type === 'video' ? 'video/mp4' : 'image/png'),
            zipPath
          });
          values[field.id] = makeIdbRef(presetId, field.id);
        }
      }
    }

    // bundle selected, favorited, or local clips when clips module is enabled for this preset
    const clipPickerEnabled = presetCopy.modules?.clipPicker?.enabled === true || presetCopy.modules?.clips?.enabled === true;
    const normalizedPlaylistsByMode = clipPickerEnabled ? normalizePlaylistsByCutMode(playlistsByCutMode) : null;
    const selectedSet = new Set(clipPickerEnabled ? (selectedClipIds || []) : []);
    if (normalizedPlaylistsByMode) {
      Object.values(normalizedPlaylistsByMode).forEach((pl) => {
        (pl?.ids || []).forEach((id) => selectedSet.add(id));
      });
    }
    const favoriteList = Array.isArray(favoriteClips) ? favoriteClips : [];
    const favoriteSet = new Set(favoriteList.map((c) => c?.id).filter(Boolean));
    const clipsMeta = [];
    const bundledClipIds = new Set();
    const pickerClipSet = new Set((Array.isArray(clips) ? clips : []).map((c) => c?.id).filter(Boolean));
    const allCandidateClips = [];
    for (const c of [...(Array.isArray(clips) ? clips : []), ...favoriteList]) {
      if (!c || !c.id || bundledClipIds.has(c.id)) continue;
      bundledClipIds.add(c.id);
      allCandidateClips.push(c);
    }
    if (clipPickerEnabled) {
      for (const clip of allCandidateClips) {
        const includeClip = clip.isLocal || clip.source === 'local' || selectedSet.has(clip.id) || favoriteSet.has(clip.id);
        if (!includeClip) continue;

        let clipBlob = null;
        const cached = await getCachedClipRecord(clip.id);
        if (cached?.blob) {
          clipBlob = cached.blob;
        } else if (clip.url && (clip.url.startsWith('blob:') || clip.url.startsWith('/'))) {
          try {
            const res = await fetch(clip.url);
            if (res.ok) {
              clipBlob = await res.blob();
              await cacheClipBlob(clip.id, clipBlob, {
                title: clip.title,
                vibe: clip.vibe,
                source: clip.source || 'remote',
                tags: clip.tags
              });
            }
          } catch { }
        }

        if (clipBlob) {
          const ext = (clipBlob.type || '').includes('webm') ? 'webm' : 'mp4';
          const zipPath = `clips/${safeFilename(clip.id, 'clip')}.${ext}`;
          entries.push({ path: zipPath, data: clipBlob });
          clipsMeta.push({
            id: clip.id,
            sourceId: clip.sourceId || clip.id,
            title: clip.title || 'clip',
            vibe: clip.vibe || 'custom',
            source: clip.source || (clip.isLocal ? 'local' : 'remote'),
            isLocal: Boolean(clip.isLocal || clip.source === 'local'),
            _archivedFromPicker: !pickerClipSet.has(clip.id),
            remoteUrl: clip.remoteUrl || null,
            manualFocalX: clip.manualFocalX,
            startTime: Number.isFinite(clip.startTime) ? Number(clip.startTime) : 0,
            favorite: favoriteSet.has(clip.id) || Boolean(clip.favorite),
            score: clip.score,
            width: clip.width,
            height: clip.height,
            tags: Array.isArray(clip.tags) ? clip.tags.slice(0, 12) : [],
            mimeType: clipBlob.type || 'video/mp4',
            zipPath
          });
        }
      }
    }

    // bundle active audio & midi/als files
    let bundledAudioPath = null;
    let resolvedAudioBlob = audioBlob instanceof Blob ? audioBlob : (await getSlotMedia(presetId, '__project_audio__'))?.blob || null;
    if (!resolvedAudioBlob && project?.audioUrl) {
      try {
        const audioRes = await fetch(project.audioUrl);
        if (audioRes.ok) resolvedAudioBlob = await audioRes.blob();
      } catch { }
    }
    let resolvedAudioName = audioName || (await getSlotMedia(presetId, '__project_audio__'))?.name || null;
    if (!resolvedAudioName && project?.title) {
      resolvedAudioName = `${safeFilename(project.title, 'sample')}.wav`;
    }
    if (resolvedAudioBlob && resolvedAudioBlob.size > 0) {
      const safeAudio = safeFilename(resolvedAudioName || 'sample.wav', 'sample.wav');
      bundledAudioPath = `audio/${safeAudio}`;
      entries.push({ path: bundledAudioPath, data: resolvedAudioBlob });
    }

    let bundledMidiPath = null;
    let resolvedMidiBlob = midiBlob instanceof Blob ? midiBlob : (await getSlotMedia(presetId, '__project_midi__'))?.blob || null;
    let resolvedMidiName = midiName || (await getSlotMedia(presetId, '__project_midi__'))?.name || null;
    if (!resolvedMidiBlob && project?.serverAudioUrl && project.id === 'starter_meadows') {
      try {
        const alsRes = await fetch('/presets/meadows/' + encodeURIComponent('#1 - meadows - bmaj - 132bpm.als'));
        if (alsRes.ok) {
          resolvedMidiBlob = await alsRes.blob();
          resolvedMidiName = '#1 - meadows - bmaj - 132bpm.als';
        }
      } catch { }
    }
    if (resolvedMidiBlob && resolvedMidiBlob.size > 0) {
      const safeMidi = safeFilename(resolvedMidiName || 'project.mid', 'project.mid');
      bundledMidiPath = `audio/${safeMidi}`;
      entries.push({ path: bundledMidiPath, data: resolvedMidiBlob });
    }

    const trackLoopStates = {};
    if (Array.isArray(project?.tracks)) {
      project.tracks.forEach((tr) => {
        if (tr?.id && typeof tr.loopMidi === 'boolean') {
          trackLoopStates[tr.id] = tr.loopMidi;
        }
      });
    }

    const cleanProject = project ? {
      id: project.id,
      brand: project.brand,
      sampleNumber: project.sampleNumber,
      title: project.title,
      key: project.key,
      bpm: project.bpm,
      duration: project.duration,
      dropBar: project.dropBar,
      dropTime: project.dropTime,
      selectedTrackIds: Array.isArray(project.selectedTrackIds) ? [...project.selectedTrackIds] : null,
      trackLoopStates: Object.keys(trackLoopStates).length > 0 ? trackLoopStates : null,
      peaks: project.peaks,
      sections: project.sections,
      sourceType: project.sourceType,
      tracks: project.tracks,
      chordCutTimes: project.chordCutTimes,
      impactTimes: project.impactTimes,
      _impactTimesEdited: Boolean(project._impactTimesEdited),
      _defaultImpactTimes: Array.isArray(project._defaultImpactTimes) ? project._defaultImpactTimes : null,
      _markerOverrides: project._markerOverrides,
      _customCues: project._customCues || null,
      customCutTimes: Array.isArray(project.customCutTimes) ? project.customCutTimes : null
    } : null;

    const favoriteClipsExport = favoriteList.map((c) => ({
      id: c.id,
      sourceId: c.sourceId || c.id,
      title: c.title || 'clip',
      vibe: c.vibe || 'custom',
      source: c.source || (c.isLocal ? 'local' : 'remote'),
      isLocal: Boolean(c.isLocal || c.source === 'local'),
      url: (c.isLocal || c.source === 'local') ? null : (c.url || null),
      remoteUrl: c.remoteUrl || null,
      manualFocalX: c.manualFocalX,
      startTime: Number.isFinite(c.startTime) ? Number(c.startTime) : 0,
      favorite: true,
      favoritedAt: c.favoritedAt || null,
      score: c.score,
      width: c.width,
      height: c.height,
      tags: Array.isArray(c.tags) ? c.tags.slice(0, 12) : []
    }));

    const manifest = {
      format: 'samplevis-bundle-v1',
      exportedAt: new Date().toISOString(),
      presetId,
      project: cleanProject,
      lyricsData: lyricsData || project?.lyrics || null,
      selectedClipIds: Array.isArray(selectedClipIds) ? selectedClipIds : [],
      selectedClipStartTimes: clipPickerEnabled && Array.isArray(selectedClipStartTimes)
        ? selectedClipStartTimes.map((n) => Math.max(0, Number(n) || 0))
        : [],
      selectedClipEndTimes: clipPickerEnabled && Array.isArray(selectedClipEndTimes)
        ? selectedClipEndTimes.map((n) => (n !== null && n !== undefined && Number(n) > 0 ? Number(n) : null))
        : [],
      selectedClipSpeeds: clipPickerEnabled && Array.isArray(selectedClipSpeeds)
        ? selectedClipSpeeds.map((n) => Math.round(Math.max(25, Math.min(400, Number(n) || 100))))
        : [],
      playlistsByCutMode: normalizedPlaylistsByMode,
      favoriteClips: favoriteClipsExport,
      clipSource: typeof clipSource === 'string' ? clipSource : null,
      clipQuery: typeof clipQuery === 'string' ? clipQuery : null,
      slotManifest,
      clipsMeta,
      bundledAudioPath,
      bundledAudioName: resolvedAudioName || null,
      bundledMidiPath,
      bundledMidiName: resolvedMidiName || null
    };

    entries.unshift(
      { path: 'preset.json', data: JSON.stringify(presetCopy, null, 2) },
      { path: 'project.json', data: JSON.stringify(manifest, null, 2) }
    );

    const zipBlob = await buildZipBlob(entries);
    const fileTitle = safeFilename(presetCopy.meta?.name || presetCopy.id || 'samplevis-project', 'samplevis-project');
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileTitle}.samplevis.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    return { fileName: a.download, size: zipBlob.size };
  }

  function rewriteIdbRefsInPreset(presetObj, oldPresetId, newPresetId) {
    if (!presetObj || !newPresetId) return presetObj;
    const oldPrefix = `idb://preset/${encodeURIComponent(oldPresetId || '')}/`;
    const replaceRef = (val) => {
      if (typeof val !== 'string') return val;
      if (oldPresetId && val.startsWith(oldPrefix)) {
        return makeIdbRef(newPresetId, decodeURIComponent(val.slice(oldPrefix.length)));
      }
      if (val.startsWith('idb://preset/')) {
        const parsed = parseIdbRef(val);
        if (parsed) return makeIdbRef(newPresetId, parsed.slotId);
      }
      return val;
    };

    if (presetObj.assets?.customImage) {
      presetObj.assets.customImage = replaceRef(presetObj.assets.customImage);
    }
    if (presetObj.controlsBox?.values && typeof presetObj.controlsBox.values === 'object') {
      for (const [k, v] of Object.entries(presetObj.controlsBox.values)) {
        if (Array.isArray(v)) {
          presetObj.controlsBox.values[k] = v.map((item) => {
            if (item && typeof item === 'object' && typeof item.src === 'string') {
              return { ...item, src: replaceRef(item.src) };
            }
            return item;
          });
        } else {
          presetObj.controlsBox.values[k] = replaceRef(v);
        }
      }
    }
    return presetObj;
  }

  async function importProjectZip(zipFile) {
    const fileMap = await parseZipFile(zipFile);
    const decoder = new TextDecoder('utf-8');

    let presetBytes = fileMap.get('preset.json');
    if (!presetBytes) {
      for (const [k, v] of fileMap.entries()) {
        if (k.endsWith('.reel.json') || k.endsWith('preset.json')) {
          presetBytes = v;
          break;
        }
      }
    }
    if (!presetBytes) {
      throw new Error('no preset.json found inside .zip bundle');
    }

    const parsedPreset = JSON.parse(decoder.decode(presetBytes));
    const oldPresetId = parsedPreset.id;
    let projectManifest = null;
    const projectBytes = fileMap.get('project.json');
    if (projectBytes) {
      projectManifest = JSON.parse(decoder.decode(projectBytes));
    }

    const baseId = parsedPreset.id || parsedPreset.meta?.name || 'imported-design';
    const cleanId = String(baseId).trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    parsedPreset.id = cleanId || (window.presetService?.generatePresetId?.(12) || `imp_${Date.now()}`);

    const tempSaved = window.presetService
      ? await window.presetService.savePreset(parsedPreset)
      : parsedPreset;
    const targetId = tempSaved.id;

    rewriteIdbRefsInPreset(tempSaved, oldPresetId, targetId);
    if (window.presetService && targetId !== oldPresetId) {
      await window.presetService.savePreset(tempSaved);
    }

    // restore media slot blobs
    if (Array.isArray(projectManifest?.slotManifest)) {
      for (const slot of projectManifest.slotManifest) {
        const data = fileMap.get(slot.zipPath);
        if (!data) continue;
        const blob = new Blob([data], { type: slot.mimeType || 'application/octet-stream' });
        await saveSlotMedia(targetId, slot.slotId, blob, {
          kind: slot.kind,
          name: slot.name,
          mimeType: slot.mimeType
        });
      }
    }

    // restore custom clips
    const restoredClips = [];
    if (Array.isArray(projectManifest?.clipsMeta)) {
      for (const meta of projectManifest.clipsMeta) {
        const data = fileMap.get(meta.zipPath);
        if (!data) continue;
        const blob = new Blob([data], { type: meta.mimeType || 'video/mp4' });
        const cached = await cacheClipBlob(meta.id, blob, meta);
        restoredClips.push({
          ...meta,
          url: cached.objectUrl,
          isLocal: Boolean(meta.isLocal || meta.source === 'local'),
          _archivedFromPicker: Boolean(meta._archivedFromPicker)
        });
      }
    }

    // restore favorite clips metadata (re-linking restored blob urls where available)
    const restoredById = new Map(restoredClips.map((c) => [c.id, c]));
    const restoredFavorites = [];
    if (Array.isArray(projectManifest?.favoriteClips)) {
      for (const fav of projectManifest.favoriteClips) {
        if (!fav || !fav.id) continue;
        const matched = restoredById.get(fav.id);
        restoredFavorites.push({
          ...fav,
          url: matched?.url || fav.url || (fav.remoteUrl ? `/api/clips/stream?url=${encodeURIComponent(fav.remoteUrl)}` : null),
          favorite: true
        });
      }
    }

    // restore audio & midi blobs
    let audioBlob = null;
    let midiBlob = null;
    if (projectManifest?.bundledAudioPath && fileMap.has(projectManifest.bundledAudioPath)) {
      audioBlob = new Blob([fileMap.get(projectManifest.bundledAudioPath)], { type: 'audio/wav' });
    }
    if (projectManifest?.bundledMidiPath && fileMap.has(projectManifest.bundledMidiPath)) {
      midiBlob = new Blob([fileMap.get(projectManifest.bundledMidiPath)], { type: 'application/octet-stream' });
    }

    const importedProjectMeta = projectManifest?.project ? { ...projectManifest.project } : null;
    if (importedProjectMeta && !importedProjectMeta.trackLoopStates && Array.isArray(importedProjectMeta.tracks)) {
      const derivedLoops = {};
      importedProjectMeta.tracks.forEach((tr) => {
        if (tr?.id && typeof tr.loopMidi === 'boolean') derivedLoops[tr.id] = tr.loopMidi;
      });
      if (Object.keys(derivedLoops).length > 0) importedProjectMeta.trackLoopStates = derivedLoops;
    }

    await saveProjectState(targetId, {
      projectMeta: importedProjectMeta,
      lyricsData: projectManifest?.lyricsData || null,
      selectedClipIds: projectManifest?.selectedClipIds || null,
      selectedClipStartTimes: Array.isArray(projectManifest?.selectedClipStartTimes)
        ? projectManifest.selectedClipStartTimes
        : null,
      selectedClipEndTimes: Array.isArray(projectManifest?.selectedClipEndTimes)
        ? projectManifest.selectedClipEndTimes
        : null,
      selectedClipSpeeds: Array.isArray(projectManifest?.selectedClipSpeeds)
        ? projectManifest.selectedClipSpeeds
        : null,
      playlistsByCutMode: projectManifest?.playlistsByCutMode || null,
      customClips: restoredClips,
      favoriteClips: restoredFavorites,
      clipSource: typeof projectManifest?.clipSource === 'string' ? projectManifest.clipSource : null,
      clipQuery: typeof projectManifest?.clipQuery === 'string' ? projectManifest.clipQuery : null,
      audioBlob,
      audioName: projectManifest?.bundledAudioName || null,
      midiBlob,
      midiName: projectManifest?.bundledMidiName || null
    }, { checkpoint: true });

    const loadedState = await loadProjectState(targetId);
    return {
      preset: tempSaved,
      projectState: loadedState
    };
  }

  /**
   * The mime type a dropped track file advertises from its extension. A dropped .mid/.als often
   * arrives with no type at all, so the extension is the only reliable signal.
   */
  function trackMime(name, fallback = '') {
    const lower = String(name || '').toLowerCase();
    if (lower.endsWith('.als')) return 'application/x-ableton-live-set';
    if (lower.endsWith('.mid') || lower.endsWith('.midi')) return 'audio/midi';
    return fallback;
  }

  window.projectBundleService = {
    makeIdbRef,
    parseIdbRef,
    dataUrlToBlob,
    blobToDataUrl,
    trackMime,
    saveSlotMedia,
    getSlotMedia,
    updateSlotMeta,
    listPresetMedia,
    deleteSlotMedia,
    deletePresetData,
    migratePresetMedia,
    clonePresetMedia: migratePresetMedia,
    cacheClipBlob,
    getCachedClipRecord,
    updateClipMeta,
    getCachedClipUrl,
    listCachedClips,
    saveProjectState,
    loadProjectState,
    ensureProjectStateCheckpoint,
    revertProjectStateToCheckpoint,
    hasCustomMedia,
    exportProjectZip,
    importProjectZip
  };
})();
