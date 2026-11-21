// registry and adapter for switching between canvas templates and 3-box presets
const SANDBOX_RENDERER_ENABLED = (() => {
  try {
    // the sandboxed frame is the renderer; ?sandbox=0 is the escape hatch back to the in-page one
    if (new URLSearchParams(window.location.search).get('sandbox') === '0') return false;
  } catch { }
  return typeof window.SandboxEngine === 'function';
})();

// readers branch on this attribute; which renderer is live is otherwise invisible in a bug report
try {
  document.documentElement.dataset.renderer = SANDBOX_RENDERER_ENABLED ? 'sandbox' : 'in-page';
} catch { }

class ReelPresetTemplateAdapter {
  constructor(preset) {
    this.id = preset.id;
    this.name = preset.meta?.name || preset.id;
    this.title = preset.meta?.title || preset.meta?.name || preset.id;
    this.subtitle = preset.meta?.description || '';
    this.tagline = preset.meta?.description || '';
    this.badge = preset.meta?.badge || 'preset';
    this.preset = {
      ...preset,
      meta: preset.meta ? { ...preset.meta } : {}
    };
    this.modules = preset.modules || preset.features || {};
    this.features = preset.features || null;
    this.engine = null;
    this._project = null;
  }

  init(canvas, state) {
    if (SANDBOX_RENDERER_ENABLED) {
      this._initSandbox(canvas, state);
      return;
    }
    if (!this.engine) {
      this.engine = new window.ReelEngine(canvas);
    }
    this.engine.loadPreset(this.preset);
    if (state && typeof state.seamlessLoop === 'boolean' && this.params.seamlessLoop === undefined) {
      this.params.seamlessLoop = state.seamlessLoop;
    }
    if (state && typeof state.seamlessLoopStyle === 'string' && this.params.loopStyle === undefined) {
      this.params.loopStyle = state.seamlessLoopStyle;
    }
    if (this.params.clipTransition === undefined) {
      if (typeof this.params.dropGlitch === 'boolean') {
        this.params.clipTransition = this.params.dropGlitch ? 'glitch' : 'none';
      } else if (state && typeof state.clipTransition === 'string') {
        this.params.clipTransition = state.clipTransition;
      }
    }
    if (this.params.clipTransitionDuration === undefined && state && Number.isFinite(state.clipTransitionDuration)) {
      this.params.clipTransitionDuration = state.clipTransitionDuration;
    }
    if (state && state.customImageDataUrl && !this.preset?.assets?.customImage) {
      this.engine.setCustomImage(state.customImageDataUrl);
    }
    if (state && state.project) {
      this._project = state.project;
      this.engine.setProject(state.project);
    }
    if (state && state.aspectRatio && !this.preset?.meta?.aspectRatio) {
      this.engine.setAspectRatio(state.aspectRatio);
    }
    if (state && state.videoPool) {
      this.engine.setActiveVideos(state.videoPool);
    }
  }

  get params() {
    if (!this.preset) return {};
    if (!this.preset.controlsBox) this.preset.controlsBox = { fields: [], values: {} };
    if (!this.preset.controlsBox.values || typeof this.preset.controlsBox.values !== 'object') {
      this.preset.controlsBox.values = {};
    }
    return this.preset.controlsBox.values;
  }

  get project() {
    return this.engine ? this.engine.project : this._project;
  }

  set project(p) {
    this._project = p;
    if (this.engine) this.engine.setProject(p);
  }

  get selectedTrackIds() {
    return this.engine ? this.engine.selectedTrackIds : new Set();
  }

  /**
   * Runtime failures collected from the frame. Callers (Viz context, the repair card) previously
   * read `visualizer.engine.lastRuntimeErrors`; this keeps that contract when the engine is remote.
   */
  get lastRuntimeErrors() {
    if (this.engine) return this.engine.lastRuntimeErrors || [];
    return this._sandboxErrors || [];
  }

  attachDecodedAudioBuffer(audioBuffer, key) {
    if (SANDBOX_RENDERER_ENABLED) {
      try {
        const data = window.audioSignals?.attachBuffer?.(audioBuffer, key || null);
        if (data) {
          this._sandboxSignalData = data;
          this._sandboxSignalKey = key || null;
          if (this._sandbox) this._sandbox.setSignalData(data, key || null);
        }
        return data;
      } catch (err) {
        console.warn('[sandbox] signal analysis failed', err);
        return null;
      }
    }
    return this.engine && typeof this.engine.attachDecodedAudioBuffer === 'function'
      ? this.engine.attachDecodedAudioBuffer(audioBuffer, key)
      : null;
  }

