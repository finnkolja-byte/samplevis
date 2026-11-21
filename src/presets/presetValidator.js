const crypto = require('crypto');

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MAX_PRESET_BYTES = 50 * 1024 * 1024;
const FONT_DATA_URL_RE = /^data:(?:font\/[a-z0-9.+-]+|application\/(?:font-[a-z0-9.+-]+|x-font-[a-z0-9.+-]+|vnd\.ms-fontobject|octet-stream));base64,/i;
const MAX_CUSTOM_FONTS = 12;
const MAX_CUSTOM_FONT_DATA_URL_CHARS = 8 * 1024 * 1024;

function generateAlphanumericId(length = 12) {
  let out = '';
  // rejection sampling threshold (248 = 62 * 4) prevents modulo bias
  while (out.length < length) {
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      if (bytes[i] < 248) {
        out += BASE62_ALPHABET[bytes[i] % 62];
      }
    }
  }
  return out;
}

function sanitizePresetId(rawId) {
  return String(rawId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/**
 * Normalizes and validates a 3-Box ReelPreset object before writing to disk.
 */
function normalizePresetForStorage(preset, { existsSync } = {}) {
  if (!preset || typeof preset !== 'object') {
    const err = new Error('Invalid preset payload');
    err.status = 400;
    throw err;
  }

  let id = preset.id ? sanitizePresetId(preset.id) : '';
  if (!id) {
    do {
      id = generateAlphanumericId(12);
    } while (typeof existsSync === 'function' && existsSync(id));
  }

  if (!id) {
    const err = new Error('Preset ID cannot be empty');
    err.status = 400;
    throw err;
  }

  const cleanCustomFonts = Array.isArray(preset.assets?.customFonts)
    ? preset.assets.customFonts
        .filter((f) => (
          f &&
          typeof f.family === 'string' &&
          f.family.trim() &&
          typeof f.dataUrl === 'string' &&
          f.dataUrl.length <= MAX_CUSTOM_FONT_DATA_URL_CHARS &&
          FONT_DATA_URL_RE.test(f.dataUrl)
        ))
        .slice(0, MAX_CUSTOM_FONTS)
        .map((f) => ({
          family: f.family.trim().slice(0, 120),
          ...(f.name ? { name: String(f.name).slice(0, 160) } : {}),
          ...(f.mimeType ? { mimeType: String(f.mimeType).slice(0, 80) } : {}),
          dataUrl: f.dataUrl
        }))
    : [];

  const cleanAssets = {
    ...(typeof preset.assets?.customImage === 'string' && preset.assets.customImage.startsWith('idb://')
      ? { customImage: preset.assets.customImage.slice(0, 240) }
      : {}),
    ...(cleanCustomFonts.length > 0 ? { customFonts: cleanCustomFonts } : {})
  };

  const cleanPreset = {
    version: preset.version || '1.0',
    id,
    meta: {
      name: preset.meta?.name || 'Untitled Preset',
      title: preset.meta?.title || preset.meta?.name || 'Untitled Preset',
      description: preset.meta?.description || 'custom visual preset',
      aspectRatio: preset.meta?.aspectRatio || '9:16',
      badge: 'Custom',
      ownerId: preset.meta?.ownerId || 'local',
      author: preset.meta?.author === 'official' ? 'local' : (preset.meta?.author || 'local'),
      forkedFrom: preset.meta?.forkedFrom && typeof preset.meta.forkedFrom === 'object'
        ? {
            id: String(preset.meta.forkedFrom.id || ''),
            name: String(preset.meta.forkedFrom.name || ''),
            author: String(preset.meta.forkedFrom.author || '')
          }
        : null,
      ...(preset.meta?.starterPresetId ? { starterPresetId: String(preset.meta.starterPresetId) } : {}),
      ...(typeof preset.meta?.notes === 'string' && preset.meta.notes.trim()
        ? { notes: preset.meta.notes }
        : {}),
      thumbnail: typeof preset.meta?.thumbnail === 'string' && preset.meta.thumbnail.startsWith('data:image/')
        ? preset.meta.thumbnail
        : null,
      createdAt: preset.meta?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    modules: preset.modules && typeof preset.modules === 'object' ? preset.modules : {},
    ...(preset.features ? { features: preset.features } : {
      features: {
        timeline: {
          markers: [{ id: 'drop', label: 'drop', color: '#83ca90' }]
        }
      }
    }),
    shaderBox: {
      fragmentShader: preset.shaderBox?.fragmentShader || '',
      // optional layer-3 composite; whitespace-only is treated as absent so the fast path stays clean
      ...(typeof preset.shaderBox?.postShader === 'string' && preset.shaderBox.postShader.trim()
        ? { postShader: preset.shaderBox.postShader }
        : {})
    },
    frontUiBox: {
      initScript: preset.frontUiBox?.initScript || '',
      drawScript: preset.frontUiBox?.drawScript || ''
    },
    controlsBox: {
      fields: Array.isArray(preset.controlsBox?.fields) ? preset.controlsBox.fields : [],
      values: preset.controlsBox?.values && typeof preset.controlsBox.values === 'object' ? { ...preset.controlsBox.values } : {}
    },
    ...(preset.projectState && typeof preset.projectState === 'object' && !Array.isArray(preset.projectState)
      ? { projectState: preset.projectState }
      : {}),
    ...(Object.keys(cleanAssets).length > 0 ? { assets: cleanAssets } : {})
  };

  // strip oversized inline media data urls so heavy binary blobs live in indexeddb / .samplevis.zip
  if (cleanPreset.controlsBox.values) {
    for (const [k, v] of Object.entries(cleanPreset.controlsBox.values)) {
      if (typeof v === 'string' && /^data:(image|video|audio)\//i.test(v) && v.length > 512) {
        cleanPreset.controlsBox.values[k] = null;
      }
    }
  }

  const serialized = JSON.stringify(cleanPreset, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PRESET_BYTES) {
    const err = new Error('preset exceeds the 50 mb save limit. compress or remove embedded media before saving.');
    err.status = 413;
    throw err;
  }

  return { id, cleanPreset, serialized };
}

module.exports = {
  MAX_PRESET_BYTES,
  generateAlphanumericId,
  sanitizePresetId,
  normalizePresetForStorage
};
