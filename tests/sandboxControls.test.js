const fs = require('fs');
const path = require('path');
const vm = require('vm');

// the frame renders from its own structured clone of the preset, so an inspector move that is never
// pushed crosses no boundary at all. these cases pin both ends of that transport.

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label.padEnd(52)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}

function readSource(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

class FakeEngine {
  constructor() {
    this.preset = null;
    this.lastRuntimeErrors = [];
    this.renderLogs = [];
    this.state = {};
    this.loopCache = {
      invalidated: 0
    };
    this.loopCache.invalidate = () => { this.loopCache.invalidated += 1; };
  }
  loadPreset(preset) { this.preset = preset; }
  setProject() {}
  setAspectRatio() {}
  setActiveVideos() {}
  setLyricsData() {}
  _syncCustomFontsFromPreset(preset) {
    this.fonts = (this.fonts || []).concat(preset.assets.customFonts);
  }
  renderFrame() {}
}

function frameContext() {
  const handlers = {};
  const posted = [];
  const engines = [];
  const createdFonts = [];
  const addedFonts = [];
  class FakeFontFace {
    constructor(family, bytes, descriptors) {
      this.family = family;
      this.bytes = bytes;
      this.descriptors = descriptors || {};
      createdFonts.push(this);
    }
    load() { return Promise.resolve(this); }
  }
  const context = {
    console: { error() {}, warn() {}, log() {}, info() {} },
    Promise,
    Map,
    Blob,
    URL,
    FontFace: FakeFontFace,
    performance: { now: () => 0 },
    // the boot watchdog is the only timer that matters here and it would hold the process open
    setTimeout: () => 0,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    parent: { postMessage: (msg) => posted.push(msg) },
    document: {
      createElement: () => ({ width: 1, height: 1 }),
      body: { appendChild() {} },
      fonts: { ready: Promise.resolve(), add: (font) => addedFonts.push(font) }
    }
  };
  context.window = {
    ReelEngine: function ReelEngine() {
      const engine = new FakeEngine();
      engines.push(engine);
      return engine;
    },
    addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); }
  };
  vm.createContext(context);
  vm.runInContext(readSource('public/js/engine/sandboxRuntime.js'), context, { filename: 'sandboxRuntime.js' });
  return {
    engines,
    posted,
    createdFonts,
    addedFonts,
    send: (data) => (handlers.message || []).forEach((fn) => fn({ data }))
  };
}

const frame = frameContext();
const bootPreset = {
  id: 'ocean',
  controlsBox: { fields: [], values: { u_exposure: 1, lyricColor: '#a9d6ff' } }
};
frame.send({ type: 'boot', width: 1080, height: 1920, preset: bootPreset, project: { duration: 30 } });
// boot structured-clones in a real frame; mutating the host object must not be what the test reads
bootPreset.controlsBox.values.u_exposure = 999;

const engine = frame.engines[0];
check('boot: frame builds an engine', Boolean(engine), true);
check('boot: preset values arrive', engine.preset.controlsBox.values.u_exposure, 999);

frame.send({ type: 'controls', id: 'u_exposure', value: 0.35 });
check('controls: shader value updated in frame', engine.preset.controlsBox.values.u_exposure, 0.35);
check('controls: untouched values survive', engine.preset.controlsBox.values.lyricColor, '#a9d6ff');
check('controls: loop cache invalidated', engine.loopCache.invalidated, 1);

frame.send({ type: 'controls', id: 'lyricColor', value: '#ff0000' });
check('controls: colour value accepted', engine.preset.controlsBox.values.lyricColor, '#ff0000');

frame.send({ type: 'controls', id: 'cover', value: null });
check('controls: cleared slot stays null', engine.preset.controlsBox.values.cover, null);

const before = JSON.stringify(engine.preset.controlsBox.values);
frame.send({ type: 'controls', value: 'orphan' });
frame.send({ type: 'controls', id: '', value: 3 });
check('controls: missing id ignored', JSON.stringify(engine.preset.controlsBox.values), before);

frame.send({
  type: 'controls',
  id: 'lyricFont',
  value: 'Compagnon',
  font: { family: 'Compagnon', dataUrl: 'data:font/woff2;base64,AA' }
});
check('controls: uploaded font registered in frame', (engine.fonts || []).map((f) => f.family), ['Compagnon']);

// host side of the same contract
const hostContext = {
  console,
  URL,
  Blob,
  fetch: async () => { throw new Error('not fetched in this test'); },
  document: { currentScript: null }
};
hostContext.window = hostContext;
vm.createContext(hostContext);
vm.runInContext(readSource('public/js/engine/sandboxEngine.js'), hostContext, { filename: 'sandboxEngine.js' });

const SandboxEngine = hostContext.window.SandboxEngine;
const host = new SandboxEngine({});
const sent = [];
host.frame = { sendCommand: (type, payload) => sent.push({ type, payload }) };
host.setControls({ id: 'u_exposure', value: 0.4 });
host.setControls({
  id: 'lyricFont',
  value: 'Instrument Serif',
  font: { family: 'Instrument Serif', dataUrl: 'data:font/woff2;base64,AA' }
});
host.setControls({});
check('host: one controls command per move', sent.length, 2);
check('host: message type', sent[0].type, 'controls');
check('host: scalar value travels as-is', sent[0].payload.value, 0.4);
check('host: font bytes travel with the family', Boolean(sent[1].payload.font), true);