  setProject(project) {
    this._project = project;
    if (SANDBOX_RENDERER_ENABLED) {
      this._sandboxProject = project;
      this._bootSandbox();
      return;
    }
    if (this.engine) {
      this.engine.setProject(project);
    }
  }

  setAspectRatio(ratio) {
    if (SANDBOX_RENDERER_ENABLED) {
      this._sandboxAspectRatio = ratio;
      const canvas = this._sandboxCanvas;
      if (this._sandbox && canvas) {
        // the frame sizes its own canvas from the ratio; the host canvas is only a capture surface
        this._sandbox.setSize(canvas.width || 1080, canvas.height || 1920, 1, ratio);
      }
      return;
    }
    if (this.engine) {
      this.engine.setAspectRatio(ratio);
    }
  }

  setActiveVideos(videos) {
    if (SANDBOX_RENDERER_ENABLED) {
      this._sandboxVideos = Array.isArray(videos) ? videos : [];
      this._sandboxVideoIndex = new Map(this._sandboxVideos.map((el, i) => [el, i]));
      this._queueSandboxMedia();
      return;
    }
    if (this.engine) {
      this.engine.setActiveVideos(videos);
    }
  }

  setCustomImage(dataUrl) {
    if (this.engine && typeof this.engine.setCustomImage === 'function') {
      this.engine.setCustomImage(dataUrl);
    }
  }

  setMediaSlot(slotId, urlOrRef, kind = 'image') {
    if (SANDBOX_RENDERER_ENABLED) {
      if (!slotId) return;
      this._sandboxSlotRefs = this._sandboxSlotRefs || new Map();
      this._sandboxSlotRefs.set(slotId, { kind, ref: urlOrRef });
      this._pushSandboxSlot(slotId);
      return;
    }
    if (this.engine && typeof this.engine.setMediaSlot === 'function') {
      this.engine.setMediaSlot(slotId, urlOrRef, kind);
    }
  }

  setMediaPool(poolId, items = []) {
    if (SANDBOX_RENDERER_ENABLED) {
      if (!poolId) return;
      this._sandboxPoolRefs = this._sandboxPoolRefs || new Map();
      this._sandboxPoolRefs.set(poolId, Array.isArray(items) ? items : []);
      this._pushSandboxPool(poolId);
      return;
    }
    if (this.engine && typeof this.engine.setMediaPool === 'function') {
      this.engine.setMediaPool(poolId, items);
    }
  }

  /**
   * The frame has no IndexedDB, so `idb://` refs are resolved here and travel as bytes. Same reason
   * blob URLs are minted inside the frame: an opaque origin cannot reach the parent's storage.
   */
  async _pushSandboxSlot(slotId, attempt = 0) {
    if (!this._sandbox || !this._sandboxSlotRefs) return;
    const entry = this._sandboxSlotRefs.get(slotId);
    if (!entry) return;
    this._sandboxSlotSent = this._sandboxSlotSent || new Map();
    // the frame keys its blob URL by this value; re-sending an unchanged slot would reload it
    if (this._sandboxSlotSent.get(slotId) === entry.ref) return;
    let src = entry.ref;
    if (typeof src === 'string' && src.startsWith('idb://') && window.projectBundleService?.getSlotMedia) {
      // the ref carries its own preset and slot ids; the in-memory preset id is not authoritative
      const parsed = window.projectBundleService.parseIdbRef?.(src);
      const rec = await window.projectBundleService.getSlotMedia(
        parsed?.presetId || this.preset?.id || 'default',
        parsed?.slotId || slotId
      );
      src = rec?.objectUrl || null;
    }
    if (typeof src !== 'string' || !src) {
      // media hydration from IndexedDB can land after boot; retry briefly before giving up
      if (attempt < 4) {
        setTimeout(() => this._pushSandboxSlot(slotId, attempt + 1), 250 * (attempt + 1));
      } else {
        console.warn('[sandbox] media slot unresolved', slotId);
      }
      return;
    }
    await this._sandbox.setMediaSlot(slotId, entry.kind, src, String(entry.ref || ''));
    this._sandboxSlotSent.set(slotId, entry.ref);
    this._requestSandboxRepaint();
  }

