const fs = require('fs');
const path = require('path');
const https = require('https');

const CLIPS_DIR = path.join(__dirname, '..', '..', 'data', 'anime-clips');
const CATALOG_PATH = path.join(__dirname, '..', '..', 'data', 'anime-library.json');

// Curated melancholic presets: includes character slice-of-life moments (beach, city stairs, walking, train, wind, night, sunset, calm) + scenery
const MELANCHOLIC_PRESETS = {
  kimi_no_na_wa: {
    label: 'Kimi no Na wa (Your Name)',
    queries: [
      'kimi_no_na_wa'
    ],
    vibe: 'kimi_no_na_wa'
  },
  weathering_with_you: {
    label: 'Weathering with You (Tenki no Ko)',
    queries: [
      'tenki_no_ko',
      'weathering_with_you'
    ],
    vibe: 'weathering_with_you'
  },
  suzume: {
    label: 'Suzume (Suzume no Tojimari)',
    queries: [
      'suzume_no_tojimari'
    ],
    vibe: 'suzume'
  },
  '5_centimeters_per_second': {
    label: '5 Centimeters per Second',
    queries: [
      '5_centimeters_per_second',
      'byousoku_5_centimeter'
    ],
    vibe: '5_centimeters_per_second'
  },
  the_garden_of_words: {
    label: 'The Garden of Words (Kotonoha no Niwa)',
    queries: [
      'the_garden_of_words'
    ],
    vibe: 'the_garden_of_words'
  },
  violet_evergarden: {
    label: 'Violet Evergarden',
    queries: [
      'violet_evergarden'
    ],
    vibe: 'violet_evergarden'
  },
  a_silent_voice: {
    label: 'A Silent Voice (Koe no Katachi)',
    queries: [
      'koe_no_katachi'
    ],
    vibe: 'a_silent_voice'
  },
  your_lie_in_april: {
    label: 'Your Lie in April (Shigatsu wa Kimi no Uso)',
    queries: [
      'shigatsu_wa_kimi_no_uso'
    ],
    vibe: 'your_lie_in_april'
  },
  josee: {
    label: 'Josee, the Tiger and the Fish',
    queries: [
      'josee_to_tora_to_sakana-tachi'
    ],
    vibe: 'josee'
  },
  frieren: {
    label: 'Frieren: Beyond Journey\'s End',
    queries: [
      'sousou_no_frieren'
    ],
    vibe: 'frieren'
  },
  night_sunset: {
    label: 'Night & Sunset',
    queries: [
      'yuru_camp',
      'hibike!_euphonium',
      'tenki_no_ko',
      'kimi_no_na_wa'
    ],
    vibe: 'night_sunset'
  },
  calm: {
    label: 'Calm & Peaceful',
    queries: [
      'hyouka',
      'non_non_biyori',
      'tamako_market',
      'yuru_camp'
    ],
    vibe: 'calm'
  },
  character_melancholic: {
    label: 'Characters · Melancholic / Wind',
    queries: [
      'violet_evergarden',
      'liz_and_the_blue_bird',
      'koe_no_katachi',
      'sousou_no_frieren'
    ],
    vibe: 'character'
  },
  city_walk_stairs: {
    label: 'City / Stairs / Bridge / Train',
    queries: [
      'kimi_no_na_wa',
      'weathering_with_you',
      '5_centimeters_per_second'
    ],
    vibe: 'city'
  },
  beach_ocean_breeze: {
    label: 'Beach / Ocean / Sunset',
    queries: [
      'sonny_boy',
      'the_garden_of_words'
    ],
    vibe: 'beach'
  },
  meadows_sky_night: {
    label: 'Meadows / Nature / Sky',
    queries: [
      'sousou_no_frieren',
      'violet_evergarden'
    ],
    vibe: 'scenery'
  }
};

