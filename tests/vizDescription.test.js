const fs = require('node:fs');
const path = require('node:path');
const { isBlankDescription, resolveDescription, DEFAULT_DESCRIPTION } = require('../public/js/services/presetDescription.js');
const VizSkill = require('../public/js/services/vizSkill.js');

// the description is the only preset field the user can also write by hand, so the rule is
// one-shot: viz fills an empty field and then never touches it again.

const ROOT = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const indexHtmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label.padEnd(56)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}

check('blank: missing value', isBlankDescription(undefined), true);
check('blank: empty string', isBlankDescription(''), true);
check('blank: whitespace', isBlankDescription('   \n '), true);
check('blank: placeholder', isBlankDescription(DEFAULT_DESCRIPTION), true);
check('blank: placeholder is case-insensitive', isBlankDescription('Custom Visual Preset'), true);
check('blank: real description', isBlankDescription('slow drifting stars'), false);

check('resolve: user text wins over viz', resolveDescription('my own line', 'viz line'), 'my own line');
check('resolve: placeholder counts as empty', resolveDescription(DEFAULT_DESCRIPTION, 'viz line'), 'viz line');
check('resolve: empty takes viz text', resolveDescription('', 'viz line'), 'viz line');
check('resolve: nothing on either side keeps placeholder', resolveDescription('', ''), DEFAULT_DESCRIPTION);
check('resolve: whitespace collapsed', resolveDescription('', '  two   sentences\n here '), 'two sentences here');
check('resolve: existing text is trimmed only', resolveDescription('  mine  ', ''), 'mine');

const prompt = VizSkill.getSystemPrompt();
check('prompt: description section present', prompt.includes('PROJECT DESCRIPTION (meta.description)'), true);
check('prompt: one or two sentences', /One or two sentences/.test(prompt), true);
check('prompt: bans technical vocabulary', /never mention shaders, GLSL, uniforms/.test(prompt), true);
check('prompt: fills only an empty description', /Write it ONLY while currentPreset\.meta\.description is empty/.test(prompt), true);
check('prompt: forbids rewrites', /copy it back unchanged, character for character/.test(prompt), true);
check('prompt: patch turns leave it alone', VizSkill.PATCH_MODE_CONTRACT.includes('meta.description is not a patch target'), true);

check('app: merge goes through the guard', appSrc.includes('window.PresetDescription.resolveDescription(previous.meta?.description'), true);
check('app: guard runs before the raw fallback', appSrc.indexOf('resolveDescription(previous.meta?.description') < appSrc.indexOf('rawAiPreset.meta?.description || previous.meta?.description'), true);
check('markup: helper loads before app.js', indexHtmlSrc.indexOf('presetDescription.js') > 0 && indexHtmlSrc.indexOf('presetDescription.js') < indexHtmlSrc.indexOf('/js/app.js'), true);

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