  async _pushSandboxPool(poolId, attempt = 0) {
    if (!this._sandbox || !this._sandboxPoolRefs) return;
    const items = this._sandboxPoolRefs.get(poolId) || [];
    this._sandboxPoolSent = this._sandboxPoolSent || new Map();
    const signature = items.map((item) => `${item?.id || ''}:${item?.src || ''}`).join('|');
    if (this._sandboxPoolSent.get(poolId) === signature) return;
    const resolved = [];
    for (const item of items) {
      let src = item?.src;
      if (typeof src === 'string' && src.startsWith('idb://') && window.projectBundleService?.getSlotMedia) {
        const parsed = window.projectBundleService.parseIdbRef?.(src);
        const rec = await window.projectBundleService.getSlotMedia(
          parsed?.presetId || this.preset?.id || 'default',
          parsed?.slotId || item.id || poolId
        );
        src = rec?.objectUrl || null;
      }
      if (src) resolved.push({ ...item, src });
    }
    if (items.length > 0 && resolved.length === 0) {
      if (attempt < 4) {
        setTimeout(() => this._pushSandboxPool(poolId, attempt + 1), 250 * (attempt + 1));
      } else {
        console.warn('[sandbox] media pool unresolved', poolId);
      }
      return;
    }
    await this._sandbox.setMediaPool(poolId, resolved, signature);
    this._sandboxPoolSent.set(poolId, signature);
    this._requestSandboxRepaint();
  }

  getMediaSlotElements(kind = null) {
    if (this.engine && typeof this.engine.getMediaSlotElements === 'function') {
      return this.engine.getMediaSlotElements(kind);
    }
    return [];
  }

  setLyricsData(lyricsData) {
    if (SANDBOX_RENDERER_ENABLED) {
      this._sandboxLyrics = lyricsData || null;
      this._queueSandboxMedia();
      return;
    }
    if (this.engine && typeof this.engine.setLyricsData === 'function') {
      this.engine.setLyricsData(lyricsData);
    }
  }

  /**
   * A boot constructs a new engine inside the frame, so its slots, pools and clips start empty.
   * Every send cache has to be invalidated with it or the parent will believe it already delivered
   * media that the new engine never saw. setProject reboots, so this is not a one-time path.
   */
  _bootSandbox() {
    if (!this._sandbox) return;
    const project = this._sandboxProject || this._project || null;
    this._sandboxErrors = [];
    this._sandbox.boot({
      preset: this.preset,
      project,
      signalData: project?._signalData || null,
      lyrics: this._sandboxLyrics || (project && project.lyrics) || null,
      aspectRatio: this._sandboxAspectRatio || this.preset?.meta?.aspectRatio || '9:16'
    });
    this._sandboxSlotSent = new Map();
    this._sandboxPoolSent = new Map();
    this._sandboxClipSignature = null;
    this._queueSandboxMedia();
    this._syncSandboxMediaFromPreset();
    // anything moved before the frame existed lands now that the engine is listening
    this._flushSandboxControls();
    // audio analysis can finish before or after boot; hand it over whenever it exists
    if (this._sandboxSignalData) this._sandbox.setSignalData(this._sandboxSignalData, this._sandboxSignalKey);
  }

  _queueSandboxMedia() {
    if (!this._sandbox) return;

    if (this._sandboxVideos) {
      const sources = this._sandboxVideos.map((el) => (el && (el.currentSrc || el.src)) || '');
      const signature = sources.join('|');
      // re-sending megabytes of clip bytes on every unrelated setActiveVideos call would be wasteful
      if (signature !== this._sandboxClipSignature) {
        this._sandboxClipSignature = signature;
        this._sandbox.setClips(sources.map((src, i) => ({ id: String(i), src })))
          .catch((err) => console.warn('[sandbox] clips failed', err));
      }
    }

    if (this._sandboxLyrics) this._sandbox.setLyrics(this._sandboxLyrics);
  }

  rebuildNoteNodes() {
    if (this.engine) {
      this.engine.rebuildNoteNodes();
    }
  }

  toggleTrack(trackId, enabled) {
    if (this.engine) {
      this.engine.toggleTrack(trackId, enabled);
    }
  }

  getSpeedRampInfo(time) {
    if (this.engine) {
      return this.engine.getSpeedRampInfo(time);
    }
    return { clipTime: time, instSpeed: 1.0 };
  }