// Strict exclusion tags to prevent any action/fight/combat/chaos from slipping in
const EXCLUDED_TAGS = new Set([
  'fighting',
  'fight',
  'combat',
  'battle',
  'action',
  'explosion',
  'explosions',
  'fire',
  'smoke',
  'blood',
  'gore',
  'mecha',
  'robot',
  'beams',
  'missile',
  'gun',
  'guns',
  'shooting',
  'sword',
  'swords',
  'swordfight',
  'punch',
  'punching',
  'kick',
  'martial_arts',
  'screaming',
  'genga',
  'douga',
  'sketch',
  'unfinished',
  'production_materials',
  'storyboard',
  'impact_frames',
  'debris',
  'creatures',
  'creature',
  'monster',
  'monsters',
  'demon',
  'hentai',
  'ecchi',
  'nsfw',
  'vehicle',
  'car',
  'motorcycle',
  'running',
  'chase'
]);

function ensureDirs() {
  if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });
}

function loadCatalog() {
  ensureDirs();
  if (!fs.existsSync(CATALOG_PATH)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    // Keep only clips whose files exist on disk
    return list.filter((item) => fs.existsSync(path.join(CLIPS_DIR, item.filename)));
  } catch {
    return [];
  }
}

function saveCatalog(list) {
  ensureDirs();
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(list, null, 2), 'utf8');
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'SampleVis/1.0 (Personal Music Visualizer Studio)',
          Accept: 'application/json'
        },
        timeout: 15000
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'SampleVis/1.0 (Personal Music Visualizer Studio)'
        },
        timeout: 30000
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(destPath)));
      }
    );
    req.on('error', (err) => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      file.close();
      fs.unlink(destPath, () => {});
      reject(new Error('Download timeout'));
    });
  });
}

function formatReadableTitle(tagsStr, postId) {
  const tags = tagsStr.split(/\s+/).filter(Boolean);
  const metaIgnore = new Set([
    'animated',
    'artist_unknown',
    'background_animation',
    'character_acting',
    'cgi',
    'effects',
    'fabric',
    'hair',
    'scenery',
    'wind',
    'water_effects',
    'lighting',
    'walking',
    'running',
    'sitting',
    'rain',
    'clouds',
    'sky',
    'ocean',
    'train',
    'nature',
    'animals',
    'bird',
    'smoke',
    'liquid',
    'rotation',
    'steven_universe',
    'western'
  ]);
  const showTag = tags.find((t) => !metaIgnore.has(t) && t.length > 3) || 'anime_scene';
  const moodTags = tags.filter((t) =>
    ['wind', 'rain', 'ocean', 'sky', 'clouds', 'train', 'walking', 'character_acting', 'scenery', 'hair'].includes(t)
  );
  const cleanShow = showTag.replace(/_/g, ' ');
  const cleanMood = moodTags.slice(0, 2).map((t) => t.replace(/_/g, ' ')).join(' · ');
  return cleanMood ? `${cleanShow} (${cleanMood})` : `${cleanShow} #${postId}`;
}

/**
 * Fetches melancholic anime clips from Sakugabooru matching a preset category or custom tags.
 * Supports two modes:
 * - 'best': Deterministically fetches the highest-rated masterpiece clips (page 1 score-ordered).
 * - 'random': Samples fresh random clips within the category each time (random page + score-weighted sampling).
 */
