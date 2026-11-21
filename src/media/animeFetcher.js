const fs = require('fs');
const path = require('path');
const https = require('https');

const BUNDLED_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DATA_DIR = process.env.SAMPLEVIS_DATA_DIR || BUNDLED_DATA_DIR;
const CLIPS_DIR = path.join(DATA_DIR, 'anime-clips');
const CATALOG_PATH = path.join(DATA_DIR, 'anime-library.json');
const BUNDLED_CLIPS_DIR = path.join(BUNDLED_DATA_DIR, 'anime-clips');
const BUNDLED_CATALOG_PATH = path.join(BUNDLED_DATA_DIR, 'anime-library.json');
const HAS_SEPARATE_USER_DATA = path.resolve(DATA_DIR) !== path.resolve(BUNDLED_DATA_DIR);
const MAX_CATALOG_CLIPS = 120;

// sakugabooru tag presets tuned for slice-of-life / atmospheric scenery cuts
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

const NSFW_TAGS = new Set(['hentai', 'ecchi', 'nsfw']);

const PRODUCTION_JUNK_TAGS = new Set([
  'genga',
  'douga',
  'sketch',
  'unfinished',
  'production_materials',
  'storyboard',
  'settei',
  'correction',
  'genga_comparison'
]);

// sakugabooru has plenty of raw action cuts — filter those out for default browsing unless the user searches for them
const ACTION_TAGS = new Set([
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
  'missiles',
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
  'impact_frames',
  'debris',
  'creatures',
  'creature',
  'monster',
  'monsters',
  'demon',
  'vehicle',
  'car',
  'motorcycle',
  'running',
  'chase'
]);

const EXCLUDED_TAGS = new Set([
  ...NSFW_TAGS,
  ...PRODUCTION_JUNK_TAGS,
  ...ACTION_TAGS
]);

function ensureDirs() {
  try {
    if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });
  } catch {
    // ignore read-only bundle paths when running in stream-only mode
  }
}

function clipFileExists(filename) {
  if (!filename) return false;
  if (fs.existsSync(path.join(CLIPS_DIR, filename))) return true;
  if (HAS_SEPARATE_USER_DATA && fs.existsSync(path.join(BUNDLED_CLIPS_DIR, filename))) return true;
  return false;
}

function readCatalogFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(list)) return [];
    return list.filter((item) => {
      if (!item || !item.id) return false;
      // an entry with a recorded source plays through the stream proxy and caches its bytes on
      // first play, so it does not need a downloaded file to be listed
      if (item.remoteUrl) return true;
      if (item.url && item.url.startsWith('/api/clips/stream')) return true;
      return clipFileExists(item.filename);
    });
  } catch {
    return [];
  }
}

/**
 * Resolves what a catalog entry plays from. A library clip is always a link: it streams through the
 * proxy and the studio caches the bytes in indexeddb on first play, so no footage is written to
 * disk. A file left over in `data/anime-clips` from an older download is ignored on purpose.
 */
function withPlayableSource(item) {
  const fromUrl = typeof item.url === 'string' && item.url.startsWith('/anime-clips/')
    ? item.url.split('/').pop()
    : null;
  const filename = item.filename || fromUrl;
  if (item.remoteUrl) {
    return {
      ...item,
      filename: filename || null,
      url: `/api/clips/stream?url=${encodeURIComponent(item.remoteUrl)}`,
      streamOnly: true
    };
  }
  return { ...item, url: null, unavailable: true };
}

function loadCatalog() {
  const seen = new Set();
  const merged = [];
  const appendUnique = (items) => {
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(withPlayableSource(item));
      if (merged.length >= MAX_CATALOG_CLIPS) break;
    }
  };
  appendUnique(readCatalogFile(CATALOG_PATH));
  if (HAS_SEPARATE_USER_DATA && merged.length < MAX_CATALOG_CLIPS) {
    appendUnique(readCatalogFile(BUNDLED_CATALOG_PATH));
  }
  return merged;
}

function persistUserStreamClips(added) {
  if (!HAS_SEPARATE_USER_DATA || !Array.isArray(added) || added.length === 0) return;
  try {
    const existingUser = readCatalogFile(CATALOG_PATH);
    saveCatalog([...added, ...existingUser]);
  } catch {
    // ignore read-only or quota errors when caching stream metadata
  }
}

function saveCatalog(list) {
  ensureDirs();
  const seen = new Set();
  const deduped = [];
  for (const item of (Array.isArray(list) ? list : [])) {
    if (!item || !item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
    if (deduped.length >= MAX_CATALOG_CLIPS) break;
  }
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(deduped, null, 2), 'utf8');
}