  _initSandbox(canvas, state) {
    this._sandboxCanvas = canvas;
    this._sandboxCtx = canvas.getContext('2d', { alpha: false });
    this._sandboxWaiters = this._sandboxWaiters || [];
    this._sandboxIndex = this._sandboxIndex || 0;
    if (state && state.project) this._sandboxProject = state.project;
    // lyrics can be set before init; project state is the last reliable copy
    if (!this._sandboxLyrics && state && state.project && state.project.lyrics) {
      this._sandboxLyrics = state.project.lyrics;
    }
    if (state && Array.isArray(state.videoPool)) {
      this._sandboxVideos = state.videoPool;
      this._sandboxVideoIndex = new Map(state.videoPool.map((el, i) => [el, i]));
    }
    this._sandboxAspectRatio = (state && state.aspectRatio) || this.preset?.meta?.aspectRatio || '9:16';

    const bootWith = (instance) => {
      this._sandbox = instance;
      this._bootSandbox();
    };

    if (!this._sandboxPromise) {
      this._sandboxPromise = window.SandboxEngine.create({
        width: canvas.width || 1080,
        height: canvas.height || 1920,
        dpr: 1,
        // preview shows the frame's own canvas: no bitmap hop, and the paint happens inside the
        // frame's animation callback where the compositor expects it
        visible: true,
        container: canvas.parentElement || null,
        onFrame: (bitmap, index, time) => this._paintSandboxFrame(bitmap, index, time),
        onError: (err) => {
          const entry = `${err.phase}: ${err.message}`.slice(0, 260);
          const errors = (this._sandboxErrors || []).filter((item) => item !== entry);
          this._sandboxErrors = [...errors, entry].slice(-4);
          console.error('[sandbox]', err.phase, err.message, err.stack || '');
        },
        onLog: (text, level) => {
          if (level === 'error') console.error('[sandbox]', text);
          else if (level === 'warn') console.warn('[sandbox]', text);
          else if (window.__sandboxDebug === true) console.log('[sandbox]', text);
        },
        onMessage: (msg) => {
          if (msg.type === 'runtime-error') {
            this._sandboxErrors = Array.isArray(msg.errors) ? msg.errors.slice(0, 4) : [];
            return;
          }
          if (msg.type === 'video-health') {
            this._sandboxVideoHealth = msg.text || '';
            if (window.__sandboxDebug === true) console.info('[sandbox] video', this._sandboxVideoHealth);
            return;
          }
          if (msg.type === 'lyrics-state') {
            if (window.__sandboxDebug === true) {
              console.log('[sandbox] lyrics ' + msg.source + ' has=' + msg.has + ' lines=' + msg.lines);
            }
            return;
          }
          if (msg.type === 'assets-changed') this._requestSandboxRepaint();
        }
      }).then((instance) => {
        bootWith(instance);
        return instance;
      });
    } else {
      this._sandboxPromise.then(bootWith);
    }
  }

  _syncSandboxMediaFromPreset() {
    const fields = this.preset?.controlsBox?.fields || [];
    const values = this.preset?.controlsBox?.values || {};
    for (const field of fields) {
      if (!field || !field.id) continue;
      if (field.type === 'image' || field.type === 'video') {
        const value = values[field.id];
        if (typeof value === 'string' && value) this.setMediaSlot(field.id, value, field.type);
      } else if (field.type === 'media_pool') {
        if (Array.isArray(values[field.id])) this.setMediaPool(field.id, values[field.id]);
      }
    }
    // anything set before the frame finished booting still needs its bytes sent
    if (this._sandboxSlotRefs) for (const id of this._sandboxSlotRefs.keys()) this._pushSandboxSlot(id);
    if (this._sandboxPoolRefs) for (const id of this._sandboxPoolRefs.keys()) this._pushSandboxPool(id);
  }

  /**
   * Captured frames are the only ones that reach the host canvas. Preview never uses this path, so
   * there is no per-frame copy to schedule or rate-limit here.
   */
  _paintSandboxFrame(bitmap, index, time) {
    this._compositeSandboxFrame(bitmap, typeof index === 'number' ? index : Infinity, time);
  }

