/**
 * meta.description is the one line the gallery shows under a project's title, and the user can edit
 * it from the gallery and from save copy as. Viz is allowed to name a project while the field is
 * still empty and must never replace text that is already there, because that text may be the
 * creator's own words.
 *
 * Every default in the app writes the same placeholder into an unset description, so the
 * placeholder has to count as empty or a drafted preset could never be described.
 */
(function (global) {
  const DEFAULT_DESCRIPTION = 'custom visual preset';

  function normalizeDescription(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  }

  function isBlankDescription(value) {
    const text = normalizeDescription(value);
    return !text || text.toLowerCase() === DEFAULT_DESCRIPTION;
  }

  function resolveDescription(previous, incoming) {
    const prev = normalizeDescription(previous);
    if (!isBlankDescription(prev)) return prev;
    const next = normalizeDescription(incoming);
    return next || prev || DEFAULT_DESCRIPTION;
  }

  const api = {
    DEFAULT_DESCRIPTION,
    isBlankDescription,
    normalizeDescription,
    resolveDescription
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (global) {
    global.PresetDescription = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