function httpsGetJson(urlString, redirectsRemaining = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      urlString,
      {
        headers: {
          'User-Agent': 'SampleVis/1.0 (https://samplevis.local; creative-visualizer) node-https',
          Accept: 'application/json'
        },
        timeout: 15000
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsRemaining > 0) {
          res.resume();
          let nextUrl = res.headers.location;
          try {
            nextUrl = new URL(nextUrl, urlString).href;
          } catch {
            return reject(new Error('invalid redirect url'));
          }
          return httpsGetJson(nextUrl, redirectsRemaining - 1).then(resolve, reject);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`http ${res.statusCode}`));
        }
        let body = '';
        res.setEncoding('utf8');
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
      req.destroy(new Error('request timed out'));
    });
  });
}

  function formatReadableTitle(tagsStr, postId, preferredTags = []) {
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
      'wind',
      'lighting',
      'walking',
      'walk_cycle',
      'running',
      'sitting',
      'animals',
      'bird',
      'smoke',
      'smears',
      'liquid',
      'rotation',
      'steven_universe',
      'western',
      'eastern',
      'web',
      '3d_background',
      'impact_frames',
      'sparks',
      'debris',
      'creatures'
    ]);
    const preferredSet = new Set((Array.isArray(preferredTags) ? preferredTags : []).map((t) => String(t).toLowerCase()));
    const showTag =
      tags.find((t) => preferredSet.has(t.toLowerCase()) && !metaIgnore.has(t) && t.length > 2) ||
      tags.find((t) => !metaIgnore.has(t) && t.length > 3) ||
      'anime_scene';
    const moodTags = tags.filter((t) =>
      ['wind', 'liquid', 'hair', 'fabric', 'background_animation', 'character_acting', 'walk_cycle', 'crying', 'dancing', 'instruments', 'performance', 'ice', 'fire', 'lightning'].includes(t)
    );
    const cleanShow = showTag.replace(/_/g, ' ');
    const cleanMood = moodTags.slice(0, 2).map((t) => t.replace(/_/g, ' ')).join(' · ');
    return cleanMood ? `${cleanShow} (${cleanMood})` : `${cleanShow} #${postId}`;
  }

  const ANIME_QUERY_ALIASES = [
    [/your\s*name|kimi\s*no\s*na/i, ['kimi_no_na_wa']],
    [/weathering|tenki\s*no\s*ko/i, ['tenki_no_ko', 'weathering_with_you']],
    [/suzume/i, ['suzume_no_tojimari']],
    [/5\s*cm|5\s*centimeters|byousoku/i, ['5_centimeters_per_second', 'byousoku_5_centimeter']],
    [/garden\s*of\s*words|kotonoha/i, ['the_garden_of_words']],
    [/violet\s*evergarden|violet/i, ['violet_evergarden']],
    [/silent\s*voice|koe\s*no\s*katachi/i, ['koe_no_katachi']],
    [/your\s*lie|shigatsu/i, ['shigatsu_wa_kimi_no_uso']],
    [/josee/i, ['josee_to_tora_to_sakana-tachi']],
    [/frieren/i, ['sousou_no_frieren']],
    [/attack\s*on\s*titan|\baot\b|shingeki/i, ['shingeki_no_kyojin']],
    [/demon\s*slayer|kimetsu/i, ['kimetsu_no_yaiba']],
    [/jujutsu\s*kaisen|\bjjk\b/i, ['jujutsu_kaisen']],
    [/chainsaw\s*man|\bcsm\b/i, ['chainsaw_man']],
    [/evangelion|\beva\b/i, ['neon_genesis_evangelion', 'evangelion']],
    [/spirited\s*away|chihiro/i, ['sen_to_chihiro_no_kamikakushi']],
    [/howl/i, ['howl_no_ugoku_shiro']],
    [/ghibli/i, ['sen_to_chihiro_no_kamikakushi', 'howl_no_ugoku_shiro', 'tonari_no_totoro', 'mononoke_hime']],
    [/makoto\s*shinkai|shinkai/i, ['kimi_no_na_wa', 'tenki_no_ko', '5_centimeters_per_second', 'the_garden_of_words']],
    [/kyoto\s*animation|kyoani/i, ['violet_evergarden', 'hyouka', 'hibike!_euphonium', 'liz_and_the_blue_bird']],
    [/my\s*hero\s*academia|\bmha\b|boku\s*no\s*hero/i, ['boku_no_hero_academia']],
    [/fullmetal\s*alchemist|\bfma\b/i, ['fullmetal_alchemist']],
    [/cowboy\s*bebop|bebop/i, ['cowboy_bebop']],
    [/cyberpunk|edgerunners/i, ['cyberpunk:_edgerunners', 'akira', 'ghost_in_the_shell']],
    [/mob\s*psycho/i, ['mob_psycho_100']],
    [/one\s*punch/i, ['one-punch_man']],
    [/bocchi/i, ['bocchi_the_rock!']],
    [/monogatari/i, ['monogatari_series', 'bakemonogatari']],
    [/oshi\s*no\s*ko/i, ['oshi_no_ko']],
    [/samurai\s*champloo|champloo/i, ['samurai_champloo']],
    [/dandadan/i, ['dandadan']],
    [/solo\s*leveling/i, ['solo_leveling']],
    [/mushishi/i, ['mushishi']],
    [/sonny\s*boy/i, ['sonny_boy']],
    [/hyouka/i, ['hyouka']],
    [/yuru\s*camp|laid[-\s]*back\s*camp/i, ['yuru_camp']],
    [/hibike|euphonium/i, ['hibike!_euphonium']],
    [/sky|clouds|sunset|twilight|horizon|sunrise/i, ['background_animation', 'kimi_no_na_wa', 'tenki_no_ko', 'wind']],
    [/rain|storm|puddle|umbrella|drizzle/i, ['the_garden_of_words', 'tenki_no_ko', 'liquid', 'background_animation']],
    [/ocean|sea|beach|wave|waves|water|river|lake/i, ['liquid', 'josee_to_tora_to_sakana-tachi', 'sonny_boy', 'background_animation']],
    [/city|street|train|station|bridge|urban|tokyo|neon/i, ['background_animation', '3d_background', 'suzume_no_tojimari', 'kimi_no_na_wa']],
    [/night|star|stars|moon|space|constellation|galaxy/i, ['kimi_no_na_wa', 'yuru_camp', 'background_animation', 'space_dandy']],
    [/wind|meadow|forest|grass|trees|nature|flower|blossom|sakura|petal/i, ['wind', 'hair', 'fabric', 'background_animation', 'violet_evergarden']],
    [/snow|ice|winter|cold/i, ['ice', '5_centimeters_per_second', 'yuru_camp', 'background_animation']],
    [/calm|peaceful|chill|melancholic|sad|cry|crying|emotional/i, ['character_acting', 'crying', 'hair', 'violet_evergarden']],
    [/music|piano|guitar|band|sing|singing|concert|dance|dancing/i, ['instruments', 'performance', 'dancing', 'bocchi_the_rock!', 'hibike!_euphonium']],
    [/fight|fighting|action|battle|combat|sword|sakuga/i, ['fighting', 'effects', 'smears', 'impact_frames']],
    [/fire|flame|explosion|spark|lightning|magic/i, ['fire', 'sparks', 'lightning', 'effects']],
    [/car|drive|driving|vehicle|bike|motorcycle/i, ['vehicle', '3d_background']],
    [/food|cooking|eat|eating|coffee|tea/i, ['food', 'character_acting']],
    [/run|running|walk|walking|chase/i, ['running', 'walk_cycle']],
    [/fly|flying|float|floating|falling/i, ['flying', 'falling', 'hair']]
  ];

  const SEARCH_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'anime', 'clip', 'clips', 'scene', 'cut']);

  function isWordBoundaryTagMatch(tagName, word) {
    const cleanTag = String(tagName || '').toLowerCase();
    const cleanWord = String(word || '').toLowerCase();
    if (!cleanTag || !cleanWord) return false;
    if (cleanTag === cleanWord) return true;
    const parts = cleanTag.split(/[_:!\-]+/).filter(Boolean);
    if (parts.includes(cleanWord)) return true;
    return cleanTag.startsWith(`${cleanWord}_`) || cleanTag.endsWith(`_${cleanWord}`);
  }

  async function resolveAnimeSearchQueries(customQuery, orderTag) {
    const cleanQ = String(customQuery || '').trim();
    const seen = new Set();
    const list = [];
    const matchedTagPool = [];
    const pushTag = (raw, weight = 1) => {
      const t = String(raw || '').trim();
      if (!t) return;
      const q = /order:/i.test(t) ? t : `${t} ${orderTag}`;
      if (!seen.has(q)) {
        seen.add(q);
        list.push({ query: q, vibe: 'custom', rawTag: t, weight });
        if (!t.includes(' ') && !t.includes(':')) {
          matchedTagPool.push(t);
        }
      }
    };

    const aliasMatches = [];
    for (const [re, tags] of ANIME_QUERY_ALIASES) {
      if (re.test(cleanQ)) {
        aliasMatches.push(...tags);
      }
    }

    const words = cleanQ
      .toLowerCase()
      .replace(/[^a-z0-9_'\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !SEARCH_STOP_WORDS.has(w));
    const lookupTerm = words.length > 1 ? words.join('_') : (words[0] || '');

    // look up real sakugabooru tags dynamically with word-boundary validation so substrings like "rain" -> "training" never pollute results
    const dynamicTags = [];
    const lookupTerms = [];
    if (lookupTerm) lookupTerms.push({ term: lookupTerm, isPhrase: words.length > 1 });
    for (const w of words.slice(0, 3)) {
      if (w !== lookupTerm) lookupTerms.push({ term: w, isPhrase: false });
    }

    if (lookupTerms.length > 0 && !/order:|:/i.test(cleanQ)) {
      const lookups = await Promise.allSettled(
        lookupTerms.map(({ term }) =>
          httpsGetJson(`https://www.sakugabooru.com/tag.json?limit=8&order=count&name=${encodeURIComponent(term)}`)
        )
      );
      lookups.forEach((res, idx) => {
        if (res.status !== 'fulfilled' || !Array.isArray(res.value)) return;
        const { term, isPhrase } = lookupTerms[idx];
        const minCount = isPhrase ? 3 : 8;
        const sorted = [...res.value].sort((a, b) => {
          // prefer series (type 3) and general (type 0) tags over artist names (type 1)
          const typeScore = (t) => (t?.type === 3 ? 3 : t?.type === 0 ? 2 : 1);
          const diff = typeScore(b) - typeScore(a);
          if (diff !== 0) return diff;
          return (Number(b?.count) || 0) - (Number(a?.count) || 0);
        });
        for (const tagObj of sorted) {
          if (!tagObj?.name || (Number(tagObj.count) || 0) < minCount) continue;
          const matchesBoundary = isPhrase
            ? (tagObj.name.toLowerCase() === term || words.every((w) => isWordBoundaryTagMatch(tagObj.name, w)))
            : isWordBoundaryTagMatch(tagObj.name, term);
          if (matchesBoundary) {
            dynamicTags.push(tagObj.name);
          }
        }
      });
    }

    if (/order:|_|:/i.test(cleanQ)) {
      pushTag(cleanQ, 4);
    }

    // when multiple distinct tags resolve (e.g. "frieren wind"), combine top two as an AND query first
    const orderedSeeds = [...new Set([...aliasMatches, ...dynamicTags])];
    if (words.length >= 2 && orderedSeeds.length >= 2) {
      const primary = orderedSeeds[0];
      const secondary = orderedSeeds.find((t) => t !== primary && !t.includes(primary) && !primary.includes(t));
      if (primary && secondary) {
        pushTag(`${primary} ${secondary}`, 4);
      }
    }

    for (const t of aliasMatches) pushTag(t, 3);
    for (const t of dynamicTags) pushTag(t, 2);

    if (list.length === 0 && lookupTerm) {
      pushTag(lookupTerm, 1);
    } else if (!/order:|_|:/i.test(cleanQ) && words.length === 1 && lookupTerm) {
      pushTag(lookupTerm, 1);
    }

    return {
      queries: list.slice(0, 8),
      preferredTags: [...new Set([...orderedSeeds, ...matchedTagPool])]
    };
  }

  function scoreAnimeSearchCandidate(entry, { customQuery, preferredTags, wantsAction }) {
    const baseScore = Math.log10(Math.max(10, entry.score || 10)) * 12;
    const tagSet = new Set(entry.tags.map((t) => t.toLowerCase()));
    const tagStr = entry.tags.join(' ').toLowerCase();
    let relevance = 0;

    if (customQuery) {
      const tokens = customQuery
        .toLowerCase()
        .replace(/[^a-z0-9_'\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2 && !SEARCH_STOP_WORDS.has(w));
      for (const tok of tokens) {
        if (tagSet.has(tok) || tagStr.includes(tok)) {
          relevance += 14;
        }
      }
      for (const pref of preferredTags) {
        if (tagSet.has(pref.toLowerCase())) {
          relevance += 18;
        }
      }
    }

    const atmosphereBonus =
      (entry.hasCharacter ? 6 : 0) +
      (tagSet.has('background_animation') ? 6 : 0) +
      (tagSet.has('wind') || tagSet.has('hair') || tagSet.has('liquid') ? 4 : 0);

    const hasActionTag = entry.tags.some((t) => ACTION_TAGS.has(t));
    const actionPenalty = customQuery && !wantsAction && hasActionTag ? -14 : 0;

    return relevance + baseScore + atmosphereBonus + actionPenalty;
  }

  // pulls mp4 clips from sakugabooru ('best' grabs top-scored cuts; 'random' samples with order:random)
  async function fetchAnimeClips({ category = 'all', customQuery = '', count = 4, mode = 'best', excludeIds = [] } = {}) {
    ensureDirs();
    const catalog = loadCatalog();
    const catalogIds = new Set(catalog.map((c) => String(c.sourceId)));
    const excludeSet = new Set(
      (Array.isArray(excludeIds) ? excludeIds : [])
        .map((id) => String(id).replace(/^clip_/, ''))
        .filter(Boolean)
    );
    const hasCustomQuery = Boolean(customQuery && String(customQuery).trim());
    const seenPostIds = new Set(excludeSet);
    if (mode !== 'random' && !hasCustomQuery) {
      for (const id of catalogIds) seenPostIds.add(id);
    }

    const orderTag = mode === 'random' ? 'order:random' : 'order:score';
    let queriesToRun = [];
    let preferredTags = [];
    if (hasCustomQuery) {
      const resolved = await resolveAnimeSearchQueries(customQuery, orderTag);
      queriesToRun = resolved.queries;
      preferredTags = resolved.preferredTags;
    } else if (category !== 'all' && MELANCHOLIC_PRESETS[category]) {
      queriesToRun = MELANCHOLIC_PRESETS[category].queries.map((q) => ({
        query: /order:/i.test(q) ? q : `${q} ${orderTag}`,
        vibe: MELANCHOLIC_PRESETS[category].vibe
      }));
    } else {
      const seenQueries = new Set();
      for (const preset of Object.values(MELANCHOLIC_PRESETS)) {
        for (const q of preset.queries.slice(0, 2)) {
          const query = /order:/i.test(q) ? q : `${q} ${orderTag}`;
          if (seenQueries.has(query)) continue;
          seenQueries.add(query);
          queriesToRun.push({
            query,
            vibe: preset.vibe
          });
        }
      }
    }

    const queryLower = String(customQuery || '').toLowerCase();
    const wantsAction = [...ACTION_TAGS].some((t) => queryLower.includes(t.replace(/_/g, ' ')) || queryLower.includes(t)) || /action|sakuga|fight|combat|battle/i.test(queryLower);
    const wantsProduction = [...PRODUCTION_JUNK_TAGS].some((t) => queryLower.includes(t.replace(/_/g, ' ')) || queryLower.includes(t));

    if (mode === 'random' || (!hasCustomQuery && category === 'all')) {
      queriesToRun.sort(() => Math.random() - 0.5);
    }

    const freshCandidates = [];
    const fallbackCandidates = [];
    const coveredVibes = new Set();
    const coveredQueries = new Set();

    for (let qi = 0; qi < queriesToRun.length; qi++) {
      const { query, vibe } = queriesToRun[qi];
      if (
        hasCustomQuery &&
        freshCandidates.length >= count * 3 &&
        coveredQueries.size >= Math.min(2, queriesToRun.length)
      ) {
        break;
      }
      if (
        mode === 'random' &&
        !hasCustomQuery &&
        category === 'all' &&
        freshCandidates.length >= Math.max(count * 3, 24) &&
        coveredVibes.size >= Math.min(4, count)
      ) {
        break;
      }

      const usesOrderRandom = /order:random/i.test(query);
      const targetPage = mode === 'random' && !usesOrderRandom ? Math.floor(Math.random() * 5) + 1 : 1;
      let apiUrl = `https://www.sakugabooru.com/post.json?limit=40&page=${targetPage}&tags=${encodeURIComponent(query)}`;

      try {
        let posts = await httpsGetJson(apiUrl);
        if (mode === 'best' && Array.isArray(posts)) {
          let unseenCount = posts.filter((p) => p && !seenPostIds.has(String(p.id))).length;
          // paginate deeper when earlier pages are already in the user's clip list
          for (let page = 2; page <= 4 && unseenCount < count && posts.length >= 20; page++) {
            const pageUrl = `https://www.sakugabooru.com/post.json?limit=40&page=${page}&tags=${encodeURIComponent(query)}`;
            const morePosts = await httpsGetJson(pageUrl).catch(() => []);
            if (!Array.isArray(morePosts) || morePosts.length === 0) break;
            posts = posts.concat(morePosts);
            unseenCount += morePosts.filter((p) => p && !seenPostIds.has(String(p.id))).length;
          }
        } else if (mode === 'random' && (!Array.isArray(posts) || posts.length < 3) && targetPage > 1) {
          apiUrl = `https://www.sakugabooru.com/post.json?limit=40&page=1&tags=${encodeURIComponent(query)}`;
          posts = await httpsGetJson(apiUrl);
        }
        if (!Array.isArray(posts)) continue;

        for (const post of posts) {
          if (!post || !post.file_url || seenPostIds.has(String(post.id))) continue;
          if (post.rating === 'e') continue;
          if (!post.file_url.endsWith('.mp4')) continue;
          // allow compact 150kb cuts up to 28mb hd sakuga mp4s
          if (post.file_size && (post.file_size < 150_000 || post.file_size > 28_000_000)) continue;

          const postTags = String(post.tags || '').split(/\s+/).filter(Boolean);
          if (postTags.some((t) => NSFW_TAGS.has(t))) continue;
          if (!wantsProduction && postTags.some((t) => PRODUCTION_JUNK_TAGS.has(t))) continue;
          if (!hasCustomQuery && postTags.some((t) => ACTION_TAGS.has(t))) continue;

          const score = typeof post.score === 'number' ? post.score : 0;
          const minScore = hasCustomQuery
            ? (mode === 'random' ? 0 : 1)
            : (mode === 'random' ? 8 : 12);
          if (score < minScore) continue;

          const hasCharacter = postTags.some((t) =>
            ['character_acting', 'walking', 'walk_cycle', 'hair', 'fabric', 'sitting', 'crying'].includes(t)
          );
          const entry = {
            post,
            vibe,
            hasCharacter,
            score,
            tags: postTags
          };
          if (catalogIds.has(String(post.id)) && !hasCustomQuery) {
            if (mode === 'random') fallbackCandidates.push(entry);
          } else {
            freshCandidates.push(entry);
            coveredVibes.add(vibe);
            coveredQueries.add(query);
          }
          seenPostIds.add(String(post.id));
        }
      } catch {
        // ignore single tag fetch failures
      }
    }

    const candidates = mode === 'random' && freshCandidates.length < count
      ? [...freshCandidates, ...fallbackCandidates]
      : freshCandidates;

    const byVibe = {};
    for (const item of candidates) {
      if (!byVibe[item.vibe]) byVibe[item.vibe] = [];
      byVibe[item.vibe].push(item);
    }

    for (const vibe of Object.keys(byVibe)) {
      const pool = byVibe[vibe];
      if (mode === 'random') {
        // score-weighted reservoir key so random mode still favors higher-rated cuts
        for (const item of pool) {
          const charBonus = item.hasCharacter ? 1.35 : 1.0;
          const qualityWeight = Math.sqrt(Math.max(10, item.score)) * charBonus;
          const u = Math.max(0.0001, Math.min(0.9999, Math.random()));
          item.randomRank = Math.pow(u, 1 / qualityWeight);
        }
        pool.sort((a, b) => b.randomRank - a.randomRank);
      } else if (hasCustomQuery) {
        pool.sort((a, b) =>
          scoreAnimeSearchCandidate(b, { customQuery, preferredTags, wantsAction }) -
          scoreAnimeSearchCandidate(a, { customQuery, preferredTags, wantsAction })
        );
      } else {
        pool.sort((a, b) => {
          const scoreA = (a.score || 0) * (a.hasCharacter ? 1.25 : 1.0);
          const scoreB = (b.score || 0) * (b.hasCharacter ? 1.25 : 1.0);
          return scoreB - scoreA;
        });
      }
    }

    // round-robin across vibes when pulling from 'all'
    const interleaved = [];
    const vibeKeys = Object.keys(byVibe);
    const maxLen = Math.max(0, ...vibeKeys.map((k) => byVibe[k].length));
    for (let i = 0; i < maxLen; i++) {
      for (const k of vibeKeys) {
        if (byVibe[k][i]) interleaved.push(byVibe[k][i]);
      }
    }

    const newlyAdded = [];
    for (const item of interleaved) {
      if (newlyAdded.length >= count) break;
      const { post, vibe, hasCharacter, tags, score } = item;
      // a clip is a link, never a file: the proxy streams it and the studio caches the bytes in
      // indexeddb, so nothing unlicensed is written to disk
      newlyAdded.push({
        id: `clip_${post.id}`,
        sourceId: String(post.id),
        filename: `sb_${post.id}.mp4`,
        url: `/api/clips/stream?url=${encodeURIComponent(post.file_url)}`,
        remoteUrl: post.file_url,
        source: 'anime',
        streamOnly: true,
        title: formatReadableTitle(post.tags || '', post.id, preferredTags),
        vibe,
        hasCharacter,
        score,
        width: post.width || 1280,
        height: post.height || 720,
        tags: tags.slice(0, 40),
        addedAt: new Date().toISOString()
      });
    }

    if (mode !== 'random') {
      persistUserStreamClips(newlyAdded);
    }
    return {
      added: newlyAdded,
      catalog: mode === 'random' ? newlyAdded : [...newlyAdded, ...catalog].slice(0, MAX_CATALOG_CLIPS)
    };
  }

    // picks initial clips matching the sample title's mood with a bit of random tie-breaking
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

        const jitter = Math.random() * 0.75;
        return { clip, effectiveScore: score + jitter };
      });
      scored.sort((a, b) => b.effectiveScore - a.effectiveScore);
      return scored.map((s) => s.clip);
    }

const REAL_LIFE_QUERIES = [
  'clouds sky',
  'nature timelapse',
  'night city lights',
  'sunset clouds',
  'city night',
  'ocean waves',
  'rain street',
  'forest wind',
  'rain window',
  'misty forest',
  'train station'
];

const REAL_LIFE_CATEGORY_QUERIES = {
  all: ['sunset clouds', 'city night', 'ocean waves', 'rain window', 'misty forest', 'train station'],
  kimi_no_na_wa: ['night sky stars', 'sunset clouds', 'train station', 'city twilight'],
  weathering_with_you: ['rain in the city', 'raindrops window', 'sunlight clouds', 'rainy street night'],
  suzume: ['abandoned train', 'ocean sunrise', 'coastal road', 'sunset sky'],
  '5_centimeters_per_second': ['pink flowers', 'train crossing', 'snowy street night', 'sunset clouds'],
  the_garden_of_words: ['rainy park', 'raindrops on water', 'green forest rain', 'rainy window'],
  violet_evergarden: ['golden hour field', 'calm lake', 'misty forest', 'autumn trees'],
  a_silent_voice: ['river sunlight', 'bridge sunset', 'night fireworks', 'pink flowers'],
  your_lie_in_april: ['spring flowers wind', 'grass in the wind', 'piano hands', 'golden sunset'],
  josee: ['ocean sunset', 'underwater light', 'city bridge night', 'aquarium fish'],
  frieren: ['grass in the wind', 'misty forest', 'night stars', 'mountain sunrise'],
  calm: ['calm lake', 'misty forest', 'sunlit leaves', 'slow clouds'],
  night_sunset: ['night city', 'sunset clouds', 'city lights night', 'golden hour sky'],
  character_melancholic: ['silhouette sunset', 'looking out window', 'walking in rain', 'train window'],
  city_walk_stairs: ['city street night', 'rain in the city', 'train station', 'bridge traffic night'],
  beach_ocean_breeze: ['ocean waves', 'beach sunset', 'coastal waves', 'sea breeze'],
  meadows_sky_night: ['grass in the wind', 'misty forest', 'sunset clouds', 'night stars']
};

const WIKIMEDIA_JUNK_TITLE_RE = /(diagram|animation|google earth|microscop|spoken|wikipedia|interview|lecture|news|webcam|logo|chart|simulation|screenshot|presentation|tutorial|conference|wikidata|screencast|3d render|timelapse of a 3d|laboratory|time-lapse of a mold)/i;

function shuffleCopy(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildRealLifeQueryPool({ category = 'all', customQuery = '', mode = 'best' } = {}) {
  const cleanQuery = String(customQuery || '').trim();
  if (cleanQuery) {
    const words = cleanQuery.split(/\s+/).filter(Boolean);
    const seen = new Set([cleanQuery.toLowerCase()]);
    const queries = [cleanQuery];
    if (words.length > 2) {
      const firstTwo = words.slice(0, 2).join(' ');
      if (!seen.has(firstTwo.toLowerCase())) {
        seen.add(firstTwo.toLowerCase());
        queries.push(firstTwo);
      }
    }
    if (words.length > 1) {
      for (const w of words) {
        if (w.length >= 3 && !SEARCH_STOP_WORDS.has(w.toLowerCase()) && !seen.has(w.toLowerCase())) {
          seen.add(w.toLowerCase());
          queries.push(w);
        }
      }
    }
    return { baseQuery: cleanQuery, queries };
  }

  const pool = REAL_LIFE_CATEGORY_QUERIES[category] || REAL_LIFE_QUERIES;
  const ordered = mode === 'random' ? shuffleCopy(pool) : [...pool];
  return { baseQuery: ordered[0], queries: ordered };
}

function scoreCoverrHit(hit, queryText = '') {
  const dl = Number(hit.downloads) || 0;
  const views = Number(hit.views) || 0;
  const resBonus = Number(hit.max_height) >= 1080 ? 15 : 0;
  let queryBonus = 0;
  const cleanQ = String(queryText || '').trim().toLowerCase();
  if (cleanQ) {
    const titleLower = String(hit.title || '').toLowerCase();
    const tagsLower = Array.isArray(hit.tags) ? hit.tags.join(' ').toLowerCase() : '';
    const descLower = String(hit.description || '').toLowerCase();
    if (titleLower.includes(cleanQ)) queryBonus += 35;
    const tokens = cleanQ.split(/\s+/).filter((w) => w.length >= 2 && !SEARCH_STOP_WORDS.has(w));
    for (const tok of tokens) {
      if (titleLower.includes(tok)) queryBonus += 18;
      else if (tagsLower.includes(tok)) queryBonus += 12;
      else if (descLower.includes(tok)) queryBonus += 5;
    }
  }
  return queryBonus + Math.log10(dl + 1) * 18 + Math.log10(views + 1) * 6 + resBonus;
}

async function fetchCoverrRealLifeClips({ queries, baseQuery, customQuery = '', category, count, mode, excludeSet, seenUrls }) {
  const candidates = [];
  const seenIds = new Set();
  const requestErrors = [];
  let succeededRequests = 0;
  const maxPagesPerQuery = customQuery ? 3 : 2;

  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    if (candidates.length >= count * 2) break;
    // only fall back to split single-word queries if the full phrase returned sparse results
    if (customQuery && qi > 0 && candidates.length >= count) break;

    let totalPages = 1;
    for (let pageOffset = 0; pageOffset < maxPagesPerQuery && pageOffset < totalPages; pageOffset++) {
      if (candidates.length >= count * 2) break;
      const targetPage = mode === 'random' && totalPages > 1 && pageOffset === 0
        ? Math.floor(Math.random() * totalPages)
        : pageOffset;
      const url = `https://coverr.co/api/videos?query=${encodeURIComponent(q)}&page=${targetPage}&page_size=24`;
      let payload;
      try {
        payload = await httpsGetJson(url);
        succeededRequests += 1;
      } catch (err) {
        requestErrors.push(err?.message || 'coverr search failed');
        break;
      }

      totalPages = Math.min(Number(payload?.pages) || 1, 5);
      let hits = Array.isArray(payload?.hits) ? payload.hits : [];
      if (mode === 'random' && pageOffset === 0 && totalPages > 1) {
        const randomPage = Math.floor(Math.random() * totalPages);
        if (randomPage > 0) {
          try {
            const randPayload = await httpsGetJson(
              `https://coverr.co/api/videos?query=${encodeURIComponent(q)}&page=${randomPage}&page_size=24`
            );
            if (Array.isArray(randPayload?.hits) && randPayload.hits.length > 0) {
              hits = randPayload.hits;
            }
          } catch { }
        }
      }

      if (hits.length === 0) break;
      for (const h of hits) {
        const id = String(h?.id || '');
        if (!id || seenIds.has(id)) continue;
        if (excludeSet.has(id) || excludeSet.has(`cv_${id}`)) continue;
        if (h.is_premium || h.is_ai_generated || h.is_vertical) continue;
        if (h.state && h.state !== 'published') continue;
        const w = Number(h.max_width) || 0;
        const ht = Number(h.max_height) || 0;
        const dur = parseFloat(h.duration) || 0;
        if (w < 1280 || ht < 720 || w < ht) continue;
        if (dur > 0 && (dur < 3 || dur > 45)) continue;
        seenIds.add(id);
        candidates.push(h);
      }
    }
  }

  const ordered = mode === 'random'
    ? shuffleCopy(candidates)
    : candidates.sort((a, b) => scoreCoverrHit(b, customQuery || baseQuery) - scoreCoverrHit(a, customQuery || baseQuery));

  const targetSlice = ordered.slice(0, Math.min(ordered.length, count + 6));
  const detailResults = await Promise.allSettled(
    targetSlice.map((h) => httpsGetJson(`https://coverr.co/api/videos/${encodeURIComponent(h.id)}`))
  );

  const clips = [];
  for (let i = 0; i < detailResults.length && clips.length < count; i++) {
    const res = detailResults[i];
    if (res.status !== 'fulfilled' || !res.value) continue;
    const d = res.value;
    const mp4Url = d?.urls?.mp4;
    if (typeof mp4Url !== 'string' || !mp4Url.startsWith('https://cdn.coverr.co/')) continue;
    if (seenUrls.has(mp4Url)) continue;

    seenUrls.add(mp4Url);
    const id = String(d.id || targetSlice[i].id);
    const cleanTitle = String(d.title || 'real life clip').trim().slice(0, 64) || 'real life clip';
    const tags = Array.isArray(d.tags)
      ? d.tags.map((t) => String(t).toLowerCase()).filter(Boolean).slice(0, 16)
      : baseQuery.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);

    clips.push({
      id: `cv_${id}`,
      sourceId: id,
      filename: `cv_${id}.mp4`,
      url: `/api/clips/stream?url=${encodeURIComponent(mp4Url)}`,
      remoteUrl: mp4Url,
      source: 'real_life',
      category: String(category || 'all'),
      streamOnly: true,
      title: cleanTitle.toLowerCase(),
      vibe: 'real_life',
      hasCharacter: false,
      score: Math.round(scoreCoverrHit(d, customQuery || baseQuery)),
      width: Math.min(1920, Number(d.max_width) || 1920),
      height: Math.min(1080, Number(d.max_height) || 1080),
      duration: Math.round((parseFloat(d.duration) || 15) * 10) / 10,
      tags,
      addedAt: new Date().toISOString()
    });
  }

  return { clips, succeededRequests, requestErrors };
}