  _compositeSandboxFrame(bitmap, paintedIndex, time) {
    const canvas = this._sandboxCanvas;
    const ctx = this._sandboxCtx;
    if (canvas && ctx) ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // drawing is deferred on the compositor, so closing the bitmap we just handed to drawImage can
    // drop the frame before it is rasterised. release the previous one instead.
    if (this._sandboxPaintedBitmap && typeof this._sandboxPaintedBitmap.close === 'function') {
      this._sandboxPaintedBitmap.close();
    }
    this._sandboxPaintedBitmap = bitmap || null;

    const waiting = this._sandboxWaiters || [];
    const stillWaiting = [];
    for (const waiter of waiting) {
      if (paintedIndex >= waiter.index) waiter.resolve();
      else stillWaiting.push(waiter);
    }
    this._sandboxWaiters = stillWaiting;
  }

  /**
   * Export steps frames and reads the canvas immediately afterwards, which the async sandbox
   * cannot satisfy synchronously. The export loop awaits this; preview keeps using renderFrame.
   */
  renderFrameAwait(time, activeVid) {
    if (!SANDBOX_RENDERER_ENABLED) {
      this.renderFrame(time, activeVid);
      return Promise.resolve();
    }
    if (!this._sandbox) return Promise.resolve();
    // a capture taken right after load must not grab fallback type
    const ready = this._sandbox.whenFontsReady ? this._sandbox.whenFontsReady() : Promise.resolve();
    return ready.then(() => new Promise((resolve) => {
      this._sandboxWaiters = this._sandboxWaiters || [];
      this._sandboxIndex = (this._sandboxIndex || 0) + 1;
      this._sandboxWaiters.push({ index: this._sandboxIndex, resolve });
      const clipIndex = this._sandboxVideoIndex ? this._sandboxVideoIndex.get(activeVid) : undefined;
      const clipTime = activeVid && Number.isFinite(activeVid.currentTime) ? activeVid.currentTime : undefined;
      const clipRate = activeVid && Number.isFinite(activeVid.playbackRate) ? activeVid.playbackRate : undefined;
      // export bypasses the preview path: one captured frame, handed back as a bitmap
      this._sandbox.render(time, this._sandboxIndex, clipIndex, true, clipTime, clipRate, true, false);
    }));
  }

  setPlaying(playing) {
    // paused and scrubbed frames must be exact; free playback may let media drift
    this._sandboxPlaying = Boolean(playing);
  }

  _sendSandboxFrame(time, activeVid, capture) {
    if (!this._sandbox) return;
    this._sandboxLastTime = time;
    this._sandboxLastVid = activeVid || null;
    this._sandboxIndex = (this._sandboxIndex || 0) + 1;
    const clipIndex = this._sandboxVideoIndex ? this._sandboxVideoIndex.get(activeVid) : undefined;
    const clipTime = activeVid && Number.isFinite(activeVid.currentTime) ? activeVid.currentTime : undefined;
    const clipRate = activeVid && Number.isFinite(activeVid.playbackRate) ? activeVid.playbackRate : undefined;
    const exact = this._sandboxPlaying ? undefined : true;
    this._sandbox.render(
      time,
      this._sandboxIndex,
      clipIndex,
      exact,
      clipTime,
      clipRate,
      capture,
      this._sandboxPlaying
    );
  }

  renderFrame(time, activeVid) {
    if (SANDBOX_RENDERER_ENABLED) {
      if (!this._sandbox) return;
      // live frames are fire-and-forget: the frame paints its own canvas and coalesces requests,
      // so there is nothing to gate and no bitmap to bring back
      this._sendSandboxFrame(time, activeVid, false);
      return;
    }
    if (this.engine) {
      this.engine.renderFrame(time, activeVid);
    }
  }

  /**
   * Media decodes after the frame that requested it has already been painted, so the canvas would
   * keep showing the missing-media tile until the studio happens to render again. Repaint the last
   * timestamp, throttled because a decoding pool fires one event per item.
   */
  _requestSandboxRepaint() {
    if (!this._sandbox || this._sandboxLastTime == null) return;
    const now = Date.now();
    if (this._sandboxRepaintAt && now - this._sandboxRepaintAt < 120) return;
    this._sandboxRepaintAt = now;
    this.renderFrame(this._sandboxLastTime, this._sandboxLastVid || null);
  }

