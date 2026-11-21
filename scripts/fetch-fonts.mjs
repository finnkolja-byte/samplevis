// vendors the studio's font library: downloads the latin woff2 subsets and each family's licence
// from google fonts, then writes public/fonts/fonts.css and public/js/engine/fontLibrary.js.
// run `npm run fonts:sync` after editing FONT_FAMILIES. the sandboxed renderer cannot fetch these
// files, so fontLibrary.js is what lets the host push the exact bytes a preset asks for.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = path.join(ROOT, 'public', 'fonts');
const CSS_FILE = path.join(FONT_DIR, 'fonts.css');
const MANIFEST_FILE = path.join(ROOT, 'public', 'js', 'engine', 'fontLibrary.js');
const LICENSE_INDEX = path.join(FONT_DIR, 'LICENSES.md');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// every family here is SIL Open Font License 1.1, which allows commercial use and redistribution
// with the licence text. weights are kept to what the inspector and presets actually use.
const FONT_FAMILIES = [
  { family: 'Geist', slug: 'geist', faces: [[400, 'normal'], [500, 'normal'], [600, 'normal']] },
  { family: 'Geist Mono', slug: 'geistmono', faces: [[400, 'normal'], [500, 'normal'], [600, 'normal']] },
  { family: 'Plus Jakarta Sans', slug: 'plusjakartasans', faces: [[500, 'normal'], [600, 'normal'], [700, 'normal']] },
  { family: 'Space Grotesk', slug: 'spacegrotesk', faces: [[400, 'normal'], [500, 'normal'], [700, 'normal']] },
  { family: 'Instrument Serif', slug: 'instrumentserif', faces: [[400, 'normal'], [400, 'italic']] },
  { family: 'Playfair Display', slug: 'playfairdisplay', faces: [[500, 'normal'], [700, 'normal'], [400, 'italic']] },
  { family: 'Bodoni Moda', slug: 'bodonimoda', faces: [[400, 'normal'], [700, 'normal']] },
  { family: 'Lora', slug: 'lora', faces: [[400, 'normal'], [400, 'italic']] },
  { family: 'Cormorant Garamond', slug: 'cormorantgaramond', faces: [[500, 'normal'], [600, 'normal'], [500, 'italic']] },
  { family: 'Anton', slug: 'anton', faces: [[400, 'normal']] },
  { family: 'Bebas Neue', slug: 'bebasneue', faces: [[400, 'normal']] },
  { family: 'Syne', slug: 'syne', faces: [[400, 'normal'], [700, 'normal']] },
  { family: 'IBM Plex Mono', slug: 'ibmplexmono', faces: [[400, 'normal'], [600, 'normal']] }
];

const SUBSETS = new Set(['latin', 'latin-ext']);

function cssQuery(family) {
  const tuples = [];
  for (const [weight, style] of family.faces) {
    tuples.push(style === 'italic' ? `1,${weight}` : `0,${weight}`);
  }
  const unique = [...new Set(tuples)].sort();
  const axes = unique.some((t) => t.startsWith('1,')) ? 'ital,wght@' : 'wght@';
  const values = axes === 'ital,wght@' ? unique.join(';') : unique.map((t) => t.replace(/^0,/, '')).join(';');
  return `family=${encodeURIComponent(family.family).replace(/%20/g, '+')}:${axes}${values}`;
}

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return as === 'buffer' ? Buffer.from(await res.arrayBuffer()) : res.text();
}

function parseFaces(css) {
  const out = [];
  const blocks = css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g);
  for (const [, subset, body] of blocks) {
    if (!SUBSETS.has(subset)) continue;
    const style = /font-style:\s*(\w+)/.exec(body)?.[1] || 'normal';
    const weight = Number(/font-weight:\s*(\d+)/.exec(body)?.[1] || 400);
    const url = /src:\s*url\(([^)]+)\)/.exec(body)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1].trim();
    if (!url || !range) continue;
    out.push({ subset, style, weight, url, range });
  }
  return out;
}

