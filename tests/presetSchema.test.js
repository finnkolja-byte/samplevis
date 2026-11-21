// shaderBox.postShader is the layer-3 composite. the desktop save path normalizes a preset through
// src/presets/presetValidator.js, and the studio's own save-copy step rebuilds shaderBox by hand; a
// normalizer that forgets the field strips the pass on save, and the picture keeps rendering without
// the grade. these cases pin the shared half (the server sanitizer has its own file).

const fs = require('node:fs');
const path = require('node:path');
const { normalizePresetForStorage } = require('../src/presets/presetValidator.js');

const ROOT = path.resolve(__dirname, '..');

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label.padEnd(58)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}

const POST = '#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main() {\n  fragColor = texture(u_scene_tex, v_uv);\n}\n';

function presetWith(postShader) {
  return {
    version: '1.0',
    id: 'postfx-fixture',
    meta: { name: 'fixture', aspectRatio: '9:16' },
    modules: {},
    shaderBox: {
      fragmentShader: 'void main() { gl_FragColor = vec4(0.1); }',
      ...(postShader === undefined ? {} : { postShader })
    },
    frontUiBox: { initScript: '', drawScript: '' },
    controlsBox: { fields: [], values: {} }
  };
}

// --- electron / local disk path ---

const local = normalizePresetForStorage(presetWith(POST)).cleanPreset;
check('local save: postShader preserved verbatim', local.shaderBox.postShader, POST);
check('local save: fragmentShader untouched', typeof local.shaderBox.fragmentShader, 'string');

const localBlank = normalizePresetForStorage(presetWith('   \n  ')).cleanPreset;
check('local save: whitespace-only postShader dropped', 'postShader' in localBlank.shaderBox, false);

const localAbsent = normalizePresetForStorage(presetWith(undefined)).cleanPreset;
check('local save: absent postShader stays absent', 'postShader' in localAbsent.shaderBox, false);

const localNumber = normalizePresetForStorage(presetWith(42)).cleanPreset;
check('local save: non-string postShader dropped', 'postShader' in localNumber.shaderBox, false);

// the studio's own normalize step has no Node entry point, so pin the branch in source: a fork or
// "save copy as" that rebuilds shaderBox must carry the pass across
const presetServiceSrc = fs.readFileSync(path.join(ROOT, 'public/js/services/presetService.js'), 'utf8');
check('studio save: normalize keeps postShader', /shaderBox:\s*\{[^}]*postShader/s.test(presetServiceSrc), true);
check('studio save: fragmentShader still normalized', /fragmentShader:\s*presetData\.shaderBox\?\.fragmentShader/.test(presetServiceSrc), true);

console.log(`\npreset schema (local): ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