  getRenderDiagnostics() {
    if (this.engine && typeof this.engine.getRenderDiagnostics === 'function') {
      return this.engine.getRenderDiagnostics();
    }
    if (SANDBOX_RENDERER_ENABLED) {
      return {
        renderer: 'sandbox',
        runtimeErrors: [...(this._sandboxErrors || [])],
        renderLogs: [],
        deadUniforms: []
      };
    }
    return null;
  }

  probeRenderLogs(samplesOrOpts, restoreSample) {
    if (this.engine && typeof this.engine.probeRenderLogs === 'function') {
      return this.engine.probeRenderLogs(samplesOrOpts, restoreSample);
    }
    return null;
  }

  renderControls(container, onChange) {
    if (window.ControlsManager) {
      window.ControlsManager.render(container, this.preset, (key, value, meta) => {
        if (meta && (meta.type === 'image' || meta.type === 'video')) {
          this.setMediaSlot(key, meta.cleared ? null : (meta.url || value), meta.type);
        } else if (meta && meta.type === 'media_pool') {
          this.setMediaPool(key, value);
        } else {
          this._pushSandboxControl(key, value, meta);
        }
        if (typeof onChange === 'function') onChange(key, value, meta);
      });
    }
  }

  /**
   * Inspector values are written into the host preset, but the frame renders from its own clone of
   * it. Without this push every slider, colour and toggle moves the sidebar and nothing else.
   */
  _pushSandboxControl(id, value, meta = null) {
    if (!SANDBOX_RENDERER_ENABLED || !id) return;
    const kind = typeof value;
    if (value !== null && kind !== 'string' && kind !== 'number' && kind !== 'boolean') return;
    // the inspector is painted before the frame finishes booting, so a move made in that window
    // must be replayed rather than dropped — otherwise the first thing a user tries does nothing
    this._sandboxControlQueue = this._sandboxControlQueue || new Map();
    this._sandboxControlQueue.set(id, { id, value, meta });
    this._flushSandboxControls();
  }

  _flushSandboxControls() {
    if (!this._sandbox || !this._sandboxControlQueue || this._sandboxControlQueue.size === 0) return;
    for (const entry of this._sandboxControlQueue.values()) {
      this._sandbox.setControls({
        id: entry.id,
        value: entry.value,
        font: entry.meta && entry.meta.customFont ? entry.meta.customFont : null
      });
      // a stock family picked from the union list may not have been sent with the preset yet
      if (entry.meta && entry.meta.type === 'font' && !entry.meta.customFont && typeof entry.value === 'string') {
        this._sandbox.syncStockFonts?.([entry.value]);
      }
    }
    this._sandboxControlQueue.clear();
  }

  cleanup() {
    if (SANDBOX_RENDERER_ENABLED) {
      if (this._sandboxPaintedBitmap && typeof this._sandboxPaintedBitmap.close === 'function') {
        this._sandboxPaintedBitmap.close();
      }
      this._sandboxPaintedBitmap = null;
      const pending = this._sandboxPromise;
      if (this._sandbox) {
        this._sandbox.dispose();
      } else if (pending) {
        // boot can finish after the template was swapped; a frame nobody owns must not stay mounted
        pending.then((instance) => instance.dispose()).catch(() => {});
      }
      this._sandbox = null;
      this._sandboxPromise = null;
      this._sandboxWaiters = [];
      return;
    }
    if (this.engine && typeof this.engine.cleanup === 'function') {
      this.engine.cleanup();
      this.engine = null;
    }
  }
}

class TemplateRegistry {
  constructor() {
    this.templates = new Map();
    this.activeTemplate = null;
    this.activeTemplateId = null;
    this.listeners = [];
  }

  register(template) {
    if (!template || !template.id) {
      console.error('Invalid template passed to register', template);
      return;
    }
    this.templates.set(template.id, template);
  }

  registerPreset(preset) {
    if (!preset || !preset.id) return;
    const existing = this.templates.get(preset.id);
    if (existing && !(existing instanceof ReelPresetTemplateAdapter)) {
      return;
    }

    // a saved copy of a canvas template has to keep rendering through it. the 3-box twin in
    // STARTER_PRESET_DEFINITIONS is a separate implementation of the same idea, so opening the copy
    // through the adapter silently swapped the artwork for the simplified version.
    const twinId = preset.meta?.starterPresetId;
    const twin = twinId ? this.templates.get(twinId) : null;
    if (twin && !(twin instanceof ReelPresetTemplateAdapter) && typeof twin.constructor === 'function') {
      try {
        const copy = new twin.constructor();
        copy.id = preset.id;
        copy.name = preset.meta?.name || copy.name;
        copy.title = copy.name;
        copy.preset = preset;
        copy.savedParams = { ...(preset.controlsBox?.values || {}) };
        this.register(copy);
        return;
      } catch (err) {
        console.warn('[templateRegistry] could not reuse the canvas template for', preset.id, err);
      }
    }

    this.register(new ReelPresetTemplateAdapter(preset));
  }

