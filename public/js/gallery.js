(async function () {
  'use strict';

  const grid = document.getElementById('galleryGrid');
  const tabs = document.querySelectorAll('.gallery-tab-btn');
  const importInput = document.getElementById('galleryImportInput');
  let currentFilter = 'templates';

  // cache generated data-url thumbnails per preset id so tab switches stay instant
  const generatedThumbCache = new Map();

  function switchToSavedTab() {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.filter === 'saved'));
    currentFilter = 'saved';
    renderGrid();
  }

  async function resolvePresetObject(tpl) {
    if (!tpl) return null;
    if (window.presetService) {
      const cached = window.presetService.inMemoryCache?.get?.(tpl.id);
      if (cached) return cached;
      if (typeof window.presetService.getPresetById === 'function') {
        const fetched = await window.presetService.getPresetById(tpl.id).catch(() => null);
        if (fetched) return fetched;
      }
    }
    return (
      tpl.preset ||
      window.STARTER_PRESET_DEFINITIONS?.[tpl.id] ||
      window.STARTER_PRESETS?.[tpl.id] ||
      null
    );
  }

  async function exportGalleryPreset(tpl) {
    const presetObj = await resolvePresetObject(tpl);
    if (window.projectBundleService && presetObj) {
      try {
        const hasMedia = await window.projectBundleService.hasCustomMedia(tpl.id, presetObj, null);
        const savedState = await window.projectBundleService.loadProjectState(tpl.id);
        if (hasMedia || savedState) {
          await window.projectBundleService.exportProjectZip({
            preset: presetObj,
            project: savedState?.projectMeta || null,
            lyricsData: savedState?.lyricsData || null,
            selectedClipIds: savedState?.selectedClipIds || [],
            selectedClipStartTimes: savedState?.selectedClipStartTimes || [],
            selectedClipEndTimes: savedState?.selectedClipEndTimes || [],
            selectedClipSpeeds: savedState?.selectedClipSpeeds || [],
            clips: savedState?.customClips || [],
            favoriteClips: savedState?.favoriteClips || [],
            clipSource: savedState?.clipSource || null,
            clipQuery: savedState?.clipQuery || null,
            audioBlob: savedState?.audioAsset?.blob || null,
            audioName: savedState?.audioAsset?.name || savedState?.audioFileName || null,
            midiBlob: savedState?.midiAsset?.blob || null,
            midiName: savedState?.midiAsset?.name || savedState?.midiFileName || null
          });
          return;
        }
      } catch (err) {
        console.warn('[Gallery] ZIP export fallback:', err.message);
      }
    }
    if (window.presetService) {
      await window.presetService.exportPreset(tpl.id);
    }
  }

  async function duplicateGalleryPreset(tpl, isSaved) {
    if (!window.presetService?.duplicatePreset) return;
    const presetObj = await resolvePresetObject(tpl);
    await window.presetService.duplicatePreset(presetObj || tpl.id, {
      sourceId: tpl.id,
      includeProjectState: true
    });
    if (!isSaved) {
      switchToSavedTab();
    } else {
      renderGrid();
    }
  }

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

  const metaModal = document.getElementById('presetMetaModal');
  const metaNameInput = document.getElementById('presetMetaNameInput');
  const metaDescInput = document.getElementById('presetMetaDescInput');
  const saveMetaBtn = document.getElementById('savePresetMetaBtn');
  const cancelMetaBtn = document.getElementById('cancelPresetMetaBtn');
  const closeMetaBtn = document.getElementById('closePresetMetaModalBtn');
  let editingPresetId = null;

  function closeMetaModal() {
    editingPresetId = null;
    if (metaModal) metaModal.hidden = true;
  }

  function openMetaModal(tpl, focusTarget = 'name') {
    if (!metaModal) return;
    editingPresetId = tpl.id;
    if (metaNameInput) metaNameInput.value = tpl.name || tpl.preset?.meta?.name || tpl.id || '';
    if (metaDescInput) metaDescInput.value = tpl.preset?.meta?.description || tpl.tagline || '';
    metaModal.hidden = false;
    setTimeout(() => {
      const target = focusTarget === 'desc' ? metaDescInput : metaNameInput;
      target?.focus();
      target?.select?.();
    }, 20);
  }

  async function saveMetaModal() {
    if (!editingPresetId || !window.presetService) return;
    const nextName = metaNameInput?.value.trim();
    if (!nextName) {
      metaNameInput?.focus();
      return;
    }
    const nextDesc = metaDescInput?.value.trim() || 'custom visual preset';

    if (saveMetaBtn) saveMetaBtn.disabled = true;
    try {
      const existing = await window.presetService.getPresetById(editingPresetId)
        || window.templateRegistry?.get(editingPresetId)?.preset;
      if (!existing) {
        closeMetaModal();
        return;
      }
      const copy = JSON.parse(JSON.stringify(existing));
      copy.meta = {
        ...(copy.meta || {}),
        name: nextName,
        title: nextName,
        description: nextDesc
      };
      await window.presetService.savePreset(copy);
      closeMetaModal();
      renderGrid();
    } catch (err) {
      alert(`could not update preset: ${err.message}`);
    } finally {
      if (saveMetaBtn) saveMetaBtn.disabled = false;
    }
  }

  if (saveMetaBtn) saveMetaBtn.addEventListener('click', saveMetaModal);
  if (cancelMetaBtn) cancelMetaBtn.addEventListener('click', closeMetaModal);
  if (closeMetaBtn) closeMetaBtn.addEventListener('click', closeMetaModal);
  if (metaModal) {
    metaModal.addEventListener('click', (e) => {
      if (e.target === metaModal) closeMetaModal();
    });
  }
  if (metaNameInput) {
    metaNameInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        saveMetaModal();
      }
    });
  }
  if (metaDescInput) {
    metaDescInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        saveMetaModal();
      }
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && metaModal && !metaModal.hidden) {
      closeMetaModal();
    }
  });

  function renderGrid() {
    if (!grid) return;
    grid.innerHTML = '';


    if (currentFilter === 'saved') {
      const createCard = document.createElement('div');
      createCard.className = 'gallery-card new-preset-card';
      createCard.innerHTML = `
        <div class="new-preset-icon">+</div>
        <div class="new-preset-title">new blank preset</div>
      `;
      createCard.addEventListener('click', () => {
        const hasBlank = window.templateRegistry && window.templateRegistry.get('blank');
        window.location.href = `/?preset=${hasBlank ? 'blank' : 'new_blank'}`;
      });
      grid.appendChild(createCard);
    }

    const allTemplates = window.templateRegistry ? window.templateRegistry.getAll() : [];
    const filtered = allTemplates.filter((tpl) => {
      if (tpl.id === 'blank' || tpl.id === 'new_blank') return false;
      const isSaved = isUserSavedPreset(tpl);
      return currentFilter === 'saved' ? isSaved : !isSaved;
    });

    buildPreviewThumbnailMap(filtered);

    filtered.forEach((tpl) => {
      const isSaved = isUserSavedPreset(tpl);
      const thumbUrl = tpl.preset?.meta?.thumbnail || generatedThumbCache.get(tpl.id) || '';

      const wrap = document.createElement('div');
      wrap.className = 'gallery-card-wrap';

      const card = document.createElement('a');
      card.className = isSaved ? 'gallery-card is-user-preset' : 'gallery-card';
      card.href = `/?preset=${encodeURIComponent(tpl.id)}`;

      const preview = document.createElement('div');
      preview.className = 'gallery-card-preview';
      if (thumbUrl) {
        const img = document.createElement('img');
        img.className = 'gallery-card-thumb';
        img.src = thumbUrl;
        img.alt = `${tpl.name || tpl.id} preview`;
        img.loading = 'lazy';
        preview.appendChild(img);
      }

      const header = document.createElement('div');
      header.className = 'gallery-card-header';
      const titleEl = document.createElement('span');
      titleEl.className = 'gallery-card-title';
      titleEl.textContent = tpl.name || tpl.id;
      header.appendChild(titleEl);

      const descEl = document.createElement('div');
      descEl.className = 'gallery-card-desc';
      const fullDesc = tpl.tagline || tpl.preset?.meta?.description || 'custom audio & visual reel preset.';
      descEl.textContent = fullDesc;
      descEl.title = fullDesc;

      const footer = document.createElement('div');
      footer.className = 'gallery-card-footer';

      // what this project costs to store, and whether it still needs the machine it was built on -
      // the two facts that decide if opening it elsewhere works
      const mediaBadge = window.projectVault?.cardMediaBadge?.(tpl);
      if (mediaBadge) footer.appendChild(mediaBadge);

      const openLabel = document.createElement('span');
      openLabel.className = 'gallery-card-btn';
      openLabel.textContent = 'open in editor →';
      footer.appendChild(openLabel);

      card.append(preview, header, descEl, footer);
      wrap.appendChild(card);

      if (isSaved) {
        const hoverBar = document.createElement('div');
        hoverBar.className = 'gallery-hover-bar';

        const createHoverBtn = (cls, label, titleText, handler) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `hover-bar-btn ${cls}`;
          btn.textContent = label;
          if (titleText) btn.title = titleText;
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handler(btn);
          });
          return btn;
        };

        const duplicateBtn = createHoverBtn('duplicate', 'duplicate', 'create an editable copy of this preset', async () => {
          try {
            await duplicateGalleryPreset(tpl, isSaved);
          } catch (err) {
            alert(`duplicate failed: ${err.message}`);
          }
        });

        const exportBtn = createHoverBtn('export', 'export', 'export project bundle or preset json', async () => {
          await exportGalleryPreset(tpl);
        });

        const renameBtn = createHoverBtn('rename', 'rename', 'rename preset', () => openMetaModal(tpl, 'name'));
        const descBtn = createHoverBtn('edit-desc', 'edit desc', 'edit description', () => openMetaModal(tpl, 'desc'));

        // only offered when there is something stored: the project and the files on this device
        // survive, and the space goes back to the account. each action owns its own prompts and
        // errors, and asks for a grid refresh when it changed something
        const vaultActions = window.projectVault?.cardActions?.(tpl) || [];

        const deleteBtn = createHoverBtn('delete', 'delete', 'delete saved preset', async () => {
          if (!confirm(`Delete saved preset "${tpl.name || tpl.id}"?`)) return;
          if (window.presetService) {
            await window.presetService.deletePreset(tpl.id);
            generatedThumbCache.delete(tpl.id);
            renderGrid();
          }
        });
        hoverBar.append(renameBtn, descBtn, duplicateBtn, exportBtn);
        for (const action of vaultActions) {
          hoverBar.append(createHoverBtn(action.className, action.label, action.title, async () => {
            const outcome = await action.run();
            if (outcome?.refresh) {
              generatedThumbCache.delete(tpl.id);
              renderGrid();
              renderStorageMeter();
            }
          }));
        }
        hoverBar.append(deleteBtn);
        wrap.appendChild(hoverBar);
      }

      grid.appendChild(wrap);
    });
  }

  if (importInput) {
    importInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file || !window.presetService) return;
      try {
        await window.presetService.importPresetFile(file);
        switchToSavedTab();
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
      window.presetService.syncWithBackend().catch(() => { });
    });
  }

  async function importOpenedElectronFile(payload) {
    if (!payload || !payload.bytes || !window.presetService) return;
    const ext = String(payload.ext || '').toLowerCase();
    if (ext !== '.json' && ext !== '.zip') return;
    try {
      const file = new File([payload.bytes], payload.name || `import${ext}`, {
        type: payload.mimeType || 'application/octet-stream'
      });
      const imported = await window.presetService.importPresetFile(file);
      if (imported?.id) {
        window.location.href = `/?preset=${encodeURIComponent(imported.id)}`;
      }
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  }

  if (window.electronAPI?.isElectron) {
    window.electronAPI.consumePendingFiles(['.json', '.zip'])
      .then((files) => {
        if (Array.isArray(files) && files.length > 0) {
          return importOpenedElectronFile(files[0]);
        }
      })
      .catch(() => { });
    window.electronAPI.onOpenFile((payload) => {
      importOpenedElectronFile(payload);
    });
  }

  /**
   * The account storage meter is a vault surface: it needs an endpoint that knows what is stored
   * outside this machine. Without a vault there is nothing to meter.
   */
  function renderStorageMeter() {
    window.projectVault?.renderStorageMeter?.();
  }

  renderGrid();
  renderStorageMeter();
})();
