const fs = require('fs');
const path = require('path');
const { midiToNoteName } = require('./alsParser');

/**
 * Extracts sample number, title, key, and BPM from filenames like:
 * "#1 - meadows - bmaj - 132bpm.wav"
 */
function parseSampleFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  let sampleNumber = '001';
  let title = base;
  let key = 'Bmaj';
  let bpm = 132;

  const numMatch = base.match(/#?\s*(\d+)/);
  if (numMatch) {
    sampleNumber = String(parseInt(numMatch[1], 10)).padStart(3, '0');
  }

  const bpmMatch = base.match(/(\d{2,3}(?:\.\d+)?)\s*bpm/i);
  if (bpmMatch) {
    bpm = parseFloat(bpmMatch[1]);
  }

  const keyMatch = base.match(/\b([A-G](?:#|b)?\s*(?:maj|min|m)?)\b/i);
  if (keyMatch) {
    const rawKey = keyMatch[1].replace(/\s+/g, '');
    key = rawKey.charAt(0).toUpperCase() + rawKey.slice(1);
  }

  const parts = base.split(/\s*-\s*/);
  if (parts.length >= 2) {
    const candidate = parts.find(
      (p) =>
        !/^#?\d+$/.test(p.trim()) &&
        !/bpm/i.test(p) &&
        !/^[A-G](#|b)?(maj|min|m)?$/i.test(p.trim())
    );
    if (candidate) title = candidate.trim();
  }

  return {
    sampleNumber,
    title,
    key,
    bpm
  };
}

/**
 * Reads a PCM/IEEE Float WAV file header & samples to:
 * 1. Compute exact audio duration & envelope waveform peaks
 * 2. Auto-detect the "Explosion of Prettiness" drop timestamp aligned to bar boundaries
 * 3. Provide an audio-to-MIDI onset/pitch fallback if no .mid or .als is supplied
 */
function analyzeWavFile(filePath, bpm = 132) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    return {
      duration: 29.09,
      dropTime: Number(((32 * 60) / bpm).toFixed(3)),
      dropBar: 9,
      peaks: new Array(160).fill(0.4),
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

  // 1. Compute 240 waveform RMS peaks for the UI timeline
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

  // Normalize peaks 0..1
  const maxPeak = Math.max(0.01, ...peaks);
  const normPeaks = peaks.map((p) => Number((p / maxPeak).toFixed(3)));

  // 2. Auto-detect the main Drop bar boundary
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

  // Look for the strongest structural energy jump on a 4-bar or 2-bar boundary between 25% and 70% of the sample
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
    if (b % 4 === 0) jumpScore *= 1.35; // Favor 4-bar boundaries (e.g. Bar 5, Bar 9)
    else if (b % 2 === 0) jumpScore *= 1.15;

    if (jumpScore > bestScore) {
      bestScore = jumpScore;
      bestBarIdx = b;
    }
  }

  const dropBar = bestBarIdx + 1; // 1-indexed (e.g. Bar 9)
  const dropTime = Number((bestBarIdx * secPerBar).toFixed(3));

  // 3. Audio-to-MIDI onset + zero-crossing/autocorrelation pitch fallback (used if only .wav is uploaded)
  const fallbackNotes = [];
  const stepSec = 60 / bpm / 2; // 8th-note grid
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

  // 4. Compute transient impact timestamps post-drop for impact-synced video cutting
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

