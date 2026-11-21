// dual-layer preset runtime: webgl shader background + 2d canvas overlay
(function () {
  'use strict';

  function hexToRgb01(hex) {
    if (!hex || typeof hex !== 'string') return [1, 1, 1];
    let clean = hex.replace('#', '').trim();
    if (clean.length === 3) {
      clean = clean.split('').map((c) => c + c).join('');
    }
    const num = parseInt(clean, 16);
    if (Number.isNaN(num)) return [1, 1, 1];
    const r = ((num >> 16) & 255) / 255;
    const g = ((num >> 8) & 255) / 255;
    const b = (num & 255) / 255;
    return [r, g, b];
  }

  // the quad is the only geometry either layer uses, and both versions keep the same top-down uv
  // contract so a preset never has to know which one it was compiled against
  const VERT_SHADER_ES1 = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    uniform float u_flip_y;
    void main() {
      v_uv = (a_pos + 1.0) * 0.5;
      v_uv.y = 1.0 - v_uv.y; // standard top-down uv
      gl_Position = vec4(a_pos.x, a_pos.y * u_flip_y, 0.0, 1.0);
    }
  `;

  const VERT_SHADER_ES3 = `#version 300 es
    layout(location = 0) in vec2 a_pos;
    out vec2 v_uv;
    uniform float u_flip_y;
    void main() {
      v_uv = (a_pos + 1.0) * 0.5;
      v_uv.y = 1.0 - v_uv.y;
      gl_Position = vec4(a_pos.x, a_pos.y * u_flip_y, 0.0, 1.0);
    }
  `;

  // engine-owned bloom chain. es 1.00 on purpose: these run on both contexts and never depend on
  // the user-facing compiler or the webgl1 down-port.
  const BLOOM_PREFILTER_FRAG = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_scene_tex;
    uniform sampler2D u_overlay_tex;
    uniform float u_has_overlay;
    uniform float u_bloom_threshold;
    void main() {
      vec4 ov = u_has_overlay > 0.5 ? texture2D(u_overlay_tex, v_uv) : vec4(0.0);
      vec3 scene = texture2D(u_scene_tex, v_uv).rgb;
      // premultiplied over: no dark fringe around antialiased glyph edges
      vec3 col = scene * (1.0 - ov.a) + ov.rgb;
      float l = max(max(col.r, col.g), col.b);
      float k = max(0.0, l - u_bloom_threshold) / max(l, 0.0001);
      gl_FragColor = vec4(col * k, 1.0);
    }
  `;

  const BLOOM_TENT_FRAG = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_src;
    uniform vec2 u_texel;
    void main() {
      vec2 o = u_texel;
      vec4 c = texture2D(u_src, v_uv) * 4.0;
      c += texture2D(u_src, v_uv + vec2(-o.x, 0.0)) * 2.0;
      c += texture2D(u_src, v_uv + vec2( o.x, 0.0)) * 2.0;
      c += texture2D(u_src, v_uv + vec2(0.0, -o.y)) * 2.0;
      c += texture2D(u_src, v_uv + vec2(0.0,  o.y)) * 2.0;
      c += texture2D(u_src, v_uv + vec2(-o.x, -o.y));
      c += texture2D(u_src, v_uv + vec2( o.x, -o.y));
      c += texture2D(u_src, v_uv + vec2(-o.x,  o.y));
      c += texture2D(u_src, v_uv + vec2( o.x,  o.y));
      gl_FragColor = c / 16.0;
    }
  `;

  const BLOOM_LEVELS = 4;

  const GLSL3_VERSION_RE = /^\s*#version\s+300\s+es\b/;

  function detectGlslVersion(source) {
    return GLSL3_VERSION_RE.test(String(source || '')) ? 3 : 1;
  }

  // constructs with no GLSL ES 1.00 equivalent; a shader using them has to stay on WebGL2 instead of
  // being rewritten into something that compiles but renders a different image
  const GLSL3_ONLY_RE = /\b(?:textureLod|textureGrad|texelFetch|texelFetchOffset|textureSize|textureOffset|uvec[234]|isampler[23]D|usampler[23]D|flat\s+(?:in|out)|uint)\b/;

  /**
   * Best-effort port for the WebGL1 fallback, so ES 3.00 can be the authoring default without the
   * fallback losing the whole visual. Mechanical rewrites only: version line, out variable,
   * in -> varying, texture -> texture2D. Anything outside that set refuses with a reason.
   */
  function downportGlsl3To1(source) {
    const src = String(source || '');
    if (!GLSL3_VERSION_RE.test(src)) return { ok: true, source: src, changed: false };

    const blocker = src.match(GLSL3_ONLY_RE);
    if (blocker) return { ok: false, source: '', reason: `${blocker[0]} has no GLSL ES 1.00 equivalent` };

    let out = src.replace(/^\s*#version\s+300\s+es[^\n]*\n?/i, '');
    const outDecl = out.match(/\bout\s+vec4\s+([A-Za-z_]\w*)\s*;/);
    if (outDecl) {
      const name = outDecl[1];
      out = out.replace(new RegExp(`\\bout\\s+vec4\\s+${name}\\s*;[ \\t]*\\n?`), '');
      out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), 'gl_FragColor');
    }
    out = out.replace(/^([ \t]*)in\s+/gm, '$1varying ');
    out = out.replace(/\btexture\s*\(/g, 'texture2D(');
    return { ok: true, source: out, changed: true };
  }

  // a clip that is seeking or still decoding has no frame to upload. dropping u_has_video to 0
  // there turns every cut into a black flash, so hold the last uploaded frame instead: for as long
  // as the seek is actually in flight (transient by definition), and for a bounded window after the
  // last real upload when nothing is seeking.
  const VIDEO_HOLD_MS = 1200;

  // gated readout for the "clip is black for a moment" class of bug: ?videodiag=1 (in-page renderer)
  const VIDEO_DIAG = (() => {
    try {
      return typeof window !== 'undefined'
        && /[?&]videodiag=1(&|$)/.test(String(window.location.search || ''));
    } catch { return false; }
  })();
  function resolveVideoUpload({ ready, hasActiveVideo, seeking, textureValid, msSinceUpload, holdMs = VIDEO_HOLD_MS }) {
    if (ready) return { upload: true, hasVideo: true };
    if (!hasActiveVideo || !textureValid) return { upload: false, hasVideo: false };
    const holding = Boolean(seeking) || (msSinceUpload >= 0 && msSinceUpload < holdMs);
    return { upload: false, hasVideo: holding };
  }

  const FALLBACK_FRAG_SHADER = `
    precision mediump float;
    varying vec2 v_uv;
    uniform vec2 u_resolution;
    uniform float u_time;
    void main() {
      gl_FragColor = vec4(0.07, 0.09, 0.16, 1.0);
    }
  `;

  class ReelEngine {
    constructor(targetCanvas) {
      this.canvas = targetCanvas;
      this.ctx = targetCanvas.getContext('2d', { alpha: false });

      this.aspectRatio = '9:16';
      this.width = 1080;
      this.height = 1920;

      // offscreen webgl canvas for box 1
      this.glCanvas = document.createElement('canvas');
      this.glCanvas.width = this.width;
      this.glCanvas.height = this.height;
      // webgl2 first so es 3.00 presets compile natively and layer 1 can render into a float target;
      // webgl1 stays as the fallback and still runs es 3.00 sources through the down-port
      const glOptions = {
        alpha: false,
        antialias: true,
        preserveDrawingBuffer: true,
        premultipliedAlpha: false
      };
      this.gl = this.glCanvas.getContext('webgl2', glOptions)
        || this.glCanvas.getContext('webgl', glOptions)
        || this.glCanvas.getContext('experimental-webgl');
      // createVertexArray is the cheapest reliable webgl2 marker and survives a mocked context
      this.isWebGL2 = Boolean(this.gl && typeof this.gl.createVertexArray === 'function');
      // rgba16f render targets are what let layer 1 hand hdr values to the post pass
      this._hasFloatFbo = Boolean(this.isWebGL2 && this.gl.getExtension && this.gl.getExtension('EXT_color_buffer_float'));

      this.preset = null;
      this.project = null;
      this.state = {};
      this.activeVideos = [];
      this.shaderClipIndex = 0;
      this.lastTriggeredTime = -1;
      this._lastTriggerWindowStart = -1;
      this.customImage = null;
      this.customImageDataUrl = null;
      this.customImageReady = false;
      this.customImageTextureDirty = false;
      this._pendingCustomImageRef = null;
      this._uploadedShaderImageEl = null;
      this.mediaSlots = new Map();
      this._pendingSlotRefs = new Map();
      this.mediaPools = new Map();
      this._mediaPoolCache = new Map();
      this._pendingPoolRefs = new Map();
      this.lyricsData = null;
      this._loadedPresetId = null;
      this.onAssetLoaded = null;
      this._fxSignalState = new Map();
      this._lastSmoothTime = -1;

      // compiled routines
      this.compiledInitScript = null;
      this.compiledDrawScript = null;
      this.glProgram = null;
      this.uniformLocations = {};
      this.postProgram = null;
      this.postUniformLocations = {};

      // webgl geometry & textures
      this._initWebGLQuad();
      this._initTextures();

      // layer 2 lives on its own transparent canvas so the post pass can sample it as a texture
      this.overlayCanvas = document.createElement('canvas');
      this.overlayCanvas.width = this.width;
      this.overlayCanvas.height = this.height;
      this.overlayCtx = this.overlayCanvas.getContext('2d', { alpha: true });

      // layer 3 targets, allocated lazily on the first composite
      this.sceneFbo = null;
      this.sceneTexture = null;
      this.sceneFormat = null;
      this.overlayTexture = null;
      this.bloomFbos = [];
      this.bloomTextures = [];
      this.bloomPrograms = null;
      this._pipelineSize = '';
      this._postSamplesOverlay = true;
      this._pipelinePasses = 0;
      this._frameValues = null;

      // audio analysis buffers for standard uniforms
      this.fftArray = new Uint8Array(256);
      this.waveformArray = new Uint8Array(256);
      this.waveformArray.fill(128);
      this.audioSignalData = null;
      this._audioSignalUrl = null;
      this.lastRuntimeErrors = [];
      this.renderLogs = [];
      this.deadUniforms = [];
      this._loggedKeys = new Set();
      this._userLogCount = 0;
      this._detectedCustomClipTransition = false;
      this._dispatchedCustomClipTransition = false;
      this._disposeClipTransitionStates();
      this._checkedGlError = false;
      this._suppressNativeConsole = false;
      this._videoTextureValid = false;
      this._lastVideoUploadMs = undefined;
      this._lastFrameDiag = null;
      this._lyricUniforms = null;
      this._probeTraces = new Map();
      this._suppressProbe = false;
      this._pixelCanvas = null;
      this._pixelCtx = null;
      this._pixelSample = null;
      this._pixelLuma = null;
      this._frameMs = 0;
      this._frameMsMax = 0;

      // selected tracks set
      this.selectedTrackIds = new Set();

      this.loopCache = window.loopUtils ? new window.loopUtils.SeamlessLoopCache() : null;
      this._cachedProjectData = null;
      this._motionScratch = window.motionKit ? window.motionKit.createScratchState() : null;
      this._clipTransitionStates = new Map();
      this._detectedCustomClipTransition = false;
      this._dispatchedCustomClipTransition = false;
    }

    hasCustomClipTransition() {
      return Boolean(
        this.preset?.modules?.clips?.customTransition === true ||
        this._detectedCustomClipTransition
      );
    }

    _getClipTransitionState(key) {
      if (!window.motionKit?.createClipTransitionState) return null;
      let ts = this._clipTransitionStates.get(key);
      if (!ts) {
        ts = window.motionKit.createClipTransitionState();
        this._clipTransitionStates.set(key, ts);
      }
      return ts;
    }

    _disposeClipTransitionStates() {
      if (!this._clipTransitionStates) return;
      for (const ts of this._clipTransitionStates.values()) {
        window.motionKit?.disposeClipTransitionState?.(ts);
      }
      this._clipTransitionStates.clear();
    }

    get params() {
      if (!this.preset) return {};
      if (!this.preset.controlsBox) this.preset.controlsBox = { fields: [], values: {} };
      if (!this.preset.controlsBox.values || typeof this.preset.controlsBox.values !== 'object') {
        this.preset.controlsBox.values = {};
      }
      return this.preset.controlsBox.values;
    }

    setAspectRatio(ratio) {
      if (ratio === '16:9') {
        this.aspectRatio = '16:9';
        this.width = 1920;
        this.height = 1080;
      } else if (ratio === '1:1') {
        this.aspectRatio = '1:1';
        this.width = 1080;
        this.height = 1080;
      } else {
        this.aspectRatio = '9:16';
        this.width = 1080;
        this.height = 1920;
      }

      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.glCanvas.width = this.width;
      this.glCanvas.height = this.height;
      if (this.overlayCanvas) {
        this.overlayCanvas.width = this.width;
        this.overlayCanvas.height = this.height;
      }
      this._disposePipelineTargets();

      if (this.gl) {
        this.gl.viewport(0, 0, this.width, this.height);
      }

      if (this.loopCache) this.loopCache.invalidate();
      if (this.preset) {
        this.reinitPresetState();
      }
    }

    _initWebGLQuad() {
      const gl = this.gl;
      if (!gl) return;

      const quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      // two triangles covering the full clip-space
      const vertices = new Float32Array([
        -1.0, -1.0,
        1.0, -1.0,
        -1.0, 1.0,
        -1.0, 1.0,
        1.0, -1.0,
        1.0, 1.0
      ]);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      this.quadBuffer = quadBuffer;

      // every program uses attribute 0, so one vao is enough and switching programs cannot drop
      // the attribute state
      if (this.isWebGL2 && typeof gl.createVertexArray === 'function') {
        this.quadVao = gl.createVertexArray();
        gl.bindVertexArray(this.quadVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
      }
    }

    _initTextures() {
      const gl = this.gl;
      if (!gl) return;

      // fft 1d spectrum texture (256x1)
      this.fftTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.fftTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.LUMINANCE, 256, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, this.fftArray
      );

      // time-domain 1d waveform texture (256x1, center 0.5)
      this.waveformTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.waveformTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.LUMINANCE, 256, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, this.waveformArray
      );

      // video clip sampler2d texture
      this.videoTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      // dummy 1x1 dark pixel until video arrives
      const black = new Uint8Array([18, 24, 41, 255]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, black);

      // user-uploaded image sampler2d texture
      this.imageTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      const emptyPx = new Uint8Array([0, 0, 0, 0]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, emptyPx);

      // bound wherever an overlay sampler exists but nothing was drawn: an unbound sampler returns
      // opaque black, which would paint the whole frame black through the over-operator
      this.transparentTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.transparentTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, emptyPx);
    }

    _getMissingMediaPlaceholderUrl(label = 'missing media', kind = 'image') {
      const safeLabel = String(label || 'missing media')
        .replace(/[<>&"']/g, '')
        .slice(0, 28) || 'missing media';
      const safeKind = kind === 'video' ? 'video' : 'image';
      const cacheKey = `${safeKind}:${safeLabel}`;
      if (!this._placeholderUrlCache) this._placeholderUrlCache = new Map();
      if (this._placeholderUrlCache.has(cacheKey)) {
        return this._placeholderUrlCache.get(cacheKey);
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">` +
        `<rect x="10" y="10" width="300" height="300" rx="18" fill="#16214e" fill-opacity="0.72" stroke="#83ca90" stroke-width="3" stroke-dasharray="10 8"/>` +
        `<path d="M118 128h84v56h-84z" fill="none" stroke="#a5ccaf" stroke-width="3" rx="6"/>` +
        `<circle cx="140" cy="146" r="6" fill="#83ca90"/>` +
        `<path d="M124 176l22-20 16 14 14-12 20 18" fill="none" stroke="#a5ccaf" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<text x="160" y="212" text-anchor="middle" font-family="ui-monospace, monospace" font-size="14" fill="#f0f7f2">missing ${safeKind}</text>` +
        `<text x="160" y="232" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="#9daea8">${safeLabel}</text>` +
        `</svg>`;
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      this._placeholderUrlCache.set(cacheKey, url);
      return url;
    }

    setCustomImage(dataUrl) {
      if (typeof dataUrl === 'string' && dataUrl.startsWith('idb://') && typeof window !== 'undefined' && window.projectBundleService) {
        this._pendingCustomImageRef = dataUrl;
        const parsed = window.projectBundleService.parseIdbRef(dataUrl);
        if (parsed) {
          window.projectBundleService.getSlotMedia(parsed.presetId, parsed.slotId).then((rec) => {
            if (this._pendingCustomImageRef !== dataUrl) return;
            this._pendingCustomImageRef = null;
            if (rec?.objectUrl) {
              this.setCustomImage(rec.objectUrl);
            } else {
              this._recordRenderLog('warn', 'assets', 'customImage missing in local storage; showing placeholder');
              this.setCustomImage(this._getMissingMediaPlaceholderUrl('custom image', 'image'));
            }
          }).catch(() => {
            if (this._pendingCustomImageRef !== dataUrl) return;
            this._pendingCustomImageRef = null;
            this.setCustomImage(this._getMissingMediaPlaceholderUrl('custom image', 'image'));
          });
        }
        return;
      }

      this._pendingCustomImageRef = null;
      const clean = (typeof dataUrl === 'string' && (dataUrl.startsWith('data:image/') || dataUrl.startsWith('blob:') || dataUrl.startsWith('/') || /^https?:\/\//i.test(dataUrl)))
        ? dataUrl
        : null;
      if (clean === this.customImageDataUrl && (clean ? this.customImageReady : true)) return;
      this.customImageDataUrl = clean;
      this.customImageReady = false;
      this.customImageTextureDirty = false;

      if (!clean) {
        this.customImage = null;
        this._uploadedShaderImageEl = null;
        return;
      }

      const img = new Image();
      if (/^https?:\/\//i.test(clean)) img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (this.customImageDataUrl !== clean) return;
        this.customImage = img;
        this.customImageReady = true;
        this.customImageTextureDirty = true;
        if (this.loopCache) this.loopCache.invalidate();
        if (typeof this.onAssetLoaded === 'function') {
          this.onAssetLoaded();
        }
      };
      img.onerror = () => {
        if (this.customImageDataUrl === clean) {
          this._recordRenderLog('warn', 'assets', 'customImage failed to decode or load; showing placeholder');
          if (!clean.startsWith('data:image/svg+xml')) {
            this.setCustomImage(this._getMissingMediaPlaceholderUrl('custom image', 'image'));
          } else {
            this.customImage = null;
            this.customImageReady = false;
          }
        }
      };
      img.src = clean;
    }

    setLyricsData(lyricsData) {
      this.lyricsData = lyricsData || null;
      if (this.loopCache) this.loopCache.invalidate();
    }

    _disposeMediaSlotEntry(entry) {
      if (!entry) return;
      if (entry.kind === 'video' && entry.el) {
        try {
          entry.el.pause();
          entry.el.removeAttribute('src');
          entry.el.load();
        } catch { }
      }
    }

    _disposeMediaPoolEntry(entry) {
      if (!entry) return;
      if (entry.kind === 'video' && entry.el) {
        try {
          entry.el.pause();
          entry.el.removeAttribute('src');
          entry.el.load();
        } catch { }
      }
    }

    _decodeMediaPoolEntry(poolId, item, resolvedUrl, itemKey) {
      const cached = this._mediaPoolCache.get(itemKey);
      if (cached && cached.resolvedUrl === resolvedUrl && cached.kind === item.kind) {
        cached.name = item.name;
        cached.enabled = item.enabled !== false;
        return cached;
      }
      if (cached) {
        this._disposeMediaPoolEntry(cached);
      }

      const entry = {
        id: item.id,
        name: item.name,
        kind: item.kind,
        src: item.src,
        resolvedUrl,
        enabled: item.enabled !== false,
        el: null,
        ready: false,
        width: 0,
        height: 0,
        duration: 0
      };

      if (item.kind === 'video') {
        const video = document.createElement('video');
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'auto';
        if (resolvedUrl.startsWith('http://') || resolvedUrl.startsWith('https://')) {
          video.crossOrigin = 'anonymous';
        }
        entry.el = video;
        video.onloadeddata = () => {
          entry.ready = video.readyState >= 2;
          entry.width = video.videoWidth || 1280;
          entry.height = video.videoHeight || 720;
          entry.duration = Number.isFinite(video.duration) ? video.duration : 5.0;
          if (this.loopCache) this.loopCache.invalidate();
          if (typeof this.onAssetLoaded === 'function') this.onAssetLoaded(`${poolId}:${item.id}`);
        };
        video.onseeked = () => {
          if (this.loopCache) this.loopCache.invalidate();
          if (typeof this.onAssetLoaded === 'function') this.onAssetLoaded(`${poolId}:${item.id}`);
        };
        video.onerror = () => {
          this._recordRenderLog('warn', 'pools', `pool "${poolId}" video "${item.name}" failed to load; showing placeholder`);
          const ph = new Image();
          ph.onload = () => {
            entry.el = ph;
            entry.kind = 'image';
            entry.ready = true;
            entry.missingPlaceholder = true;
            entry.width = ph.naturalWidth || 320;
            entry.height = ph.naturalHeight || 320;
            if (this.loopCache) this.loopCache.invalidate();
            if (typeof this.onAssetLoaded === 'function') this.onAssetLoaded(`${poolId}:${item.id}`);
          };
          ph.src = this._getMissingMediaPlaceholderUrl(item.name || poolId, 'video');
        };
        video.src = resolvedUrl;
      } else {
        const img = new Image();
        img.decoding = 'async';
        if (resolvedUrl.startsWith('http://') || resolvedUrl.startsWith('https://')) {
          img.crossOrigin = 'anonymous';
        }
        entry.el = img;
        img.onload = () => {
          entry.ready = true;
          entry.width = img.naturalWidth || 128;
          entry.height = img.naturalHeight || 128;
          if (this.loopCache) this.loopCache.invalidate();
          if (typeof this.onAssetLoaded === 'function') this.onAssetLoaded(`${poolId}:${item.id}`);
        };
        img.onerror = () => {
          this._recordRenderLog('warn', 'pools', `pool "${poolId}" image "${item.name}" failed to decode; showing placeholder`);
          if (!String(resolvedUrl).startsWith('data:image/svg+xml')) {
            entry.missingPlaceholder = true;
            img.src = this._getMissingMediaPlaceholderUrl(item.name || poolId, 'image');
          } else {
            entry.ready = false;
          }
        };
        img.src = resolvedUrl;
      }

      this._mediaPoolCache.set(itemKey, entry);
      return entry;
    }

    setMediaPool(poolId, rawItems = []) {
      if (!poolId) return;
      const helper = typeof window !== 'undefined' ? window.MediaPoolHelper : null;
      const items = helper ? helper.normalizePoolItems(rawItems) : (Array.isArray(rawItems) ? rawItems : []);
      const nextEntries = [];
      const activeKeys = new Set();

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || !item.src) continue;
        if (typeof window !== 'undefined' && window.SANDBOX_FRAME && String(item.src).startsWith('idb://')) continue;
        const itemKey = `${poolId}::${item.id}`;
        activeKeys.add(itemKey);

        if (item.src.startsWith('idb://') && typeof window !== 'undefined' && window.projectBundleService) {
          const existing = this._mediaPoolCache.get(itemKey);
          if (existing && existing.src === item.src && existing.resolvedUrl) {
            existing.name = item.name;
            existing.enabled = item.enabled !== false;
            nextEntries.push(existing);
            continue;
          }
          const placeholder = {
            id: item.id,
            name: item.name,
            kind: item.kind,
            src: item.src,
            resolvedUrl: null,
            enabled: item.enabled !== false,
            el: null,
            ready: false,
            width: 0,
            height: 0,
            duration: 0
          };
          nextEntries.push(placeholder);
          this._pendingPoolRefs.set(itemKey, item.src);
          const parsed = window.projectBundleService.parseIdbRef(item.src);
          const targetPid = parsed?.presetId || this.preset?.id || 'default';
          const targetSlot = parsed?.slotId || `${poolId}__${item.id}`;
          window.projectBundleService.getSlotMedia(targetPid, targetSlot).then((rec) => {
            if (this._pendingPoolRefs.get(itemKey) !== item.src) return;
            this._pendingPoolRefs.delete(itemKey);
            const targetUrl = rec?.objectUrl || this._getMissingMediaPlaceholderUrl(item.name || poolId, item.kind);
            if (!rec?.objectUrl) {
              this._recordRenderLog('warn', 'pools', `pool "${poolId}" item "${item.name}" missing in local storage; showing placeholder`);
            }
            const decoded = this._decodeMediaPoolEntry(
              poolId,
              rec?.objectUrl ? item : { ...item, kind: 'image' },
              targetUrl,
              itemKey
            );
            if (!rec?.objectUrl) decoded.missingPlaceholder = true;
            const poolList = this.mediaPools.get(poolId);
            if (Array.isArray(poolList)) {
              const idx = poolList.indexOf(placeholder);
              if (idx >= 0) poolList[idx] = decoded;
            }
          }).catch(() => { });
          continue;
        }

        nextEntries.push(this._decodeMediaPoolEntry(poolId, item, item.src, itemKey));
      }

      for (const [k, cached] of Array.from(this._mediaPoolCache.entries())) {
        if (k.startsWith(`${poolId}::`) && !activeKeys.has(k)) {
          this._disposeMediaPoolEntry(cached);
          this._mediaPoolCache.delete(k);
          this._pendingPoolRefs.delete(k);
        }
      }

      this.mediaPools.set(poolId, nextEntries);
    }

    setMediaSlot(slotId, urlOrRef, kind = 'image', meta = {}) {
      if (!slotId) return;
      // inside the sandboxed frame an idb:// ref cannot be resolved: the host sends bytes instead
      if (typeof urlOrRef === 'string' && urlOrRef.startsWith('idb://') && typeof window !== 'undefined' && window.SANDBOX_FRAME) {
        return;
      }
      if (typeof urlOrRef === 'string' && urlOrRef.startsWith('idb://') && typeof window !== 'undefined' && window.projectBundleService) {
        this._pendingSlotRefs.set(slotId, urlOrRef);
        const parsed = window.projectBundleService.parseIdbRef(urlOrRef);
        const fallbackPid = this.preset?.id || 'default';
        const targetPid = parsed?.presetId || fallbackPid;
        const targetSlot = parsed?.slotId || slotId;
        window.projectBundleService.getSlotMedia(targetPid, targetSlot).then((rec) => {
          if (this._pendingSlotRefs.get(slotId) !== urlOrRef) return;
          this._pendingSlotRefs.delete(slotId);
          if (rec?.objectUrl) {
            this.setMediaSlot(slotId, rec.objectUrl, rec.kind || kind);
          } else {
            this._recordRenderLog('warn', 'assets', `media slot "${slotId}" missing in local storage; showing placeholder`);
            this.setMediaSlot(slotId, this._getMissingMediaPlaceholderUrl(slotId, kind), 'image', { placeholder: true });
          }
        }).catch(() => { });
        return;
      }

      this._pendingSlotRefs.delete(slotId);
      const existing = this.mediaSlots.get(slotId);
      if (!urlOrRef) {
        if (existing) {
          this._disposeMediaSlotEntry(existing);
          this.mediaSlots.delete(slotId);
          this._uploadedShaderImageEl = null;
          if (this.loopCache) this.loopCache.invalidate();
        }
        return;
      }

      if (existing && existing.url === urlOrRef && existing.kind === kind) {
        return;
      }
      if (existing) {
        this._disposeMediaSlotEntry(existing);
        this.mediaSlots.delete(slotId);
      }

      if (kind === 'video') {
        const vid = document.createElement('video');
        vid.muted = true;
        vid.loop = true;
        vid.playsInline = true;
        vid.preload = 'auto';
        vid.crossOrigin = 'anonymous';
        const entry = { slotId, kind: 'video', url: urlOrRef, el: vid, ready: false, placeholder: Boolean(meta.placeholder) };
        this.mediaSlots.set(slotId, entry);

        const markReady = () => {
          if (this.mediaSlots.get(slotId) !== entry) return;
          if (!entry.ready) {
            entry.ready = true;
            if (this.loopCache) this.loopCache.invalidate();
            if (typeof this.onAssetLoaded === 'function') this.onAssetLoaded(slotId);
          }
        };
        vid.addEventListener('loadeddata', markReady);
        vid.addEventListener('canplay', markReady);
        vid.addEventListener('seeked', () => {
          if (this.mediaSlots.get(slotId) !== entry) return;
          if (this.loopCache) this.loopCache.invalidate();
          if (typeof this.onAssetLoaded === 'function') this.onAssetLoaded(slotId);
        });
        vid.addEventListener('error', () => {
          if (this.mediaSlots.get(slotId) === entry) {
            this._recordRenderLog('warn', 'assets', `media slot "${slotId}" video failed to load; showing placeholder`);
            this.setMediaSlot(slotId, this._getMissingMediaPlaceholderUrl(slotId, 'video'), 'image', { placeholder: true });
          }
        });
        vid.src = urlOrRef;
        try { vid.currentTime = 0; } catch { }
        return;
      }

      const img = new Image();
      if (/^https?:\/\//i.test(urlOrRef)) img.crossOrigin = 'anonymous';
      const entry = { slotId, kind: 'image', url: urlOrRef, el: img, ready: false, placeholder: Boolean(meta.placeholder) };
      this.mediaSlots.set(slotId, entry);
      img.onload = () => {
        if (this.mediaSlots.get(slotId) !== entry) return;
        entry.ready = true;
        this.customImageTextureDirty = true;
        if (this.loopCache) this.loopCache.invalidate();
        if (typeof this.onAssetLoaded === 'function') this.onAssetLoaded(slotId);
      };
      img.onerror = () => {
        if (this.mediaSlots.get(slotId) === entry) {
          this._recordRenderLog('warn', 'assets', `media slot "${slotId}" image failed to load; showing placeholder`);
          if (!String(urlOrRef).startsWith('data:image/svg+xml')) {
            this.setMediaSlot(slotId, this._getMissingMediaPlaceholderUrl(slotId, 'image'), 'image', { placeholder: true });
          } else {
            entry.ready = false;
          }
        }
      };
      img.src = urlOrRef;
    }

    getMediaSlotElements(kind = null) {
      const out = [];
      for (const entry of this.mediaSlots.values()) {
        if (!entry || !entry.el) continue;
        if (!kind || entry.kind === kind) out.push(entry.el);
      }
      if (this.mediaPools) {
        for (const list of this.mediaPools.values()) {
          if (!Array.isArray(list)) continue;
          for (const entry of list) {
            if (!entry || !entry.el || entry.enabled === false) continue;
            if (!kind || entry.kind === kind) out.push(entry.el);
          }
        }
      }
      return out;
    }

    _syncMediaSlotsFromPreset(preset) {
      const fields = Array.isArray(preset?.controlsBox?.fields) ? preset.controlsBox.fields : [];
      const values = preset?.controlsBox?.values || {};
      const pid = preset?.id || 'default';
      const declaredIds = new Set();
      const declaredPoolIds = new Set();

      for (const f of fields) {
        if (!f) continue;
        if (f.type === 'media_pool') {
          declaredPoolIds.add(f.id);
          this.setMediaPool(f.id, Array.isArray(values[f.id]) ? values[f.id] : []);
          continue;
        }
        if (f.type !== 'image' && f.type !== 'video') continue;
        declaredIds.add(f.id);
        const val = values[f.id];
        if (typeof val === 'string' && val) {
          this.setMediaSlot(f.id, val, f.type);
        } else if (typeof window !== 'undefined' && window.projectBundleService) {
          window.projectBundleService.getSlotMedia(pid, f.id).then((rec) => {
            if (this.preset !== preset) return;
            if (rec?.objectUrl) {
              values[f.id] = window.projectBundleService.makeIdbRef(pid, f.id);
              this.setMediaSlot(f.id, rec.objectUrl, f.type);
            }
          }).catch(() => { });
        }
      }

      for (const [slotId, entry] of Array.from(this.mediaSlots.entries())) {
        if (!declaredIds.has(slotId)) {
          this._disposeMediaSlotEntry(entry);
          this.mediaSlots.delete(slotId);
        }
      }

      for (const poolId of Array.from(this.mediaPools.keys())) {
        if (!declaredPoolIds.has(poolId)) {
          this.setMediaPool(poolId, []);
          this.mediaPools.delete(poolId);
        }
      }
    }

    _formatLogArgs(args) {
      return args.map((arg) => {
        if (typeof arg === 'string') return arg;
        if (typeof arg === 'number') return Number.isFinite(arg) ? String(Number(arg.toFixed(4))) : String(arg);
        if (typeof arg === 'boolean' || arg == null) return String(arg);
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }).join(' ').slice(0, 200);
    }

    _recordRenderLog(level, category, message, time = null, allowDuplicates = false) {
      const cleanMsg = String(message || '').trim().slice(0, 220);
      if (!cleanMsg) return;
      if (!this._loggedKeys) this._loggedKeys = new Set();
      if (!this.renderLogs) this.renderLogs = [];
      const dedupeKey = `${level}:${category}:${cleanMsg}`;
      if (!allowDuplicates && this._loggedKeys.has(dedupeKey)) return;
      this._loggedKeys.add(dedupeKey);
      const timeTag = (typeof time === 'number' && Number.isFinite(time)) ? ` @${time.toFixed(2)}s` : '';
      const entry = `[${level}] ${category}${timeTag}: ${cleanMsg}`;
      this.renderLogs.push(entry);
      if (this.renderLogs.length > 20) {
        this.renderLogs.shift();
      }
    }

    _recordUserLog(phase, time, args, level = 'log') {
      if (this._userLogCount >= 12) return;
      const formatted = this._formatLogArgs(args);
      if (!formatted) return;
      if (!this._loggedKeys) this._loggedKeys = new Set();
      const dedupeKey = `user:${level}:${phase}:${formatted}`;
      if (this._loggedKeys.has(dedupeKey)) return;
      this._loggedKeys.add(dedupeKey);
      this._userLogCount += 1;
      this._recordRenderLog(level, phase, formatted, time, true);
    }

    _createScriptConsole(phase, time = null) {
      const baseConsole = typeof console !== 'undefined' ? console : {};
      const wrap = (method, level) => (...args) => {
        this._recordUserLog(phase, time, args, level);
        if (!this._suppressNativeConsole && typeof baseConsole[method] === 'function') {
          baseConsole[method](...args);
        }
      };
      return {
        ...baseConsole,
        log: wrap('log', 'log'),
        info: wrap('info', 'info'),
        warn: wrap('warn', 'warn'),
        error: wrap('error', 'error')
      };
    }

    _recordRuntimeError(phase, err) {
      const msg = typeof err === 'string' ? err : (err?.message || String(err || 'unknown error'));
      const clean = `${phase}: ${msg}`.trim().slice(0, 260);
      if (!this.lastRuntimeErrors) this.lastRuntimeErrors = [];
      if (this.lastRuntimeErrors.includes(clean)) return;
      this.lastRuntimeErrors.push(clean);
      if (this.lastRuntimeErrors.length > 4) {
        this.lastRuntimeErrors.shift();
      }
    }

    /**
     * Compiles one fragment source against the version-matched vertex shader. Pairing them is what
     * keeps a single quad contract: ES 3.00 fragments need the ES 3.00 vertex shader, ES 1.00 (and
     * anything down-ported) needs the ES 1.00 one.
     */
    _compileProgram(fragSource, label = 'shader') {
      const gl = this.gl;
      if (!gl) return null;

      let version = detectGlslVersion(fragSource);
      let source = String(fragSource || '');
      if (version === 3) {
        if (!this.isWebGL2) {
          const ported = downportGlsl3To1(source);
          if (!ported.ok) {
            this._recordRuntimeError(`${label} compile`, `this preset needs WebGL2 (${ported.reason})`);
            this._recordRenderLog('error', 'webgl', `${label} needs WebGL2: ${ported.reason}`);
            return null;
          }
          source = ported.source;
          version = 1;
        } else if (!/precision\s+(?:lowp|mediump|highp)\s+float\s*;/.test(source)) {
          // es 3.00 has no default float precision in fragment shaders, so omitting it is the most
          // common compile failure there; highp is guaranteed in es 3.00
          source = source.replace(/(^\s*#version\s+300\s+es[^\n]*)/, '$1\nprecision highp float;');
        }
      }

      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, version === 3 ? VERT_SHADER_ES3 : VERT_SHADER_ES1);
      gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        const vsInfo = gl.getShaderInfoLog(vs);
        gl.deleteShader(vs);
        this._recordRuntimeError(`${label} compile`, `vertex shader failed: ${vsInfo || 'glsl syntax error'}`);
        return null;
      }

      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, source);
      gl.compileShader(fs);

      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(fs);
        console.error(`${label} fragment compile error:`, info);
        this._recordRuntimeError(`${label} compile`, info || 'glsl syntax error');
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return null;
      }

      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      // explicit location so switching between layer 1, layer 3 and the internal passes never drops
      // the quad attribute; a no-op for es 3.00 sources that declare layout(location = 0)
      gl.bindAttribLocation(prog, 0, 'a_pos');
      gl.linkProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);

      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const linkInfo = gl.getProgramInfoLog(prog);
        console.error(`${label} program link error:`, linkInfo);
        this._recordRuntimeError(`${label} link`, linkInfo || 'glsl link error');
        gl.deleteProgram(prog);
        return null;
      }

      return prog;
    }

    _bindQuadAttributes(prog) {
      const gl = this.gl;
      if (!gl || !prog) return;
      gl.useProgram(prog);
      if (this.quadVao) {
        gl.bindVertexArray(this.quadVao);
        return;
      }
      const aPos = gl.getAttribLocation(prog, 'a_pos');
      if (aPos < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    }

    _loc(prog, cache, name) {
      const gl = this.gl;
      if (!gl || !prog || !cache) return null;
      if (cache[name] === undefined) cache[name] = gl.getUniformLocation(prog, name);
      return cache[name];
    }

    // -1 when the target is a texture, +1 when it is the canvas. every pass follows this, or the
    // bloom chain inverts once per level and the glow ends up under the text.
    _setFlip(prog, flip) {
      const gl = this.gl;
      if (!gl || !prog) return;
      if (!this._flipLocCache) this._flipLocCache = new WeakMap();
      let cache = this._flipLocCache.get(prog);
      if (!cache) {
        cache = {};
        this._flipLocCache.set(prog, cache);
      }
      const l = this._loc(prog, cache, 'u_flip_y');
      if (l) gl.uniform1f(l, flip);
    }

    _bindFrameValues(loc) {
      const gl = this.gl;
      const values = this._frameValues;
      if (!gl || !values) return;
      for (const name in values) {
        const l = loc(name);
        if (!l) continue;
        const v = values[name];
        if (Array.isArray(v)) gl.uniform2f(l, v[0], v[1]);
        else gl.uniform1f(l, v);
      }
    }

    _bindControlUniforms(loc, { markDead = false } = {}) {
      const gl = this.gl;
      const fields = this.preset?.controlsBox?.fields || [];
      const values = this.preset?.controlsBox?.values || {};
      if (!this._postUniformPresence) this._postUniformPresence = {};
      for (const f of fields) {
        if (!f || f.type === 'section' || !f.id) continue;
        if (f.target !== 'shader_uniform' && f.target !== 'both') continue;
        const l = loc(f.id);
        if (!l) {
          if (!markDead) continue;
          // the bloom threshold is consumed by the engine's prefilter, so "no shader declares it"
          // is the normal case rather than a dead control
          if (f.id === 'u_bloom_threshold') continue;
          // a control is only dead when neither program declares it: a post-only uniform is wired
          if (this._postUniformPresence[f.id] === undefined) {
            this._postUniformPresence[f.id] = this.postProgram ? gl.getUniformLocation(this.postProgram, f.id) : null;
          }
          if (this._postUniformPresence[f.id]) continue;
          if (!this.deadUniforms.includes(f.id)) {
            this.deadUniforms.push(f.id);
            this._recordRenderLog('warn', 'shader_uniform', `control "${f.id}" uniform is inactive or unused in both shaders`);
          }
          continue;
        }
        const val = values[f.id] !== undefined ? values[f.id] : f.defaultValue;
        if (f.type === 'slider') {
          gl.uniform1f(l, parseFloat(val) || 0);
        } else if (f.type === 'toggle') {
          gl.uniform1f(l, val ? 1.0 : 0.0);
        } else if (f.type === 'color') {
          const rgb = hexToRgb01(String(val));
          gl.uniform3f(l, rgb[0], rgb[1], rgb[2]);
        }
      }
    }

    _disposePipelineTargets() {
      const gl = this.gl;
      if (!gl) return;
      if (this.sceneFbo) gl.deleteFramebuffer(this.sceneFbo);
      if (this.sceneTexture) gl.deleteTexture(this.sceneTexture);
      if (this.overlayTexture) gl.deleteTexture(this.overlayTexture);
      for (const fbo of this.bloomFbos) if (fbo) gl.deleteFramebuffer(fbo);
      for (const tex of this.bloomTextures) if (tex) gl.deleteTexture(tex);
      this.sceneFbo = null;
      this.sceneTexture = null;
      this.overlayTexture = null;
      this.bloomFbos = [];
      this.bloomTextures = [];
      this._pipelineSize = '';
      this.sceneFormat = null;
    }

    _createTargetTexture(w, h, preferFloat) {
      const gl = this.gl;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      const useFloat = Boolean(preferFloat && this._hasFloatFbo && this.isWebGL2);
      const internal = useFloat ? gl.RGBA16F : gl.RGBA;
      const type = useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
      return { texture, format: useFloat ? 'rgba16f' : 'rgba8' };
    }

    _ensurePipelineTargets() {
      const gl = this.gl;
      if (!gl) return false;
      const key = `${this.width}x${this.height}`;
      if (this._pipelineSize === key && this.sceneFbo && this.overlayTexture) return true;

      this._disposePipelineTargets();

      const W = this.width;
      const H = this.height;

      const scene = this._createTargetTexture(W, H, true);
      this.sceneTexture = scene.texture;
      this.sceneFormat = scene.format;
      this.sceneFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneTexture, 0);

      // a driver can advertise EXT_color_buffer_float and still refuse the attachment, so the
      // status is the real answer and the fallback is a plain rgba8 target
      const status = typeof gl.checkFramebufferStatus === 'function'
        ? gl.checkFramebufferStatus(gl.FRAMEBUFFER)
        : gl.FRAMEBUFFER_COMPLETE;
      if (status !== gl.FRAMEBUFFER_COMPLETE && this.sceneFormat === 'rgba16f') {
        gl.deleteFramebuffer(this.sceneFbo);
        gl.deleteTexture(this.sceneTexture);
        const fallback = this._createTargetTexture(W, H, false);
        this.sceneTexture = fallback.texture;
        this.sceneFormat = fallback.format;
        this.sceneFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneTexture, 0);
        this._recordRenderLog('warn', 'webgl', 'float render target refused, using rgba8');
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      this.overlayTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.overlayTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

      this._pipelineSize = key;
      return true;
    }

    _bloomDims(level) {
      const div = 2 ** (level + 1);
      return {
        w: Math.max(1, Math.floor(this.width / div)),
        h: Math.max(1, Math.floor(this.height / div))
      };
    }

    _ensureBloomTargets() {
      const gl = this.gl;
      if (!gl) return false;
      if (this.bloomFbos.length === BLOOM_LEVELS && this.bloomTextures.length === BLOOM_LEVELS) return true;
      for (const fbo of this.bloomFbos) if (fbo) gl.deleteFramebuffer(fbo);
      for (const tex of this.bloomTextures) if (tex) gl.deleteTexture(tex);
      this.bloomFbos = [];
      this.bloomTextures = [];
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        const { w, h } = this._bloomDims(i);
        const target = this._createTargetTexture(w, h, true);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
        this.bloomTextures.push(target.texture);
        this.bloomFbos.push(fbo);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return true;
    }

    _ensureBloomPrograms() {
      if (this.bloomPrograms) return true;
      const prefilter = this._compileProgram(BLOOM_PREFILTER_FRAG, 'bloom');
      const tent = this._compileProgram(BLOOM_TENT_FRAG, 'bloom');
      if (!prefilter || !tent) {
        if (prefilter) this.gl.deleteProgram(prefilter);
        if (tent) this.gl.deleteProgram(tent);
        return false;
      }
      this.bloomPrograms = { prefilter, tent };
      this._bloomUniformLocations = { prefilter: {}, tent: {} };
      this._bindQuadAttributes(prefilter);
      this._bindQuadAttributes(tent);
      return true;
    }

    _tentPass(prog, locCache, sourceTexture, targetFbo, srcW, srcH, dstW, dstH) {
      const gl = this.gl;
      const loc = (name) => this._loc(prog, locCache, name);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
      gl.viewport(0, 0, dstW, dstH);
      gl.useProgram(prog);
      this._setFlip(prog, -1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
      const uSrc = loc('u_src');
      if (uSrc) gl.uniform1i(uSrc, 0);
      const uTexel = loc('u_texel');
      if (uTexel) gl.uniform2f(uTexel, 1 / Math.max(1, srcW), 1 / Math.max(1, srcH));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    _renderBloom() {
      const gl = this.gl;
      if (!gl || !this._ensureBloomPrograms() || !this._ensureBloomTargets()) return false;

      const thresholdRaw = Number(this.preset?.controlsBox?.values?.u_bloom_threshold);
      const threshold = Number.isFinite(thresholdRaw) ? Math.max(0, Math.min(4, thresholdRaw)) : 0.75;

      // prefilter: scene + premultiplied overlay, highlights only
      const pre = this.bloomPrograms.prefilter;
      const preLoc = (name) => this._loc(pre, this._bloomUniformLocations.prefilter, name);
      const l0 = this._bloomDims(0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFbos[0]);
      gl.viewport(0, 0, l0.w, l0.h);
      gl.useProgram(pre);
      this._setFlip(pre, -1);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
      const preScene = preLoc('u_scene_tex');
      if (preScene) gl.uniform1i(preScene, 4);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, this._overlayBound ? this.overlayTexture : this.transparentTexture);
      const preOverlay = preLoc('u_overlay_tex');
      if (preOverlay) gl.uniform1i(preOverlay, 5);
      const preHas = preLoc('u_has_overlay');
      if (preHas) gl.uniform1f(preHas, this._overlayBound ? 1.0 : 0.0);
      const preThreshold = preLoc('u_bloom_threshold');
      if (preThreshold) gl.uniform1f(preThreshold, threshold);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      const tent = this.bloomPrograms.tent;
      const tentLocs = this._bloomUniformLocations.tent;
      for (let i = 0; i < BLOOM_LEVELS - 1; i++) {
        const src = this._bloomDims(i);
        const dst = this._bloomDims(i + 1);
        this._tentPass(tent, tentLocs, this.bloomTextures[i], this.bloomFbos[i + 1], src.w, src.h, dst.w, dst.h);
      }

      // additive upsample folds the smaller levels back into level 0
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
        const src = this._bloomDims(i);
        const dst = this._bloomDims(i - 1);
        this._tentPass(tent, tentLocs, this.bloomTextures[i], this.bloomFbos[i - 1], src.w, src.h, dst.w, dst.h);
      }
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return true;
    }

    /**
     * Layer 3: composite scene + overlay (+ bloom) through the preset's postShader. Runs after
     * drawScript, because the overlay has to exist before it can be sampled.
     */
    _renderPostComposite() {
      const gl = this.gl;
      if (!gl || !this.postProgram) return false;
      if (!this._ensurePipelineTargets()) return false;

      const loc = (name) => this._loc(this.postProgram, this.postUniformLocations, name);
      gl.useProgram(this.postProgram);

      const hasOverlay = Boolean(this.preset?.frontUiBox?.drawScript && this.preset.frontUiBox.drawScript.trim());
      this._overlayBound = hasOverlay;
      // a shader that never reads the overlay would delete every lyric pixel, so the engine
      // composites it afterwards instead. getUniformLocation also covers "declared but optimised out".
      this._postSamplesOverlay = Boolean(loc('u_overlay_tex'));

      gl.activeTexture(gl.TEXTURE5);
      if (hasOverlay) {
        gl.bindTexture(gl.TEXTURE_2D, this.overlayTexture);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        try {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.overlayCanvas);
        } catch (err) {
          this._recordRenderLog('warn', 'webgl', `overlay upload failed: ${err?.message || err}`);
        } finally {
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        }
      } else {
        gl.bindTexture(gl.TEXTURE_2D, this.transparentTexture);
      }
      const uOverlay = loc('u_overlay_tex');
      if (uOverlay) gl.uniform1i(uOverlay, 5);
      const uHasOverlay = loc('u_has_overlay');
      if (uHasOverlay) gl.uniform1f(uHasOverlay, hasOverlay ? 1.0 : 0.0);

      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
      const uScene = loc('u_scene_tex');
      if (uScene) gl.uniform1i(uScene, 4);

      let bloomOk = false;
      const uBloom = loc('u_bloom_tex');
      if (uBloom) {
        bloomOk = this._renderBloom();
        // the bloom passes bind their own programs, so the post program has to be current again
        // before the remaining uniforms and the composite draw
        gl.useProgram(this.postProgram);
        if (bloomOk && this.bloomTextures[0]) {
          gl.activeTexture(gl.TEXTURE6);
          gl.bindTexture(gl.TEXTURE_2D, this.bloomTextures[0]);
          gl.uniform1i(uBloom, 6);
        }
      }

      this._bindFrameValues(loc);
      this._bindControlUniforms(loc, { markDead: false });

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.width, this.height);
      this._setFlip(this.postProgram, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this._pipelinePasses = 1 + (bloomOk ? (BLOOM_LEVELS - 1) * 2 + 1 : 0);
      return true;
    }

    compileShaderBox(fragSource, postSource = '') {
      const gl = this.gl;
      if (!gl) {
        this._recordRenderLog('error', 'webgl', 'WebGL context unavailable');
        return false;
      }

      const hasFrag = typeof fragSource === 'string' && fragSource.trim();
      const prog = this._compileProgram(hasFrag ? fragSource : FALLBACK_FRAG_SHADER, 'shader');
      if (!prog) {
        if (this.glProgram) gl.deleteProgram(this.glProgram);
        this.glProgram = null;
        this.uniformLocations = {};
        return false;
      }

      if (this.glProgram) {
        gl.deleteProgram(this.glProgram);
      }

      this.glProgram = prog;
      this.uniformLocations = {};
      this._bindQuadAttributes(prog);

      // layer 3 is optional: an absent or whitespace-only source means the fast path, so a stale
      // program from the previous preset must never survive
      if (this.postProgram) {
        gl.deleteProgram(this.postProgram);
        this.postProgram = null;
      }
      this.postUniformLocations = {};
      this._postUniformPresence = {};
      const post = typeof postSource === 'string' ? postSource.trim() : '';
      if (post) {
        const postProg = this._compileProgram(postSource, 'postShader');
        if (postProg) {
          this.postProgram = postProg;
          this._bindQuadAttributes(postProg);
        }
      }

      return true;
    }

    _syncCustomFontsFromPreset(preset) {
      const fonts = Array.isArray(preset?.assets?.customFonts) ? preset.assets.customFonts : [];
      if (fonts.length === 0 || typeof FontFace === 'undefined' || !document.fonts) return;
      if (!this._loadedFontKeys) this._loadedFontKeys = new Set();

      for (const entry of fonts) {
        const family = String(entry?.family || '').trim();
        const dataUrl = String(entry?.dataUrl || '').trim();
        if (!family || !dataUrl) continue;
        const key = `${family}::${dataUrl.length}::${dataUrl.slice(0, 64)}`;
        if (this._loadedFontKeys.has(key)) continue;
        this._loadedFontKeys.add(key);

        try {
          const face = new FontFace(family, `url(${dataUrl})`);
          face.load().then((loaded) => {
            document.fonts.add(loaded);
            if (typeof this.onAssetLoaded === 'function') {
              this.onAssetLoaded(`font:${family}`);
            }
          }).catch((err) => {
            this._loadedFontKeys.delete(key);
            this._recordRenderLog('warn', 'fonts', `failed to load custom font "${family}": ${err?.message || 'decode error'}`);
          });
        } catch (err) {
          this._loadedFontKeys.delete(key);
          this._recordRenderLog('warn', 'fonts', `invalid custom font "${family}": ${err?.message || 'error'}`);
        }
      }
    }

    loadPreset(preset) {
      if (!preset || !preset.frontUiBox) {
        console.error('Invalid ReelPreset passed to ReelEngine');
        return;
      }

      this.lastRuntimeErrors = [];
      this.renderLogs = [];
      this.deadUniforms = [];
      this._loggedKeys = new Set();
      this._userLogCount = 0;
      this._detectedCustomClipTransition = false;
      this._dispatchedCustomClipTransition = false;
      this._disposeClipTransitionStates();
      this._checkedGlError = false;
      this._videoTextureValid = false;
      this._lastVideoUploadMs = undefined;
      this.preset = preset;
      const nextPresetId = preset.id || preset.meta?.name || null;
      if (this._loadedPresetId && this._loadedPresetId !== nextPresetId) {
        for (const entry of this.mediaSlots.values()) {
          this._disposeMediaSlotEntry(entry);
        }
        this.mediaSlots.clear();
        this._pendingSlotRefs.clear();
        if (this._mediaPoolCache) {
          for (const entry of this._mediaPoolCache.values()) {
            this._disposeMediaPoolEntry(entry);
          }
          this._mediaPoolCache.clear();
        }
        if (this.mediaPools) this.mediaPools.clear();
        if (this._pendingPoolRefs) this._pendingPoolRefs.clear();
      }
      this._loadedPresetId = nextPresetId;
      if (preset.assets?.customImage) {
        this.setCustomImage(preset.assets.customImage);
      } else {
        this.setCustomImage(null);
      }
      this._syncMediaSlotsFromPreset(preset);
      this._syncCustomFontsFromPreset(preset);
      if (preset.meta?.aspectRatio) {
        this.setAspectRatio(preset.meta.aspectRatio);
      }

      // always recompile both passes: reusing the previous program leaks a layer-3 grade (or a
      // layer-1 shader) from whichever preset was open before this one
      this.compileShaderBox(
        preset.shaderBox?.fragmentShader || '',
        preset.shaderBox?.postShader || ''
      );

      try {
        this.compiledInitScript = new Function(
          'project',
          'state',
          'controls',
          'console',
          preset.frontUiBox.initScript || ''
        );
      } catch (err) {
        console.error('Failed to compile frontUiBox.initScript:', err);
        this._recordRuntimeError('initScript syntax', err);
        this.compiledInitScript = () => { };
      }

      try {
        this.compiledDrawScript = new Function(
          'ctx',
          'width',
          'height',
          'frame',
          'state',
          'console',
          preset.frontUiBox.drawScript || ''
        );
      } catch (err) {
        console.error('Failed to compile frontUiBox.drawScript:', err);
        this._recordRuntimeError('drawScript syntax', err);
        this.compiledDrawScript = () => { };
      }

      this.reinitPresetState();
    }

    attachDecodedAudioBuffer(audioBuffer, cacheKey = null) {
      if (!audioBuffer || typeof window === 'undefined' || !window.audioSignals?.attachBuffer) {
        return null;
      }
      const key = cacheKey || this.project?.audioUrl || null;
      const data = window.audioSignals.attachBuffer(audioBuffer, key);
      if (data) {
        this.audioSignalData = data;
        this._audioSignalUrl = key;
        if (this.loopCache) this.loopCache.invalidate();
      }
      return data;
    }

    setProject(project) {
      if (project && (!project.chordTimelineMarkers || project.chordTimelineMarkers.length === 0)) {
        if (typeof window !== 'undefined' && window.clientAnalyzer && typeof window.clientAnalyzer.computeChordTimelineMarkers === 'function') {
          project.chordTimelineMarkers = window.clientAnalyzer.computeChordTimelineMarkers(project);
        }
      }
      this.project = project;

      const audioUrl = project?.audioUrl || null;
      this._audioSignalUrl = audioUrl;
      if (project?._signalData) {
        this.audioSignalData = project._signalData;
        if (audioUrl && window.audioSignals?.registerSignalData) {
          window.audioSignals.registerSignalData(audioUrl, project._signalData);
        }
      } else if (audioUrl && typeof window !== 'undefined' && window.audioSignals) {
        const cached = window.audioSignals.getCached(audioUrl);
        if (cached) {
          this.audioSignalData = cached;
        } else {
          this.audioSignalData = null;
          window.audioSignals.ensureLoaded(audioUrl, (signalData, loadedUrl) => {
            if (this._audioSignalUrl !== loadedUrl || !signalData) return;
            this.audioSignalData = signalData;
            if (this.loopCache) this.loopCache.invalidate();
            if (typeof this.onAssetLoaded === 'function') {
              this.onAssetLoaded();
            }
          });
        }
      } else {
        this.audioSignalData = null;
      }

      this.selectedTrackIds.clear();
      if (project?.tracks) {
        project.tracks.forEach((tr) => {
          if (tr.defaultSelected) this.selectedTrackIds.add(tr.id);
        });
      }
      this.reinitPresetState();
    }

    setActiveVideos(videoElements) {
      this.activeVideos = Array.isArray(videoElements) ? videoElements : [];
      this._cachedProjectData = this._buildProjectData();
      if (this.loopCache) this.loopCache.invalidate();
    }

    invalidateLoopCache() {
      if (this.loopCache) this.loopCache.invalidate();
    }

    rebuildNoteNodes() {
      this.reinitPresetState();
    }

    toggleTrack(trackId, enabled) {
      if (enabled) this.selectedTrackIds.add(trackId);
      else this.selectedTrackIds.delete(trackId);
      this.reinitPresetState();
    }

    reinitPresetState() {
      const projectData = this._buildProjectData();
      this._cachedProjectData = projectData;
      this._userLogCount = 0;
      this.state = {
        project: projectData,
        log: (...args) => this._recordUserLog('initScript', null, args)
      };
      if (typeof this.compiledInitScript === 'function') {
        try {
          const controls = this.preset?.controlsBox?.values || {};
          this.compiledInitScript(projectData, this.state, controls, this._createScriptConsole('initScript'));
          for (const [k, v] of Object.entries(this.state)) {
            if (k === 'project' || k === 'log') continue;
            if (typeof v === 'number' && !Number.isFinite(v)) {
              this._recordRenderLog('warn', 'initScript', `state.${k} is ${v}`);
            }
          }
        } catch (err) {
          console.error('Error executing frontUiBox.initScript:', err);
          this._recordRuntimeError('initScript runtime', err);
        }
      }
      if (this.loopCache) this.loopCache.invalidate();
    }

    _buildProjectData() {
      const proj = this.project || {};
      const tracks = [];

      if (proj.tracks && Array.isArray(proj.tracks)) {
        proj.tracks.forEach((tr, trIdx) => {
          const isSelected = this.selectedTrackIds.has(tr.id);
          const spanInfo = window.loopUtils?.getTrackSpanInfo ? window.loopUtils.getTrackSpanInfo(tr, proj) : { canLoop: false };
          const loopActive = window.loopUtils?.isTrackLoopEnabled ? window.loopUtils.isTrackLoopEnabled(tr, proj) : false;
          tracks.push({
            index: trIdx,
            id: tr.id,
            name: tr.name,
            noteCount: tr.noteCount || 0,
            selected: isSelected,
            canLoop: spanInfo.canLoop,
            loopMidi: loopActive
          });
        });
      }

      let allNotes = [];
      if (proj.tracks && Array.isArray(proj.tracks)) {
        if (window.loopUtils && typeof window.loopUtils.expandTrackNotes === 'function') {
          allNotes = window.loopUtils.expandTrackNotes(
            proj.tracks,
            this.selectedTrackIds,
            proj,
            (n, tr, trIdx, shiftedTime, _shiftedBeat, mirrored) => ({
              pitch: n.midi,
              midi: n.midi,
              velocity: n.velocity || 0.8,
              startTime: shiftedTime,
              time: shiftedTime,
              duration: n.duration || 0.5,
              trackIndex: trIdx,
              trackName: tr.name,
              mirrored
            })
          );
        } else {
          proj.tracks.forEach((tr, trIdx) => {
            if (!this.selectedTrackIds.has(tr.id) || !tr.notes) return;
            for (const n of tr.notes) {
              allNotes.push({
                pitch: n.midi,
                midi: n.midi,
                velocity: n.velocity || 0.8,
                startTime: n.time,
                time: n.time,
                duration: n.duration || 0.5,
                trackIndex: trIdx,
                trackName: tr.name,
                mirrored: false
              });
            }
          });
          allNotes.sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch);
        }
      }

      const duration = proj.duration || 30.0;
      const dropTime = (typeof proj.dropTime === 'number' && !isNaN(proj.dropTime))
        ? proj.dropTime
        : (duration * 0.5);
      const bpm = proj.bpm || 120;

      return {
        brand: proj.brand || '',
        sampleNumber: proj.sampleNumber || '',
        title: proj.title || 'untitled',
        key: proj.key || '',
        duration,
        sampleRate: proj.sampleRate || 44100,
        bpm,
        dropTime,
        dropBar: proj.dropBar || 1,
        pcmPeaks: proj.peaks ? new Float32Array(proj.peaks) : new Float32Array(240),
        chordCutTimes: proj.chordCutTimes || [dropTime],
        impactTimes: proj.impactTimes || [dropTime],
        aspectRatio: this.aspectRatio,
        midi: {
          hasMidi: allNotes.length > 0,
          bpm,
          tracks,
          allNotes
        },
        clips: {
          count: this.activeVideos.length,
          items: this.activeVideos.map((v, i) => ({
            id: v.dataset?.clipId || `clip_${i}`,
            title: v.dataset?.clipTitle || `Clip ${i + 1}`,
            duration: v.duration || 5.0
          }))
        },
        pools: (() => {
          const out = {};
          if (this.mediaPools) {
            for (const [poolId, list] of this.mediaPools.entries()) {
              const active = Array.isArray(list) ? list.filter((e) => e && e.enabled !== false) : [];
              out[poolId] = {
                count: active.length,
                items: active.map((e) => ({
                  id: e.id,
                  name: e.name,
                  kind: e.kind,
                  width: e.width || 128,
                  height: e.height || 128
                }))
              };
            }
          }
          return out;
        })()
      };
    }

    _getAudioMetricsAt(time) {
      const proj = this.project || {};
      const duration = proj.duration || 30.0;
      const peaks = proj.peaks;

      let rms = 0.5;
      if (peaks && peaks.length > 0) {
        const norm = Math.max(0, Math.min(1, time / duration));
        const idx = Math.min(peaks.length - 1, Math.floor(norm * peaks.length));
        rms = peaks[idx] || 0.5;
      }

      const dropTime = (typeof proj.dropTime === 'number' && !isNaN(proj.dropTime))
        ? proj.dropTime
        : (duration * 0.5);
      const isDrop = time >= dropTime;

      // synthesize smoothed audio frequency bands aligned to detected beat/downbeat grid
      const bpm = proj.bpm || 120;
      const beatOffset = Number.isFinite(proj.beatOffset) ? proj.beatOffset : 0;
      const downbeatOffset = Number.isFinite(proj.downbeatOffset) ? proj.downbeatOffset : beatOffset;
      const rawBeat = (time - beatOffset) * (bpm / 60);
      const beatPhase = ((rawBeat % 1) + 1) % 1;
      const beatPulse = Math.pow(Math.max(0, 1 - beatPhase * 2.2), 2.4);
      const rawBar = ((time - downbeatOffset) * (bpm / 60)) / 4;
      const barPhase = ((rawBar % 1) + 1) % 1;
      const beatImpulse = Math.pow(Math.max(0, 1 - beatPhase * 1.8), 2.5);

      const bass = Math.min(1.0, rms * (isDrop ? 1.25 : 0.65) + beatImpulse * 0.35);
      const mid = Math.min(1.0, rms * 0.95 + 0.15);
      const high = Math.min(1.0, rms * (isDrop ? 0.9 : 0.45) + (Math.sin(time * 12.0) * 0.1 + 0.1));
      const fallback = { rms, bass, mid, high, beatImpulse, beatPhase, beatPulse, barPhase };

      if (typeof window !== 'undefined' && window.audioSignals?.fillAudioBuffers) {
        const filled = window.audioSignals.fillAudioBuffers(
          this.audioSignalData,
          fallback,
          time,
          duration,
          this.fftArray,
          this.waveformArray
        );
        filled.beatPhase = beatPhase;
        filled.beatPulse = beatPulse;
        filled.barPhase = barPhase;
        return filled;
      }

      return fallback;
    }

    _getActiveAndTriggeredNotes(time) {
      const projData = this._cachedProjectData || this._buildProjectData();
      const all = projData.midi.allNotes;
      const active = [];
      const triggered = [];

      const lookbehind = 0.04;
      let prevTime = this.lastTriggeredTime;
      if (Math.abs(time - this.lastTriggeredTime) < 1e-6) {
        prevTime = this._lastTriggerWindowStart;
      } else if (this.lastTriggeredTime >= 0 && (time < this.lastTriggeredTime || time - this.lastTriggeredTime > 0.35)) {
        prevTime = time - lookbehind;
      }
      for (const n of all) {
        if (time >= n.startTime && time <= n.startTime + n.duration) {
          active.push(n);
        }
        if (n.startTime <= time && n.startTime > time - lookbehind && n.startTime > prevTime) {
          triggered.push(n);
        }
      }

      return { all, active, triggered };
    }

    _detectChordAt(time) {
      const markers = this.project?.chordTimelineMarkers || [];
      if (markers.length > 0) {
        let best = markers[0];
        for (const m of markers) {
          if (time >= m.time) best = m;
          else break;
        }
        const root = best.root || best.name.match(/^[A-G][#b]?/i)?.[0] || best.name.charAt(0);
        return { name: best.name, time: best.time, root };
      }

      const { active } = this._getActiveAndTriggeredNotes(time);
      if (active.length > 0) {
        const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const CHORD_TYPES = [
          { name: 'maj7#11', intervals: [0, 4, 7, 11, 6], weight: 1.38 },
          { name: 'maj9', intervals: [0, 4, 7, 11, 2], weight: 1.36 },
          { name: 'm9', intervals: [0, 3, 7, 10, 2], weight: 1.36 },
          { name: '9', intervals: [0, 4, 7, 10, 2], weight: 1.30 },
          { name: '7sus4', intervals: [0, 5, 7, 10], weight: 1.28 },
          { name: 'maj7', intervals: [0, 4, 7, 11], weight: 1.30 },
          { name: 'm7', intervals: [0, 3, 7, 10], weight: 1.30 },
          { name: 'm7b5', intervals: [0, 3, 6, 10], weight: 1.24 },
          { name: '7', intervals: [0, 4, 7, 10], weight: 1.20 },
          { name: 'add9', intervals: [0, 4, 7, 2], weight: 1.25 },
          { name: 'madd9', intervals: [0, 3, 7, 2], weight: 1.24 },
          { name: 'maj', intervals: [0, 4, 7], weight: 1.15 },
          { name: 'm', intervals: [0, 3, 7], weight: 1.15 },
          { name: 'sus4', intervals: [0, 5, 7], weight: 1.05 },
          { name: 'sus2', intervals: [0, 2, 7], weight: 1.05 },
          { name: 'dim', intervals: [0, 3, 6], weight: 0.90 },
          { name: '5', intervals: [0, 7], weight: 0.85 }
        ];
        const pitches = Array.from(new Set(active.map((n) => n.pitch % 12))).sort((a, b) => a - b);
        const bassRoot = active.slice().sort((a, b) => a.pitch - b.pitch)[0].pitch % 12;
        const pitchSet = new Set(pitches);

        const scoreRoot = (candRoot, isBass) => {
          let best = { name: null, quality: 'maj', score: -999 };
          for (const type of CHORD_TYPES) {
            let matched = 0;
            let missed = 0;
            for (const iv of type.intervals) {
              if (pitchSet.has((candRoot + iv) % 12)) matched++;
              else missed++;
            }
            if (matched < (isBass ? 2 : Math.min(3, type.intervals.length))) continue;
            const extraPenalty = Math.max(0, pitchSet.size - matched) * 0.25;
            const score = (matched * 2.4 - missed * 0.85 - extraPenalty) * type.weight - (isBass ? 0 : 0.75);
            if (score > best.score) {
              best = { name: NOTE_NAMES[candRoot] + type.name, quality: type.name, score };
            }
          }
          return best;
        };

        const bassFit = scoreRoot(bassRoot, true);
        let bestName = bassFit.name || (NOTE_NAMES[bassRoot] + 'maj');
        let bestQuality = bassFit.quality;
        let bestRoot = NOTE_NAMES[bassRoot];
        let bestScore = bassFit.score;

        for (const cand of pitchSet) {
          if (cand === bassRoot) continue;
          const alt = scoreRoot(cand, false);
          if (alt.name && alt.score > bestScore && (bestScore < 2.2 || alt.score > bestScore + 0.55)) {
            bestScore = alt.score;
            bestName = `${alt.name}/${NOTE_NAMES[bassRoot]}`;
            bestQuality = alt.quality;
            bestRoot = NOTE_NAMES[cand];
          }
        }
        return { name: bestName, root: bestRoot, quality: bestQuality, time };
      }

      const key = (this.project?.key || 'Bmaj').toUpperCase();
      return { name: key, root: key.replace(/[^A-G#B]/g, ''), quality: '', time: 0 };
    }

    _updateSmoothedAudio(time, audioMetrics, noteTriggerImpulse) {
      const expFollow = (cur, target, dt, attackSec, releaseSec) => {
        if (cur === undefined || !Number.isFinite(cur)) return target;
        const tau = target > cur ? attackSec : releaseSec;
        const alpha = 1 - Math.exp(-dt / Math.max(0.005, tau));
        return cur + (target - cur) * alpha;
      };

      const rawStems = audioMetrics?.stems || {};
      const stKick = rawStems.kick ?? 0;
      const stSnare = rawStems.snare ?? 0;
      const stTop = rawStems.top ?? 0;
      const stBass = rawStems.bass ?? 0;
      const stOther = rawStems.other ?? 0;
      const stDrums = rawStems.drums ?? Math.min(1, Math.max(stKick, stSnare * 0.85, stTop * 0.65));

      const dtRaw = time - this._lastSmoothTime;
      if (this._lastSmoothTime >= 0 && Math.abs(dtRaw) < 1e-6) {
        return;
      }

      const seekJumped = this._lastSmoothTime < 0 || dtRaw < 0 || dtRaw > 0.12;
      if (seekJumped) {
        const steps = 6;
        const winStart = Math.max(0, time - 0.20);
        const span = time - winStart;
        if (span <= 1e-4) {
          this.smoothedBass = audioMetrics.bass;
          this.smoothedMid = audioMetrics.mid;
          this.smoothedHigh = audioMetrics.high;
          this.smoothedRms = audioMetrics.rms;
          this.smoothedNoteHit = noteTriggerImpulse;
          this.smoothedKick = stKick;
          this.smoothedSnare = stSnare;
          this.smoothedTop = stTop;
          this.smoothedStemBass = stBass;
          this.smoothedStemOther = stOther;
          this.smoothedDrums = stDrums;
        } else {
          const stepDt = span / (steps - 1);
          for (let s = 0; s < steps; s++) {
            const sampleT = winStart + s * stepDt;
            const m = (s === steps - 1) ? audioMetrics : this._getAudioMetricsAt(sampleT);
            const ms = m?.stems || {};
            const mk = ms.kick ?? 0;
            const msn = ms.snare ?? 0;
            const mtp = ms.top ?? 0;
            const mbs = ms.bass ?? 0;
            const mot = ms.other ?? 0;
            const mdr = ms.drums ?? Math.min(1, Math.max(mk, msn * 0.85, mtp * 0.65));
            const mHit = (s === steps - 1) ? noteTriggerImpulse : Math.max(0, (m.beatImpulse || 0) * 0.8);
            if (s === 0) {
              this.smoothedBass = m.bass;
              this.smoothedMid = m.mid;
              this.smoothedHigh = m.high;
              this.smoothedRms = m.rms;
              this.smoothedNoteHit = mHit;
              this.smoothedKick = mk;
              this.smoothedSnare = msn;
              this.smoothedTop = mtp;
              this.smoothedStemBass = mbs;
              this.smoothedStemOther = mot;
              this.smoothedDrums = mdr;
            } else {
              this.smoothedBass = expFollow(this.smoothedBass, m.bass, stepDt, 0.065, 0.26);
              this.smoothedMid = expFollow(this.smoothedMid, m.mid, stepDt, 0.08, 0.28);
              this.smoothedHigh = expFollow(this.smoothedHigh, m.high, stepDt, 0.055, 0.22);
              this.smoothedRms = expFollow(this.smoothedRms, m.rms, stepDt, 0.09, 0.34);
              this.smoothedNoteHit = expFollow(this.smoothedNoteHit, mHit, stepDt, 0.025, 0.16);
              this.smoothedKick = expFollow(this.smoothedKick, mk, stepDt, 0.015, 0.18);
              this.smoothedSnare = expFollow(this.smoothedSnare, msn, stepDt, 0.015, 0.16);
              this.smoothedTop = expFollow(this.smoothedTop, mtp, stepDt, 0.015, 0.14);
              this.smoothedStemBass = expFollow(this.smoothedStemBass, mbs, stepDt, 0.075, 0.28);
              this.smoothedStemOther = expFollow(this.smoothedStemOther, mot, stepDt, 0.085, 0.28);
              this.smoothedDrums = expFollow(this.smoothedDrums, mdr, stepDt, 0.015, 0.18);
            }
          }
          // restore spectrum/wave typed arrays to the target frame timestamp
          this._getAudioMetricsAt(time);
        }
        this._lastSmoothTime = time;
        return;
      }

      const dtSmooth = Math.max(0.001, Math.min(0.08, dtRaw));
      this._lastSmoothTime = time;

      this.smoothedBass = expFollow(this.smoothedBass, audioMetrics.bass, dtSmooth, 0.065, 0.26);
      this.smoothedMid = expFollow(this.smoothedMid, audioMetrics.mid, dtSmooth, 0.08, 0.28);
      this.smoothedHigh = expFollow(this.smoothedHigh, audioMetrics.high, dtSmooth, 0.055, 0.22);
      this.smoothedRms = expFollow(this.smoothedRms, audioMetrics.rms, dtSmooth, 0.09, 0.34);
      this.smoothedNoteHit = expFollow(this.smoothedNoteHit, noteTriggerImpulse, dtSmooth, 0.025, 0.16);
      this.smoothedKick = expFollow(this.smoothedKick, stKick, dtSmooth, 0.015, 0.18);
      this.smoothedSnare = expFollow(this.smoothedSnare, stSnare, dtSmooth, 0.015, 0.16);
      this.smoothedTop = expFollow(this.smoothedTop, stTop, dtSmooth, 0.015, 0.14);
      this.smoothedStemBass = expFollow(this.smoothedStemBass, stBass, dtSmooth, 0.075, 0.28);
      this.smoothedStemOther = expFollow(this.smoothedStemOther, stOther, dtSmooth, 0.085, 0.28);
      this.smoothedDrums = expFollow(this.smoothedDrums, stDrums, dtSmooth, 0.015, 0.18);
    }

    _renderShaderBox(time, audioMetrics, noteTriggerImpulse, activePitch, activeVideo, loopInfo, sectionInfo, target = 'canvas') {
      const gl = this.gl;
      if (!gl || !this.glProgram) return;

      // render-to-texture flips the quad so every fbo holds top-down data; the canvas pass does not.
      // this one rule keeps the scene, the bloom chain and the composite on the same uv contract.
      const toTexture = target === 'fbo';
      if (toTexture) {
        this._ensurePipelineTargets();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.viewport(0, 0, this.width, this.height);
      gl.useProgram(this.glProgram);
      this._setFlip(this.glProgram, toTexture ? -1 : 1);

      const getLoc = (name) => this._loc(this.glProgram, this.uniformLocations, name);
      // every scalar is recorded as well as uploaded, because layer 3 rebinds the same values to a
      // different program and recomputing them there would drift the moment either side changes
      const values = (this._frameValues = {});
      const set1 = (name, v) => { values[name] = v; const l = getLoc(name); if (l) gl.uniform1f(l, v); };
      const set2 = (name, a, b) => { values[name] = [a, b]; const l = getLoc(name); if (l) gl.uniform2f(l, a, b); };

      set1('u_time', time);
      set2('u_resolution', this.width, this.height);

      set1('u_bass', this.smoothedBass);
      set1('u_mid', this.smoothedMid);
      set1('u_high', this.smoothedHigh);
      set1('u_rms', this.smoothedRms);
      set1('u_kick', this.smoothedKick ?? 0.0);
      set1('u_snare', this.smoothedSnare ?? 0.0);
      set1('u_top', this.smoothedTop ?? 0.0);
      set1('u_stem_bass', this.smoothedStemBass ?? 0.0);
      set1('u_stem_other', this.smoothedStemOther ?? 0.0);
      set1('u_drums', this.smoothedDrums ?? 0.0);
      set1('u_beat_pulse', audioMetrics.beatPulse ?? 0.0);

      set1('u_has_midi', this.selectedTrackIds.size > 0 ? 1.0 : 0.0);
      set1('u_bpm', this.project?.bpm || 120);
      set1('u_note_hit', this.smoothedNoteHit);
      set1('u_active_pitch', activePitch);

      // chord cut impulse (aesthetic spike on chord transition that decays over 0.22s)
      const chordCuts = this.project?.chordCutTimes || [];
      let chordHit = 0.0;
      for (const ct of chordCuts) {
        const dt = time - ct;
        if (dt >= 0 && dt < 0.22) {
          chordHit = Math.max(chordHit, Math.pow(1.0 - dt / 0.22, 2.0));
        }
      }
      set1('u_chord_hit', chordHit);
      set1('u_loop_phase', loopInfo?.phase ?? 0.0);
      set1('u_loop_fade', loopInfo?.loopFade ?? 1.0);

      const mk = typeof window !== 'undefined' ? window.motionKit : null;
      const dropTime = this.project?.dropTime !== undefined ? this.project.dropTime : ((this.project?.duration || 30.0) * 0.5);
      set1('u_pre_drop', mk ? mk.preDrop(time, dropTime).lift : 0.0);
      const presetStartAtDrop = Boolean(this.preset?.modules?.clips?.startAtDrop);
      set1('u_speed_ramp', mk ? mk.getSpeedRampInfo(time, this.project, { startAtDrop: presetStartAtDrop, ...(this.preset?.controlsBox?.values || {}) }).rampFactor : 0.0);

      set1('u_section_index', Number(sectionInfo?.index) || 0.0);
      set1('u_section_progress', Number(sectionInfo?.progress) || 0.0);
      set1('u_section_mix', sectionInfo?.mix !== undefined ? sectionInfo.mix : 1.0);

      const lyricsSource = this.lyricsData || this.project?.lyrics || null;
      const lyrFrameForShader = (typeof window !== 'undefined' && window.lyricsService && lyricsSource)
        ? window.lyricsService.getLyricsFrameAt(lyricsSource, time)
        : null;
      set1('u_lyric_hit', lyrFrameForShader?.wordHit || 0.0);

      // lyric line state, so shader-space motion can be choreographed to the actual lines instead
      // of a fixed period. -1 on u_lyric_line / u_lyric_next_in means "no line here / no next line",
      // and u_lyric_progress is 0 whenever u_lyric_active is 0, so sin(pi * progress) is a safe
      // resting state in gaps. only uniforms the shader actually declares land in the record.
      if (lyrFrameForShader) {
        const lineActive = Number(lyrFrameForShader.activeLineIndex) >= 0;
        const lyricUniforms = {
          u_lyric_active: lineActive ? 1.0 : 0.0,
          u_lyric_line: lineActive ? Number(lyrFrameForShader.activeLineIndex) : -1.0,
          u_lyric_progress: lineActive ? Math.min(1, Math.max(0, Number(lyrFrameForShader.progress) || 0)) : 0.0,
          u_lyric_age: lineActive ? Math.max(0, Number(lyrFrameForShader.lineAge) || 0) : 0.0,
          u_lyric_next_in: Number.isFinite(lyrFrameForShader.nextIn) ? Math.max(0, lyrFrameForShader.nextIn) : -1.0,
          u_lyric_word_progress: Math.min(1, Math.max(0, Number(lyrFrameForShader.wordProgress) || 0)),
          // monotonic: one unit per line walked, holds in gaps, never reverses. safe to add to a
          // travel/phase coordinate, which no envelope-derived value ever is
          u_lyric_travel: Math.max(0, Number(lyrFrameForShader.travel) || 0),
          // how much of a full accent this line can carry (0.15 short fragment .. 1 full phrase),
          // 1 off-line so amplitude * weight is safe in gaps
          u_lyric_weight: lineActive ? Math.min(1, Math.max(0, Number(lyrFrameForShader.lineWeight) || 1)) : 1.0,
          u_lyric_duration: lineActive ? Math.max(0, Number(lyrFrameForShader.lineDuration) || 0) : 0.0
        };
        const uploaded = {};
        for (const name of Object.keys(lyricUniforms)) {
          values[name] = lyricUniforms[name];
          const loc = getLoc(name);
          if (loc) {
            gl.uniform1f(loc, lyricUniforms[name]);
            uploaded[name] = lyricUniforms[name];
          }
        }
        this._lyricUniforms = uploaded;
      }

      const luShader = typeof window !== 'undefined' ? window.loopUtils : null;
      const cueCats = luShader?.resolveMarkerCategories ? luShader.resolveMarkerCategories(this.preset) : [];
      if (cueCats.length > 0 && luShader?.resolveCustomCuesByCategory && luShader?.getCueStateAtTime) {
        let needsCueLookup = false;
        for (let ci = 0; ci < 4; ci++) {
          if (getLoc(`u_cue_${ci}`) || getLoc(`u_cue_progress_${ci}`)) {
            needsCueLookup = true;
            break;
          }
        }
        if (needsCueLookup) {
          const { byCategory } = luShader.resolveCustomCuesByCategory(this.preset, this.project);
          const cueBpm = this.project?.bpm || 120;
          for (let ci = 0; ci < Math.min(4, cueCats.length); ci++) {
            const cat = cueCats[ci];
            const uCue = getLoc(`u_cue_${ci}`);
            const uCueProg = getLoc(`u_cue_progress_${ci}`);
            if (!uCue && !uCueProg) continue;
            const st = luShader.getCueStateAtTime(byCategory[cat.id] || [], time, {
              kind: cat.kind,
              defaultBeats: cat.defaultBeats,
              bpm: cueBpm
            });
            set1(`u_cue_${ci}`, st.impulse);
            set1(`u_cue_progress_${ci}`, st.progress);
          }
        }
      }

      const uHasVideo = getLoc('u_has_video');
      const uVideoTex = getLoc('u_video_tex');
      const vid = activeVideo || this.activeVideos[this.shaderClipIndex];
      const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      const videoUpload = resolveVideoUpload({
        ready: Boolean(vid && vid.readyState >= 2),
        hasActiveVideo: Boolean(vid),
        seeking: Boolean(vid && vid.seeking),
        textureValid: this._videoTextureValid === true,
        msSinceUpload: typeof this._lastVideoUploadMs === 'number' ? nowMs - this._lastVideoUploadMs : -1
      });

      if (videoUpload.upload) {
        let uploadSource = vid;
        if (mk?.prepareTransitionSource && !this.hasCustomClipTransition()) {
          const ctrlVals = this.preset?.controlsBox?.values || {};
          const transOpts = {
            time,
            project: this.project,
            startAtDrop: presetStartAtDrop,
            cutMode: ctrlVals.cutMode || this.preset?.modules?.clips?.defaultCutMode || 'chord',
            clipTransition: ctrlVals.clipTransition,
            clipTransitionDuration: ctrlVals.clipTransitionDuration,
            dropGlitch: ctrlVals.dropGlitch,
            autoFrame: ctrlVals.autoFrame !== false,
            focalPan: ctrlVals.autoFrame !== false,
            customTransition: false
          };
          const transInfo = mk.resolveClipTransitionInfo(time, this.project, transOpts);
          this._lastTransInfo = {
            type: transInfo.type,
            active: transInfo.active,
            p: Number((transInfo.progress || 0).toFixed(2)),
            cut: transInfo.cutIndex
          };
          if (transInfo.cutIndex > 0 && this.activeVideos.length > 1) {
            const pv = this.activeVideos[(transInfo.cutIndex - 1) % this.activeVideos.length];
            if (pv && pv.readyState >= 2) transOpts.prevSource = pv;
          }
          const vw = vid.videoWidth || vid.width || 1280;
          const vh = vid.videoHeight || vid.height || 720;
          uploadSource = mk.prepareTransitionSource(
            vid,
            vw,
            vh,
            transOpts,
            this._motionScratch,
            this._getClipTransitionState('shader')
          );
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, uploadSource);
        } catch (err) {
          this._recordRenderLog('warn', 'webgl', `video texture upload failed: ${err?.message || err}`, time);
        }
        if (uVideoTex) gl.uniform1i(uVideoTex, 0);
        this._videoTextureValid = true;
        this._lastVideoUploadMs = nowMs;
        this._lastVideoUploadKind = uploadSource === vid ? 'video' : 'scratch';
      } else if (!videoUpload.hasVideo) {
        // no active clip yet (pre-drop, empty playlist): nothing to hold, so the shader must not
        // sample a frame from the previous preset's clip
        if (!vid) this._videoTextureValid = false;
      }
      if (uHasVideo) gl.uniform1f(uHasVideo, videoUpload.hasVideo ? 1.0 : 0.0);

      if (VIDEO_DIAG) {
        const sec = Math.floor(nowMs / 1000);
        if (this._lastVideoDiagSec !== sec) {
          this._lastVideoDiagSec = sec;
          console.info('[video]', {
            upload: videoUpload.upload,
            hasVideo: videoUpload.hasVideo,
            ready: vid ? vid.readyState : null,
            seeking: vid ? vid.seeking : null,
            t: vid ? Number((vid.currentTime || 0).toFixed(2)) : null,
            valid: this._videoTextureValid,
            sinceMs: typeof this._lastVideoUploadMs === 'number' ? Math.round(nowMs - this._lastVideoUploadMs) : null,
            kind: this._lastVideoUploadKind || null,
            trans: this._lastTransInfo || null,
            post: Boolean(this.postProgram),
            overlayBound: Boolean(this._overlayBound),
            overlayInShader: Boolean(this._postSamplesOverlay),
            sceneFormat: this.sceneFormat || null
          });
        }
      }

      let shaderImageEl = (this.customImageReady && this.customImage) ? this.customImage : null;
      if (!shaderImageEl && this.mediaSlots && this.mediaSlots.size > 0) {
        for (const entry of this.mediaSlots.values()) {
          if (entry && entry.kind === 'image' && entry.ready && entry.el && entry.el.naturalWidth > 0) {
            shaderImageEl = entry.el;
            break;
          }
        }
      }

      const uHasImage = getLoc('u_has_image');
      const uImageTex = getLoc('u_image_tex');
      const uImageSize = getLoc('u_image_size');
      if (shaderImageEl && this.imageTexture) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
        if (this.customImageTextureDirty || this._uploadedShaderImageEl !== shaderImageEl) {
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, shaderImageEl);
          } catch (err) {
            this._recordRenderLog('warn', 'webgl', `image texture upload failed: ${err?.message || err}`, time);
          }
          this.customImageTextureDirty = false;
          this._uploadedShaderImageEl = shaderImageEl;
        }
        if (uImageTex) gl.uniform1i(uImageTex, 1);
        if (uHasImage) gl.uniform1f(uHasImage, 1.0);
        if (uImageSize) gl.uniform2f(uImageSize, shaderImageEl.naturalWidth || 1, shaderImageEl.naturalHeight || 1);
      } else {
        if (uHasImage) gl.uniform1f(uHasImage, 0.0);
      }

      const uFft = getLoc('u_fft');
      if (uFft && this.fftTexture) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.fftTexture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, this.fftArray);
        gl.uniform1i(uFft, 2);
      }

      const uWaveform = getLoc('u_waveform');
      if (uWaveform && this.waveformTexture) {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, this.waveformTexture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, this.waveformArray);
        gl.uniform1i(uWaveform, 3);
      }

      this._bindControlUniforms(getLoc, { markDead: true });

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!this._checkedGlError && typeof gl.getError === 'function') {
        this._checkedGlError = true;
        const glErr = gl.getError();
        if (glErr && glErr !== gl.NO_ERROR) {
          this._recordRenderLog('error', 'webgl', `gl.getError() code 0x${glErr.toString(16)}`);
        }
      }
    }

    getSpeedRampInfo(time) {
      const mk = typeof window !== 'undefined' ? window.motionKit : null;
      if (mk && typeof mk.getSpeedRampInfo === 'function') {
        const startAtDrop = Boolean(this.preset?.modules?.clips?.startAtDrop);
        return mk.getSpeedRampInfo(time, this.project, { startAtDrop, ...(this.preset?.controlsBox?.values || {}) });
      }
      return { clipTime: time, instSpeed: 1.0, rampFactor: 0, isRamping: false, phase: 'cruise', cutIndex: 0 };
    }

    renderFrame(time, activeVideo = null, opts = {}) {
      const frameStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      const ctx = this.ctx;
      const W = this.width;
      const H = this.height;
      const loopInfo = window.loopUtils
        ? window.loopUtils.getLoopTransitionInfo(time, this.project, this.params)
        : { inTransition: false, progress: 0, easeProgress: 0, loopFade: 1.0, clipFade: 1.0, phase: 0 };

      const audioMetrics = this._getAudioMetricsAt(time);
      const { all, active, triggered } = this._getActiveAndTriggeredNotes(time);

      const noteHit = triggered.length > 0 ? 1.0 : Math.max(0, audioMetrics.beatImpulse * 0.8);
      const activePitch = active.length > 0 ? (active[0].pitch - 36) / 60 : 0.5;

      const lu = typeof window !== 'undefined' ? window.loopUtils : null;
      const duration = this.project?.duration || 30.0;
      const sections = Array.isArray(this.project?.sections) && this.project.sections.length > 0
        ? this.project.sections
        : (lu ? lu.getDefaultSections(this.project) : []);
      const baseSection = lu
        ? lu.getSectionAtTime(sections, time, duration)
        : {
          id: 'main',
          type: 'main',
          label: 'main',
          bar: 1,
          time: 0,
          endBar: 1,
          endTime: duration,
          duration,
          color: '#83ca90',
          index: 0,
          count: 1,
          age: time,
          remaining: Math.max(0, duration - time),
          progress: Math.max(0, Math.min(1, time / Math.max(0.001, duration)))
        };
      const mixWindow = Math.min(0.6, Math.max(0.15, (baseSection.duration || 4) * 0.25));
      const mixLin = baseSection.index === 0 ? 1.0 : Math.max(0, Math.min(1, (baseSection.age || 0) / mixWindow));
      const currentSection = {
        ...baseSection,
        mix: Number((mixLin * mixLin * (3 - 2 * mixLin)).toFixed(4))
      };

      this._updateSmoothedAudio(time, audioMetrics, noteHit);
      // layer 3 present: layer 1 renders into the scene fbo and the composite happens after
      // drawScript, because the overlay has to exist before the post pass can sample it
      const usePost = Boolean(this.postProgram);
      this._renderShaderBox(time, audioMetrics, noteHit, activePitch, activeVideo, loopInfo, currentSection, usePost ? 'fbo' : 'canvas');

      if (!usePost) {
        if (this.glCanvas) {
          ctx.drawImage(this.glCanvas, 0, 0, W, H);
        } else {
          ctx.fillStyle = '#121829';
          ctx.fillRect(0, 0, W, H);
        }
      }

      const resolvedMarkers = lu
        ? lu.resolveTimelineMarkers(this.preset, this.project)
        : (Array.isArray(this.preset?.features?.timeline?.markers) ? this.preset.features.timeline.markers : []);
      const customCuesInfo = (lu && lu.resolveCustomCuesByCategory)
        ? lu.resolveCustomCuesByCategory(this.preset, this.project)
        : { categories: [], byCategory: {} };
      const customCategoryById = new Map(customCuesInfo.categories.map((c) => [c.id, c]));
      let currentMarker = null;
      let nextMarker = null;
      for (let i = 0; i < resolvedMarkers.length; i++) {
        const m = resolvedMarkers[i];
        if (m.time <= time + 1e-4) {
          currentMarker = { ...m, age: Number(Math.max(0, time - m.time).toFixed(4)) };
        } else if (!nextMarker) {
          nextMarker = { ...m, in: Number(Math.max(0, m.time - time).toFixed(4)) };
        }
      }

      const dropMarker = resolvedMarkers.find((m) => m.id === 'drop');
      const dropTime = dropMarker
        ? dropMarker.time
        : (this.project?.dropTime !== undefined ? this.project.dropTime : duration * 0.5);
      const projData = this._cachedProjectData || this._buildProjectData();
      const sig = typeof window !== 'undefined' ? window.audioSignals : null;
      const mk = typeof window !== 'undefined' ? window.motionKit : null;
      const fftBuf = this.fftArray;
      const waveBuf = this.waveformArray;
      const peakBuf = projData.pcmPeaks;
      const ctrlValues = this.preset?.controlsBox?.values || {};
      const motionScratch = this._motionScratch;

      const resolvedLyricsSource = this.lyricsData || this.project?.lyrics || null;
      const frameLyrics = (typeof window !== 'undefined' && window.lyricsService)
        ? window.lyricsService.getLyricsFrameAt(resolvedLyricsSource, time)
        : {
          hasLyrics: false,
          lines: [],
          activeLineIndex: -1,
          line: '',
          prevLine: '',
          nextLine: '',
          lineStart: 0,
          lineEnd: 0,
          progress: 0,
          word: '',
          activeWordIndex: -1,
          wordProgress: 0,
          wordHit: 0,
          words: []
        };

      const SLOT_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const activeNoteNames = active.map((n) => {
        const pc = SLOT_NOTE_NAMES[((n.pitch % 12) + 12) % 12];
        const oct = Math.floor(n.pitch / 12) - 1;
        return `${pc}${oct}`;
      });

      const slotsMap = {};
      const isSlotElReady = (entry) => {
        if (!entry || !entry.ready || !entry.el) return false;
        if (entry.kind === 'video') return entry.el.readyState >= 2;
        return entry.el.naturalWidth > 0 && entry.el.naturalHeight > 0;
      };
      // the missing-media tile is a drawn affordance, not the user's asset, so has() must not
      // report it as present even though it is a fully loaded element
      const isSlotReal = (entry) => isSlotElReady(entry) && !entry.placeholder;
      if (this.customImageReady && this.customImage) {
        slotsMap.customImage = this.customImage;
      }
      for (const [sId, entry] of this.mediaSlots.entries()) {
        if (isSlotElReady(entry)) slotsMap[sId] = entry.el;
      }

      const fallbackCustomImg = (this.customImageReady && this.customImage)
        ? this.customImage
        : (Array.from(this.mediaSlots.values()).find((e) => e.kind === 'image' && isSlotReal(e))?.el || null);

      const getSlotElement = (slotId) => {
        if (!slotId) return fallbackCustomImg;
        if (slotId === 'customImage' || slotId === 'coverImage') {
          return slotsMap[slotId] || fallbackCustomImg;
        }
        const entry = this.mediaSlots.get(slotId);
        return isSlotElReady(entry) ? entry.el : null;
      };

      const hasSlotElement = (slotId) => {
        if (!slotId) return Boolean(fallbackCustomImg);
        if (slotId === 'customImage' || slotId === 'coverImage') {
          return isSlotReal(this.mediaSlots.get(slotId)) || Boolean(fallbackCustomImg);
        }
        return isSlotReal(this.mediaSlots.get(slotId));
      };

      const rawStems = audioMetrics?.stems || {};
      const stKick = rawStems.kick ?? 0;
      const stSnare = rawStems.snare ?? 0;
      const stTop = rawStems.top ?? 0;
      const stStemBass = rawStems.bass ?? 0;
      const stStemOther = rawStems.other ?? 0;
      const stDrums = rawStems.drums ?? Math.min(1, Math.max(stKick, stSnare * 0.85, stTop * 0.65));

      const frameContext = {
      // deterministic frame index: derive from time so a scrub, a pause and an export of the same
      // timestamp always agree. presets must never accumulate counters across renders.
      frameIndex: Math.round(time * 60),
      fps: 60,
      audio: {
          time,
          duration,
          progress: Math.max(0, Math.min(1, time / duration)),
          bass: audioMetrics.bass,
          bassSmooth: this.smoothedBass !== undefined ? this.smoothedBass : audioMetrics.bass,
          mid: audioMetrics.mid,
          midSmooth: this.smoothedMid !== undefined ? this.smoothedMid : audioMetrics.mid,
          high: audioMetrics.high,
          highSmooth: this.smoothedHigh !== undefined ? this.smoothedHigh : audioMetrics.high,
          rms: audioMetrics.rms,
          rmsSmooth: this.smoothedRms !== undefined ? this.smoothedRms : audioMetrics.rms,
          beatPhase: audioMetrics.beatPhase ?? 0,
          beatPulse: audioMetrics.beatPulse ?? 0,
          barPhase: audioMetrics.barPhase ?? 0,
          stems: {
            kick: stKick,
            snare: stSnare,
            top: stTop,
            bass: stStemBass,
            other: stStemOther,
            drums: stDrums,
            kickSmooth: this.smoothedKick !== undefined ? this.smoothedKick : stKick,
            snareSmooth: this.smoothedSnare !== undefined ? this.smoothedSnare : stSnare,
            topSmooth: this.smoothedTop !== undefined ? this.smoothedTop : stTop,
            bassSmooth: this.smoothedStemBass !== undefined ? this.smoothedStemBass : stStemBass,
            otherSmooth: this.smoothedStemOther !== undefined ? this.smoothedStemOther : stStemOther,
            drumsSmooth: this.smoothedDrums !== undefined ? this.smoothedDrums : stDrums
          },
          fft: fftBuf,
          waveform: waveBuf,
          spectrum: (count = 32, opts = {}) => (sig ? sig.sampleSpectrum(fftBuf, count, opts) : []),
          wave: (count = 64, opts = {}) => (sig ? sig.sampleWave(waveBuf, count, opts) : []),
          stereo: (count = 64) => (sig && sig.sampleStereo
            ? sig.sampleStereo(this.audioSignalData, time, count)
            : { left: new Float32Array(count), right: new Float32Array(count), correlation: 0, width: 0 }),
          overview: (count = 64) => (sig ? sig.sampleOverview(peakBuf, count) : []),
          band: (lowHz = 20, highHz = 200) => (sig ? sig.sampleBand(fftBuf, lowHz, highHz) : audioMetrics.bass)
        },
        viz: {
          spline: (destCtx, points, opts = {}) => sig?.drawSpline(destCtx, points, opts),
          polar: (values, cx, cy, baseR, ampR, opts = {}) => (sig ? sig.buildPolarPoints(values, cx, cy, baseR, ampR, opts) : []),
          mirrorPath: (destCtx, values, rect, opts = {}) => sig?.drawMirrorRibbonPath(destCtx, values, rect, opts)
        },
        fx: {
          ease: (p, kind = 'smooth') => (mk ? mk.ease(p, kind) : Math.max(0, Math.min(1, p))),
          impulse: (age, dur = 0.38, power = 2.2) => (mk ? mk.impulse(age, dur, power) : 0),
          smooth: (key, target, sOpts = {}) => (mk?.smoothSignal ? mk.smoothSignal(this._fxSignalState, key, target, time, sOpts) : (Number(target) || 0)),
          spring: (key, target, sOpts = {}) => (mk?.springSignal ? mk.springSignal(this._fxSignalState, key, target, time, sOpts) : (Number(target) || 0)),
          gate: (val, threshold = 0.55, softness = 0.16) => (mk?.gateSignal ? mk.gateSignal(val, threshold, softness) : Math.max(0, Number(val) || 0)),
          transition: (startTime, dur = 0.6, kind = 'smoother') => (mk
            ? mk.transition(time, startTime, dur, kind)
            : { active: false, started: time >= startTime, finished: time >= startTime + dur, p: 1, eased: 1, inverse: 0 }),
          preDrop: (dur = 2.2) => (mk
            ? mk.preDrop(time, dropTime, dur)
            : { active: false, p: 0, lift: 0, tension: 0, dur }),
          camera: (camOpts = {}) => {
            const cam = mk
              ? mk.camera(camOpts.time ?? time, this.project, audioMetrics, loopInfo, camOpts)
              : { x: 0, y: 0, rot: 0, zoom: 1, shakeX: 0, shakeY: 0, isLifting: false, pLift: 0, liftEase: 0, apply() { } };
            // measured automatically so a motion pass can be checked without the preset opting in:
            // a camera that "feels static" is a number, not an opinion
            this._recordProbeTrace('camX', cam.x, time, { spatial: true });
            this._recordProbeTrace('camY', cam.y, time, { spatial: true });
            this._recordProbeTrace('camZoom', cam.zoom, time);
            this._recordProbeTrace('camRot', cam.rot, time);
            return cam;
          },
          speedRamp: (rampOpts = {}) => (mk
            ? mk.getSpeedRampInfo(rampOpts.time ?? time, this.project, { startAtDrop: Boolean(this.preset?.modules?.clips?.startAtDrop), ...ctrlValues, ...rampOpts })
            : { clipTime: time, instSpeed: 1, rampFactor: 0, isRamping: false, phase: 'cruise', cutIndex: 0, cutAge: 0, cutProgress: 0 }),
          shutterBlur: (destCtx, drawStepFn, blurOpts = {}) => mk?.shutterBlur(destCtx, drawStepFn, blurOpts),
          streak: (destCtx, x1, y1, x2, y2, streakOpts = {}) => mk?.streak(destCtx, x1, y1, x2, y2, streakOpts),
          whipLines: (destCtx, w, h, intensity, whipOpts = {}) => mk?.whipLines(destCtx, w, h, intensity, { time, ...whipOpts }),
          glitch: (destCtx, source, rect, intensity, glitchOpts = {}) => mk?.glitch(destCtx, source, rect, intensity, { time, ...glitchOpts }),
          hash: (n) => {
            if (mk?.hash) return mk.hash(n);
            const s = Math.sin(Number(n) * 127.1 + 311.7) * 43758.5453123;
            return s - Math.floor(s);
          }
        },
        loop: {
          enabled: this.params?.seamlessLoop !== false,
          style: loopInfo.loopStyle || 'datamosh',
          phase: loopInfo.phase,
          fade: loopInfo.loopFade,
          inTransition: loopInfo.inTransition,
          progress: loopInfo.progress,
          easeProgress: loopInfo.easeProgress
        },
        midi: {
          hasMidi: all.length > 0,
          bpm: this.project?.bpm || 120,
          tracks: projData.midi.tracks || [],
          allNotes: all,
          activeNotes: active,
          activeNoteNames,
          triggeredNotes: triggered
        },
        chord: this._detectChordAt(time),
        lyrics: frameLyrics,
        timeline: {
          dropTime,
          dropBar: this.project?.dropBar || 9,
          markers: resolvedMarkers,
          hasMarkers: resolvedMarkers.length > 0,
          currentMarker,
          nextMarker,
          markerTime: (id) => {
            const key = String(id || '').toLowerCase();
            const foundMarker = resolvedMarkers.find((m) => m.id === key || m.label === key);
            if (foundMarker) return foundMarker.time;
            const foundSection = sections.find((s) => s.id === key || s.type === key || s.label === key);
            return foundSection ? foundSection.time : null;
          },
          sections,
          currentSection,
          sectionAt: (tQuery) => (lu ? lu.getSectionAtTime(sections, tQuery, duration) : currentSection),
          categories: customCuesInfo.categories,
          cues: (catId) => {
            const key = String(catId || '').toLowerCase();
            return Array.isArray(customCuesInfo.byCategory[key]) ? [...customCuesInfo.byCategory[key]] : [];
          },
          activeCue: (catId, opts = {}) => {
            const key = String(catId || '').toLowerCase();
            const cat = customCategoryById.get(key);
            const list = customCuesInfo.byCategory[key] || [];
            if (lu?.getCueStateAtTime) {
              return lu.getCueStateAtTime(list, time, {
                kind: cat?.kind || 'point',
                defaultBeats: cat?.defaultBeats,
                bpm: this.project?.bpm || 120,
                ...opts
              });
            }
            return { active: false, index: -1, count: 0, startTime: 0, endTime: 0, duration: 0, age: 0, remaining: 0, progress: 0, impulse: 0, nextIn: null, prevAge: null };
          },
          cueHit: (catId, decaySec) => {
            const key = String(catId || '').toLowerCase();
            const cat = customCategoryById.get(key);
            const list = customCuesInfo.byCategory[key] || [];
            if (!lu?.getCueStateAtTime) return 0;
            return lu.getCueStateAtTime(list, time, {
              kind: cat?.kind || 'point',
              defaultBeats: cat?.defaultBeats,
              bpm: this.project?.bpm || 120,
              decaySec
            }).impulse;
          },
          chords: this.project?.chordTimelineMarkers || [],
          currentChord: this._detectChordAt(time)
        },
        clips: (() => {
          const resolveClipVideo = (clipIdx) => (
            clipIdx === undefined || clipIdx === null || clipIdx === 0
              ? (activeVideo || this.activeVideos[0])
              : (this.activeVideos[clipIdx] || activeVideo)
          );
          const presetStartAtDrop = Boolean(this.preset?.modules?.clips?.startAtDrop);
          const clipCutMode = ctrlValues.cutMode || this.preset?.modules?.clips?.defaultCutMode || 'chord';
          const clipCustom = this.hasCustomClipTransition();
          const clipTransOpts = {
            time,
            project: this.project,
            startAtDrop: presetStartAtDrop,
            cutMode: clipCutMode,
            clipTransition: ctrlValues.clipTransition,
            clipTransitionDuration: ctrlValues.clipTransitionDuration,
            dropGlitch: ctrlValues.dropGlitch,
            autoFrame: ctrlValues.autoFrame !== false,
            customTransition: clipCustom
          };
          const transitionInfo = mk?.resolveClipTransitionInfo
            ? mk.resolveClipTransitionInfo(time, this.project, clipTransOpts)
            : { type: 'none', duration: 0, rawDuration: 0.35, active: false, progress: 1, cutIndex: 0 };
          let drawClipCallIndex = 0;

          return {
            count: this.activeVideos.length,
            transition: transitionInfo,
            getFocalX: (clipIdx = 0, targetAspect = W / H) => {
              const v = resolveClipVideo(clipIdx);
              return mk ? mk.detectFocalX(v, motionScratch, targetAspect) : 0.5;
            },
            drawClip: (destCtx, clipIdx, x, y, w, h, opts = {}) => {
              const callKey = `drawClip_${drawClipCallIndex++}`;
              const v = resolveClipVideo(clipIdx);
              if (!v) {
                this._recordRenderLog('warn', 'clips', `drawClip(${clipIdx}) called with no active video clip selected`, time);
                return;
              }
              if (v.readyState < 2) {
                this._recordRenderLog('info', 'clips', `drawClip(${clipIdx}) skipped because video readyState=${v.readyState}`, time);
                return;
              }
              if (opts.transition === false && !this._detectedCustomClipTransition) {
                this._detectedCustomClipTransition = true;
                if (!this._dispatchedCustomClipTransition && typeof window !== 'undefined') {
                  this._dispatchedCustomClipTransition = true;
                  window.dispatchEvent(new CustomEvent('samplevis:clip-transition-mode', {
                    detail: { custom: true, presetId: this.preset?.id || null }
                  }));
                }
              }
              if (mk) {
                const useTransition = opts.transition !== false && !this.hasCustomClipTransition();
                if (useTransition && mk.drawMediaWithTransition) {
                  let prevSource = null;
                  if (transitionInfo.cutIndex > 0 && this.activeVideos.length > 1) {
                    const pv = this.activeVideos[(transitionInfo.cutIndex - 1) % this.activeVideos.length];
                    if (pv && pv.readyState >= 2) prevSource = pv;
                  }
                  mk.drawMediaWithTransition(
                    destCtx,
                    v,
                    x,
                    y,
                    w,
                    h,
                    {
                      ...clipTransOpts,
                      prevSource,
                      ...opts
                    },
                    motionScratch,
                    this._getClipTransitionState(callKey)
                  );
                  return;
                }
                mk.drawMediaSmart(destCtx, v, x, y, w, h, { time, autoFrame: ctrlValues.autoFrame !== false, ...opts }, motionScratch);
                return;
              }
              destCtx.save();
              if (opts.opacity !== undefined) destCtx.globalAlpha *= opts.opacity;
              destCtx.drawImage(v, x, y, w, h);
              destCtx.restore();
            },
            setShaderVideoClip: (clipIdx) => {
              this.shaderClipIndex = clipIdx;
            }
          };
        })(),
        controls: ctrlValues,
        project: projData,
        log: (...args) => this._recordUserLog('drawScript', time, args),
        probe: (label, value) => this._recordProbeTrace(label, value, time),
        assets: {
          coverImage: fallbackCustomImg,
          customImage: fallbackCustomImg,
          hasImage: Boolean(fallbackCustomImg),
          slots: slotsMap,
          has: (slotId) => hasSlotElement(slotId),
          get: (slotId) => getSlotElement(slotId),
          draw: (destCtx, slotId, x, y, w, h, opts = {}) => {
            const el = getSlotElement(slotId);
            if (!el) {
              this._recordRenderLog('warn', 'assets', `assets.draw("${slotId}") skipped because media slot is empty or not ready`, time);
              return;
            }
            if (mk) {
              mk.drawMediaSmart(destCtx, el, x, y, w, h, { time, ...opts }, motionScratch);
              return;
            }
            destCtx.save();
            if (opts.opacity !== undefined) destCtx.globalAlpha *= opts.opacity;
            destCtx.drawImage(el, x, y, w, h);
            destCtx.restore();
          },
          drawImage: (destCtx, x, y, w, h, opts = {}) => {
            const img = fallbackCustomImg;
            if (!img || !img.naturalWidth || !img.naturalHeight) {
              this._recordRenderLog('warn', 'assets', 'drawImage() skipped because no customImage asset is loaded/ready', time);
              return;
            }
            if (mk) {
              mk.drawMediaSmart(destCtx, img, x, y, w, h, { time, ...opts }, motionScratch);
              return;
            }
            destCtx.save();
            if (opts.opacity !== undefined) destCtx.globalAlpha *= opts.opacity;
            destCtx.drawImage(img, x, y, w, h);
            destCtx.restore();
          }
        },
      pools: (() => {
        const getReadyPool = (poolId) => {
          const list = this.mediaPools?.get(poolId);
          if (!Array.isArray(list)) return [];
          return list.filter((e) => e && e.enabled !== false && !e.missingPlaceholder && e.el && (e.kind === 'video' ? e.el.readyState >= 2 : (e.ready && e.el.naturalWidth > 0)));
        };
        const resolveEntry = (poolId, indexOrId) => {
          const ready = getReadyPool(poolId);
          if (!ready.length) return null;
          if (typeof indexOrId === 'number') {
            const idx = ((Math.floor(indexOrId) % ready.length) + ready.length) % ready.length;
            return ready[idx] || null;
          }
          if (typeof indexOrId === 'string') {
            return ready.find((e) => e.id === indexOrId || e.name === indexOrId) || null;
          }
          return ready[0] || null;
        };
        return {
          ids: () => (this.mediaPools ? Array.from(this.mediaPools.keys()) : []),
          count: (poolId) => getReadyPool(poolId).length,
          items: (poolId) => getReadyPool(poolId).map((e) => ({
            id: e.id,
            name: e.name,
            kind: e.kind,
            width: e.width,
            height: e.height,
            duration: e.duration || 0
          })),
          get: (poolId, indexOrId) => resolveEntry(poolId, indexOrId)?.el || null,
          draw: (destCtx, poolId, indexOrId, x, y, w, h, opts = {}) => {
            const entry = resolveEntry(poolId, indexOrId);
            if (!entry || !entry.el) {
              this._recordRenderLog('warn', 'pools', `pools.draw("${poolId}", ${indexOrId}) skipped because pool has no ready enabled items`, time);
              return;
            }
            if (entry.kind === 'video' && mk && typeof mk.drawMediaSmart === 'function' && !opts.tint && !opts.rotation && !opts.flipX && !opts.flipY) {
              mk.drawMediaSmart(destCtx, entry.el, x, y, w, h, { time, ...opts }, motionScratch);
              return;
            }
            if (window.MediaPoolHelper?.drawElement) {
              window.MediaPoolHelper.drawElement(destCtx, entry.el, x, y, w, h, opts);
              return;
            }
            destCtx.save();
            if (opts.opacity !== undefined) destCtx.globalAlpha *= opts.opacity;
            destCtx.drawImage(entry.el, x, y, w, h);
            destCtx.restore();
          }
        };
      })()
    };
      frameContext.debug = frameContext.log;

    // layer 2 draws on its own transparent canvas when a post pass exists, so the shader can
    // sample it; reset the state a previous frame may have left behind
    const drawTarget = usePost && this.overlayCtx ? this.overlayCtx : ctx;
    if (drawTarget !== ctx) {
      drawTarget.setTransform(1, 0, 0, 1, 0, 0);
      drawTarget.globalAlpha = 1;
      drawTarget.globalCompositeOperation = 'source-over';
      drawTarget.filter = 'none';
      drawTarget.clearRect(0, 0, W, H);
    }

    if(typeof this.compiledDrawScript === 'function') {
    try {
      this.compiledDrawScript(drawTarget, W, H, frameContext, this.state, this._createScriptConsole('drawScript', time));
      for (const [k, v] of Object.entries(this.state || {})) {
        if (k === 'project' || k === 'log') continue;
        if (typeof v === 'number' && !Number.isFinite(v)) {
          this._recordRenderLog('warn', 'drawScript', `state.${k} is ${v}`, time);
        }
      }
    } catch (err) {
      console.error('Error in frontUiBox.drawScript:', err);
      this._recordRuntimeError('drawScript runtime', err);
    }
  }

  if (usePost) {
    const composed = this._renderPostComposite();
    if (this.glCanvas) ctx.drawImage(this.glCanvas, 0, 0, W, H);
    // the shader never read the overlay, so the engine keeps the text on top of the grade instead
    // of letting it disappear
    if ((!composed || !this._postSamplesOverlay) && this.overlayCanvas) {
      ctx.drawImage(this.overlayCanvas, 0, 0, W, H);
    }
  }

  this._lastFrameDiag = {
    time: Number(time.toFixed(3)),
    width: W,
    height: H,
    aspectRatio: this.aspectRatio,
    audio: {
      bass: Number((audioMetrics.bass || 0).toFixed(3)),
      mid: Number((audioMetrics.mid || 0).toFixed(3)),
      high: Number((audioMetrics.high || 0).toFixed(3)),
      rms: Number((audioMetrics.rms || 0).toFixed(3)),
      hasDecodedFft: Boolean(this.audioSignalData)
    },
    midi: {
      hasMidi: all.length > 0,
      selectedTracks: this.selectedTrackIds.size,
      totalNotes: all.length,
      activeNotes: active.length,
      triggeredNotes: triggered.length
    },
    clips: {
      activeCount: this.activeVideos.length,
      readyCount: this.activeVideos.filter((v) => v && v.readyState >= 2).length
    },
    pipeline: {
      postShader: Boolean(this.postProgram),
      bloom: Boolean(this.postProgram && this._loc(this.postProgram, this.postUniformLocations, 'u_bloom_tex')),
      sceneFormat: this.sceneFormat || null,
      overlay: Boolean(this._overlayBound),
      overlayInShader: Boolean(this._postSamplesOverlay),
      passes: this._pipelinePasses || 0
    },
    assets: {
      hasCustomImage: Boolean(this.customImageReady && this.customImage)
    },
    pools: (() => {
      const summary = {};
      if (this.mediaPools) {
        for (const [poolId, list] of this.mediaPools.entries()) {
          const enabled = Array.isArray(list) ? list.filter((e) => e && e.enabled !== false) : [];
          summary[poolId] = {
            activeCount: enabled.length,
            readyCount: enabled.filter((e) => e.el && (e.kind === 'video' ? e.el.readyState >= 2 : e.ready)).length
          };
        }
      }
      return summary;
    })(),
    chord: frameContext.chord?.name || null,
    section: currentSection?.label || null,
    // exactly what reached the GPU this frame: a missing key means the shader does not declare or
    // use that uniform, which is the difference between "wired" and "bound" that logs couldn't show
    lyricUniforms: this._lyricUniforms ? { ...this._lyricUniforms } : null,
    stateKeys: Object.keys(this.state || {}).filter((k) => k !== 'project' && k !== 'log').slice(0, 16)
  };

  const diagBeforeComposite = this._lastFrameDiag;
  if (!opts._skipLoopComposite) {
    if (Math.abs(time - this.lastTriggeredTime) >= 1e-6) {
      if (this.lastTriggeredTime < 0 || time < this.lastTriggeredTime || time - this.lastTriggeredTime > 0.35) {
        this._lastTriggerWindowStart = time - 0.04;
      } else {
        this._lastTriggerWindowStart = this.lastTriggeredTime;
      }
      this.lastTriggeredTime = time;
    }
    if (this.loopCache) {
      const ctrlSig = JSON.stringify(this.preset?.controlsBox?.values || {});
      const clipSig = (activeVideo && activeVideo.readyState >= 2) ? (activeVideo.dataset?.clipId || 1) : 0;
      const cacheKey = `${this.loopCache.version}|${W}x${H}|${this.preset?.id || ''}|${ctrlSig}|${clipSig}`;
      if (time <= 0.025 && !loopInfo.inTransition && (!activeVideo || (!activeVideo.seeking && activeVideo.readyState >= 2))) {
        this.loopCache.capture(this.canvas, W, H, cacheKey);
      } else if (loopInfo.inTransition) {
        this.loopCache.composite(ctx, W, H, loopInfo.easeProgress, cacheKey, (startCtx) => {
          const prevCtx = this.ctx;
          const prevBass = this.smoothedBass;
          const prevMid = this.smoothedMid;
          const prevHigh = this.smoothedHigh;
          const prevRms = this.smoothedRms;
          const prevHit = this.smoothedNoteHit;
          const prevKick = this.smoothedKick;
          const prevSnare = this.smoothedSnare;
          const prevTop = this.smoothedTop;
          const prevStemBass = this.smoothedStemBass;
          const prevStemOther = this.smoothedStemOther;
          const prevDrums = this.smoothedDrums;
          const prevSmoothTime = this._lastSmoothTime;
          const prevTrig = this.lastTriggeredTime;
          const prevTrigWin = this._lastTriggerWindowStart;
          try {
            this.ctx = startCtx;
            this.smoothedBass = undefined;
            this.smoothedMid = undefined;
            this.smoothedHigh = undefined;
            this.smoothedRms = undefined;
            this.smoothedNoteHit = undefined;
            this.smoothedKick = undefined;
            this.smoothedSnare = undefined;
            this.smoothedTop = undefined;
            this.smoothedStemBass = undefined;
            this.smoothedStemOther = undefined;
            this.smoothedDrums = undefined;
            this._lastSmoothTime = -1;
            this.lastTriggeredTime = -1;
            this._lastTriggerWindowStart = -1;
            this.renderFrame(0, activeVideo, { _skipLoopComposite: true });
          } finally {
            this.ctx = prevCtx;
            this.smoothedBass = prevBass;
            this.smoothedMid = prevMid;
            this.smoothedHigh = prevHigh;
            this.smoothedRms = prevRms;
            this.smoothedNoteHit = prevHit;
            this.smoothedKick = prevKick;
            this.smoothedSnare = prevSnare;
            this.smoothedTop = prevTop;
            this.smoothedStemBass = prevStemBass;
            this.smoothedStemOther = prevStemOther;
            this.smoothedDrums = prevDrums;
            this._lastSmoothTime = prevSmoothTime;
            this.lastTriggeredTime = prevTrig;
            this._lastTriggerWindowStart = prevTrigWin;
          }
        }, { style: loopInfo.loopStyle, progress: loopInfo.progress });
      }
    }
  }

  // the loop turnaround renders frame 0 into a scratch context on top of this frame; that nested
  // render overwrites the diagnostics with its own and samples the scratch canvas, so the frame the
  // user actually sees is restored before health is measured
  this._lastFrameDiag = diagBeforeComposite;
  this._sampleFrameHealth(time, frameStartedAt);
}

    cleanup() {
  const gl = this.gl;
  if (gl) {
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    if (this.fftTexture) gl.deleteTexture(this.fftTexture);
    if (this.waveformTexture) gl.deleteTexture(this.waveformTexture);
    if (this.videoTexture) gl.deleteTexture(this.videoTexture);
    if (this.imageTexture) gl.deleteTexture(this.imageTexture);
    if (this.glProgram) gl.deleteProgram(this.glProgram);
    if (this.postProgram) gl.deleteProgram(this.postProgram);
    if (this.bloomPrograms) {
      if (this.bloomPrograms.prefilter) gl.deleteProgram(this.bloomPrograms.prefilter);
      if (this.bloomPrograms.tent) gl.deleteProgram(this.bloomPrograms.tent);
    }
    this._disposePipelineTargets();
    if (this.transparentTexture) gl.deleteTexture(this.transparentTexture);
    if (this.quadVao) gl.deleteVertexArray(this.quadVao);
  }
  if (this.loopCache) {
    this.loopCache.dispose();
  }
  if (this.mediaSlots) {
    for (const entry of this.mediaSlots.values()) {
      this._disposeMediaSlotEntry(entry);
    }
    this.mediaSlots.clear();
  }
  if (this._pendingSlotRefs) this._pendingSlotRefs.clear();
  if (this._mediaPoolCache) {
    for (const entry of this._mediaPoolCache.values()) {
      this._disposeMediaPoolEntry(entry);
    }
    this._mediaPoolCache.clear();
  }
  if (this.mediaPools) this.mediaPools.clear();
  if (this._pendingPoolRefs) this._pendingPoolRefs.clear();
  this._uploadedShaderImageEl = null;
  this.lyricsData = null;
  if (this._motionScratch && window.motionKit) {
    window.motionKit.disposeScratchState(this._motionScratch);
  }
  this._motionScratch = null;
  this._disposeClipTransitionStates();
  this.quadBuffer = null;
  this.fftTexture = null;
  this.waveformTexture = null;
  this.videoTexture = null;
  this.imageTexture = null;
  this.glProgram = null;
  this.uniformLocations = {};
  this.postProgram = null;
  this.postUniformLocations = {};
  this._postUniformPresence = {};
  this._cachedProjectData = null;
  this.audioSignalData = null;
  this.lastRuntimeErrors = [];
  this.renderLogs = [];
  this.deadUniforms = [];
  this._loggedKeys = new Set();
  this._userLogCount = 0;
  this._lastFrameDiag = null;
  this._videoTextureValid = false;
  this._lastVideoUploadMs = undefined;
  this._lastVideoUploadKind = null;
  this._lastTransInfo = null;
  this._lastVideoDiagSec = -1;
  this._lyricUniforms = null;
  this._probeTraces = new Map();
  this._suppressProbe = false;
  this._pixelCanvas = null;
  this._pixelCtx = null;
  this._pixelSample = null;
  this._pixelLuma = null;
  this._frameMs = 0;
  this._frameMsMax = 0;
}

  /**
   * Frame health: what the frame cost and what actually landed on the canvas. A preset that renders
   * black, blows out, goes flat or stops moving is invisible in uniform values and in a single still,
   * so a 16x16 readback is the cheapest instrument that answers "is anything on screen".
   */
  _sampleFrameHealth(time, startedAt) {
    const diag = this._lastFrameDiag;
    if (!diag) return;
    if (startedAt) {
      const ms = Math.max(0, performance.now() - startedAt);
      this._frameMs = this._frameMs > 0 ? this._frameMs * 0.9 + ms * 0.1 : ms;
      this._frameMsMax = Math.max(this._frameMsMax || 0, ms);
      diag.perf = {
        ms: Number(ms.toFixed(2)),
        avgMs: Number(this._frameMs.toFixed(2)),
        maxMs: Number(this._frameMsMax.toFixed(2))
      };
    }
    const sample = this._samplePixels(time);
    if (sample) diag.pixels = { ...sample };
  }

  _samplePixels(time) {
    const now = Number(time) || 0;
    if (this._pixelSample && Math.abs(now - this._pixelSample.at) < 0.4) return this._pixelSample;
    // the loop turnaround renders into a scratch context; its pixels are intermediate, not a frame
    if (!this.ctx || this.ctx.canvas !== this.canvas) return this._pixelSample || null;
    try {
      if (!this._pixelCanvas) {
        this._pixelCanvas = document.createElement('canvas');
        this._pixelCanvas.width = 16;
        this._pixelCanvas.height = 16;
        this._pixelCtx = this._pixelCanvas.getContext('2d', { willReadFrequently: true });
      }
      this._pixelCtx.clearRect(0, 0, 16, 16);
      this._pixelCtx.drawImage(this.canvas, 0, 0, 16, 16);
      const data = this._pixelCtx.getImageData(0, 0, 16, 16).data;
      const count = data.length / 4;
      const luma = new Float32Array(count);
      const colors = new Set();
      let min = 1;
      let max = 0;
      let sum = 0;
      for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        luma[p] = l;
        sum += l;
        if (l < min) min = l;
        if (l > max) max = l;
        colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      }
      const prev = this._pixelLuma;
      let diff = 0;
      if (prev) {
        for (let i = 0; i < count; i += 1) diff += Math.abs(luma[i] - prev[i]);
        diff /= count;
      }
      const gap = this._pixelSample ? Math.max(0, now - this._pixelSample.at) : 0;
      const staticSec = (prev && diff < 0.004 && gap > 0 && gap < 1.2)
        ? Number(((this._pixelSample.staticSec || 0) + gap).toFixed(2))
        : 0;
      this._pixelLuma = luma;
      this._pixelSample = {
        at: Number(now.toFixed(2)),
        meanLuma: Number((sum / count).toFixed(3)),
        minLuma: Number(min.toFixed(3)),
        maxLuma: Number(max.toFixed(3)),
        distinct: colors.size,
        changed: prev ? Number(diff.toFixed(4)) : null,
        staticSec
      };
      return this._pixelSample;
    } catch {
      this._pixelSample = { at: Number(now.toFixed(2)), error: 'pixels unreadable' };
      return this._pixelSample;
    }
  }

  /**
   * Streaming per-label motion trace, O(1) memory per label. Only consecutive frames accumulate:
   * a seek would otherwise register a jump the preset never made, so a discontinuity starts a fresh
   * measurement window instead of polluting travel, span and maxDelta.
   */
  _recordProbeTrace(label, value, time, opts = {}) {
    if (this._suppressProbe) return;
    const key = String(label || '').trim().slice(0, 40);
    const num = Number(value);
    if (!key || !Number.isFinite(num)) return;
    if (!this._probeTraces.has(key) && this._probeTraces.size >= 24) return;

    const spatial = Boolean(opts.spatial);
    const trace = this._probeTraces.get(key) || {
      label: key,
      spatial,
      frames: 0,
      lastValue: null,
      lastTime: null,
      lastDelta: 0,
      first: num,
      last: num,
      min: num,
      max: num,
      travel: 0,
      path: 0,
      seconds: 0,
      reversals: 0,
      maxDelta: 0,
      maxDeltaAt: null
    };

    const contiguous = trace.lastTime !== null && Math.abs(time - trace.lastTime) <= 0.5;
    // a preset can call frame.fx.camera() more than once per frame (shader pass, overlay pass,
    // parallax variant); only the first call at a timestamp is a sample, or intra-frame differences
    // would read as motion
    if (trace.frames > 0 && time === trace.lastTime) return;
    if (trace.frames > 0 && !contiguous) {
      trace.first = num;
      trace.min = num;
      trace.max = num;
      trace.travel = 0;
      trace.path = 0;
      trace.seconds = 0;
      trace.reversals = 0;
      trace.maxDelta = 0;
      trace.maxDeltaAt = null;
      trace.lastDelta = 0;
    } else if (trace.frames > 0) {
      const delta = num - trace.lastValue;
      const abs = Math.abs(delta);
      if (abs > trace.maxDelta) {
        trace.maxDelta = Number(abs.toFixed(4));
        trace.maxDeltaAt = Number(time.toFixed(2));
      }
      if (abs > 1e-4) {
        if (Math.abs(trace.lastDelta) > 1e-4 && Math.sign(delta) !== Math.sign(trace.lastDelta)) {
          trace.reversals += 1;
        }
        trace.lastDelta = delta;
      }
      trace.travel += delta;
      trace.path += abs;
      trace.seconds += Math.max(0, time - trace.lastTime);
    }

    trace.frames += 1;
    trace.last = num;
    trace.min = Math.min(trace.min, num);
    trace.max = Math.max(trace.max, num);
    trace.lastValue = num;
    trace.lastTime = time;
    this._probeTraces.set(key, trace);
  }

  /**
   * Camera values are in pixels of the frame's canvas, so they are also reported as a percentage of
   * frame width: "the camera moved 3% of frame" is the only wording the motion budget is written in.
   */
  _getProbeTraces() {
    const width = Number(this._lastFrameDiag?.width) || 1080;
    const round = (n) => Number(Number(n).toFixed(4));
    const pct = (n) => Number((Number(n) / width * 100).toFixed(2));
    const out = {};
    for (const [key, trace] of this._probeTraces.entries()) {
      const entry = {
        frames: trace.frames,
        seconds: Number(trace.seconds.toFixed(2)),
        travel: round(trace.travel),
        span: round(trace.max - trace.min),
        path: round(trace.path),
        maxDelta: round(trace.maxDelta),
        maxDeltaAt: trace.maxDeltaAt,
        reversals: trace.reversals
      };
      if (trace.spatial) {
        entry.travelPct = pct(trace.travel);
        entry.spanPct = pct(trace.max - trace.min);
        entry.maxDeltaPct = pct(trace.maxDelta);
        entry.frameWidth = width;
      }
      out[key] = entry;
    }
    return out;
  }

  getRenderDiagnostics() {
    return {
      runtimeErrors: Array.isArray(this.lastRuntimeErrors) ? [...this.lastRuntimeErrors] : [],
      renderLogs: Array.isArray(this.renderLogs) ? [...this.renderLogs] : [],
      deadUniforms: Array.isArray(this.deadUniforms) ? [...this.deadUniforms] : [],
      lastFrame: this._lastFrameDiag ? { ...this._lastFrameDiag } : null,
      traces: this._getProbeTraces()
    };
  }

  probeRenderLogs(samplesOrOpts = 'both', restoreSample = null) {
    const duration = this.project?.duration || 30.0;
    const dropTime = (typeof this.project?.dropTime === 'number' && !Number.isNaN(this.project.dropTime))
      ? this.project.dropTime
      : (duration * 0.5);

    let samples;
    let restore;
    if (Array.isArray(samplesOrOpts)) {
      samples = samplesOrOpts;
      restore = restoreSample || samples[0] || { time: 0, activeVideo: null };
    } else {
      const opts = (samplesOrOpts && typeof samplesOrOpts === 'object')
        ? samplesOrOpts
        : { at: String(samplesOrOpts || 'both') };
      const at = opts.at || 'both';
      const curTime = typeof opts.currentTime === 'number' ? opts.currentTime : (this._lastFrameDiag?.time ?? 0);
      const curVid = opts.activeVideo || null;
      if (at === 'drop') {
        samples = [{ label: 'drop', time: dropTime, activeVideo: curVid }];
      } else if (at === 'current') {
        samples = [{ label: 'current', time: curTime, activeVideo: curVid }];
      } else {
        samples = [{ label: 'current', time: curTime, activeVideo: curVid }];
        if (Math.abs(dropTime - curTime) > 0.05) {
          samples.push({ label: 'drop', time: dropTime, activeVideo: opts.dropVideo || curVid });
        }
      }
      restore = restoreSample || { time: curTime, activeVideo: curVid };
    }

    const prevTrig = this.lastTriggeredTime;
    const prevBass = this.smoothedBass;
    const prevRms = this.smoothedRms;
    const prevHit = this.smoothedNoteHit;
    const prevSuppress = this._suppressNativeConsole;
    // the probe renders deliberately scattered timestamps; counting them as motion would replace a
    // real measurement with the size of the seek. traces keep reporting the last contiguous playback.
    const prevSuppressProbe = this._suppressProbe;
    this._suppressProbe = true;
    const traces = this._getProbeTraces();
    const frameSamples = [];

    if (this._loggedKeys) {
      for (const k of Array.from(this._loggedKeys)) {
        if (k.startsWith('user:')) this._loggedKeys.delete(k);
      }
    }
    this._userLogCount = 0;
    this._suppressNativeConsole = true;

    try {
      for (const s of samples) {
        const t = typeof s.time === 'number' ? s.time : 0;
        this.lastTriggeredTime = t - 0.05;
        this.renderFrame(t, s.activeVideo || null, { _skipLoopComposite: true });
        if (this._lastFrameDiag) {
          frameSamples.push({ label: s.label || `${t.toFixed(2)}s`, ...this._lastFrameDiag });
        }
      }
    } finally {
      this._suppressNativeConsole = prevSuppress;
      this.lastTriggeredTime = prevTrig;
      this.smoothedBass = prevBass;
      this.smoothedRms = prevRms;
      this.smoothedNoteHit = prevHit;
      if (restore) {
        this.renderFrame(typeof restore.time === 'number' ? restore.time : 0, restore.activeVideo || null, { _skipLoopComposite: true });
      }
      this._suppressProbe = prevSuppressProbe;
    }

    return {
      runtimeErrors: [...(this.lastRuntimeErrors || [])],
      renderLogs: [...(this.renderLogs || [])],
      deadUniforms: [...(this.deadUniforms || [])],
      traces,
      samples: frameSamples
    };
  }
    }

// exposed for tests: the version pairing and the webgl1 down-port are pure functions, so they can be
// pinned without a gl context
ReelEngine.GlslCompat = { detectGlslVersion, downportGlsl3To1, VERT_SHADER_ES1, VERT_SHADER_ES3 };
ReelEngine.VideoUpload = { resolveVideoUpload, VIDEO_HOLD_MS };

if (typeof window !== 'undefined') {
  window.ReelEngine = ReelEngine;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ReelEngine;
}
}) ();