function pickWikimediaDerivativeUrl(page) {
  const derivatives = page?.videoinfo?.[0]?.derivatives;
  if (Array.isArray(derivatives) && derivatives.length > 0) {
    const webmTranscodes = derivatives
      .filter((d) => typeof d?.src === 'string' && d.src.startsWith('https://upload.wikimedia.org/') && /\.vp9\.webm/i.test(d.src))
      .sort((a, b) => (Number(a.height) || 0) - (Number(b.height) || 0));
    const ideal = webmTranscodes.find((d) => Number(d.height) >= 720 && Number(d.height) <= 1080);
    if (ideal) return { url: ideal.src, width: Number(ideal.width) || 1280, height: Number(ideal.height) || 720, ext: 'webm' };
    const hd = webmTranscodes.find((d) => Number(d.height) >= 540);
    if (hd) return { url: hd.src, width: Number(hd.width) || 960, height: Number(hd.height) || 540, ext: 'webm' };
  }

  const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
  if (!info || !info.url) return null;
  const mime = String(info.mime || '').toLowerCase();
  const urlLower = String(info.url).toLowerCase();
  const isNativePlayable = mime.includes('mp4') || mime.includes('webm') || /\.(mp4|webm)(\?|$)/i.test(urlLower);
  if (!isNativePlayable) return null;
  if (typeof info.size === 'number' && (info.size < 350 * 1024 || info.size > 30 * 1024 * 1024)) return null;
  return {
    url: info.url,
    width: Number(info.width) || 1280,
    height: Number(info.height) || 720,
    ext: (mime.includes('webm') || /\.webm(\?|$)/i.test(urlLower)) ? 'webm' : 'mp4'
  };
}

