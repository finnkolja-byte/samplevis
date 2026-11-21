// deterministic offline spectrogram, waveform slicing, and unstyled canvas geometry helpers
(function () {
  'use strict';

  const SPEC_RATE = 22050;
  const FFT_SIZE = 1024;
  const HALF_FFT = FFT_SIZE >> 1; // 512 linear bins (~21.53 Hz/bin at 22050 Hz)
  const LOG_BINS = 128;
  const MIN_HZ = 30;
  const MAX_HZ = 10500;
  const SPEC_FPS = 36;
  const WAVE_RATE = 8000;
  const WAVE_WINDOW_MS = 32;
  const MAX_ANALYSIS_SECONDS = 300;
  const MAX_CACHE_ENTRIES = 6;

  // precompute hann window and bit-reversal permutation for 1024-point real/complex fft
  const HANN_WINDOW = new Float32Array(FFT_SIZE);
  const BIT_REV = new Uint16Array(FFT_SIZE);
  const LOG_BITS = Math.round(Math.log2(FFT_SIZE));
  for (let i = 0; i < FFT_SIZE; i++) {
    HANN_WINDOW[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
    let x = i;
    let rev = 0;
    for (let b = 0; b < LOG_BITS; b++) {
      rev = (rev << 1) | (x & 1);
      x >>= 1;
    }
    BIT_REV[i] = rev;
  }

  // precompute linear bin ranges for each of the 128 logarithmic bands
  const BIN_START = new Uint16Array(LOG_BINS);
  const BIN_END = new Uint16Array(LOG_BINS);
  const FREQ_TILT = new Float32Array(LOG_BINS);
  const LOG_RATIO = Math.log(MAX_HZ / MIN_HZ);
  const HZ_PER_BIN = SPEC_RATE / FFT_SIZE;

  for (let k = 0; k < LOG_BINS; k++) {
    const fLow = MIN_HZ * Math.exp((k / LOG_BINS) * LOG_RATIO);
    const fHigh = MIN_HZ * Math.exp(((k + 1) / LOG_BINS) * LOG_RATIO);
    const b0 = Math.max(1, Math.min(HALF_FFT - 1, Math.floor(fLow / HZ_PER_BIN)));
    const b1 = Math.max(b0, Math.min(HALF_FFT - 1, Math.ceil(fHigh / HZ_PER_BIN)));
    BIN_START[k] = b0;
    BIN_END[k] = b1;
    FREQ_TILT[k] = 1.0 + 0.42 * (k / (LOG_BINS - 1));
  }

  function hzToBinIdx(hz) {
    const norm = Math.log(Math.max(MIN_HZ, Math.min(MAX_HZ, Number(hz) || MIN_HZ)) / MIN_HZ) / LOG_RATIO;
    return Math.max(0, Math.min(LOG_BINS - 1, Math.round(norm * (LOG_BINS - 1))));
  }

  // log-bin ranges for 5-stem hpss extraction (bass/other harmonic, kick/snare/top percussive)
  const STEM_RANGES = {
    bass: [hzToBinIdx(30), hzToBinIdx(180)],
    other: [hzToBinIdx(190), hzToBinIdx(6000)],
    kick: [hzToBinIdx(35), hzToBinIdx(140)],
    snare: [hzToBinIdx(210), hzToBinIdx(4500)],
    top: [hzToBinIdx(5500), LOG_BINS - 1]
  };

  function medianFloatSlice(buf, count) {
    for (let i = 1; i < count; i++) {
      const x = buf[i];
      let j = i - 1;
      while (j >= 0 && buf[j] > x) {
        buf[j + 1] = buf[j];
        j--;
      }
      buf[j + 1] = x;
    }
    const mid = count >> 1;
    return (count & 1) ? buf[mid] : (buf[mid - 1] + buf[mid]) * 0.5;
  }

  function computeHpssStems(rawSpectrogram, numFrames, peakRef) {
    const hRad = 5;
    const pRad = 6;
    const pStride = 2;
    const hWin = new Float32Array(hRad * 2 + 1);
    const pWin = new Float32Array(pRad * 2 + 1);
    const rowHarm = new Float32Array(LOG_BINS);
    const rowPerc = new Float32Array(LOG_BINS);

    const rawBass = new Float32Array(numFrames);
    const rawOther = new Float32Array(numFrames);
    const rawKick = new Float32Array(numFrames);
    const rawSnare = new Float32Array(numFrames);
    const rawTop = new Float32Array(numFrames);

    const aggBand = (row, b0, b1) => {
      let sumSq = 0;
      let peak = 0;
      const count = Math.max(1, b1 - b0 + 1);
      for (let k = b0; k <= b1; k++) {
        const v = row[k];
        sumSq += v * v;
        if (v > peak) peak = v;
      }
      const rms = Math.sqrt(sumSq / count);
      return rms * 0.58 + peak * 0.42;
    };

    for (let f = 0; f < numFrames; f++) {
      const fStart = Math.max(0, f - hRad);
      const fEnd = Math.min(numFrames - 1, f + hRad);
      const rowOffset = f * LOG_BINS;

      for (let k = 0; k < LOG_BINS; k++) {
        let hCount = 0;
        for (let ff = fStart; ff <= fEnd; ff++) {
          hWin[hCount++] = rawSpectrogram[ff * LOG_BINS + k];
        }
        const hMed = medianFloatSlice(hWin, hCount);

        let pCount = 0;
        for (let d = -pRad; d <= pRad; d++) {
          const kk = k + d * pStride;
          if (kk < 0) {
            // zero-pad below 30 hz so single sub-bass partials do not look broadband
            pWin[pCount++] = 0;
          } else if (kk < LOG_BINS) {
            pWin[pCount++] = rawSpectrogram[rowOffset + kk];
          }
        }
        const pMed = pCount > 0 ? medianFloatSlice(pWin, pCount) : 0;

        const s = rawSpectrogram[rowOffset + k];
        const h3 = hMed * hMed * hMed;
        const p3 = pMed * pMed * pMed;
        const denom = h3 + p3 + 1e-12;
        const mH = h3 / denom;
        const mP = p3 / denom;

        rowHarm[k] = Math.min(s, Math.max(s * mH, hMed));
        const transientExcess = Math.max(0, s - 1.02 * hMed) * 1.35;
        const sPerc = s * mP;
        rowPerc[k] = mP < 0.82 ? Math.min(sPerc, transientExcess) : sPerc;
      }

      rawBass[f] = aggBand(rowHarm, STEM_RANGES.bass[0], STEM_RANGES.bass[1]);
      rawOther[f] = aggBand(rowHarm, STEM_RANGES.other[0], STEM_RANGES.other[1]);
      rawKick[f] = aggBand(rowPerc, STEM_RANGES.kick[0], STEM_RANGES.kick[1]);
      rawSnare[f] = aggBand(rowPerc, STEM_RANGES.snare[0], STEM_RANGES.snare[1]);
      rawTop[f] = aggBand(rowPerc, STEM_RANGES.top[0], STEM_RANGES.top[1]);
    }

    const logDenom = Math.log1p(12);
    const minStemPeak = Math.max(0.008, peakRef * 0.22);
    const scratchSort = new Float32Array(numFrames);

    const packEnvelope = (rawArr, attackAlpha, releaseAlpha, gateFloor) => {
      scratchSort.set(rawArr);
      scratchSort.sort();
      const p98 = scratchSort[Math.min(numFrames - 1, Math.floor(numFrames * 0.98))] || 0;
      const stemScale = 1.0 / Math.max(minStemPeak, p98);
      const packed = new Uint8Array(numFrames);
      let env = 0;

      for (let f = 0; f < numFrames; f++) {
        const linear = Math.min(1.0, rawArr[f] * stemScale);
        const compressed = Math.min(1.0, Math.log1p(linear * 12) / logDenom);
        const target = compressed <= gateFloor ? 0 : (compressed - gateFloor) / (1 - gateFloor);
        const alpha = target > env ? attackAlpha : releaseAlpha;
        env = env + (target - env) * alpha;
        packed[f] = Math.max(0, Math.min(255, Math.round(env * 255)));
      }
      return packed;
    };

    return {
      kick: packEnvelope(rawKick, 0.96, 0.42, 0.06),
      snare: packEnvelope(rawSnare, 0.96, 0.40, 0.06),
      top: packEnvelope(rawTop, 0.96, 0.38, 0.05),
      bass: packEnvelope(rawBass, 0.58, 0.26, 0.03),
      other: packEnvelope(rawOther, 0.55, 0.25, 0.03)
    };
  }

  function fftMagnitudes(samples, startIdx, re, im, outMags) {
    const len = samples.length;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = startIdx + i;
      const v = idx >= 0 && idx < len ? samples[idx] : 0;
      const j = BIT_REV[i];
      re[j] = v * HANN_WINDOW[i];
      im[j] = 0;
    }

    for (let size = 2; size <= FFT_SIZE; size <<= 1) {
      const half = size >> 1;
      const theta = (-2 * Math.PI) / size;
      const wStepR = Math.cos(theta);
      const wStepI = Math.sin(theta);

      for (let start = 0; start < FFT_SIZE; start += size) {
        let wR = 1;
        let wI = 0;
        for (let k = 0; k < half; k++) {
          const evenIdx = start + k;
          const oddIdx = evenIdx + half;
          const tR = wR * re[oddIdx] - wI * im[oddIdx];
          const tI = wR * im[oddIdx] + wI * re[oddIdx];
          re[oddIdx] = re[evenIdx] - tR;
          im[oddIdx] = im[evenIdx] - tI;
          re[evenIdx] += tR;
          im[evenIdx] += tI;
          const nextWR = wR * wStepR - wI * wStepI;
          wI = wR * wStepI + wI * wStepR;
          wR = nextWR;
        }
      }
    }

    const invScale = 2.0 / FFT_SIZE;
    for (let b = 0; b < HALF_FFT; b++) {
      outMags[b] = Math.hypot(re[b], im[b]) * invScale;
    }
  }

  function downsampleMono(audioBuffer, targetRate, maxSeconds) {
    const srcRate = Math.max(8000, audioBuffer.sampleRate || 44100);
    const chCount = Math.min(2, Math.max(1, audioBuffer.numberOfChannels || 1));
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = chCount > 1 ? audioBuffer.getChannelData(1) : null;
    const maxSrcFrames = Math.min(ch0.length, Math.floor(srcRate * maxSeconds));
    const outLen = Math.max(1, Math.floor((maxSrcFrames / srcRate) * targetRate));
    const out = new Float32Array(outLen);
    const ratio = maxSrcFrames / outLen;

    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.max(start + 1, Math.min(maxSrcFrames, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let f = start; f < end; f++) {
        const s = ch1 ? (ch0[f] + ch1[f]) * 0.5 : ch0[f];
        sum += Number.isFinite(s) ? s : 0;
      }
      out[i] = sum / (end - start);
    }
    return out;
  }

  function analyzeAudioBuffer(audioBuffer) {
    if (!audioBuffer || !audioBuffer.length || !audioBuffer.sampleRate) {
      return null;
    }

    const analyzedDur = Math.min(audioBuffer.duration || (audioBuffer.length / audioBuffer.sampleRate), MAX_ANALYSIS_SECONDS);
    const specMono = downsampleMono(audioBuffer, SPEC_RATE, analyzedDur);
    const waveMonoFloat = downsampleMono(audioBuffer, WAVE_RATE, analyzedDur);
    const STEREO_RATE = 4000;
    const downsampleStereoCh = (chIdx) => {
      const safeCh = Math.min(chIdx, Math.max(0, (audioBuffer.numberOfChannels || 1) - 1));
      const src = audioBuffer.getChannelData(safeCh);
      const srcRate = audioBuffer.sampleRate || 44100;
      const outLen = Math.max(1, Math.round(analyzedDur * STEREO_RATE));
      const out = new Int8Array(outLen);
      const ratio = srcRate / STEREO_RATE;
      for (let i = 0; i < outLen; i++) {
        const idx = Math.min(src.length - 1, Math.floor(i * ratio));
        out[i] = Math.max(-127, Math.min(127, Math.round(src[idx] * 127)));
      }
      return out;
    };
    const waveLeftPcm = downsampleStereoCh(0);
    const waveRightPcm = (audioBuffer.numberOfChannels || 1) > 1 ? downsampleStereoCh(1) : waveLeftPcm;

    const wavePcm = new Int8Array(waveMonoFloat.length);
    for (let i = 0; i < waveMonoFloat.length; i++) {
      const clamped = Math.max(-1, Math.min(1, waveMonoFloat[i]));
      wavePcm[i] = Math.round(clamped * 127);
    }

    const numFrames = Math.max(1, Math.ceil(analyzedDur * SPEC_FPS));
    const hop = Math.max(1, specMono.length / numFrames);
    const rawSpectrogram = new Float32Array(numFrames * LOG_BINS);

    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    const mags = new Float32Array(HALF_FFT);

    let peakRef = 0.02;
    const frameMaxes = new Float32Array(numFrames);
    for (let f = 0; f < numFrames; f++) {
      const centerSample = Math.floor(f * hop);
      const startSample = centerSample - (FFT_SIZE >> 1);
      fftMagnitudes(specMono, startSample, re, im, mags);

      const frameOffset = f * LOG_BINS;
      let frameMax = 0;
      for (let k = 0; k < LOG_BINS; k++) {
        const b0 = BIN_START[k];
        const b1 = BIN_END[k];
        let sumSq = 0;
        let count = 0;
        for (let b = b0; b <= b1; b++) {
          const m = mags[b];
          sumSq += m * m;
          count++;
        }
        const val = Math.sqrt(sumSq / Math.max(1, count)) * FREQ_TILT[k];
        rawSpectrogram[frameOffset + k] = val;
        if (val > frameMax) frameMax = val;
      }
      frameMaxes[f] = frameMax;
    }

    // use 96th-percentile frame peak so a single transient click never squashes dynamic range
    const sortedMaxes = Array.from(frameMaxes).sort((a, b) => a - b);
    const p96 = sortedMaxes[Math.min(sortedMaxes.length - 1, Math.floor(sortedMaxes.length * 0.96))] || 0.02;
    peakRef = Math.max(0.02, p96);

    // deterministic attack/release temporal smoothing + log dynamic scaling
    const normScale = 1.0 / Math.max(0.015, peakRef);
    const logDenom = Math.log1p(14);
    const specBins = new Uint8Array(numFrames * LOG_BINS);
    const prev = new Float32Array(LOG_BINS);

    for (let f = 0; f < numFrames; f++) {
      const frameOffset = f * LOG_BINS;
      for (let k = 0; k < LOG_BINS; k++) {
        const scaled = Math.min(1.0, rawSpectrogram[frameOffset + k] * normScale);
        const target = Math.min(1.0, Math.log1p(scaled * 14) / logDenom);
        const alpha = target > prev[k] ? 0.56 : 0.24;
        prev[k] = prev[k] + (target - prev[k]) * alpha;
        specBins[frameOffset + k] = Math.max(0, Math.min(255, Math.round(prev[k] * 255)));
      }
    }

    const stems = computeHpssStems(rawSpectrogram, numFrames, peakRef);

    return {
      duration: audioBuffer.duration || analyzedDur,
      analyzedDuration: analyzedDur,
      specFps: SPEC_FPS,
      specNumFrames: numFrames,
      specNumBins: LOG_BINS,
      specBins,
      stems,
      waveRate: WAVE_RATE,
      wavePcm,
      stereoRate: STEREO_RATE,
      waveLeftPcm,
      waveRightPcm
    };
  }

  function hzToNormalizedBin(hz) {
    const safeHz = Math.max(MIN_HZ, Math.min(MAX_HZ, Number(hz) || MIN_HZ));
    return Math.log(safeHz / MIN_HZ) / LOG_RATIO;
  }

  function sampleStems(signalData, fallbackMetrics, time, duration) {
    const fbBass = Math.max(0, Math.min(1, Number(fallbackMetrics?.bass) || 0));
    const fbMid = Math.max(0, Math.min(1, Number(fallbackMetrics?.mid) || 0));
    const fbHigh = Math.max(0, Math.min(1, Number(fallbackMetrics?.high) || 0));
    const fbImpulse = Math.max(0, Math.min(1, Number(fallbackMetrics?.beatImpulse) || 0));

    if (!signalData || !signalData.stems || !signalData.specNumFrames) {
      const kick = Math.min(1, fbImpulse * 0.85 + fbBass * 0.15);
      const snare = Math.min(1, fbImpulse * 0.35 + fbMid * 0.25);
      const top = Math.min(1, fbHigh * 0.65);
      const bass = Math.min(1, fbBass * 0.85);
      const other = Math.min(1, fbMid * 0.8);
      return {
        kick,
        snare,
        top,
        bass,
        other,
        drums: Math.min(1, Math.max(kick, snare * 0.85, top * 0.65))
      };
    }

    const safeTime = Math.max(0, Math.min(signalData.analyzedDuration || duration || 0, Number(time) || 0));
    const nFrames = signalData.specNumFrames;
    const exactFrame = Math.min(nFrames - 1, Math.max(0, safeTime * signalData.specFps));
    const f0 = Math.floor(exactFrame);
    const f1 = Math.min(nFrames - 1, f0 + 1);
    const frac = exactFrame - f0;

    const readEnv = (arr) => {
      if (!arr || arr.length === 0) return 0;
      const v0 = arr[Math.min(arr.length - 1, f0)] || 0;
      const v1 = arr[Math.min(arr.length - 1, f1)] || 0;
      return Math.max(0, Math.min(1, (v0 * (1 - frac) + v1 * frac) / 255));
    };

    const st = signalData.stems;
    const kick = readEnv(st.kick);
    const snare = readEnv(st.snare);
    const top = readEnv(st.top);
    const bass = readEnv(st.bass);
    const other = readEnv(st.other);
    return {
      kick,
      snare,
      top,
      bass,
      other,
      drums: Math.min(1, Math.max(kick, snare * 0.85, top * 0.65))
    };
  }

  function fillAudioBuffers(signalData, fallbackMetrics, time, duration, fftOut256, waveOut256) {
    const metrics = {
      rms: fallbackMetrics?.rms ?? 0.5,
      bass: fallbackMetrics?.bass ?? 0.4,
      mid: fallbackMetrics?.mid ?? 0.35,
      high: fallbackMetrics?.high ?? 0.25,
      beatImpulse: fallbackMetrics?.beatImpulse ?? 0,
      stems: null
    };

    if (!signalData || !signalData.specBins || !signalData.wavePcm) {
      // graceful synthetic fallback while audio is still decoding or unavailable
      const r = metrics.rms;
      for (let i = 0; i < 256; i++) {
        const u = i / 255;
        const bandWeight = u < 0.22 ? metrics.bass : u < 0.65 ? metrics.mid : metrics.high;
        const val = Math.max(0, Math.min(1, bandWeight * (0.45 + 0.55 * (Math.sin(time * 7 + i * 0.22) * 0.5 + 0.5))));
        if (fftOut256) fftOut256[i] = Math.round(val * 255);
        if (waveOut256) {
          const wv = Math.sin(time * 28 + u * 24) * r * 0.65;
          waveOut256[i] = Math.max(0, Math.min(255, Math.round(128 + wv * 127)));
        }
      }
      metrics.stems = sampleStems(null, metrics, time, duration);
      return metrics;
    }

    const safeTime = Math.max(0, Math.min(signalData.analyzedDuration || duration || 0, Number(time) || 0));
    const exactFrame = Math.min(
      signalData.specNumFrames - 1,
      Math.max(0, safeTime * signalData.specFps)
    );
    const f0 = Math.floor(exactFrame);
    const f1 = Math.min(signalData.specNumFrames - 1, f0 + 1);
    const frac = exactFrame - f0;
    const bins = signalData.specBins;
    const nBins = signalData.specNumBins;
    const off0 = f0 * nBins;
    const off1 = f1 * nBins;

    if (fftOut256) {
      let bassSum = 0;
      let bassCount = 0;
      let midSum = 0;
      let midCount = 0;
      let highSum = 0;
      let highCount = 0;

      for (let i = 0; i < 256; i++) {
        const pos = (i / 255) * (nBins - 1);
        const k0 = Math.floor(pos);
        const k1 = Math.min(nBins - 1, k0 + 1);
        const kFrac = pos - k0;

        const vA = bins[off0 + k0] * (1 - kFrac) + bins[off0 + k1] * kFrac;
        const vB = bins[off1 + k0] * (1 - kFrac) + bins[off1 + k1] * kFrac;
        const valByte = vA * (1 - frac) + vB * frac;
        fftOut256[i] = Math.max(0, Math.min(255, Math.round(valByte)));

        const normVal = valByte / 255;
        if (i < 66) { // ~30–140 Hz
          bassSum += normVal;
          bassCount++;
        } else if (i < 185) { // ~140–2200 Hz
          midSum += normVal;
          midCount++;
        } else { // ~2200–10500 Hz
          highSum += normVal;
          highCount++;
        }
      }

      if (bassCount > 0) {
        const realBass = bassSum / bassCount;
        metrics.bass = Math.min(1.0, realBass * 0.85 + metrics.beatImpulse * 0.25);
      }
      if (midCount > 0) {
        metrics.mid = Math.min(1.0, (midSum / midCount) * 1.05);
      }
      if (highCount > 0) {
        metrics.high = Math.min(1.0, (highSum / highCount) * 1.15);
      }
    }

    if (waveOut256) {
      const pcm = signalData.wavePcm;
      const pcmLen = pcm.length;
      const winSamples = Math.max(16, Math.round((WAVE_WINDOW_MS / 1000) * signalData.waveRate));
      const centerIdx = Math.round(safeTime * signalData.waveRate);
      const startIdx = centerIdx - (winSamples >> 1);

      for (let i = 0; i < 256; i++) {
        const samplePos = startIdx + (i / 255) * winSamples;
        const idx0 = Math.floor(samplePos);
        const idx1 = idx0 + 1;
        const sFrac = samplePos - idx0;
        const s0 = idx0 >= 0 && idx0 < pcmLen ? pcm[idx0] : 0;
        const s1 = idx1 >= 0 && idx1 < pcmLen ? pcm[idx1] : 0;
        const interp = s0 * (1 - sFrac) + s1 * sFrac;
        waveOut256[i] = Math.max(0, Math.min(255, Math.round(128 + interp)));
      }
    }

    metrics.stems = sampleStems(signalData, metrics, safeTime, duration);
    return metrics;
  }

  function clampCount(n, fallback = 32) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return fallback;
    return Math.max(1, Math.min(256, v));
  }

  function sampleSpectrum(fftArray, count = 32, opts = {}) {
    const safeCount = clampCount(count, 32);
    const out = new Array(safeCount);
    if (!fftArray || fftArray.length === 0) {
      out.fill(0);
      return out;
    }

    const len = fftArray.length;
    const minU = opts.minHz !== undefined ? hzToNormalizedBin(opts.minHz) : 0;
    const maxU = opts.maxHz !== undefined
      ? Math.max(minU + 0.02, hzToNormalizedBin(opts.maxHz))
      : 1;
    const mirror = Boolean(opts.mirror);
    const power = Number.isFinite(opts.power) && opts.power > 0 ? opts.power : 1.0;

    for (let i = 0; i < safeCount; i++) {
      let t = safeCount === 1 ? 0 : i / (safeCount - 1);
      if (mirror) {
        t = Math.abs(t * 2 - 1);
      }
      const u = minU + t * (maxU - minU);
      const pos = u * (len - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(len - 1, i0 + 1);
      const frac = pos - i0;
      const norm = ((fftArray[i0] || 0) * (1 - frac) + (fftArray[i1] || 0) * frac) / 255;
      out[i] = power === 1.0 ? norm : Math.pow(Math.max(0, norm), power);
    }
    return out;
  }

  function sampleWave(waveArray, count = 64, opts = {}) {
    const safeCount = clampCount(count, 64);
    const out = new Array(safeCount);
    if (!waveArray || waveArray.length === 0) {
      out.fill(0);
      return out;
    }

    const len = waveArray.length;
    const gain = Number.isFinite(opts.gain) ? Math.max(0.05, Math.min(8, opts.gain)) : 1.0;

    for (let i = 0; i < safeCount; i++) {
      const pos = safeCount === 1 ? 0 : (i / (safeCount - 1)) * (len - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(len - 1, i0 + 1);
      const frac = pos - i0;
      const raw = (waveArray[i0] ?? 128) * (1 - frac) + (waveArray[i1] ?? 128) * frac;
      const signed = ((raw - 128) / 127) * gain;
      out[i] = Math.max(-1, Math.min(1, signed));
    }

    if (opts.smooth) {
      const passes = Math.max(1, Math.min(3, Number(opts.smooth) === true ? 1 : Number(opts.smooth) || 0));
      for (let p = 0; p < passes; p++) {
        for (let i = 1; i < safeCount - 1; i++) {
          out[i] = out[i - 1] * 0.22 + out[i] * 0.56 + out[i + 1] * 0.22;
        }
      }
    }
    return out;
  }

  function sampleOverview(peaks, count = 64) {
    const safeCount = clampCount(count, 64);
    const out = new Array(safeCount);
    if (!peaks || peaks.length === 0) {
      out.fill(0.2);
      return out;
    }
    const len = peaks.length;
    for (let i = 0; i < safeCount; i++) {
      const pos = safeCount === 1 ? 0 : (i / (safeCount - 1)) * (len - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(len - 1, i0 + 1);
      const frac = pos - i0;
      const val = (peaks[i0] || 0) * (1 - frac) + (peaks[i1] || 0) * frac;
      out[i] = Math.max(0, Math.min(1, Number.isFinite(val) ? val : 0));
    }
    return out;
  }

  function sampleBand(fftArray, lowHz = 20, highHz = 200) {
    if (!fftArray || fftArray.length === 0) return 0;
    const len = fftArray.length;
    const lo = hzToNormalizedBin(Math.min(lowHz, highHz));
    const hi = hzToNormalizedBin(Math.max(lowHz, highHz));
    const i0 = Math.max(0, Math.min(len - 1, Math.floor(lo * (len - 1))));
    const i1 = Math.max(i0, Math.min(len - 1, Math.ceil(hi * (len - 1))));
    let sum = 0;
    let count = 0;
    for (let i = i0; i <= i1; i++) {
      sum += fftArray[i] || 0;
      count++;
    }
    return count > 0 ? Math.max(0, Math.min(1, sum / (count * 255))) : 0;
  }

  // unstyled catmull-rom cubic path builder (caller owns begin/stroke/fill styling)
  function drawSpline(ctx, points, opts = {}) {
    if (!ctx || !Array.isArray(points) || points.length === 0) return;
    const pts = [];
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const x = Array.isArray(pt) ? Number(pt[0]) : Number(pt?.x);
      const y = Array.isArray(pt) ? Number(pt[1]) : Number(pt?.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        pts.push({ x, y });
      }
    }
    const n = pts.length;
    if (n === 0) return;

    const closed = Boolean(opts.closed);
    const tension = Number.isFinite(opts.tension) ? Math.max(0, Math.min(1, opts.tension)) : 0.5;
    if (opts.beginPath !== false) ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    if (n === 1) return;
    if (n === 2) {
      ctx.lineTo(pts[1].x, pts[1].y);
      if (closed) ctx.closePath();
      return;
    }

    const totalSegs = closed ? n : n - 1;
    const factor = tension / 3;
    for (let i = 0; i < totalSegs; i++) {
      const p0 = pts[(i - 1 + n) % n];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % n];
      const p3 = pts[(i + 2) % n];

      const ep0 = !closed && i === 0 ? p1 : p0;
      const ep3 = !closed && i === n - 2 ? p2 : p3;

      const cp1x = p1.x + (p2.x - ep0.x) * factor;
      const cp1y = p1.y + (p2.y - ep0.y) * factor;
      const cp2x = p2.x - (ep3.x - p1.x) * factor;
      const cp2y = p2.y - (ep3.y - p1.y) * factor;

      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
    if (closed) ctx.closePath();
  }

  function buildPolarPoints(values, cx, cy, baseR, ampR, opts = {}) {
    if (!values || !values.length) return [];
    const safeCx = Number.isFinite(Number(cx)) ? Number(cx) : 0;
    const safeCy = Number.isFinite(Number(cy)) ? Number(cy) : 0;
    const safeBase = Number.isFinite(Number(baseR)) ? Number(baseR) : 0;
    const safeAmp = Number.isFinite(Number(ampR)) ? Number(ampR) : 0;
    const startAngle = Number.isFinite(opts.startAngle) ? opts.startAngle : -Math.PI * 0.5;
    const endAngle = Number.isFinite(opts.endAngle) ? opts.endAngle : startAngle + Math.PI * 2;
    const rotate = Number.isFinite(opts.rotate) ? opts.rotate : 0;
    const span = endAngle - startAngle;
    const len = values.length;
    const closedLoop = Math.abs(Math.abs(span) - Math.PI * 2) < 0.05;
    const denom = closedLoop ? len : Math.max(1, len - 1);

    const pts = new Array(len);
    for (let i = 0; i < len; i++) {
      const raw = Number(values[i]);
      const v = Number.isFinite(raw) ? raw : 0;
      const angle = startAngle + rotate + (i / denom) * span;
      const r = Math.max(0, safeBase + v * safeAmp);
      pts[i] = {
        x: safeCx + Math.cos(angle) * r,
        y: safeCy + Math.sin(angle) * r,
        r,
        angle,
        value: v,
        index: i
      };
    }
    return pts;
  }

  function drawMirrorRibbonPath(ctx, values, rect, opts = {}) {
    if (!ctx || !values || !values.length || !rect) return;
    const x = Number(rect.x) || 0;
    const y = Number(rect.y) || 0;
    const w = Math.max(1, Number(rect.w ?? rect.width) || 1);
    const h = Math.max(1, Number(rect.h ?? rect.height) || 1);
    const midY = y + h * 0.5;
    const minHalf = Math.max(0.5, (Number(opts.minH) || 2) * 0.5);
    const amp = (Number.isFinite(opts.amp) ? opts.amp : 0.48) * h;
    const n = values.length;

    const topPts = new Array(n);
    const botPts = new Array(n);
    for (let i = 0; i < n; i++) {
      const px = n === 1 ? x : x + (i / (n - 1)) * w;
      const v = Math.min(1, Math.max(0, Math.abs(Number(values[i]) || 0)));
      const halfH = Math.max(minHalf, v * amp);
      topPts[i] = { x: px, y: midY - halfH };
      botPts[n - 1 - i] = { x: px, y: midY + halfH };
    }

    if (opts.smooth === false || n < 3) {
      ctx.beginPath();
      ctx.moveTo(topPts[0].x, topPts[0].y);
      for (let i = 1; i < n; i++) ctx.lineTo(topPts[i].x, topPts[i].y);
      for (let i = 0; i < n; i++) ctx.lineTo(botPts[i].x, botPts[i].y);
      ctx.closePath();
    } else {
      drawSpline(ctx, [...topPts, ...botPts], { closed: true, tension: 0.45 });
    }
  }

  // bounded in-memory spectrogram cache keyed by audioUrl
  const signalCache = new Map();
  const pendingLoads = new Map();

  function setCached(key, signalData) {
    if (!key || !signalData) return;
    if (signalCache.has(key)) signalCache.delete(key);
    signalCache.set(key, signalData);
    while (signalCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = signalCache.keys().next().value;
      signalCache.delete(oldestKey);
    }
  }

  function getCached(key) {
    if (!key) return null;
    return signalCache.get(key) || null;
  }

  function attachBuffer(audioBuffer, cacheKey) {
    const signalData = analyzeAudioBuffer(audioBuffer);
    if (signalData && cacheKey) {
      setCached(cacheKey, signalData);
    }
    return signalData;
  }

  function registerSignalData(cacheKey, signalData) {
    if (cacheKey && signalData) {
      setCached(cacheKey, signalData);
    }
  }

  function isSafeAudioFetchUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('blob:')) return true;
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.origin === window.location.origin && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
    } catch {
      return false;
    }
  }

  async function ensureLoaded(audioUrl, onReady) {
    if (!audioUrl) return null;
    const cached = getCached(audioUrl);
    if (cached) {
      if (typeof onReady === 'function') onReady(cached, audioUrl);
      return cached;
    }
    if (!isSafeAudioFetchUrl(audioUrl)) return null;

    if (pendingLoads.has(audioUrl)) {
      const data = await pendingLoads.get(audioUrl);
      if (data && typeof onReady === 'function') onReady(data, audioUrl);
      return data;
    }

    const task = (async () => {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      let audioCtx = null;
      try {
        const res = await fetch(audioUrl);
        if (!res.ok) return null;
        const arrBuf = await res.arrayBuffer();
        if (!arrBuf || arrBuf.byteLength === 0) return null;
        audioCtx = new AudioContextClass();
        const audioBuffer = await audioCtx.decodeAudioData(arrBuf);
        const signalData = analyzeAudioBuffer(audioBuffer);
        if (signalData) setCached(audioUrl, signalData);
        return signalData;
      } catch {
        return null;
      } finally {
        if (audioCtx && audioCtx.state !== 'closed') {
          try { await audioCtx.close(); } catch {}
        }
        pendingLoads.delete(audioUrl);
      }
    })();

    pendingLoads.set(audioUrl, task);
    const data = await task;
    if (data && typeof onReady === 'function') onReady(data, audioUrl);
    return data;
  }

  function sampleStereo(signalData, time, count = 64) {
    const n = Math.max(8, Math.min(256, Math.round(count || 64)));
    const left = new Float32Array(n);
    const right = new Float32Array(n);

    if (!signalData || (!signalData.waveLeftPcm && !signalData.wavePcm)) {
      return { left, right, correlation: 0, width: 0 };
    }

    const lPcm = signalData.waveLeftPcm;
    const rPcm = signalData.waveRightPcm || lPcm;
    if (!lPcm || lPcm.length === 0) {
      const mono = sampleWave(signalData, time, n);
      left.set(mono);
      right.set(mono);
      return { left, right, correlation: 1, width: 0 };
    }

    const rate = signalData.stereoRate || 4000;
    const dur = signalData.analyzedDuration || signalData.duration || (lPcm.length / rate);
    const t = Math.max(0, Math.min(dur, time || 0));
    const winSec = 0.032;
    const centerSample = Math.round(t * rate);
    const spanSamples = Math.max(n, Math.round(winSec * rate));
    const half = spanSamples >> 1;

    let dot = 0;
    let sumL2 = 0;
    let sumR2 = 0;
    let sumDiff2 = 0;

    for (let i = 0; i < n; i++) {
      const idx = centerSample - half + Math.floor((i / n) * spanSamples);
      const clamped = Math.max(0, Math.min(lPcm.length - 1, idx));
      const lv = lPcm[clamped] / 127;
      const rv = rPcm[clamped] / 127;
      left[i] = lv;
      right[i] = rv;
      dot += lv * rv;
      sumL2 += lv * lv;
      sumR2 += rv * rv;
      const d = lv - rv;
      sumDiff2 += d * d;
    }

    const denom = Math.sqrt(sumL2 * sumR2);
    const correlation = denom > 1e-6 ? Math.max(-1, Math.min(1, dot / denom)) : 0;
    const energy = sumL2 + sumR2;
    const sideRatio = energy > 1e-6 ? Math.min(1, Math.sqrt(sumDiff2 / energy)) : 0;
    const corrTerm = denom > 1e-6 ? (1 - correlation) * 0.5 : 1.0;
    const width = energy > 1e-6
      ? Math.max(0, Math.min(1, 0.55 * corrTerm + 0.45 * sideRatio))
      : 0;

    return {
      left,
      right,
      correlation: Number(correlation.toFixed(4)),
      width: Number(width.toFixed(4))
    };
  }

  const api = {
    analyzeAudioBuffer,
    attachBuffer,
    registerSignalData,
    getCached,
    ensureLoaded,
    fillAudioBuffers,
    sampleStems,
    sampleSpectrum,
    sampleWave,
    sampleStereo,
    sampleOverview,
    sampleBand,
    drawSpline,
    buildPolarPoints,
    drawMirrorRibbonPath
  };

  if (typeof window !== 'undefined') {
    window.audioSignals = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