async function main() {
  await fs.mkdir(FONT_DIR, { recursive: true });
  const faces = [];
  const licenceLines = [];
  let bytes = 0;

  for (const family of FONT_FAMILIES) {
    const css = await get(`https://fonts.googleapis.com/css2?${cssQuery(family)}&display=swap`);
    const parsed = parseFaces(css);
    if (parsed.length === 0) throw new Error(`no latin faces for ${family.family}`);

    const dir = path.join(FONT_DIR, family.slug);
    await fs.mkdir(dir, { recursive: true });

    for (const face of parsed) {
      const name = `${family.slug}-${face.weight}${face.style === 'italic' ? 'i' : ''}-${face.subset}.woff2`;
      const buffer = await get(face.url, 'buffer');
      await fs.writeFile(path.join(dir, name), buffer);
      bytes += buffer.length;
      faces.push({
        family: family.family,
        slug: family.slug,
        weight: face.weight,
        style: face.style,
        subset: face.subset,
        unicodeRange: face.range,
        file: `/fonts/${family.slug}/${name}`
      });
    }

    const licence = await get(`https://raw.githubusercontent.com/google/fonts/main/ofl/${family.slug}/OFL.txt`);
    await fs.writeFile(path.join(dir, 'OFL.txt'), licence);
    const holder = /^(Copyright\s+.+)$/im.exec(licence)?.[1]?.trim() || family.family;
    licenceLines.push(`- **${family.family}** (${family.slug}), SIL Open Font License 1.1. ${holder}`);
    console.log(`  ${family.family.padEnd(20)} ${String(parsed.length).padStart(2)} faces`);
  }

  const css = [
    '/* generated by scripts/fetch-fonts.mjs - run `npm run fonts:sync` to regenerate */',
    ...faces.map((face) => [
      '@font-face {',
      `  font-family: '${face.family}';`,
      `  font-style: ${face.style};`,
      `  font-weight: ${face.weight};`,
      '  font-display: swap;',
      `  src: url('${face.file}') format('woff2');`,
      `  unicode-range: ${face.unicodeRange};`,
      '}'
    ].join('\n'))
  ].join('\n\n');
  await fs.writeFile(CSS_FILE, `${css}\n`);

  const families = [...new Set(faces.map((f) => f.family))];
  const manifest = `// generated by scripts/fetch-fonts.mjs - run \`npm run fonts:sync\` to regenerate.
// the studio and the sandboxed renderer read the same list, so a family added here shows up in the
// inspector dropdown and becomes available to preset scripts without a second registration path.
(function () {
  var FACES = ${JSON.stringify(faces, null, 2).replace(/\n/g, '\n  ')};
  var root = typeof window !== 'undefined' ? window : globalThis;
  root.STUDIO_FONTS = {
    families: ${JSON.stringify(families, null, 2).replace(/\n/g, '\n    ')},
    faces: FACES
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.STUDIO_FONTS;
})();
`;
  await fs.writeFile(MANIFEST_FILE, manifest);

  const index = [
    '# Bundled Fonts',
    '',
    'All families in `public/fonts` are licensed under the SIL Open Font License 1.1, which permits',
    'commercial use, embedding and redistribution alongside this application. The full licence and',
    'copyright notice for each family sits next to its files as `OFL.txt`.',
    '',
    ...licenceLines,
    ''
  ].join('\n');
  await fs.writeFile(LICENSE_INDEX, index);

  console.log(`\n${families.length} families · ${faces.length} faces · ${(bytes / 1024).toFixed(0)} kB`);
  console.log(`wrote ${path.relative(ROOT, CSS_FILE)}, ${path.relative(ROOT, MANIFEST_FILE)}, ${path.relative(ROOT, LICENSE_INDEX)}`);
}

main().catch((err) => {
  console.error(`font sync failed: ${err.message}`);
  process.exit(1);
});
