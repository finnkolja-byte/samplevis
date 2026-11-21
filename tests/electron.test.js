const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sanitizePresetId, normalizePresetForStorage } = require('../src/presets/presetValidator');
const { validateStreamUrl } = require('../src/media/clipProxy');
const { createStarterService } = require('../src/starter/starterService');
const { createDiskPresetStore } = require('../electron/presetStore');

async function run() {
  // 1. presetValidator & id sanitization
  assert.strictEqual(sanitizePresetId('../../etc/passwd'), 'etc-passwd');
  assert.strictEqual(sanitizePresetId('  my preset! '), 'my-preset');

  const { id, cleanPreset } = normalizePresetForStorage({
    meta: { name: 'Beta Glass', author: 'official' },
    controlsBox: {
      fields: [],
      values: { u_img: 'data:image/png;base64,' + 'A'.repeat(1024) }
    }
  });
  assert.strictEqual(id.length, 12);
  assert.strictEqual(cleanPreset.meta.author, 'local');
  assert.strictEqual(cleanPreset.controlsBox.values.u_img, null);

  // 2. clipProxy allowlist
  assert.ok(validateStreamUrl('https://www.sakugabooru.com/data/test.mp4'));
  assert.ok(validateStreamUrl('https://upload.wikimedia.org/test.webm'));
  assert.strictEqual(validateStreamUrl('http://www.sakugabooru.com/test.mp4'), null);
  assert.strictEqual(validateStreamUrl('https://127.0.0.1/secret'), null);

  // 3. starterService (meadows + demo + blank)
  const starter = createStarterService({
    presetsDir: path.join(__dirname, '..', 'data', 'presets', 'meadows'),
    demosDir: path.join(__dirname, '..', 'data', 'presets', 'demos')
  });
  const blankRes = starter.getStarterPayload('blank');
  assert.strictEqual(blankRes.status, 200);
  assert.strictEqual(blankRes.body.project, null);

  const constRes = starter.getStarterPayload('constellations');
  assert.strictEqual(constRes.status, 200);
  assert.strictEqual(constRes.body.project.id, 'starter_meadows');

  const demoRes = starter.getStarterPayload('cinematic-minimal');
  assert.strictEqual(demoRes.status, 200);
  assert.strictEqual(demoRes.body.project.id, 'starter_cinematic-minimal');

  // 4. electron disk presetStore roundtrip in isolated temp directory
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'samplevis-electron-test-'));
  try {
    const fakeApp = {
      getPath: (key) => (key === 'documents' ? tmpRoot : tmpRoot)
    };
    const store = createDiskPresetStore(fakeApp);
    const saved = await store.savePreset({
      meta: { name: 'Electron Disk Test' },
      shaderBox: { fragmentShader: 'void main() {}' },
      frontUiBox: { initScript: '', drawScript: '' },
      controlsBox: { fields: [], values: {} }
    });
    assert.ok(saved.id);
    const expectedFile = path.join(tmpRoot, 'SampleVis', 'Presets', `${saved.id}.json`);
    assert.ok(fs.existsSync(expectedFile), 'preset .json must exist on disk');

    const listed = await store.listPresets();
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].id, saved.id);

    const fetched = await store.getPreset(saved.id);
    assert.strictEqual(fetched.meta.name, 'Electron Disk Test');

    await store.deletePreset(saved.id);
    assert.ok(!fs.existsSync(expectedFile), 'preset .json must be deleted');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log('All Electron core & storage tests passed!');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
