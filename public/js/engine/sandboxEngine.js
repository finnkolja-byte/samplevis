/**
 * Host side of the sandboxed renderer.
 *
 * Loads the engine sources once per session (they are inlined into the frame's srcdoc, so the
 * frame never fetches anything itself), then exposes boot/render/dispose on top of RendererFrame.
 */
(function () {
  'use strict';

  window.SANDBOX_ENGINE_VERSION = 'host-v4';

  const ENGINE_SOURCES = [
    '/js/engine/audioSignals.js',
    '/js/engine/motionKit.js',
    '/js/engine/loopUtils.js',
    '/js/services/lyricsService.js',
    '/js/engine/reelEngine.js'
  ];
  const RUNTIME_SOURCE = '/js/engine/sandboxRuntime.js';

  // stock faces are fetched once per session; the frame has no origin of its own, so the bytes
  // travel with the preset instead of being resolved by CSS there
  const stockFontCache = new Map();

  function namedFamilies(preset) {
    const library = window.STUDIO_FONTS;
    if (!library || !Array.isArray(library.families)) return [];
    const parts = [preset?.frontUiBox?.initScript, preset?.frontUiBox?.drawScript];
    const values = preset?.controlsBox?.values || {};
    for (const field of preset?.controlsBox?.fields || []) {
      if (!field || field.type !== 'font') continue;
      parts.push(field.defaultValue, values[field.id]);
      (field.options || []).forEach((option) => parts.push(option));
      (field.fonts || []).forEach((option) => parts.push(option));
    }
    const text = parts.filter((part) => typeof part === 'string').join('\n').toLowerCase();
    return library.families.filter((family) => {
      const name = String(family).toLowerCase();
      const at = text.indexOf(name);
      if (at === -1) return false;
      // "lora" inside "flora" is not a request for the family
      const before = text[at - 1];
      const after = text[at + name.length];
      return !/[a-z0-9]/.test(before || '') && !/[a-z0-9]/.test(after || '');
    });
  }

  async function loadStockFace(file) {
    if (!stockFontCache.has(file)) {
      stockFontCache.set(file, fetch(file)
        .then((res) => (res.ok ? res.arrayBuffer() : null))
        .catch(() => null));
    }
    const bytes = await stockFontCache.get(file);
    if (!bytes) stockFontCache.delete(file);
    return bytes;
  }

  // the loaded script tag carries the cache-buster; the engine sources are fetched separately and
  // need the same version or Pages' static TTL pins an older engine than the host
  const SOURCE_VERSION = (() => {
    try {
      return new URL(document.currentScript.src).search || '';
    } catch {
      return '';
    }
  })();

  let sourcesPromise = null;

  /**
   * Preset data can name any URL it likes. Only same-origin, blob: and data: sources are fetched
   * here; a public preset must not be able to turn the viewer's browser into a beacon for
   * arbitrary hosts, which is the network half of the sandbox guarantee.
   */
  function localSourceKind(src) {
    if (!src || typeof src !== 'string') return null;
    if (src.startsWith('data:')) return 'data';
    try {
      const parsed = new URL(src, window.location.href);
      if (parsed.protocol === 'blob:' || parsed.origin === window.location.origin) return 'local';
    } catch { }
    return null;
  }

  function loadSources() {
    if (!sourcesPromise) {
      sourcesPromise = (async () => {
        const paths = [RUNTIME_SOURCE, ...ENGINE_SOURCES];
        const responses = await Promise.all(paths.map((path) => fetch(path + SOURCE_VERSION)));
        const texts = await Promise.all(responses.map((res, i) => {
          if (!res.ok) throw new Error(`sandbox source ${paths[i]} failed (${res.status})`);
          return res.text();
        }));
        return { runtime: texts[0], extras: texts.slice(1) };
      })().catch((err) => {
        sourcesPromise = null;
        throw err;
      });
    }
    return sourcesPromise;
  }

  class SandboxEngine {
    constructor(options = {}) {
      this.width = Math.round(options.width || 1080);
      this.height = Math.round(options.height || 1920);
      this.dpr = options.dpr || 1;
      this.onFrame = options.onFrame || null;
      this.onPainted = options.onPainted || null;
      this.onError = options.onError || null;
      this.onLog = options.onLog || null;
      this.onDiag = options.onDiag || null;
      this.onBooted = options.onBooted || null;
      this.onMessage = options.onMessage || null;
      this.booted = false;
      this.frame = null;
      this._readyPromise = null;
      this._fontsApplied = Promise.resolve();
    }

    static async create(options = {}) {
      const { runtime, extras } = await loadSources();
      const instance = new SandboxEngine(options);

      instance._readyPromise = new Promise((resolve) => { instance._resolveReady = resolve; });

      instance.frame = new window.RendererFrame({
        width: instance.width,
        height: instance.height,
        dpr: instance.dpr,
        visible: Boolean(options.visible),
        extraSources: extras,
        runtimeSource: runtime,
        onReady: () => instance._resolveReady(),
        onFrame: (bitmap, index, time, renderMs) => {
          const paintStart = performance.now();
          if (instance.onFrame) instance.onFrame(bitmap, index, time, renderMs);
          else if (bitmap && typeof bitmap.close === 'function') bitmap.close();
          instance._paintMsTotal = (instance._paintMsTotal || 0) + (performance.now() - paintStart);
          instance._recordFrameStats(renderMs, time);
        },
        onPainted: (msg) => {
          instance._recordFrameStats(msg.renderMs, msg.time, msg.videos, msg.dropped);
          if (instance.onPainted) instance.onPainted(msg);
        },
        onError: (err) => { if (instance.onError) instance.onError(err); },
        onLog: (msg) => { if (instance.onLog) instance.onLog(msg); },
        onMessage: (msg) => {
          if (msg.type === 'booted') {
            instance.booted = true;
            if (instance.onBooted) instance.onBooted(msg);
            return;
          }
          if (msg.type === 'diag') {
            instance.lastDiag = msg;
            if (instance._diagResolve) {
              const resolve = instance._diagResolve;
              instance._diagResolve = null;
              resolve(msg);
            }
            if (instance.onDiag) instance.onDiag(msg);
            return;
          }
          if (msg.type === 'fonts-state') {
            if (instance._fontsResolve) {
              const resolve = instance._fontsResolve;
              instance._fontsResolve = null;
              resolve(msg);
            }
            return;
          }
          if (instance.onMessage) instance.onMessage(msg);
        }
      });
      instance.frame.mount(options.container);

      await instance._readyPromise;
      return instance;
    }

    /**
     * `signalData` is the precomputed spectrogram from audioSignals. The frame slices it by time,
     * so it is sent once and every later frame is just a timestamp.
     */
    boot({ preset, project, signalData, aspectRatio, lyrics } = {}) {
      this.frame.sendCommand('boot', {
        width: this.width,
        height: this.height,
        aspectRatio: aspectRatio || preset?.meta?.aspectRatio || '9:16',
        preset,
        project,
        signalData,
        lyrics: lyrics || null
      });
      this.syncStockFonts(namedFamilies(preset));
    }

    /**
     * Push studio families the preset names, or one the user just picked. The frame cannot fetch
     * /fonts and an opaque origin cannot read the host's document.fonts, so without this a vendored
     * family would still fall back to a system face inside the renderer.
     */
    async syncStockFonts(families = []) {
      const library = window.STUDIO_FONTS;
      if (!this.frame || !library || !Array.isArray(library.faces)) return;
      const names = Array.isArray(families) ? families : [];
      if (names.length === 0) return;
      this._fontsSent = this._fontsSent || new Set();
      // a reboot keeps the same document, so a face registered earlier is still there
      const wanted = library.faces.filter((face) => names.includes(face.family) && !this._fontsSent.has(face.file));
      if (wanted.length === 0) return;
      const faces = [];
      for (const face of wanted) {
        const bytes = await loadStockFace(face.file);
        if (bytes) faces.push({ ...face, bytes });
      }
      if (!this.frame || faces.length === 0) return;
      // a failed fetch must retry, so only delivered faces are recorded
      faces.forEach((face) => this._fontsSent.add(face.file));
      this._fontsApplied = new Promise((resolve) => { this._fontsResolve = resolve; });
      this.frame.sendCommand('fonts', { faces });
    }

    /**
     * Captures do not wait for a paint loop, so an export or thumbnail taken right after load would
     * otherwise grab fallback type before the faces land. A dead frame must not hang the export.
     */
    whenFontsReady(timeoutMs = 2000) {
      const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
      return Promise.race([this._fontsApplied, timeout]);
    }

    render(time, index, clipIndex, exact, clipTime, clipRate, capture, playing) {
      this._lastSentAt = performance.now();
      this.frame.renderFrame(time, index, clipIndex, exact, clipTime, clipRate, capture, playing);
    }

    /**
     * Rolling frame cost, logged once every two seconds. The point is to separate what the engine
     * spends inside the frame from what the message hop and the host paint add, because those have
     * different fixes.
     */
    _recordFrameStats(renderMs, time, videos, dropped) {
      const now = performance.now();
      this._stats = this._stats || { frames: 0, renderMs: 0, tripMs: 0, since: now, gapMax: 0, gapSum: 0, lastTime: null };
      const stats = this._stats;
      stats.frames += 1;
      stats.renderMs += Number(renderMs) || 0;
      if (Number.isFinite(videos)) stats.videos = videos;
      if (Number.isFinite(dropped)) stats.dropped = dropped;
      if (this._lastSentAt) stats.tripMs += Math.max(0, now - this._lastSentAt);
      // gap between the timestamps of consecutive painted frames: a steady value near the refresh
      // interval means the picture advances evenly, which a paint counter cannot tell you
      if (Number.isFinite(time)) {
        if (stats.lastTime != null) {
          const gap = Math.abs(time - stats.lastTime) * 1000;
          stats.gapSum += gap;
          if (gap > stats.gapMax) stats.gapMax = gap;
        }
        stats.lastTime = time;
      }
      if (now - stats.since < 2000) return;
      const seconds = (now - stats.since) / 1000;
      const paintMs = (this._paintMsTotal || 0) / stats.frames;
      const gaps = Math.max(1, stats.frames - 1);
      this.perf = {
        fps: Math.round(stats.frames / seconds),
        engineMs: Math.round((stats.renderMs / stats.frames) * 10) / 10,
        hopMs: Math.round((stats.tripMs / stats.frames) * 10) / 10,
        paintMs: Math.round(paintMs * 10) / 10,
        gapMs: Math.round((stats.gapSum / gaps) * 10) / 10,
        gapMaxMs: Math.round(stats.gapMax * 10) / 10,
        videos: stats.videos || 0,
        dropped: stats.dropped || 0
      };
      if (window.__sandboxPerfLog !== false) {
        const media = this.perf.videos > 0 ? ` · media ${this.perf.videos} (${this.perf.dropped} dropped)` : '';
        console.info(`[sandbox] ${this.perf.fps} fps · engine ${this.perf.engineMs}ms · hop ${this.perf.hopMs}ms · paint ${this.perf.paintMs}ms · gap ${this.perf.gapMs}/${this.perf.gapMaxMs}ms${media}`);
      }
      this._stats = {
        frames: 0,
        renderMs: 0,
        tripMs: 0,
        since: now,
        gapMax: 0,
        gapSum: 0,
        lastTime: stats.lastTime,
        videos: stats.videos,
        dropped: stats.dropped
      };
      this._paintMsTotal = 0;
    }

    /**
     * Clip bytes move once per source and the frame builds its own blob URLs, because blob: is
     * origin-bound and the sandbox has an opaque origin.
     */
    async setClips(list = []) {
      if (!this.frame) return;
      const payload = [];
      for (const clip of list) {
        if (!clip || !clip.src) continue;
        if (!localSourceKind(clip.src)) {
          console.warn('[sandbox] cross-origin clip blocked', clip.src);
          continue;
        }
        try {
          const res = await fetch(clip.src);
          if (!res.ok) continue;
          const bytes = await res.arrayBuffer();
          payload.push({
            id: String(clip.id),
            bytes,
            mimeType: res.headers.get('content-type') || 'video/mp4'
          });
        } catch (err) {
          console.warn('[sandbox] clip fetch failed', clip.src, err);
        }
      }
      this.frame.sendCommand('clips', { clips: payload }, payload.map((clip) => clip.bytes));
    }

    setSignalData(signalData, key) {
      this.frame.sendCommand('signal', { signalData, key: key || null });
    }

    async setMediaSlot(slotId, kind, src, key) {
      const media = await this._fetchBytes(src);
      if (!media) return;
      if (media.dataUrl) {
        // an inline svg placeholder already is the payload; fetching it only round-trips bytes
        this.frame.sendCommand('media-slot', { slotId, kind, key: key || '', dataUrl: media.dataUrl });
        return;
      }
      this.frame.sendCommand(
        'media-slot',
        { slotId, kind, key: key || '', bytes: media.buffer, mimeType: media.type },
        [media.buffer]
      );
    }

    async setMediaPool(poolId, items = [], key) {
      const resolved = [];
      for (const item of items) {
        if (!item) continue;
        const media = await this._fetchBytes(item.src);
        resolved.push({
          id: item.id,
          name: item.name,
          kind: item.kind,
          enabled: item.enabled,
          bytes: media?.buffer || null,
          mimeType: media?.type || '',
          dataUrl: media?.dataUrl || ''
        });
      }
      const transfer = resolved.filter((i) => i.bytes).map((i) => i.bytes);
      this.frame.sendCommand('media-pool', { poolId, key: key || '', items: resolved }, transfer);
    }

    async _fetchBytes(src) {
      if (!src || typeof src !== 'string') return null;
      const kind = localSourceKind(src);
      if (kind === 'data') return { dataUrl: src };
      if (kind !== 'local') {
        if (src) console.warn('[sandbox] cross-origin media blocked', src);
        return null;
      }
      try {
        const res = await fetch(src);
        if (!res.ok) return null;
        return {
          buffer: await res.arrayBuffer(),
          type: res.headers.get('content-type') || ''
        };
      } catch (err) {
        console.warn('[sandbox] media fetch failed', src, err);
        return null;
      }
    }

    setLyrics(lyrics) {
      this.frame.sendCommand('lyrics', { lyrics: lyrics || null });
    }

    /**
     * The frame holds a structured clone of the preset, so an inspector move has to be pushed or it
     * only changes the host's copy. One id per message: media slots and pools have their own
     * transport and must not be re-cloned into every slider event.
     */
    setControls(update = {}) {
      if (!this.frame || !update.id) return;
      this.frame.sendCommand('controls', {
        id: update.id,
        value: update.value === undefined ? null : update.value,
        font: update.font || null
      });
    }

    requestDiagnostics(timeoutMs = 500) {
      if (!this.frame) return Promise.resolve(null);
      return new Promise((resolve) => {
        this._diagResolve = resolve;
        this.frame.sendCommand('diag');
        // a dead frame never answers; the caller needs an answer either way
        setTimeout(() => {
          if (this._diagResolve !== resolve) return;
          this._diagResolve = null;
          resolve(this.lastDiag || null);
        }, timeoutMs);
      });
    }

    setSize(width, height, dpr, aspectRatio) {
      this.width = Math.round(width);
      this.height = Math.round(height);
      if (dpr) this.dpr = dpr;
      this.frame.setSize(this.width, this.height, this.dpr, aspectRatio);
    }

    dispose() {
      if (this.frame) this.frame.destroy();
      this.frame = null;
    }
  }

  window.SandboxEngine = SandboxEngine;
})();
