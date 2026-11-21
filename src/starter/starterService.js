const fs = require('fs');
const path = require('path');

const { parseAlsFile, extractChordCutTimes } = require('../parsers/alsParser');
const { parseSampleFilename, analyzeWavFile } = require('../parsers/audioAnalyzer');
const { loadCatalog, pickClipsForSample } = require('../media/animeFetcher');

/**
 * Resolves built-in starter and demo project payloads without requiring an Express server.
 */
function createStarterService({ presetsDir, demosDir }) {
  let cachedStarterProject = null;
  let cachedDemoMeta = null;

  function loadDemoProjects() {
    if (cachedDemoMeta) return cachedDemoMeta;
    const manifestPath = path.join(demosDir, 'demos.json');
    if (!fs.existsSync(manifestPath)) {
      cachedDemoMeta = {};
      return cachedDemoMeta;
    }
    try {
      cachedDemoMeta = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      cachedDemoMeta = {};
    }
    return cachedDemoMeta;
  }

  function getStarterPayload(requestedPresetRaw = 'constellations') {
    const requestedPreset = String(requestedPresetRaw || 'constellations').trim();

    if (requestedPreset === 'new_blank' || requestedPreset === 'blank') {
      return {
        status: 200,
        body: {
          project: null,
          clips: [],
          recommendedClips: []
        }
      };
    }

    const demoMeta = loadDemoProjects();
    if (requestedPreset !== 'constellations' && demoMeta[requestedPreset]) {
      const d = demoMeta[requestedPreset];
      const wavPath = path.join(demosDir, d.filename);
      if (fs.existsSync(wavPath)) {
        const catalog = loadCatalog();
        const demoProject = {
          id: `starter_${requestedPreset}`,
          brand: 'samplevis',
          sampleNumber: '',
          title: d.title,
          key: d.key,
          bpm: d.bpm || parseSampleFilename(d.filename).bpm || 120,
          audioUrl: `/presets/demos/${encodeURIComponent(d.filename)}`,
          duration: d.duration,
          dropBar: d.dropBar,
          dropTime: d.dropTime,
          peaks: d.peaks,
          sourceType: 'midi',
          tracks: [
            {
              id: 'demo_keys',
              name: 'Keys & Pad',
              noteCount: d.notes.length,
              startBar: 1,
              endBar: Math.ceil((d.duration * ((d.bpm || 120) / 60)) / 4),
              defaultSelected: true,
              notes: d.notes
            }
          ],
          chordCutTimes: d.chordCutTimes,
          impactTimes: d.impactTimes,
          lyrics: d.lyrics || null
        };
        const matched = pickClipsForSample(catalog, d.title);
        return {
          status: 200,
          body: {
            project: demoProject,
            clips: catalog,
            recommendedClips: matched.slice(0, 6)
          }
        };
      }
    }

    const wavName = '#1 - meadows - bmaj - 132bpm.wav';
    const alsName = '#1 - meadows - bmaj - 132bpm.als';
    const wavPath = path.join(presetsDir, wavName);
    const alsPath = path.join(presetsDir, alsName);

    if (!fs.existsSync(wavPath)) {
      return {
        status: 404,
        body: { error: 'Starter sample not found' }
      };
    }

    if (!cachedStarterProject) {
      const meta = parseSampleFilename(wavName);
      const wavAnalysis = analyzeWavFile(wavPath, meta.bpm);
      let midiData = { sourceType: 'audio-fallback', bpm: meta.bpm, tracks: [] };

      if (fs.existsSync(alsPath)) {
        midiData = parseAlsFile(alsPath, meta.bpm);
      }
      if (!midiData.tracks || midiData.tracks.length === 0) {
        midiData.tracks = [
          {
            id: 'fallback_0',
            name: 'Audio Transcribed',
            noteCount: wavAnalysis.fallbackNotes.length,
            startBar: 1,
            endBar: Math.ceil((wavAnalysis.duration * (meta.bpm / 60)) / 4),
            defaultSelected: true,
            notes: wavAnalysis.fallbackNotes
          }
        ];
      }

      const effectiveStarterBpm = midiData.bpm || meta.bpm;
      const chordCutTimes = extractChordCutTimes(
        midiData.tracks,
        wavAnalysis.dropTime,
        effectiveStarterBpm,
        wavAnalysis.duration
      );

      cachedStarterProject = {
        id: 'starter_meadows',
        brand: 'aesttc',
        sampleNumber: meta.sampleNumber || '',
        title: (meta.title || 'starter').toLowerCase(),
        key: (meta.key || '').toLowerCase(),
        bpm: effectiveStarterBpm,
        audioUrl: `/presets/meadows/${encodeURIComponent(wavName)}`,
        duration: wavAnalysis.duration,
        dropBar: wavAnalysis.dropBar,
        dropTime: wavAnalysis.dropTime,
        peaks: wavAnalysis.peaks,
        sourceType: midiData.sourceType,
        tracks: midiData.tracks,
        chordCutTimes,
        impactTimes: wavAnalysis.impactTimes || [wavAnalysis.dropTime]
      };
    }

    const catalog = loadCatalog();
    const matchedClips = pickClipsForSample(catalog, cachedStarterProject.title);

    return {
      status: 200,
      body: {
        project: cachedStarterProject,
        clips: catalog,
        recommendedClips: matchedClips.slice(0, 6)
      }
    };
  }

  return { getStarterPayload };
}

module.exports = { createStarterService };
