const fs = require('node:fs');
const path = require('node:path');
const VizSkill = require('../public/js/services/vizSkill.js');

const ROOT = path.resolve(__dirname, '..');
const reelEngineSrc = fs.readFileSync(path.join(ROOT, 'public/js/engine/reelEngine.js'), 'utf8');
const aiProviderSrc = fs.readFileSync(path.join(ROOT, 'public/js/services/aiProvider.js'), 'utf8');
const lyricsServiceSrc = fs.readFileSync(path.join(ROOT, 'public/js/services/lyricsService.js'), 'utf8');
const sandboxRuntimeSrc = fs.readFileSync(path.join(ROOT, 'public/js/engine/sandboxRuntime.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const indexHtmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label.padEnd(50)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}

const promptA = VizSkill.getSystemPrompt();
const promptB = VizSkill.getSystemPrompt();

check('prompt: non-empty string', typeof promptA === 'string' && promptA.length > 0, true);
check('prompt: deterministic for prefix caching', promptA === promptB, true);
check('prompt: within sweet-spot target bounds (20k..60k)', promptA.length >= 20000 && promptA.length <= 60000, true);
// the server does not reject an oversized prompt, it slices it (MAX_SYSTEM_PROMPT_CHARS in
// functions/api/ai/chat.js). the output contract sits at the very end of the skill, so crossing
// this line silently hands the model a prompt with no JSON schema. keep real margin under it.
check('prompt: well under server 65536 char limit', promptA.length < 65536, true);

// verify documented standard uniforms exist in reelEngine.js
const requiredUniforms = [
  'u_time', 'u_resolution', 'u_bass', 'u_mid', 'u_high', 'u_rms',
  'u_kick', 'u_snare', 'u_top', 'u_drums', 'u_stem_bass', 'u_stem_other',
  'u_beat_pulse', 'u_fft', 'u_waveform', 'u_has_midi', 'u_bpm',
  'u_note_hit', 'u_chord_hit', 'u_active_pitch', 'u_video_tex', 'u_has_video',
  'u_image_tex', 'u_has_image', 'u_image_size', 'u_loop_phase', 'u_loop_fade',
  'u_pre_drop', 'u_speed_ramp', 'u_section_index', 'u_section_progress',
  'u_section_mix', 'u_lyric_hit'
];
for (const u of requiredUniforms) {
  check(`uniform documented & bound: ${u}`, promptA.includes(u) && reelEngineSrc.includes(`'${u}'`), true);
}
check('uniform documented & bound: u_cue_0..3', promptA.includes('u_cue_0..u_cue_3') && reelEngineSrc.includes('`u_cue_${ci}`'), true);
check('uniform documented & bound: u_cue_progress_0..3', promptA.includes('u_cue_progress_0..u_cue_progress_3') && reelEngineSrc.includes('`u_cue_progress_${ci}`'), true);
for (const u of ['u_scene_tex', 'u_overlay_tex', 'u_bloom_tex', 'u_has_overlay']) {
  check(`layer-3 uniform documented & bound: ${u}`, promptA.includes(u) && reelEngineSrc.includes(`'${u}'`), true);
}

// verify frame.fx hooks documented in prompt exist in reelEngine.js
const requiredFxHooks = [
  'ease', 'impulse', 'smooth', 'spring', 'gate', 'transition',
  'preDrop', 'camera', 'speedRamp', 'shutterBlur', 'streak',
  'whipLines', 'glitch', 'hash'
];
for (const fnName of requiredFxHooks) {
  const re = new RegExp(`\\b${fnName}\\s*:`);
  check(`frame.fx.${fnName} exists in reelEngine`, re.test(reelEngineSrc), true);
}

// verify frame.lyrics fields exist in lyricsService.js
for (const lyrProp of ['hasLyrics', 'lines', 'activeLineIndex', 'line', 'prevLine', 'nextLine', 'wordHit', 'wordProgress', 'words']) {
  check(`frame.lyrics.${lyrProp} exists in lyricsService`, lyricsServiceSrc.includes(`${lyrProp}`), true);
}

// verify core craft rules & anti-bias checks
check('craft: removes hardcoded dusk sunPos pattern', promptA.includes('vec2 sunPos ='), false);
check('craft: removes sunset horizonY=0.52 example', promptA.includes('float horizonY = 0.52;'), false);
check('craft: encodes neutral chameleon rule', /zero default aesthetic bias/i.test(promptA), true);
check('craft: supports hard-cut rap/cinema subtitles', /hard-cut/i.test(promptA) && /rap\/cinema subtitles/i.test(promptA), true);
check('craft: includes 9:16 social safe zone guidance', /9:16 social safe zone/i.test(promptA), true);
check('craft: includes photosensitive safety limit', /3 hz/i.test(promptA), true);
check('craft: includes 60-30-10 color balance', /60-30-10/i.test(promptA), true);
check('craft: teaches post-processing stack order', /post-processing/i.test(promptA) && /aces/i.test(promptA) && /halation/i.test(promptA), true);
check('craft: teaches unified 2D grain & offscreen bloom', /grainCanvas/i.test(promptA) && /1\/4-res/i.test(promptA), true);
check('craft: avoids non-existent motionKit expoIn ease', promptA.includes('expoIn'), false);
check('craft: teaches the three-layer pipeline', /three layers/i.test(promptA) && promptA.includes('postShader') && promptA.includes('u_scene_tex') && promptA.includes('u_overlay_tex') && promptA.includes('u_bloom_tex'), true);
check('craft: teaches premultiplied overlay compositing', promptA.includes('scene.rgb * (1.0 - ov.a) + ov.rgb'), true);
check('craft: teaches es 3.00 as the default dialect', promptA.includes('#version 300 es') && promptA.includes('out vec4 fragColor'), true);
check('craft: keeps legacy es 1.00 working', /Legacy ES 1\.00 presets still compile/.test(promptA), true);
check('craft: warns about gl_FragCoord in layer 1', /gl_FragCoord\.y origin is the top/.test(promptA), true);
check('craft: documents the optional postShader in the schema', promptA.includes('"postShader"?:string'), true);

// verify wiring in aiProvider.js and index.html
check('wiring: aiProvider uses VizSkill', aiProviderSrc.includes('VizSkill?.getSystemPrompt'), true);
check('wiring: aiProvider forwards projectContext.pools', aiProviderSrc.includes('projectContext?.pools'), true);
check('wiring: aiProvider forwards clipTransition', aiProviderSrc.includes('projectContext?.clips?.transition'), true);
check('wiring: index.html loads vizSkill before aiProvider', indexHtmlSrc.indexOf('vizSkill.js') > 0 && indexHtmlSrc.indexOf('vizSkill.js') < indexHtmlSrc.indexOf('aiProvider.js'), true);
check('wiring: index.html loads presetPatch before aiProvider', indexHtmlSrc.indexOf('presetPatch.js') > 0 && indexHtmlSrc.indexOf('presetPatch.js') < indexHtmlSrc.indexOf('aiProvider.js'), true);

// patch mode appends to the end of the static prompt so the cached prefix stays byte-identical
check('patch: default prompt is the bare skill', VizSkill.getSystemPrompt(), VizSkill.VIZ_SYSTEM_PROMPT);
check('patch: full prompt is the bare skill', VizSkill.getSystemPrompt('full'), VizSkill.VIZ_SYSTEM_PROMPT);
check('patch: prompt extends the cached prefix', VizSkill.getSystemPrompt('patch').startsWith(VizSkill.VIZ_SYSTEM_PROMPT), true);
check('patch: contract ships only in patch mode', VizSkill.getSystemPrompt('patch').includes('PATCH MODE:'), true);
check('patch: teaches the veto', VizSkill.PATCH_MODE_CONTRACT.includes('"mode":"full"'), true);
check('patch: names the unique-anchor rule', VizSkill.PATCH_MODE_CONTRACT.includes('exactly ONCE'), true);

// every lyric uniform the skill promises must actually be uploaded by the engine, or Viz writes
// shaders that read 0.0 forever and "camera locked to the lyrics" silently becomes a static shot
const documentedLyricUniforms = Array.from(new Set(VizSkill.VIZ_SYSTEM_PROMPT.match(/u_lyric_[a-z_]+/g) || []));
const requiredLyricUniforms = [
  'u_lyric_hit',
  'u_lyric_active',
  'u_lyric_line',
  'u_lyric_progress',
  'u_lyric_age',
  'u_lyric_next_in',
  'u_lyric_word_progress',
  'u_lyric_travel',
  'u_lyric_weight',
  'u_lyric_duration'
];
check('lyrics: full uniform set documented', requiredLyricUniforms.every((n) => documentedLyricUniforms.includes(n)), true);
check('lyrics: every documented uniform is uploaded', documentedLyricUniforms.filter((n) => !reelEngineSrc.includes(n)), []);
check('lyrics: canvas frame exposes nextIn', VizSkill.VIZ_SYSTEM_PROMPT.includes('nextIn'), true);
check('lyrics: held lines documented', VizSkill.VIZ_SYSTEM_PROMPT.includes('heldFor = seconds since sung'), true);
check('lyrics: hold toggle wired', appSrc.includes('lyricsHoldLinesCheck'), true);
check('lyrics: hold toggle in markup', indexHtmlSrc.includes('id="lyricsHoldLinesCheck"'), true);
check('lyrics: motion is lyric-lockable', VizSkill.VIZ_SYSTEM_PROMPT.includes('LYRIC-LOCKED MOTION'), true);
check('lyrics: warns next_in is a sawtooth', VizSkill.VIZ_SYSTEM_PROMPT.includes('it is a sawtooth'), true);
check('lyrics: bans envelopes in travel', VizSkill.VIZ_SYSTEM_PROMPT.includes('never accumulated travel'), true);
check('lyrics: names monotonic travel', VizSkill.VIZ_SYSTEM_PROMPT.includes('u_lyric_travel'), true);
check('lyrics: names the continuous phase', VizSkill.VIZ_SYSTEM_PROMPT.includes('max(u_lyric_line, 0.0) + u_lyric_progress'), true);
check('lyrics: diagnostic channel documented', VizSkill.VIZ_SYSTEM_PROMPT.includes('lastFrame.lyricUniforms'), true);
check('lyrics: engine reports uploaded uniforms', reelEngineSrc.includes('lyricUniforms: this._lyricUniforms'), true);
check('motion: budget rule is frame-relative', VizSkill.VIZ_SYSTEM_PROMPT.includes('8-12% of frame width'), true);
check('motion: probe documented', VizSkill.VIZ_SYSTEM_PROMPT.includes('frame.probe(label, value)'), true);
check('motion: probe readout documented', VizSkill.VIZ_SYSTEM_PROMPT.includes('renderDiagnostics.traces'), true);
check('motion: engine auto-traces the camera', reelEngineSrc.includes("_recordProbeTrace('camX'"), true);
check('motion: diagnostics return traces', reelEngineSrc.includes('traces: this._getProbeTraces()'), true);
check('collab: ask policy present', VizSkill.VIZ_SYSTEM_PROMPT.includes('ASK MORE THAN YOU GUESS'), true);
check('collab: ask turn forbids claims', /ask turn with nothing to build carries "preset": null and claims nothing/i.test(VizSkill.VIZ_SYSTEM_PROMPT), true);
check('collab: patch mode can ask', VizSkill.PATCH_MODE_CONTRACT.includes('ASK MORE THAN YOU GUESS'), true);
check('collab: questions are a control, not prose', VizSkill.VIZ_SYSTEM_PROMPT.includes('QUESTIONS ARE A CONTROL, NOT PROSE'), true);
check('collab: question schema published', VizSkill.VIZ_SYSTEM_PROMPT.includes('"questions":Array<{"question":string'), true);
check('collab: patch turns may ask', VizSkill.PATCH_MODE_CONTRACT.includes('Patch turns can ask too'), true);
check('collab: provider normalizes questions', aiProviderSrc.includes('normalizedQuestions'), true);
check('collab: chat renders question chips', appSrc.includes('msg.questions'), true);
check('diagnostics: pixel readback documented', VizSkill.VIZ_SYSTEM_PROMPT.includes('lastFrame.pixels'), true);
check('diagnostics: frame cost documented', VizSkill.VIZ_SYSTEM_PROMPT.includes('lastFrame.perf'), true);
check('diagnostics: filmstrip documented', VizSkill.VIZ_SYSTEM_PROMPT.includes('labelled filmstrip'), true);
check('diagnostics: sweep documented', VizSkill.VIZ_SYSTEM_PROMPT.includes('8 evenly spaced times'), true);
check('diagnostics: engine attaches pixels', reelEngineSrc.includes('diag.pixels = { ...sample }'), true);
check('diagnostics: engine attaches perf', reelEngineSrc.includes('diag.perf = {'), true);
check('diagnostics: sandbox forwards traces', sandboxRuntimeSrc.includes('traces: (engine && typeof engine._getProbeTraces'), true);
check('diagnostics: aiProvider accepts sweep', aiProviderSrc.includes("logsAtRaw === 'sweep'"), true);
check('diagnostics: aiProvider parses frames', aiProviderSrc.includes('rawPeek.frames'), true);
check('diagnostics: app builds a filmstrip', appSrc.includes('async function captureFilmstrip'), true);
check('craft: diagnosis table present', VizSkill.VIZ_SYSTEM_PROMPT.includes('IF IT FEELS WRONG'), true);
check('craft: diagnoses all four failure modes', ['stiff / robotic', 'floaty / sluggish', 'cheap / janky', 'mechanical despite easing'].every((s) => VizSkill.VIZ_SYSTEM_PROMPT.includes(s)), true);
check('craft: shader continuity rule present', VizSkill.VIZ_SYSTEM_PROMPT.includes('CONTINUITY & BANDING') && VizSkill.VIZ_SYSTEM_PROMPT.includes('smin/smax'), true);
check('craft: preflight checklist present', VizSkill.VIZ_SYSTEM_PROMPT.includes('BEFORE RETURNING A FULL BUILD'), true);
check('craft: headline mask reveal taught', VizSkill.VIZ_SYSTEM_PROMPT.includes('mask reveal'), true);

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
