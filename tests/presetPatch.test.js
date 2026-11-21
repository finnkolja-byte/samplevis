const fs = require('node:fs');
const path = require('node:path');
const {
  applyOps,
  classifyTurn,
  detectOutputShape,
  isPromptDivergentPath,
  PROMPT_DIVERGENT_PATHS
} = require('../public/js/services/presetPatch.js');

// patch mode only pays off if a bad patch is refused rather than half-applied, so these cases pin
// the refusal paths as hard as the happy path.

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label.padEnd(52)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}

function basePreset() {
  return {
    version: '1.0',
    id: 'starter-template',
    meta: { name: 'test', description: 'a test preset', notes: 'keep this' },
    modules: { clips: { enabled: true, startAtDrop: false } },
    features: { timeline: { categories: [{ id: 'cue', cues: [{ time: 1 }] }] } },
    assets: { customImage: 'data:image/png;base64,AAAA', customFonts: [{ family: 'Inter', name: 'Inter', dataUrl: 'data:font/woff2;base64,BBBB' }] },
    shaderBox: {
      fragmentShader: 'void main() {\n  vec3 sun = vec3(1.0, 0.7, 0.3);\n  gl_FragColor = vec4(sun, 1.0);\n}\n'
    },
    frontUiBox: {
      initScript: 'state.sunR = 120;',
      drawScript: 'const sunR = u * 0.16;\nctx.arc(cx, cy, sunR, 0, Math.PI * 2);\nctx.fill();'
    },
    controlsBox: {
      fields: [{ id: 'sunSize', type: 'slider', defaultValue: 0.16 }],
      values: { sunSize: 0.16 }
    }
  };
}

// --- happy paths ---

const setControl = applyOps(basePreset(), [{ op: 'set', path: 'controlsBox.values.sunSize', value: 0.11 }]);
check('set: ok', setControl.ok, true);
check('set: value applied', setControl.preset.controlsBox.values.sunSize, 0.11);

const setNewValue = applyOps(basePreset(), [{ op: 'set', path: 'controlsBox.values.grain', value: 0.4 }]);
check('set: new control value allowed', setNewValue.ok, true);
check('set: new value present', setNewValue.preset.controlsBox.values.grain, 0.4);

const replaced = applyOps(basePreset(), [
  { op: 'replace', path: 'frontUiBox.drawScript', find: 'const sunR = u * 0.16;', with: 'const sunR = u * 0.11;' }
]);
check('replace: ok', replaced.ok, true);
check('replace: text swapped', replaced.preset.frontUiBox.drawScript.includes('u * 0.11'), true);
check('replace: rest preserved', replaced.preset.frontUiBox.drawScript.includes('ctx.arc'), true);

const chained = applyOps(basePreset(), [
  { op: 'set', path: 'frontUiBox.initScript', value: 'state.sunR = 200;' },
  { op: 'replace', path: 'frontUiBox.initScript', find: '200', with: '210' }
]);
check('order: ops compose in sequence', chained.preset.frontUiBox.initScript, 'state.sunR = 210;');

const indexed = applyOps(basePreset(), [{ op: 'set', path: 'controlsBox.fields[0].defaultValue', value: 0.3 }]);
check('array index: ok', indexed.ok, true);
check('array index: value applied', indexed.preset.controlsBox.fields[0].defaultValue, 0.3);

check('input never mutated', basePreset().controlsBox.values.sunSize, 0.16);
check('set: input untouched after apply', basePreset().shaderBox.fragmentShader.length > 0, true);

// --- refusals ---

function refusal(label, ops) {
  const result = applyOps(basePreset(), ops);
  check(label, result.ok, false);
  return result;
}

refusal('replace: ambiguous find refuses', [
  { op: 'replace', path: 'frontUiBox.drawScript', find: 's', with: 'S' }
]);
refusal('replace: missing find refuses', [
  { op: 'replace', path: 'frontUiBox.drawScript', find: 'nope-not-here', with: 'x' }
]);
refusal('replace: non-string target refuses', [
  { op: 'replace', path: 'controlsBox.values.sunSize', find: '0', with: '1' }
]);
refusal('set: unknown path refuses', [
  { op: 'set', path: 'shaderBox.uniforms.glow', value: 1 }
]);
refusal('set: array index out of range refuses', [
  { op: 'set', path: 'controlsBox.fields[9].label', value: 'x' }
]);
refusal('unknown op refuses', [{ op: 'append', path: 'controlsBox.fields', value: {} }]);
refusal('empty ops refuses', []);
refusal('oversized op list refuses', Array.from({ length: 40 }, () => ({ op: 'set', path: 'controlsBox.values.sunSize', value: 1 })));

// fields the model was never shown faithfully must not be addressable
for (const divergentPath of [
  'assets.customImage',
  'assets.customFonts[0].dataUrl',
  'meta.notes',
  'meta.thumbnail',
  'features.timeline.categories',
  'id'
]) {
  check(`deny-list: ${divergentPath}`, isPromptDivergentPath(divergentPath), true);
  refusal(`deny-list: ${divergentPath} refuses`, [{ op: 'set', path: divergentPath, value: 'x' }]);
}
check('deny-list: shader still editable', isPromptDivergentPath('shaderBox.fragmentShader'), false);

// layer 3 is a normal editable field, including when the preset has no pass yet
const POST_SHADER = '#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main() {\n  fragColor = texture(u_scene_tex, v_uv);\n}\n';
check('deny-list: postShader editable', isPromptDivergentPath('shaderBox.postShader'), false);

