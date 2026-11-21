// in-browser audio, midi, and ableton .als parser
(function () {
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function midiToNoteName(midi) {
    const octave = Math.floor(midi / 12) - 1;
    const name = NOTE_NAMES[midi % 12] || 'C';
    return `${name}${octave}`;
  }

  // pulls sample number, title, key, and bpm out of loop filenames
  function parseSampleFilename(filename) {
    if (!filename || typeof filename !== 'string') {
      return { sampleNumber: null, title: 'untitled', key: null, bpm: null };
    }
    const clean = filename.replace(/\.[^/.]+$/, '').trim();
    let working = clean.replace(/_/g, ' ');

    let sampleNumber = null;
    let bpm = null;
    let key = null;

    const numMatch = working.match(/(?:^|\s)#\s*(\d{1,4})\b/) || working.match(/^(\d{1,3})\s*[-–—]\s*/);
    if (numMatch) {
      sampleNumber = String(parseInt(numMatch[1], 10)).padStart(3, '0');
      working = working.replace(numMatch[0], ' ');
    }

    const bpmExplicitMatch = working.match(/\b(?:bpm\s*(\d{2,3}(?:\.\d+)?)|(\d{2,3}(?:\.\d+)?)\s*bpm)\b/i);
    if (bpmExplicitMatch) {
      bpm = parseFloat(bpmExplicitMatch[1] || bpmExplicitMatch[2]);
      working = working.replace(bpmExplicitMatch[0], ' ');
    }

    const keyRegex = /\b([A-G][#b]?)(?:\s*(major|minor|maj|min|moll|dur|m))?(?=[\s\-–—]|$)/i;
    const keyMatch = working.match(keyRegex);
    if (keyMatch && (keyMatch[2] || keyMatch[1].length > 1 || /\b(key|scale)\b/i.test(working))) {
      const root = keyMatch[1].charAt(0).toUpperCase() + keyMatch[1].slice(1).toLowerCase();
      const modeRaw = (keyMatch[2] || '').toLowerCase();
      const isMinor = modeRaw.startsWith('min') || modeRaw === 'm' || modeRaw === 'moll';
      key = root + (isMinor ? 'min' : 'maj');
      working = working.replace(keyMatch[0], ' ');
    }

    if (bpm === null) {
      const standaloneBpm = working.match(/\b([6-9]\d|1\d{2}|2[0-1]\d)\b/);
      if (standaloneBpm) {
        bpm = parseFloat(standaloneBpm[1]);
        working = working.replace(standaloneBpm[0], ' ');
      }
    }

    let title = working
      .replace(/[-–—]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!title) {
      title = clean.replace(/[-–—_]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    return { sampleNumber, title: title.toLowerCase(), key, bpm };
  }

  // detects beat-grid phase offset and optional tempo from audio onsets (for cut loops not starting on beat 1)
  function analyzeBeatAlignment(channelData, sampleRate, initialBpm = 120, opts = {}) {
    const safeSr = Math.max(8000, Number(sampleRate) || 44100);
    const totalFrames = channelData?.length || 0;
    if (totalFrames < safeSr * 0.5) {
      return { bpm: initialBpm, beatOffset: 0, downbeatOffset: 0 };
    }

    const hopRate = 100;
    const hop = Math.max(1, Math.round(safeSr / hopRate));
    const maxFrames = Math.min(totalFrames, Math.floor(45 * safeSr));
    const envLen = Math.floor(maxFrames / hop);
    if (envLen < 32) {
      return { bpm: initialBpm, beatOffset: 0, downbeatOffset: 0 };
    }

    const lowEnv = new Float32Array(envLen);
    const fullEnv = new Float32Array(envLen);
    const lpAlpha = Math.max(0.02, Math.min(0.95, 1 - Math.exp((-2 * Math.PI * 180) / safeSr)));
    let lp = 0;

    for (let e = 0; e < envLen; e++) {
      const f0 = e * hop;
      const f1 = Math.min(maxFrames, f0 + hop);
      const stride = Math.max(1, Math.floor((f1 - f0) / 16));
      let lowSq = 0;
      let fullSq = 0;
      let n = 0;
      for (let f = f0; f < f1; f += stride) {
        const s = channelData[f] || 0;
        lp += lpAlpha * (s - lp);
        lowSq += lp * lp;
        fullSq += s * s;
        n++;
      }
      lowEnv[e] = Math.sqrt(lowSq / Math.max(1, n));
      fullEnv[e] = Math.sqrt(fullSq / Math.max(1, n));
    }

    const rawFlux = new Float32Array(envLen);
    for (let i = 1; i < envLen; i++) {
      const dLow = Math.max(0, lowEnv[i] - lowEnv[i - 1]);
      const dFull = Math.max(0, fullEnv[i] - fullEnv[i - 1]);
      rawFlux[i] = dLow * 1.9 + dFull;
    }

    // subtract local moving baseline so sustained pads don't blur sharp transients
    const flux = new Float32Array(envLen);
    const winHalf = 18;
    for (let i = 0; i < envLen; i++) {
      const a = Math.max(0, i - winHalf);
      const b = Math.min(envLen - 1, i + winHalf);
      let sum = 0;
      for (let j = a; j <= b; j++) sum += rawFlux[j];
      const avg = sum / (b - a + 1);
      flux[i] = Math.max(0, rawFlux[i] - avg * 1.05);
    }

    let bpm = Math.max(40, Math.min(220, Number(initialBpm) || 120));
    if (opts.autoDetectBpm) {
      let bestTempo = bpm;
      let bestTempoScore = -Infinity;
      for (let cand = 70; cand <= 176; cand++) {
        const lag = (60 / cand) * hopRate;
        let score = 0;
        for (let i = 0; i < envLen; i++) {
          if (flux[i] <= 0) continue;
          const j1 = Math.round(i + lag);
          const j2 = Math.round(i + lag * 2);
          if (j1 < envLen) score += flux[i] * (flux[j1] + (j1 > 0 ? flux[j1 - 1] * 0.5 : 0) + (j1 + 1 < envLen ? flux[j1 + 1] * 0.5 : 0));
          if (j2 < envLen) score += flux[i] * flux[j2] * 0.6;
        }
        // gentle prior centering around 95..148 bpm avoids half/double-time octave flips
        const prior = Math.exp(-Math.pow((cand - 120) / 48, 2));
        const weighted = score * (0.85 + 0.15 * prior);
        if (weighted > bestTempoScore) {
          bestTempoScore = weighted;
          bestTempo = cand;
        }
      }
      if (bestTempoScore > 0) bpm = bestTempo;
    }

    const secPerBeat = 60 / bpm;
    const scorePhase = (phiSec) => {
      let score = 0;
      let ticks = 0;
      for (let t = phiSec; t < (envLen / hopRate) - 0.03; t += secPerBeat) {
        const idx = Math.round(t * hopRate);
        let localMax = 0;
        for (let d = -2; d <= 2; d++) {
          const k = idx + d;
          if (k >= 0 && k < envLen) {
            const w = 1 - Math.abs(d) * 0.28;
            localMax = Math.max(localMax, flux[k] * w);
          }
        }
        score += localMax;
        ticks++;
      }
      return ticks > 0 ? score / ticks : 0;
    };

    const steps = 120;
    let bestPhi = 0;
    let bestScore = -Infinity;
    for (let s = 0; s < steps; s++) {
      const phi = (s / steps) * secPerBeat;
      const sc = scorePhase(phi);
      if (sc > bestScore) {
        bestScore = sc;
        bestPhi = phi;
      }
    }

    // preserve exact 0.000 alignment when a clean loop already starts on beat 1
    const zeroScore = scorePhase(0);
    if ((bestPhi < 0.025 || secPerBeat - bestPhi < 0.025) && zeroScore >= bestScore * 0.92) {
      bestPhi = 0;
    }

    // resolve which beat of the 4-beat bar is the strongest downbeat (bar 1)
    let bestBarSlot = 0;
    let bestBarScore = -Infinity;
    let slot0Score = 0;
    const secPerBar = secPerBeat * 4;
    for (let m = 0; m < 4; m++) {
      const start = bestPhi + m * secPerBeat;
      let sc = 0;
      let bars = 0;
      for (let t = start; t < (envLen / hopRate) - 0.03; t += secPerBar) {
        const idx = Math.round(t * hopRate);
        let kick = 0;
        for (let d = -2; d <= 2; d++) {
          const k = idx + d;
          if (k >= 0 && k < envLen) {
            kick = Math.max(kick, flux[k] * 0.7 + lowEnv[k] * 0.3);
          }
        }
        sc += kick;
        bars++;
      }
      const meanSc = bars > 0 ? sc / bars : 0;
      if (m === 0) slot0Score = meanSc;
      if (meanSc > bestBarScore) {
        bestBarScore = meanSc;
        bestBarSlot = m;
      }
    }
    if (slot0Score >= bestBarScore * 0.92) {
      bestBarSlot = 0;
    }

    const beatOffset = Number(bestPhi.toFixed(4));
    const downbeatOffset = Number(((bestPhi + bestBarSlot * secPerBeat) % secPerBar).toFixed(4));
    return { bpm, beatOffset, downbeatOffset };
  }

  // decodes audio via web audio api, builds a 240-point rms envelope, and finds the drop bar
  async function analyzeAudioFileInBrowser(audioFile, initialBpm = 120, opts = {}) {
    const arrayBuffer = await audioFile.arrayBuffer();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioContextClass();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    await audioCtx.close();

    const duration = audioBuffer.duration;
    const sampleRate = audioBuffer.sampleRate;
    const channelData = audioBuffer.getChannelData(0);
    const totalFrames = channelData.length;

    const alignment = analyzeBeatAlignment(channelData, sampleRate, initialBpm, {
      autoDetectBpm: Boolean(opts.autoDetectBpm)
    });
    const bpm = alignment.bpm;
    const beatOffset = alignment.beatOffset;
    const downbeatOffset = alignment.downbeatOffset;

    const numPeaks = 240;
    const framesPerPeak = Math.max(1, Math.floor(totalFrames / numPeaks));
    const peaks = [];
    for (let i = 0; i < numPeaks; i++) {
      const start = i * framesPerPeak;
      const end = Math.min(totalFrames, start + framesPerPeak);
      const step = Math.max(1, Math.floor((end - start) / 64));
      let sumSq = 0;
      let count = 0;
      for (let f = start; f < end; f += step) {
        const s = channelData[f];
        sumSq += s * s;
        count++;
      }
      peaks.push(Math.sqrt(sumSq / Math.max(1, count)));
    }

    const maxPeak = Math.max(0.01, ...peaks);
    const normPeaks = peaks.map((p) => Number((p / maxPeak).toFixed(3)));

    // evaluate per-bar energy + low-end (<165hz) + crispness features aligned to detected downbeat
    const secPerBar = (60 / bpm) * 4;
    const totalBars = Math.max(2, Math.round(Math.max(0.5, duration - downbeatOffset) / secPerBar));
    const barEnergies = [];
    const rawBarRms = [];
    const rawBarLow = [];
    const rawBarCrisp = [];

    for (let b = 0; b < totalBars; b++) {
      const startSec = Math.min(duration, downbeatOffset + b * secPerBar);
      const endSec = Math.min(duration, downbeatOffset + (b + 1) * secPerBar);
      const pStart = Math.floor((startSec / duration) * normPeaks.length);
      const pEnd = Math.max(pStart + 1, Math.floor((endSec / duration) * normPeaks.length));
      let sum = 0;
      for (let i = pStart; i < pEnd && i < normPeaks.length; i++) {
        sum += normPeaks[i];
      }
      barEnergies.push(sum / (pEnd - pStart));

      const fStart = Math.max(0, Math.floor(startSec * sampleRate));
      const fEnd = Math.min(totalFrames, Math.max(fStart + 1, Math.floor(endSec * sampleRate)));
      const stride = Math.max(1, Math.min(16, Math.floor((fEnd - fStart) / 2048)));
      const effSr = sampleRate / stride;
      const lpAlpha = Math.max(0.02, Math.min(0.95, 1 - Math.exp((-2 * Math.PI * 165) / effSr)));
      let lp = 0;
      let prev = channelData[fStart] || 0;
      let sumSq = 0;
      let lowSq = 0;
      let diffSq = 0;
      let count = 0;
      for (let f = fStart; f < fEnd; f += stride) {
        const s = channelData[f];
        lp += lpAlpha * (s - lp);
        const d = s - prev;
        prev = s;
        sumSq += s * s;
        lowSq += lp * lp;
        diffSq += d * d;
        count++;
      }
      const invN = 1 / Math.max(1, count);
      const barRms = Math.sqrt(sumSq * invN);
      rawBarRms.push(barRms);
      rawBarLow.push(Math.sqrt(lowSq * invN));
      rawBarCrisp.push(barRms > 1e-5 ? Math.sqrt(diffSq * invN) / (barRms + 1e-4) : 0);
    }

    const maxBarRms = Math.max(0.001, ...rawBarRms);
    const maxBarLow = Math.max(0.001, ...rawBarLow);
    const maxBarCrisp = Math.max(0.001, ...rawBarCrisp);
    const barFeatures = rawBarRms.map((r, b) => ({
      bar: b + 1,
      time: Number(Math.min(duration, downbeatOffset + b * secPerBar).toFixed(3)),
      rms: Number((r / maxBarRms).toFixed(3)),
      low: Number((rawBarLow[b] / maxBarLow).toFixed(3)),
      crisp: Number((rawBarCrisp[b] / maxBarCrisp).toFixed(3))
    }));

    let bestBarIdx = Math.min(8, Math.floor(totalBars / 2));
    let bestScore = -Infinity;

    for (let b = 2; b < totalBars - 2; b++) {
      const ratio = b / totalBars;
      if (ratio < 0.2 || ratio > 0.75) continue;

      const beforeAvg =
        barEnergies.slice(Math.max(0, b - 4), b).reduce((a, c) => a + c, 0) /
        Math.min(4, b);
      const afterAvg =
        barEnergies.slice(b, Math.min(totalBars, b + 4)).reduce((a, c) => a + c, 0) /
        Math.min(4, totalBars - b);

      let jumpScore = afterAvg - beforeAvg * 0.85;
      if (b % 4 === 0) jumpScore *= 1.35;
      else if (b % 2 === 0) jumpScore *= 1.15;

      if (jumpScore > bestScore) {
        bestScore = jumpScore;
        bestBarIdx = b;
      }
    }

    const dropBar = bestBarIdx + 1;
    const dropTime = Number(Math.min(duration, downbeatOffset + bestBarIdx * secPerBar).toFixed(3));

    const impactTimes = [dropTime];
    const minImpactInterval = (60 / bpm) * 1.5;
    let lastImpact = dropTime;
    const startPeakIdx = Math.floor((dropTime / duration) * normPeaks.length);

    for (let i = startPeakIdx + 1; i < normPeaks.length - 1; i++) {
      const tSec = Number(((i / normPeaks.length) * duration).toFixed(3));
      if (tSec - lastImpact < minImpactInterval) continue;
      const delta = normPeaks[i] - normPeaks[i - 1];
      if (delta > 0.12 && normPeaks[i] > 0.42) {
        impactTimes.push(tSec);
        lastImpact = tSec;
      }
    }

    // rough zero-crossing pitch fallback if the user only drops an audio file without midi
    const fallbackNotes = [];
    const stepSec = 60 / bpm / 2;
    const totalSteps = Math.floor(Math.max(0, duration - beatOffset) / stepSec);
    for (let s = 0; s < totalSteps; s++) {
      const tSec = beatOffset + s * stepSec;
      const fStart = Math.floor(tSec * sampleRate);
      const winLen = Math.min(2048, totalFrames - fStart);
      if (winLen < 512) continue;

      let energy = 0;
      let zeroCrossings = 0;
      let prev = channelData[fStart];
      for (let i = 1; i < winLen; i++) {
        const cur = channelData[fStart + i];
        energy += cur * cur;
        if ((prev >= 0 && cur < 0) || (prev < 0 && cur >= 0)) zeroCrossings++;
        prev = cur;
      }
      const rms = Math.sqrt(energy / winLen);
      if (rms < maxPeak * 0.22) continue;

      const estFreq = Math.max(110, Math.min(1200, (zeroCrossings * sampleRate) / (2 * winLen)));
      const rawMidi = Math.round(69 + 12 * Math.log2(estFreq / 440));
      const clampedMidi = Math.max(48, Math.min(84, rawMidi));
      const beat = tSec * (bpm / 60);

      fallbackNotes.push({
        midi: clampedMidi,
        name: midiToNoteName(clampedMidi),
        beat: Number(beat.toFixed(4)),
        durationBeats: 0.5,
        time: Number(tSec.toFixed(4)),
        duration: Number(stepSec.toFixed(4)),
        velocity: Number(Math.min(1, rms / maxPeak).toFixed(3)),
        track: 'Audio Transcribed'
      });
    }

    const signalData = (typeof window !== 'undefined' && window.audioSignals?.analyzeAudioBuffer)
      ? window.audioSignals.analyzeAudioBuffer(audioBuffer)
      : null;

    const sections = detectTrackSections({
      duration: Number(duration.toFixed(3)),
      bpm,
      barFeatures,
      peaks: normPeaks,
      dropBar,
      dropTime
    });

    const result = {
      bpm,
      beatOffset,
      downbeatOffset,
      duration: Number(duration.toFixed(3)),
      dropTime,
      dropBar,
      peaks: normPeaks,
      barFeatures,
      sections,
      impactTimes,
      fallbackNotes
    };
    if (signalData) {
      Object.defineProperty(result, '_signalData', {
        enumerable: false,
        configurable: true,
        value: signalData
      });
    }
    return result;
  }

  // .als files are gzipped xml; gunzip via DecompressionStream and query MidiTrack nodes
  async function parseAlsFileInBrowser(alsFile, fallbackBpm = 120) {
    let xmlText = '';
    try {
      if (window.DecompressionStream) {
        const ds = new DecompressionStream('gzip');
        const decompressedStream = alsFile.stream().pipeThrough(ds);
        xmlText = await new Response(decompressedStream).text();
      } else {
        xmlText = await alsFile.text();
      }
    } catch {
      xmlText = await alsFile.text();
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');

    let effectiveBpm = fallbackBpm;
    const manualTempo = doc.querySelector('Tempo > Manual');
    if (manualTempo) {
      const v = parseFloat(manualTempo.getAttribute('Value'));
      if (Number.isFinite(v) && v > 30 && v < 300) {
        effectiveBpm = Math.round(v * 10) / 10;
      }
    }
    const secPerBeat = 60 / effectiveBpm;

    const tracks = [];
    const midiTracks = doc.querySelectorAll('MidiTrack');

    midiTracks.forEach((trNode, trIdx) => {
      const userNameNode = trNode.querySelector('Name > UserName');
      const effectiveNameNode = trNode.querySelector('Name > EffectiveName');
      const trackName =
        userNameNode?.getAttribute('Value') ||
        effectiveNameNode?.getAttribute('Value') ||
        `Track ${trIdx + 1}`;

      const notes = [];
      const midiClips = trNode.querySelectorAll('MidiClip');
      midiClips.forEach((clip) => {
        const clipCurrent = clip.querySelector('CurrentStart');
        const clipStartBeat = clipCurrent ? parseFloat(clipCurrent.getAttribute('Value')) || 0 : 0;

        const keyTracks = clip.querySelectorAll('KeyTrack');
        keyTracks.forEach((kt) => {
          const rootKeyNode = kt.querySelector('MidiKey');
          const midiNum = rootKeyNode ? parseInt(rootKeyNode.getAttribute('Value'), 10) : 60;

          const noteNodes = kt.querySelectorAll('MidiNoteEvent');
          noteNodes.forEach((n) => {
            const timeBeat = parseFloat(n.getAttribute('Time')) || 0;
            const durBeat = parseFloat(n.getAttribute('Duration')) || 0.5;
            const vel = parseFloat(n.getAttribute('Velocity')) || 100;

            const absBeat = clipStartBeat + timeBeat;
            const timeSec = absBeat * secPerBeat;
            const durSec = durBeat * secPerBeat;

            notes.push({
              midi: midiNum,
              name: midiToNoteName(midiNum),
              beat: Number(absBeat.toFixed(4)),
              durationBeats: Number(durBeat.toFixed(4)),
              time: Number(timeSec.toFixed(4)),
              duration: Number(durSec.toFixed(4)),
              velocity: Number((vel / 127).toFixed(3)),
              track: trackName
            });
          });
        });
      });

      if (notes.length > 0) {
        notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
        const minBeat = notes[0].beat;
        const maxBeat = Math.max(...notes.map((n) => n.beat + n.durationBeats));
        tracks.push({
          id: `als_${trIdx}_${trackName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
          name: trackName,
          noteCount: notes.length,
          startBar: Math.floor(minBeat / 4) + 1,
          endBar: Math.ceil(maxBeat / 4),
          defaultSelected: true,
          notes
        });
      }
    });

    const locators = [];
    const seenLocatorBeats = new Set();
    doc.querySelectorAll('Locators Locator').forEach((locNode) => {
      const timeVal = parseFloat(locNode.querySelector('Time')?.getAttribute('Value'));
      if (!Number.isFinite(timeVal) || timeVal < -0.05) return;
      const clampedBeat = Math.max(0, timeVal);
      const beatKey = Math.round(clampedBeat * 4);
      if (seenLocatorBeats.has(beatKey)) return;
      seenLocatorBeats.add(beatKey);
      const rawName =
        locNode.querySelector('Name')?.getAttribute('Value') ||
        locNode.querySelector('Annotation')?.getAttribute('Value') ||
        '';
      locators.push({
        bar: Math.floor(clampedBeat / 4) + 1,
        beat: Number(clampedBeat.toFixed(4)),
        time: Number((clampedBeat * secPerBeat).toFixed(3)),
        name: String(rawName).trim()
      });
    });
    locators.sort((a, b) => a.time - b.time);

    return {
      sourceType: 'als',
      bpm: effectiveBpm,
      tracks,
      locators
    };
  }

  // binary smf (.mid) parser
  async function parseMidiFileInBrowser(midiFile, fallbackBpm = 120) {
    const buffer = await midiFile.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let pos = 0;

    function readStr(len) {
      let s = '';
      for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[pos++]);
      return s;
    }
    function readU16() {
      const v = (bytes[pos] << 8) | bytes[pos + 1];
      pos += 2;
      return v;
    }
    function readU32() {
      const v = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
      pos += 4;
      return v >>> 0;
    }
    function readVlq() {
      let v = 0;
      while (pos < bytes.length) {
        const b = bytes[pos++];
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return v;
    }

    if (readStr(4) !== 'MThd') {
      return { sourceType: 'midi', bpm: fallbackBpm, tracks: [] };
    }
    readU32(); // header length
    readU16(); // format
    const numTracks = readU16();
    const division = readU16();
    const ticksPerBeat = division & 0x8000 ? 480 : division;

    let bpm = fallbackBpm;
    let usPerQuarter = 500000;

    const tracks = [];

    for (let t = 0; t < numTracks && pos < bytes.length; t++) {
      if (readStr(4) !== 'MTrk') break;
      const trackLen = readU32();
      const trackEnd = pos + trackLen;

      let tick = 0;
      let lastStatus = 0;
      let trackName = `Track ${t + 1}`;
      const activeNotes = new Map();
      const notes = [];

      while (pos < trackEnd && pos < bytes.length) {
        const delta = readVlq();
        tick += delta;

        let status = bytes[pos];
        if (status >= 0x80) {
          pos++;
          lastStatus = status;
        } else {
          status = lastStatus;
        }

        const type = status & 0xf0;

        if (status === 0xff) {
          const metaType = bytes[pos++];
          const metaLen = readVlq();
          if (metaType === 0x03) {
            trackName = '';
            for (let i = 0; i < metaLen; i++) trackName += String.fromCharCode(bytes[pos++]);
          } else if (metaType === 0x51 && metaLen === 3) {
            usPerQuarter = (bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2];
            pos += 3;
            bpm = Math.round((60000000 / usPerQuarter) * 10) / 10;
          } else {
            pos += metaLen;
          }
        } else if (type === 0x90) {
          const midi = bytes[pos++];
          const vel = bytes[pos++];
          if (vel > 0) {
            activeNotes.set(midi, { startTick: tick, vel });
          } else {
            // velocity 0 note-on acts as note-off in running status streams
            const on = activeNotes.get(midi);
            if (on) {
              activeNotes.delete(midi);
              const durTicks = Math.max(1, tick - on.startTick);
              const beat = on.startTick / ticksPerBeat;
              const durBeats = durTicks / ticksPerBeat;
              const secPerBeat = 60 / bpm;
              notes.push({
                midi,
                name: midiToNoteName(midi),
                beat: Number(beat.toFixed(4)),
                durationBeats: Number(durBeats.toFixed(4)),
                time: Number((beat * secPerBeat).toFixed(4)),
                duration: Number((durBeats * secPerBeat).toFixed(4)),
                velocity: Number((on.vel / 127).toFixed(3)),
                track: trackName
              });
            }
          }
        } else if (type === 0x80) {
          const midi = bytes[pos++];
          pos++; // release velocity
          const on = activeNotes.get(midi);
          if (on) {
            activeNotes.delete(midi);
            const durTicks = Math.max(1, tick - on.startTick);
            const beat = on.startTick / ticksPerBeat;
            const durBeats = durTicks / ticksPerBeat;
            const secPerBeat = 60 / bpm;
            notes.push({
              midi,
              name: midiToNoteName(midi),
              beat: Number(beat.toFixed(4)),
              durationBeats: Number(durBeats.toFixed(4)),
              time: Number((beat * secPerBeat).toFixed(4)),
              duration: Number((durBeats * secPerBeat).toFixed(4)),
              velocity: Number((on.vel / 127).toFixed(3)),
              track: trackName
            });
          }
        } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
          pos += 2;
        } else if (type === 0xc0 || type === 0xd0) {
          pos += 1;
        } else if (status === 0xf0 || status === 0xf7) {
          const sysLen = readVlq();
          pos += sysLen;
        }
      }

      pos = trackEnd;

      if (notes.length > 0) {
        notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
        const minBeat = notes[0].beat;
        const maxBeat = Math.max(...notes.map((n) => n.beat + n.durationBeats));
        tracks.push({
          id: `mid_${t}_${trackName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
          name: trackName,
          noteCount: notes.length,
          startBar: Math.floor(minBeat / 4) + 1,
          endBar: Math.ceil(maxBeat / 4),
          defaultSelected: true,
          notes
        });
      }
    }

    return {
      sourceType: 'midi',
      bpm,
      tracks
    };
  }

  // finds chord change timestamps after the drop from bass/root tracks, chord tracks, or 2-bar intervals
  function extractChordCutTimes(tracks = [], dropTime = null, bpm = 120, duration = 30.0) {
    const effectiveBpm = bpm || 120;
    const effectiveDur = duration || 30.0;
    const effectiveDrop = (typeof dropTime === 'number' && !isNaN(dropTime)) ? dropTime : (effectiveDur * 0.5);
    const minInterval = (60 / effectiveBpm) * 1.8;

    const rootTrack = (tracks || []).find(
      (t) =>
        /bass|808|sub|root/i.test(t.name) &&
        t.notes &&
        t.notes.some((n) => n.time >= effectiveDrop - 0.25)
    );
    if (rootTrack) {
      const onsets = [];
      const notes = rootTrack.notes
        .filter((n) => n.time >= effectiveDrop - 0.25)
        .sort((a, b) => a.time - b.time);
      let lastTime = -999;
      for (const n of notes) {
        if (n.time - lastTime >= minInterval) {
          onsets.push(Number(n.time.toFixed(3)));
          lastTime = n.time;
        }
      }
      if (onsets.length >= 2) {
        if (Math.abs(onsets[0] - effectiveDrop) < 0.3) onsets[0] = effectiveDrop;
        else if (onsets[0] > effectiveDrop + 0.3) onsets.unshift(effectiveDrop);
        return onsets;
      }
    }

    const chordTrack = (tracks || []).find(
      (t) =>
        /chord|harmony|keys|pad|piano|rhodes/i.test(t.name) &&
        t.notes &&
        t.notes.some((n) => n.time >= effectiveDrop - 0.25)
    );
    if (chordTrack) {
      const onsets = [];
      const notes = chordTrack.notes
        .filter((n) => n.time >= effectiveDrop - 0.25)
        .sort((a, b) => a.time - b.time);
      let lastTime = -999;
      let lastMidi = -1;
      for (const n of notes) {
        if (n.time - lastTime >= minInterval && n.midi !== lastMidi) {
          onsets.push(Number(n.time.toFixed(3)));
          lastTime = n.time;
          lastMidi = n.midi;
        }
      }
      if (onsets.length >= 2) {
        if (Math.abs(onsets[0] - effectiveDrop) < 0.3) onsets[0] = effectiveDrop;
        else if (onsets[0] > effectiveDrop + 0.3) onsets.unshift(effectiveDrop);
        return onsets;
      }
    }

    const barSec = (60 / effectiveBpm) * 4;
    const cuts = [];
    for (let t = effectiveDrop; t < effectiveDur - 0.5; t += barSec * 2) {
      cuts.push(Number(t.toFixed(3)));
    }
    return cuts.length > 0 ? cuts : [effectiveDrop];
  }

  // computes macro-harmonic chord progression timeline across song bars
  // analyzes bar intervals and pitch sets to detect steady chords (e.g. Bmaj7, G#m7)
  function computeChordTimelineMarkers(project) {
    if (!project) return [];
    const bpm = project.bpm || 120;
    const duration = project.duration || 30.0;
    const dropTime = typeof project.dropTime === 'number' ? project.dropTime : duration * 0.5;

    const notePool = [];
    const tracks = project.tracks || [];
    for (const tr of tracks) {
      if (tr.notes && Array.isArray(tr.notes)) {
        for (const n of tr.notes) {
          notePool.push({
            midi: n.midi !== undefined ? n.midi : (n.pitch !== undefined ? n.pitch : 60),
            time: n.time !== undefined ? n.time : (n.startTime !== undefined ? n.startTime : 0),
            duration: n.duration !== undefined ? n.duration : 0.5
          });
        }
      }
    }

    if (notePool.length === 0) return [];

    const rawTimes = [];
    const cuts = project.chordCutTimes || [];
    if (cuts.length >= 2) {
      for (const c of cuts) {
        rawTimes.push(c);
        let introT = c - dropTime;
        while (introT >= -0.05) {
          rawTimes.push(Math.max(0, Number(introT.toFixed(3))));
          introT -= dropTime;
        }
      }
      rawTimes.push(0);
    } else {
      rawTimes.push(0);
      const lowNotes = notePool.filter((n) => n.midi < 55);
      const minInterval = (60 / bpm) * 2.5;
      let lastLowT = -999;
      for (const n of lowNotes) {
        if (n.time - lastLowT >= minInterval) {
          rawTimes.push(Number(n.time.toFixed(3)));
          lastLowT = n.time;
        }
      }
    }

    rawTimes.sort((a, b) => a - b);
    const mergedTimes = [];
    for (const t of rawTimes) {
      if (t < 0 || t > duration - 0.25) continue;
      const hasExisting = mergedTimes.some((m) => Math.abs(m - t) < 0.35);
      if (!hasExisting) {
        mergedTimes.push(t);
      }
    }
    mergedTimes.sort((a, b) => a - b);

    const keyStr = (project.key || '').toLowerCase();
    const isFlatKey = /([a-g]b|bb|eb|ab|db|gb|f\b|d min|g min|c min)/i.test(keyStr);
    const NOTE_NAMES = isFlatKey
      ? ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
      : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

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

    function scoreChordRoot(root, pitchSet, isBassRoot) {
      let bestName = null;
      let bestScore = -999;
      for (const type of CHORD_TYPES) {
        let matched = 0;
        let missed = 0;
        for (const interval of type.intervals) {
          const pitch = (root + interval) % 12;
          if (pitchSet.has(pitch)) matched++;
          else missed++;
        }
        const minReq = isBassRoot ? 2 : Math.min(3, type.intervals.length);
        if (matched < minReq) continue;
        // slight preference for root position and complete voicings
        const extraPenalty = Math.max(0, pitchSet.size - matched) * 0.25;
        const score = (matched * 2.4 - missed * 0.85 - extraPenalty) * type.weight - (isBassRoot ? 0 : 0.75);
        if (score > bestScore) {
          bestScore = score;
          bestName = NOTE_NAMES[root] + type.name;
        }
      }
      return { name: bestName, score: bestScore };
    }

    function detectChordAt(t) {
      const active = notePool.filter((n) =>
        (n.time >= t - 0.08 && n.time <= t + 0.35) ||
        (n.time <= t + 0.02 && n.time + n.duration >= t + 0.12)
      );
      if (active.length === 0) return null;

      const sorted = [...active].sort((a, b) => a.midi - b.midi);
      const bassMidi = sorted[0].midi;
      const bassRoot = bassMidi % 12;
      const pitchSet = new Set(active.map((n) => n.midi % 12));

      const bassCandidate = scoreChordRoot(bassRoot, pitchSet, true);
      let bestChord = bassCandidate.name;
      let bestScore = bassCandidate.score;

      for (const root of pitchSet) {
        if (root === bassRoot) continue;
        const slashCandidate = scoreChordRoot(root, pitchSet, false);
        if (slashCandidate.name && slashCandidate.score > bestScore && (bestScore < 2.2 || slashCandidate.score > bestScore + 0.55)) {
          bestScore = slashCandidate.score;
          bestChord = `${slashCandidate.name}/${NOTE_NAMES[bassRoot]}`;
        }
      }

      return bestChord || (NOTE_NAMES[bassRoot] + 'maj');
    }

    const markers = [];
    let lastChord = null;
    let lastTime = -999;

    for (const t of mergedTimes) {
      const chordName = detectChordAt(t);
      if (!chordName) continue;
      if (chordName === lastChord && t - lastTime < 1.3) continue;
      const rootMatch = chordName.match(/^[A-G][#b]?/i);
      const root = rootMatch ? rootMatch[0] : chordName.charAt(0);
      markers.push({ time: t, name: chordName, root });
      lastChord = chordName;
      lastTime = t;
    }

    return markers;
  }

  const SECTION_COLORS = {
    intro: '#7aa6c2',
    build: '#e2a856',
    verse: '#9b8ec4',
    drop: '#83ca90',
    bridge: '#e087a1',
    outro: '#6d8a96',
    main: '#83ca90'
  };

  function inferSectionTypeFromLabel(label) {
    const s = String(label || '').toLowerCase();
    if (!s) return 'verse';
    if (/(intro|opening|start)/.test(s)) return 'intro';
    if (/(build|pre[- ]?drop|riser|lift|pre[- ]?chorus)/.test(s)) return 'build';
    if (/(drop|chorus|hook|climax|main)/.test(s)) return 'drop';
    if (/(bridge|break|breakdown|interlude|solo)/.test(s)) return 'bridge';
    if (/(outro|end|ending|fade)/.test(s)) return 'outro';
    if (/(verse|part|groove)/.test(s)) return 'verse';
    return 'verse';
  }

  function buildBarFeaturesFromPeaks(peaks, totalBars, duration, secPerBar) {
    const normPeaks = Array.isArray(peaks) && peaks.length > 0 ? peaks : [0.5];
    const features = [];
    let maxRms = 0.001;
    for (let b = 0; b < totalBars; b++) {
      const startSec = b * secPerBar;
      const endSec = Math.min(duration, (b + 1) * secPerBar);
      const pStart = Math.floor((startSec / duration) * normPeaks.length);
      const pEnd = Math.max(pStart + 1, Math.floor((endSec / duration) * normPeaks.length));
      let sum = 0;
      let diffSum = 0;
      for (let i = pStart; i < pEnd && i < normPeaks.length; i++) {
        sum += Number(normPeaks[i]) || 0;
        if (i > 0) diffSum += Math.abs((Number(normPeaks[i]) || 0) - (Number(normPeaks[i - 1]) || 0));
      }
      const n = Math.max(1, pEnd - pStart);
      const rms = sum / n;
      if (rms > maxRms) maxRms = rms;
      features.push({
        bar: b + 1,
        time: Number(startSec.toFixed(3)),
        rms,
        low: rms,
        crisp: Math.min(1, (diffSum / n) * 2.5)
      });
    }
    for (const f of features) {
      f.rms = Number((f.rms / maxRms).toFixed(3));
      f.low = Number((f.low / maxRms).toFixed(3));
    }
    return features;
  }

  function finalizeSectionSegments(rawSegments, totalBars, duration, secPerBar, barFeatures, source) {
    const typeCounts = {};
    rawSegments.forEach((seg) => {
      typeCounts[seg.type] = (typeCounts[seg.type] || 0) + 1;
    });
    const seenCounts = {};
    const usedIds = new Set();

    return rawSegments.map((seg, idx) => {
      const next = rawSegments[idx + 1];
      const startBar = Math.max(1, Math.min(totalBars, seg.startBar));
      const endBar = next ? Math.max(startBar, next.startBar - 1) : totalBars;
      const startTime = Number((typeof seg.time === 'number' ? seg.time : (startBar - 1) * secPerBar).toFixed(3));
      const endTime = Number((next ? (typeof next.time === 'number' ? next.time : (next.startBar - 1) * secPerBar) : duration).toFixed(3));

      const slice = barFeatures.slice(startBar - 1, endBar);
      const avgRms = slice.length ? slice.reduce((a, f) => a + f.rms, 0) / slice.length : 0.5;
      const avgLow = slice.length ? slice.reduce((a, f) => a + f.low, 0) / slice.length : avgRms;

      seenCounts[seg.type] = (seenCounts[seg.type] || 0) + 1;
      const occ = seenCounts[seg.type];
      const multi = typeCounts[seg.type] > 1;
      const label = seg.customLabel || (multi ? `${seg.type} ${occ}` : seg.type);
      let id = occ === 1 ? seg.type : `${seg.type}_${occ}`;
      while (usedIds.has(id)) {
        id = `${seg.type}_${idx + 1}`;
      }
      usedIds.add(id);

      return {
        id,
        type: seg.type,
        label,
        bar: startBar,
        time: startTime,
        endBar,
        endTime,
        duration: Number(Math.max(0.001, endTime - startTime).toFixed(3)),
        color: SECTION_COLORS[seg.type] || SECTION_COLORS.verse,
        energy: Number(avgRms.toFixed(3)),
        lowEnergy: Number(avgLow.toFixed(3)),
        source
      };
    });
  }

  function detectTrackSections(input = {}) {
    const duration = Math.max(1, Number(input.duration) || 30);
    const bpm = Math.max(40, Math.min(240, Number(input.bpm) || 120));
    const secPerBar = (60 / bpm) * 4;
    const totalBars = Math.max(2, Math.round(duration / secPerBar));
    const barFeatures = Array.isArray(input.barFeatures) && input.barFeatures.length >= 2
      ? input.barFeatures
      : buildBarFeaturesFromPeaks(input.peaks, totalBars, duration, secPerBar);

    const locators = Array.isArray(input.locators)
      ? input.locators.filter((loc) => loc && Number.isFinite(loc.time) && loc.time >= 0 && loc.time < duration - secPerBar * 0.4)
      : [];

    if (locators.length >= 2 || (locators.length === 1 && locators[0].time > secPerBar * 0.6)) {
      const rawLocSegs = [];
      if (locators[0].time > secPerBar * 0.6) {
        rawLocSegs.push({
          startBar: 1,
          time: 0,
          type: 'intro',
          customLabel: 'intro'
        });
      }
      for (const loc of locators) {
        const type = inferSectionTypeFromLabel(loc.name);
        rawLocSegs.push({
          startBar: Math.max(1, Math.min(totalBars, loc.bar || Math.floor(loc.time / secPerBar) + 1)),
          time: loc.time,
          type,
          customLabel: loc.name || type
        });
      }
      return finalizeSectionSegments(rawLocSegs, totalBars, duration, secPerBar, barFeatures, 'als');
    }

    const rmsVals = barFeatures.map((f) => f.rms);
    const sortedRms = [...rmsVals].sort((a, b) => a - b);
    const medianRms = sortedRms[Math.floor(sortedRms.length * 0.5)] || 0.5;
    const peakRms = sortedRms[sortedRms.length - 1] || 1;
    const minRms = sortedRms[0] || 0;
    const energySpread = peakRms - minRms;

    // per-bar midi track entrance/exit count boosts structural boundaries when available
    const trackEventsByBar = new Array(totalBars + 2).fill(0);
    if (Array.isArray(input.tracks)) {
      for (const tr of input.tracks) {
        if (!tr) continue;
        if (tr.startBar >= 1 && tr.startBar <= totalBars) trackEventsByBar[tr.startBar - 1] += 1;
        if (tr.endBar >= 1 && tr.endBar < totalBars) trackEventsByBar[tr.endBar] += 1;
      }
    }
    const maxTrackEvents = Math.max(0, ...trackEventsByBar);

    const dropBar = Number(input.dropBar) > 1 && Number(input.dropBar) <= totalBars
      ? Number(input.dropBar)
      : null;

    if (energySpread < 0.14 && maxTrackEvents === 0) {
      return finalizeSectionSegments(
        [{ startBar: 1, time: 0, type: 'main', customLabel: 'main' }],
        totalBars,
        duration,
        secPerBar,
        barFeatures,
        'audio'
      );
    }

    const minSegBars = totalBars >= 48 ? 8 : (totalBars >= 12 ? 4 : 2);
    const gridBars = totalBars >= 32 ? 4 : (totalBars >= 12 ? 4 : 2);
    const winBars = totalBars >= 32 ? 4 : Math.max(2, Math.floor(minSegBars));
    const maxSections = totalBars >= 48 ? 8 : (totalBars >= 16 ? 5 : 3);

    const candidates = [];
    for (let b = minSegBars; b <= totalBars - minSegBars; b++) {
      const isDropBoundary = dropBar !== null && (b + 1) === dropBar;
      const isGridBoundary = b % gridBars === 0;
      const hasTrackChange = trackEventsByBar[b] > 0;
      if (!isDropBoundary && !isGridBoundary && !hasTrackChange) continue;

      const beforeSlice = barFeatures.slice(Math.max(0, b - winBars), b);
      const afterSlice = barFeatures.slice(b, Math.min(totalBars, b + winBars));
      if (!beforeSlice.length || !afterSlice.length) continue;

      const avg = (arr, k) => arr.reduce((a, f) => a + f[k], 0) / arr.length;
      const dRms = Math.abs(avg(afterSlice, 'rms') - avg(beforeSlice, 'rms'));
      const dLow = Math.abs(avg(afterSlice, 'low') - avg(beforeSlice, 'low'));
      const dCrisp = Math.abs(avg(afterSlice, 'crisp') - avg(beforeSlice, 'crisp'));
      const midiBoost = (trackEventsByBar[b] || 0) * 0.28;
      let score = dRms * 1.1 + dLow * 0.9 + dCrisp * 0.45 + midiBoost;
      if (b % 8 === 0) score *= 1.2;
      else if (b % 4 === 0) score *= 1.08;
      if (isDropBoundary) score = Math.max(score * 1.3, 0.35);

      if (score >= 0.2) {
        candidates.push({ barIdx: b, score, isDropBoundary });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const picked = [0];
    for (const c of candidates) {
      if (picked.length >= maxSections) break;
      const tooClose = picked.some((p) => Math.abs(p - c.barIdx) < minSegBars);
      if (tooClose) continue;
      if (totalBars - c.barIdx < Math.max(2, Math.floor(minSegBars * 0.75))) continue;
      picked.push(c.barIdx);
    }
    picked.sort((a, b) => a - b);

    const segStats = picked.map((startIdx, idx) => {
      const endIdx = idx + 1 < picked.length ? picked[idx + 1] : totalBars;
      const slice = barFeatures.slice(startIdx, endIdx);
      const n = Math.max(1, slice.length);
      return {
        startBar: startIdx + 1,
        endBar: endIdx,
        rms: slice.reduce((a, f) => a + f.rms, 0) / n,
        low: slice.reduce((a, f) => a + f.low, 0) / n,
        crisp: slice.reduce((a, f) => a + f.crisp, 0) / n
      };
    });

    const maxSegRms = Math.max(0.01, ...segStats.map((s) => s.rms));
    const maxSegLow = Math.max(0.01, ...segStats.map((s) => s.low));

    const typedSegments = segStats.map((s) => ({
      startBar: s.startBar,
      time: Number(((s.startBar - 1) * secPerBar).toFixed(3)),
      type: 'verse'
    }));

    if (typedSegments.length === 1) {
      typedSegments[0].type = 'main';
    } else {
      let seenDrop = false;
      for (let i = 0; i < segStats.length; i++) {
        const s = segStats[i];
        const next = segStats[i + 1];
        const prev = segStats[i - 1];
        const isLast = i === segStats.length - 1;
        const containsDropBar = dropBar !== null && s.startBar <= dropBar && s.endBar >= dropBar && s.rms >= maxSegRms * 0.65;
        const isHighDrop = (s.rms >= maxSegRms * 0.76 && s.low >= maxSegLow * 0.72) || (containsDropBar && (!prev || s.rms > prev.rms * 1.15));

        if (i === 0 && !isHighDrop && s.rms < maxSegRms * 0.85) {
          typedSegments[i].type = 'intro';
        } else if (isLast && i >= 2 && s.rms < prev.rms * 0.82 && s.rms < maxSegRms * 0.7) {
          typedSegments[i].type = 'outro';
        } else if (isHighDrop) {
          typedSegments[i].type = 'drop';
          seenDrop = true;
        } else if (
          next &&
          ((next.rms >= maxSegRms * 0.76 && next.low >= maxSegLow * 0.72) || (dropBar !== null && next.startBar === dropBar)) &&
          s.low < next.low * 0.78 &&
          i > 0
        ) {
          typedSegments[i].type = 'build';
        } else if (seenDrop && (s.low < maxSegLow * 0.56 || s.rms < maxSegRms * 0.62) && (!next || next.rms > s.rms * 1.12)) {
          typedSegments[i].type = 'bridge';
        } else if (i === 0 && !isHighDrop && medianRms > 0) {
          typedSegments[i].type = 'intro';
        } else {
          typedSegments[i].type = 'verse';
        }
      }

      // synchronize explicit first drop section time cleanly with dropTime when after bar 1
      const firstDrop = typedSegments.find((seg, idx) => idx > 0 && seg.type === 'drop');
      if (firstDrop && Number.isFinite(Number(input.dropTime)) && dropBar !== null && Math.abs(firstDrop.startBar - dropBar) <= 1) {
        firstDrop.startBar = dropBar;
        firstDrop.time = Number(Number(input.dropTime).toFixed(3));
      }
    }

    return finalizeSectionSegments(
      typedSegments,
      totalBars,
      duration,
      secPerBar,
      barFeatures,
      maxTrackEvents > 0 ? 'audio+midi' : 'audio'
    );
  }

  const exportedApi = {
    parseSampleFilename,
    analyzeBeatAlignment,
    analyzeAudioFileInBrowser,
    parseAlsFileInBrowser,
    parseMidiFileInBrowser,
    extractChordCutTimes,
    computeChordTimelineMarkers,
    detectTrackSections
  };

  if (typeof window !== 'undefined') {
    window.clientAnalyzer = exportedApi;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportedApi;
  }
})();

