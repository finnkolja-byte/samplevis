const ReelEngine = require('../public/js/engine/reelEngine.js');

// the motion probe is the only instrument that answers "did it move", so these cases pin the
// readings that separate a timid pass from a pop from a reversed phase.

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label.padEnd(52)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}

function probeHost(width = 1080) {
  const host = Object.create(ReelEngine.prototype);
  host._probeTraces = new Map();
  host._suppressProbe = false;
  host._lastFrameDiag = { width };
  return host;
}

function feed(host, label, values, opts = {}, t0 = 0) {
  values.forEach((v, i) => host._recordProbeTrace(label, v, t0 + i / 60, opts));
}

const linear = probeHost();
feed(linear, 'camX', Array.from({ length: 61 }, (_, i) => i * 2), { spatial: true });
const lin = linear._getProbeTraces().camX;
check('linear: travel is the full distance', lin.travel, 120);
check('linear: path equals travel', lin.path, 120);
check('linear: no reversals', lin.reversals, 0);
check('linear: one frame step', lin.maxDelta, 2);
check('linear: travel as percent of width', lin.travelPct, 11.11);
check('linear: window in seconds', lin.seconds, 1);
check('linear: frame count', lin.frames, 61);

// a 0-to-1-to-0 envelope added into a travel coordinate shows up as reversals with almost no net
// travel — the ocean-speeds-up-then-stutters signature
const envelope = probeHost();
feed(envelope, 'waterPhase', Array.from({ length: 121 }, (_, i) => 1 - Math.abs(i / 60 - 1)));
const env = envelope._getProbeTraces().waterPhase;
check('envelope: net travel is zero', env.travel, 0);
check('envelope: reversals detected', env.reversals > 0, true);
check('envelope: path is the walked distance', env.path, 2);

// a seek must not be mistaken for motion: the window restarts at the new position
const seek = probeHost();
feed(seek, 'camZoom', [1, 1.02, 1.04]);
seek._recordProbeTrace('camZoom', 1.9, 12.0);
feed(seek, 'camZoom', [1.92, 1.94], {}, 12.0 + 1 / 60);
const jumped = seek._getProbeTraces().camZoom;
check('seek: jump is not a max delta', jumped.maxDelta, 0.02);
check('seek: travel restarts after the seek', jumped.travel, 0.04);
check('seek: frames still counted', jumped.frames, 6);

const nonSpatial = probeHost();
feed(nonSpatial, 'waterPhase', [0.1, 0.2, 0.3]);
check('non-spatial: no percent fields', nonSpatial._getProbeTraces().waterPhase.travelPct, undefined);

// one frame, two camera calls (shader pass + parallax overlay) must not read as motion
const twice = probeHost();
twice._recordProbeTrace('camX', 0, 0.5);
twice._recordProbeTrace('camX', 12, 0.5);
check('same frame: second call ignored', twice._getProbeTraces().camX.frames, 1);
check('same frame: no fake delta', twice._getProbeTraces().camX.maxDelta, 0);

const capped = probeHost();
for (let i = 0; i < 30; i += 1) capped._recordProbeTrace(`label${i}`, i, i / 60);
check('cap: at most 24 labels', capped._getProbeTraces()['label23'] !== undefined, true);
check('cap: later labels dropped', capped._getProbeTraces()['label24'], undefined);

const suppressed = probeHost();
suppressed._suppressProbe = true;
suppressed._recordProbeTrace('camX', 5, 0);
suppressed._suppressProbe = false;
check('suppressed: nothing recorded', Object.keys(suppressed._getProbeTraces()).length, 0);

const junk = probeHost();
junk._recordProbeTrace('', 1, 0);
junk._recordProbeTrace('camX', Number.NaN, 0);
check('junk: invalid samples ignored', Object.keys(junk._getProbeTraces()).length, 0);

// frame-health readback: the engine cannot be constructed headless, so the 2d context is stubbed and
// the thresholds that Viz is told to trust are pinned here
let frameData = new Uint8ClampedArray(16 * 16 * 4);
const pixelCtx = {
  clearRect() { },
  drawImage() { },
  getImageData() { return { data: frameData }; }
};
const engineCanvas = { width: 1080, height: 1920 };
const health = Object.create(ReelEngine.prototype);
Object.assign(health, {
  canvas: engineCanvas,
  ctx: { canvas: engineCanvas },
  _pixelCanvas: null,
  _pixelCtx: null,
  _pixelSample: null,
  _pixelLuma: null,
  _frameMs: 0,
  _frameMsMax: 0
});

const paint = (r, g, b) => {
  frameData = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < frameData.length; i += 4) {
    frameData[i] = r;
    frameData[i + 1] = g;
    frameData[i + 2] = b;
    frameData[i + 3] = 255;
  }
};

global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => pixelCtx }) };

paint(0, 0, 0);
const black = health._samplePixels(0);
check('pixels: black frame reads zero luma', black.meanLuma, 0);
check('pixels: black frame is flat', black.distinct, 1);
check('pixels: first sample has no change value', black.changed, null);

paint(255, 255, 255);
const white = health._samplePixels(0.5);
check('pixels: white frame reads full luma', white.meanLuma, 1);
check('pixels: black to white is a change', white.changed > 0.5, true);
check('pixels: static resets on new content', white.staticSec, 0);

paint(255, 255, 255);
check('pixels: identical frame is static', health._samplePixels(1.0).staticSec, 0.5);
check('pixels: static accumulates', health._samplePixels(1.5).staticSec, 1);

paint(128, 128, 128);
check('pixels: moving frame clears static', health._samplePixels(2.0).staticSec, 0);

check('perf: average is tracked', (() => {
  health._lastFrameDiag = {};
  health._sampleFrameHealth(3, Date.now());
  return typeof health._lastFrameDiag.perf.avgMs === 'number';
})(), true);

delete global.document;

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
