const fs = require('fs');
const path = require('path');

// the studio ships its own type library so no page depends on google fonts, and the sandboxed
// renderer depends on both the manifest and the woff2 files existing. a missing file is a silent
// fallback at runtime, so it has to fail here instead.

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label.padEnd(52)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));

const library = require('../public/js/engine/fontLibrary.js');

check('library: families present', library.families.length >= 10, true);
check('library: no duplicate families', new Set(library.families).size, library.families.length);
check('library: faces reference a family', library.faces.every((face) => library.families.includes(face.family)), true);
check('library: every face has a unicode range', library.faces.every((face) => typeof face.unicodeRange === 'string' && face.unicodeRange.includes('U+')), true);
check('library: every face has a weight and style', library.faces.every((face) => Number.isFinite(face.weight) && (face.style === 'normal' || face.style === 'italic')), true);

const missingFiles = library.faces.filter((face) => !exists(`public${face.file}`));
check('library: every woff2 exists', missingFiles.map((face) => face.file), []);
const smallFiles = library.faces.filter((face) => exists(`public${face.file}`) && fs.statSync(path.join(root, `public${face.file}`)).size < 4096);
check('library: no truncated woff2', smallFiles.map((face) => face.file), []);
const missingLicences = library.families.filter((family) => !exists(`public/fonts/${library.faces.find((f) => f.family === family).slug}/OFL.txt`));
check('library: every family ships its OFL', missingLicences, []);

const css = read('public/fonts/fonts.css');
const cssFaces = (css.match(/@font-face\s*\{/g) || []).length;
check('css: one block per face', cssFaces, library.faces.length);
check('css: only local sources', /https?:\/\//.test(css), false);
const cssMissing = library.faces.filter((face) => !css.includes(`url('${face.file}')`));
check('css: every face is declared', cssMissing.map((face) => face.file), []);

// the page must not reach a font CDN, and neither CSP should still allow one. a page absent from
// this edition (the legal pages are not part of the desktop build) has no references to find.
const pages = ['public/index.html', 'public/gallery.html', 'public/brand-assets.html', 'public/privacy.html', 'public/terms.html']
  .filter((page) => fs.existsSync(path.join(__dirname, '..', page)));
const pageRefs = pages.filter((page) => /fonts\.(googleapis|gstatic)\.com/.test(read(page)));
check('pages: no google font references', pageRefs, []);
check('pages: the edition keeps its engine pages', ['public/index.html', 'public/gallery.html'].every((p) => pages.includes(p)), true);
check('pages: studio loads the local stylesheet', read('public/index.html').includes('/fonts/fonts.css'), true);

check('csp: dev server allows no font CDN', /fonts\.gstatic|fonts\.googleapis/.test(read('server.js')), false);
check('csp: electron allows no font CDN', /fonts\.gstatic|fonts\.googleapis/.test(read('electron/main.js')), false);
check('csp: frame still allows local font sources', /font-src blob: data:/.test(read('public/js/engine/rendererFrame.js')), true);

// the inspector dropdown is generated from the same list, not a second hardcoded array
check('inspector: font defaults come from the library', read('public/js/engine/controlsManager.js').includes('window.STUDIO_FONTS?.families'), true);

// the host pushes only families the preset names, so both ends of that transport must exist
const sandbox = read('public/js/engine/sandboxEngine.js');
check('sandbox: preset families are resolved', sandbox.includes('namedFamilies(preset)'), true);
check('sandbox: faces are pushed on boot', sandbox.includes("sendCommand('fonts'"), true);
check('sandbox: runtime registers fonts', read('public/js/engine/sandboxRuntime.js').includes("msg.type === 'fonts'"), true);

// preset context tells viz which families are actually renderable
check('context: studio families reach viz', read('public/js/app.js').includes('studioFonts: Array.isArray(window.STUDIO_FONTS?.families)'), true);
check('context: aiProvider forwards them', read('public/js/services/aiProvider.js').includes('projectContext?.studioFonts'), true);

if (failures > 0) {
  console.error(`\n${failures} font library check(s) failed`);
  process.exit(1);
}
console.log('\nall font library checks passed');