  getAll() {
    return Array.from(this.templates.values());
  }

  get(id) {
    return this.templates.get(id);
  }

  async setTemplate(id, canvas, state, controlsContainer) {
    const next = this.templates.get(id);
    if (!next) {
      console.warn(`Template "${id}" not found. Falling back to default.`);
      return this.activeTemplate;
    }

    if (this.activeTemplate && this.activeTemplate !== next) {
      if (typeof this.activeTemplate.cleanup === 'function') {
        this.activeTemplate.cleanup();
      }
    }

    const isStarter = Boolean(
      window.STARTER_PRESET_DEFINITIONS?.[id] ||
      window.STARTER_PRESETS?.[id]
    );

    // only built-in starter presets inherit universal studio toggles or localstorage overrides;
    // user-saved presets always open with their exact saved controlsBox.values
    if (isStarter) {
      const universalKeys = ['cutMode', 'speedRamping', 'clipTransition', 'clipTransitionDuration', 'dropGlitch', 'autoFrame', 'seamlessLoop', 'loopStyle'];
      if (this.activeTemplate && next.params) {
        for (const k of universalKeys) {
          if (this.activeTemplate.params && this.activeTemplate.params[k] !== undefined) {
            next.params[k] = this.activeTemplate.params[k];
          }
        }
      }

      const saved = localStorage.getItem(`samplevis_preset_${id}`) || localStorage.getItem(`samplevis_template_${id}`);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          Object.assign(next.params, parsed);
        } catch (err) {
          console.warn('Could not restore template params', err);
        }
      }
    }

    this.activeTemplate = next;
    this.activeTemplateId = id;
    localStorage.setItem('samplevis_active_template_id', id);

    // initialize template with canvas
    if (typeof next.init === 'function') {
      next.init(canvas, state);
    }

    // a saved copy of a canvas template carries the knob values it was saved with; its params are
    // the live render state, so seed them once, after init, before the first frame
    if (next.savedParams) {
      try {
        Object.assign(next.params, next.savedParams);
      } catch { }
      delete next.savedParams;
    }

    // canvas templates draw in-page even while preset templates use the sandboxed frame
    try {
      const sandboxed = SANDBOX_RENDERER_ENABLED && next instanceof ReelPresetTemplateAdapter;
      document.documentElement.dataset.renderer = sandboxed ? 'sandbox' : 'in-page';
    } catch { }

    if (state && state.project && typeof next.setProject === 'function') {
      next.setProject(state.project);
    }

    if (state && state.videoPool && typeof next.setActiveVideos === 'function') {
      next.setActiveVideos(state.videoPool);
    }

    // render template-specific sidebar controls
    if (controlsContainer && typeof next.renderControls === 'function') {
      controlsContainer.innerHTML = '';
      next.renderControls(controlsContainer, (key, value, meta) => {
        next.params[key] = value;
        if (isStarter && !(meta && (meta.type === 'image' || meta.type === 'video'))) {
          try {
            localStorage.setItem(`samplevis_preset_${id}`, JSON.stringify(next.params));
          } catch (e) {}
        }
        window.dispatchEvent(new CustomEvent('samplevis:control-change', {
          detail: { key, value, meta }
        }));
        window.dispatchEvent(new CustomEvent('samplevis:preset-dirty'));
      });
    }

    // notify listeners
    this.listeners.forEach((fn) => {
      try {
        fn(next);
      } catch (err) {
        console.error('Error in template change listener:', err);
      }
    });

    return next;
  }

  onTemplateChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
    }
  }
}

window.ReelPresetTemplateAdapter = ReelPresetTemplateAdapter;
window.templateRegistry = new TemplateRegistry();

// auto-register built-in starter presets if loaded
if (window.STARTER_PRESETS) {
  Object.values(window.STARTER_PRESETS).forEach((preset) => {
    window.templateRegistry.registerPreset(preset);
  });
}
