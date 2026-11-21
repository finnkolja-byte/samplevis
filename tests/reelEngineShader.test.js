// the shader compiler is the one place a preset can be silently wrong: a version mismatch, a
// program left over from the previous preset, or a down-port that compiles into a different image.
// these cases pin the pairing and the webgl1 fallback without a real gpu.

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label.padEnd(56)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}

function makeGl({ webgl2 = true, missing = [] } = {}) {
  const calls = [];
  const programs = [];
  const deletedPrograms = new Set();
  const absent = new Set(missing);
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TEXTURE_2D: 8,
    TEXTURE_WRAP_S: 9,
    TEXTURE_WRAP_T: 10,
    TEXTURE_MIN_FILTER: 11,
    TEXTURE_MAG_FILTER: 12,
    CLAMP_TO_EDGE: 13,
    LINEAR: 14,
    LUMINANCE: 15,
    RGBA: 16,
    UNSIGNED_BYTE: 17,
    TEXTURE0: 18,
    NO_ERROR: 0,
    FRAMEBUFFER: 19,
    COLOR_ATTACHMENT0: 20,
    FRAMEBUFFER_COMPLETE: 21,
    RGBA16F: 22,
    HALF_FLOAT: 23,
    ONE: 24,
    TRIANGLES: 25,
    __calls: calls,
    __programs: programs,
    __deleted: deletedPrograms,
    createShader(type) { return { type, source: '', ok: true }; },
    shaderSource(shader, source) { shader.source = source; calls.push(['shaderSource', shader.type, source]); },
    compileShader() { },
    getShaderParameter(shader) { return shader.ok; },
    getShaderInfoLog() { return 'mock compile log'; },
    createProgram() { const p = { id: programs.length, ok: true }; programs.push(p); calls.push(['createProgram', p.id]); return p; },
    attachShader() { },
    bindAttribLocation(program, loc, name) { calls.push(['bindAttribLocation', program.id, loc, name]); },
    linkProgram(program) { calls.push(['linkProgram', program.id]); },
    getProgramParameter(program) { return program.ok; },
    getProgramInfoLog() { return 'mock link log'; },
    deleteShader() { },
    deleteProgram(program) { deletedPrograms.add(program.id); calls.push(['deleteProgram', program.id]); },
    useProgram(program) { calls.push(['useProgram', program && program.id]); },
    getAttribLocation() { return 0; },
    getUniformLocation(program, name) { return absent.has(name) ? null : { program: program && program.id, name }; },
    uniform1f(loc, v) { if (loc && loc.name === 'u_flip_y') calls.push(['flip', v]); }, uniform2f() { }, uniform3f() { }, uniform1i() { },
    bindBuffer() { },
    bufferData() { },
    enableVertexAttribArray() { },
    vertexAttribPointer() { },
    createBuffer() { return {}; },
    deleteBuffer() { },
    deleteTexture() { },
    createTexture() { return {}; },
    bindTexture() { },
    texParameteri() { },
    texImage2D() { },
    texSubImage2D() { },
    activeTexture() { },
    viewport() { },
    drawArrays() { calls.push(['drawArrays']); },
    clearColor() { },
    clear() { },
    pixelStorei() { },
    enable() { }, disable() { }, blendFunc() { },
    createFramebuffer() { return { fbo: true }; },
    bindFramebuffer(target, fbo) { calls.push(['bindFramebuffer', fbo ? 'fbo' : 'canvas']); },
    framebufferTexture2D() { },
    checkFramebufferStatus() { return 21; },
    deleteFramebuffer() { },
    bindVertexArray() { },
    deleteVertexArray() { },
    getError() { return 0; },
    getExtension() { return {}; }
  };
  if (webgl2) gl.createVertexArray = () => ({});
  return gl;
}

function makeHost({ webgl2 = true, missing = [] } = {}) {
  const gl = makeGl({ webgl2, missing });
  const makeCanvas = () => {
    const canvas = { width: 1080, height: 1920 };
    canvas.getContext = (kind) => (kind === '2d' ? { canvas, clearRect() { }, drawImage() { } } : gl);
    return canvas;
  };
  global.window = {};
  global.document = { createElement: () => makeCanvas() };
  const ReelEngine = require('../public/js/engine/reelEngine.js');
  const engine = new ReelEngine(makeCanvas());
  return { ReelEngine, engine, gl };
}

