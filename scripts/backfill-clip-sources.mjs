#!/usr/bin/env node
/**
 * Records where each catalog clip came from, so a machine without the downloaded files can stream it
 * through /api/clips/stream and cache the bytes locally instead of 404ing on /anime-clips.
 *
 * The library is a list of sakugabooru posts; this asks the API for each post's file_url and writes
 * it back as `remoteUrl`. Entries that already have one are skipped, so it is safe to re-run.
 *
 *   node scripts/backfill-clip-sources.mjs [--delay 600]
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'data', 'anime-library.json');
const delayArg = process.argv.indexOf('--delay');
const DELAY_MS = delayArg > -1 ? Number(process.argv[delayArg + 1]) || 600 : 600;

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'samplevis/0.1.1 (+clip catalog)' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const library = JSON.parse(fs.readFileSync(LIBRARY, 'utf8'));
const missing = library.filter((entry) => entry.sourceId && !entry.remoteUrl);
console.log(`  ${library.length} clip(s), ${missing.length} need a source url`);

let resolved = 0;
let failed = 0;

for (const entry of missing) {
  try {
    const posts = await getJson(`https://www.sakugabooru.com/post.json?limit=1&tags=id:${encodeURIComponent(entry.sourceId)}`);
    const post = Array.isArray(posts) ? posts[0] : null;
    if (!post?.file_url) throw new Error('no file_url');
    entry.remoteUrl = post.file_url;
    entry.source = entry.source || 'anime';
    entry.streamOnly = true;
    if (post.file_size) entry.remoteBytes = Number(post.file_size) || undefined;
    resolved += 1;
    console.log(`  ${entry.id} -> ${post.file_url}`);
  } catch (err) {
    failed += 1;
    console.warn(`  ${entry.id} failed: ${err.message}`);
  }
  await sleep(DELAY_MS);
}

if (resolved > 0) {
  fs.writeFileSync(LIBRARY, `${JSON.stringify(library, null, 2)}\n`);

  // the Pages function keeps its own copy of the same list; keep both pointing at the same sources
  const pagesCatalog = path.join(ROOT, 'functions', 'api', '_data', 'anime-library.js');
  if (fs.existsSync(path.dirname(pagesCatalog))) {
    const entries = library.map((clip) => ({
      ...clip,
      url: `/api/clips/stream?url=${encodeURIComponent(clip.remoteUrl)}`,
      streamOnly: true
    }));
    fs.writeFileSync(pagesCatalog, `export default ${JSON.stringify(entries, null, 2)};\n`);
    console.log(`  rewrote ${path.relative(ROOT, pagesCatalog)}`);
  }
}

console.log(`\n  ${resolved} resolved, ${failed} failed, ${library.filter((e) => e.remoteUrl).length}/${library.length} have a source url`);
process.exit(failed > 0 ? 1 : 0);
