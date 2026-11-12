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

  const DEFAULT_VERT_SHADER = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = (a_pos + 1.0) * 0.5;
      v_uv.y = 1.0 - v_uv.y; // standard top-down uv
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

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
      this.gl = this.glCanvas.getContext('webgl', {
        alpha: false,
        antialias: true,
        preserveDrawingBuffer: true,
        premultipliedAlpha: false
      }) || this.glCanvas.getContext('experimental-webgl');

      this.preset = null;
      this.project = null;
      this.state = {};
      this.activeVideos = [];
      this.shaderClipIndex = 0;
      this.lastTriggeredTime = -1;

      // compiled routines
      this.compiledInitScript = null;
      this.compiledDrawScript = null;
      this.glProgram = null;
      this.uniformLocations = {};

      // webgl geometry & textures
      this._initWebGLQuad();
      this._initTextures();

      // audio analysis buffers for standard uniforms
      this.fftArray = new Uint8Array(256);
      this.waveformArray = new Uint8Array(256);

      // selected tracks set
      this.selectedTrackIds = new Set();
    }

    get params() {
      return this.preset?.controlsBox?.values || {};
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

      if (this.gl) {
        this.gl.viewport(0, 0, this.width, this.height);
      }

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
        -1.0,  1.0,
        -1.0,  1.0,
         1.0, -1.0,
         1.0,  1.0
      ]);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      this.quadBuffer = quadBuffer;
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
    }

    compileShaderBox(fragSource) {
      const gl = this.gl;
      if (!gl) return;

      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, DEFAULT_VERT_SHADER);
      gl.compileShader(vs);

      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fragSource || FALLBACK_FRAG_SHADER);
      gl.compileShader(fs);

      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(fs);
        console.error('ShaderBox fragment compile error:', info);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return false;
      }

      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);

      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('ShaderBox program link error:', gl.getProgramInfoLog(prog));
        gl.deleteProgram(prog);
        return false;
      }

      if (this.glProgram) {
        gl.deleteProgram(this.glProgram);
      }

      this.glProgram = prog;
      this.uniformLocations = {};

      gl.useProgram(prog);
      const aPos = gl.getAttribLocation(prog, 'a_pos');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      return true;
    }

    loadPreset(preset) {
      if (!preset || !preset.frontUiBox) {
        console.error('Invalid ReelPreset passed to ReelEngine');
        return;
      }

      this.preset = preset;
      if (preset.meta?.aspectRatio) {
        this.setAspectRatio(preset.meta.aspectRatio);
      }

      if (preset.shaderBox?.fragmentShader) {
        this.compileShaderBox(preset.shaderBox.fragmentShader);
      }

      try {
        this.compiledInitScript = new Function(
          'project',
          'state',
          'controls',
          preset.frontUiBox.initScript || ''
        );
      } catch (err) {
        console.error('Failed to compile frontUiBox.initScript:', err);
        this.compiledInitScript = () => {};
      }

      try {
        this.compiledDrawScript = new Function(
          'ctx',
          'width',
          'height',
          'frame',
          'state',
          preset.frontUiBox.drawScript || ''
        );
      } catch (err) {
        console.error('Failed to compile frontUiBox.drawScript:', err);
        this.compiledDrawScript = () => {};
      }

      this.reinitPresetState();
    }

    setProject(project) {
      this.project = project;
      if (project?.tracks) {
        this.selectedTrackIds.clear();
        project.tracks.forEach((tr) => {
          if (tr.defaultSelected) this.selectedTrackIds.add(tr.id);
        });
      }
      this.reinitPresetState();
    }

    setActiveVideos(videoElements) {
      this.activeVideos = Array.isArray(videoElements) ? videoElements : [];
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
      this.state = {
        project: projectData
      };
      if (typeof this.compiledInitScript === 'function') {
        try {
          const controls = this.preset?.controlsBox?.values || {};
          this.compiledInitScript(projectData, this.state, controls);
        } catch (err) {
          console.error('Error executing frontUiBox.initScript:', err);
        }
      }
    }

    _buildProjectData() {
      const proj = this.project || {};
      const allNotes = [];
      const tracks = [];

      if (proj.tracks && Array.isArray(proj.tracks)) {
        proj.tracks.forEach((tr, trIdx) => {
          const isSelected = this.selectedTrackIds.has(tr.id);
          tracks.push({
            index: trIdx,
            id: tr.id,
            name: tr.name,
            noteCount: tr.noteCount || 0,
            selected: isSelected
          });

          if (isSelected && tr.notes) {
            for (const n of tr.notes) {
              allNotes.push({
                pitch: n.midi,
                velocity: n.velocity || 0.8,
                startTime: n.time,
                duration: n.duration || 0.5,
                trackIndex: trIdx,
                trackName: tr.name
              });
            }
          }
        });
      }

      allNotes.sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch);

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
        }
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

      // synthesize smoothed audio frequency bands from rms & beat phase
      const bpm = proj.bpm || 120;
      const beatPhase = (time * (bpm / 60)) % 1;
      const beatImpulse = Math.pow(Math.max(0, 1 - beatPhase * 1.8), 2.5);

      const bass = Math.min(1.0, rms * (isDrop ? 1.25 : 0.65) + beatImpulse * 0.35);
      const mid = Math.min(1.0, rms * 0.95 + 0.15);
      const high = Math.min(1.0, rms * (isDrop ? 0.9 : 0.45) + (Math.sin(time * 12.0) * 0.1 + 0.1));

      return { rms, bass, mid, high, beatImpulse };
    }

    _getActiveAndTriggeredNotes(time) {
      const projData = this._buildProjectData();
      const all = projData.midi.allNotes;
      const active = [];
      const triggered = [];

      const lookbehind = 0.04;
      for (const n of all) {
        if (time >= n.startTime && time <= n.startTime + n.duration) {
          active.push(n);
        }
        if (n.startTime <= time && n.startTime > time - lookbehind && n.startTime > this.lastTriggeredTime) {
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
        if (best) return { name: best.name, time: best.time, root: best.name.replace(/[^A-Ga-g#b]/g, '') };
      }

      const { active } = this._getActiveAndTriggeredNotes(time);
      if (active.length > 0) {
        const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const pitches = Array.from(new Set(active.map((n) => n.pitch % 12))).sort((a, b) => a - b);
        const lowest = active.slice().sort((a, b) => a.pitch - b.pitch)[0].pitch % 12;
        const root = NOTE_NAMES[lowest];

        const hasMajorThird = pitches.includes((lowest + 4) % 12);
        const hasMinorThird = pitches.includes((lowest + 3) % 12);
        const hasSeventh = pitches.includes((lowest + 11) % 12);
        const hasFlatSeventh = pitches.includes((lowest + 10) % 12);

        let quality = 'maj';
        if (hasMinorThird) {
          quality = hasFlatSeventh ? 'm7' : 'm';
        } else if (hasMajorThird) {
          quality = hasSeventh ? 'maj7' : (hasFlatSeventh ? '7' : 'maj');
        }
        return { name: root + quality, root, quality, time };
      }

      const key = (this.project?.key || 'Bmaj').toUpperCase();
      return { name: key, root: key.replace(/[^A-G#B]/g, ''), quality: '', time: 0 };
    }

    _renderShaderBox(time, audioMetrics, noteTriggerImpulse, activePitch, activeVideo) {
      const gl = this.gl;
      if (!gl || !this.glProgram) return;

      gl.useProgram(this.glProgram);
      gl.viewport(0, 0, this.width, this.height);

      const getLoc = (name) => {
        if (this.uniformLocations[name] === undefined) {
          this.uniformLocations[name] = gl.getUniformLocation(this.glProgram, name);
        }
        return this.uniformLocations[name];
      };

      const uTime = getLoc('u_time');
      if (uTime) gl.uniform1f(uTime, time);

      const uRes = getLoc('u_resolution');
      if (uRes) gl.uniform2f(uRes, this.width, this.height);

      const lerp = (a, b, t) => a + (b - a) * t;
      this.smoothedBass = lerp(this.smoothedBass !== undefined ? this.smoothedBass : 0.4, audioMetrics.bass, 0.2);
      this.smoothedRms = lerp(this.smoothedRms !== undefined ? this.smoothedRms : 0.4, audioMetrics.rms, 0.16);
      this.smoothedNoteHit = lerp(this.smoothedNoteHit !== undefined ? this.smoothedNoteHit : 0.0, noteTriggerImpulse, 0.3);

      const uBass = getLoc('u_bass');
      if (uBass) gl.uniform1f(uBass, this.smoothedBass);
      const uMid = getLoc('u_mid');
      if (uMid) gl.uniform1f(uMid, audioMetrics.mid);
      const uHigh = getLoc('u_high');
      if (uHigh) gl.uniform1f(uHigh, audioMetrics.high);
      const uRms = getLoc('u_rms');
      if (uRms) gl.uniform1f(uRms, this.smoothedRms);

      const uHasMidi = getLoc('u_has_midi');
      if (uHasMidi) gl.uniform1f(uHasMidi, this.selectedTrackIds.size > 0 ? 1.0 : 0.0);
      const uBpm = getLoc('u_bpm');
      if (uBpm) gl.uniform1f(uBpm, this.project?.bpm || 120);
      const uNoteHit = getLoc('u_note_hit');
      if (uNoteHit) gl.uniform1f(uNoteHit, this.smoothedNoteHit);
      const uActivePitch = getLoc('u_active_pitch');
      if (uActivePitch) gl.uniform1f(uActivePitch, activePitch);

      // chord cut impulse (aesthetic spike on chord transition that decays over 0.22s)
      const chordCuts = this.project?.chordCutTimes || [];
      let chordHit = 0.0;
      for (const ct of chordCuts) {
        const dt = time - ct;
        if (dt >= 0 && dt < 0.22) {
          chordHit = Math.max(chordHit, Math.pow(1.0 - dt / 0.22, 2.0));
        }
      }
      const uChordHit = getLoc('u_chord_hit');
      if (uChordHit) gl.uniform1f(uChordHit, chordHit);

      const uHasVideo = getLoc('u_has_video');
      const uVideoTex = getLoc('u_video_tex');
      const vid = activeVideo || this.activeVideos[this.shaderClipIndex];

      if (vid && vid.readyState >= 2) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vid);
        } catch {
          // ignore cross-origin or unready video frames
        }
        if (uVideoTex) gl.uniform1i(uVideoTex, 0);
        if (uHasVideo) gl.uniform1f(uHasVideo, 1.0);
      } else {
        if (uHasVideo) gl.uniform1f(uHasVideo, 0.0);
      }

      const fields = this.preset?.controlsBox?.fields || [];
      const values = this.preset?.controlsBox?.values || {};

      for (const f of fields) {
        if (f.target === 'shader_uniform' || f.target === 'both') {
          const loc = getLoc(f.id);
          if (!loc) continue;

          const val = values[f.id] !== undefined ? values[f.id] : f.defaultValue;
          if (f.type === 'slider') {
            gl.uniform1f(loc, parseFloat(val) || 0);
          } else if (f.type === 'toggle') {
            gl.uniform1f(loc, val ? 1.0 : 0.0);
          } else if (f.type === 'color') {
            const rgb = hexToRgb01(String(val));
            gl.uniform3f(loc, rgb[0], rgb[1], rgb[2]);
          }
        }
      }

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    getSpeedRampInfo(time) {
      const duration = this.project?.duration || 30.0;
      const dropTime = (typeof this.project?.dropTime === 'number' && !isNaN(this.project.dropTime))
        ? this.project.dropTime
        : (duration * 0.5);
      const bpm = this.project?.bpm || 120;
      const secPerBeat = 60 / bpm;
      const cutMode = this.preset?.controlsBox?.values?.cutMode || 'chord';
      const speedRamping = this.preset?.controlsBox?.values?.speedRamping !== false;

      if (!speedRamping || time < dropTime) {
        return { clipTime: time, instSpeed: 1.0 };
      }

      let cuts = [dropTime];
      if (cutMode === 'chord' && this.project?.chordCutTimes?.length) {
        cuts = this.project.chordCutTimes;
      } else if (cutMode === 'impact' && this.project?.impactTimes?.length) {
        cuts = this.project.impactTimes;
      } else {
        const interval = cutMode === '2bar' ? secPerBeat * 8 : secPerBeat * 16;
        for (let t = dropTime; t < duration; t += interval) {
          cuts.push(t);
        }
      }

      let segmentStart = dropTime;
      for (let i = cuts.length - 1; i >= 0; i--) {
        if (time >= cuts[i]) {
          segmentStart = cuts[i];
          break;
        }
      }

      const tau = time - segmentStart;
      const rampDur = Math.min(0.42, secPerBeat * 0.9);
      if (tau < rampDur) {
        const p = tau / rampDur;
        const ease = 1 - Math.pow(p - 1, 2);
        return {
          clipTime: segmentStart + tau * (0.4 + ease * 0.6),
          instSpeed: 0.4 + ease * 0.6
        };
      }

      return { clipTime: time, instSpeed: 1.0 };
    }

    renderFrame(time, activeVideo = null) {
      const ctx = this.ctx;
      const W = this.width;
      const H = this.height;

      const audioMetrics = this._getAudioMetricsAt(time);
      const { all, active, triggered } = this._getActiveAndTriggeredNotes(time);

      const noteHit = triggered.length > 0 ? 1.0 : Math.max(0, audioMetrics.beatImpulse * 0.8);
      const activePitch = active.length > 0 ? (active[0].pitch - 36) / 60 : 0.5;

      this._renderShaderBox(time, audioMetrics, noteHit, activePitch, activeVideo);

      if (this.glCanvas) {
        ctx.drawImage(this.glCanvas, 0, 0, W, H);
      } else {
        ctx.fillStyle = '#121829';
        ctx.fillRect(0, 0, W, H);
      }

      const duration = this.project?.duration || 30.0;
      const frameContext = {
        audio: {
          time,
          duration,
          progress: Math.max(0, Math.min(1, time / duration)),
          bass: audioMetrics.bass,
          bassSmooth: this.smoothedBass !== undefined ? this.smoothedBass : audioMetrics.bass,
          mid: audioMetrics.mid,
          high: audioMetrics.high,
          rms: audioMetrics.rms,
          rmsSmooth: this.smoothedRms !== undefined ? this.smoothedRms : audioMetrics.rms,
          fft: this.fftArray,
          waveform: this.waveformArray
        },
        midi: {
          hasMidi: all.length > 0,
          bpm: this.project?.bpm || 120,
          allNotes: all,
          activeNotes: active,
          triggeredNotes: triggered
        },
        chord: this._detectChordAt(time),
        timeline: {
          dropTime: this.project?.dropTime !== undefined ? this.project.dropTime : duration * 0.5,
          dropBar: this.project?.dropBar || 9,
          markers: (this.preset?.features?.timeline?.markers || [
            { id: 'drop', label: 'drop', time: this.project?.dropTime !== undefined ? this.project.dropTime : duration * 0.5, color: '#83ca90' }
          ]),
          chords: this.project?.chordTimelineMarkers || [],
          currentChord: this._detectChordAt(time)
        },
        clips: {
          count: this.activeVideos.length,
          drawClip: (destCtx, clipIdx, x, y, w, h, opts = {}) => {
            const v = this.activeVideos[clipIdx] || activeVideo;
            if (!v || v.readyState < 2) return;
            destCtx.save();
            if (opts.opacity !== undefined) destCtx.globalAlpha *= opts.opacity;

            const vw = v.videoWidth || 1920;
            const vh = v.videoHeight || 1080;
            const vAspect = vw / vh;
            const targetAspect = w / h;

            if (opts.fit === 'contain') {
              let dw = w, dh = h, dx = x, dy = y;
              if (targetAspect > vAspect) {
                dw = h * vAspect;
                dx = x + (w - dw) * 0.5;
              } else {
                dh = w / vAspect;
                dy = y + (h - dh) * 0.5;
              }
              destCtx.drawImage(v, 0, 0, vw, vh, dx, dy, dw, dh);
            } else {
              // default cover fit: crops overflow, never squishes
              let sx = 0, sy = 0, sw = vw, sh = vh;
              if (targetAspect > vAspect) {
                sh = vw / targetAspect;
                sy = (vh - sh) * 0.5;
              } else {
                sw = vh * targetAspect;
                sx = (vw - sw) * 0.5;
              }
              destCtx.drawImage(v, sx, sy, sw, sh, x, y, w, h);
            }
            destCtx.restore();
          },
          setShaderVideoClip: (clipIdx) => {
            this.shaderClipIndex = clipIdx;
          }
        },
        controls: this.preset?.controlsBox?.values || {},
        project: this._buildProjectData(),
        assets: {
          coverImage: null
        }
      };

      if (typeof this.compiledDrawScript === 'function') {
        try {
          this.compiledDrawScript(ctx, W, H, frameContext, this.state);
        } catch (err) {
          console.error('Error in frontUiBox.drawScript:', err);
        }
      }

      this.lastTriggeredTime = time;
    }

    cleanup() {
      const gl = this.gl;
      if (gl) {
        if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
        if (this.fftTexture) gl.deleteTexture(this.fftTexture);
        if (this.videoTexture) gl.deleteTexture(this.videoTexture);
        if (this.glProgram) gl.deleteProgram(this.glProgram);
      }
      this.quadBuffer = null;
      this.fftTexture = null;
      this.videoTexture = null;
      this.glProgram = null;
    }
  }

  window.ReelEngine = ReelEngine;
})();
