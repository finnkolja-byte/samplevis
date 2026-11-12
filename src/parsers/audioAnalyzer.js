const fs = require('fs');
const path = require('path');
const { midiToNoteName } = require('./alsParser');

// parses sample index, title, key, and bpm out of producer loop filenames
// e.g. "#1 - meadows - bmaj - 132bpm.wav"
function parseSampleFilename(filename) {
  if (!filename || typeof filename !== 'string') {
    return { sampleNumber: null, title: 'untitled', key: null, bpm: null };
  }
  const clean = path.basename(filename, path.extname(filename)).trim();
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

  // bare number in typical tempo range if "bpm" wasn't written out
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

// reads wav headers & pcm data to build the 240-point waveform envelope,
// find the main structural drop bar, and approximate notes if no midi/als was dropped
function analyzeWavFile(filePath, bpm = 120) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    return {
      duration: 0,
      dropTime: 0,
      dropBar: 1,
      peaks: new Array(160).fill(0),
      fallbackNotes: []
    };
  }

  let offset = 12;
  let audioFormat = 1;
  let numChannels = 2;
  let sampleRate = 44100;
  let bitsPerSample = 16;
  let dataOffset = 44;
  let dataSize = buf.length - 44;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      audioFormat = buf.readUInt16LE(offset + 8);
      numChannels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.min(chunkSize, buf.length - dataOffset);
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  const bytesPerSample = Math.max(1, Math.floor(bitsPerSample / 8));
  const frameSize = bytesPerSample * numChannels;
  const totalFrames = Math.floor(dataSize / frameSize);
  const duration = totalFrames / sampleRate;

  function readMonoFrame(frameIdx) {
    const pos = dataOffset + frameIdx * frameSize;
    if (pos + bytesPerSample > buf.length) return 0;
    if (audioFormat === 3 && bitsPerSample === 32) {
      return Math.max(-1, Math.min(1, buf.readFloatLE(pos)));
    }
    if (bitsPerSample === 16) {
      return buf.readInt16LE(pos) / 32768;
    }
    if (bitsPerSample === 24) {
      let val = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
      if (val & 0x800000) val |= ~0xffffff;
      return val / 8388608;
    }
    if (bitsPerSample === 32) {
      return buf.readInt32LE(pos) / 2147483648;
    }
    return 0;
  }

  // downsample into 240 rms windows for the timeline bar graph
  const numPeaks = 240;
  const framesPerPeak = Math.max(1, Math.floor(totalFrames / numPeaks));
  const peaks = [];
  for (let i = 0; i < numPeaks; i++) {
    const startFrame = i * framesPerPeak;
    const step = Math.max(1, Math.floor(framesPerPeak / 64));
    let sumSq = 0;
    let count = 0;
    for (let f = startFrame; f < startFrame + framesPerPeak && f < totalFrames; f += step) {
      const s = readMonoFrame(f);
      sumSq += s * s;
      count++;
    }
    peaks.push(Number(Math.sqrt(sumSq / Math.max(1, count)).toFixed(4)));
  }

  const maxPeak = Math.max(0.01, ...peaks);
  const normPeaks = peaks.map((p) => Number((p / maxPeak).toFixed(3)));

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

  // find the biggest energy jump between 20% and 75% of the loop, weighting 4-bar boundaries
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

  // rough zero-crossing pitch + onset fallback when only a wav is loaded without midi
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
    let prev = readMonoFrame(fStart);
    for (let i = 1; i < winLen; i++) {
      const cur = readMonoFrame(fStart + i);
      energy += cur * cur;
      if ((prev >= 0 && cur < 0) || (prev < 0 && cur >= 0)) {
        zeroCrossings++;
      }
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

  // transient spikes after the drop for impact-cut mode
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

  return {
    duration: Number(duration.toFixed(3)),
    dropTime,
    dropBar,
    peaks: normPeaks,
    fallbackNotes,
    impactTimes
  };
}

module.exports = {
  parseSampleFilename,
  analyzeWavFile
};

