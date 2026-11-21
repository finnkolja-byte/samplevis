// clip hydration decides whether a seek reads local bytes or round-trips to the stream proxy.
// app.js is a browser IIFE with no Node entry point, so these pin the wiring in source form.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const bundleSrc = fs.readFileSync(path.join(ROOT, 'public/js/services/projectBundleService.js'), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label.padEnd(58)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}

// --- restore path ---

const hydrate = appSrc.match(/const hydrateClipUrl = async \(c\) => \{[\s\S]*?\n    \};/);
check('hydrate: function present', Boolean(hydrate), true);
const hydrateSrc = hydrate ? hydrate[0] : '';

// the old guard skipped the cache for every clip that carried a remoteUrl, which is every starter
// clip that streams through the proxy
check('hydrate: old remoteUrl guard removed', hydrateSrc.includes('!c.url && !c.remoteUrl'), false);
check('hydrate: cache consulted for a missing url', /\(!clip\.url \|\| proxied\)/.test(hydrateSrc), true);
check('hydrate: proxy url counts as needing cache', /const proxied = typeof clip\.url === 'string' && clip\.url\.startsWith\('\/api\/clips\/stream'\)/.test(hydrateSrc), true);
check('hydrate: stale blob url discarded', /startsWith\('blob:'\)\) \? \{ \.\.\.c, url: undefined \}/.test(hydrateSrc), true);
check('hydrate: cached object url returned', /rec\?\.objectUrl/.test(hydrateSrc), true);
check('hydrate: local catalog url still preferred', /catalogById\.get\(clip\.id\)/.test(hydrateSrc), true);

// --- background cache fill ---

check('cache: bounded batch', /const CLIP_CACHE_MAX = \d+;/.test(appSrc), true);
check('cache: honours save-data', /navigator\.connection\?\.saveData/.test(appSrc), true);
check('cache: only proxies are fetched', /clip\.url\.startsWith\('\/api\/clips\/stream'\)/.test(appSrc), true);
check('cache: existing blobs skipped', /if \(existing\?\.blob\) continue;/.test(appSrc), true);
check('cache: writes through cacheClipBlob', /projectBundleService\.cacheClipBlob\(clip\.id, blob, clip\)/.test(appSrc), true);
check('cache: scheduled from the playlist sync', /scheduleClipBlobCache\(\);\s*\n  \}/.test(appSrc), true);
check('cache: debounced', /clearTimeout\(_clipCacheTimer\)/.test(appSrc), true);

// the record has to carry a live object url or the restore path can never use it
check('bundle: cache record exposes objectUrl', /return \{ \.\.\.record, objectUrl \};/.test(bundleSrc), true);
check('bundle: cache record requires a blob', /if \(!record \|\| !record\.blob\) return null;/.test(bundleSrc), true);

process.exit(failures > 0 ? 1 : 0);
