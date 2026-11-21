const fs = require('fs');
const path = require('path');
const { sanitizePresetId, normalizePresetForStorage } = require('../src/presets/presetValidator');

/**
 * Manages plain JSON preset files in ~/Documents/SampleVis/Presets (with userData fallback).
 */
function createDiskPresetStore(app) {
  let resolvedDir = null;

  function getPresetsDir() {
    if (resolvedDir) return resolvedDir;
    const preferred = path.join(app.getPath('documents'), 'SampleVis', 'Presets');
    try {
      if (!fs.existsSync(preferred)) {
        fs.mkdirSync(preferred, { recursive: true });
      }
      fs.accessSync(preferred, fs.constants.W_OK);
      resolvedDir = preferred;
      return resolvedDir;
    } catch {
      const fallback = path.join(app.getPath('userData'), 'Presets');
      if (!fs.existsSync(fallback)) {
        fs.mkdirSync(fallback, { recursive: true });
      }
      resolvedDir = fallback;
      return resolvedDir;
    }
  }

  async function listPresets() {
    const dir = getPresetsDir();
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const presets = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const raw = await fs.promises.readFile(path.join(dir, entry.name), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.id) {
          presets.push(parsed);
        }
      } catch (err) {
        console.warn(`[ElectronPresetStore] Skipping invalid preset "${entry.name}":`, err.message);
      }
    }
    return presets;
  }

  async function getPreset(rawId) {
    const id = sanitizePresetId(rawId);
    if (!id) return null;
    const filePath = path.join(getPresetsDir(), `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function savePreset(preset) {
    const dir = getPresetsDir();
    const { id, cleanPreset, serialized } = normalizePresetForStorage(preset, {
      existsSync: (candidateId) => fs.existsSync(path.join(dir, `${candidateId}.json`))
    });

    const targetPath = path.join(dir, `${id}.json`);
    const tmpPath = `${targetPath}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmpPath, serialized, 'utf8');
    await fs.promises.rename(tmpPath, targetPath);

    return cleanPreset;
  }

  async function deletePreset(rawId) {
    const id = sanitizePresetId(rawId);
    if (!id) {
      throw new Error('Invalid preset ID');
    }
    const filePath = path.join(getPresetsDir(), `${id}.json`);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
    return { ok: true, id };
  }

  return {
    getPresetsDir,
    listPresets,
    getPreset,
    savePreset,
    deletePreset
  };
}

module.exports = { createDiskPresetStore };
