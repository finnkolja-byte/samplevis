/**
 * Patch-mode output for Viz: instead of re-emitting an entire ReelPreset, the model returns a short
 * list of ops against the preset it was shown. Applying them is deterministic and all-or-nothing,
 * so a patch either produces a complete preset or is refused and the turn falls back to a full
 * rewrite.
 *
 * Ops are deliberately trivial (set a field, swap a unique substring in one string field) rather
 * than JSON-Patch: every op has to be verifiable without executing preset code, because the same
 * operations later run behind the repair endpoint.
 */
(function (global) {
  const MAX_OPS = 32;
  const MAX_OP_TEXT = 120_000;
  const MAX_TOTAL_TEXT = 400_000;

  // Fields the prompt never sees verbatim. sanitizePresetForPrompt() strips or reshapes these
  // before the model is asked for edits, so a path into them either addresses the wrong index or
  // wipes data the model could not know about (custom cues, font binaries, the cover image).
  // Kept as prefixes of a normalized dot path; keep in sync with sanitizePresetForPrompt().
  const PROMPT_DIVERGENT_PATHS = [
    'id',
    'assets',
    'meta.notes',
    'meta.thumbnail',
    'features.timeline.categories'
  ];

  const REDESIGN_PATTERN = /\b(redesign|rebuild|rework|start over|from scratch|new concept|new direction|different vibe|completely different|replace everything|replace the whole|throw it out)\b/i;
  const SCOPE_PATTERN = /\b(everything|all of it|the whole thing|the entire)\b/i;

  function normalizePath(path) {
    return String(path || '')
      .replace(/\[(\d+)\]/g, '.$1')
      .replace(/^\./, '')
      .trim();
  }

  function splitPath(path) {
    const normalized = normalizePath(path);
    if (!normalized) return [];
    return normalized.split('.').filter(Boolean);
  }

  function isPromptDivergentPath(path) {
    const normalized = normalizePath(path);
    if (!normalized) return true;
    return PROMPT_DIVERGENT_PATHS.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}.`)
    );
  }

  function cloneJson(value) {
    return typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  /**
   * Classifies a turn from the prompt alone. This lives client-side because BYOK/desktop has no
   * server to ask, and it is only a default: the model can veto with { mode: 'full' } and a full
   * preset in a patch turn is accepted as a valid answer.
   */
  function classifyTurn({ prompt, preset, hasAttachedMedia = false } = {}) {
    const text = String(prompt || '');
    if (!preset || typeof preset !== 'object') return 'full';
    if (!preset.shaderBox?.fragmentShader && !preset.frontUiBox?.drawScript) return 'full';
    if (hasAttachedMedia) return 'full';
    if (REDESIGN_PATTERN.test(text)) return 'full';
    if (SCOPE_PATTERN.test(text)) return 'full';
    if (text.length > 420) return 'full';
    return 'patch';
  }

  /**
   * Reads which shape the model actually returned. A bare veto is the cheap escape hatch: the model
   * says it needs a rewrite in ~20 tokens instead of burning a full rewrite into a patch turn.
   */
  function detectOutputShape(parsed) {
    if (!parsed || typeof parsed !== 'object') return { kind: 'invalid' };
    // a complete preset always wins over a patch: if the model emitted both, the whole preset is
    // its real intent, and applying a partial op list instead would silently drop the rest
    if (parsed.preset || parsed.shaderBox || parsed.frontUiBox) {
      return { kind: 'full' };
    }
    if (Array.isArray(parsed.ops)) {
      return { kind: 'patch', ops: parsed.ops };
    }
    // a clarification turn is a finished turn, not a failed patch: re-asking in full mode would
    // spend an upstream call to receive the same question back
    const replyText = String(parsed.reply ?? parsed.message ?? '');
    const askOptions = Array.isArray(parsed.options) ? parsed.options : [];
    const askQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
    if (parsed.preset === null && (replyText.includes('?') || askOptions.length > 0 || askQuestions.length > 0)) {
      return { kind: 'ask' };
    }
    const bareVeto =
      String(parsed.mode || '').toLowerCase() === 'full' &&
      !parsed.preset &&
      !parsed.shaderBox &&
      !parsed.frontUiBox;
    if (bareVeto) {
      return { kind: 'veto', reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 160) : '' };
    }
    return { kind: 'invalid' };
  }

  function resolveParent(root, parts) {
    let cursor = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      if (cursor === null || typeof cursor !== 'object') return null;
      if (!Object.prototype.hasOwnProperty.call(cursor, key)) return null;
      cursor = cursor[key];
    }
    return cursor;
  }

  function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      count += 1;
      index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
  }

  function validatePresetShape(preset) {
    if (!preset || typeof preset !== 'object') return 'preset is not an object';
    if (!preset.meta || typeof preset.meta !== 'object') return 'preset.meta missing';
    if (!preset.shaderBox || typeof preset.shaderBox.fragmentShader !== 'string') return 'shaderBox.fragmentShader missing';
    if (preset.shaderBox.postShader !== undefined && typeof preset.shaderBox.postShader !== 'string') {
      return 'shaderBox.postShader must be a string';
    }
    if (!preset.frontUiBox || typeof preset.frontUiBox.drawScript !== 'string') return 'frontUiBox.drawScript missing';
    return null;
  }

  /**
   * Applies ops to a copy of `basePreset`. Returns { ok: false, error } without touching the input
   * when any op cannot be applied exactly, because a half-applied shader is worse than a refusal.
   */
  function applyOps(basePreset, ops) {
    const shapeError = validatePresetShape(basePreset);
    if (shapeError) return { ok: false, error: `base ${shapeError}` };
    if (!Array.isArray(ops) || ops.length === 0) return { ok: false, error: 'no ops' };
    if (ops.length > MAX_OPS) return { ok: false, error: `too many ops (${ops.length} > ${MAX_OPS})` };

    const next = cloneJson(basePreset);
    let totalText = 0;

    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i];
      if (!op || typeof op !== 'object') return { ok: false, error: `op ${i}: not an object` };
      const kind = String(op.op || '').toLowerCase();
      const parts = splitPath(op.path);
      if (parts.length === 0) return { ok: false, error: `op ${i}: missing path` };
      if (isPromptDivergentPath(op.path)) {
        return { ok: false, error: `op ${i}: ${op.path} is not editable through a patch` };
      }

      const parent = resolveParent(next, parts);
      const key = parts[parts.length - 1];
      if (!parent || typeof parent !== 'object') {
        return { ok: false, error: `op ${i}: path ${op.path} does not exist` };
      }
      if (Array.isArray(parent) && !/^\d+$/.test(key)) {
        return { ok: false, error: `op ${i}: ${op.path} indexes an array without a number` };
      }

      if (kind === 'set') {
        if (Array.isArray(parent) && Number(key) >= parent.length) {
          return { ok: false, error: `op ${i}: index out of range at ${op.path}` };
        }
        const valueSize = JSON.stringify(op.value ?? null).length;
        totalText += valueSize;
        if (totalText > MAX_TOTAL_TEXT) return { ok: false, error: 'patch text too large' };
        parent[key] = cloneJson(op.value ?? null);
        continue;
      }

      if (kind === 'replace') {
        const find = typeof op.find === 'string' ? op.find : '';
        const withText = typeof op.with === 'string' ? op.with : '';
        if (!find) return { ok: false, error: `op ${i}: replace needs find` };
        if (find.length > MAX_OP_TEXT || withText.length > MAX_OP_TEXT) {
          return { ok: false, error: `op ${i}: replace text too large` };
        }
        const current = parent[key];
        if (typeof current !== 'string') {
          return { ok: false, error: `op ${i}: ${op.path} is not a string` };
        }
        const hits = countOccurrences(current, find);
        if (hits !== 1) {
          return { ok: false, error: `op ${i}: find matches ${hits} times in ${op.path}` };
        }
        parent[key] = current.replace(find, withText);
        totalText += withText.length;
        continue;
      }

      return { ok: false, error: `op ${i}: unknown op "${op.op}"` };
    }

    const resultError = validatePresetShape(next);
    if (resultError) return { ok: false, error: `patched ${resultError}` };
    return { ok: true, preset: next };
  }

  const api = {
    MAX_OPS,
    PROMPT_DIVERGENT_PATHS,
    applyOps,
    classifyTurn,
    detectOutputShape,
    isPromptDivergentPath
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (global) {
    global.PresetPatch = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
