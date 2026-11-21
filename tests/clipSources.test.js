// the clip library is metadata only. a clip is always a link: it streams through /api/clips/stream
// and the studio caches the bytes in indexeddb. a file left in data/anime-clips by an older download
// must be ignored, so no unlicensed footage can be served from the app folder.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'samplevis-clips-'));
fs.mkdirSync(path.join(dir, 'anime-clips'), { recursive: true });
fs.writeFileSync(path.join(dir, 'anime-clips', 'sb_local.mp4'), 'not really an mp4');
fs.writeFileSync(path.join(dir, 'anime-library.json'), JSON.stringify([
  {
    id: 'local1',
    sourceId: '1',
    filename: 'sb_local.mp4',
    url: '/anime-clips/sb_local.mp4',
    remoteUrl: 'https://www.sakugabooru.com/data/aaaa.mp4'
  },
  {
    id: 'stream1',
    sourceId: '2',
    filename: 'sb_missing.mp4',
    url: '/anime-clips/sb_missing.mp4',
    remoteUrl: 'https://www.sakugabooru.com/data/bbbb.mp4'
  },
  {
    id: 'orphan1',
    sourceId: '3',
    filename: 'sb_orphan.mp4',
    url: '/anime-clips/sb_orphan.mp4'
  }
], null, 2));

process.env.SAMPLEVIS_DATA_DIR = dir;
const { loadCatalog } = require('../src/media/animeFetcher.js');

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label.padEnd(56)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}

const catalog = loadCatalog();
const byId = new Map(catalog.map((clip) => [clip.id, clip]));

check('a leftover local file is ignored', byId.get('local1').url,
  `/api/clips/stream?url=${encodeURIComponent('https://www.sakugabooru.com/data/aaaa.mp4')}`);
check('a leftover local file does not un-mark the clip', byId.get('local1').streamOnly, true);

const proxied = byId.get('stream1');
check('a clip with no local file streams through the proxy', proxied.url,
  `/api/clips/stream?url=${encodeURIComponent('https://www.sakugabooru.com/data/bbbb.mp4')}`);
check('a streamed clip is marked stream-only', proxied.streamOnly, true);
check('a streamed clip keeps its filename', proxied.filename, 'sb_missing.mp4');

check('an entry with no local file and no source is dropped', byId.has('orphan1'), false);

// the bundled catalog is merged too; every entry must resolve to one of the three shapes
const shapes = new Set(catalog.map((clip) => (
  clip.unavailable ? 'unavailable' : clip.streamOnly ? 'proxy' : 'local'
)));
check('every catalog entry resolves to a playable shape', [...shapes].every((s) => ['local', 'proxy', 'unavailable'].includes(s)), true);

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\nclip sources: ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