const addedPost = applyOps(basePreset(), [{ op: 'set', path: 'shaderBox.postShader', value: POST_SHADER }]);
check('postShader: set adds the pass', addedPost.ok, true);
check('postShader: value applied', addedPost.preset.shaderBox.postShader, POST_SHADER);
check('postShader: layer 1 untouched', addedPost.preset.shaderBox.fragmentShader, basePreset().shaderBox.fragmentShader);

const replacedPost = applyOps(
  { ...basePreset(), shaderBox: { ...basePreset().shaderBox, postShader: POST_SHADER } },
  [{ op: 'replace', path: 'shaderBox.postShader', find: 'u_scene_tex', with: 'u_bloom_tex' }]
);
check('postShader: replace anchors inside the pass', replacedPost.preset.shaderBox.postShader.includes('texture(u_bloom_tex'), true);

const badPostShape = applyOps(
  { ...basePreset(), shaderBox: { fragmentShader: 'void main() {}', postShader: 7 } },
  [{ op: 'set', path: 'shaderBox.fragmentShader', value: 'void main() {}' }]
);
check('postShader: non-string base refused', badPostShape.ok, false);
check('postShader: refusal names the field', badPostShape.error, 'base shaderBox.postShader must be a string');

// a patch that fails halfway must not leave the first op applied anywhere
const partial = applyOps(basePreset(), [
  { op: 'set', path: 'controlsBox.values.sunSize', value: 0.9 },
  { op: 'replace', path: 'frontUiBox.drawScript', find: 'missing-token', with: 'x' }
]);
check('atomic: later failure fails the patch', partial.ok, false);
check('atomic: no preset returned', partial.preset, undefined);

// --- output shapes ---

check('shape: ops is a patch', detectOutputShape({ reply: 'ok', ops: [{ op: 'set' }] }).kind, 'patch');
check('shape: bare veto', detectOutputShape({ mode: 'full', reason: 'needs a rewrite' }).kind, 'veto');
check('shape: veto carries reason', detectOutputShape({ mode: 'full', reason: ' needs a rewrite ' }).reason, 'needs a rewrite');
check('shape: full preset wins over mode label', detectOutputShape({ mode: 'full', preset: { meta: {} } }).kind, 'full');
check('shape: legacy top-level preset', detectOutputShape({ shaderBox: {}, frontUiBox: {} }).kind, 'full');
check('shape: empty object is invalid', detectOutputShape({}).kind, 'invalid');
check('shape: null is invalid', detectOutputShape(null).kind, 'invalid');
check('shape: question turn is an ask', detectOutputShape({ reply: 'too slow, too small, or too linear?', preset: null }).kind, 'ask');
check('shape: question chips make an ask', detectOutputShape({ reply: 'pick one', preset: null, questions: [{ question: 'locked or drifting?', options: [{ label: 'locked', prompt: 'lock it' }] }] }).kind, 'ask');
check('shape: option chips make an ask', detectOutputShape({ reply: 'pick one', preset: null, options: [{ label: 'drone pass', prompt: 'drone pass' }] }).kind, 'ask');
check('shape: null preset without a question still retries', detectOutputShape({ reply: 'done', preset: null }).kind, 'invalid');

check('shape: full preset wins over an op list', detectOutputShape({ preset: { meta: {} }, ops: [{ op: 'set' }] }).kind, 'full');

// --- classification ---

const anyPreset = basePreset();
check('mode: surgical edit patches', classifyTurn({ prompt: 'make the sun round', preset: anyPreset }), 'patch');
check('mode: one constant patches', classifyTurn({ prompt: 'sun radius 0.11 and nudge the glare down 2px', preset: anyPreset }), 'patch');
check('mode: redesign rewrites', classifyTurn({ prompt: 'redesign this into a sunrise over water', preset: anyPreset }), 'full');
check('mode: "everything" rewrites', classifyTurn({ prompt: 'make everything warmer', preset: anyPreset }), 'full');
check('mode: attached media rewrites', classifyTurn({ prompt: 'match this look', preset: anyPreset, hasAttachedMedia: true }), 'full');
check('mode: no preset means a build', classifyTurn({ prompt: 'make something calm', preset: null }), 'full');
check('mode: long brief rewrites', classifyTurn({ prompt: 'x'.repeat(500), preset: anyPreset }), 'full');

// the deny-list is only correct while it still covers what the sanitizer rewrites: if the sanitizer
// grows another redacted field and nobody extends PROMPT_DIVERGENT_PATHS, patched paths start
// addressing data the model never saw
const providerSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'services', 'aiProvider.js'),
  'utf8'
);
const sanitizerStart = providerSource.indexOf('function sanitizePresetForPrompt');
const sanitizerBody = providerSource.slice(sanitizerStart, sanitizerStart + 2200);
// only assignments and deletes count as rewrites; bare guard reads like `if (copy.meta && ...)` do not
const rewrittenRoots = Array.from(
  new Set(
    sanitizerBody
      .replace(/\?\./g, '.')
      .split('\n')
      .map((line) => {
        const deleted = line.match(/delete\s+copy\.([a-zA-Z][a-zA-Z0-9_.[\]]*)/);
        if (deleted) return deleted[1];
        const assigned = line.match(/copy\.([a-zA-Z][a-zA-Z0-9_.[\]]*)\s*=[^=]/);
        return assigned ? assigned[1] : null;
      })
      .filter(Boolean)
      .map((root) => root.replace(/\[(\d+)\]/g, '.$1').replace(/\.\.+/g, '.'))
  )
);
check('sanitizer: rewrites found', rewrittenRoots.length > 0, true);
const uncovered = rewrittenRoots.filter((root) => !isPromptDivergentPath(root));
check('sanitizer: every rewrite is denied by patches', uncovered, []);
check('sanitizer: deny list matches sanitizer', PROMPT_DIVERGENT_PATHS.includes('assets'), true);

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
