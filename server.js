const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

const { parseAlsFile, extractChordCutTimes } = require('./src/parsers/alsParser');
const { parseMidiFile } = require('./src/parsers/midiParser');
const { parseSampleFilename, analyzeWavFile } = require('./src/parsers/audioAnalyzer');
const {
  loadCatalog,
  saveCatalog,
  fetchAnimeClips,
  fetchRealLifeClips,
  pickClipsForSample,
  CLIPS_DIR
} = require('./src/media/animeFetcher');
const { pipeAllowlistedStream } = require('./src/media/clipProxy');
const { createStarterService } = require('./src/starter/starterService');
const { sanitizePresetId, normalizePresetForStorage } = require('./src/presets/presetValidator');

const app = express();
const PORT = parseInt(process.env.PORT || '3450', 10);

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
const PRESETS_DIR = path.join(DATA_DIR, 'presets', 'meadows');
const DEMOS_DIR = path.join(DATA_DIR, 'presets', 'demos');
const CUSTOM_PRESETS_DIR = path.join(DATA_DIR, 'presets', 'custom');

for (const dir of [DATA_DIR, UPLOADS_DIR, EXPORTS_DIR, CLIPS_DIR, PRESETS_DIR, CUSTOM_PRESETS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// reverse proxy / tunnel deployments forward the real client ip
app.set('trust proxy', 1);

// allow blob/data urls for local webcodecs export and canvas video playback
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // the sandboxed renderer is an srcdoc iframe and inherits this policy, so its inline
        // runtime is blocked here unless inline scripts are allowed; Pages serves no CSP at all
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'blob:', 'https:'],
        workerSrc: ["'self'", 'blob:']
      }
    },
    crossOriginResourcePolicy: { policy: 'same-origin' }
  })
);

app.use((req, res, next) => {
  if (req.path === '/api/presets') return next();
  return express.json({ limit: '2mb' })(req, res, next);
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/clips/stream',
  message: { error: 'too many requests — please wait a moment and try again' }
});
const fetchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'clip fetch rate limit reached — wait a few seconds and try again' }
});
app.use('/api/', apiLimiter);

function safeBasename(name) {
  return path
    .basename(name)
    .replace(/[^a-zA-Z0-9._# -]/g, '_')
    .slice(0, 120);
}

const sampleStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const id = crypto.randomBytes(4).toString('hex');
    cb(null, `${Date.now()}_${id}_${safeBasename(file.originalname)}`);
  }
});

const uploadSampleMiddleware = multer({
  storage: sampleStorage,
  limits: { fileSize: 120 * 1024 * 1024 }, // 120mb ceiling for uncompressed wavs
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.wav', '.mid', '.midi', '.als'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file extension: ${ext}`));
    }
  }
});

const clipUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, CLIPS_DIR),
    filename: (_req, file, cb) => {
      const id = crypto.randomBytes(4).toString('hex');
      const ext = path.extname(file.originalname).toLowerCase() === '.webm' ? '.webm' : '.mp4';
      cb(null, `custom_${Date.now()}_${id}${ext}`);
    }
  }),
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.mp4', '.webm'].includes(ext)) cb(null, true);
    else cb(new Error('Only .mp4 and .webm video clips are allowed'));
  }
});

app.get('/', (req, res, next) => {
  if (!req.query.preset) {
    return res.sendFile(path.join(__dirname, 'public', 'gallery.html'));
  }
  next();
});

