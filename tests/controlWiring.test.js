// "the slider does nothing" has a handful of causes and none of them throws: the uniform name does
// not match, the control never targets the shader, or the declared GLSL type cannot take the upload.
// this pins the static half of the audit that now marks the control row.
global.window = {};
const ControlsManager = require('../public/js/engine/controlsManager.js');

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label.padEnd(58)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}

const SHADER = `
precision highp float;
uniform vec2 u_resolution;
uniform float u_sunSize;
uniform vec3 u_sunColor;
uniform vec2 u_offset;
uniform float u_glow;
void main() { gl_FragColor = vec4(u_sunColor * u_sunSize, 1.0); }
`;

function preset(fields, shader = SHADER) {
  return {
    shaderBox: { fragmentShader: shader },
    controlsBox: { fields, values: {} }
  };
}

function overlayPreset(fields, drawScript, initScript = '') {
  return {
    shaderBox: { fragmentShader: SHADER },
    frontUiBox: { initScript, drawScript },
    controlsBox: { fields, values: {} }
  };
}

const overlayReasons = (fields, drawScript, initScript) =>
  ControlsManager.auditWiring(overlayPreset(fields, drawScript, initScript)).map((issue) => issue.reason);

const reasons = (fields, shader) => ControlsManager.auditWiring(preset(fields, shader)).map((issue) => issue.reason);

check('slider on a float uniform is wired', reasons([{ id: 'u_sunSize', type: 'slider', target: 'shader_uniform' }]), []);
check('color on a vec3 uniform is wired', reasons([{ id: 'u_sunColor', type: 'color', target: 'both' }]), []);
check('toggle on a float uniform is wired', reasons([{ id: 'u_glow', type: 'toggle', target: 'shader_uniform' }]), []);

check('missing u_ prefix is flagged', reasons([{ id: 'sunSize', type: 'slider', target: 'shader_uniform' }]), ['missing_uniform']);
check('overlay-only control on a declared uniform is flagged', reasons([{ id: 'u_resolution', type: 'slider', target: 'overlay_control' }]), ['not_targeted']);
check('overlay-only control without a uniform is fine', reasons([{ id: 'label', type: 'text', target: 'overlay_control' }]), []);
check('slider on a vec2 uniform is flagged', reasons([{ id: 'u_offset', type: 'slider', target: 'shader_uniform' }]), ['type_mismatch']);
check('color on a vec2 uniform is flagged', reasons([{ id: 'u_offset', type: 'color', target: 'shader_uniform' }]), ['type_mismatch']);
check('select cannot drive a uniform', reasons([{ id: 'u_glow', type: 'select', target: 'shader_uniform' }]), ['unsupported_type']);
check('text cannot drive a uniform', reasons([{ id: 'u_glow', type: 'text', target: 'both' }]), ['unsupported_type']);
check('engine-consumed bloom threshold is not flagged', reasons([{ id: 'u_bloom_threshold', type: 'slider', target: 'shader_uniform' }]), []);

// layer 3 is a separate program: a control declared only in postShader is wired, not dead
const POST_SHADER = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_scene_tex;
uniform float u_grain;
uniform vec3 u_tint;
void main() { gl_FragColor = vec4(u_tint * u_grain, 1.0); }
`;
const postReasons = (fields, postShader, shader = SHADER) => ControlsManager.auditWiring({
  shaderBox: { fragmentShader: shader, postShader },
  controlsBox: { fields, values: {} }
}).map((issue) => issue.reason);

check('post-only slider is wired', postReasons([{ id: 'u_grain', type: 'slider', target: 'shader_uniform' }], POST_SHADER), []);
check('post-only color is wired', postReasons([{ id: 'u_tint', type: 'color', target: 'both' }], POST_SHADER), []);
check('control in neither shader is flagged', postReasons([{ id: 'u_missing', type: 'slider', target: 'shader_uniform' }], POST_SHADER), ['missing_uniform']);
check('wrong type in postShader is flagged', postReasons([{ id: 'u_tint', type: 'slider', target: 'shader_uniform' }], POST_SHADER), ['type_mismatch']);
check('conflicting types across layers are flagged', postReasons(
  [{ id: 'u_grain', type: 'slider', target: 'shader_uniform' }],
  'precision highp float;\nvarying vec2 v_uv;\nuniform vec3 u_grain;\nvoid main() { gl_FragColor = vec4(u_grain, 1.0); }',
  'precision highp float;\nvarying vec2 v_uv;\nuniform float u_grain;\nvoid main() { gl_FragColor = vec4(u_grain); }'
), ['conflicting_types']);
check('declaring in both with the same type is wired', postReasons(
  [{ id: 'u_glow', type: 'slider', target: 'shader_uniform' }],
  'precision highp float;\nvarying vec2 v_uv;\nuniform float u_glow;\nvoid main() { gl_FragColor = vec4(u_glow); }'
), []);

// an overlay control is only alive if the script reads it — the same silent failure, one layer down
const DRAW_READS = 'const c = frame.controls; ctx.fillRect(0, 0, c.barWidth, 10);';
check('overlay control read by drawScript is wired',
  overlayReasons([{ id: 'barWidth', type: 'slider', target: 'canvas' }], DRAW_READS), []);
check('overlay control nothing reads is flagged',
  overlayReasons([{ id: 'lyricNudge', type: 'slider', target: 'canvas' }], DRAW_READS), ['unused']);
check('overlay control read only by initScript is wired',
  overlayReasons([{ id: 'seed', type: 'slider', target: 'canvas' }], DRAW_READS, 'state.seed = controls.seed;'), []);
check('media slots are not judged by the overlay text',
  overlayReasons([{ id: 'cover', type: 'image', target: 'canvas' }], DRAW_READS), []);
check('engine-owned toggles are not judged by the overlay text',
  overlayReasons([{ id: 'speedRamping', type: 'toggle', target: 'canvas' }], DRAW_READS), []);
check('a script that reads the whole bag is not judged',
  overlayReasons([{ id: 'lyricNudge', type: 'slider', target: 'canvas' }], 'const c = { ...frame.controls }; ctx.fillText(c.x, 0, 0);'), []);
check('a partial word is not a read',
  overlayReasons([{ id: 'pan', type: 'slider', target: 'canvas' }], 'const panel = 4; ctx.fillRect(panel, 0, 1, 1);'), ['unused']);

// a canvas-template preset has no shader to audit, so nothing is claimed either way
check('no shader means no false positives', reasons([{ id: 'armCount', type: 'slider', target: 'shader_uniform' }], ''), []);

// the message has to name the fix, not just the failure
const missing = ControlsManager.auditWiring(preset([{ id: 'sunSize', type: 'slider', target: 'shader_uniform' }]))[0];
check('missing uniform message mentions the id', missing.message.includes('u_ prefix'), true);
const typed = ControlsManager.auditWiring(preset([{ id: 'u_offset', type: 'slider', target: 'shader_uniform' }]))[0];
check('type mismatch names both types', typed.message.includes('vec2') && typed.message.includes('float'), true);

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
