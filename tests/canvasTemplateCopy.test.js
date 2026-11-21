// a canvas template (constellations, cinematic-minimal) and the 3-box twin of the same name in
// STARTER_PRESET_DEFINITIONS are different implementations. saving a copy used to reopen it through
// the twin, so the artwork changed the moment it hit "saved". a copy must keep its renderer.

global.window = {
  location: { search: '' },
  dispatchEvent() {},
  addEventListener() {},
  STARTER_PRESET_DEFINITIONS: {},
  STARTER_PRESETS: {}
};
global.location = global.window.location;
global.document = { documentElement: { dataset: {} } };
const storage = new Map();
global.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key)
};
global.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};

require('../public/js/templates/templateRegistry.js');
const registry = window.templateRegistry;

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label.padEnd(58)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}

// a stand-in for constellationsTemplate.js: a canvas renderer with its own field list and params
class FakeCanvasTemplate {
  constructor() {
    this.id = 'constellations';
    this.name = 'Constellations';
    this.title = 'Constellations';
    this.params = { starDensity: 0.35, palette: 'night' };
    this.initCalls = 0;
  }
  init() { this.initCalls += 1; }
  setAspectRatio() {}
  setProject() {}
  setActiveVideos() {}
  renderControls() {}
  cleanup() {}
  renderFrame() {}
}
registry.register(new FakeCanvasTemplate());

const savedCopy = {
  id: 'hCtWuxPxwgp4',
  meta: { name: 'Constellations (copy)', starterPresetId: 'constellations', aspectRatio: '9:16' },
  controlsBox: { fields: [], values: { starDensity: 0.92, palette: 'dusk' } },
  shaderBox: { fragmentShader: 'void main(){}' },
  frontUiBox: { initScript: '', drawScript: '' }
};

registry.registerPreset(savedCopy);
const loaded = registry.get('hCtWuxPxwgp4');
check('the copy keeps the canvas renderer', loaded instanceof FakeCanvasTemplate, true);
check('the copy is not the 3-box adapter', loaded instanceof window.ReelPresetTemplateAdapter, false);
check('the copy has its own id', loaded.id, 'hCtWuxPxwgp4');
check('the copy keeps the saved name', loaded.name, 'Constellations (copy)');
check('the copy keeps the saved document', loaded.preset === savedCopy, true);
check('the built-in is untouched', registry.get('constellations').name, 'Constellations');

// opening the copy seeds the canvas params from the saved knobs, once
const canvas = { width: 1080, height: 1920 };
registry.setTemplate('hCtWuxPxwgp4', canvas, { aspectRatio: '9:16' }, null);
check('saved knobs reach the live params', [loaded.params.starDensity, loaded.params.palette], [0.92, 'dusk']);
check('the seed is consumed once', loaded.savedParams, undefined);
check('the renderer is initialised', loaded.initCalls, 1);

// a saved copy of a 3-box starter still goes through the adapter
registry.registerPreset({
  id: 'saved-vhs',
  meta: { name: 'VHS (copy)', starterPresetId: 'vhs' },
  controlsBox: { fields: [], values: {} },
  shaderBox: { fragmentShader: '' },
  frontUiBox: { initScript: '', drawScript: '' }
});
check('a 3-box copy still uses the adapter', registry.get('saved-vhs') instanceof window.ReelPresetTemplateAdapter, true);

console.log(`\ncanvas template copies: ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
