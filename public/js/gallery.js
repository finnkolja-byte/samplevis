(async function () {
  'use strict';

  const grid = document.getElementById('galleryGrid');
  const tabs = document.querySelectorAll('.gallery-tab-btn');
  const importInput = document.getElementById('galleryImportInput');
  let currentFilter = 'templates';

  // cache generated data-url thumbnails per preset id so tab switches stay instant
  const generatedThumbCache = new Map();

  // sync presets from disk/indexeddb
  if (window.presetService) {
    try {
      await window.presetService.syncWithBackend();
    } catch (err) {
      console.warn('[Gallery] Sync failed:', err);
    }
  }

  function buildPreviewThumbnailMap(templates) {
    if (!window.ReelEngine) return;

    const toRender = templates.filter((tpl) => {
      if (tpl.preset?.meta?.thumbnail) return false;
      if (generatedThumbCache.has(tpl.id)) return false;
      const def = tpl.preset || (window.STARTER_PRESET_DEFINITIONS && window.STARTER_PRESET_DEFINITIONS[tpl.id]);
      return Boolean(def);
    });

    if (toRender.length === 0) return;

    const offscreen = document.createElement('canvas');
    offscreen.width = 480;
    offscreen.height = 270;
    let engine = null;

    try {
      engine = new window.ReelEngine(offscreen);
      engine.setAspectRatio('16:9');

      // seed synthetic spectrum + midi notes so procedural thumbnails show stars, bars, and glow
      for (let i = 0; i < engine.fftArray.length; i++) {
        const wave = Math.sin(i * 0.14) * 0.5 + 0.5;
        engine.fftArray[i] = Math.round(90 + wave * 135);
      }
      for (let i = 0; i < engine.waveformArray.length; i++) {
        engine.waveformArray[i] = Math.round(128 + Math.sin(i * 0.22) * 72);
      }

      engine.setProject({
        duration: 24,
        bpm: 132,
        key: 'Bmaj',
        dropTime: 12,
        metadata: { brand: 'samplevis', number: '001', title: 'meadows', bpm: 132, key: 'Bmaj' },
        tracks: [
          {
            id: 'preview-melody',
            name: 'melody',
            notes: [
              { time: 3.4, duration: 0.8, midi: 71, velocity: 0.9 },
              { time: 3.9, duration: 0.7, midi: 75, velocity: 0.85 },
              { time: 4.1, duration: 1.0, midi: 78, velocity: 0.92 },
              { time: 4.3, duration: 0.6, midi: 83, velocity: 0.88 }
            ]
          }
        ],
        selectedTracks: new Set(['preview-melody']),
        chordCutTimes: [0, 4, 8, 12],
        impactTimes: [12]
      });

      toRender.forEach((tpl) => {
        const def = tpl.preset || (window.STARTER_PRESET_DEFINITIONS && window.STARTER_PRESET_DEFINITIONS[tpl.id]);
        if (!def) return;
        try {
          engine.loadPreset(def);
          engine.renderFrame(4.2, null);
          const url = window.presetService
            ? window.presetService.captureThumbnail(offscreen, 360)
            : offscreen.toDataURL('image/webp', 0.74);
          if (url) generatedThumbCache.set(tpl.id, url);
        } catch (err) {
          console.warn(`[Gallery] Preview render skipped for "${tpl.id}":`, err.message);
        }
      });
    } finally {
      if (engine && typeof engine.cleanup === 'function') {
        engine.cleanup();
      }
    }
  }

  function isUserSavedPreset(tpl) {
    return tpl.badge === 'Custom' || tpl.preset?.meta?.ownerId === 'local' || Boolean(tpl.isCustom);
  }

  function renderEmptyState(title, desc) {
    const empty = document.createElement('div');
    empty.className = 'gallery-empty-state';
    empty.innerHTML = `
      <div class="gallery-empty-title">${title}</div>
      <div class="gallery-empty-desc">${desc}</div>
    `;
    grid.appendChild(empty);
  }

  function renderGrid() {
    if (!grid) return;
    grid.innerHTML = '';

    if (currentFilter === 'community') {
      renderEmptyState(
        'community presets',
        'available in the web edition.'
      );
      return;
    }

    if (currentFilter === 'saved') {
      const createCard = document.createElement('div');
      createCard.className = 'gallery-card new-preset-card';
      createCard.innerHTML = `
        <div class="new-preset-icon">+</div>
        <div class="new-preset-title">new blank preset</div>
      `;
      createCard.addEventListener('click', () => {
        const hasBlank = window.templateRegistry && window.templateRegistry.get('blank');
        window.open(`/?preset=${hasBlank ? 'blank' : 'new_blank'}`, '_blank');
      });
      grid.appendChild(createCard);
    }

    const allTemplates = window.templateRegistry ? window.templateRegistry.getAll() : [];
    const filtered = allTemplates.filter((tpl) => {
      if (tpl.id === 'blank') return false;
      const isSaved = isUserSavedPreset(tpl);
      return currentFilter === 'saved' ? isSaved : !isSaved;
    });

    buildPreviewThumbnailMap(filtered);

    filtered.forEach((tpl) => {
      const isSaved = isUserSavedPreset(tpl);
      const thumbUrl = tpl.preset?.meta?.thumbnail || generatedThumbCache.get(tpl.id) || '';
      const forkedFrom = tpl.preset?.meta?.forkedFrom;
      const metaLabel = isSaved
        ? (forkedFrom ? `from ${forkedFrom.name}` : 'saved')
        : 'official';

      const card = document.createElement('a');
      card.className = 'gallery-card';
      card.href = `/?preset=${encodeURIComponent(tpl.id)}`;
      card.target = '_blank';
      card.innerHTML = `
        <div class="gallery-card-preview">
          ${thumbUrl ? `<img class="gallery-card-thumb" src="${thumbUrl}" alt="${tpl.name || tpl.id} preview" loading="lazy" />` : ''}
        </div>
        <div class="gallery-card-header">
          <span class="gallery-card-title">${tpl.name || tpl.id}</span>
          <span class="gallery-card-badge">${tpl.badge || (isSaved ? 'saved' : 'template')}</span>
        </div>
        <div class="gallery-card-desc">${tpl.tagline || tpl.preset?.meta?.description || 'custom audio & visual reel preset.'}</div>
        <div class="gallery-card-footer">
          <span class="card-meta-tag">${metaLabel}</span>
          <div class="gallery-card-actions">
            ${isSaved ? `
              <button type="button" class="card-action-btn" data-action="export">export</button>
              <button type="button" class="card-action-btn danger" data-action="delete">delete</button>
            ` : ''}
            <span class="gallery-card-btn">open in editor ↗</span>
          </div>
        </div>
      `;

      if (isSaved) {
        const exportBtn = card.querySelector('[data-action="export"]');
        const deleteBtn = card.querySelector('[data-action="delete"]');

        if (exportBtn) {
          exportBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (window.presetService) {
              window.presetService.exportPreset(tpl.id);
            }
          });
        }

        if (deleteBtn) {
          deleteBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!confirm(`Delete saved preset "${tpl.name || tpl.id}"?`)) return;
            if (window.presetService) {
              await window.presetService.deletePreset(tpl.id);
              generatedThumbCache.delete(tpl.id);
              renderGrid();
            }
          });
        }
      }

      grid.appendChild(card);
    });
  }

  if (importInput) {
    importInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file || !window.presetService) return;
      try {
        await window.presetService.importPresetFile(file);
        tabs.forEach((t) => t.classList.toggle('active', t.dataset.filter === 'saved'));
        currentFilter = 'saved';
        renderGrid();
      } catch (err) {
        alert(`Import failed: ${err.message}`);
      } finally {
        importInput.value = '';
      }
    });
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.filter;
      renderGrid();
    });
  });

  if (window.presetService) {
    window.presetService.onPresetsChange(() => renderGrid());
    window.addEventListener('focus', () => {
      window.presetService.syncWithBackend().catch(() => {});
    });
  }

  renderGrid();
})();