async function fetchAnimeClips({ category = 'all', customQuery = '', count = 4, mode = 'best' } = {}) {
  ensureDirs();
  const catalog = loadCatalog();
  const existingIds = new Set(catalog.map((c) => String(c.sourceId)));

  let queriesToRun = [];
  if (customQuery && customQuery.trim()) {
    const cleanQ = customQuery.trim();
    const query = /order:/i.test(cleanQ) ? cleanQ : `${cleanQ} order:score`;
    queriesToRun.push({ query, vibe: 'custom' });
  } else if (category !== 'all' && MELANCHOLIC_PRESETS[category]) {
    queriesToRun = MELANCHOLIC_PRESETS[category].queries.map((q) => ({
      query: /order:/i.test(q) ? q : `${q} order:score`,
      vibe: MELANCHOLIC_PRESETS[category].vibe
    }));
  } else {
    // Balanced mix of Character Melancholic + City/Stairs/Train + Beach/Ocean + Meadows/Sky
    for (const preset of Object.values(MELANCHOLIC_PRESETS)) {
      for (const q of preset.queries.slice(0, 2)) {
        queriesToRun.push({
          query: /order:/i.test(q) ? q : `${q} order:score`,
          vibe: preset.vibe
        });
      }
    }
  }

  // Shuffle query order slightly when fetching 'all' for broad category diversity
  if (category === 'all') {
    queriesToRun.sort(() => Math.random() - 0.5);
  }

  const candidates = [];

  for (const { query, vibe } of queriesToRun) {
    // In random mode, pick a random page (1 to 5) each time to fetch different clips within the category
    // In best mode, start with page 1 to guarantee top community-rated clips first
    const targetPage = mode === 'random' ? Math.floor(Math.random() * 5) + 1 : 1;
    let apiUrl = `https://www.sakugabooru.com/post.json?limit=40&page=${targetPage}&tags=${encodeURIComponent(query)}`;

    try {
      let posts = await httpsGetJson(apiUrl);
      // In best mode, if page 1 has few undownloaded posts, fetch page 2 to get the next best clips
      if (mode === 'best' && Array.isArray(posts)) {
        const unDownloaded = posts.filter((p) => p && !existingIds.has(String(p.id)));
        if (unDownloaded.length < count) {
          const page2Url = `https://www.sakugabooru.com/post.json?limit=40&page=2&tags=${encodeURIComponent(query)}`;
          const p2Posts = await httpsGetJson(page2Url).catch(() => []);
          if (Array.isArray(p2Posts)) posts = posts.concat(p2Posts);
        }
      } else if (mode === 'random' && (!Array.isArray(posts) || posts.length < 3) && targetPage > 1) {
        // Fallback for random mode if high page was empty
        apiUrl = `https://www.sakugabooru.com/post.json?limit=40&page=1&tags=${encodeURIComponent(query)}`;
        posts = await httpsGetJson(apiUrl);
      }
      if (!Array.isArray(posts)) continue;

      for (const post of posts) {
        if (!post || !post.file_url || existingIds.has(String(post.id))) continue;
        if (post.rating === 'e') continue;
        if (!post.file_url.endsWith('.mp4')) continue;
        // Reasonable file size (450KB to 14.5MB) for smooth streaming & fast loading
        if (post.file_size && (post.file_size < 450_000 || post.file_size > 14_500_000)) continue;

        const postTags = String(post.tags || '').split(/\s+/);
        if (postTags.some((t) => EXCLUDED_TAGS.has(t))) continue;

        // Quality Floor: Require proven community upvote score (>= 12) so low-tier clips are rejected
        const score = typeof post.score === 'number' ? post.score : 0;
        if (score < 12) continue;

        const hasCharacter = postTags.some((t) =>
          ['character_acting', 'walking', 'hair', 'fabric', 'sitting', 'crying'].includes(t)
        );
        candidates.push({
          post,
          vibe,
          hasCharacter,
          score,
          tags: postTags
        });
        existingIds.add(String(post.id));
      }
    } catch {
      // Continue if one tag query fails
    }
  }

  // Group candidates by vibe
  const byVibe = {};
  for (const item of candidates) {
    if (!byVibe[item.vibe]) byVibe[item.vibe] = [];
    byVibe[item.vibe].push(item);
  }

  for (const vibe of Object.keys(byVibe)) {
    const pool = byVibe[vibe];
    if (mode === 'random') {
      // Quality-weighted random sampling: samples randomly from "the good ones"
      for (const item of pool) {
        const charBonus = item.hasCharacter ? 1.35 : 1.0;
        const qualityWeight = Math.sqrt(Math.max(10, item.score)) * charBonus;
        const u = Math.max(0.0001, Math.min(0.9999, Math.random()));
        item.randomRank = Math.pow(u, 1 / qualityWeight);
      }
      pool.sort((a, b) => b.randomRank - a.randomRank);
    } else {
      // Pure quality ranking: highest score first, with character acting preference
      pool.sort((a, b) => {
        const scoreA = (a.score || 0) * (a.hasCharacter ? 1.25 : 1.0);
        const scoreB = (b.score || 0) * (b.hasCharacter ? 1.25 : 1.0);
        return scoreB - scoreA;
      });
    }
  }

  // Interleave candidates across vibes so 'all' fetches a balanced mix of character, city, beach, and scenery
  const interleaved = [];
  const vibeKeys = Object.keys(byVibe);
  let maxLen = Math.max(0, ...vibeKeys.map((k) => byVibe[k].length));
  for (let i = 0; i < maxLen; i++) {
    for (const k of vibeKeys) {
      if (byVibe[k][i]) interleaved.push(byVibe[k][i]);
    }
  }

  const newlyDownloaded = [];
  for (const item of interleaved) {
    if (newlyDownloaded.length >= count) break;
    const { post, vibe, hasCharacter, tags, score } = item;
    const filename = `sb_${post.id}.mp4`;
    const destPath = path.join(CLIPS_DIR, filename);

    try {
      await downloadFile(post.file_url, destPath);
      const entry = {
        id: `clip_${post.id}`,
        sourceId: String(post.id),
        filename,
        url: `/anime-clips/${filename}`,
        title: formatReadableTitle(post.tags || '', post.id),
        vibe,
        hasCharacter,
        score,
        width: post.width || 1280,
        height: post.height || 720,
        tags: tags.slice(0, 12),
        addedAt: new Date().toISOString()
      };
      catalog.unshift(entry);
      newlyDownloaded.push(entry);
    } catch {
      // Skip broken download
    }
  }

  saveCatalog(catalog);
  return {
    added: newlyDownloaded,
    catalog
  };
}

