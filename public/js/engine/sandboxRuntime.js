/**
 * Frame-side runtime. This file is fetched by the host and inlined into the sandboxed iframe's
 * srcdoc, so it must never depend on anything from the studio document.
 *
 * The frame owns drawing only. It receives a preset, a project and the precomputed signal data
 * once, then renders one requested time per message and transfers the resulting bitmap back.
 */
(function () {
  'use strict';

  // the frame has no bundle service, so an idb:// ref can never resolve here; the host pushes the
  // bytes for every slot and pool instead. without this flag the engine mints placeholder tiles and
  // logs a CSP violation for each ref it tries to load directly.
  window.SANDBOX_FRAME = true;

  // a real element, not an OffscreenCanvas: during preview the compositor consumes this canvas
  // directly, so no bitmap has to cross the iframe boundary per frame
  var canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  (document.body || document.documentElement).appendChild(canvas);
  var engine = null;
  var clipVideos = [];

  function post(type, payload, transfer) {
    parent.postMessage(Object.assign({ type: type }, payload || {}), '*', transfer || []);
  }

  // ReelEngine catches drawScript throws into its own diagnostics; mirror console output so a
  // failing overlay reaches the host instead of leaving a silently empty canvas.
  ['error', 'warn'].forEach(function (level) {
    var original = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      var text = args.map(function (a) {
        return typeof a === 'string' ? a : (a && a.message) || String(a);
      }).join(' ');
      post('log', { level: level, message: text.slice(0, 400) });
      original.apply(console, arguments);
    };
  });

  var lastRenderTime = -1;

  // resolve only when the element has actually presented the requested frame
  function seekVideo(video, target) {
    return new Promise(function (resolve) {
      if (!video) return resolve();
      if (Math.abs(video.currentTime - target) < 0.002) return resolve();
      var settled = false;
      function done() {
        if (settled) return;
        settled = true;
        video.removeEventListener('seeked', done);
        resolve();
      }
      video.addEventListener('seeked', done);
      try { video.currentTime = target; } catch (err) { done(); }
      setTimeout(done, 150);
    });
  }

  var videoHealthPrev = {};
  var videoHealthFrames = 0;
  var errorCheckFrames = 0;
  var lastVideoHealth = '';
  var mediaVideoCount = 0;
  var mediaDroppedTotal = 0;

  // decode health is invisible to the frame timers: a stuttering video presents fewer frames while
  // every canvas frame still renders on time
  function reportVideoHealth() {
    if (!engine || typeof engine.getMediaSlotElements !== 'function') return;
    var videos = engine.getMediaSlotElements('video');
    mediaVideoCount = videos.length;
    if (!videos.length) return;
    var parts = [];
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      if (!video || typeof video.getVideoPlaybackQuality !== 'function') {
        parts.push(i + ':n/a');
        continue;
      }
      var quality = video.getVideoPlaybackQuality();
      var previous = videoHealthPrev[i];
      var gained = previous ? quality.totalVideoFrames - previous.total : 0;
      var dropped = previous ? quality.droppedVideoFrames - previous.dropped : 0;
      videoHealthPrev[i] = { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames };
      mediaDroppedTotal += dropped;
      parts.push(i + ':' + gained + 'f/' + dropped + 'd rs' + video.readyState + (video.paused ? '/paused' : '/playing') + ' d' + (Number.isFinite(video.duration) ? video.duration.toFixed(1) : 'NaN'));
    }
    lastVideoHealth = parts.join(' ');
    post('video-health', { text: lastVideoHealth });
  }

  var lastErrorSignature = '';
  // ReelEngine collects script and shader failures instead of throwing them, and nothing else
  // reads that list inside the frame; without this the host would never learn a preset broke.
  function reportRuntimeErrors() {
    var errors = (engine && engine.lastRuntimeErrors) || [];
    if (!errors.length) return;
    var signature = errors.join('|');
    if (signature === lastErrorSignature) return;
    lastErrorSignature = signature;
    post('runtime-error', { errors: errors.slice(0, 4) });
  }

  function drawFrame(time, index, active, capture) {
    var started = performance.now();
    engine.renderFrame(time, active || undefined);
    var renderMs = performance.now() - started;
    videoHealthFrames += 1;
    if (videoHealthFrames >= 60) {
      videoHealthFrames = 0;
      reportVideoHealth();
    }
    errorCheckFrames += 1;
    if (errorCheckFrames >= 10) {
      errorCheckFrames = 0;
      reportRuntimeErrors();
    }
    if (!capture) {
      // preview: the frame is already on screen, so only the timing needs to go back
      post('painted', {
        index: index,
        time: time,
        renderMs: renderMs,
        videos: mediaVideoCount,
        dropped: mediaDroppedTotal
      });
      return null;
    }
    // resolve only after the copy is taken, so the pump cannot draw over it mid-capture
    return createImageBitmap(canvas).then(function (bitmap) {
      post('frame', { bitmap: bitmap, index: index, time: time, renderMs: renderMs }, [bitmap]);
    }, function (err) {
      post('error', {
        phase: 'capture',
        message: String((err && err.message) || err),
        stack: String((err && err.stack) || '')
      });
      // a null frame releases the host waiter even though there are no pixels to show
      post('frame', { bitmap: null, index: index, time: time, renderMs: renderMs }, []);
    });
  }

  var slotUrls = new Map();
  var poolKeys = new Map();
  var fontKeys = new Set();
  var renderBusy = false;
  var renderPending = null;
  var captureQueue = [];
  var pumpRaf = 0;

  // a scrub drag produces more render requests than the frame can seek; keep only the newest so
  // the queue drains to "where the playhead is now" instead of replaying every intermediate step.
  // captures are queued instead of coalesced: the host is awaiting each one.
  function enqueueRender(msg) {
    if (msg.capture === false) renderPending = msg;
    else captureQueue.push(msg);
  }

  /**
   * Draw on the frame document's own animation frame. Message delivery is a task, not a vsync
   * callback, so drawing on arrival regularly misses the compositor deadline and shows the same
   * frame twice before jumping ahead — the judder this replaces.
   */
  function pump() {
    pumpRaf = requestAnimationFrame(pump);
    if (!engine || renderBusy) return;
    var next = captureQueue.length ? captureQueue.shift() : renderPending;
    if (!next) return;
    if (next === renderPending) renderPending = null;
    renderBusy = true;
    try {
      handleRender(next, function () {
        renderBusy = false;
      });
    } catch (err) {
      renderBusy = false;
      post('error', {
        phase: 'pump',
        message: String((err && err.message) || err),
        stack: String((err && err.stack) || '')
      });
    }
  }

  // slot and pool videos loop from their own head, so the deterministic position for a timestamp is
  // t % duration — the same mapping app.js uses when it syncs the in-page elements
  function seekAuxVideos(time, skip) {
    if (!engine || typeof engine.getMediaSlotElements !== 'function') return Promise.resolve();
    var vids = engine.getMediaSlotElements('video');
    var seeks = [];
    for (var i = 0; i < vids.length; i++) {
      var video = vids[i];
      if (!video || video === skip || video.seeking) continue;
      var duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0.05) continue;
      try { video.pause(); } catch (err) {}
      seeks.push(seekVideo(video, Math.max(0, time) % duration));
    }
    return Promise.all(seeks);
  }

  // free playback lets the elements run; only real drift gets corrected, the same tolerance the
  // studio uses for the in-page elements
  function playAuxVideos(time, skip) {
    if (!engine || typeof engine.getMediaSlotElements !== 'function') return;
    var vids = engine.getMediaSlotElements('video');
    for (var i = 0; i < vids.length; i++) {
      var video = vids[i];
      if (!video || video === skip) continue;
      // start playback before consulting duration: a video whose metadata has not loaded reports
      // NaN, and gating play behind that left every slot video frozen at its first frame
      if (video.paused && !video.seeking) {
        try { video.play().catch(function () {}); } catch (err) {}
      }
      var duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0.05) continue;
      var target = Math.max(0, time) % duration;
      if (!video.seeking && Math.abs(video.currentTime - target) > 0.35) {
        try { video.currentTime = target; } catch (err) {}
      }
    }
  }

  function handleRender(msg, done) {
    var time = msg.time || 0;
    var sameTime = Math.abs(time - lastRenderTime) < 0.0005;
    // a backwards move is a scrub; a forward step under three quarters of a second is playback,
    // even when the host is running slow. treating a slow frame as a jump paused every slot video
    // and awaited its seek, which is what made playback stutter harder the slower it got.
    var jumped = lastRenderTime >= 0 && (time < lastRenderTime - 0.001 || time - lastRenderTime > 0.75);
    lastRenderTime = time;
    // a repeated timestamp is only a "show this exact frame" request while paused. during playback
    // the audio clock updates slower than a 120 hz tick, so treating repeats as seeks paused and
    // re-seeked every slot/pool video on alternate frames.
    var playing = msg.playing === true;
    // a paused or scrubbed playhead must show the exact frame; only free playback may drift
    var exact = Boolean(msg.exact) || jumped || (sameTime && !playing);
    var active = typeof msg.clipIndex === 'number' && msg.clipIndex >= 0 ? clipVideos[msg.clipIndex] : null;
    var pending = [];

    function finish() {
      var capture;
      try {
        capture = drawFrame(time, msg.index, active, msg.capture !== false);
      } catch (err) {
        post('error', {
          phase: 'render',
          message: String((err && err.message) || err),
          stack: String((err && err.stack) || '')
        });
        done();
        return;
      }
      if (capture && typeof capture.then === 'function') capture.then(done, done);
      else done();
    }

    if (exact) pending.push(seekAuxVideos(time, active));
    else playAuxVideos(time, active);

    if (active && Number.isFinite(active.duration) && active.duration > 0) {
      // the parent resolved trim, speed and cut interval against its own element; mirror that
      // instead of re-deriving it from wall time, which ignored all three.
      var target = typeof msg.clipTime === 'number' ? msg.clipTime : time % active.duration;
      var rate = typeof msg.clipRate === 'number' && msg.clipRate > 0 ? msg.clipRate : 1;
      if (Math.abs(active.playbackRate - rate) > 0.01) {
        try { active.playbackRate = rate; } catch (err) {}
      }
      if (exact) {
        try { active.pause(); } catch (err) {}
        pending.push(seekVideo(active, target));
      } else {
        if (Math.abs(active.currentTime - target) > 0.35) {
          try { active.currentTime = target; } catch (err) {}
        }
        if (active.paused) {
          try { active.play().catch(function () {}); } catch (err) {}
        }
      }
    }

    Promise.all(pending).then(finish, finish);
  }

  function boot(payload) {
    var debug = Boolean(payload && payload.debug);
    var lastStep = 'boot-start';
    var done = false;
    function step(label) {
      lastStep = label;
      if (debug) post('trace', { step: label });
    }
    // a synchronous hang inside the engine produces no error at all, just silence
    setTimeout(function () {
      if (!done) post('error', { phase: 'boot-timeout', message: 'stuck at ' + lastStep, stack: '' });
    }, 2500);
    try {
      step('boot-start');
      canvas.width = payload.width;
      canvas.height = payload.height;
      engine = new window.ReelEngine(canvas);
      // decode finishes long after the frame that asked for it was painted; without a nudge the
      // host keeps showing the missing-media tile until something else triggers a render
      var announcedAssets = {};
      engine.onAssetLoaded = function (key) {
        var assetId = String(key || 'asset');
        if (announcedAssets[assetId]) return;
        announcedAssets[assetId] = true;
        post('assets-changed', { key: assetId });
      };
      step('constructed');
      engine.setAspectRatio(payload.aspectRatio || '9:16');
      step('aspect');

      var project = payload.project || { duration: 30, bpm: 120, tracks: [], allNotes: [], clips: [], sections: [] };
      if (payload.signalData) project._signalData = payload.signalData;
      // the frame has no network origin, so an audioUrl would make the engine attempt fetch(blob:)
      // and fail; the precomputed signals are authoritative here.
      project.audioUrl = null;

      engine.loadPreset(payload.preset);
      // a new engine starts with no media; the URL caches belong to the previous one
      slotUrls.forEach(function (entry) {
        try { URL.revokeObjectURL(entry.url); } catch (err) {}
      });
      slotUrls.clear();
      poolKeys.clear();
      step('preset');
      engine.setProject(project);
      step('project');
      if (payload.lyrics && typeof engine.setLyricsData === 'function') {
        engine.setLyricsData(payload.lyrics);
        step('lyrics');
      }
      post('lyrics-state', {
        source: 'boot',
        has: Boolean(payload.lyrics),
        lines: payload.lyrics && Array.isArray(payload.lyrics.lines) ? payload.lyrics.lines.length : 0
      });
      engine.setActiveVideos([]);
      step('videos');
      done = true;
      lastErrorSignature = '';
      if (!pumpRaf) pumpRaf = requestAnimationFrame(pump);
      // custom fonts register during loadPreset and decode asynchronously; a render that lands
      // before they finish draws fallback type, which is a preview that disagrees with the export
      function announce() {
        post('booted', { width: canvas.width, height: canvas.height });
      }
      if (document.fonts && document.fonts.ready) {
        Promise.race([
          document.fonts.ready.then(function () {}, function () {}),
          new Promise(function (resolve) { setTimeout(resolve, 3000); })
        ]).then(announce);
      } else {
        announce();
      }
    } catch (err) {
      engine = null;
      post('error', {
        phase: 'boot',
        message: String((err && err.message) || err),
        stack: String((err && err.stack) || '')
      });
    }
  }

  window.addEventListener('error', function (event) {
    post('error', {
      phase: 'window',
      message: String((event && event.message) || 'unknown'),
      stack: String((event && event.error && event.error.stack) || '')
    });
  });

  window.addEventListener('message', function (event) {
    var msg = event.data || {};

    if (msg.type === 'init') {
      if (engine && msg.aspectRatio) {
        // setAspectRatio owns the canvas dimensions and re-derives them from the ratio
        engine.setAspectRatio(msg.aspectRatio);
      } else {
        canvas.width = msg.width;
        canvas.height = msg.height;
      }
      post('ready-initialized', { width: canvas.width, height: canvas.height });
      return;
    }

    if (msg.type === 'boot') {
      boot(msg);
      return;
    }

    if (msg.type === 'clips') {
      var list = Array.isArray(msg.clips) ? msg.clips : [];
      for (var i = 0; i < clipVideos.length; i++) {
        try { URL.revokeObjectURL(clipVideos[i].src); } catch (err) {}
      }
      clipVideos = [];
      if (!list.length) {
        if (engine) engine.setActiveVideos([]);
        post('clips-ready', { count: 0 });
        return;
      }
      var pending = list.length;
      list.forEach(function (clip, index) {
        var blob = new Blob([clip.bytes], { type: clip.mimeType || 'video/mp4' });
        var url = URL.createObjectURL(blob);
        var video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.src = url;
        clipVideos[index] = video;
        function settle() {
          pending -= 1;
          if (pending === 0) {
            if (engine) engine.setActiveVideos(clipVideos);
            // these elements are muted, so playback is allowed without a gesture. letting them run
            // is what keeps readyState >= 2; constant seeking was what made the texture flicker.
            clipVideos.forEach(function (video) {
              try { video.play().catch(function () {}); } catch (err) {}
            });
            post('clips-ready', { count: clipVideos.length });
          }
        }
        video.addEventListener('loadeddata', settle, { once: true });
        video.addEventListener('error', settle, { once: true });
      });
      return;
    }

    if (msg.type === 'signal') {
      if (engine && msg.signalData) {
        engine.audioSignalData = msg.signalData;
        engine._audioSignalUrl = msg.key || null;
        if (window.audioSignals && typeof window.audioSignals.registerSignalData === 'function') {
          try { window.audioSignals.registerSignalData(msg.key || null, msg.signalData); } catch (err) {}
        }
        if (engine.loopCache && typeof engine.loopCache.invalidate === 'function') engine.loopCache.invalidate();
      }
      return;
    }

    if (msg.type === 'media-slot') {
      if (engine && msg.slotId && (msg.bytes || msg.dataUrl)) {
        var previous = slotUrls.get(msg.slotId);
        // same source, same element: re-pushing bytes would mint a new blob URL, and setMediaSlot
        // dedupes by URL, so it would tear the video/image down and reload it
        if (previous && msg.key && previous.key === msg.key) return;
        if (previous && previous.url && previous.url.indexOf('blob:') === 0) {
          try { URL.revokeObjectURL(previous.url); } catch (err) {}
        }
        var slotUrl = msg.dataUrl || URL.createObjectURL(new Blob([msg.bytes], { type: msg.mimeType || 'image/png' }));
        slotUrls.set(msg.slotId, { key: msg.key || '', url: slotUrl });
        engine.setMediaSlot(msg.slotId, slotUrl, msg.kind || 'image');
      }
      return;
    }

    if (msg.type === 'media-pool') {
      if (engine && Array.isArray(msg.items)) {
        if (msg.key && poolKeys.get(msg.poolId) === msg.key) return;
        poolKeys.set(msg.poolId, msg.key || '');
        var poolItems = msg.items.map(function (item) {
          var url = item.dataUrl || (item.bytes
            ? URL.createObjectURL(new Blob([item.bytes], { type: item.mimeType || 'image/png' }))
            : item.src);
          return { id: item.id, name: item.name, kind: item.kind, enabled: item.enabled, src: url };
        });
        engine.setMediaPool(msg.poolId, poolItems);
      }
      return;
    }

    if (msg.type === 'fonts') {
      var list = Array.isArray(msg.faces) ? msg.faces : [];
      var jobs = [];
      list.forEach(function (face) {
        if (!face || !face.family || !face.bytes) return;
        var key = face.family + '|' + face.weight + '|' + face.style + '|' + face.subset;
        if (fontKeys.has(key)) return;
        fontKeys.add(key);
        try {
          var loaded = new FontFace(face.family, face.bytes, {
            weight: String(face.weight || 400),
            style: face.style || 'normal',
            unicodeRange: face.unicodeRange || undefined
          });
          jobs.push(loaded.load().then(function (font) {
            document.fonts.add(font);
            // the frame may already have painted with fallback type
            post('assets-changed', { key: 'font:' + face.family });
          }, function () {
            fontKeys.delete(key);
          }));
        } catch (err) {
          fontKeys.delete(key);
        }
      });
      // the host gates captures on this, so it has to mean "usable", not "received"
      Promise.all(jobs).then(function () {
        post('fonts-state', { applied: true, faces: jobs.length, total: list.length });
      });
      return;
    }

    if (msg.type === 'controls') {
      if (!engine || !msg.id) return;
      var preset = engine.preset || (engine.preset = {});
      var box = preset.controlsBox || (preset.controlsBox = { fields: [], values: {} });
      if (!box.values || typeof box.values !== 'object') box.values = {};
      // the engine reads this object every frame, so assigning here is the whole update
      box.values[msg.id] = msg.value === undefined ? null : msg.value;
      // an uploaded font only exists in the host document; the frame needs the bytes to use it
      if (msg.font && typeof engine._syncCustomFontsFromPreset === 'function') {
        engine._syncCustomFontsFromPreset({ assets: { customFonts: [msg.font] } });
      }
      // the loop cache is keyed on the control signature, so a move mid-song leaves it stale
      if (engine.loopCache && typeof engine.loopCache.invalidate === 'function') engine.loopCache.invalidate();
      return;
    }

    if (msg.type === 'lyrics') {
      if (engine && typeof engine.setLyricsData === 'function') {
        engine.setLyricsData(msg.lyrics || null);
      }
      post('lyrics-state', {
        source: 'message',
        has: Boolean(msg.lyrics),
        lines: msg.lyrics && Array.isArray(msg.lyrics.lines) ? msg.lyrics.lines.length : 0
      });
      return;
    }

    if (msg.type === 'render') {
      if (engine) enqueueRender(msg);
      return;
    }

    if (msg.type === 'dispose') {
      if (pumpRaf) cancelAnimationFrame(pumpRaf);
      pumpRaf = 0;
      engine = null;
      post('disposed', {});
      return;
    }

    if (msg.type === 'diag') {
      post('diag', {
        errors: (engine && engine.lastRuntimeErrors || []).slice(0, 5),
        logs: (engine && engine.renderLogs || []).slice(-8),
        video: lastVideoHealth,
        hasDrawScript: typeof (engine && engine.compiledDrawScript) === 'function',
        stateKeys: engine ? Object.keys(engine.state || {}) : [],
        lastFrame: (engine && engine._lastFrameDiag) || null,
        deadUniforms: (engine && Array.isArray(engine.deadUniforms)) ? engine.deadUniforms.slice(0, 24) : [],
        traces: (engine && typeof engine._getProbeTraces === 'function') ? engine._getProbeTraces() : {}
      });
    }
  });

  post('hello', { runtime: 'v3', hasBoot: true });
  post('ready', {});
})();
