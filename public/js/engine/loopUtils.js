// shared loop turnaround timing and per-track midi pattern expansion
(function () {
  'use strict';

  function getLoopTransitionInfo(t, project, params) {
    const dur = Math.max(0.001, Number(project?.duration) || 30.0);
    const phase = Math.max(0, Math.min(1, (Number(t) || 0) / dur));
    const loopStyle = (params && params.loopStyle === 'fade') ? 'fade' : 'datamosh';
    if (params && params.seamlessLoop === false) {
      return {
        inTransition: false,
        progress: 0,
        easeProgress: 0,
        loopFade: 1.0,
        clipFade: 1.0,
        loopWin: 0.85,
        loopStyle,
        phase
      };
    }

    const bpm = parseFloat(project?.bpm) || 120;
    const secPerBeat = 60 / bpm;
    const loopWin = (params && params.loopTransitionDuration) || Math.max(0.75, Math.min(1.2, secPerBeat * 2));

    if (dur <= loopWin * 2.2) {
      return {
        inTransition: false,
        progress: 0,
        easeProgress: 0,
        loopFade: 1.0,
        clipFade: 1.0,
        loopWin,
        loopStyle,
        phase
      };
    }

    if (t > dur - loopWin) {
      const p = Math.max(0, Math.min(1.0, (t - (dur - loopWin)) / loopWin));
      const easeP = p * p * (3 - 2 * p);
      const loopFade = Math.max(0, 1.0 - easeP);
      const clipProg = Math.min(1.0, p / 0.70);
      const clipEase = clipProg * clipProg * (3 - 2 * clipProg);
      const clipFade = Math.max(0, 1.0 - clipEase);
      return {
        inTransition: true,
        progress: p,
        easeProgress: easeP,
        loopFade,
        clipFade,
        loopWin,
        loopStyle,
        phase
      };
    }

    return {
      inTransition: false,
      progress: 0,
      easeProgress: 0,
      loopFade: 1.0,
      clipFade: 1.0,
      loopWin,
      loopStyle,
      phase
    };
  }

  function getTrackSpanInfo(track, project) {
    const notes = Array.isArray(track?.notes) ? track.notes : [];
    const bpm = parseFloat(project?.bpm) || 120;
    const secPerBar = (60 / bpm) * 4;
    const duration = Number(project?.duration) || 29.09;
    const dropTime = (typeof project?.dropTime === 'number' && !Number.isNaN(project.dropTime))
      ? project.dropTime
      : duration * 0.5;
    const totalBars = Math.max(1, Math.round(duration / secPerBar));

    if (notes.length === 0) {
      return {
        canLoop: false,
        defaultLoopEnabled: false,
        minTime: 0,
        maxTime: 0,
        spanBars: 0,
        spanSec: 0,
        totalBars,
        duration,
        bpm,
        secPerBar
      };
    }

    let minTime = Infinity;
    let maxTime = 0;
    for (const n of notes) {
      const t = Number(n.time) || 0;
      if (t < minTime) minTime = t;
      if (t > maxTime) maxTime = t;
    }
    if (!Number.isFinite(minTime)) minTime = 0;

    const phraseStartSec = Math.max(0, Math.floor((minTime + 0.05) / secPerBar) * secPerBar);
    const spanBars = Math.max(1, Math.ceil((maxTime - phraseStartSec - 0.05) / secPerBar));
    const spanSec = spanBars * secPerBar;

    const endsEarly = (typeof track.endBar === 'number' && track.endBar > 0)
      ? track.endBar < totalBars
      : (phraseStartSec + spanSec < duration - secPerBar * 0.35);

    const canLoop = Boolean(endsEarly && (minTime + spanSec + 0.05 < duration));
    const endsAtOrBeforeDrop = maxTime <= dropTime + 0.15 && dropTime > 2 && duration > dropTime + 2;
    const defaultLoopEnabled = canLoop && endsAtOrBeforeDrop;

    return {
      canLoop,
      defaultLoopEnabled,
      minTime,
      maxTime,
      spanBars,
      spanSec,
      totalBars,
      duration,
      bpm,
      secPerBar
    };
  }

  function isTrackLoopEnabled(track, project) {
    const info = getTrackSpanInfo(track, project);
    if (!info.canLoop) return false;
    if (typeof track?.loopMidi === 'boolean') return track.loopMidi;
    return info.defaultLoopEnabled;
  }

  function expandTrackNotes(tracks, selectedIds, project, mapNoteFn) {
    const expanded = [];
    if (!Array.isArray(tracks)) return expanded;

    for (let trIdx = 0; trIdx < tracks.length; trIdx++) {
      const tr = tracks[trIdx];
      if (!tr || !selectedIds || !selectedIds.has(tr.id)) continue;
      const trackNotes = Array.isArray(tr.notes) ? tr.notes : [];
      if (trackNotes.length === 0) continue;

      const buildEntry = mapNoteFn || ((n, track, trackIndex, shiftedTime, shiftedBeat, mirrored) => ({
        ...n,
        time: shiftedTime,
        startTime: shiftedTime,
        beat: shiftedBeat,
        trackId: track.id,
        trackIndex,
        trackName: track.name,
        mirrored
      }));

      for (const n of trackNotes) {
        const baseTime = Number(n.time) || 0;
        const baseBeat = Number(n.beat) || 0;
        expanded.push(buildEntry(n, tr, trIdx, baseTime, baseBeat, false));
      }

      if (isTrackLoopEnabled(tr, project)) {
        const info = getTrackSpanInfo(tr, project);
        const spanBeats = (info.spanSec * info.bpm) / 60;
        for (let cycle = 1; cycle < 32; cycle++) {
          const offsetSec = cycle * info.spanSec;
          if (info.minTime + offsetSec + 0.05 >= info.duration) break;
          for (const n of trackNotes) {
            const shiftedTime = Number(((Number(n.time) || 0) + offsetSec).toFixed(4));
            if (shiftedTime + 0.05 < info.duration) {
              const shiftedBeat = Number(((Number(n.beat) || 0) + cycle * spanBeats).toFixed(4));
              expanded.push(buildEntry(n, tr, trIdx, shiftedTime, shiftedBeat, true));
            }
          }
        }
      }
    }

    expanded.sort((a, b) => (a.time ?? a.startTime ?? 0) - (b.time ?? b.startTime ?? 0) || (a.midi ?? a.pitch ?? 0) - (b.midi ?? b.pitch ?? 0));
    return expanded;
  }

  function extractLuma(flowCtx, sourceCanvas, fw, fh) {
    flowCtx.drawImage(sourceCanvas, 0, 0, fw, fh);
    const data = flowCtx.getImageData(0, 0, fw, fh).data;
    const luma = new Uint8Array(fw * fh);
    for (let i = 0, j = 0; i < luma.length; i++, j += 4) {
      luma[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
    }
    return luma;
  }

  // fast diamond-search block matching on downsampled luma, followed by spatial smoothing
  function estimateBlockMotion(srcLuma, refLuma, fw, fh, cellSize, cols, rows, vxSmooth, vySmooth) {
    const dirs = [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    const fine = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
    const rawVx = new Float32Array(cols * rows);
    const rawVy = new Float32Array(cols * rows);

    for (let br = 0; br < rows; br++) {
      const y0 = br * cellSize;
      const bh = Math.min(cellSize, fh - y0);
      for (let bc = 0; bc < cols; bc++) {
        const x0 = bc * cellSize;
        const bw = Math.min(cellSize, fw - x0);
        const idx = br * cols + bc;

        let bestDx = 0;
        let bestDy = 0;
        let bestSad = 1e9;

        for (let d = 0; d < dirs.length; d++) {
          const dx = dirs[d][0];
          const dy = dirs[d][1];
          if (x0 + dx < 0 || x0 + dx + bw > fw || y0 + dy < 0 || y0 + dy + bh > fh) continue;
          let sad = 0;
          for (let y = 0; y < bh; y += 2) {
            const rOff = (y0 + y) * fw + x0;
            const sOff = (y0 + y + dy) * fw + (x0 + dx);
            for (let x = 0; x < bw; x += 2) {
              const diff = refLuma[rOff + x] - srcLuma[sOff + x];
              sad += diff < 0 ? -diff : diff;
            }
          }
          if (sad < bestSad) {
            bestSad = sad;
            bestDx = dx;
            bestDy = dy;
          }
        }

        let fDx = bestDx;
        let fDy = bestDy;
        for (let d = 1; d < fine.length; d++) {
          const dx = bestDx + fine[d][0];
          const dy = bestDy + fine[d][1];
          if (x0 + dx < 0 || x0 + dx + bw > fw || y0 + dy < 0 || y0 + dy + bh > fh) continue;
          let sad = 0;
          for (let y = 0; y < bh; y += 2) {
            const rOff = (y0 + y) * fw + x0;
            const sOff = (y0 + y + dy) * fw + (x0 + dx);
            for (let x = 0; x < bw; x += 2) {
              const diff = refLuma[rOff + x] - srcLuma[sOff + x];
              sad += diff < 0 ? -diff : diff;
            }
          }
          if (sad < bestSad) {
            bestSad = sad;
            fDx = dx;
            fDy = dy;
          }
        }

        if (bestSad >= 18) {
          rawVx[idx] = fDx;
          rawVy[idx] = fDy;
        }
      }
    }

    // 3x3 weighted spatial smoothing so moving shapes drag coherently without block seams
    for (let br = 0; br < rows; br++) {
      for (let bc = 0; bc < cols; bc++) {
        let sumX = 0;
        let sumY = 0;
        let wSum = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const nr = br + oy;
          if (nr < 0 || nr >= rows) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const nc = bc + ox;
            if (nc < 0 || nc >= cols) continue;
            const w = (ox === 0 && oy === 0) ? 4 : ((ox === 0 || oy === 0) ? 2 : 1);
            const nIdx = nr * cols + nc;
            sumX += rawVx[nIdx] * w;
            sumY += rawVy[nIdx] * w;
            wSum += w;
          }
        }
        const idx = br * cols + bc;
        vxSmooth[idx] = sumX / wSum;
        vySmooth[idx] = sumY / wSum;
      }
    }
  }

  function advectDatamoshPixels(moshPixels, prevPixels, tgtPixels, vx, vy, mw, mh, fw, fh, cols, rows, p) {
    const gxScale = (cols - 1) / Math.max(1, mw - 1);
    const gyScale = (rows - 1) / Math.max(1, mh - 1);
    const mvToPxX = (mw / fw) * 1.85;
    const mvToPxY = (mh / fh) * 1.85;
    const bleedPhase = Math.max(0, (p - 0.34) / 0.60);

    for (let y = 0; y < mh; y++) {
      const gy = y * gyScale;
      const r0 = gy | 0;
      const r1 = r0 + 1 < rows ? r0 + 1 : r0;
      const fy = gy - r0;
      const rowOff0 = r0 * cols;
      const rowOff1 = r1 * cols;
      const yOff = y * mw;

      for (let x = 0; x < mw; x++) {
        const gx = x * gxScale;
        const c0 = gx | 0;
        const c1 = c0 + 1 < cols ? c0 + 1 : c0;
        const fx = gx - c0;

        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;

        const mvx = (vx[rowOff0 + c0] * w00 + vx[rowOff0 + c1] * w10 + vx[rowOff1 + c0] * w01 + vx[rowOff1 + c1] * w11) * mvToPxX;
        const mvy = (vy[rowOff0 + c0] * w00 + vy[rowOff0 + c1] * w10 + vy[rowOff1 + c0] * w01 + vy[rowOff1 + c1] * w11) * mvToPxY;

        const pIdx = (yOff + x) * 4;
        const hasMotion = (mvx < -0.18 || mvx > 0.18 || mvy < -0.18 || mvy > 0.18);

        if (hasMotion) {
          let sx = x - mvx;
          let sy = y - mvy;
          if (sx < 0) sx = 0;
          else if (sx > mw - 1.001) sx = mw - 1.001;
          if (sy < 0) sy = 0;
          else if (sy > mh - 1.001) sy = mh - 1.001;

          const sx0 = sx | 0;
          const sy0 = sy | 0;
          const sfx = sx - sx0;
          const sfy = sy - sy0;
          const sw00 = (1 - sfx) * (1 - sfy);
          const sw10 = sfx * (1 - sfy);
          const sw01 = (1 - sfx) * sfy;
          const sw11 = sfx * sfy;

          const i00 = (sy0 * mw + sx0) * 4;
          const i10 = i00 + 4;
          const i01 = i00 + mw * 4;
          const i11 = i01 + 4;

          moshPixels[pIdx] = prevPixels[i00] * sw00 + prevPixels[i10] * sw10 + prevPixels[i01] * sw01 + prevPixels[i11] * sw11;
          moshPixels[pIdx + 1] = prevPixels[i00 + 1] * sw00 + prevPixels[i10 + 1] * sw10 + prevPixels[i01 + 1] * sw01 + prevPixels[i11 + 1] * sw11;
          moshPixels[pIdx + 2] = prevPixels[i00 + 2] * sw00 + prevPixels[i10 + 2] * sw10 + prevPixels[i01 + 2] * sw01 + prevPixels[i11 + 2] * sw11;
        }

        // difference-driven residual bleed: changed/high-contrast edges emerge first, static background stays untouched
        if (bleedPhase > 0) {
          const dr = tgtPixels[pIdx] - moshPixels[pIdx];
          const dg = tgtPixels[pIdx + 1] - moshPixels[pIdx + 1];
          const db = tgtPixels[pIdx + 2] - moshPixels[pIdx + 2];
          const diffMag = ((dr < 0 ? -dr : dr) + (dg < 0 ? -dg : dg) + (db < 0 ? -db : db)) / 765;
          if (diffMag > 0.14 || hasMotion) {
            const alpha = Math.min(1, bleedPhase * (hasMotion ? 0.35 : 0.18 + diffMag * 0.45));
            moshPixels[pIdx] += dr * alpha;
            moshPixels[pIdx + 1] += dg * alpha;
            moshPixels[pIdx + 2] += db * alpha;
          }
        }
      }
    }
  }

  function _blockSad(srcLuma, refLuma, fw, x0, y0, bw, bh, dx, dy) {
    let sad = 0;
    for (let y = 0; y < bh; y++) {
      const rOff = (y0 + y) * fw + x0;
      const sOff = (y0 + y + dy) * fw + (x0 + dx);
      for (let x = 0; x < bw; x++) {
        const diff = srcLuma[rOff + x] - refLuma[sOff + x];
        sad += diff < 0 ? -diff : diff;
      }
    }
    return sad;
  }

  // rigid macroblock P-frame motion estimator (unsmoothed blocks, compares best match against (0,0) SAD)
  function estimateCodecMotion(srcLuma, refLuma, fw, fh, cellSize, cols, rows, vxOut, vyOut, blockErrOut) {
    const coarse = [
      [0, 0], [2, 0], [-2, 0], [0, 2], [0, -2],
      [2, 2], [-2, 2], [2, -2], [-2, -2],
      [4, 0], [-4, 0], [0, 4], [0, -4],
      [4, 2], [-4, 2], [4, -2], [-4, -2]
    ];
    const fine = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
    let activeBlocks = 0;

    for (let br = 0; br < rows; br++) {
      const y0 = br * cellSize;
      const bh = Math.min(cellSize, fh - y0);
      for (let bc = 0; bc < cols; bc++) {
        const x0 = bc * cellSize;
        const bw = Math.min(cellSize, fw - x0);
        const area = Math.max(1, bw * bh);
        const idx = br * cols + bc;
        const sad0 = _blockSad(srcLuma, refLuma, fw, x0, y0, bw, bh, 0, 0);

        let bestDx = 0;
        let bestDy = 0;
        let bestSad = sad0;

        for (let d = 1; d < coarse.length; d++) {
          const dx = coarse[d][0];
          const dy = coarse[d][1];
          if (x0 + dx < 0 || x0 + dx + bw > fw || y0 + dy < 0 || y0 + dy + bh > fh) continue;
          const sad = _blockSad(srcLuma, refLuma, fw, x0, y0, bw, bh, dx, dy);
          if (sad < bestSad) {
            bestSad = sad;
            bestDx = dx;
            bestDy = dy;
          }
        }

        let fDx = bestDx;
        let fDy = bestDy;
        for (let d = 1; d < fine.length; d++) {
          const dx = bestDx + fine[d][0];
          const dy = bestDy + fine[d][1];
          if (x0 + dx < 0 || x0 + dx + bw > fw || y0 + dy < 0 || y0 + dy + bh > fh) continue;
          const sad = _blockSad(srcLuma, refLuma, fw, x0, y0, bw, bh, dx, dy);
          if (sad < bestSad) {
            bestSad = sad;
            fDx = dx;
            fDy = dy;
          }
        }

        const noiseFloor = area * 4.5;
        if (sad0 > noiseFloor && bestSad < sad0 * 0.88) {
          vxOut[idx] = fDx;
          vyOut[idx] = fDy;
          activeBlocks++;
        } else {
          vxOut[idx] = 0;
          vyOut[idx] = 0;
        }
        if (blockErrOut) {
          blockErrOut[idx] = Math.min(1, sad0 / (area * 48));
        }
      }
    }
    return activeBlocks;
  }

  function _codecHash(n) {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return s - Math.floor(s);
  }

  // discrete nearest-neighbor macroblock P-frame advection + Y/chroma split + I-block refresh
  function advectCodecDatamosh(moshPixels, prevPixels, tgtPixels, vx, vy, blockErr, mw, mh, fw, fh, cols, rows, p, cutIndex = 0) {
    const mvToPxX = (mw / Math.max(1, fw)) * 2.15;
    const mvToPxY = (mh / Math.max(1, fh)) * 2.15;
    const bleed = Math.max(0, Math.min(1, (p - 0.16) / 0.74));
    const maxY = mh - 1;
    const maxX = mw - 1;

    for (let br = 0; br < rows; br++) {
      const py0 = Math.floor((br * mh) / rows);
      const py1 = Math.floor(((br + 1) * mh) / rows);
      for (let bc = 0; bc < cols; bc++) {
        const px0 = Math.floor((bc * mw) / cols);
        const px1 = Math.floor(((bc + 1) * mw) / cols);
        const idx = br * cols + bc;

        let mvx = Math.round(vx[idx] * mvToPxX);
        let mvy = Math.round(vy[idx] * mvToPxY);
        const err = blockErr ? blockErr[idx] : 0;
        const hb = _codecHash(br * 37.3 + bc * 91.7 + cutIndex * 13.7);

        // inject occasional horizontal bitstream macroblock slip when error is high on static patches
        if (mvx === 0 && mvy === 0 && err > 0.38 && hb > 0.62 && p > 0.08 && p < 0.72) {
          mvx = hb > 0.81 ? 6 : -6;
        }

        const popScore = bleed * 1.16 + err * 0.34 + (hb - 0.5) * 0.42;
        if (popScore >= 1.0) {
          // hard intra-coded macroblock refresh from live target frame
          for (let y = py0; y < py1; y++) {
            const rowBase = y * mw * 4;
            for (let x = px0; x < px1; x++) {
              const i = rowBase + x * 4;
              moshPixels[i] = tgtPixels[i];
              moshPixels[i + 1] = tgtPixels[i + 1];
              moshPixels[i + 2] = tgtPixels[i + 2];
              moshPixels[i + 3] = tgtPixels[i + 3];
            }
          }
          continue;
        }

        const chromaCorruption = popScore >= 0.72 && bleed > 0.12;
        const hasShift = mvx !== 0 || mvy !== 0;

        for (let y = py0; y < py1; y++) {
          let sy = y - mvy;
          if (sy < 0) sy = 0;
          else if (sy > maxY) sy = maxY;
          const outRow = y * mw * 4;
          const srcRow = sy * mw * 4;

          for (let x = px0; x < px1; x++) {
            const outIdx = outRow + x * 4;
            let srcIdx = outIdx;
            if (hasShift) {
              let sx = x - mvx;
              if (sx < 0) sx = 0;
              else if (sx > maxX) sx = maxX;
              srcIdx = srcRow + sx * 4;
            }
            const r0 = prevPixels[srcIdx];
            const g0 = prevPixels[srcIdx + 1];
            const b0 = prevPixels[srcIdx + 2];

            if (chromaCorruption) {
              // bleed live luma residual onto frozen/advected macroblock chroma
              const lPrev = (r0 * 77 + g0 * 150 + b0 * 29) >> 8;
              const lTgt = (tgtPixels[outIdx] * 77 + tgtPixels[outIdx + 1] * 150 + tgtPixels[outIdx + 2] * 29) >> 8;
              const dl = (lTgt - lPrev) * 0.72;
              const nr = r0 + dl;
              const ng = g0 + dl;
              const nb = b0 + dl;
              moshPixels[outIdx] = nr < 0 ? 0 : nr > 255 ? 255 : nr;
              moshPixels[outIdx + 1] = ng < 0 ? 0 : ng > 255 ? 255 : ng;
              moshPixels[outIdx + 2] = nb < 0 ? 0 : nb > 255 ? 255 : nb;
            } else if (hasShift) {
              moshPixels[outIdx] = r0;
              moshPixels[outIdx + 1] = g0;
              moshPixels[outIdx + 2] = b0;
            }
          }
        }
      }
    }
  }

  class SeamlessLoopCache {
    constructor() {
      this.canvas = null;
      this.ctx = null;
      this.moshCanvas = null;
      this.moshCtx = null;
      this.moshData = null;
      this.moshPrevData = null;
      this.targetCanvas = null;
      this.targetCtx = null;
      this.targetData = null;
      this.targetDataKey = '';
      this.outCanvas = null;
      this.outCtx = null;
      this.flowCanvas = null;
      this.flowCtx = null;
      this.prevOutLuma = null;
      this.targetLuma = null;
      this.targetLumaKey = '';
      this.lastMoshProgress = -1;
      this.cacheKey = '';
      this.version = 0;
    }

    invalidate() {
      this.cacheKey = '';
      this.targetLumaKey = '';
      this.targetDataKey = '';
      this.prevOutLuma = null;
      this.targetLuma = null;
      this.targetData = null;
      this.lastMoshProgress = -1;
      this.version += 1;
    }

    dispose() {
      for (const c of [this.canvas, this.moshCanvas, this.targetCanvas, this.outCanvas, this.flowCanvas]) {
        if (c) {
          c.width = 0;
          c.height = 0;
        }
      }
      this.canvas = null;
      this.ctx = null;
      this.moshCanvas = null;
      this.moshCtx = null;
      this.moshData = null;
      this.moshPrevData = null;
      this.targetCanvas = null;
      this.targetCtx = null;
      this.targetData = null;
      this.targetDataKey = '';
      this.outCanvas = null;
      this.outCtx = null;
      this.flowCanvas = null;
      this.flowCtx = null;
      this.prevOutLuma = null;
      this.targetLuma = null;
      this.targetLumaKey = '';
      this.lastMoshProgress = -1;
      this.cacheKey = '';
    }

    _ensureCanvas(width, height) {
      if (!this.canvas || this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = width;
        this.canvas.height = height;
        this.ctx = this.canvas.getContext('2d', { alpha: false });
        this.cacheKey = '';
        this.targetLumaKey = '';
        this.targetDataKey = '';
      }
      return this.ctx;
    }

    _ensureMoshBuffers(mw, mh, fw, fh) {
      if (!this.moshCanvas || this.moshCanvas.width !== mw || this.moshCanvas.height !== mh) {
        this.moshCanvas = document.createElement('canvas');
        this.moshCanvas.width = mw;
        this.moshCanvas.height = mh;
        this.moshCtx = this.moshCanvas.getContext('2d', { willReadFrequently: true });
        this.moshData = this.moshCtx.createImageData(mw, mh);
        this.moshPrevData = new Uint8ClampedArray(mw * mh * 4);
        this.lastMoshProgress = -1;
      }
      if (!this.targetCanvas || this.targetCanvas.width !== mw || this.targetCanvas.height !== mh) {
        this.targetCanvas = document.createElement('canvas');
        this.targetCanvas.width = mw;
        this.targetCanvas.height = mh;
        this.targetCtx = this.targetCanvas.getContext('2d', { willReadFrequently: true });
        this.targetData = null;
        this.targetDataKey = '';
      }
      if (!this.outCanvas || this.outCanvas.width !== mw || this.outCanvas.height !== mh) {
        this.outCanvas = document.createElement('canvas');
        this.outCanvas.width = mw;
        this.outCanvas.height = mh;
        this.outCtx = this.outCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (!this.flowCanvas || this.flowCanvas.width !== fw || this.flowCanvas.height !== fh) {
        this.flowCanvas = document.createElement('canvas');
        this.flowCanvas.width = fw;
        this.flowCanvas.height = fh;
        this.flowCtx = this.flowCanvas.getContext('2d', { willReadFrequently: true });
        this.prevOutLuma = null;
        this.targetLuma = null;
        this.targetLumaKey = '';
      }
    }

    _extractLuma(sourceCanvas, fw, fh) {
      return extractLuma(this.flowCtx, sourceCanvas, fw, fh);
    }

    _estimateBlockMotion(srcLuma, refLuma, fw, fh, cellSize, cols, rows, vxSmooth, vySmooth) {
      estimateBlockMotion(srcLuma, refLuma, fw, fh, cellSize, cols, rows, vxSmooth, vySmooth);
    }

    capture(sourceCanvas, width, height, key) {
      if (!sourceCanvas || this.cacheKey === key) return;
      const lctx = this._ensureCanvas(width, height);
      if (!lctx) return;
      lctx.clearRect(0, 0, width, height);
      lctx.drawImage(sourceCanvas, 0, 0, width, height);
      this.cacheKey = key;
      this.targetLumaKey = '';
      this.targetDataKey = '';
    }

    composite(destCtx, width, height, easeProgress, key, renderZeroFn, options) {
      if (!destCtx || easeProgress <= 0.001) return;
      const lctx = this._ensureCanvas(width, height);
      if (!lctx) return;
      if (this.cacheKey !== key && typeof renderZeroFn === 'function') {
        renderZeroFn(lctx);
        this.cacheKey = key;
        this.targetLumaKey = '';
        this.targetDataKey = '';
      }
      if (this.cacheKey !== key || !this.canvas) return;

      const style = options?.style || 'fade';
      if (style === 'datamosh') {
        const p = typeof options?.progress === 'number' ? options.progress : easeProgress;
        this._compositeDatamosh(destCtx, width, height, p, easeProgress, key);
        return;
      }

      destCtx.save();
      destCtx.globalAlpha = easeProgress;
      destCtx.drawImage(this.canvas, 0, 0, width, height);
      destCtx.restore();
    }

    // per-pixel bilinear motion-vector advection: unchanged pixels stay frozen, moving pixels smear fluidly
    _compositeDatamosh(destCtx, width, height, progress, easeProgress, key) {
      const p = Math.max(0, Math.min(1, progress));
      if (p <= 0.01) {
        this.lastMoshProgress = -1;
        return;
      }
      if (p >= 0.96) {
        destCtx.save();
        destCtx.globalAlpha = 1;
        destCtx.drawImage(this.canvas, 0, 0, width, height);
        destCtx.restore();
        this.lastMoshProgress = p;
        return;
      }

      const scale = Math.min(0.5, 380 / Math.max(1, Math.min(width, height)));
      const mw = Math.max(120, Math.round(width * scale));
      const mh = Math.max(120, Math.round(height * scale));
      const cellSize = 4;
      const cols = 36;
      const fw = cols * cellSize;
      const fh = Math.max(cellSize * 12, Math.round(fw * (height / width) / cellSize) * cellSize);
      const rows = Math.floor(fh / cellSize);

      this._ensureMoshBuffers(mw, mh, fw, fh);
      if (!this.moshCtx || !this.targetCtx || !this.outCtx || !this.flowCtx || !destCtx.canvas) {
        destCtx.save();
        destCtx.globalAlpha = easeProgress;
        destCtx.drawImage(this.canvas, 0, 0, width, height);
        destCtx.restore();
        return;
      }

      if (this.targetLumaKey !== key || !this.targetLuma) {
        this.targetLuma = this._extractLuma(this.canvas, fw, fh);
        this.targetLumaKey = key;
      }
      if (this.targetDataKey !== key || !this.targetData) {
        this.targetCtx.drawImage(this.canvas, 0, 0, mw, mh);
        this.targetData = this.targetCtx.getImageData(0, 0, mw, mh).data;
        this.targetDataKey = key;
      }

      const currOutLuma = this._extractLuma(destCtx.canvas, fw, fh);
      const isFreshStart = this.lastMoshProgress < 0 || p < this.lastMoshProgress - 0.04 || p < 0.05;

      if (isFreshStart) {
        this.outCtx.drawImage(destCtx.canvas, 0, 0, mw, mh);
        const initPixels = this.outCtx.getImageData(0, 0, mw, mh).data;
        this.moshData.data.set(initPixels);
        this.prevOutLuma = currOutLuma;
      }

      const vx = new Float32Array(cols * rows);
      const vy = new Float32Array(cols * rows);
      const refLuma = (this.prevOutLuma && !isFreshStart) ? this.prevOutLuma : this.targetLuma;
      this._estimateBlockMotion(currOutLuma, refLuma, fw, fh, cellSize, cols, rows, vx, vy);

      const moshPixels = this.moshData.data;
      this.moshPrevData.set(moshPixels);
      advectDatamoshPixels(moshPixels, this.moshPrevData, this.targetData, vx, vy, mw, mh, fw, fh, cols, rows, p);

      this.moshCtx.putImageData(this.moshData, 0, 0);

      destCtx.save();
      destCtx.imageSmoothingEnabled = true;
      destCtx.drawImage(this.moshCanvas, 0, 0, width, height);
      if (p > 0.84) {
        const settle = (p - 0.84) / 0.12;
        destCtx.globalAlpha = Math.min(1, settle * settle * (3 - 2 * settle));
        destCtx.drawImage(this.canvas, 0, 0, width, height);
      }
      destCtx.restore();

      this.prevOutLuma = currOutLuma;
      this.lastMoshProgress = p;
    }
  }

  const MARKER_PALETTE = ['#83ca90', '#7aa6c2', '#e2a856', '#9b8ec4', '#e087a1', '#6fc3b2'];

  function getDefaultSections(project) {
    const duration = Math.max(0.1, Number(project?.duration) || 30);
    const bpm = Math.max(40, Math.min(240, parseFloat(project?.bpm) || 120));
    const secPerBar = (60 / bpm) * 4;
    const totalBars = Math.max(1, Math.round(duration / secPerBar));
    return [{
      id: 'main',
      type: 'main',
      label: 'main',
      bar: 1,
      time: 0,
      endBar: totalBars,
      endTime: Number(duration.toFixed(3)),
      duration: Number(duration.toFixed(3)),
      color: '#83ca90',
      energy: 0.7,
      lowEnergy: 0.7,
      source: 'fallback'
    }];
  }

  function resolveTimelineMarkers(presetOrTemplate, project) {
    const modules = presetOrTemplate?.modules || presetOrTemplate?.preset?.modules || {};
    const features = presetOrTemplate?.features || presetOrTemplate?.preset?.features || {};
    const timelineFeat = features.timeline || {};
    const explicitMarkers = timelineFeat.markers;
    const tplId = presetOrTemplate?.id || presetOrTemplate?.preset?.id || '';
    const projectSections = Array.isArray(project?.sections) && project.sections.length > 0
      ? project.sections
      : null;

    let rawMarkers = null;
    if (explicitMarkers === 'sections' || timelineFeat.useDetectedSections === true) {
      if (projectSections) {
        rawMarkers = projectSections
          .filter((s, idx) => idx > 0 || s.time > 0.05)
          .map((s) => ({
            id: s.id,
            label: s.label,
            section: s.id,
            time: s.time,
            bar: s.bar,
            color: s.color
          }));
      } else {
        rawMarkers = [];
      }
    } else if (Array.isArray(explicitMarkers)) {
      if (explicitMarkers.length === 0) return [];
      rawMarkers = explicitMarkers;
    } else if (modules?.dropMarker?.enabled === false) {
      return [];
    } else {
      const legacyNeedsDrop =
        modules?.dropMarker?.enabled === true ||
        modules?.clips?.startAtDrop === true ||
        tplId === 'constellations' ||
        tplId === 'cinematic-minimal';
      if (!legacyNeedsDrop) return [];
      rawMarkers = [{
        id: 'drop',
        label: modules?.dropMarker?.label || 'drop',
        color: modules?.dropMarker?.color || '#83ca90'
      }];
    }

    if (!Array.isArray(rawMarkers) || rawMarkers.length === 0) return [];

    const duration = Math.max(0.1, Number(project?.duration) || 30);
    const bpm = Math.max(40, Math.min(240, parseFloat(project?.bpm) || 120));
    const secPerBar = (60 / bpm) * 4;
    const overrides = project?._markerOverrides || {};
    const usedIds = new Set();

    const resolved = rawMarkers.map((m, idx) => {
      const baseKey = String(m?.id || m?.section || m?.label || `cue_${idx + 1}`)
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '') || `cue_${idx + 1}`;
      let id = baseKey;
      let dup = 2;
      while (usedIds.has(id)) {
        id = `${baseKey}_${dup++}`;
      }
      usedIds.add(id);

      const secQuery = String(m?.section || m?.id || m?.label || '').toLowerCase();
      const matchedSection = projectSections
        ? (projectSections.find((s) => s.id === secQuery || (s.label && s.label.toLowerCase() === secQuery)) ||
          projectSections.find((s) => s.type === secQuery))
        : null;

      let time;
      if (typeof overrides[id] === 'number' && Number.isFinite(overrides[id])) {
        time = overrides[id];
      } else if (typeof m?.time === 'number' && Number.isFinite(m.time)) {
        time = m.time;
      } else if (typeof m?.bar === 'number' && Number.isFinite(m.bar)) {
        time = (Math.max(1, m.bar) - 1) * secPerBar;
      } else if (matchedSection && Number.isFinite(matchedSection.time)) {
        time = matchedSection.time;
      } else if (id === 'drop' || secQuery === 'drop') {
        time = typeof project?.dropTime === 'number' && Number.isFinite(project.dropTime)
          ? project.dropTime
          : duration * 0.5;
      } else {
        time = ((idx + 1) / (rawMarkers.length + 1)) * duration;
      }

      const clampedTime = Number(Math.max(0, Math.min(duration - 0.02, time)).toFixed(3));
      const bar = Math.max(1, Math.round(clampedTime / secPerBar) + 1);
      const label = String(m?.label || matchedSection?.label || id).toLowerCase();
      const color = String(m?.color || matchedSection?.color || MARKER_PALETTE[idx % MARKER_PALETTE.length]);

      return {
        id,
        label,
        time: clampedTime,
        bar,
        color,
        section: m?.section || matchedSection?.id || null
      };
    });

    resolved.sort((a, b) => a.time - b.time);
    return resolved;
  }

  function getSectionAtTime(sections, time, duration) {
    const dur = Math.max(0.1, Number(duration) || 30);
    const list = Array.isArray(sections) && sections.length > 0
      ? sections
      : getDefaultSections({ duration: dur });
    const t = Math.max(0, Math.min(dur, Number(time) || 0));

    let activeIdx = 0;
    for (let i = 0; i < list.length; i++) {
      const sTime = Number(list[i]?.time) || 0;
      if (t >= sTime - 1e-4) {
        activeIdx = i;
      } else {
        break;
      }
    }

    const active = list[activeIdx] || list[0];
    const next = list[activeIdx + 1];
    const startTime = Number(active.time) || 0;
    const endTime = next ? (Number(next.time) || dur) : (Number(active.endTime) || dur);
    const span = Math.max(0.001, endTime - startTime);
    const age = Math.max(0, t - startTime);
    const remaining = Math.max(0, endTime - t);
    const progress = Math.max(0, Math.min(1, age / span));

    return {
      ...active,
      index: activeIdx,
      count: list.length,
      startTime,
      endTime,
      age: Number(age.toFixed(4)),
      remaining: Number(remaining.toFixed(4)),
      progress: Number(progress.toFixed(4))
    };
  }

  const CUSTOM_CUE_PALETTE = ['#f59e0b', '#60a5fa', '#a78bfa', '#f472b6', '#34d399', '#fb7185'];

  function sanitizeCategoryId(raw, fallbackIdx = 0) {
    const cleaned = String(raw || '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return cleaned || `cue_${fallbackIdx + 1}`;
  }

  function resolveMarkerCategories(presetOrTemplate) {
    const features = presetOrTemplate?.features || presetOrTemplate?.preset?.features || {};
    const rawCats = features?.timeline?.categories;
    if (!Array.isArray(rawCats) || rawCats.length === 0) return [];

    const usedIds = new Set();
    const out = [];
    for (let i = 0; i < rawCats.length; i++) {
      const c = rawCats[i];
      if (!c || typeof c !== 'object') continue;
      const baseId = sanitizeCategoryId(c.id || c.label, out.length);
      let id = baseId;
      let dup = 2;
      while (usedIds.has(id)) {
        id = `${baseId}_${dup++}`;
      }
      usedIds.add(id);

      const kind = String(c.kind || 'point').toLowerCase() === 'range' ? 'range' : 'point';
      const rawBeats = Number(c.defaultBeats);
      const defaultBeats = Number.isFinite(rawBeats) && rawBeats > 0
        ? Math.max(0.125, Math.min(32, rawBeats))
        : (kind === 'range' ? 1 : 0.5);
      const label = String(c.label || id).trim().toLowerCase().slice(0, 28) || id;
      const color = (typeof c.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(c.color.trim()))
        ? c.color.trim()
        : CUSTOM_CUE_PALETTE[out.length % CUSTOM_CUE_PALETTE.length];

      out.push({ id, label, color, kind, defaultBeats });
    }
    return out;
  }

  function normalizeCategoryCues(rawList, duration = 30, kind = 'point', defaultDurationSec = 0.5, bpm = 120) {
    if (!Array.isArray(rawList) || rawList.length === 0) return [];
    const dur = Math.max(0.1, Number(duration) || 30);
    const beatSec = 60 / Math.max(40, Math.min(240, Number(bpm) || 120));
    const secPerBar = beatSec * 4;
    const minSpan = Math.min(0.05, dur * 0.25);
    const fallbackSpan = Math.max(minSpan, Number(defaultDurationSec) || beatSec);
    const maxStart = Math.max(0, dur - (kind === 'range' ? minSpan : 0.02));

    const items = [];
    for (let i = 0; i < rawList.length; i++) {
      const entry = rawList[i];
      const rawTime = typeof entry === 'number'
        ? entry
        : (Number.isFinite(Number(entry?.time))
          ? Number(entry.time)
          : (Number.isFinite(Number(entry?.bar)) ? (Math.max(1, Number(entry.bar)) - 1) * secPerBar : NaN));
      if (!Number.isFinite(rawTime)) continue;

      const t = Number(Math.max(0, Math.min(maxStart, rawTime)).toFixed(3));
      let span = 0;
      if (kind === 'range') {
        const rawDur = typeof entry === 'object' && entry !== null ? Number(entry.duration) : NaN;
        const rawBeats = typeof entry === 'object' && entry !== null ? Number(entry.beats) : NaN;
        const wanted = Number.isFinite(rawDur) && rawDur > 0
          ? rawDur
          : (Number.isFinite(rawBeats) && rawBeats > 0 ? rawBeats * beatSec : fallbackSpan);
        span = Number(Math.max(minSpan, Math.min(dur - t, wanted)).toFixed(3));
      }

      items.push({
        id: typeof entry === 'object' && entry?.id ? String(entry.id) : null,
        time: t,
        duration: span,
        endTime: Number((t + span).toFixed(3)),
        bar: Math.max(1, Math.round(t / secPerBar) + 1)
      });
    }

    items.sort((a, b) => a.time - b.time || a.duration - b.duration);
    for (let i = 0; i < items.length; i++) {
      if (!items[i].id) items[i].id = `c_${i}`;
    }
    return items;
  }

  function resolveCustomCuesByCategory(presetOrTemplate, project) {
    const categories = resolveMarkerCategories(presetOrTemplate);
    if (categories.length === 0) return { categories: [], byCategory: {} };

    const duration = Math.max(0.1, Number(project?.duration) || 30);
    const bpm = Math.max(40, Math.min(240, parseFloat(project?.bpm) || 120));
    const beatSec = 60 / bpm;
    const store = (project && typeof project._customCues === 'object' && project._customCues) || {};
    const byCategory = {};

    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      const defaultSpan = cat.defaultBeats * beatSec;
      const raw = Array.isArray(store[cat.id]) ? store[cat.id] : [];
      byCategory[cat.id] = normalizeCategoryCues(raw, duration, cat.kind, defaultSpan, bpm);
    }
    return { categories, byCategory };
  }

  function getCueStateAtTime(cues, time, opts = {}) {
    const list = Array.isArray(cues) ? cues : [];
    const t = Math.max(0, Number(time) || 0);
    const kind = String(opts.kind || 'point').toLowerCase() === 'range' ? 'range' : 'point';
    const beatSec = 60 / Math.max(40, Math.min(240, Number(opts.bpm) || 120));
    const decaySec = Math.max(0.05, Number(opts.decaySec) || (Number(opts.defaultBeats) || 0.5) * beatSec);

    if (list.length === 0) {
      return {
        active: false,
        index: -1,
        count: 0,
        startTime: 0,
        endTime: 0,
        duration: 0,
        age: 0,
        remaining: 0,
        progress: 0,
        impulse: 0,
        nextIn: null,
        prevAge: null
      };
    }

    let nextIn = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].time > t + 1e-4) {
        nextIn = Number((list[i].time - t).toFixed(4));
        break;
      }
    }

    if (kind === 'range') {
      let activeIdx = -1;
      let latestPrevIdx = -1;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const end = c.time + Math.max(0.05, Number(c.duration) || 0.05);
        if (c.time <= t + 1e-4) latestPrevIdx = i;
        if (t >= c.time - 1e-4 && t <= end + 1e-4) {
          activeIdx = i;
        }
      }
      const prevAge = latestPrevIdx >= 0 ? Number(Math.max(0, t - list[latestPrevIdx].time).toFixed(4)) : null;
      if (activeIdx < 0) {
        return {
          active: false,
          index: -1,
          count: list.length,
          startTime: 0,
          endTime: 0,
          duration: 0,
          age: 0,
          remaining: 0,
          progress: 0,
          impulse: 0,
          nextIn,
          prevAge
        };
      }
      const cur = list[activeIdx];
      const dur = Math.max(0.05, Number(cur.duration) || 0.05);
      const age = Math.max(0, t - cur.time);
      const remaining = Math.max(0, cur.time + dur - t);
      const progress = Math.max(0, Math.min(1, age / dur));
      return {
        active: true,
        index: activeIdx,
        count: list.length,
        startTime: cur.time,
        endTime: Number((cur.time + dur).toFixed(3)),
        duration: dur,
        age: Number(age.toFixed(4)),
        remaining: Number(remaining.toFixed(4)),
        progress: Number(progress.toFixed(4)),
        impulse: 1,
        nextIn,
        prevAge
      };
    }

    let prevIdx = -1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].time <= t + 1e-4) prevIdx = i;
      else break;
    }
    if (prevIdx < 0) {
      return {
        active: false,
        index: -1,
        count: list.length,
        startTime: 0,
        endTime: 0,
        duration: 0,
        age: 0,
        remaining: 0,
        progress: 0,
        impulse: 0,
        nextIn,
        prevAge: null
      };
    }
    const cur = list[prevIdx];
    const age = Math.max(0, t - cur.time);
    const active = age <= decaySec;
    const progress = active ? Math.max(0, Math.min(1, age / decaySec)) : 1;
    const impulse = active ? Number(Math.pow(1 - progress, 2).toFixed(4)) : 0;
    return {
      active,
      index: prevIdx,
      count: list.length,
      startTime: cur.time,
      endTime: cur.time,
      duration: 0,
      age: Number(age.toFixed(4)),
      remaining: active ? Number(Math.max(0, decaySec - age).toFixed(4)) : 0,
      progress: Number(progress.toFixed(4)),
      impulse,
      nextIn,
      prevAge: Number(age.toFixed(4))
    };
  }

  const loopUtilsApi = {
    getLoopTransitionInfo,
    getTrackSpanInfo,
    isTrackLoopEnabled,
    expandTrackNotes,
    SeamlessLoopCache,
    extractLuma,
    estimateBlockMotion,
    advectDatamoshPixels,
    estimateCodecMotion,
    advectCodecDatamosh,
    getDefaultSections,
    resolveTimelineMarkers,
    getSectionAtTime,
    resolveMarkerCategories,
    normalizeCategoryCues,
    resolveCustomCuesByCategory,
    getCueStateAtTime
  };

  if (typeof window !== 'undefined') {
    window.loopUtils = loopUtilsApi;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = loopUtilsApi;
  }
})();