// the adapter must push overlay controls and leave media to its own transport
const adapterContext = {
  console,
  URLSearchParams,
  localStorage: { getItem: () => null, setItem: () => {} },
  document: { documentElement: { dataset: {} } },
  location: { search: '' },
  dispatchEvent: () => {},
  setTimeout: () => 0
};
adapterContext.window = adapterContext;
adapterContext.SandboxEngine = function SandboxEngine() {};
adapterContext.ControlsManager = {
  render(container, preset, onChange) { adapterContext.onChange = onChange; }
};
vm.createContext(adapterContext);
vm.runInContext(readSource('public/js/templates/templateRegistry.js'), adapterContext, { filename: 'templateRegistry.js' });

const adapter = new adapterContext.window.ReelPresetTemplateAdapter({ id: 'ocean', controlsBox: { fields: [], values: {} } });
const pushed = [];
adapter._sandbox = {
  setControls: (msg) => pushed.push(msg),
  setMediaSlot: async () => {},
  setMediaPool: async () => {}
};
adapter.renderControls({}, () => {});
adapterContext.onChange('u_exposure', 0.2);
adapterContext.onChange('lyricSize', 0.11);
adapterContext.onChange('cover', 'idb://preset/ocean/cover', { type: 'image' });
adapterContext.onChange('library', [{ id: 'a', src: 'blob:item' }], { type: 'media_pool' });
check('adapter: shader and overlay values pushed', pushed.map((m) => m.id), ['u_exposure', 'lyricSize']);
check('adapter: media never re-cloned into a control', pushed.length, 2);

// the inspector exists before the frame does: a move made during boot must be replayed, not dropped
const early = new adapterContext.window.ReelPresetTemplateAdapter({ id: 'ocean', controlsBox: { fields: [], values: {} } });
const order = [];
const replayed = [];
early._sandbox = null;
early._pushSandboxControl('sunSize', 0.9);
early._pushSandboxControl('sunSize', 1.2);
early._pushSandboxControl('lyricColor', '#ff0000');
check('early moves are held while the frame boots', replayed.length, 0);
early._sandbox = {
  boot: () => order.push('boot'),
  setControls: (msg) => { order.push('controls'); replayed.push(msg); },
  setMediaSlot: async () => {},
  setMediaPool: async () => {}
};
early._bootSandbox();
check('held moves replay after boot', order[0], 'boot');
check('one message per control, last value wins', replayed.map((m) => `${m.id}=${m.value}`), ['sunSize=1.2', 'lyricColor=#ff0000']);
early._pushSandboxControl('sunSize', 1.4);
check('later moves go straight through', replayed.map((m) => m.id), ['sunSize', 'lyricColor', 'sunSize']);

// stock families travel as bytes because the frame cannot fetch /fonts; a reboot reuses the
// registration, so the same faces must not be constructed twice
(async () => {
  const fontsFrame = frameContext();
  fontsFrame.send({
    type: 'boot',
    width: 1080,
    height: 1920,
    preset: { id: 'ocean', controlsBox: { fields: [], values: {} } },
    project: { duration: 30 }
  });
  const faces = [
    { family: 'Instrument Serif', weight: 400, style: 'normal', subset: 'latin', unicodeRange: 'U+0000-00FF', bytes: new ArrayBuffer(8) },
    { family: 'Instrument Serif', weight: 400, style: 'italic', subset: 'latin', unicodeRange: 'U+0000-00FF', bytes: new ArrayBuffer(8) }
  ];
  fontsFrame.send({ type: 'fonts', faces });
  check('fonts: faces constructed from bytes', fontsFrame.createdFonts.length, 2);
  check('fonts: weight descriptor forwarded', fontsFrame.createdFonts[0].descriptors.weight, '400');
  check('fonts: style descriptor forwarded', fontsFrame.createdFonts[1].descriptors.style, 'italic');
  check('fonts: unicode range forwarded', fontsFrame.createdFonts[0].descriptors.unicodeRange, 'U+0000-00FF');

  fontsFrame.send({ type: 'fonts', faces });
  check('fonts: duplicate faces skipped', fontsFrame.createdFonts.length, 2);

  await new Promise((resolve) => setImmediate(resolve));

  check('fonts: registered on the frame document', fontsFrame.addedFonts.length, 2);
  check('fonts: repaint requested after load', fontsFrame.posted.some((msg) => msg.type === 'assets-changed'), true);
  check('fonts: applied state reported after load', fontsFrame.posted.some((msg) => msg.type === 'fonts-state' && msg.applied === true), true);

  if (failures > 0) {
    console.error(`\n${failures} sandbox control check(s) failed`);
    process.exit(1);
  }
  console.log('\nall sandbox control checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