/**
 * Matches best clips from catalog for a sample based on title/mood keywords, preferring a mix of character & scenery.
 * Uses quality-controlled random variance to rotate among top matches without picking irrelevant clips.
 */
function pickClipsForSample(catalog, sampleTitle = '') {
  if (!catalog || catalog.length === 0) return [];
  const lower = sampleTitle.toLowerCase();
  const scored = catalog.map((clip) => {
    let score = 1;
    const tagStr = (clip.tags || []).join(' ') + ' ' + (clip.title || '').toLowerCase();
    if (/meadow|forest|wind|sky|field|spring/i.test(lower) && /wind|nature|scenery|clouds|sky|hair/.test(tagStr)) {
      score += 3;
    }
    if (/rain|city|night|train|street/i.test(lower) && /rain|train|walking|city/.test(tagStr)) {
      score += 3;
    }
    if (/beach|sea|ocean|wave/i.test(lower) && /ocean|water|wind/.test(tagStr)) {
      score += 3;
    }
    if (clip.hasCharacter) score += 1.5;
    if (clip.favorite) score += 2.0;
    if (clip.score && clip.score > 50) score += 0.8;

    // Small controlled jitter (0..0.75) breaks ties among top matches for fresh variety
    const jitter = Math.random() * 0.75;
    return { clip, effectiveScore: score + jitter };
  });
  scored.sort((a, b) => b.effectiveScore - a.effectiveScore);
  return scored.map((s) => s.clip);
}

module.exports = {
  MELANCHOLIC_PRESETS,
  loadCatalog,
  saveCatalog,
  fetchAnimeClips,
  pickClipsForSample,
  CLIPS_DIR
};
