// anamorphic letterbox template with timecode hud, spectrum, and film grain
(function () {
  class CinematicMinimalTemplate {
    constructor() {
      this.id = 'cinematic-minimal';
      this.name = 'Cinematic Minimal';
      this.subtitle = 'Anamorphic letterbox & timecode HUD';
      this.tagline = 'Anamorphic matte bars, audio spectrum, and 35mm grain';
      this.badge = 'Aesthetic';

      this.canvas = null;
      this.ctx = null;
      this.project = null;
      this.selectedTrackIds = new Set();

      this.params = {
        letterboxHeight: 200,
        filmGrain: 0.35,
        waveformStyle: 'bars', // 'bars' | 'wave' | 'dots'
        accentColor: '#38bdf8', // ice cyan
        bloomIntensity: 0.75,
        cameraPunch: 1.0,
        cutMode: 'chord',
        speedRamping: true,
        dropGlitch: true,
        autoFrame: true
      };

      // floating dust motes in the viewport
      this.particles = [];
      this.lastCutTime = -1;
      this.lastCutIndex = -1;
    }

    init(canvas, state) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.initParticles();
      if (state && state.project) {
        this.setProject(state.project);
      }
    }

    initParticles() {
      this.particles = [];
      const count = 40;
      for (let i = 0; i < count; i++) {
        this.particles.push({
          x: Math.random() * 1080,
          y: Math.random() * 1920,
          vx: (Math.random() - 0.5) * 8,
          vy: -Math.random() * 12 - 4,
          r: Math.random() * 2.2 + 0.8,
          alpha: Math.random() * 0.4 + 0.15,
          phase: Math.random() * Math.PI * 2
        });
      }
    }

    setProject(proj) {
      this.project = proj;
      if (proj?.tracks) {
        this.selectedTrackIds.clear();
        proj.tracks.forEach((tr) => {
          if (tr.defaultSelected) this.selectedTrackIds.add(tr.id);
        });
      }
    }

    rebuildNoteNodes() {
      this.initParticles();
    }

    toggleTrack(trackId, enabled) {
      if (enabled) this.selectedTrackIds.add(trackId);
      else this.selectedTrackIds.delete(trackId);
    }

    getSpeedRampInfo(time) {
      const dur = this.project?.duration || 30.0;
      const dropTime = (typeof this.project?.dropTime === 'number' && !isNaN(this.project.dropTime))
        ? this.project.dropTime
        : (dur * 0.5);
      const bpm = this.project?.bpm || 120;
      const secPerBeat = 60 / bpm;

      if (!this.params.speedRamping || time < dropTime) {
        return { clipTime: time, instSpeed: 1.0 };
      }

      const cutMode = this.params.cutMode || 'chord';
      let cuts = [dropTime];
      if (cutMode === 'chord' && this.project?.chordCutTimes?.length) {
        cuts = this.project.chordCutTimes;
      } else if (cutMode === 'impact' && this.project?.impactTimes?.length) {
        cuts = this.project.impactTimes;
      } else {
        const interval = cutMode === '2bar' ? secPerBeat * 8 : secPerBeat * 16;
        for (let t = dropTime; t < (this.project?.duration || 29.09); t += interval) {
          cuts.push(t);
        }
      }

      let curSegIdx = 0;
      for (let i = 0; i < cuts.length; i++) {
        if (time >= cuts[i]) curSegIdx = i;
        else break;
      }

      const segStart = cuts[curSegIdx] || dropTime;
      const segEnd = cuts[curSegIdx + 1] || (this.project?.duration || 29.09);
      const segDur = Math.max(0.4, segEnd - segStart);
      const segProgress = (time - segStart) / segDur;

      // s-curve ramp: slow down at mid, accelerate at edges
      let speed = 1.0;
      if (segProgress < 0.2) {
        speed = 1.6 - (segProgress / 0.2) * 0.7; // 1.6 down to 0.9
      } else if (segProgress > 0.8) {
        speed = 0.9 + ((segProgress - 0.8) / 0.2) * 0.7; // 0.9 up to 1.6
      } else {
        speed = 0.9;
      }

      return {
        clipTime: (time - segStart) * 1.1,
        instSpeed: speed
      };
    }

    renderFrame(time, activeVid) {
      if (!this.canvas || !this.ctx) return;
      const ctx = this.ctx;
      const W = 1080;
      const H = 1920;
      const proj = this.project || {};
      const dur = proj.duration || 30.0;
      const dropTime = (typeof proj.dropTime === 'number' && !isNaN(proj.dropTime))
        ? proj.dropTime
        : (dur * 0.5);
      const bpm = proj.bpm || 120;
      const isPostDrop = time >= dropTime;
      const dSinceDrop = Math.max(0, time - dropTime);

      const lbH = Math.max(80, Math.min(320, this.params.letterboxHeight || 200));
      const viewY = lbH;
      const viewH = H - lbH * 2;

      ctx.save();
      ctx.clearRect(0, 0, W, H);

      // cinema viewport (clip with grading & zoom)
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, viewY, W, viewH);
      ctx.clip();

      ctx.fillStyle = '#0a0d12';
      ctx.fillRect(0, viewY, W, viewH);

      // slow ken burns zoom pre-drop, punch zoom on drop
      let zoom = 1.0;
      let panX = 0;
      let panY = 0;
      const punchMult = this.params.cameraPunch || 1.0;

      if (!isPostDrop) {
        const preProgress = Math.min(1, time / Math.max(1, dropTime));
        zoom = 1.0 + preProgress * 0.08 * punchMult;
      } else {
        const dropImp = Math.max(0, 1 - dSinceDrop / 0.45);
        zoom = 1.04 + dropImp * 0.12 * punchMult;

        const beatSec = 60 / bpm;
        const beatFrac = (time % beatSec) / beatSec;
        if (beatFrac < 0.18) {
          const beatImp = (1 - beatFrac / 0.18) * 4 * punchMult;
          panY += (Math.sin(time * 30) * beatImp);
        }
      }

      if (activeVid && activeVid.readyState >= 2) {
        ctx.save();
        ctx.translate(W / 2 + panX, viewY + viewH / 2 + panY);
        ctx.scale(zoom, zoom);

        const vW = activeVid.videoWidth || activeVid.width || 854;
        const vH = activeVid.videoHeight || activeVid.height || 480;
        const vAspect = vW / vH;
        const targetAspect = W / viewH;

        const focalX = activeVid.dataset?.manualFocalX ? parseFloat(activeVid.dataset.manualFocalX) : 0.5;
        let drawW = W;
        let drawH = viewH;
        let offsetX = -drawW / 2;
        let offsetY = -drawH / 2;

        if (vAspect > targetAspect) {
          drawH = viewH;
          drawW = viewH * vAspect;
          const maxOverflowX = drawW - W;
          offsetX = -drawW / 2 + (0.5 - focalX) * maxOverflowX;
        } else {
          drawW = W;
          drawH = W / vAspect;
        }

        ctx.drawImage(activeVid, offsetX, offsetY, drawW, drawH);
        ctx.restore();
      }

      // pre-drop atmospheric dim
      if (!isPostDrop) {
        const dimRatio = 0.45 - (time / Math.max(1, dropTime)) * 0.15;
        ctx.fillStyle = `rgba(10, 14, 22, ${dimRatio.toFixed(3)})`;
        ctx.fillRect(0, viewY, W, viewH);
      }

      const vigGrad = ctx.createRadialGradient(
        W / 2,
        viewY + viewH / 2,
        viewH * 0.35,
        W / 2,
        viewY + viewH / 2,
        viewH * 0.85
      );
      vigGrad.addColorStop(0, 'rgba(0,0,0,0)');
      vigGrad.addColorStop(1, 'rgba(0,0,0,0.65)');
      ctx.fillStyle = vigGrad;
      ctx.fillRect(0, viewY, W, viewH);

      ctx.save();
      this.particles.forEach((p) => {
        p.y += p.vy * 0.016;
        p.x += p.vx * 0.016;
        if (p.y < viewY) p.y = viewY + viewH;
        if (p.x < 0) p.x = W;
        if (p.x > W) p.x = 0;

        const pAlpha = p.alpha * (0.8 + 0.2 * Math.sin(time * 2 + p.phase));
        ctx.fillStyle = `rgba(255, 255, 255, ${pAlpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();

      if (this.params.filmGrain > 0.05) {
        this.renderFilmGrain(ctx, 0, viewY, W, viewH, this.params.filmGrain);
      }

      if (isPostDrop && dSinceDrop < 0.25) {
        const flashAlpha = (1 - dSinceDrop / 0.25) * 0.75;
        ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha.toFixed(3)})`;
        ctx.fillRect(0, viewY, W, viewH);
      }

      ctx.restore();

      this.renderTypography(ctx, time, isPostDrop, dSinceDrop, viewY, viewH, W, H);
      this.renderLetterboxes(ctx, time, viewY, viewH, lbH, W, H, isPostDrop);

      ctx.restore();
    }

    renderTypography(ctx, time, isPostDrop, dSinceDrop, viewY, viewH, W, H) {
      const proj = this.project || {};
      const title = (proj.title || 'untitled').toUpperCase();
      const num = proj.sampleNumber ? String(proj.sampleNumber).replace(/^#?\s*0*/, '').padStart(2, '0') : '';
      const bpm = proj.bpm || 120;
      const key = (proj.key || '').toUpperCase();
      const brand = (proj.brand || '').toUpperCase();
      const accent = this.params.accentColor || '#38bdf8';

      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      if (!isPostDrop) {
        const centerY = viewY + viewH * 0.58;

        ctx.font = '500 24px "IBM Plex Mono", monospace';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
        ctx.letterSpacing = '6px';
        ctx.fillText(`SAMPLE · #${num}`, W / 2, centerY - 80);

        ctx.font = '700 82px "Space Grotesk", sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.letterSpacing = '4px';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
        ctx.shadowBlur = 18;
        ctx.fillText(title, W / 2, centerY);

        ctx.font = '400 22px "Space Grotesk", sans-serif';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
        ctx.letterSpacing = '5px';
        ctx.shadowBlur = 10;
        ctx.fillText('メドウズ · ORIGINAL SAMPLE MASTER', W / 2, centerY + 65);

        const tagY = centerY + 130;
        const tagText = `${key} · ${bpm} BPM`;
        ctx.font = '600 24px "IBM Plex Mono", monospace';
        ctx.letterSpacing = '3px';
        const tagW = ctx.measureText(tagText).width + 48;
        const tagH = 44;

        ctx.fillStyle = 'rgba(12, 16, 24, 0.82)';
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        this.drawRoundedRect(ctx, W / 2 - tagW / 2, tagY - tagH / 2, tagW, tagH, 8);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.fillText(tagText, W / 2, tagY);

        this.renderReactiveWaveform(ctx, W / 2 - 200, tagY + 50, 400, 36, time, accent);
      } else {
        const postAlpha = Math.min(1, dSinceDrop / 0.5);
        ctx.globalAlpha = postAlpha;

        const lowerY = viewY + viewH - 60;
        ctx.textAlign = 'left';

        ctx.fillStyle = 'rgba(8, 12, 18, 0.78)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        this.drawRoundedRect(ctx, 48, lowerY - 32, 420, 64, 8);
        ctx.fill();
        ctx.stroke();

        ctx.font = '700 28px "Space Grotesk", sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.letterSpacing = '2px';
        ctx.fillText(title, 72, lowerY - 6);

        ctx.font = '500 18px "IBM Plex Mono", monospace';
        ctx.fillStyle = accent;
        ctx.letterSpacing = '1px';
        ctx.fillText(`#${num} · ${key} · ${bpm}BPM`, 72, lowerY + 18);
      }

      ctx.restore();
    }

    renderLetterboxes(ctx, time, viewY, viewH, lbH, W, H, isPostDrop) {
      const proj = this.project || {};
      const num = proj.sampleNumber ? String(proj.sampleNumber).replace(/^#?\s*0*/, '').padStart(2, '0') : '';
      const brand = (proj.brand || '').toUpperCase();
      const dur = proj.duration || 30.0;
      const bpm = proj.bpm || 120;
      const accent = this.params.accentColor || '#38bdf8';

      ctx.save();

      ctx.fillStyle = '#080a0e';
      ctx.fillRect(0, 0, W, lbH);
      ctx.fillRect(0, H - lbH, W, lbH);

      // hairline borders between viewport and letterboxes
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, lbH);
      ctx.lineTo(W, lbH);
      ctx.moveTo(0, H - lbH);
      ctx.lineTo(W, H - lbH);
      ctx.stroke();

      // top hud telemetry
      ctx.textBaseline = 'middle';
      const topContentY = lbH / 2;

      ctx.textAlign = 'left';
      ctx.fillStyle = accent;
      ctx.fillRect(48, topContentY - 8, 4, 16);

      ctx.font = '600 18px "IBM Plex Mono", monospace';
      ctx.letterSpacing = '2px';
      ctx.fillStyle = '#ffffff';
      ctx.fillText('35MM', 64, topContentY);

      ctx.font = '400 18px "IBM Plex Mono", monospace';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.fillText('· 24.0 FPS · SHUTTER 1/48', 124, topContentY);

      ctx.textAlign = 'right';
      ctx.font = '600 20px "IBM Plex Mono", monospace';
      ctx.fillStyle = '#ffffff';
      ctx.letterSpacing = '2px';
      ctx.fillText(`[ #${num} · ${brand} ]`, W - 48, topContentY);

      // bottom hud telemetry
      const botContentY = H - lbH / 2;

      this.renderLetterboxAudioSpectrum(ctx, 0, H - lbH - 12, W, 12, time, accent);

      ctx.textAlign = 'left';
      ctx.font = '500 20px "IBM Plex Mono", monospace';
      ctx.letterSpacing = '2px';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      const curSecStr = time.toFixed(2).padStart(5, '0');
      const durSecStr = dur.toFixed(2).padStart(5, '0');
      const secPerBar = (60 / bpm) * 4;
      const curBar = Math.floor(time / secPerBar) + 1;
      ctx.fillText(`TC 00:${curSecStr} / 00:${durSecStr} [BAR ${curBar}]`, 48, botContentY);

      ctx.textAlign = 'right';
      ctx.font = '500 18px "IBM Plex Mono", monospace';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.letterSpacing = '3px';
      ctx.fillText('AESTTC SOUNDS · TOKYO STUDIO', W - 48, botContentY);

      ctx.restore();
    }

    renderLetterboxAudioSpectrum(ctx, x, y, width, height, time, accent) {
      const bars = 64;
      const barW = width / bars;
      const peaks = this.project?.peaks || [];
      const dur = this.project?.duration || 29.09;
      const curRatio = Math.max(0, Math.min(1, time / dur));
      const peakIdx = Math.floor(curRatio * peaks.length);
      const curEnergy = peaks[peakIdx] || 0.4;

      ctx.save();
      for (let i = 0; i < bars; i++) {
        // mirrored spectrum frequency curve
        const freqNorm = 1 - Math.abs((i / bars) - 0.5) * 2;
        const wave = Math.sin(time * 12 + i * 0.35) * 0.3 + 0.7;
        const h = Math.max(2, freqNorm * curEnergy * wave * height);
        const bx = x + i * barW;
        const by = y + (height - h);

        ctx.fillStyle = i % 2 === 0 ? accent : 'rgba(255, 255, 255, 0.45)';
        ctx.fillRect(bx, by, barW - 1, h);
      }
      ctx.restore();
    }

    renderReactiveWaveform(ctx, x, y, width, height, time, accent) {
      const peaks = this.project?.peaks || [];
      const dur = this.project?.duration || 29.09;
      const curRatio = Math.max(0, Math.min(1, time / dur));
      const peakIdx = Math.floor(curRatio * peaks.length);
      const curEnergy = peaks[peakIdx] || 0.35;

      ctx.save();
      if (this.params.waveformStyle === 'bars') {
        const count = 32;
        const bw = width / count;
        for (let i = 0; i < count; i++) {
          const ratio = i / count;
          const curve = Math.sin(ratio * Math.PI);
          const bounce = Math.sin(time * 10 + i * 0.4) * 0.25 + 0.75;
          const bh = Math.max(4, curve * curEnergy * bounce * height);
          ctx.fillStyle = ratio < curRatio ? accent : 'rgba(255, 255, 255, 0.35)';
          ctx.fillRect(x + i * bw, y + (height - bh) / 2, bw - 3, bh);
        }
      } else {
        // oscilloscope wave
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        for (let i = 0; i < width; i += 4) {
          const ratio = i / width;
          const amp = curEnergy * height * 0.45;
          const py = y + height / 2 + Math.sin(time * 14 + ratio * 18) * amp;
          if (i === 0) ctx.moveTo(x + i, py);
          else ctx.lineTo(x + i, py);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    renderFilmGrain(ctx, x, y, w, h, intensity) {
      // procedural grain points
      ctx.save();
      const dotCount = Math.floor(w * h * 0.00035 * intensity);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      for (let i = 0; i < dotCount; i++) {
        const gx = x + Math.random() * w;
        const gy = y + Math.random() * h;
        ctx.fillRect(gx, gy, 1.5, 1.5);
      }
      ctx.restore();
    }

    drawRoundedRect(ctx, x, y, width, height, radius) {
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + width - radius, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
      ctx.lineTo(x + width, y + height - radius);
      ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
      ctx.lineTo(x + radius, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
    }

    cleanup() {
      this.particles = [];
    }

    renderControls(container, onChange) {
      const p = this.params;
      const lbH = p.letterboxHeight || 200;
      const grainPct = Math.round((p.filmGrain || 0.35) * 100);
      const punchVal = p.cameraPunch || 1.0;
      const accent = p.accentColor || '#38bdf8';
      const waveStyle = p.waveformStyle || 'bars';

      container.innerHTML = `
        <div class="slider-group">
          <div class="slider-row">
            <label for="sliderLetterbox">Letterbox Height</label>
            <span class="slider-val" id="valLetterbox">${lbH}px</span>
          </div>
          <input type="range" id="sliderLetterbox" min="80" max="320" step="10" value="${lbH}" />

          <div class="slider-row">
            <label for="sliderFilmGrain">35mm Film Grain</label>
            <span class="slider-val" id="valFilmGrain">${grainPct}%</span>
          </div>
          <input type="range" id="sliderFilmGrain" min="0" max="100" step="5" value="${grainPct}" />

          <div class="slider-row">
            <label for="sliderPunch">Camera Punch</label>
            <span class="slider-val" id="valPunch">${punchVal.toFixed(1)}x</span>
          </div>
          <input type="range" id="sliderPunch" min="0.2" max="2.5" step="0.1" value="${punchVal}" />

          <div class="slider-row" style="margin-top: 10px;">
            <label>Waveform Style</label>
          </div>
          <div class="segmented-control" role="radiogroup" style="margin-bottom: 12px;">
            <button type="button" class="seg-btn ${waveStyle === 'bars' ? 'active' : ''}" data-style="bars" id="wfStyleBars">Spectrum Bars</button>
            <button type="button" class="seg-btn ${waveStyle === 'wave' ? 'active' : ''}" data-style="wave" id="wfStyleWave">Oscilloscope</button>
          </div>

          <div class="slider-row">
            <label>HUD Accent</label>
            <span class="slider-val" id="valAccent">${accent}</span>
          </div>
          <div class="color-palette-row" style="display: flex; gap: 8px; margin-top: 6px;">
            <button type="button" class="btn-color-swatch ${accent === '#38bdf8' ? 'active' : ''}" data-color="#38bdf8" style="background:#38bdf8; width:28px; height:28px; border-radius:6px; border:2px solid ${accent === '#38bdf8' ? '#fff' : 'transparent'}; cursor:pointer;" title="Ice Cyan"></button>
            <button type="button" class="btn-color-swatch ${accent === '#f59e0b' ? 'active' : ''}" data-color="#f59e0b" style="background:#f59e0b; width:28px; height:28px; border-radius:6px; border:2px solid ${accent === '#f59e0b' ? '#fff' : 'transparent'}; cursor:pointer;" title="Amber"></button>
            <button type="button" class="btn-color-swatch ${accent === '#fb7185' ? 'active' : ''}" data-color="#fb7185" style="background:#fb7185; width:28px; height:28px; border-radius:6px; border:2px solid ${accent === '#fb7185' ? '#fff' : 'transparent'}; cursor:pointer;" title="Rose"></button>
            <button type="button" class="btn-color-swatch ${accent === '#ffffff' ? 'active' : ''}" data-color="#ffffff" style="background:#ffffff; width:28px; height:28px; border-radius:6px; border:2px solid ${accent === '#ffffff' ? '#38bdf8' : 'transparent'}; cursor:pointer;" title="White"></button>
          </div>
        </div>
      `;

      const sliderLb = container.querySelector('#sliderLetterbox');
      const valLb = container.querySelector('#valLetterbox');
      sliderLb.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        valLb.textContent = `${v}px`;
        this.params.letterboxHeight = v;
        onChange('letterboxHeight', v);
      });

      const sliderGrain = container.querySelector('#sliderFilmGrain');
      const valGrain = container.querySelector('#valFilmGrain');
      sliderGrain.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        valGrain.textContent = `${v}%`;
        this.params.filmGrain = v / 100;
        onChange('filmGrain', v / 100);
      });

      const sliderPunch = container.querySelector('#sliderPunch');
      const valPunch = container.querySelector('#valPunch');
      sliderPunch.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        valPunch.textContent = `${v.toFixed(1)}x`;
        this.params.cameraPunch = v;
        onChange('cameraPunch', v);
      });

      const btnBars = container.querySelector('#wfStyleBars');
      const btnWave = container.querySelector('#wfStyleWave');
      btnBars.addEventListener('click', () => {
        btnBars.classList.add('active');
        btnWave.classList.remove('active');
        this.params.waveformStyle = 'bars';
        onChange('waveformStyle', 'bars');
      });
      btnWave.addEventListener('click', () => {
        btnWave.classList.add('active');
        btnBars.classList.remove('active');
        this.params.waveformStyle = 'wave';
        onChange('waveformStyle', 'wave');
      });

      const swatches = container.querySelectorAll('.btn-color-swatch');
      swatches.forEach((sw) => {
        sw.addEventListener('click', () => {
          swatches.forEach((s) => (s.style.borderColor = 'transparent'));
          sw.style.borderColor = '#ffffff';
          const color = sw.getAttribute('data-color');
          this.params.accentColor = color;
          container.querySelector('#valAccent').textContent = color;
          onChange('accentColor', color);
        });
      });
    }
  }

  window.templateRegistry.register(new CinematicMinimalTemplate());
})();