async function fetchWikimediaRealLifeClips({ queries, baseQuery, customQuery = '', category, count, mode, excludeSet, seenUrls }) {
  const added = [];
  const requestErrors = [];
  let succeededRequests = 0;
  const queryTokens = String(customQuery || baseQuery || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !SEARCH_STOP_WORDS.has(w));

  for (const rawQ of queries) {
    if (added.length >= count) break;
    const q = `${rawQ} filetype:video`;
    const offsets = mode === 'random' ? [Math.floor(Math.random() * 2) * 12, 0] : [0, 24];
    const buildUrl = (off) =>
      `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(q)}&gsrlimit=24&gsroffset=${off}&prop=imageinfo|videoinfo&iiprop=url|size|mime&viprop=derivatives&format=json`;

    for (const offset of offsets) {
      if (added.length >= count) break;
      let payload = null;
      try {
        payload = await httpsGetJson(buildUrl(offset));
        succeededRequests += 1;
      } catch (err) {
        requestErrors.push(err?.message || 'wikimedia request failed');
        continue;
      }

      let pages = Object.values(payload?.query?.pages || {});
      if (pages.length === 0) break;
      if (mode === 'random') {
        pages = shuffleCopy(pages);
      } else {
        pages.sort((a, b) => {
          const titleA = String(a?.title || '').toLowerCase();
          const titleB = String(b?.title || '').toLowerCase();
          const matchA = queryTokens.reduce((acc, t) => acc + (titleA.includes(t) ? 1 : 0), 0);
          const matchB = queryTokens.reduce((acc, t) => acc + (titleB.includes(t) ? 1 : 0), 0);
          if (matchB !== matchA) return matchB - matchA;
          const hA = Number(a?.imageinfo?.[0]?.height) || 0;
          const hB = Number(b?.imageinfo?.[0]?.height) || 0;
          return hB - hA;
        });
      }

      for (const page of pages) {
        if (added.length >= count) break;
        const pageIdStr = String(page?.pageid || '');
        if (pageIdStr && (excludeSet.has(pageIdStr) || excludeSet.has(`wm_${pageIdStr}`))) continue;

        const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
        if (!info || !info.url) continue;
        if (typeof info.size === 'number' && info.size > 80 * 1024 * 1024) continue;

        const rawTitle = String(page.title || '')
          .replace(/^File:/i, '')
          .replace(/\.[a-z0-9]+$/i, '')
          .replace(/[_-]+/g, ' ')
          .trim()
          .slice(0, 64) || 'real life clip';
        if (!rawTitle || WIKIMEDIA_JUNK_TITLE_RE.test(rawTitle)) continue;

        if ((Number(info.width) || 0) < 960 || (Number(info.height) || 0) < 540 || Number(info.width) < Number(info.height)) continue;
        if (typeof info.duration === 'number' && (info.duration < 3 || info.duration > 60)) continue;

        const chosen = pickWikimediaDerivativeUrl(page);
        if (!chosen || seenUrls.has(chosen.url)) continue;

        seenUrls.add(chosen.url);
        added.push({
          id: `wm_${page.pageid || Date.now()}_${added.length}`,
          sourceId: String(page.pageid || chosen.url),
          filename: `wm_${page.pageid || 'clip'}.${chosen.ext}`,
          url: `/api/clips/stream?url=${encodeURIComponent(chosen.url)}`,
          remoteUrl: chosen.url,
          source: 'real_life',
          category: String(category || 'all'),
          streamOnly: true,
          title: rawTitle.slice(0, 64).toLowerCase(),
          vibe: 'real_life',
          hasCharacter: false,
          score: chosen.height >= 1080 ? 35 : 25,
          width: chosen.width,
          height: chosen.height,
          duration: typeof info.duration === 'number' ? Math.round(info.duration * 10) / 10 : undefined,
          tags: [...baseQuery.toLowerCase().split(/\s+/).filter(Boolean), String(category || 'all').toLowerCase()].slice(0, 12),
          addedAt: new Date().toISOString()
        });
      }
      if (mode === 'random') break;
    }
  }

  return { clips: added, succeededRequests, requestErrors };
}

