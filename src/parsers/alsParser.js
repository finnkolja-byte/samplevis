const zlib = require('zlib');
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToNoteName(midi) {
  const octave = Math.floor(midi / 12) - 1;
  const name = NOTE_NAMES[midi % 12] || 'C';
  return `${name}${octave}`;
}

function asArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function findTempo(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.Tempo && obj.Tempo.Manual && obj.Tempo.Manual['@_Value']) {
    const val = parseFloat(obj.Tempo.Manual['@_Value']);
    if (!Number.isNaN(val) && val > 20 && val < 300) return val;
  }
  for (const key of Object.keys(obj)) {
    const found = findTempo(obj[key]);
    if (found) return found;
  }
  return null;
}

function collectMidiClips(node, results = []) {
  if (!node || typeof node !== 'object') return results;
  if (node.MidiClip) {
    for (const clip of asArray(node.MidiClip)) {
      results.push(clip);
    }
  }
  for (const key of Object.keys(node)) {
    if (key !== 'MidiClip') {
      collectMidiClips(node[key], results);
    }
  }
  return results;
}

// ableton .als files are gzipped xml; gunzip and walk the arrangement midi tracks
function parseAlsFile(filePath, fallbackBpm = 120) {
  const rawBuffer = fs.readFileSync(filePath);
  let xmlString;
  try {
    xmlString = zlib.gunzipSync(rawBuffer).toString('utf8');
  } catch {
    // already uncompressed xml
    xmlString = rawBuffer.toString('utf8');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_'
  });

  const parsed = parser.parse(xmlString);
  const liveSet = parsed?.Ableton?.LiveSet;
  if (!liveSet) {
    throw new Error('Invalid Ableton Live Set (.als) structure');
  }

  const bpm = findTempo(liveSet.MasterTrack || liveSet.MainTrack || liveSet) || fallbackBpm;
  const secPerBeat = 60 / bpm;

  const midiTracksRaw = asArray(liveSet?.Tracks?.MidiTrack);
  const tracks = [];

  midiTracksRaw.forEach((trackNode, idx) => {
    const trackName =
      trackNode?.Name?.EffectiveName?.['@_Value'] ||
      trackNode?.Name?.UserName?.['@_Value'] ||
      `MIDI Track ${idx + 1}`;

    // stick to arrangement view clips under MainSequencer -> ClipTimeable -> ArrangerAutomation -> Events
    const arrangerEvents =
      trackNode?.DeviceChain?.MainSequencer?.ClipTimeable?.ArrangerAutomation?.Events;
    const clips = arrangerEvents ? collectMidiClips(arrangerEvents) : collectMidiClips(trackNode);

    const trackNotes = [];

    for (const clip of clips) {
      const clipStart = parseFloat(clip?.['@_Time'] ?? clip?.CurrentStart?.['@_Value'] ?? 0);
      const clipEnd = parseFloat(clip?.CurrentEnd?.['@_Value'] ?? clipStart + 16);
      const clipDuration = Math.max(0, clipEnd - clipStart);
      if (clipDuration <= 0) continue;

      const loopNode = clip?.Loop || {};
      const loopOn = String(loopNode?.LoopOn?.['@_Value'] ?? 'true') === 'true';
      const loopStart = parseFloat(loopNode?.LoopStart?.['@_Value'] ?? 0);
      const loopEnd = parseFloat(loopNode?.LoopEnd?.['@_Value'] ?? clipDuration);
      const startRelative = parseFloat(loopNode?.StartRelative?.['@_Value'] ?? 0);
      const loopLen = Math.max(0.25, loopEnd - loopStart);

      const keyTracks = asArray(clip?.Notes?.KeyTracks?.KeyTrack);

      for (const kt of keyTracks) {
        const midiKey = parseInt(kt?.MidiKey?.['@_Value'], 10);
        if (Number.isNaN(midiKey)) continue;

        const noteEvents = asArray(kt?.Notes?.MidiNoteEvent);
        for (const ne of noteEvents) {
          const isEnabled = String(ne?.IsEnabled?.['@_Value'] ?? 'true') !== 'false';
          if (!isEnabled) continue;

          const rawNoteTime = parseFloat(ne?.['@_Time'] ?? 0);
          const rawDuration = Math.max(0.05, parseFloat(ne?.['@_Duration'] ?? 0.25));
          const rawVelocity = parseFloat(ne?.['@_Velocity'] ?? 100);
          const velocity = Math.max(0.05, Math.min(1, rawVelocity / 127));

          if (loopOn && rawNoteTime >= loopStart && rawNoteTime < loopEnd) {
            const maxIterations = Math.ceil((clipDuration + startRelative) / loopLen) + 1;
            for (let iter = 0; iter < maxIterations; iter++) {
              const offsetInClip = (rawNoteTime - loopStart) + iter * loopLen - startRelative;
              if (offsetInClip < -0.001) continue;
              if (offsetInClip >= clipDuration - 0.001) break;

              const absBeat = clipStart + offsetInClip;
              const clampedDurBeats = Math.min(rawDuration, clipEnd - absBeat);
              trackNotes.push({
                midi: midiKey,
                name: midiToNoteName(midiKey),
                beat: Number(absBeat.toFixed(4)),
                durationBeats: Number(clampedDurBeats.toFixed(4)),
                time: Number((absBeat * secPerBeat).toFixed(4)),
                duration: Number((clampedDurBeats * secPerBeat).toFixed(4)),
                velocity: Number(velocity.toFixed(3)),
                track: trackName
              });
            }
          } else {
            const offsetInClip = rawNoteTime - (loopStart + startRelative);
            if (offsetInClip >= 0 && offsetInClip < clipDuration) {
              const absBeat = clipStart + offsetInClip;
              const clampedDurBeats = Math.min(rawDuration, clipEnd - absBeat);
              trackNotes.push({
                midi: midiKey,
                name: midiToNoteName(midiKey),
                beat: Number(absBeat.toFixed(4)),
                durationBeats: Number(clampedDurBeats.toFixed(4)),
                time: Number((absBeat * secPerBeat).toFixed(4)),
                duration: Number((clampedDurBeats * secPerBeat).toFixed(4)),
                velocity: Number(velocity.toFixed(3)),
                track: trackName
              });
            }
          }
        }
      }
    }

    if (trackNotes.length > 0) {
      trackNotes.sort((a, b) => a.beat - b.beat || a.midi - b.midi);
      const minBeat = trackNotes[0].beat;
      const maxBeat = Math.max(...trackNotes.map((n) => n.beat + n.durationBeats));
      tracks.push({
        id: `als_${idx}_${trackName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
        name: trackName,
        noteCount: trackNotes.length,
        startBar: Math.floor(minBeat / 4) + 1,
        endBar: Math.ceil(maxBeat / 4),
        defaultSelected: !/bass|rack|chord/i.test(trackName),
        notes: trackNotes
      });
    }
  });

  return {
    sourceType: 'als',
    bpm,
    tracks
  };
}

// pulls chord change timestamps after the drop from bass/root tracks, chord pads, or a 2-bar grid fallback
function extractChordCutTimes(tracks = [], dropTime = null, bpm = 120, duration = 30.0) {
  const effectiveBpm = bpm || 120;
  const effectiveDur = duration || 30.0;
  const effectiveDrop = (typeof dropTime === 'number' && !isNaN(dropTime)) ? dropTime : (effectiveDur * 0.5);
  const minInterval = (60 / effectiveBpm) * 1.5;

  // check dedicated bass / root note tracks first
  const rootTrack = (tracks || []).find(
    (t) =>
      /bass|sub|rack|root/i.test(t.name) &&
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

  // otherwise look for chord / keys / pad tracks
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

  // fallback to 2-bar intervals after the drop
  const barSec = (60 / effectiveBpm) * 4;
  const cuts = [];
  for (let t = effectiveDrop; t < effectiveDur - 0.5; t += barSec * 2) {
    cuts.push(Number(t.toFixed(3)));
  }
  return cuts.length > 0 ? cuts : [effectiveDrop];
}

module.exports = {
  parseAlsFile,
  midiToNoteName,
  extractChordCutTimes
};