// pages serves /privacy and /terms without the extension; mirror that so local dev links work
for (const page of ['privacy', 'terms', 'impressum']) {
  app.get(`/${page}`, (req, res) => res.sendFile(path.join(__dirname, 'public', `${page}.html`)));
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(
  '/anime-clips',
  express.static(CLIPS_DIR, {
    maxAge: '7d',
    setHeaders: (res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
  })
);
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/presets/meadows', express.static(PRESETS_DIR));
app.use('/presets/demos', express.static(DEMOS_DIR));
app.use('/exports', express.static(EXPORTS_DIR));

const starterService = createStarterService({
  presetsDir: PRESETS_DIR,
  demosDir: DEMOS_DIR
});

app.get('/api/starter', (req, res) => {
  try {
    const { status, body } = starterService.getStarterPayload(req.query.preset);
    res.status(status).json(body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// server-side sample analysis fallback (most analysis runs in clientAnalyzer.js now)
app.post(
  '/api/analyze-sample',
  uploadSampleMiddleware.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'midi', maxCount: 1 }
  ]),
  (req, res) => {
    try {
      const audioFile = req.files?.audio?.[0];
      const midiFile = req.files?.midi?.[0];

      if (!audioFile) {
        return res.status(400).json({ error: 'Please provide a .wav audio file' });
      }

      const meta = parseSampleFilename(audioFile.originalname);
      let midiData = null;

      if (midiFile) {
        const ext = path.extname(midiFile.originalname).toLowerCase();
        if (ext === '.als') {
          midiData = parseAlsFile(midiFile.path, meta.bpm);
        } else if (ext === '.mid' || ext === '.midi') {
          midiData = parseMidiFile(midiFile.path, meta.bpm);
        }
        // drop the temp midi/als file once parsed; we only need the extracted note json
        fs.unlink(midiFile.path, () => {});
      }

      const effectiveBpm = midiData?.bpm || meta.bpm;
      const wavAnalysis = analyzeWavFile(audioFile.path, effectiveBpm);

      if (!midiData || !midiData.tracks || midiData.tracks.length === 0) {
        midiData = {
          sourceType: 'audio-fallback',
          bpm: effectiveBpm,
          tracks: [
            {
              id: 'fallback_0',
              name: 'Audio Pitch / Onset Fallback',
              noteCount: wavAnalysis.fallbackNotes.length,
              startBar: 1,
              endBar: Math.ceil((wavAnalysis.duration * (effectiveBpm / 60)) / 4),
              defaultSelected: true,
              notes: wavAnalysis.fallbackNotes
            }
          ]
        };
      }

      const catalog = loadCatalog();
      const matchedClips = pickClipsForSample(catalog, meta.title);

      const chordCutTimes = extractChordCutTimes(
        midiData.tracks,
        wavAnalysis.dropTime,
        effectiveBpm,
        wavAnalysis.duration
      );

      const project = {
        id: `sample_${Date.now()}`,
        brand: (req.body?.brand || 'aesttc').toLowerCase(),
        sampleNumber: meta.sampleNumber || '',
        title: (meta.title || 'starter').toLowerCase(),
        key: (meta.key || '').toLowerCase(),
        bpm: effectiveBpm,
        audioUrl: `/uploads/${encodeURIComponent(audioFile.filename)}`,
        duration: wavAnalysis.duration,
        dropBar: wavAnalysis.dropBar,
        dropTime: wavAnalysis.dropTime,
        peaks: wavAnalysis.peaks,
        sourceType: midiData.sourceType,
        tracks: midiData.tracks,
        chordCutTimes,
        impactTimes: wavAnalysis.impactTimes || [wavAnalysis.dropTime]
      };

      res.json({
        project,
        recommendedClips: matchedClips.slice(0, 6)
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.get('/api/clips', (_req, res) => {
  res.json({ clips: loadCatalog() });
});

app.get('/api/clips/stream', (req, res) => {
  pipeAllowlistedStream(req.query.url, req, res, 3);
});

app.post('/api/clips/fetch', fetchLimiter, async (req, res) => {
  try {
    const { category = 'all', customQuery = '', count = 4, mode = 'best', source = 'anime', excludeIds = [] } = req.body || {};
    const cleanSource = source === 'real_life' ? 'real_life' : 'anime';
    const params = {
      category: String(category),
      customQuery: String(customQuery).slice(0, 80),
      count: Math.min(16, Math.max(1, parseInt(count, 10) || 4)),
      mode: mode === 'random' ? 'random' : 'best',
      streamOnly: true,
      excludeIds: Array.isArray(excludeIds) ? excludeIds.slice(0, 200).map(String) : []
    };
    const result = cleanSource === 'real_life'
      ? await fetchRealLifeClips(params)
      : await fetchAnimeClips(params);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clips/upload', clipUploadMiddleware.single('clip'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video clip provided' });
    const catalog = loadCatalog();
    const cleanName = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const entry = {
      id: `custom_${Date.now()}`,
      sourceId: `custom_${Date.now()}`,
      filename: req.file.filename,
      url: `/anime-clips/${req.file.filename}`,
      title: cleanName,
      vibe: req.body?.vibe || 'custom',
      hasCharacter: true,
      tags: ['custom', req.body?.vibe || 'melancholic'],
      addedAt: new Date().toISOString()
    };
    catalog.unshift(entry);
    saveCatalog(catalog);
    res.json({ added: entry, catalog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clips/:id/favorite', (req, res) => {
  try {
    const { id } = req.params;
    const { favorite } = req.body || {};
    const catalog = loadCatalog();
    const clip = catalog.find((c) => c.id === id);
    if (!clip) {
      return res.status(404).json({ error: 'Clip not found' });
    }
    clip.favorite = typeof favorite === 'boolean' ? favorite : !clip.favorite;
    saveCatalog(catalog);
    res.json({ id: clip.id, favorite: clip.favorite, clip });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// custom 3-box design preset storage (pure self-hosted filesystem)
app.get('/api/presets', async (_req, res) => {
  try {
    if (!fs.existsSync(CUSTOM_PRESETS_DIR)) {
      return res.json({ presets: [] });
    }
    const files = await fs.promises.readdir(CUSTOM_PRESETS_DIR);
    const presets = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.promises.readFile(path.join(CUSTOM_PRESETS_DIR, f), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.id) presets.push(parsed);
      } catch (parseErr) {
        console.warn(`[PresetStore] Skipping invalid preset file "${f}":`, parseErr.message);
      }
    }
    res.json({ presets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/presets/:id', async (req, res) => {
  try {
    const id = sanitizePresetId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid preset ID' });
    }
    const filePath = path.join(CUSTOM_PRESETS_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Preset not found' });
    }
    const raw = await fs.promises.readFile(filePath, 'utf8');
    res.json({ preset: JSON.parse(raw) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/presets', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const preset = req.body.preset || req.body;
    const { id, cleanPreset, serialized } = normalizePresetForStorage(preset, {
      existsSync: (candidateId) => fs.existsSync(path.join(CUSTOM_PRESETS_DIR, `${candidateId}.json`))
    });

    const targetPath = path.join(CUSTOM_PRESETS_DIR, `${id}.json`);
    const tmpPath = `${targetPath}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmpPath, serialized, 'utf8');
    await fs.promises.rename(tmpPath, targetPath);

    res.json({ ok: true, id, preset: cleanPreset });
  } catch (err) {
    res.status(err?.status || 500).json({ error: err.message });
  }
});

app.delete('/api/presets/:id', async (req, res) => {
  try {
    const id = sanitizePresetId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid preset ID' });
    }
    const filePath = path.join(CUSTOM_PRESETS_DIR, `${id}.json`);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, _req, res, _next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({
      error: 'preset exceeds the 50 mb save limit. compress or remove embedded media before saving.'
    });
  }
  res.status(err?.status || 400).json({ error: err.message || 'Request error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SampleVis] Studio running at http://localhost:${PORT}`);
});

