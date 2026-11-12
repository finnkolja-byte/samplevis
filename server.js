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
  MELANCHOLIC_PRESETS,
  loadCatalog,
  saveCatalog,
  fetchAnimeClips,
  pickClipsForSample,
  CLIPS_DIR
} = require('./src/media/animeFetcher');
const { getPostizStatus, schedulePost } = require('./src/social/postizClient');

const app = express();
const PORT = parseInt(process.env.PORT || '3450', 10);

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
const PRESETS_DIR = path.join(DATA_DIR, 'presets', 'meadows');

for (const dir of [DATA_DIR, UPLOADS_DIR, EXPORTS_DIR, CLIPS_DIR, PRESETS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Trust reverse proxy (Caddy + Authelia on surfacesrv)
app.set('trust proxy', 1);

// Security headers via Helmet (configured to allow local Blob/Media/WebCodecs & Google Fonts)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:']
      }
    },
    crossOriginResourcePolicy: { policy: 'same-origin' }
  })
);

app.use(express.json({ limit: '2mb' }));

// Optional strict Authelia enforcement when REQUIRE_AUTHELIA=true
app.use((req, res, next) => {
  const remoteUser = req.headers['remote-user'] || req.headers['x-forwarded-user'] || null;
  req.autheliaUser = remoteUser
    ? {
        username: String(remoteUser),
        name: String(req.headers['remote-name'] || remoteUser),
        email: String(req.headers['remote-email'] || ''),
        groups: String(req.headers['remote-groups'] || '')
          .split(',')
          .filter(Boolean)
      }
    : null;

  if (process.env.REQUIRE_AUTHELIA === 'true' && !req.autheliaUser && req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required via Authelia' });
  }
  next();
});

// Rate limiters
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
const fetchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

// Secure Multer storage with strict filename sanitization & extension allowlist
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
  limits: { fileSize: 120 * 1024 * 1024 }, // 120 MB max for .wav / .als
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

const exportUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, EXPORTS_DIR),
    filename: (_req, file, cb) => {
      cb(null, `${Date.now()}_${safeBasename(file.originalname || 'samplevis_render.mp4')}`);
    }
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.mp4', '.webm'].includes(ext)) cb(null, true);
    else cb(new Error('Only rendered .mp4/.webm files are allowed'));
  }
});

// Static assets
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
app.use('/exports', express.static(EXPORTS_DIR));

// Session / Auth endpoint
app.get('/api/session', (req, res) => {
  res.json({
    authelia: req.autheliaUser,
    presets: Object.entries(MELANCHOLIC_PRESETS).map(([id, val]) => ({
      id,
      label: val.label,
      vibe: val.vibe
    }))
  });
});

// Starter project endpoint (#1 - meadows - bmaj - 132bpm)
let cachedStarterProject = null;
app.get('/api/starter', (req, res) => {
  try {
    const wavName = '#1 - meadows - bmaj - 132bpm.wav';
    const alsName = '#1 - meadows - bmaj - 132bpm.als';
    const wavPath = path.join(PRESETS_DIR, wavName);
    const alsPath = path.join(PRESETS_DIR, alsName);

    if (!fs.existsSync(wavPath)) {
      return res.status(404).json({ error: 'Starter sample not found' });
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

    res.json({
      project: cachedStarterProject,
      clips: catalog,
      recommendedClips: matchedClips.slice(0, 6)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload & analyze new sample (.wav + optional .mid or .als)
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
        // Clean up the uploaded .als/.mid file after parsing so we don't waste disk space
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

// Server-side audio muxing fallback when client lacks native WebCodecs AAC encoder
app.post('/api/remux-audio', clipUploadMiddleware.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video provided' });
    const audioUrl = req.body?.audioUrl;
    let audioPath = null;
    if (audioUrl && audioUrl.startsWith('/presets/meadows/')) {
      const filename = decodeURIComponent(audioUrl.replace('/presets/meadows/', ''));
      audioPath = path.join(PRESETS_DIR, filename);
    } else if (audioUrl && audioUrl.startsWith('/uploads/')) {
      const filename = decodeURIComponent(audioUrl.replace('/uploads/', ''));
      audioPath = path.join(UPLOADS_DIR, filename);
    }

    if (!audioPath || !fs.existsSync(audioPath)) {
      return res.sendFile(req.file.path);
    }

    const outPath = path.join(EXPORTS_DIR, `remux_${Date.now()}.mp4`);
    const { execFile } = require('child_process');
    execFile(
      'ffmpeg',
      ['-y', '-i', req.file.path, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', outPath],
      (err) => {
        fs.unlink(req.file.path, () => {});
        if (err) return res.status(500).json({ error: err.message });
        res.download(outPath, 'render.mp4', () => {
          fs.unlink(outPath, () => {});
        });
      }
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Anime clips library endpoints
app.get('/api/clips', (_req, res) => {
  res.json({ clips: loadCatalog() });
});

app.post('/api/clips/fetch', fetchLimiter, async (req, res) => {
  try {
    const { category = 'all', customQuery = '', count = 4, mode = 'best' } = req.body || {};
    const result = await fetchAnimeClips({
      category: String(category),
      customQuery: String(customQuery).slice(0, 80),
      count: Math.min(8, Math.max(1, parseInt(count, 10) || 4)),
      mode: mode === 'random' ? 'random' : 'best'
    });
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

// Toggle / set favorite on a clip
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

// Postiz Multi-Platform Social Scheduling Endpoints
app.get('/api/social/status', async (_req, res) => {
  const status = await getPostizStatus();
  res.json(status);
});

app.post('/api/social/schedule', exportUploadMiddleware.single('video'), async (req, res) => {
  try {
    const platforms = req.body.platforms ? JSON.parse(req.body.platforms) : ['instagram', 'youtube', 'tiktok'];
    const integrationIds = req.body.integrationIds ? JSON.parse(req.body.integrationIds) : [];
    const sampleMeta = req.body.sampleMeta ? JSON.parse(req.body.sampleMeta) : {};

    const record = await schedulePost({
      mp4Path: req.file?.path || null,
      filename: req.file?.filename || 'client_export.mp4',
      caption: String(req.body.caption || '').slice(0, 2200),
      platforms,
      scheduledAt: req.body.scheduledAt || null,
      integrationIds,
      sampleMeta
    });

    res.json({ ok: true, record });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Global error handler
app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || 'Request error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SampleVis] Studio running at http://localhost:${PORT}`);
});

