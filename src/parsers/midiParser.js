const fs = require('fs');
const { Midi } = require('@tonejs/midi');
const { midiToNoteName } = require('./alsParser');

/**
 * Parses a standard .mid file into normalized tracks and notes.
 */
function parseMidiFile(filePath, fallbackBpm = 132) {
  const buffer = fs.readFileSync(filePath);
  const midi = new Midi(buffer);

  const headerBpm = midi.header?.tempos?.[0]?.bpm;
  const bpm = headerBpm ? Math.round(headerBpm * 10) / 10 : fallbackBpm;
  const beatsPerSec = bpm / 60;

  const tracks = [];
  midi.tracks.forEach((t, idx) => {
    if (!t.notes || t.notes.length === 0) return;
    const trackName = t.name?.trim() || t.instrument?.name || `MIDI Track ${idx + 1}`;
    const notes = t.notes.map((n) => {
      const beat = n.time * beatsPerSec;
      const durationBeats = Math.max(0.05, n.duration * beatsPerSec);
      return {
        midi: n.midi,
        name: n.name || midiToNoteName(n.midi),
        beat: Number(beat.toFixed(4)),
        durationBeats: Number(durationBeats.toFixed(4)),
        time: Number(n.time.toFixed(4)),
        duration: Number(Math.max(0.04, n.duration).toFixed(4)),
        velocity: Number(Math.max(0.05, Math.min(1, n.velocity)).toFixed(3)),
        track: trackName
      };
    });

    notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
    const minBeat = notes[0].beat;
    const maxBeat = Math.max(...notes.map((n) => n.beat + n.durationBeats));

    tracks.push({
      id: `mid_${idx}_${trackName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      name: trackName,
      noteCount: notes.length,
      startBar: Math.floor(minBeat / 4) + 1,
      endBar: Math.ceil(maxBeat / 4),
      defaultSelected: true,
      notes
    });
  });

  return {
    sourceType: 'midi',
    bpm,
    tracks
  };
}

module.exports = {
  parseMidiFile
};

