/**
 * Sandboxed renderer transport.
 *
 * The frame owns compositing once the engine moves in: it receives audio signals and preset code
 * and draws into its own canvas. Preset scripts never run in this document, so they cannot reach
 * cookies, IndexedDB, the DOM, or the network (the frame CSP allows only local blob:/data: URLs).
 *
 * A visible frame paints straight to the screen, which is what preview uses. Captures (export,
 * thumbnails, snapshots) ask for one ImageBitmap instead, because those readers need pixels in the
 * host document.
 */
(function () {
  'use strict';

  function frameRuntime() {
    // offscreencanvas only: transferToImageBitmap lives there, not on a display canvas
    var canvas = new OffscreenCanvas(1, 1);
    var ctx = canvas.getContext('2d');
    var width = 0;
    var height = 0;
    var dpr = 1;
    var running = false;
    var rafId = 0;
    var frameIndex = 0;
    var lastTime = 0;
    var signal = { bass: 0, mid: 0, high: 0, rms: 0, time: 0 };
    var fpsWindow = { started: 0, frames: 0 };

    function post(type, payload, transfer) {
      parent.postMessage(Object.assign({ type: type }, payload || {}), '*', transfer || []);
    }

    function resize(nextWidth, nextHeight, nextDpr) {
      width = nextWidth;
      height = nextHeight;
      dpr = nextDpr || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      // resizing resets the context state, so the dpr transform has to be re-applied
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw(col) {
      var t = signal.time;
      var h = height;
      var w = width;
      var grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, 'hsl(' + ((t * 12) % 360) + ', 62%, 18%)');
      grad.addColorStop(1, 'hsl(' + ((t * 12 + 60) % 360) + ', 48%, 42%)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      var radius = 40 + signal.bass * Math.min(w, h) * 0.28;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + (0.12 + signal.rms * 0.5) + ')';
      ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = '28px ui-monospace, monospace';
      ctx.fillText('frame ' + col, 24, 48);
    }

    function emit() {
      frameIndex += 1;
      var bitmap = canvas.transferToImageBitmap();
      post('frame', { bitmap: bitmap, index: frameIndex, time: signal.time }, [bitmap]);
      fpsWindow.frames += 1;
      var now = performance.now();
      if (!fpsWindow.started) fpsWindow.started = now;
      if (now - fpsWindow.started >= 1000) {
        post('stats', { fps: Math.round(fpsWindow.frames * 1000 / (now - fpsWindow.started)) });
        fpsWindow.started = now;
        fpsWindow.frames = 0;
      }
    }

    function step(index) {
      try {
        draw(index);
        emit();
      } catch (err) {
        // a silent throw here is invisible to the parent, which then just sees zero frames
        post('error', { phase: 'step', message: String(err && err.message || err), stack: String(err && err.stack || '') });
      }
    }

    function loop(now) {
      if (!running) return;
      // advance on wall clock so the parent can tell a slow frame from a slow machine
      signal.time += lastTime ? Math.min(now - lastTime, 100) / 1000 : 1 / 60;
      lastTime = now;
      step(frameIndex);
      rafId = requestAnimationFrame(loop);
    }

    function start() {
      if (running) return;
      running = true;
      lastTime = 0;
      var startedAt = frameIndex;
      setTimeout(function () {
        // hidden iframes can have rAF throttled to nothing; say so instead of going quiet
        if (running && frameIndex === startedAt) {
          post('error', { phase: 'world', message: 'requestAnimationFrame did not fire - hidden iframe throttle' });
        }
      }, 400);
      rafId = requestAnimationFrame(loop);
    }

    function stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    }

    window.addEventListener('message', function (event) {
      var msg = event.data;
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'init') {
        resize(msg.width, msg.height, msg.dpr || 1);
        post('ready-initialized', { width: msg.width, height: msg.height });
        return;
      }
      if (msg.type === 'audio') {
        signal.bass = msg.bass || 0;
        signal.mid = msg.mid || 0;
        signal.high = msg.high || 0;
        signal.rms = msg.rms || 0;
        signal.time = msg.time || 0;
        return;
      }
      if (msg.type === 'play') { start(); return; }
      if (msg.type === 'stop') { stop(); return; }
      if (msg.type === 'render') {
        // deterministic step: one requested frame, no wall-clock advance
        signal.time = msg.time || signal.time;
        step(msg.index || frameIndex);
        return;
      }
      if (msg.type === 'dispose') { stop(); post('disposed', {}); }
    });

    post('ready', {});
  }

  function buildFrameDoc({ width, height, dpr, extraSources, runtimeSource }) {
    // a literal </script> inside inlined source would close the tag early
    const safe = (s) => String(s).replace(/<\/script/gi, '<\\/script');
    const source = safe(runtimeSource || `(${frameRuntime.toString()})();`);
    const extras = Array.isArray(extraSources) ? safe(extraSources.filter(Boolean).join('\n')) : '';
    return [
      '<!doctype html><meta charset="utf-8">',
      // unsafe-eval is required: preset scripts are compiled with new Function inside the frame.
      // blob: in connect-src/font-src is frame-local (the frame mints its own object URLs); it does
      // not open a network path, so exfiltration stays blocked.
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'; style-src \'unsafe-inline\'; img-src blob: data:; media-src blob: data:; font-src blob: data:; connect-src blob: data:">',
      '<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}canvas{display:block;width:100%;height:100%}</style>',
      extras ? `<script>${extras}<\/script>` : '',
      `<script>${source}<\/script>`
    ].join('');
  }

  class RendererFrame {
    constructor(options = {}) {
      this.width = Math.round(options.width || 1080);
      this.height = Math.round(options.height || 1920);
      this.dpr = options.dpr || 1;
      this.onFrame = typeof options.onFrame === 'function' ? options.onFrame : null;
      this.onPainted = typeof options.onPainted === 'function' ? options.onPainted : null;
      this.onStats = typeof options.onStats === 'function' ? options.onStats : null;
      this.onLog = typeof options.onLog === 'function' ? options.onLog : null;
      this.onError = typeof options.onError === 'function' ? options.onError : null;
      this.onReady = typeof options.onReady === 'function' ? options.onReady : null;
      this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;

      this.ready = false;
      this.disposed = false;
      this.visible = Boolean(options.visible);
      this.extraSources = Array.isArray(options.extraSources) ? options.extraSources : [];
      this.runtimeSource = typeof options.runtimeSource === 'string' ? options.runtimeSource : null;
      this._frames = 0;
      this._handler = (event) => this._handleMessage(event);

      this.iframe = document.createElement('iframe');
      this.iframe.setAttribute('sandbox', 'allow-scripts');
      this.iframe.setAttribute('aria-hidden', 'true');
      this.iframe.tabIndex = -1;
      this.iframe.style.cssText = this.visible
        // sits over #previewCanvas inside .canvas-housing; pointer-events stay on the host canvas
        ? 'position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:transparent;pointer-events:none;'
        : 'position:absolute;left:-10px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;';
      this.iframe.srcdoc = buildFrameDoc({
        width: this.width,
        height: this.height,
        dpr: this.dpr,
        extraSources: this.extraSources,
        runtimeSource: this.runtimeSource
      });
    }

    mount(container) {
      if (this.disposed) return this;
      const host = container || document.body;
      if (this.visible) {
        // insert directly after the canvas so later siblings (the render overlay) stay on top
        const canvas = host.querySelector('canvas');
        if (canvas && canvas.parentNode === host) host.insertBefore(this.iframe, canvas.nextSibling);
        else host.appendChild(this.iframe);
      } else {
        host.appendChild(this.iframe);
      }
      window.addEventListener('message', this._handler);
      return this;
    }

    _send(payload, transfer) {
      if (!this.iframe.contentWindow || this.disposed) return;
      this.iframe.contentWindow.postMessage(payload, '*', transfer || []);
    }

    _handleMessage(event) {
      if (!this.iframe.contentWindow || event.source !== this.iframe.contentWindow) return;
      const msg = event.data;
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'ready') {
        this._send({ type: 'init', width: this.width, height: this.height, dpr: this.dpr });
        return;
      }
      if (msg.type === 'ready-initialized') {
        this.ready = true;
        if (this.onReady) this.onReady({ width: msg.width, height: msg.height });
        return;
      }
      if (msg.type === 'frame') {
        this._frames += 1;
        if (this.onFrame) this.onFrame(msg.bitmap, msg.index, msg.time, msg.renderMs);
        else if (msg.bitmap && typeof msg.bitmap.close === 'function') msg.bitmap.close();
        return;
      }
      if (msg.type === 'painted') {
        if (this.onPainted) this.onPainted(msg);
        return;
      }
      if (msg.type === 'stats') {
        if (this.onStats) this.onStats({ fps: msg.fps, frames: this._frames });
        return;
      }
      if (msg.type === 'log') {
        if (this.onLog) this.onLog(msg.message, msg.level);
        return;
      }
      if (msg.type === 'error') {
        if (this.onError) this.onError(msg);
        return;
      }
      if (this.onMessage) this.onMessage(msg);
    }

    setSize(width, height, dpr, aspectRatio) {
      this.width = Math.round(width);
      this.height = Math.round(height);
      if (dpr) this.dpr = dpr;
      this._send({ type: 'init', width: this.width, height: this.height, dpr: this.dpr, aspectRatio: aspectRatio || null });
      return this;
    }

    /**
     * Signal payload is copied before transfer: the caller reuses its FFT buffers every frame, and
     * transferring them would detach the arrays under the analyser.
     */
    sendAudio(audio, time) {
      this._send({
        type: 'audio',
        time: time || 0,
        bass: audio?.bass || 0,
        mid: audio?.mid || 0,
        high: audio?.high || 0,
        rms: audio?.rms || 0
      });
      return this;
    }

    play() { this._send({ type: 'play' }); return this; }
    stop() { this._send({ type: 'stop' }); return this; }
    renderFrame(time, index, clipIndex, exact, clipTime, clipRate, capture, playing) {
      this._send({
        type: 'render',
        time,
        index,
        clipIndex,
        exact,
        clipTime,
        clipRate,
        capture: capture !== false,
        playing: playing === true
      });
      return this;
    }
    sendCommand(type, payload, transfer) { this._send(Object.assign({ type }, payload || {}), transfer); return this; }

    destroy() {
      this.disposed = true;
      window.removeEventListener('message', this._handler);
      this._send({ type: 'dispose' });
      if (this.iframe.parentNode) this.iframe.parentNode.removeChild(this.iframe);
      this.iframe.srcdoc = '';
    }
  }

  window.RendererFrame = RendererFrame;
})();