const { ReelEngine } = makeHost();
const { detectGlslVersion, downportGlsl3To1 } = ReelEngine.GlslCompat;
const { resolveVideoUpload, VIDEO_HOLD_MS } = ReelEngine.VideoUpload;

// --- version detection ---

check('version: 300 es detected', detectGlslVersion('#version 300 es\nvoid main(){}'), 3);
check('version: leading whitespace tolerated', detectGlslVersion('\n\n  #version 300 es\nvoid main(){}'), 3);
check('version: es 1.00 default', detectGlslVersion('precision mediump float;\nvoid main(){}'), 1);
check('version: empty is 1.00', detectGlslVersion(''), 1);
check('version: 300 without es is not 3', detectGlslVersion('#version 300\nvoid main(){}'), 1);

// --- webgl1 down-port ---

const ES3 = '#version 300 es\nprecision highp float;\nout vec4 fragColor;\nuniform sampler2D u_scene_tex;\nin vec2 v_uv;\nvoid main() {\n  fragColor = texture(u_scene_tex, v_uv);\n}\n';
const ported = downportGlsl3To1(ES3);
check('downport: succeeds', ported.ok, true);
check('downport: version line removed', ported.source.includes('#version'), false);
check('downport: out declaration removed', /out\s+vec4/.test(ported.source), false);
check('downport: writes gl_FragColor', ported.source.includes('gl_FragColor = texture2D('), true);
check('downport: in becomes varying', ported.source.includes('varying vec2 v_uv;'), true);
check('downport: no texture() left', /\btexture\s*\(/.test(ported.source), false);

const es1 = 'precision mediump float;\nvoid main() { gl_FragColor = vec4(1.0); }';
const untouched = downportGlsl3To1(es1);
check('downport: es 1.00 passes through', untouched.changed, false);
check('downport: es 1.00 unchanged', untouched.source, es1);

const lod = downportGlsl3To1('#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){ fragColor = textureLod(u_scene_tex, v_uv, 2.0); }');
check('downport: textureLod refuses', lod.ok, false);
check('downport: refusal names the blocker', /textureLod/.test(lod.reason), true);

// --- webgl2 pairing ---

const w2 = makeHost({ webgl2: true });
check('webgl2: context detected', w2.engine.isWebGL2, true);
check('webgl2: compile succeeds', w2.engine.compileShaderBox(ES3, ES3), true);
check('webgl2: layer 1 program built', Boolean(w2.engine.glProgram), true);
check('webgl2: layer 3 program built', Boolean(w2.engine.postProgram), true);

const w2Sources = w2.gl.__calls.filter((c) => c[0] === 'shaderSource');
const w2Vert = w2Sources.find((c) => c[1] === w2.gl.VERTEX_SHADER);
const w2Frag = w2Sources.find((c) => c[1] === w2.gl.FRAGMENT_SHADER);
check('webgl2: es 3.00 vertex shader paired', w2Vert[2].startsWith('#version 300 es'), true);
check('webgl2: fragment compiled natively', w2Frag[2].startsWith('#version 300 es'), true);
check('webgl2: declared precision untouched', (w2Frag[2].match(/precision highp float;/g) || []).length, 1);

const noPrecision = makeHost({ webgl2: true });
noPrecision.engine.compileShaderBox('#version 300 es\nout vec4 fragColor;\nvoid main(){ fragColor = vec4(1.0); }', '');
const injected = noPrecision.gl.__calls.filter((c) => c[0] === 'shaderSource' && c[1] === noPrecision.gl.FRAGMENT_SHADER)[0][2];
check('webgl2: missing precision injected', injected.includes('#version 300 es\nprecision highp float;'), true);

const binds = w2.gl.__calls.filter((c) => c[0] === 'bindAttribLocation');
const links = w2.gl.__calls.filter((c) => c[0] === 'linkProgram');
check('webgl2: attribute bound before link', w2.gl.__calls.indexOf(binds[0]) < w2.gl.__calls.indexOf(links[0]), true);

// --- webgl1 fallback ---

const w1 = makeHost({ webgl2: false });
check('webgl1: context detected', w1.engine.isWebGL2, false);
check('webgl1: es 3.00 still compiles', w1.engine.compileShaderBox(ES3, ''), true);
const w1Sources = w1.gl.__calls.filter((c) => c[0] === 'shaderSource');
const w1Vert = w1Sources.find((c) => c[1] === w1.gl.VERTEX_SHADER);
const w1Frag = w1Sources.find((c) => c[1] === w1.gl.FRAGMENT_SHADER);
check('webgl1: es 1.00 vertex shader paired', w1Vert[2].includes('#version'), false);
check('webgl1: fragment down-ported', w1Frag[2].includes('texture2D('), true);

const w1Refuse = makeHost({ webgl2: false });
check('webgl1: unportable shader refused', w1Refuse.engine.compileShaderBox('#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){ fragColor = textureLod(u_scene_tex, v_uv, 1.0); }', ''), false);
check('webgl1: refusal reaches diagnostics', w1Refuse.engine.lastRuntimeErrors.some((e) => e.includes('needs WebGL2')), true);

// --- program lifecycle ---

const swap = makeHost({ webgl2: true });
swap.engine.compileShaderBox(ES3, ES3);
const firstPost = swap.engine.postProgram;
swap.engine.compileShaderBox(ES3, '');
check('lifecycle: post program cleared when absent', swap.engine.postProgram, null);
check('lifecycle: old post program deleted', swap.gl.__deleted.has(firstPost.id), true);

const emptyFrag = makeHost({ webgl2: true });
check('lifecycle: empty fragment falls back', emptyFrag.engine.compileShaderBox('', ''), true);
check('lifecycle: fallback program exists', Boolean(emptyFrag.engine.glProgram), true);

const cleanupHost = makeHost({ webgl2: true });
cleanupHost.engine.compileShaderBox(ES3, ES3);
const progBeforeCleanup = cleanupHost.engine.glProgram;
const postBeforeCleanup = cleanupHost.engine.postProgram;
cleanupHost.engine.cleanup();
check('cleanup: layer 1 program deleted', cleanupHost.gl.__deleted.has(progBeforeCleanup.id), true);
check('cleanup: layer 3 program deleted', cleanupHost.gl.__deleted.has(postBeforeCleanup.id), true);
check('cleanup: every program deleted', cleanupHost.gl.__programs.every((p) => cleanupHost.gl.__deleted.has(p.id)), true);
check('cleanup: handles nulled', [cleanupHost.engine.glProgram, cleanupHost.engine.postProgram], [null, null]);

// --- video hold across a cut or scrub ---
// a clip that is seeking has no frame to upload. dropping u_has_video there is the black flash
// that shows up on every cut, so the engine holds the last frame for a bounded window instead.

const ready = { ready: true, hasActiveVideo: true, textureValid: false, msSinceUpload: -1 };
check('video: ready frame uploads', resolveVideoUpload(ready), { upload: true, hasVideo: true });

const seeking = { ready: false, hasActiveVideo: true, textureValid: true, msSinceUpload: 120 };
check('video: seeking holds the last frame', resolveVideoUpload(seeking), { upload: false, hasVideo: true });

const cold = { ready: false, hasActiveVideo: true, textureValid: false, msSinceUpload: -1 };
check('video: first frame has nothing to hold', resolveVideoUpload(cold), { upload: false, hasVideo: false });

const preDrop = { ready: false, hasActiveVideo: false, textureValid: true, msSinceUpload: 50 };
check('video: no active clip does not leak the old frame', resolveVideoUpload(preDrop), { upload: false, hasVideo: false });

const expired = { ready: false, hasActiveVideo: true, textureValid: true, msSinceUpload: VIDEO_HOLD_MS };
check('video: hold expires at the window', resolveVideoUpload(expired), { upload: false, hasVideo: false });

const almost = { ready: false, hasActiveVideo: true, textureValid: true, msSinceUpload: VIDEO_HOLD_MS - 1 };
check('video: hold survives until the window', resolveVideoUpload(almost), { upload: false, hasVideo: true });

// the reported bug: a remote 1080p clip can seek for seconds. a seek is transient, so the frame
// must stay held for as long as it is actually in flight, not for a fixed window
const longSeek = { ready: false, hasActiveVideo: true, seeking: true, textureValid: true, msSinceUpload: 5000 };
check('video: a long seek still holds', resolveVideoUpload(longSeek), { upload: false, hasVideo: true });

const coldSeek = { ready: false, hasActiveVideo: true, seeking: true, textureValid: false, msSinceUpload: -1 };
check('video: seeking with no frame yet stays black', resolveVideoUpload(coldSeek), { upload: false, hasVideo: false });

check('video: hold window is bounded', VIDEO_HOLD_MS > 0 && VIDEO_HOLD_MS <= 3000, true);

// --- layer 3 pipeline ---
// the flip invariant is the one that silently ruins the composite: texture targets render flipped
// so every fbo holds top-down data, and only the canvas pass is unflipped.

function pipelineHost(opts = {}) {
  const host = makeHost({ webgl2: true, ...opts });
  host.engine.preset = {
    controlsBox: { fields: [], values: {} },
    modules: {},
    frontUiBox: { drawScript: 'ctx.fillRect(0, 0, 1, 1);' }
  };
  host.engine.project = { duration: 30 };
  host.engine.compileShaderBox(ES3, ES3);
  host.gl.__calls.length = 0;
  return host;
}

const fboHost = pipelineHost({ missing: ['u_bloom_tex'] });
fboHost.engine._renderShaderBox(0.5, { beatPulse: 0 }, 0, 0.5, null, { phase: 0 }, { index: 0, progress: 0, mix: 1 }, 'fbo');
const fboBind = fboHost.gl.__calls.findIndex((c) => c[0] === 'bindFramebuffer' && c[1] === 'fbo');
const firstDraw = fboHost.gl.__calls.findIndex((c) => c[0] === 'drawArrays');
check('layer1: renders into the scene fbo', fboBind >= 0 && fboBind < firstDraw, true);
check('layer1: flip is -1 for a texture target', fboHost.gl.__calls.some((c) => c[0] === 'flip' && c[1] === -1), true);

fboHost.gl.__calls.length = 0;
check('layer3: composite runs', fboHost.engine._renderPostComposite(), true);
check('layer3: one draw without bloom', fboHost.gl.__calls.filter((c) => c[0] === 'drawArrays').length, 1);
check('layer3: flip is +1 for the canvas', fboHost.gl.__calls.some((c) => c[0] === 'flip' && c[1] === 1), true);
check('layer3: composite targets the canvas', fboHost.gl.__calls.some((c) => c[0] === 'bindFramebuffer' && c[1] === 'canvas'), true);
check('layer3: scene format reported', ['rgba16f', 'rgba8'].includes(fboHost.engine.sceneFormat), true);

const canvasHost = pipelineHost({ missing: ['u_bloom_tex'] });
canvasHost.engine._renderShaderBox(0.5, { beatPulse: 0 }, 0, 0.5, null, { phase: 0 }, { index: 0, progress: 0, mix: 1 }, 'canvas');
check('fast path: flip is +1', canvasHost.gl.__calls.some((c) => c[0] === 'flip' && c[1] === 1), true);
check('fast path: no fbo bound', canvasHost.gl.__calls.some((c) => c[0] === 'bindFramebuffer' && c[1] === 'fbo'), false);

// bloom only runs when the post shader actually reads u_bloom_tex
const bloomHost = pipelineHost();
bloomHost.gl.__calls.length = 0;
bloomHost.engine._renderPostComposite();
check('bloom: full chain runs when declared', bloomHost.gl.__calls.filter((c) => c[0] === 'drawArrays').length, 8);

// a post shader that ignores the overlay must not delete the lyrics
const ignoreOverlay = pipelineHost({ missing: ['u_overlay_tex', 'u_bloom_tex'] });
ignoreOverlay.engine._renderPostComposite();
check('overlay: engine composites when shader ignores it', ignoreOverlay.engine._postSamplesOverlay, false);

const sampleOverlay = pipelineHost({ missing: ['u_bloom_tex'] });
sampleOverlay.engine._renderPostComposite();
check('overlay: shader owns the composite when it samples', sampleOverlay.engine._postSamplesOverlay, true);

// aspect changes must drop the targets so the next composite reallocates at the new size
const resizeHost = pipelineHost({ missing: ['u_bloom_tex'] });
resizeHost.engine._renderPostComposite();
const sizeBefore = resizeHost.engine._pipelineSize;
resizeHost.engine.setAspectRatio('16:9');
check('resize: targets disposed', resizeHost.engine._pipelineSize, '');
check('resize: new key differs', sizeBefore !== resizeHost.engine._pipelineSize, true);

process.exit(failures > 0 ? 1 : 0);
