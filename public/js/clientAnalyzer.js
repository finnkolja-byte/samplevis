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

  // decodes audio via web audio api, builds a 240-point rms envelope, and finds the drop bar
  async function analyzeAudioFileInBrowser(audioFile, bpm = 120) {
    const arrayBuffer = await audioFile.arrayBuffer();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioContextClass();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    await audioCtx.close();

    const duration = audioBuffer.duration;
    const sampleRate = audioBuffer.sampleRate;
    const channelData = audioBuffer.getChannelData(0);
    const totalFrames = channelData.length;

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

    // evaluate bar-to-bar energy jumps, weighting 4-bar phrase boundaries
    const secPerBar = (60 / bpm) * 4;
    const totalBars = Math.max(2, Math.round(duration / secPerBar));
    const barEnergies = [];

    for (let b = 0; b < totalBars; b++) {
      const startSec = b * secPerBar;
      const endSec = Math.min(duration, (b + 1) * secPerBar);
      const pStart = Math.floor((startSec / duration) * normPeaks.length);
      const pEnd = Math.max(pStart + 1, Math.floor((endSec / duration) * normPeaks.length));
      let sum = 0;
      for (let i = pStart; i < pEnd && i < normPeaks.length; i++) {
        sum += normPeaks[i];
      }
      barEnergies.push(sum / (pEnd - pStart));
    }

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
    const dropTime = Number((bestBarIdx * secPerBar).toFixed(3));

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
    const totalSteps = Math.floor(duration / stepSec);
    for (let s = 0; s < totalSteps; s++) {
      const tSec = s * stepSec;
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

    return {
      duration: Number(duration.toFixed(3)),
      dropTime,
      dropBar,
      peaks: normPeaks,
      impactTimes,
      fallbackNotes
    };
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

    return {
      sourceType: 'als',
      bpm: effectiveBpm,
      tracks
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
      { name: 'maj7', intervals: [0, 4, 7, 11], weight: 1.30 },
      { name: 'm7', intervals: [0, 3, 7, 10], weight: 1.30 },
      { name: '7', intervals: [0, 4, 7, 10], weight: 1.20 },
      { name: 'maj9', intervals: [0, 4, 7, 11, 2], weight: 1.35 },
      { name: 'add9', intervals: [0, 4, 7, 2], weight: 1.25 },
      { name: 'maj', intervals: [0, 4, 7], weight: 1.15 },
      { name: 'm', intervals: [0, 3, 7], weight: 1.15 },
      { name: 'sus4', intervals: [0, 5, 7], weight: 1.05 },
      { name: 'sus2', intervals: [0, 2, 7], weight: 1.05 },
      { name: 'dim', intervals: [0, 3, 6], weight: 0.90 },
      { name: '5', intervals: [0, 7], weight: 0.85 }
    ];

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

      let bestChord = null;
      let bestScore = -999;

      for (const type of CHORD_TYPES) {
        let matched = 0;
        let missed = 0;
        for (const interval of type.intervals) {
          const pitch = (bassRoot + interval) % 12;
          if (pitchSet.has(pitch)) matched++;
          else missed++;
        }
        const score = (matched * 2.5 - missed * 0.8) * type.weight;
        if (matched >= 2 && score > bestScore) {
          bestScore = score;
          const label = type.name === 'maj9' ? 'maj7' : type.name;
          bestChord = NOTE_NAMES[bassRoot] + label;
        }
      }

      if (bestChord && bestScore >= 2.0) {
        return bestChord;
      }

      for (const root of pitchSet) {
        if (root === bassRoot) continue;
        for (const type of CHORD_TYPES) {
          let matched = 0;
          let missed = 0;
          for (const interval of type.intervals) {
            const pitch = (root + interval) % 12;
            if (pitchSet.has(pitch)) matched++;
            else missed++;
          }
          const score = (matched * 2.0 - missed * 1.0) * type.weight;
          if (matched >= 3 && score > bestScore) {
            bestScore = score;
            const label = type.name === 'maj9' ? 'maj7' : type.name;
            bestChord = NOTE_NAMES[root] + label;
          }
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

  window.clientAnalyzer = {
    parseSampleFilename,
    analyzeAudioFileInBrowser,
    parseAlsFileInBrowser,
    parseMidiFileInBrowser,
    extractChordCutTimes,
    computeChordTimelineMarkers
  };
})();