// searches curated hd stock (coverr) first and falls back to filtered wikimedia commons without touching disk
async function fetchRealLifeClips({ category = 'all', customQuery = '', count = 12, mode = 'best', excludeIds = [] } = {}) {
  ensureDirs();
  const catalog = loadCatalog();
  const { baseQuery, queries } = buildRealLifeQueryPool({ category, customQuery, mode });
  const excludeSet = new Set((Array.isArray(excludeIds) ? excludeIds : []).map(String));
  const seenUrls = new Set();

  const coverr = await fetchCoverrRealLifeClips({
    queries,
    baseQuery,
    customQuery,
    category,
    count,
    mode,
    excludeSet,
    seenUrls
  });

  const added = [...coverr.clips];
  let succeededRequests = coverr.succeededRequests;
  const requestErrors = [...coverr.requestErrors];

  if (added.length < count) {
    const fallback = await fetchWikimediaRealLifeClips({
      queries,
      baseQuery,
      customQuery,
      category,
      count: count - added.length,
      mode,
      excludeSet,
      seenUrls
    });
    added.push(...fallback.clips);
    succeededRequests += fallback.succeededRequests;
    requestErrors.push(...fallback.requestErrors);
  }

  if (added.length === 0 && succeededRequests === 0 && requestErrors.length > 0) {
    throw new Error(`real-life clip fetch failed (${requestErrors[0]})`);
  }

  if (mode !== 'random') {
    persistUserStreamClips(added);
  }

  return {
    added,
    catalog: mode === 'random' ? added : [...added, ...catalog].slice(0, MAX_CATALOG_CLIPS)
  };
}

module.exports = {
  MELANCHOLIC_PRESETS,
  loadCatalog,
  saveCatalog,
  fetchAnimeClips,
  fetchRealLifeClips,
  pickClipsForSample,
  CLIPS_DIR
};
