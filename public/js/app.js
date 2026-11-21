(function () {
  const previewCanvas = document.getElementById('previewCanvas');
  const waveformCanvas = document.getElementById('waveformCanvas');
  let visualizer = null;

  const audioEl = new Audio();
  audioEl.preload = 'auto';
  audioEl.loop = true;

  audioEl.addEventListener('ended', () => {
    if (state.isPlaying) {
      audioEl.currentTime = 0;
      audioEl.play().catch(() => { });
    }
  });

  // transport state is the single source of truth for whether a frame must be exact, and every
  // play/pause path goes through this element
  audioEl.addEventListener('play', () => visualizer?.setPlaying?.(true));
  audioEl.addEventListener('pause', () => visualizer?.setPlaying?.(false));

  const MAX_PLAYLIST_SLOTS = 300;
  const MAX_CLIP_PICKER_CLIPS = 120;
  const VIDEO_POOL_SIZE = 16;
  let _videoPoolUseSeq = 0;

  // fixed-size pool of video elements with lru swapping for up to 300 playlist slots
  const videoPool = Array.from({ length: VIDEO_POOL_SIZE }, () => {
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.crossOrigin = 'anonymous';
    v.preload = 'auto';
    v.addEventListener('loadedmetadata', () => {
      if (!state.isPlaying && v.dataset.startTime !== undefined && v.dataset.startTime !== '') {
        const s = normalizeClipStartTime(v.dataset.startTime, v.duration);
        if (Math.abs((v.currentTime || 0) - s) > 0.05) {
          try { v.currentTime = s; } catch { }
        }
      }
    });
    v.addEventListener('loadeddata', () => {
      state._forceVideoSync = true;
      state._needsRender = true;
    });
    v.addEventListener('seeked', () => {
      if (Number.isFinite(v._pendingSeekTime) && Math.abs((v.currentTime || 0) - v._pendingSeekTime) > 0.04) {
        const nextTarget = v._pendingSeekTime;
        v._pendingSeekTime = null;
        try { v.currentTime = nextTarget; } catch { }
        return;
      }
      v._pendingSeekTime = null;
      state._needsRender = true;
      visualizer?.invalidateLoopCache?.();
      visualizer?.loopCache?.invalidate?.();
      visualizer?.engine?.loopCache?.invalidate?.();
    });
    v.addEventListener('error', () => {
      const clipUrl = v.dataset.clipUrl;
      if (!clipUrl || (v._retryCount || 0) >= 2) return;
      v._retryCount = (v._retryCount || 0) + 1;
      const delayMs = 350 * v._retryCount;
      setTimeout(() => {
        if (v.dataset.clipUrl !== clipUrl) return;
        v.src = clipUrl;
        v.load();
      }, delayMs);
    });
    return v;
  });

  const state = {
    project: null,
    clips: [],
    _archivedSelectedClips: new Map(),
    favoriteClips: [],
    selectedClipIds: [],
    selectedClipStartTimes: [],
    selectedClipEndTimes: [],
    selectedClipSpeeds: [],
    playlistsByCutMode: {},
    _activeCutMode: null,
    _lastCutStartTime: null,
    _forceVideoSync: false,
    _needsRender: true,
    _lastRenderedTime: -1,
    _lastRenderedVid: null,
    _lastRenderedVidTime: -1,
    _playlistStripOpen: false,
    _playlistStripUserCollapsed: false,
    _activePlaylistSlot: -1,
    isPlaying: false,
    isRendering: false,
    currentTime: 0,
    lastRenderedBlob: null,
    lastRenderedFilename: 'samplevis_render.mp4',
    draggingMarkerId: null,
    draggingImpactIdx: -1,
    _impactDragMoved: false,
    _suppressNextWaveformClick: false,
    draggingCustomCue: null,
    _customCueDragMoved: false,
    visibleCueCategories: {},
    activeCueCategoryId: null,
    _activeCustomCueKey: '',
    draggingLyricWord: null,
    _lyricWordDragMoved: false,
    _suppressNextLyricsBarClick: false,
    selectedLyricLineIdx: -1,
    selectedLyricWordIdx: -1,
    showLyricsTimelineBar: true,
    _lyricsModuleEnabled: false,
    _activeImpactIdx: -1,
    timelineZoom: 1,
    _timelineManualScrollUntil: 0,
    aspectRatio: '9:16',
    seamlessLoop: true,
    seamlessLoopStyle: 'datamosh',
    clipTransition: 'glitch',
    clipTransitionDuration: 0.35,
    hasCustomAudio: false,
    hasCustomMidi: false,
    audioBlob: null,
    audioName: null,
    midiBlob: null,
    midiName: null,
    _decodedAudioBuffer: null,
    _decodedAudioUrl: null,
    _decodedSttWords: null,
    videoPool
  };

  const els = {
    aspectRatioToggleBtn: document.getElementById('aspectRatioToggleBtn'),
    aspectRatioTelemetry: document.getElementById('aspectRatioTelemetry'),
    canvasHousing: document.querySelector('.canvas-housing'),
    studioGrid: document.getElementById('studioGrid'),
    encoderBadge: document.getElementById('encoderBadge'),
    sampleDropzone: document.getElementById('sampleDropzone'),
    sampleFileInput: document.getElementById('sampleFileInput'),
    uploadStatusText: document.getElementById('uploadStatusText'),
    reloadStarterBtn: document.getElementById('reloadStarterBtn'),
    inputBrand: document.getElementById('inputBrand'),
    inputNumber: document.getElementById('inputNumber'),
    inputTitle: document.getElementById('inputTitle'),
    inputBpm: document.getElementById('inputBpm'),
    inputKey: document.getElementById('inputKey'),
    midiSourceBadge: document.getElementById('midiSourceBadge'),
    trackListContainer: document.getElementById('trackListContainer'),
    seamlessReelLoopCheckbox: document.getElementById('seamlessReelLoopCheckbox'),
    seamlessLoopStyleSelect: document.getElementById('seamlessLoopStyleSelect'),
    playPauseBtn: document.getElementById('playPauseBtn'),
    jumpDropBtn: document.getElementById('jumpDropBtn'),
    timeReadout: document.getElementById('timeReadout'),
    barReadout: document.getElementById('barReadout'),
    dropBadgeReadout: document.getElementById('dropBadgeReadout'),
    lyricsTimelineToggleBtn: document.getElementById('lyricsTimelineToggleBtn'),
    lyricsCutOverlapsBtn: document.getElementById('lyricsCutOverlapsBtn'),
    timelineZoomOutBtn: document.getElementById('timelineZoomOutBtn'),
    timelineZoomResetBtn: document.getElementById('timelineZoomResetBtn'),
    timelineZoomInBtn: document.getElementById('timelineZoomInBtn'),
    lyricsAddWordBtn: document.getElementById('lyricsAddWordBtn'),
    lyricsDelWordBtn: document.getElementById('lyricsDelWordBtn'),
    lyricsTimelineBar: document.getElementById('lyricsTimelineBar'),
    lyricsTimelineTrack: document.getElementById('lyricsTimelineTrack'),
    lyricsTimelinePlayhead: document.getElementById('lyricsTimelinePlayhead'),
    markerCategoriesToolbar: document.getElementById('markerCategoriesToolbar'),
    waveformContainer: document.getElementById('waveformContainer'),
    waveformScroller: document.getElementById('waveformScroller'),
    waveformTrack: document.getElementById('waveformTrack'),
    impactCutsLayer: document.getElementById('impactCutsLayer'),
    customCuesLayer: document.getElementById('customCuesLayer'),
    customCuesEditor: document.getElementById('customCuesEditor'),
    customCuesCatList: document.getElementById('customCuesCatList'),
    customCuesActionsToolbar: document.getElementById('customCuesActionsToolbar'),
    addCustomCueBtn: document.getElementById('addCustomCueBtn'),
    clearCustomCuesBtn: document.getElementById('clearCustomCuesBtn'),
    customCuesList: document.getElementById('customCuesList'),
    customCuesStatus: document.getElementById('customCuesStatus'),
    timelineMarkersLayer: document.getElementById('timelineMarkersLayer'),
    timelinePlayhead: document.getElementById('timelinePlayhead'),
    headerPreviewTag: document.getElementById('headerPreviewTag'),
    midiTracksSection: document.getElementById('midiTracksSection'),
    midiTracksTitle: document.getElementById('midiTracksTitle'),
    clipsSection: document.getElementById('clipsSection'),
    clipsSectionTitle: document.getElementById('clipsSectionTitle'),
    cutmodeHint: document.getElementById('cutmodeHint'),
    impactCutsEditor: document.getElementById('impactCutsEditor'),
    impactCutsCount: document.getElementById('impactCutsCount'),
    impactCutsToolbar: document.getElementById('impactCutsToolbar'),
    addImpactCutBtn: document.getElementById('addImpactCutBtn'),
    resetImpactCutsBtn: document.getElementById('resetImpactCutsBtn'),
    impactCutsList: document.getElementById('impactCutsList'),
    impactCutsStatus: document.getElementById('impactCutsStatus'),
    speedRampToggle: document.getElementById('speedRampToggle'),
    clipTransitionSelect: document.getElementById('clipTransitionSelect'),
    clipTransitionDurRow: document.getElementById('clipTransitionDurRow'),
    clipTransitionDurSlider: document.getElementById('clipTransitionDurSlider'),
    clipTransitionDurVal: document.getElementById('clipTransitionDurVal'),
    autoFrameToggle: document.getElementById('autoFrameToggle'),
    clipSearchForm: document.getElementById('clipSearchForm'),
    clipSourceSelect: document.getElementById('clipSourceSelect'),
    clipCustomQueryInput: document.getElementById('clipCustomQueryInput'),
    fetchBestClipsBtn: document.getElementById('fetchBestClipsBtn'),
    customClipInput: document.getElementById('customClipInput'),
    clipGridContainer: document.getElementById('clipGridContainer'),
    clipsCountLabel: document.getElementById('clipsCountLabel'),
    togglePlaylistStripBtn: document.getElementById('togglePlaylistStripBtn'),
    playlistCountBadge: document.getElementById('playlistCountBadge'),
    clipPlaylistStrip: document.getElementById('clipPlaylistStrip'),
    clipPlaylistLimitLabel: document.getElementById('clipPlaylistLimitLabel'),
    openPlaylistEditorBtn: document.getElementById('openPlaylistEditorBtn'),
    clearPlaylistBtn: document.getElementById('clearPlaylistBtn'),
    clipPlaylistTrack: document.getElementById('clipPlaylistTrack'),
    playlistEditorDialog: document.getElementById('playlistEditorDialog'),
    playlistEditorSlotMeta: document.getElementById('playlistEditorSlotMeta'),
    playlistEditorCloseXBtn: document.getElementById('playlistEditorCloseXBtn'),
    playlistEditorVideo: document.getElementById('playlistEditorVideo'),
    playlistEditorEmpty: document.getElementById('playlistEditorEmpty'),
    playlistEditorTimeline: document.getElementById('playlistEditorTimeline'),
    playlistEditorTrimRegion: document.getElementById('playlistEditorTrimRegion'),
    playlistEditorPlayhead: document.getElementById('playlistEditorPlayhead'),
    playlistEditorInHandle: document.getElementById('playlistEditorInHandle'),
    playlistEditorOutHandle: document.getElementById('playlistEditorOutHandle'),
    playlistEditorPlayBtn: document.getElementById('playlistEditorPlayBtn'),
    playlistEditorTimeReadout: document.getElementById('playlistEditorTimeReadout'),
    playlistEditorSetStartBtn: document.getElementById('playlistEditorSetStartBtn'),
    playlistEditorStartInput: document.getElementById('playlistEditorStartInput'),
    playlistEditorSetEndBtn: document.getElementById('playlistEditorSetEndBtn'),
    playlistEditorEndInput: document.getElementById('playlistEditorEndInput'),
    playlistEditorSpeedInput: document.getElementById('playlistEditorSpeedInput'),
    playlistEditorResetStartBtn: document.getElementById('playlistEditorResetStartBtn'),
    playlistEditorCountLabel: document.getElementById('playlistEditorCountLabel'),
    playlistEditorGrid: document.getElementById('playlistEditorGrid'),
    playlistEditorDoneBtn: document.getElementById('playlistEditorDoneBtn'),
    toggleFavoritesDrawerBtn: document.getElementById('toggleFavoritesDrawerBtn'),
    favoritesCountBadge: document.getElementById('favoritesCountBadge'),
    favoritesDrawer: document.getElementById('favoritesDrawer'),
    favoritesDrawerScrim: document.getElementById('favoritesDrawerScrim'),
    favoritesDrawerCount: document.getElementById('favoritesDrawerCount'),
    closeFavoritesDrawerBtn: document.getElementById('closeFavoritesDrawerBtn'),
    favoritesGridContainer: document.getElementById('favoritesGridContainer'),
    lyricsSection: document.getElementById('lyricsSection'),
    lyricsCountBadge: document.getElementById('lyricsCountBadge'),
    lyricsTabEditBtn: document.getElementById('lyricsTabEditBtn'),
    lyricsTabLinesBtn: document.getElementById('lyricsTabLinesBtn'),
    lyricsEditPane: document.getElementById('lyricsEditPane'),
    lyricsLinesPane: document.getElementById('lyricsLinesPane'),
    lyricsAddWordInput: document.getElementById('lyricsAddWordInput'),
    lyricsAddWordSubmitBtn: document.getElementById('lyricsAddWordSubmitBtn'),
    lyricsPasteInput: document.getElementById('lyricsPasteInput'),
    lyricsModelSelect: document.getElementById('lyricsModelSelect'),
    lyricsEngineHint: document.getElementById('lyricsEngineHint'),
    lyricsCancelBtn: document.getElementById('lyricsCancelBtn'),
    lyricsCloudKeyRow: document.getElementById('lyricsCloudKeyRow'),
    lyricsCloudApiKeyInput: document.getElementById('lyricsCloudApiKeyInput'),
    lyricsLangSelect: document.getElementById('lyricsLangSelect'),
    lyricsGranularitySelect: document.getElementById('lyricsGranularitySelect'),
    lyricsHoldLinesCheck: document.getElementById('lyricsHoldLinesCheck'),
    lyricsTranscribeBtn: document.getElementById('lyricsTranscribeBtn'),
    lyricsSyncPastedBtn: document.getElementById('lyricsSyncPastedBtn'),
    lyricsClearBtn: document.getElementById('lyricsClearBtn'),
    lyricsRegroupBtn: document.getElementById('lyricsRegroupBtn'),
    lyricsRegroupUndoBtn: document.getElementById('lyricsRegroupUndoBtn'),
    lyricsRegroupDialog: document.getElementById('lyricsRegroupDialog'),
    lyricsRegroupSummary: document.getElementById('lyricsRegroupSummary'),
    lyricsRegroupList: document.getElementById('lyricsRegroupList'),
    lyricsRegroupApplyBtn: document.getElementById('lyricsRegroupApplyBtn'),
    lyricsRegroupCancelBtn: document.getElementById('lyricsRegroupCancelBtn'),
    lyricsRegroupCloseXBtn: document.getElementById('lyricsRegroupCloseXBtn'),
    lyricsLinesList: document.getElementById('lyricsLinesList'),
    lyricsStatusText: document.getElementById('lyricsStatusText'),
    renderMp4Btn: document.getElementById('renderMp4Btn'),
    downloadLastRenderBtn: document.getElementById('downloadLastRenderBtn'),
    renderOverlay: document.getElementById('renderOverlay'),
    renderStatusTitle: document.getElementById('renderStatusTitle'),
    renderProgressBar: document.getElementById('renderProgressBar'),
    renderProgressMeta: document.getElementById('renderProgressMeta'),
    openAiSettingsBtn: document.getElementById('openAiSettingsBtn'),
    closeAiSettingsBtn: document.getElementById('closeAiSettingsBtn'),
    aiSettingsModal: document.getElementById('aiSettingsModal'),
    byokApiKeyInput: document.getElementById('byokApiKeyInput'),
    byokBaseUrlInput: document.getElementById('byokBaseUrlInput'),
    byokModelInput: document.getElementById('byokModelInput'),
    saveAiSettingsBtn: document.getElementById('saveAiSettingsBtn'),
    aiSettingsSaveStatus: document.getElementById('aiSettingsSaveStatus'),
    topPresetNameInput: document.getElementById('topPresetNameInput'),
    topSavePresetBtn: document.getElementById('topSavePresetBtn'),
    topProjectMenuBtn: document.getElementById('topProjectMenuBtn'),
    topProjectMenuPopover: document.getElementById('topProjectMenuPopover'),
    menuSaveCopyBtn: document.getElementById('menuSaveCopyBtn'),
    menuNewBlankProjectBtn: document.getElementById('menuNewBlankProjectBtn'),
    menuRevertSavedBtn: document.getElementById('menuRevertSavedBtn'),
    topExportZipBtn: document.getElementById('topExportZipBtn'),
    topImportBundleBtn: document.getElementById('topImportBundleBtn'),
    menuExportZipBtn: document.getElementById('menuExportZipBtn'),
    menuImportBundleBtn: document.getElementById('menuImportBundleBtn'),
    studioPaneTabs: document.getElementById('studioPaneTabs'),
    paneTabClipsBtn: document.getElementById('paneTabClipsBtn'),
    paneQuickPlayBtn: document.getElementById('paneQuickPlayBtn'),
    topImportBundleInput: document.getElementById('topImportBundleInput'),
    saveCopyAsDialog: document.getElementById('saveCopyAsDialog'),
    saveCopyCancelXBtn: document.getElementById('saveCopyCancelXBtn'),
    saveCopyAsForm: document.getElementById('saveCopyAsForm'),
    saveCopyNameInput: document.getElementById('saveCopyNameInput'),
    saveCopyDescInput: document.getElementById('saveCopyDescInput'),
    saveCopyIncludeStateCheck: document.getElementById('saveCopyIncludeStateCheck'),
    saveCopyErrorMsg: document.getElementById('saveCopyErrorMsg'),
    saveCopyConfirmBtn: document.getElementById('saveCopyConfirmBtn'),
    saveCopyCancelBtn: document.getElementById('saveCopyCancelBtn'),
    brandGalleryLink: document.getElementById('brandGalleryLink'),
    unsavedLeaveModal: document.getElementById('unsavedLeaveModal'),
    unsavedLeaveMessage: document.getElementById('unsavedLeaveMessage'),
    unsavedSaveBtn: document.getElementById('unsavedSaveBtn'),
    unsavedDiscardBtn: document.getElementById('unsavedDiscardBtn'),
    unsavedCancelBtn: document.getElementById('unsavedCancelBtn'),
    unsavedCancelXBtn: document.getElementById('unsavedCancelXBtn'),
    templateControlsContainer: document.getElementById('templateControlsContainer'),
    projectLoadingOverlay: document.getElementById('projectLoadingOverlay'),
    projectLoadingStatus: document.getElementById('projectLoadingStatus')
  };

  let projectLoadingHideTimer = null;

  function showProjectLoading(message) {
    if (!els.projectLoadingOverlay) return;
    if (projectLoadingHideTimer) {
      clearTimeout(projectLoadingHideTimer);
      projectLoadingHideTimer = null;
    }
    if (message && els.projectLoadingStatus) {
      els.projectLoadingStatus.textContent = message;
    }
    els.projectLoadingOverlay.classList.remove('is-leaving');
    els.projectLoadingOverlay.hidden = false;
  }

  function hideProjectLoading() {
    if (!els.projectLoadingOverlay || els.projectLoadingOverlay.hidden) return;
    if (projectLoadingHideTimer) {
      clearTimeout(projectLoadingHideTimer);
      projectLoadingHideTimer = null;
    }
    window.cloudLoadProgress?.reset?.();
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      els.projectLoadingOverlay.classList.remove('is-leaving');
      els.projectLoadingOverlay.hidden = true;
      return;
    }
    els.projectLoadingOverlay.classList.add('is-leaving');
    projectLoadingHideTimer = setTimeout(() => {
      projectLoadingHideTimer = null;
      if (els.projectLoadingOverlay) {
        els.projectLoadingOverlay.hidden = true;
        els.projectLoadingOverlay.classList.remove('is-leaving');
      }
    }, 220);
  }

  function yieldToPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  // the surface the cloud overlay renders into: it owns its own progress bar, but the overlay
  // element and the frame budget belong to the studio
  window.studioShell = { showLoading: showProjectLoading, hideLoading: hideProjectLoading, yieldToPaint };

  let hasUnsavedChanges = false;
  let pendingSaveAction = null;
  let pendingLeaveCallback = null;

  function updateSaveDirtyUi() {
    if (els.topSavePresetBtn) {
      els.topSavePresetBtn.classList.toggle('is-dirty', hasUnsavedChanges);
      if (els.topSavePresetBtn.textContent !== 'saved ✓') {
        els.topSavePresetBtn.textContent = hasUnsavedChanges ? 'save preset *' : 'save preset';
      }
    }
    const vizSaveBtn = document.getElementById('vizSavePresetBtn');
    if (vizSaveBtn) {
      vizSaveBtn.classList.toggle('is-dirty', hasUnsavedChanges);
      if (vizSaveBtn.textContent !== 'saved ✓') {
        vizSaveBtn.textContent = hasUnsavedChanges ? 'save*' : 'save';
      }
    }
  }

  function markProjectDirty() {
    if (!hasUnsavedChanges) {
      hasUnsavedChanges = true;
      updateSaveDirtyUi();
    }
  }

  function clearProjectDirty() {
    hasUnsavedChanges = false;
    updateSaveDirtyUi();
  }

  window.addEventListener('samplevis:preset-dirty', markProjectDirty);

  function closeUnsavedLeaveModal() {
    pendingLeaveCallback = null;
    if (els.unsavedLeaveModal) els.unsavedLeaveModal.hidden = true;
  }

  function openUnsavedLeaveModal({ saveLabel = 'save & close', onLeave }) {
    if (!els.unsavedLeaveModal) {
      onLeave();
      return;
    }
    pendingLeaveCallback = onLeave;
    const presetTitle = els.topPresetNameInput?.value.trim() || visualizer?.name || 'this project';
    if (els.unsavedLeaveMessage) {
      els.unsavedLeaveMessage.textContent = `you have unsaved changes in "${presetTitle}". save before leaving?`;
    }
    if (els.unsavedSaveBtn) {
      els.unsavedSaveBtn.disabled = false;
      els.unsavedSaveBtn.textContent = saveLabel;
    }
    els.unsavedLeaveModal.hidden = false;
  }

  function confirmLeaveAndRun(saveLabel, onLeave) {
    if (!hasUnsavedChanges) {
      onLeave();
      return;
    }
    openUnsavedLeaveModal({
      saveLabel,
      onLeave: () => {
        clearProjectDirty();
        onLeave();
      }
    });
  }

  const backToGalleryBtn = document.getElementById('backToGalleryBtn');
  [els.brandGalleryLink, backToGalleryBtn].forEach((linkEl) => {
    if (!linkEl) return;
    linkEl.addEventListener('click', (e) => {
      if (!hasUnsavedChanges) return;
      e.preventDefault();
      const targetHref = linkEl.getAttribute('href') || '/gallery.html';
      confirmLeaveAndRun('save & close', () => {
        window.location.href = targetHref;
      });
    });
  });

  if (els.unsavedSaveBtn) {
    els.unsavedSaveBtn.addEventListener('click', async () => {
      const next = pendingLeaveCallback;
      if (typeof pendingSaveAction === 'function') {
        els.unsavedSaveBtn.disabled = true;
        els.unsavedSaveBtn.textContent = 'saving...';
        const ok = await pendingSaveAction(null);
        if (!ok) {
          els.unsavedSaveBtn.disabled = false;
          els.unsavedSaveBtn.textContent = 'save & close';
          return;
        }
      }
      closeUnsavedLeaveModal();
      if (typeof next === 'function') next();
    });
  }

  if (els.unsavedDiscardBtn) {
    els.unsavedDiscardBtn.addEventListener('click', () => {
      const next = pendingLeaveCallback;
      clearProjectDirty();
      closeUnsavedLeaveModal();
      if (typeof next === 'function') next();
    });
  }

  [els.unsavedCancelBtn, els.unsavedCancelXBtn].forEach((btn) => {
    if (btn) btn.addEventListener('click', closeUnsavedLeaveModal);
  });

  if (els.unsavedLeaveModal) {
    els.unsavedLeaveModal.addEventListener('click', (e) => {
      if (e.target === els.unsavedLeaveModal) closeUnsavedLeaveModal();
    });
  }

  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsavedChanges) return;
    e.preventDefault();
    e.returnValue = '';
  });

  if (els.templateControlsContainer) {
    els.templateControlsContainer.addEventListener('input', markProjectDirty);
    els.templateControlsContainer.addEventListener('change', markProjectDirty);
  }

  // first visit without ?preset= lands on the preset gallery
  const urlParams = new URLSearchParams(window.location.search);
  const requestedPreset = urlParams.get('preset');
  if (!requestedPreset && (window.location.pathname === '/' || window.location.pathname === '/index.html')) {
    window.location.replace('/gallery.html');
    return;
  }
  const CUT_MODE_HINTS = {
    chord: 'dynamic chord cuts · switches clips on every harmony change',
    single: 'single serene loop · one atmospheric scene for the entire drop',
    '2bar': '2-bar rhythmic cuts · switches clips every 2 bars',
    '4bar': '4-bar phrasing cuts · switches clips every 4 bars',
    impact: 'transient impact cuts · switches clips on major audio energy peaks',
    custom: 'custom cuts · driven by custom marker layer or manual waveform cuts'
  };
  const VALID_CLIP_TRANSITIONS = new Set(['none', 'glitch', 'pan', 'datamosh', 'fade']);

  const activeTemplateId = requestedPreset || localStorage.getItem('samplevis_active_template_id') || 'constellations';
  if (window.templateRegistry.get(activeTemplateId)) {
    window.templateRegistry.setTemplate(
      activeTemplateId,
      previewCanvas,
      state,
      els.templateControlsContainer
    );
    visualizer = window.templateRegistry.activeTemplate;
    state.customImageDataUrl = visualizer?.preset?.assets?.customImage || '';
    if (visualizer?.engine) {
      visualizer.engine.onAssetLoaded = () => {
        const activeVid = getActiveVideoForTime(state.currentTime);
        visualizer?.renderFrame?.(state.currentTime, activeVid);
      };
    }
    if (els.topPresetNameInput && visualizer) {
      els.topPresetNameInput.value = visualizer.name;
    }
    applyTemplateModules(visualizer);
    syncSeamlessLoopControl(visualizer);
  } else if (els.topPresetNameInput) {
    els.topPresetNameInput.value = 'loading...';
  }

  function isCustomClipTransitionActive(tpl) {
    if (!tpl) return false;
    return Boolean(
      tpl.modules?.clips?.customTransition === true ||
      tpl.preset?.modules?.clips?.customTransition === true ||
      tpl.engine?.hasCustomClipTransition?.()
    );
  }

  function syncClipTransitionUi(tpl) {
    if (!els.clipTransitionSelect) return;
    const custom = isCustomClipTransitionActive(tpl);
    const customOpt = els.clipTransitionSelect.querySelector('option[value="custom"]');

    if (custom) {
      if (customOpt) customOpt.hidden = false;
      els.clipTransitionSelect.value = 'custom';
      els.clipTransitionSelect.disabled = true;
      els.clipTransitionSelect.title = 'transition is controlled by this preset';
      if (els.clipTransitionDurRow) els.clipTransitionDurRow.hidden = true;
      return;
    }

    if (customOpt) customOpt.hidden = true;
    els.clipTransitionSelect.disabled = false;
    els.clipTransitionSelect.title = 'global transition between clip cuts';

    const rawTrans = tpl?.params?.clipTransition;
    let trans = VALID_CLIP_TRANSITIONS.has(rawTrans) ? rawTrans : null;
    if (!trans && typeof tpl?.params?.dropGlitch === 'boolean') {
      trans = tpl.params.dropGlitch ? 'glitch' : 'none';
    }
    if (!trans) {
      trans = VALID_CLIP_TRANSITIONS.has(state.clipTransition) ? state.clipTransition : 'glitch';
    }

    const rawDur = Number(tpl?.params?.clipTransitionDuration);
    const dur = Math.max(0.10, Math.min(1.00, Number.isFinite(rawDur) ? rawDur : (Number(state.clipTransitionDuration) || 0.35)));

    state.clipTransition = trans;
    state.clipTransitionDuration = dur;
    if (tpl?.params) {
      tpl.params.clipTransition = trans;
      tpl.params.clipTransitionDuration = dur;
      tpl.params.dropGlitch = trans !== 'none';
    }

    els.clipTransitionSelect.value = trans;
    if (els.clipTransitionDurSlider) {
      els.clipTransitionDurSlider.value = dur.toFixed(2);
      els.clipTransitionDurSlider.setAttribute('aria-valuetext', `${dur.toFixed(2)}s`);
    }
    if (els.clipTransitionDurVal) {
      els.clipTransitionDurVal.textContent = `${dur.toFixed(2)}s`;
    }
    if (els.clipTransitionDurRow) {
      els.clipTransitionDurRow.hidden = (trans === 'none');
    }
  }

  function resolveCustomCutCategorySpec(tpl = visualizer) {
    const categories = window.loopUtils?.resolveMarkerCategories
      ? window.loopUtils.resolveMarkerCategories(tpl?.preset || tpl)
      : [];
    const clipModule = tpl?.modules?.clips || tpl?.preset?.modules?.clips;
    const explicitId = typeof clipModule?.customCutCategory === 'string'
      ? clipModule.customCutCategory.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
      : '';
    let matched = null;
    if (explicitId) {
      matched = categories.find((c) => c.id === explicitId) || { id: explicitId, label: explicitId.replace(/_/g, ' ') };
    } else {
      const rawCats = tpl?.preset?.features?.timeline?.categories || tpl?.features?.timeline?.categories || [];
      const flagged = Array.isArray(rawCats)
        ? rawCats.find((c) => c && (c.clipCuts === true || c.role === 'clipCuts'))
        : null;
      const flaggedId = flagged
        ? String(flagged.id || flagged.label || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
        : '';
      if (flaggedId) {
        matched = categories.find((c) => c.id === flaggedId) || null;
      }
      if (!matched) {
        matched = categories.find((c) => ['clip_cuts', 'custom_cuts', 'cuts'].includes(c.id)) || null;
      }
    }
    const catId = matched?.id || '';
    if (state.project) state.project._customCutCategory = catId;
    if (tpl?.project) tpl.project._customCutCategory = catId;
    return matched;
  }

  function syncCutModeUi(tpl) {
    if (!tpl) return;
    const clipModule = tpl.modules?.clips || tpl.preset?.modules?.clips;
    const resolvedMode =
      tpl.params?.cutMode ||
      tpl.preset?.controlsBox?.values?.cutMode ||
      clipModule?.defaultCutMode ||
      'chord';
    if (tpl.params) tpl.params.cutMode = resolvedMode;
    const customCat = resolveCustomCutCategorySpec(tpl);
    document.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.cutmode === resolvedMode);
    });
    if (els.cutmodeHint) {
      if (resolvedMode === 'custom') {
        els.cutmodeHint.textContent = customCat
          ? `custom cuts · driven by "${customCat.label || customCat.id}" marker layer`
          : 'custom cuts · double-click waveform or click + cut to place clip cuts';
      } else if (CUT_MODE_HINTS[resolvedMode]) {
        els.cutmodeHint.textContent = CUT_MODE_HINTS[resolvedMode];
      }
    }
    const ctrlCutMode = document.getElementById('ctrl_cutMode');
    if (ctrlCutMode && ctrlCutMode.value !== resolvedMode) {
      ctrlCutMode.value = resolvedMode;
    }
    if (els.speedRampToggle) {
      const speedVal = tpl.params?.speedRamping !== undefined
        ? Boolean(tpl.params.speedRamping)
        : Boolean(clipModule?.speedRamping);
      if (tpl.params) tpl.params.speedRamping = speedVal;
      els.speedRampToggle.checked = speedVal;
    }
    syncClipTransitionUi(tpl);
    if (els.autoFrameToggle) {
      els.autoFrameToggle.checked = Boolean(tpl.params?.autoFrame !== false);
    }
    renderImpactCutsUi();
  }

  function normalizeImpactTimes(times, duration = 30.0) {
    if (!Array.isArray(times)) return [];
    const maxDur = Math.max(0.1, Number(duration) || 30.0);
    const sorted = times
      .map((t) => Number(t))
      .filter((t) => Number.isFinite(t) && t >= 0 && t <= maxDur)
      .map((t) => Number(t.toFixed(3)))
      .sort((a, b) => a - b);
    const deduped = [];
    for (const t of sorted) {
      if (deduped.length === 0 || t - deduped[deduped.length - 1] >= 0.03) {
        deduped.push(t);
      }
    }
    return deduped;
  }

  function announceImpactStatus(msg) {
    if (els.impactCutsStatus) {
      els.impactCutsStatus.textContent = msg;
    }
  }

  function getEditableCutTimesMode() {
    if (!state.project) return null;
    const mode = visualizer?.params?.cutMode;
    if (mode === 'impact') return 'impact';
    if (mode === 'custom' && !resolveCustomCutCategorySpec(visualizer)) return 'custom';
    return null;
  }

  function getEditableCutTimesArray(editMode = getEditableCutTimesMode()) {
    if (!state.project || !editMode) return [];
    const arr = editMode === 'custom' ? state.project.customCutTimes : state.project.impactTimes;
    return Array.isArray(arr) ? arr : [];
  }

  function getActiveImpactIndexAt(t) {
    const cuts = getEditableCutTimesArray();
    if (!Array.isArray(cuts) || cuts.length === 0) return -1;
    let activeIdx = -1;
    for (let i = 0; i < cuts.length; i++) {
      if (t + 0.02 >= cuts[i]) activeIdx = i;
      else break;
    }
    return activeIdx;
  }

  function updateActiveImpactHighlight(t = state.currentTime) {
    const isEditable = Boolean(getEditableCutTimesMode());
    const nextIdx = isEditable ? getActiveImpactIndexAt(t) : -1;
    if (nextIdx === state._activeImpactIdx) return;
    state._activeImpactIdx = nextIdx;
    if (els.impactCutsLayer) {
      els.impactCutsLayer.querySelectorAll('.impact-cut-marker').forEach((node) => {
        const idx = parseInt(node.dataset.impactIdx || '-1', 10);
        node.classList.toggle('active', idx === nextIdx && idx >= 0);
      });
    }
    if (els.impactCutsList) {
      els.impactCutsList.querySelectorAll('.impact-cut-chip').forEach((node) => {
        const idx = parseInt(node.dataset.impactIdx || '-1', 10);
        node.classList.toggle('active', idx === nextIdx && idx >= 0);
      });
    }
  }

  function updateWaveformTooltip(hasMarkers) {
    if (!els.waveformContainer) return;
    const editMode = getEditableCutTimesMode();
    const cutLabel = editMode === 'custom' ? 'custom cut' : 'impact cut';
    if (editMode && hasMarkers) {
      els.waveformContainer.title = `click or drag to scrub · double-click to add ${cutLabel} · drag cuts or markers to adjust`;
    } else if (editMode) {
      els.waveformContainer.title = `click or drag to scrub · double-click to add ${cutLabel} · drag cuts to adjust`;
    } else if (hasMarkers) {
      els.waveformContainer.title = 'click or drag to scrub · drag marker bars to adjust timing';
    } else {
      els.waveformContainer.title = 'click or drag to scrub';
    }
  }

  function renderImpactCutsUi() {
    const editMode = getEditableCutTimesMode();
    const isImpact = Boolean(editMode);
    const isCustomMode = editMode === 'custom';
    const cuts = isImpact ? getEditableCutTimesArray(editMode) : [];
    const dur = Math.max(0.1, state.project?.duration || 30.0);
    const activeIdx = isImpact ? getActiveImpactIndexAt(state.currentTime) : -1;
    state._activeImpactIdx = activeIdx;

    if (els.impactCutsEditor) {
      els.impactCutsEditor.hidden = !isImpact;
      const labelEl = els.impactCutsEditor.querySelector('.impact-cuts-label');
      if (labelEl) {
        const countSpan = els.impactCutsCount;
        labelEl.textContent = isCustomMode ? 'custom cuts ' : 'impact cuts ';
        if (countSpan) labelEl.appendChild(countSpan);
      }
    }
    if (els.impactCutsLayer) {
      els.impactCutsLayer.hidden = !isImpact;
      if (!isImpact) {
        els.impactCutsLayer.textContent = '';
      } else if (state.draggingImpactIdx < 0) {
        els.impactCutsLayer.textContent = '';
        cuts.forEach((ct, idx) => {
          const pct = Math.max(0, Math.min(100, (ct / dur) * 100));
          const marker = document.createElement('div');
          marker.className = 'impact-cut-marker';
          if (idx === activeIdx) marker.classList.add('active');
          marker.dataset.impactIdx = String(idx);
          marker.style.left = `${pct}%`;

          const handle = document.createElement('button');
          handle.type = 'button';
          handle.className = 'impact-cut-handle';
          handle.setAttribute('aria-label', `impact cut ${idx + 1} at ${ct.toFixed(2)}s`);
          handle.title = `impact cut ${ct.toFixed(2)}s · drag to move · right-click or × to remove`;

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'impact-cut-remove';
          removeBtn.textContent = '×';
          removeBtn.setAttribute('aria-label', `remove impact cut at ${ct.toFixed(2)}s`);
          removeBtn.title = `remove impact cut at ${ct.toFixed(2)}s`;

          marker.appendChild(handle);
          marker.appendChild(removeBtn);
          els.impactCutsLayer.appendChild(marker);
        });
      }
    }

    if (!isImpact) return;

    if (els.impactCutsCount) {
      els.impactCutsCount.textContent = String(cuts.length);
    }
    if (els.resetImpactCutsBtn) {
      const canReset = isCustomMode
        ? cuts.length > 0
        : Boolean(state.project?._impactTimesEdited && Array.isArray(state.project?._defaultImpactTimes));
      els.resetImpactCutsBtn.textContent = isCustomMode ? 'clear' : 'reset';
      els.resetImpactCutsBtn.title = isCustomMode ? 'clear custom cuts' : 'restore auto-detected impact cuts';
      els.resetImpactCutsBtn.setAttribute('aria-disabled', canReset ? 'false' : 'true');
    }

    if (els.impactCutsList) {
      els.impactCutsList.textContent = '';
      if (cuts.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'impact-cuts-empty';
        empty.textContent = isCustomMode
          ? 'no custom cuts · double-click waveform or click + cut'
          : 'no impact cuts · double-click waveform or click + cut';
        els.impactCutsList.appendChild(empty);
      } else {
        cuts.forEach((ct, idx) => {
          const chip = document.createElement('div');
          chip.className = 'impact-cut-chip';
          if (idx === activeIdx) chip.classList.add('active');
          chip.dataset.impactIdx = String(idx);

          const seekBtn = document.createElement('button');
          seekBtn.type = 'button';
          seekBtn.className = 'impact-cut-seek';
          seekBtn.textContent = `${ct.toFixed(2)}s`;
          seekBtn.title = `seek to ${ct.toFixed(2)}s`;
          seekBtn.addEventListener('click', () => {
            seekToTime(ct);
          });

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'impact-cut-del';
          delBtn.textContent = '×';
          delBtn.setAttribute('aria-label', `remove impact cut at ${ct.toFixed(2)}s`);
          delBtn.title = `remove impact cut at ${ct.toFixed(2)}s`;
          delBtn.addEventListener('click', () => {
            removeImpactCutAtIndex(idx);
          });

          chip.appendChild(seekBtn);
          chip.appendChild(delBtn);
          els.impactCutsList.appendChild(chip);
        });
      }
    }
  }

  function syncImpactTimesToEngine(nextTimes, opts = {}) {
    if (!state.project) return;
    const targetMode = opts.mode || getEditableCutTimesMode() || 'impact';
    const edited = opts.edited !== false;
    const clean = normalizeImpactTimes(nextTimes, state.project.duration || 30.0);
    if (targetMode === 'custom') {
      state.project.customCutTimes = clean;
      if (visualizer?.project && visualizer.project !== state.project) {
        visualizer.project.customCutTimes = clean;
      }
    } else {
      state.project.impactTimes = clean;
      state.project._impactTimesEdited = edited;
      if (visualizer?.project && visualizer.project !== state.project) {
        visualizer.project.impactTimes = clean;
        visualizer.project._impactTimesEdited = edited;
      }
    }
    if (typeof visualizer?.rebuildNoteNodes === 'function') {
      visualizer.rebuildNoteNodes();
    } else if (typeof visualizer?.invalidateLoopCache === 'function') {
      visualizer.invalidateLoopCache();
    }
    drawWaveform();
    renderImpactCutsUi();
    if (!state.isPlaying) {
      const { activeVid } = syncVideosToTime(state.currentTime, { forceSeek: true });
      visualizer?.renderFrame?.(state.currentTime, activeVid);
      state._lastRenderedTime = state.currentTime;
      state._lastRenderedVid = activeVid;
      state._lastRenderedVidTime = activeVid ? (activeVid.currentTime || 0) : -1;
      state._needsRender = false;
    }
    if (!opts.skipPersist) {
      persistCurrentProjectState().catch(() => { });
      markProjectDirty();
    }
  }

  function addImpactCutAt(timeSec) {
    if (!state.project) return false;
    const editMode = getEditableCutTimesMode() || 'impact';
    const dur = Math.max(0.1, state.project.duration || 30.0);
    const clamped = Number(Math.max(0, Math.min(dur, Number(timeSec) || 0)).toFixed(3));
    const current = getEditableCutTimesArray(editMode);
    const label = editMode === 'custom' ? 'custom cut' : 'impact cut';
    const nearIdx = current.findIndex((c) => Math.abs(c - clamped) < 0.03);
    if (nearIdx >= 0) {
      announceImpactStatus(`${label} already exists at ${current[nearIdx].toFixed(2)}s`);
      return false;
    }
    syncImpactTimesToEngine([...current, clamped], { mode: editMode, edited: true });
    announceImpactStatus(`added ${label} at ${clamped.toFixed(2)}s`);
    return true;
  }

  function removeImpactCutAtIndex(idx) {
    const editMode = getEditableCutTimesMode() || 'impact';
    const current = getEditableCutTimesArray(editMode);
    if (!state.project || idx < 0 || idx >= current.length) return false;
    const removedTime = current[idx];
    const next = current.filter((_, i) => i !== idx);
    syncImpactTimesToEngine(next, { mode: editMode, edited: true });
    announceImpactStatus(`removed ${editMode === 'custom' ? 'custom cut' : 'impact cut'} at ${removedTime.toFixed(2)}s`);
    return true;
  }

  function resetImpactCutsToAuto() {
    if (!state.project) return;
    if (getEditableCutTimesMode() === 'custom') {
      syncImpactTimesToEngine([], { mode: 'custom', edited: true });
      announceImpactStatus('cleared custom cuts');
      return;
    }
    if (!Array.isArray(state.project._defaultImpactTimes)) return;
    syncImpactTimesToEngine([...state.project._defaultImpactTimes], { mode: 'impact', edited: false });
    announceImpactStatus('restored auto-detected impact cuts');
  }

  function installToolbarFocusgroupFallback(toolbarEl) {
    if (!toolbarEl || 'focusGroup' in HTMLElement.prototype) return;
    if (toolbarEl.dataset.fgFallbackWired === '1') {
      const items = Array.from(toolbarEl.querySelectorAll('button'));
      if (items.length > 0 && !items.some((b) => b.tabIndex === 0)) {
        items.forEach((btn, idx) => {
          btn.tabIndex = idx === 0 ? 0 : -1;
        });
      }
      return;
    }
    toolbarEl.dataset.fgFallbackWired = '1';
    const getItems = () => Array.from(toolbarEl.querySelectorAll('button'));
    const syncInitial = () => {
      const items = getItems();
      if (items.length > 0 && !items.some((b) => b.tabIndex === 0)) {
        items.forEach((btn, idx) => {
          btn.tabIndex = idx === 0 ? 0 : -1;
        });
      }
    };
    syncInitial();
    toolbarEl.addEventListener('focusin', ({ target }) => {
      const items = getItems();
      if (items.includes(target)) {
        items.forEach((b) => {
          b.tabIndex = b === target ? 0 : -1;
        });
      }
    });
    toolbarEl.addEventListener('keydown', (e) => {
      const items = getItems();
      const curIdx = items.indexOf(document.activeElement);
      if (curIdx < 0 || items.length === 0) return;
      const rtl = getComputedStyle(toolbarEl).direction === 'rtl';
      let nextIdx = -1;
      if (e.key === 'ArrowRight') nextIdx = (curIdx + (rtl ? -1 : 1) + items.length) % items.length;
      else if (e.key === 'ArrowLeft') nextIdx = (curIdx + (rtl ? 1 : -1) + items.length) % items.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = items.length - 1;
      if (nextIdx >= 0) {
        e.preventDefault();
        items[nextIdx].focus();
      }
    });
  }

  function getActivePresetSpecForCues() {
    if (visualizer?.preset) return visualizer.preset;
    const tplId = window.templateRegistry?.activeTemplateId;
    const tpl = tplId ? window.templateRegistry?.get?.(tplId) : null;
    return tpl?.preset || tpl || visualizer || null;
  }

  function getDefinedCueCategories() {
    const lu = window.loopUtils;
    const spec = getActivePresetSpecForCues();
    return lu?.resolveMarkerCategories ? lu.resolveMarkerCategories(spec) : [];
  }

  function isCueCategoryVisible(catId) {
    if (!catId) return false;
    if (state.visibleCueCategories[catId] === undefined) {
      state.visibleCueCategories[catId] = true;
    }
    return state.visibleCueCategories[catId] !== false;
  }

  function getActiveCueCategory(categories = getDefinedCueCategories()) {
    if (!categories.length) return null;
    const visible = categories.filter((c) => isCueCategoryVisible(c.id));
    if (!visible.length) return null;
    const matched = visible.find((c) => c.id === state.activeCueCategoryId);
    if (matched) return matched;
    state.activeCueCategoryId = visible[0].id;
    return visible[0];
  }

  function announceCustomCueStatus(message) {
    if (els.customCuesStatus) {
      els.customCuesStatus.textContent = String(message || '').toLowerCase();
    }
  }

  function getNormalizedCustomCuesMap() {
    const lu = window.loopUtils;
    const spec = getActivePresetSpecForCues();
    if (!lu?.resolveCustomCuesByCategory || !state.project) {
      return { categories: getDefinedCueCategories(), byCategory: {} };
    }
    return lu.resolveCustomCuesByCategory(spec, state.project);
  }

  function syncCustomCuesToEngine(nextMap, { skipPersist = false } = {}) {
    if (!state.project) return;
    const lu = window.loopUtils;
    const categories = getDefinedCueCategories();
    const dur = Math.max(0.1, state.project.duration || 30.0);
    const bpm = Math.max(40, Math.min(240, parseFloat(state.project.bpm) || 120));
    const beatSec = 60 / bpm;
    const cleanMap = {};
    if (nextMap && typeof nextMap === 'object') {
      for (const cat of categories) {
        const raw = Array.isArray(nextMap[cat.id]) ? nextMap[cat.id] : [];
        cleanMap[cat.id] = lu?.normalizeCategoryCues
          ? lu.normalizeCategoryCues(raw, dur, cat.kind, cat.defaultBeats * beatSec, bpm)
          : raw;
      }
      for (const [k, v] of Object.entries(nextMap)) {
        if (!cleanMap[k] && Array.isArray(v)) cleanMap[k] = v;
      }
    }
    state.project._customCues = cleanMap;
    if (visualizer?.project && visualizer.project !== state.project) {
      visualizer.project._customCues = cleanMap;
    }
    if (visualizer?.params?.cutMode === 'custom' && resolveCustomCutCategorySpec(visualizer)) {
      if (typeof visualizer?.invalidateLoopCache === 'function') {
        visualizer.invalidateLoopCache();
      }
      drawWaveform();
    }
    renderCustomCuesUi();
    if (!state.isPlaying) {
      const { activeVid } = syncVideosToTime(state.currentTime, { forceSeek: true });
      visualizer?.renderFrame?.(state.currentTime, activeVid);
      state._lastRenderedTime = state.currentTime;
      state._lastRenderedVid = activeVid;
      state._lastRenderedVidTime = activeVid ? (activeVid.currentTime || 0) : -1;
      state._needsRender = false;
    }
    if (!skipPersist) {
      markProjectDirty();
      persistCurrentProjectState();
    }
  }

  function addCustomCueAt(catId, time, durationOverride = null) {
    if (!state.project || !catId) return false;
    const categories = getDefinedCueCategories();
    const cat = categories.find((c) => c.id === catId);
    if (!cat) return false;
    const dur = Math.max(0.1, state.project.duration || 30.0);
    const bpm = Math.max(40, Math.min(240, parseFloat(state.project.bpm) || 120));
    const beatSec = 60 / bpm;
    const defaultSpan = cat.kind === 'range'
      ? Math.max(0.08, Math.min(dur * 0.5, Number.isFinite(durationOverride) && durationOverride > 0 ? durationOverride : cat.defaultBeats * beatSec))
      : 0;
    const maxStart = Math.max(0, dur - (cat.kind === 'range' ? Math.min(0.08, defaultSpan) : 0.02));
    const clampedT = Number(Math.max(0, Math.min(maxStart, Number(time) || 0)).toFixed(3));
    const existing = Array.isArray(state.project._customCues?.[catId]) ? [...state.project._customCues[catId]] : [];
    const nextItem = {
      id: `c_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`,
      time: clampedT,
      duration: cat.kind === 'range' ? Number(Math.min(dur - clampedT, defaultSpan).toFixed(3)) : 0
    };
    existing.push(nextItem);
    const nextMap = { ...(state.project._customCues || {}), [catId]: existing };
    state.visibleCueCategories[catId] = true;
    state.activeCueCategoryId = catId;
    syncCustomCuesToEngine(nextMap);
    announceCustomCueStatus(`added ${cat.label} marker at ${clampedT.toFixed(2)}s`);
    return true;
  }

  function removeCustomCueAt(catId, idx) {
    if (!state.project || !catId) return false;
    const list = Array.isArray(state.project._customCues?.[catId]) ? state.project._customCues[catId] : [];
    if (idx < 0 || idx >= list.length) return false;
    const removed = list[idx];
    const nextList = list.filter((_, i) => i !== idx);
    const nextMap = { ...(state.project._customCues || {}), [catId]: nextList };
    syncCustomCuesToEngine(nextMap);
    announceCustomCueStatus(`removed ${catId} marker at ${Number(removed?.time || 0).toFixed(2)}s`);
    return true;
  }

  function clearCustomCuesForCategory(catId) {
    if (!state.project || !catId) return;
    const nextMap = { ...(state.project._customCues || {}), [catId]: [] };
    syncCustomCuesToEngine(nextMap);
    announceCustomCueStatus(`cleared ${catId} markers`);
  }

  function applyTimelineCueSeeds(seedsObj) {
    if (!state.project || !seedsObj || typeof seedsObj !== 'object') return false;
    const entries = Object.entries(seedsObj).filter(([, arr]) => Array.isArray(arr));
    if (entries.length === 0) return false;
    const nextMap = { ...(state.project._customCues || {}) };
    let applied = false;
    for (const [rawKey, arr] of entries) {
      const cleanKey = String(rawKey || '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
      if (!cleanKey) continue;
      nextMap[cleanKey] = arr;
      state.visibleCueCategories[cleanKey] = true;
      state.activeCueCategoryId = cleanKey;
      applied = true;
    }
    if (applied) {
      syncCustomCuesToEngine(nextMap);
    }
    return applied;
  }

  function updateActiveCustomCueHighlight(t = state.currentTime) {
    const { categories, byCategory } = getNormalizedCustomCuesMap();
    if (!categories.length) return;
    const lu = window.loopUtils;
    const bpm = state.project?.bpm || 120;
    const activeKeys = new Set();
    for (const cat of categories) {
      if (!isCueCategoryVisible(cat.id)) continue;
      const st = lu?.getCueStateAtTime
        ? lu.getCueStateAtTime(byCategory[cat.id] || [], t, { kind: cat.kind, defaultBeats: cat.defaultBeats, bpm })
        : null;
      if (st?.active && st.index >= 0) {
        activeKeys.add(`${cat.id}:${st.index}`);
      }
    }
    const nextKey = Array.from(activeKeys).sort().join(',');
    if (nextKey === state._activeCustomCueKey) return;
    state._activeCustomCueKey = nextKey;

    if (els.customCuesLayer) {
      els.customCuesLayer.querySelectorAll('[data-cue-cat][data-cue-idx]').forEach((node) => {
        const key = `${node.dataset.cueCat}:${node.dataset.cueIdx}`;
        node.classList.toggle('active', activeKeys.has(key));
      });
    }
    if (els.customCuesList) {
      els.customCuesList.querySelectorAll('.custom-cue-chip[data-cue-cat][data-cue-idx]').forEach((node) => {
        const key = `${node.dataset.cueCat}:${node.dataset.cueIdx}`;
        node.classList.toggle('active', activeKeys.has(key));
      });
    }
  }

  function renderCustomCuesUi() {
    const { categories, byCategory } = getNormalizedCustomCuesMap();
    const hasCategories = categories.length > 0;
    const visibleCats = categories.filter((c) => isCueCategoryVisible(c.id));
    const activeCat = getActiveCueCategory(categories);
    const dur = Math.max(0.1, state.project?.duration || 30.0);

    if (els.markerCategoriesToolbar) {
      els.markerCategoriesToolbar.hidden = !hasCategories;
      els.markerCategoriesToolbar.textContent = '';
      if (hasCategories) {
        categories.forEach((cat) => {
          const pressed = isCueCategoryVisible(cat.id);
          const count = (byCategory[cat.id] || []).length;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn-inline marker-category-toggle';
          btn.dataset.cueCat = cat.id;
          btn.style.setProperty('--cue-color', cat.color);
          btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
          btn.title = `${pressed ? 'hide' : 'show'} ${cat.label} (${cat.kind}) markers`;

          const swatch = document.createElement('span');
          swatch.className = 'marker-category-swatch';
          swatch.setAttribute('aria-hidden', 'true');

          const text = document.createElement('span');
          text.textContent = cat.label;

          const countEl = document.createElement('span');
          countEl.className = 'marker-category-count';
          countEl.textContent = String(count);

          btn.appendChild(swatch);
          btn.appendChild(text);
          btn.appendChild(countEl);
          els.markerCategoriesToolbar.appendChild(btn);
        });
        installToolbarFocusgroupFallback(els.markerCategoriesToolbar);
      }
    }

    if (els.customCuesLayer) {
      const showLayer = hasCategories && visibleCats.length > 0 && Boolean(state.project);
      els.customCuesLayer.hidden = !showLayer;
      if (!showLayer) {
        els.customCuesLayer.textContent = '';
      } else if (!state.draggingCustomCue) {
        els.customCuesLayer.textContent = '';
        visibleCats.forEach((cat) => {
          const list = byCategory[cat.id] || [];
          list.forEach((cue, idx) => {
            const zoom = Math.max(1, state.timelineZoom || 1);
            const leftPct = Math.max(0, Math.min(100, (cue.time / dur) * 100));
            const alignLeft = leftPct > 100 - (18 / zoom);
            if (cat.kind === 'range') {
              const spanPct = Math.max(0.05, Math.min(100 - leftPct, (cue.duration / dur) * 100));
              const el = document.createElement('div');
              el.className = 'custom-cue-range';
              if (alignLeft) el.classList.add('align-left');
              el.dataset.cueCat = cat.id;
              el.dataset.cueIdx = String(idx);
              el.style.setProperty('--cue-color', cat.color);
              el.style.left = `${leftPct.toFixed(4)}%`;
              el.style.width = `${spanPct.toFixed(4)}%`;
              el.title = `${cat.label} ${cue.time.toFixed(2)}s–${cue.endTime.toFixed(2)}s · drag to move, edges to trim, right-click to remove`;

              const tag = document.createElement('span');
              tag.className = 'custom-cue-tag';
              tag.textContent = `${cat.label} ${idx + 1}`;

              const startHandle = document.createElement('button');
              startHandle.type = 'button';
              startHandle.className = 'custom-cue-edge-handle custom-cue-edge-start';
              startHandle.dataset.edge = 'start';
              startHandle.setAttribute('aria-label', `${cat.label} ${idx + 1} start at ${cue.time.toFixed(2)}s`);

              const endHandle = document.createElement('button');
              endHandle.type = 'button';
              endHandle.className = 'custom-cue-edge-handle custom-cue-edge-end';
              endHandle.dataset.edge = 'end';
              endHandle.setAttribute('aria-label', `${cat.label} ${idx + 1} end at ${cue.endTime.toFixed(2)}s`);

              const removeBtn = document.createElement('button');
              removeBtn.type = 'button';
              removeBtn.className = 'custom-cue-remove';
              removeBtn.textContent = '×';
              removeBtn.setAttribute('aria-label', `remove ${cat.label} at ${cue.time.toFixed(2)}s`);
              removeBtn.title = `remove ${cat.label} at ${cue.time.toFixed(2)}s`;

              el.appendChild(tag);
              el.appendChild(startHandle);
              el.appendChild(endHandle);
              el.appendChild(removeBtn);
              els.customCuesLayer.appendChild(el);
            } else {
              const el = document.createElement('div');
              el.className = 'custom-cue-point';
              if (alignLeft) el.classList.add('align-left');
              el.dataset.cueCat = cat.id;
              el.dataset.cueIdx = String(idx);
              el.style.setProperty('--cue-color', cat.color);
              el.style.left = `${leftPct.toFixed(4)}%`;

              const tag = document.createElement('span');
              tag.className = 'custom-cue-tag';
              tag.textContent = `${cat.label} ${idx + 1}`;

              const handle = document.createElement('button');
              handle.type = 'button';
              handle.className = 'custom-cue-handle';
              handle.setAttribute('aria-label', `${cat.label} ${idx + 1} at ${cue.time.toFixed(2)}s`);
              handle.title = `${cat.label} ${cue.time.toFixed(2)}s · drag to move · right-click or × to remove`;

              const removeBtn = document.createElement('button');
              removeBtn.type = 'button';
              removeBtn.className = 'custom-cue-remove';
              removeBtn.textContent = '×';
              removeBtn.setAttribute('aria-label', `remove ${cat.label} at ${cue.time.toFixed(2)}s`);
              removeBtn.title = `remove ${cat.label} at ${cue.time.toFixed(2)}s`;

              el.appendChild(tag);
              el.appendChild(handle);
              el.appendChild(removeBtn);
              els.customCuesLayer.appendChild(el);
            }
          });
        });
      }
    }

    const showEditor = hasCategories && visibleCats.length > 0 && Boolean(state.project);
    if (els.customCuesEditor) {
      els.customCuesEditor.hidden = !showEditor;
    }
    if (!showEditor) return;

    if (els.customCuesCatList) {
      els.customCuesCatList.textContent = '';
      visibleCats.forEach((cat) => {
        const isActive = activeCat?.id === cat.id;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'custom-cue-cat-btn';
        btn.dataset.cueCat = cat.id;
        btn.style.setProperty('--cue-color', cat.color);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        btn.title = `edit ${cat.label} (${cat.kind}) markers`;

        const swatch = document.createElement('span');
        swatch.className = 'marker-category-swatch';
        swatch.setAttribute('aria-hidden', 'true');

        const lbl = document.createElement('span');
        lbl.textContent = cat.label;

        const kindEl = document.createElement('span');
        kindEl.className = 'custom-cue-kind';
        kindEl.textContent = cat.kind;

        btn.appendChild(swatch);
        btn.appendChild(lbl);
        btn.appendChild(kindEl);
        els.customCuesCatList.appendChild(btn);
      });
      installToolbarFocusgroupFallback(els.customCuesCatList);
    }

    const activeList = activeCat ? (byCategory[activeCat.id] || []) : [];
    if (els.clearCustomCuesBtn) {
      els.clearCustomCuesBtn.setAttribute('aria-disabled', activeList.length > 0 ? 'false' : 'true');
    }
    if (els.customCuesActionsToolbar) {
      installToolbarFocusgroupFallback(els.customCuesActionsToolbar);
    }

    if (els.customCuesList) {
      els.customCuesList.textContent = '';
      if (!activeCat || activeList.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'impact-cuts-empty';
        empty.textContent = activeCat
          ? `no ${activeCat.label} markers · click + mark or double-click waveform`
          : 'no active marker category';
        els.customCuesList.appendChild(empty);
      } else {
        activeList.forEach((cue, idx) => {
          const chip = document.createElement('div');
          chip.className = 'custom-cue-chip';
          chip.dataset.cueCat = activeCat.id;
          chip.dataset.cueIdx = String(idx);
          chip.style.setProperty('--cue-color', activeCat.color);

          const seekBtn = document.createElement('button');
          seekBtn.type = 'button';
          seekBtn.className = 'custom-cue-seek';
          seekBtn.textContent = activeCat.kind === 'range'
            ? `${cue.time.toFixed(2)}s–${cue.endTime.toFixed(2)}s`
            : `${cue.time.toFixed(2)}s`;
          seekBtn.title = `seek to ${cue.time.toFixed(2)}s`;
          seekBtn.addEventListener('click', () => {
            seekToTime(cue.time);
          });

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'custom-cue-del';
          delBtn.textContent = '×';
          delBtn.setAttribute('aria-label', `remove ${activeCat.label} at ${cue.time.toFixed(2)}s`);
          delBtn.addEventListener('click', () => removeCustomCueAt(activeCat.id, idx));

          chip.appendChild(seekBtn);
          chip.appendChild(delBtn);
          els.customCuesList.appendChild(chip);
        });
      }
    }

    state._activeCustomCueKey = '';
    updateActiveCustomCueHighlight(state.currentTime);
  }

  function syncSeamlessLoopControl(tpl) {
    if (tpl && tpl.params && tpl.params.seamlessLoop === undefined) {
      tpl.params.seamlessLoop = state.seamlessLoop !== false;
    }
    if (tpl && tpl.params && tpl.params.loopStyle === undefined) {
      tpl.params.loopStyle = state.seamlessLoopStyle || 'datamosh';
    }
    const enabled = tpl?.params ? tpl.params.seamlessLoop !== false : state.seamlessLoop !== false;
    const style = tpl?.params?.loopStyle === 'fade' ? 'fade' : (state.seamlessLoopStyle === 'fade' ? 'fade' : 'datamosh');
    state.seamlessLoop = enabled;
    state.seamlessLoopStyle = style;
    if (els.seamlessReelLoopCheckbox) {
      els.seamlessReelLoopCheckbox.checked = enabled;
    }
    if (els.seamlessLoopStyleSelect) {
      els.seamlessLoopStyleSelect.value = style;
      els.seamlessLoopStyleSelect.disabled = !enabled;
    }
  }

  function applyTemplateModules(tpl) {
    if (!tpl) return;
    const clipModule = tpl.modules?.clips || tpl.preset?.modules?.clips || tpl.features?.clips;
    const clipsEnabled = clipModule !== false && (clipModule?.enabled !== false);

    if (els.clipsSection) {
      els.clipsSection.hidden = !clipsEnabled;
      if (clipsEnabled && els.clipsSectionTitle) {
        els.clipsSectionTitle.textContent = clipModule?.label || 'clips';
      }
      if (clipsEnabled && clipModule?.source && els.clipSourceSelect) {
        if (['anime', 'real_life', 'local'].includes(clipModule.source)) {
          els.clipSourceSelect.value = clipModule.source;
        }
      }
      if (clipsEnabled && els.clipCustomQueryInput) {
        if (clipModule?.query !== undefined) {
          els.clipCustomQueryInput.value = clipModule.query || '';
        } else if (clipModule?.category && clipModule.category !== 'all') {
          els.clipCustomQueryInput.value = String(clipModule.category).replace(/_/g, ' ');
        }
        els.clipCustomQueryInput.disabled = els.clipSourceSelect?.value === 'local';
      }
    }

    if (els.studioGrid) {
      els.studioGrid.classList.toggle('no-clips', !clipsEnabled);
    }

    if (els.paneTabClipsBtn) {
      els.paneTabClipsBtn.hidden = !clipsEnabled;
      if (!clipsEnabled && els.studioGrid?.dataset.activePane === 'clips') {
        const opticsTab = els.studioPaneTabs?.querySelector('[data-pane="optics"]');
        opticsTab?.click();
      }
    }

    syncCutModeUi(tpl);

    const midiModule = tpl.modules?.midiTracks || tpl.preset?.modules?.midiTracks;
    const midiEnabled = tpl.id === 'constellations' || (midiModule !== undefined && midiModule.enabled !== false);
    if (els.midiTracksSection) {
      els.midiTracksSection.hidden = !midiEnabled;
      if (midiEnabled && els.midiTracksTitle) {
        els.midiTracksTitle.textContent = midiModule?.label || 'midi tracks';
      }
    }

    const lyricsModule = tpl.modules?.lyrics || tpl.preset?.modules?.lyrics;
    const lyricsEnabled = Boolean(lyricsModule && lyricsModule.enabled !== false);
    state._lyricsModuleEnabled = lyricsEnabled;
    if (els.lyricsSection) {
      els.lyricsSection.hidden = !lyricsEnabled;
    }
    updateLyricsTimelineVisibility();
    renderLyricsTimelineBar();
    renderCustomCuesUi();

    const activeSpec = tpl.preset || tpl;
    const resolvedMarkers = window.loopUtils?.resolveTimelineMarkers
      ? window.loopUtils.resolveTimelineMarkers(activeSpec, state.project || { duration: 30, bpm: 120 })
      : [];
    const markersEnabled = resolvedMarkers.length > 0;
    if (els.jumpDropBtn) els.jumpDropBtn.hidden = !markersEnabled;
    if (els.dropBadgeReadout) els.dropBadgeReadout.hidden = !markersEnabled;
    if (els.timelineMarkersLayer) els.timelineMarkersLayer.hidden = !markersEnabled;
    updateWaveformTooltip(markersEnabled);
    if (state.project) {
      drawWaveform();
    }
  }
  function applyAspectRatio(nextAspect, shouldMarkDirty = false) {
    const clean = String(nextAspect || '').trim();
    const ratio = clean === '16:9' ? '16:9' : (clean === '1:1' ? '1:1' : '9:16');
    state.aspectRatio = ratio;

    if (els.canvasHousing) {
      els.canvasHousing.classList.toggle('aspect-16-9', ratio === '16:9');
      els.canvasHousing.classList.toggle('aspect-1-1', ratio === '1:1');
    }

    const targetW = ratio === '16:9' ? 1920 : 1080;
    const targetH = ratio === '16:9' ? 1080 : (ratio === '1:1' ? 1080 : 1920);
    previewCanvas.width = targetW;
    previewCanvas.height = targetH;

    // sync topbar controls before invoking renderer so a frame error never leaves the toggle label stale
    if (els.aspectRatioTelemetry) {
      els.aspectRatioTelemetry.textContent = `res: ${targetW}×${targetH} (${ratio})`;
    }

    if (els.renderMp4Btn && !state.isRendering) {
      els.renderMp4Btn.textContent = `render ${targetW}×${targetH} 60fps mp4 (client gpu)`;
    }

    if (els.aspectRatioToggleBtn) {
      const nextLabel = ratio === '9:16'
        ? 'switch to 16:9 widescreen'
        : ratio === '16:9'
          ? 'switch to 1:1 square'
          : 'switch to 9:16 vertical';
      els.aspectRatioToggleBtn.textContent = nextLabel;
      els.aspectRatioToggleBtn.title = nextLabel;
      els.aspectRatioToggleBtn.setAttribute('aria-pressed', String(ratio !== '9:16'));
    }

    if (shouldMarkDirty && visualizer?.preset) {
      visualizer.preset.meta = {
        ...(visualizer.preset.meta || {}),
        aspectRatio: ratio
      };
    }

    try {
      if (visualizer && typeof visualizer.setAspectRatio === 'function') {
        visualizer.setAspectRatio(ratio);
      }

      const activeVid = typeof getActiveVideoForTime === 'function' ? getActiveVideoForTime(state.currentTime) : null;
      if (visualizer && typeof visualizer.renderFrame === 'function') {
        visualizer.renderFrame(state.currentTime, activeVid);
      }
    } catch (err) {
      console.error('Error updating visualizer for aspect ratio change:', err);
    }

    if (shouldMarkDirty) {
      markProjectDirty();
    }
  }

  window.applyTemplateModules = applyTemplateModules;
  window.updateMetadataToVisualizer = updateMetadataToVisualizer;

  function formatTime(sec) {
    const s = Math.max(0, sec || 0);
    const mins = Math.floor(s / 60);
    const rem = (s % 60).toFixed(2).padStart(5, '0');
    return `${String(mins).padStart(2, '0')}:${rem}`;
  }

  function syncProjectHeaderTags(project) {
    if (!project) return;
    if (els.uploadStatusText) {
      const metaParts = [];
      if (project.sampleNumber) metaParts.push(`#${project.sampleNumber}`);
      if (project.title) metaParts.push(project.title);
      const subParts = [];
      if (project.bpm) subParts.push(`${project.bpm}bpm`);
      if (project.key) subParts.push(project.key);
      const subStr = subParts.length ? ` (${subParts.join(' · ')})` : '';
      els.uploadStatusText.textContent = `active: ${metaParts.join(' - ')}${subStr}`;
    }
    if (els.headerPreviewTag) {
      const num = project.sampleNumber ? `#${String(project.sampleNumber).replace(/^#?\s*0*/, '') || '1'} - ` : '';
      const brandPart = project.brand ? ` · ${project.brand}` : '';
      els.headerPreviewTag.textContent = `[${num}${project.title || 'untitled'}${brandPart}]`;
    }
  }

  function updateMetadataToVisualizer() {
    if (!state.project) return;
    state.project.brand = els.inputBrand.value.trim();
    state.project.sampleNumber = els.inputNumber.value.trim();
    state.project.title = els.inputTitle.value.trim() || 'untitled';
    state.project.bpm = parseFloat(els.inputBpm.value) || 120;
    state.project.key = els.inputKey.value.trim() || '';
    if (visualizer) {
      if (typeof visualizer.setProject === 'function') {
        visualizer.setProject(state.project);
      } else if (visualizer.project) {
        visualizer.project.brand = state.project.brand;
        visualizer.project.sampleNumber = state.project.sampleNumber;
        visualizer.project.title = state.project.title;
        visualizer.project.bpm = state.project.bpm;
        visualizer.project.key = state.project.key;
      }
    }

    syncProjectHeaderTags(state.project);
  }

  function getClipSourceBucket(clip) {
    if (!clip) return 'anime';
    if (clip.isLocal || clip.source === 'local') return 'local';
    if (clip.source === 'real_life') return 'real_life';
    return 'anime';
  }

  // prepends newest fetches on top, deduplicates, and trims each source bucket to 120 from the bottom
  function mergeClipsIntoList(incoming = [], existing = [], { maxPerSource = MAX_CLIP_PICKER_CLIPS } = {}) {
    const seen = new Set();
    const bucketCounts = { anime: 0, real_life: 0, local: 0 };
    const selectedSet = new Set(state.selectedClipIds || []);
    const merged = [];

    for (const item of [...(Array.isArray(incoming) ? incoming : []), ...(Array.isArray(existing) ? existing : [])]) {
      if (!item || !item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      const bucket = getClipSourceBucket(item);
      if (bucketCounts[bucket] < maxPerSource) {
        bucketCounts[bucket] += 1;
        merged.push(item);
        state._archivedSelectedClips?.delete?.(item.id);
      } else if (selectedSet.has(item.id)) {
        // keep dropped clips available for active playlist playback without exceeding the 120 picker cap
        state._archivedSelectedClips?.set?.(item.id, item);
      }
    }
    return merged;
  }

  function findClipById(clipId) {
    if (!clipId) return null;
    return (
      (state.clips || []).find((c) => c.id === clipId) ||
      (state.favoriteClips || []).find((c) => c.id === clipId) ||
      state._archivedSelectedClips?.get?.(clipId) ||
      null
    );
  }

  function isClipFavorited(clipId) {
    if (!clipId) return false;
    return (state.favoriteClips || []).some((c) => c.id === clipId);
  }

  function updateFavoritesCountUi() {
    const count = (state.favoriteClips || []).length;
    if (els.favoritesCountBadge) els.favoritesCountBadge.textContent = String(count);
    if (els.favoritesDrawerCount) els.favoritesDrawerCount.textContent = String(count);
  }

  function setFavoritesDrawerOpen(open) {
    if (!els.favoritesDrawer) return;
    const isOpen = Boolean(open);
    els.favoritesDrawer.hidden = !isOpen;
    els.favoritesDrawer.inert = !isOpen;
    if (els.favoritesDrawerScrim) {
      els.favoritesDrawerScrim.hidden = !isOpen;
    }
    if (els.clipGridContainer) {
      els.clipGridContainer.inert = isOpen;
    }
    if (els.toggleFavoritesDrawerBtn) {
      els.toggleFavoritesDrawerBtn.setAttribute('aria-expanded', String(isOpen));
    }
    if (isOpen) {
      renderFavoritesGrid();
      setTimeout(() => els.closeFavoritesDrawerBtn?.focus(), 40);
    } else if (els.favoritesDrawer.contains(document.activeElement)) {
      els.toggleFavoritesDrawerBtn?.focus();
    }
  }

  function toggleClipFavorite(clip) {
    if (!clip || !clip.id) return;
    const exists = isClipFavorited(clip.id);
    if (exists) {
      state.favoriteClips = (state.favoriteClips || []).filter((c) => c.id !== clip.id);
    } else {
      const entry = {
        ...clip,
        favorite: true,
        favoritedAt: new Date().toISOString()
      };
      state.favoriteClips = [entry, ...(state.favoriteClips || [])];
      if (!clip.isLocal && clip.url && clip.url.startsWith('/api/clips/stream') && window.projectBundleService?.cacheClipBlob) {
        fetch(clip.url)
          .then((r) => (r.ok ? r.blob() : null))
          .then((blob) => {
            if (!blob || blob.size === 0) return;
            return window.projectBundleService.cacheClipBlob(clip.id, blob, clip);
          })
          .catch(() => { });
      }
    }
    updateFavoritesCountUi();
    renderClipGrid();
    renderFavoritesGrid();
    persistCurrentProjectState().catch(() => { });
  }

  function normalizeClipStartTime(raw, maxDuration = null) {
    let sec = 0;
    if (typeof raw === 'number') {
      sec = Number.isFinite(raw) ? raw : 0;
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.includes(':')) {
        const parts = trimmed.split(':');
        const mins = parseFloat(parts[0]);
        const rem = parseFloat(parts.slice(1).join(':'));
        if (Number.isFinite(mins) && Number.isFinite(rem)) {
          sec = mins * 60 + rem;
        }
      } else if (trimmed !== '') {
        const parsed = parseFloat(trimmed);
        if (Number.isFinite(parsed)) sec = parsed;
      }
    }
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    if (Number.isFinite(maxDuration) && maxDuration > 0.1) {
      sec = Math.min(sec, Math.max(0, maxDuration - 0.1));
    }
    return Number(sec.toFixed(2));
  }

  function normalizeClipEndTime(rawVal, startSec = 0, maxDuration = null) {
    if (rawVal === undefined || rawVal === null || rawVal === '') return null;
    let sec = typeof rawVal === 'number' ? rawVal : parseFloat(String(rawVal).trim());
    if (!Number.isFinite(sec) || sec <= 0) return null;
    const minEnd = Number((Math.max(0, startSec) + 0.1).toFixed(2));
    if (sec < minEnd) sec = minEnd;
    if (Number.isFinite(maxDuration) && maxDuration > 0.2) {
      if (sec >= maxDuration - 0.05) return null;
      sec = Math.min(sec, maxDuration);
    }
    return Number(sec.toFixed(2));
  }

  function normalizeClipSpeedPct(rawVal) {
    const num = typeof rawVal === 'number' ? rawVal : parseFloat(String(rawVal ?? '').trim());
    if (!Number.isFinite(num) || num <= 0) return 100;
    return Math.round(Math.max(25, Math.min(400, num)));
  }

  function syncSelectedClipStartTimesLength() {
    const count = Math.min(MAX_PLAYLIST_SLOTS, (state.selectedClipIds || []).length);
    const prevStarts = Array.isArray(state.selectedClipStartTimes) ? state.selectedClipStartTimes : [];
    const prevEnds = Array.isArray(state.selectedClipEndTimes) ? state.selectedClipEndTimes : [];
    const prevSpeeds = Array.isArray(state.selectedClipSpeeds) ? state.selectedClipSpeeds : [];
    const nextStarts = new Array(count);
    const nextEnds = new Array(count);
    const nextSpeeds = new Array(count);
    for (let i = 0; i < count; i++) {
      const clip = findClipById(state.selectedClipIds[i]);
      const startVal = (prevStarts[i] !== undefined && prevStarts[i] !== null)
        ? normalizeClipStartTime(prevStarts[i])
        : normalizeClipStartTime(clip?.startTime ?? 0);
      nextStarts[i] = startVal;
      nextEnds[i] = prevEnds[i] !== undefined ? normalizeClipEndTime(prevEnds[i], startVal) : null;
      nextSpeeds[i] = prevSpeeds[i] !== undefined ? normalizeClipSpeedPct(prevSpeeds[i]) : 100;
    }
    state.selectedClipStartTimes = nextStarts;
    state.selectedClipEndTimes = nextEnds;
    state.selectedClipSpeeds = nextSpeeds;
  }

  function getActiveCutMode(tpl = visualizer) {
    return (
      tpl?.params?.cutMode ||
      tpl?.preset?.controlsBox?.values?.cutMode ||
      tpl?.modules?.clips?.defaultCutMode ||
      tpl?.preset?.modules?.clips?.defaultCutMode ||
      'chord'
    );
  }

  function snapshotCurrentPlaylist() {
    syncSelectedClipStartTimesLength();
    return {
      ids: (state.selectedClipIds || []).slice(0, MAX_PLAYLIST_SLOTS),
      startTimes: [...(state.selectedClipStartTimes || [])],
      endTimes: [...(state.selectedClipEndTimes || [])],
      speeds: [...(state.selectedClipSpeeds || [])]
    };
  }

  function applyPlaylistSnapshot(snap) {
    const ids = Array.isArray(snap?.ids) ? snap.ids.slice(0, MAX_PLAYLIST_SLOTS) : [];
    const starts = Array.isArray(snap?.startTimes) ? snap.startTimes : [];
    const ends = Array.isArray(snap?.endTimes) ? snap.endTimes : [];
    const speeds = Array.isArray(snap?.speeds) ? snap.speeds : [];
    state.selectedClipIds = [...ids];
    state.selectedClipStartTimes = ids.map((id, i) => (
      starts[i] !== undefined ? normalizeClipStartTime(starts[i]) : normalizeClipStartTime(findClipById(id)?.startTime ?? 0)
    ));
    state.selectedClipEndTimes = ids.map((_, i) => (
      ends[i] !== undefined ? normalizeClipEndTime(ends[i], state.selectedClipStartTimes[i]) : null
    ));
    state.selectedClipSpeeds = ids.map((_, i) => (
      speeds[i] !== undefined ? normalizeClipSpeedPct(speeds[i]) : 100
    ));
    syncSelectedClipStartTimesLength();
  }

  function savePlaylistForCutMode(mode = getActiveCutMode()) {
    if (!mode) return;
    if (!state.playlistsByCutMode || typeof state.playlistsByCutMode !== 'object') {
      state.playlistsByCutMode = {};
    }
    state.playlistsByCutMode[mode] = snapshotCurrentPlaylist();
    state._activeCutMode = mode;
  }

  function switchCutModePlaylist(prevMode, nextMode) {
    if (!nextMode) return;
    if (!state.playlistsByCutMode || typeof state.playlistsByCutMode !== 'object') {
      state.playlistsByCutMode = {};
    }
    const sourceMode = prevMode || state._activeCutMode;
    if (sourceMode && sourceMode !== nextMode) {
      state.playlistsByCutMode[sourceMode] = snapshotCurrentPlaylist();
    }
    const existing = state.playlistsByCutMode[nextMode];
    if (existing && Array.isArray(existing.ids)) {
      applyPlaylistSnapshot(existing);
      if (nextMode === 'single' && state.selectedClipIds.length > 1) {
        state.selectedClipIds = [state.selectedClipIds[0]];
        syncSelectedClipStartTimesLength();
        state.playlistsByCutMode[nextMode] = snapshotCurrentPlaylist();
      }
    } else {
      const seed = snapshotCurrentPlaylist();
      if (nextMode === 'single' && seed.ids.length > 1) {
        seed.ids = [seed.ids[0]];
        seed.startTimes = [seed.startTimes[0] ?? 0];
        seed.endTimes = [seed.endTimes[0] ?? null];
        seed.speeds = [seed.speeds[0] ?? 100];
      }
      applyPlaylistSnapshot(seed);
      state.playlistsByCutMode[nextMode] = snapshotCurrentPlaylist();
    }
    state._activeCutMode = nextMode;
  }

  function getNormalizedPlaylistsByCutMode() {
    savePlaylistForCutMode(getActiveCutMode());
    const out = {};
    for (const [mode, entry] of Object.entries(state.playlistsByCutMode || {})) {
      if (!entry || !Array.isArray(entry.ids)) continue;
      out[mode] = {
        ids: [...entry.ids],
        startTimes: [...(entry.startTimes || [])],
        endTimes: [...(entry.endTimes || [])],
        speeds: [...(entry.speeds || [])]
      };
    }
    return out;
  }

  function getVideoForPlaylistSlot(slotIdx, { prefetch = true } = {}) {
    if (slotIdx < 0 || slotIdx >= state.selectedClipIds.length) return null;
    const clipId = state.selectedClipIds[slotIdx];
    const clip = findClipById(clipId);
    if (!clip || !clip.url) return null;

    let v = videoPool.find((el) => el.dataset.clipUrl === clip.url);
    const isWarmupOnly = !prefetch;
    const wasNew = !v;
    if (!v) {
      let oldest = videoPool[0];
      for (const candidate of videoPool) {
        if (!candidate.dataset.clipUrl) {
          oldest = candidate;
          break;
        }
        if (candidate === state.lastActiveVid) continue;
        if (oldest === state.lastActiveVid || (candidate._lastUsedSeq || 0) < (oldest._lastUsedSeq || 0)) {
          oldest = candidate;
        }
      }
      v = oldest;
      if (!v.paused) v.pause();
      v.dataset.clipUrl = clip.url;
      v._retryCount = 0;
      if (clip.url.startsWith('blob:')) {
        v.removeAttribute('crossorigin');
      } else {
        v.crossOrigin = 'anonymous';
      }
      v.preload = 'auto';
      delete v._focalX;
      delete v._curFocalX;
      delete v._curFocalSrc;
      delete v._focalCache;
      v.src = clip.url;
      v.load();
    } else if (v.preload !== 'auto') {
      v.preload = 'auto';
    }

    if (!isWarmupOnly || wasNew) {
      const startSec = normalizeClipStartTime(
        state.selectedClipStartTimes[slotIdx] ?? clip.startTime ?? 0,
        Number.isFinite(v.duration) ? v.duration : null
      );
      const endSec = normalizeClipEndTime(
        state.selectedClipEndTimes[slotIdx],
        startSec,
        Number.isFinite(v.duration) ? v.duration : null
      );
      const speedPct = normalizeClipSpeedPct(state.selectedClipSpeeds[slotIdx]);
      v.dataset.startTime = String(startSec);
      v.dataset.endTime = endSec !== null ? String(endSec) : '';
      v.dataset.speedPct = String(speedPct);
      v.dataset.manualFocalX = clip.manualFocalX !== undefined ? clip.manualFocalX : '';
    }
    v._lastUsedSeq = ++_videoPoolUseSeq;

    if (prefetch && state.selectedClipIds.length > 1) {
      const total = Math.min(MAX_PLAYLIST_SLOTS, state.selectedClipIds.length);
      for (let offset = 1; offset <= 2 && offset < total; offset++) {
        const nextIdx = (slotIdx + offset) % total;
        getVideoForPlaylistSlot(nextIdx, { prefetch: false });
      }
    }
    return v;
  }

  function syncVideoPoolSources() {
    syncSelectedClipStartTimesLength();
    const slots = state.selectedClipIds
      .slice(0, MAX_PLAYLIST_SLOTS)
      .map((id, idx) => ({ clip: findClipById(id), idx }))
      .filter((entry) => entry.clip && entry.clip.url);

    if (slots.length === 0) {
      videoPool.forEach((v) => {
        if (!v.paused) v.pause();
        v.dataset.startTime = '';
        if (v.dataset.clipUrl) {
          v.removeAttribute('src');
          v.dataset.clipUrl = '';
          v.load();
        }
      });
    } else {
      const warmupEntries = [];
      const seenUrls = new Set();
      for (const entry of slots) {
        if (seenUrls.has(entry.clip.url)) continue;
        seenUrls.add(entry.clip.url);
        warmupEntries.push(entry);
        if (warmupEntries.length >= VIDEO_POOL_SIZE) break;
      }

      const warmUrls = new Set(warmupEntries.map((e) => e.clip.url));
      const freeEls = [];
      videoPool.forEach((v) => {
        if (!v.dataset.clipUrl || !warmUrls.has(v.dataset.clipUrl)) {
          freeEls.push(v);
        }
      });

      warmupEntries.forEach(({ clip, idx }, warmIdx) => {
        let v = videoPool.find((el) => el.dataset.clipUrl === clip.url);
        if (!v) {
          v = freeEls.shift() || videoPool[0];
          if (!v.paused) v.pause();
          v.dataset.clipUrl = clip.url;
          v._retryCount = 0;
          if (clip.url.startsWith('blob:')) {
            v.removeAttribute('crossorigin');
          } else {
            v.crossOrigin = 'anonymous';
          }
          v.preload = warmIdx < 6 ? 'auto' : 'metadata';
          delete v._focalX;
          delete v._curFocalX;
          delete v._curFocalSrc;
          delete v._focalCache;
          v.src = clip.url;
          v.load();
        }
        const startSec = normalizeClipStartTime(
          state.selectedClipStartTimes[idx] ?? clip.startTime ?? 0,
          Number.isFinite(v.duration) ? v.duration : null
        );
        const endSec = normalizeClipEndTime(
          state.selectedClipEndTimes[idx],
          startSec,
          Number.isFinite(v.duration) ? v.duration : null
        );
        const speedPct = normalizeClipSpeedPct(state.selectedClipSpeeds[idx]);
        const prevStartAttr = v.dataset.startTime;
        v.dataset.startTime = String(startSec);
        v.dataset.endTime = endSec !== null ? String(endSec) : '';
        v.dataset.speedPct = String(speedPct);
        v.dataset.manualFocalX = clip.manualFocalX !== undefined ? clip.manualFocalX : '';
        v._lastUsedSeq = ++_videoPoolUseSeq;
        if (!state.isPlaying && prevStartAttr !== String(startSec) && v.readyState >= 1) {
          const target = getClipTimeForTimestamp(state.currentTime, v);
          if (Number.isFinite(target) && Math.abs((v.currentTime || 0) - target) > 0.05) {
            try { v.currentTime = target; } catch { }
          }
        }
      });

      freeEls.forEach((v) => {
        if (!v.paused) v.pause();
        v.dataset.startTime = '';
        if (v.dataset.clipUrl) {
          v.removeAttribute('src');
          v.dataset.clipUrl = '';
          v.load();
        }
      });
    }

    if (visualizer && typeof visualizer.setActiveVideos === 'function') {
      const activeSlice = slots.length > 0
        ? slots.slice(0, VIDEO_POOL_SIZE).map(({ clip }) => videoPool.find((el) => el.dataset.clipUrl === clip.url)).filter(Boolean)
        : videoPool;
      visualizer.setActiveVideos(activeSlice);
    }
    renderPlaylistStrip();
    if (els.playlistEditorDialog?.open) {
      renderPlaylistEditorGrid();
    }
    scheduleClipBlobCache();
  }

  function getProjectDropTime() {
    const p = state.project;
    if (!p) return 15.0;
    return (typeof p.dropTime === 'number' && !isNaN(p.dropTime))
      ? p.dropTime
      : ((p.duration || 30.0) * 0.5);
  }

  function getActivePlaylistSlotForTime(t) {
    if (!state.project || state.selectedClipIds.length === 0) return -1;
    const dropTime = getProjectDropTime();
    const startAtDrop = visualizer?.modules?.clips?.startAtDrop === true || visualizer?.id === 'constellations';
    if (startAtDrop && t < dropTime) return -1;
    const anchor = startAtDrop ? dropTime : 0;

    const cutMode = visualizer?.params?.cutMode || 'chord';
    if (cutMode === 'single' || state.selectedClipIds.length === 1) {
      return 0;
    }

    const activeCount = Math.max(1, Math.min(MAX_PLAYLIST_SLOTS, state.selectedClipIds.length));
    if (window.motionKit?.resolveCutInterval) {
      const interval = window.motionKit.resolveCutInterval(t, state.project, cutMode, startAtDrop);
      return Math.max(0, interval.index) % activeCount;
    }
    if (cutMode === 'chord') {
      const cuts = state.project.chordCutTimes || [];
      let cutIdx = 0;
      for (let i = 0; i < cuts.length; i++) {
        if (t >= cuts[i]) cutIdx = i;
        else break;
      }
      return cutIdx % activeCount;
    }
    if (cutMode === 'impact') {
      const cuts = (state.project.impactTimes || []).filter((c) => c > anchor + 0.05);
      let cutIdx = 0;
      for (let i = 0; i < cuts.length; i++) {
        if (t >= cuts[i]) cutIdx = i + 1;
        else break;
      }
      return cutIdx % activeCount;
    }
    const secPerBar = (60 / (state.project.bpm || 120)) * 4;
    const barsPerCut = cutMode === '2bar' ? 2 : 4;
    const cutLenSec = secPerBar * barsPerCut;
    const cutIdx = Math.floor(Math.max(0, t - anchor) / cutLenSec);
    return cutIdx % activeCount;
  }

  function getActiveVideoForTime(t) {
    const slotIdx = getActivePlaylistSlotForTime(t);
    return slotIdx >= 0 ? getVideoForPlaylistSlot(slotIdx) : null;
  }

  function updateActivePlaylistSlotHighlight(slotIdx) {
    if (state._activePlaylistSlot === slotIdx) return;
    state._activePlaylistSlot = slotIdx;
    if (!els.clipPlaylistTrack) return;
    els.clipPlaylistTrack.querySelectorAll('.playlist-slot-card').forEach((card, idx) => {
      card.classList.toggle('is-playing', idx === slotIdx);
    });
  }

  function updatePlaylistCountUi() {
    const count = Math.min(MAX_PLAYLIST_SLOTS, (state.selectedClipIds || []).length);
    const label = `${count} ${count === 1 ? 'clip' : 'clips'}`;
    if (els.playlistCountBadge) els.playlistCountBadge.textContent = String(count);
    if (els.clipPlaylistLimitLabel) els.clipPlaylistLimitLabel.textContent = label;
    if (els.playlistEditorCountLabel) els.playlistEditorCountLabel.textContent = label;
    if (els.openPlaylistEditorBtn) els.openPlaylistEditorBtn.disabled = count === 0;
    if (els.clearPlaylistBtn) els.clearPlaylistBtn.disabled = count === 0;
  }

  function setPlaylistStripOpen(open, { user = false } = {}) {
    if (!els.clipPlaylistStrip) return;
    const isOpen = Boolean(open);
    state._playlistStripOpen = isOpen;
    if (user) {
      state._playlistStripUserCollapsed = !isOpen;
    }
    els.clipPlaylistStrip.hidden = !isOpen;
    if (els.togglePlaylistStripBtn) {
      els.togglePlaylistStripBtn.setAttribute('aria-expanded', String(isOpen));
    }
    if (isOpen) {
      renderPlaylistStrip();
    }
  }

  function commitPlaylistMutation({ dirty = true, persist = true } = {}) {
    savePlaylistForCutMode(getActiveCutMode());
    syncVideoPoolSources();
    renderClipGrid();
    renderFavoritesGrid();
    if (!state.isPlaying) {
      const activeSlot = getActivePlaylistSlotForTime(state.currentTime);
      const activeVid = activeSlot >= 0 ? getVideoForPlaylistSlot(activeSlot) : null;
      updateActivePlaylistSlotHighlight(activeSlot);
      visualizer?.renderFrame?.(state.currentTime, activeVid);
    }
    if (persist) persistCurrentProjectState().catch(() => { });
    if (dirty) markProjectDirty();
  }

  function focusPlaylistSlot(idx) {
    if (!els.clipPlaylistTrack) return;
    const cards = els.clipPlaylistTrack.querySelectorAll('.playlist-slot-card');
    const clamped = Math.max(0, Math.min(cards.length - 1, idx));
    if (cards[clamped]) cards[clamped].focus();
  }

  function removePlaylistSlot(slotIdx) {
    if (slotIdx < 0 || slotIdx >= state.selectedClipIds.length) return;
    syncSelectedClipStartTimesLength();
    const next = [...state.selectedClipIds];
    next.splice(slotIdx, 1);
    const nextStarts = [...state.selectedClipStartTimes];
    nextStarts.splice(slotIdx, 1);
    const nextEnds = [...state.selectedClipEndTimes];
    nextEnds.splice(slotIdx, 1);
    const nextSpeeds = [...state.selectedClipSpeeds];
    nextSpeeds.splice(slotIdx, 1);
    state.selectedClipIds = next;
    state.selectedClipStartTimes = nextStarts;
    state.selectedClipEndTimes = nextEnds;
    state.selectedClipSpeeds = nextSpeeds;
    commitPlaylistMutation();
    if (next.length > 0) {
      focusPlaylistSlot(slotIdx);
    } else if (els.clearPlaylistBtn && !els.clearPlaylistBtn.disabled) {
      els.clearPlaylistBtn.focus();
    } else {
      els.togglePlaylistStripBtn?.focus();
    }
  }

  function movePlaylistSlot(fromIdx, toIdx) {
    const len = state.selectedClipIds.length;
    if (fromIdx < 0 || fromIdx >= len || toIdx < 0 || toIdx >= len || fromIdx === toIdx) return;
    syncSelectedClipStartTimesLength();
    const next = [...state.selectedClipIds];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    const nextStarts = [...state.selectedClipStartTimes];
    const [movedStart] = nextStarts.splice(fromIdx, 1);
    nextStarts.splice(toIdx, 0, movedStart);
    const nextEnds = [...state.selectedClipEndTimes];
    const [movedEnd] = nextEnds.splice(fromIdx, 1);
    nextEnds.splice(toIdx, 0, movedEnd);
    const nextSpeeds = [...state.selectedClipSpeeds];
    const [movedSpeed] = nextSpeeds.splice(fromIdx, 1);
    nextSpeeds.splice(toIdx, 0, movedSpeed);
    state.selectedClipIds = next;
    state.selectedClipStartTimes = nextStarts;
    state.selectedClipEndTimes = nextEnds;
    state.selectedClipSpeeds = nextSpeeds;
    commitPlaylistMutation();
  }

  function setPlaylistSlotTiming(slotIdx, patch = {}, { renderStrip = false, dirty = true, persist = true } = {}) {
    if (slotIdx < 0 || slotIdx >= state.selectedClipIds.length) return { startTime: 0, endTime: null, speedPct: 100 };
    syncSelectedClipStartTimesLength();
    const clipId = state.selectedClipIds[slotIdx];
    const clip = findClipById(clipId);
    const slotVid = clip?.url ? videoPool.find((v) => v.dataset.clipUrl === clip.url) : null;
    const editorVid = (slotIdx === _editorSlotIdx && els.playlistEditorVideo?.src) ? els.playlistEditorVideo : null;
    const maxDur = (slotVid && Number.isFinite(slotVid.duration))
      ? slotVid.duration
      : ((editorVid && Number.isFinite(editorVid.duration)) ? editorVid.duration : null);

    const nextStart = patch.startTime !== undefined
      ? normalizeClipStartTime(patch.startTime, maxDur)
      : state.selectedClipStartTimes[slotIdx];
    let nextEnd = patch.endTime !== undefined
      ? normalizeClipEndTime(patch.endTime, nextStart, maxDur)
      : state.selectedClipEndTimes[slotIdx];
    if (nextEnd !== null && nextEnd < nextStart + 0.1) {
      nextEnd = normalizeClipEndTime(nextStart + 0.1, nextStart, maxDur);
    }
    const nextSpeed = patch.speedPct !== undefined
      ? normalizeClipSpeedPct(patch.speedPct)
      : state.selectedClipSpeeds[slotIdx];

    state.selectedClipStartTimes[slotIdx] = nextStart;
    state.selectedClipEndTimes[slotIdx] = nextEnd;
    state.selectedClipSpeeds[slotIdx] = nextSpeed;

    if (clip) clip.startTime = nextStart;
    const inFavs = (state.favoriteClips || []).find((c) => c.id === clipId);
    if (inFavs) inFavs.startTime = nextStart;

    if (slotVid) {
      slotVid.dataset.startTime = String(nextStart);
      slotVid.dataset.endTime = nextEnd !== null ? String(nextEnd) : '';
      slotVid.dataset.speedPct = String(nextSpeed);
      if (!state.isPlaying) {
        const target = getClipTimeForTimestamp(state.currentTime, slotVid);
        const activeVid = getActiveVideoForTime(state.currentTime);
        if (Number.isFinite(target) && slotVid.readyState >= 1) {
          const redrawOnSeek = () => {
            if (!state.isPlaying && activeVid === slotVid) {
              visualizer?.renderFrame?.(state.currentTime, activeVid);
            }
          };
          slotVid.addEventListener('seeked', redrawOnSeek, { once: true });
          try { slotVid.currentTime = target; } catch { }
        }
        if (activeVid === slotVid) {
          visualizer?.renderFrame?.(state.currentTime, activeVid);
        }
      }
    }

    if (renderStrip) renderPlaylistStrip();
    if (els.playlistEditorDialog?.open) {
      updatePlaylistEditorTimeTag(slotIdx, nextStart, nextEnd, nextSpeed);
    }
    if (persist) persistCurrentProjectState().catch(() => { });
    if (dirty) markProjectDirty();
    return { startTime: nextStart, endTime: nextEnd, speedPct: nextSpeed };
  }

  function setPlaylistSlotStartTime(slotIdx, rawVal, opts = {}) {
    return setPlaylistSlotTiming(slotIdx, { startTime: rawVal }, opts).startTime;
  }

  function formatSlotTimingBadge(startSec, endSec, speedPct) {
    const parts = [];
    if (startSec > 0.05 || endSec !== null) {
      parts.push(endSec !== null ? `${startSec.toFixed(1)}-${endSec.toFixed(1)}s` : `${startSec.toFixed(1)}s`);
    }
    if (speedPct !== 100) {
      parts.push(`${speedPct}%`);
    }
    return parts.join(' · ');
  }

  function renderPlaylistStrip() {
    updatePlaylistCountUi();
    syncSelectedClipStartTimesLength();
    if (!els.clipPlaylistTrack) return;
    els.clipPlaylistTrack.innerHTML = '';
    const ids = (state.selectedClipIds || []).slice(0, MAX_PLAYLIST_SLOTS);
    const activeSlot = getActivePlaylistSlotForTime(state.currentTime);
    state._activePlaylistSlot = activeSlot;

    ids.forEach((clipId, slotIdx) => {
      const clip = findClipById(clipId);
      const slotStart = normalizeClipStartTime(state.selectedClipStartTimes[slotIdx] ?? clip?.startTime ?? 0);
      const slotEnd = state.selectedClipEndTimes[slotIdx] ?? null;
      const slotSpeed = normalizeClipSpeedPct(state.selectedClipSpeeds[slotIdx]);
      const card = document.createElement('div');
      card.className = `playlist-slot-card${slotIdx === activeSlot ? ' is-playing' : ''}`;
      card.setAttribute('role', 'listitem');
      card.tabIndex = 0;
      card.draggable = true;
      card.dataset.slotIdx = String(slotIdx);
      const safeTitle = String(clip?.title || clipId || `slot ${slotIdx + 1}`);
      card.title = `${slotIdx + 1}: ${safeTitle} (in ${slotStart.toFixed(1)}s${slotEnd !== null ? ` · out ${slotEnd.toFixed(1)}s` : ''} · ${slotSpeed}% · click to trim & edit)`;

      const badge = document.createElement('span');
      badge.className = 'playlist-slot-idx';
      badge.textContent = String(slotIdx + 1);

      const mediaEl = document.createElement('video');
      mediaEl.muted = true;
      mediaEl.playsInline = true;
      mediaEl.preload = 'metadata';
      if (clip?.url) {
        mediaEl.src = formatClipThumbSrc(clip.url, slotStart);
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'playlist-slot-remove';
      removeBtn.setAttribute('aria-label', `remove slot ${slotIdx + 1}`);
      removeBtn.title = `remove slot ${slotIdx + 1}`;
      removeBtn.innerHTML = '&times;';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removePlaylistSlot(slotIdx);
      });

      const timeTag = document.createElement('span');
      timeTag.className = 'playlist-slot-time-tag';
      const badgeText = formatSlotTimingBadge(slotStart, slotEnd, slotSpeed);
      timeTag.textContent = badgeText;
      timeTag.hidden = !badgeText;

      card.addEventListener('click', () => {
        openPlaylistEditor(slotIdx);
      });

      card.addEventListener('dragstart', (e) => {
        if (!e.dataTransfer) return;
        card.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('application/x-samplevis-playlist-slot', String(slotIdx));
        if (clip) {
          e.dataTransfer.setData('application/x-samplevis-clip', JSON.stringify({
            id: clip.id,
            title: clip.title,
            url: clip.url,
            remoteUrl: clip.remoteUrl || null
          }));
        }
      });

      card.addEventListener('dragend', () => {
        card.classList.remove('is-dragging');
        clearPlaylistDropIndicators();
      });

      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openPlaylistEditor(slotIdx);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          removePlaylistSlot(slotIdx);
        } else if (e.key === 'ArrowLeft' && slotIdx > 0) {
          e.preventDefault();
          movePlaylistSlot(slotIdx, slotIdx - 1);
          focusPlaylistSlot(slotIdx - 1);
        } else if (e.key === 'ArrowRight' && slotIdx < ids.length - 1) {
          e.preventDefault();
          movePlaylistSlot(slotIdx, slotIdx + 1);
          focusPlaylistSlot(slotIdx + 1);
        }
      });

      card.append(mediaEl, badge, removeBtn, timeTag);
      els.clipPlaylistTrack.appendChild(card);
    });
  }

  let _editorSlotIdx = 0;

  function updatePlaylistEditorTimeTag(slotIdx, startSec, endSec = null, speedPct = 100) {
    if (!els.playlistEditorGrid) return;
    const item = els.playlistEditorGrid.querySelector(`.playlist-editor-item[data-slot-idx="${slotIdx}"]`);
    const tag = item?.querySelector('.playlist-slot-time-tag');
    if (tag) {
      const text = formatSlotTimingBadge(startSec, endSec, speedPct);
      tag.textContent = text;
      tag.hidden = !text;
    }
    if (slotIdx === _editorSlotIdx) {
      if (els.playlistEditorStartInput) els.playlistEditorStartInput.value = startSec.toFixed(1);
      if (els.playlistEditorEndInput) {
        const dur = els.playlistEditorVideo?.duration;
        const shownEnd = endSec !== null ? endSec : (Number.isFinite(dur) ? dur : 0);
        els.playlistEditorEndInput.value = shownEnd.toFixed(1);
      }
      if (els.playlistEditorSpeedInput) els.playlistEditorSpeedInput.value = String(speedPct);
      if (els.playlistEditorVideo) {
        els.playlistEditorVideo.playbackRate = Math.max(0.25, Math.min(4.0, speedPct / 100));
      }
      syncPlaylistEditorTimeline();
    }
  }

  function syncPlaylistEditorTimeline() {
    const vid = els.playlistEditorVideo;
    const dur = vid && Number.isFinite(vid.duration) ? vid.duration : 0;
    const slotStart = _editorSlotIdx >= 0 ? normalizeClipStartTime(state.selectedClipStartTimes[_editorSlotIdx] ?? 0, dur || null) : 0;
    const rawEnd = _editorSlotIdx >= 0 ? state.selectedClipEndTimes[_editorSlotIdx] : null;
    const slotEnd = (rawEnd !== null && rawEnd !== undefined && dur > 0) ? Math.min(dur, rawEnd) : dur;

    const startPct = dur > 0.05 ? Math.max(0, Math.min(100, (slotStart / dur) * 100)) : 0;
    const endPct = dur > 0.05 ? Math.max(startPct, Math.min(100, (slotEnd / dur) * 100)) : 100;

    if (els.playlistEditorTrimRegion) {
      els.playlistEditorTrimRegion.style.left = `${startPct}%`;
      els.playlistEditorTrimRegion.style.right = `${Math.max(0, 100 - endPct)}%`;
    }
    if (els.playlistEditorInHandle) {
      els.playlistEditorInHandle.style.left = `${startPct}%`;
    }
    if (els.playlistEditorOutHandle) {
      els.playlistEditorOutHandle.style.left = `${endPct}%`;
    }
  }

  function syncPlaylistEditorScrubUi(overrideTime = null) {
    const vid = els.playlistEditorVideo;
    if (!vid) return;
    const cur = Number.isFinite(overrideTime)
      ? Math.max(0, overrideTime)
      : (Number.isFinite(vid.currentTime) ? vid.currentTime : 0);
    const dur = Number.isFinite(vid.duration) ? vid.duration : 0;
    if (els.playlistEditorPlayhead) {
      const pct = dur > 0.05 ? Math.max(0, Math.min(100, (cur / dur) * 100)) : 0;
      els.playlistEditorPlayhead.style.left = `${pct}%`;
    }
    if (els.playlistEditorTimeReadout) {
      els.playlistEditorTimeReadout.textContent = `${cur.toFixed(2)}s / ${dur.toFixed(2)}s`;
    }
    if (els.playlistEditorPlayBtn) {
      els.playlistEditorPlayBtn.textContent = vid.paused ? 'play' : 'pause';
    }
  }

  function loadPlaylistEditorSlot(slotIdx) {
    const len = state.selectedClipIds.length;
    if (len === 0) {
      _editorSlotIdx = -1;
      if (els.playlistEditorVideo) {
        els.playlistEditorVideo.pause();
        els.playlistEditorVideo.removeAttribute('src');
        els.playlistEditorVideo.dataset.clipUrl = '';
        els.playlistEditorVideo.load();
      }
      if (els.playlistEditorEmpty) els.playlistEditorEmpty.hidden = false;
      if (els.playlistEditorSlotMeta) els.playlistEditorSlotMeta.textContent = 'empty';
      syncPlaylistEditorTimeline();
      syncPlaylistEditorScrubUi();
      return;
    }

    _editorSlotIdx = Math.max(0, Math.min(len - 1, slotIdx));
    const clipId = state.selectedClipIds[_editorSlotIdx];
    const clip = findClipById(clipId);
    const slotStart = normalizeClipStartTime(state.selectedClipStartTimes[_editorSlotIdx] ?? clip?.startTime ?? 0);
    const slotEnd = state.selectedClipEndTimes[_editorSlotIdx] ?? null;
    const slotSpeed = normalizeClipSpeedPct(state.selectedClipSpeeds[_editorSlotIdx]);
    const safeTitle = String(clip?.title || clipId || `slot ${_editorSlotIdx + 1}`);

    if (els.playlistEditorSlotMeta) {
      els.playlistEditorSlotMeta.textContent = `slot ${_editorSlotIdx + 1} · ${safeTitle}`;
    }
    if (els.playlistEditorStartInput) {
      els.playlistEditorStartInput.value = slotStart.toFixed(1);
    }
    if (els.playlistEditorSpeedInput) {
      els.playlistEditorSpeedInput.value = String(slotSpeed);
    }

    const vid = els.playlistEditorVideo;
    if (vid && clip?.url) {
      if (els.playlistEditorEmpty) els.playlistEditorEmpty.hidden = true;
      vid.pause();
      vid.playbackRate = Math.max(0.25, Math.min(4.0, slotSpeed / 100));
      // isolate /api/clips/stream cache key from videoPool to avoid same-url http cache locks
      const editorSrc = clip.url.startsWith('/api/clips/stream')
        ? `${clip.url}${clip.url.includes('?') ? '&' : '?'}role=editor`
        : clip.url;
      if (vid.dataset.clipUrl !== clip.url || vid.error || vid.readyState === 0) {
        vid.dataset.clipUrl = clip.url;
        vid.dataset.editorSrc = editorSrc;
        vid.dataset.pendingSeek = String(slotStart);
        vid._retryCount = 0;
        if (clip.url.startsWith('blob:')) {
          vid.removeAttribute('crossorigin');
        } else {
          vid.crossOrigin = 'anonymous';
        }
        vid.src = editorSrc;
        vid.load();
      } else if (vid.readyState >= 1) {
        const clamped = normalizeClipStartTime(slotStart, vid.duration);
        try { vid.currentTime = clamped; } catch { }
        if (els.playlistEditorEndInput) {
          const shownEnd = slotEnd !== null ? Math.min(vid.duration, slotEnd) : vid.duration;
          els.playlistEditorEndInput.value = shownEnd.toFixed(1);
        }
        syncPlaylistEditorTimeline();
        syncPlaylistEditorScrubUi();
      }
    } else if (els.playlistEditorEmpty) {
      els.playlistEditorEmpty.hidden = false;
    }

    if (els.playlistEditorGrid) {
      els.playlistEditorGrid.querySelectorAll('.playlist-editor-item').forEach((el, idx) => {
        el.classList.toggle('is-editing', idx === _editorSlotIdx);
      });
    }
  }

  function renderPlaylistEditorGrid() {
    updatePlaylistCountUi();
    if (!els.playlistEditorGrid) return;
    els.playlistEditorGrid.innerHTML = '';
    const ids = (state.selectedClipIds || []).slice(0, MAX_PLAYLIST_SLOTS);

    ids.forEach((clipId, slotIdx) => {
      const clip = findClipById(clipId);
      const slotStart = normalizeClipStartTime(state.selectedClipStartTimes[slotIdx] ?? clip?.startTime ?? 0);
      const slotEnd = state.selectedClipEndTimes[slotIdx] ?? null;
      const slotSpeed = normalizeClipSpeedPct(state.selectedClipSpeeds[slotIdx]);
      const item = document.createElement('div');
      item.className = `playlist-editor-item${slotIdx === _editorSlotIdx ? ' is-editing' : ''}`;
      item.setAttribute('role', 'listitem');
      item.tabIndex = 0;
      item.draggable = true;
      item.dataset.slotIdx = String(slotIdx);
      const safeTitle = String(clip?.title || clipId || `slot ${slotIdx + 1}`);
      item.title = `${slotIdx + 1}: ${safeTitle} (in ${slotStart.toFixed(1)}s${slotEnd !== null ? ` · out ${slotEnd.toFixed(1)}s` : ''} · ${slotSpeed}%)`;

      const badge = document.createElement('span');
      badge.className = 'playlist-slot-idx';
      badge.textContent = String(slotIdx + 1);

      const mediaEl = document.createElement('video');
      mediaEl.muted = true;
      mediaEl.playsInline = true;
      mediaEl.preload = 'metadata';
      if (clip?.url) {
        mediaEl.src = formatClipThumbSrc(clip.url, slotStart);
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'playlist-slot-remove';
      removeBtn.setAttribute('aria-label', `remove slot ${slotIdx + 1}`);
      removeBtn.title = `remove slot ${slotIdx + 1}`;
      removeBtn.innerHTML = '&times;';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (slotIdx < _editorSlotIdx) _editorSlotIdx -= 1;
        else if (slotIdx === _editorSlotIdx && _editorSlotIdx >= ids.length - 1) {
          _editorSlotIdx = Math.max(0, ids.length - 2);
        }
        removePlaylistSlot(slotIdx);
        loadPlaylistEditorSlot(_editorSlotIdx);
      });

      const timeTag = document.createElement('span');
      timeTag.className = 'playlist-slot-time-tag';
      const badgeText = formatSlotTimingBadge(slotStart, slotEnd, slotSpeed);
      timeTag.textContent = badgeText;
      timeTag.hidden = !badgeText;

      item.addEventListener('click', () => {
        loadPlaylistEditorSlot(slotIdx);
      });

      item.addEventListener('dragstart', (e) => {
        if (!e.dataTransfer) return;
        item.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-samplevis-editor-slot', String(slotIdx));
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('is-dragging');
        els.playlistEditorGrid?.querySelectorAll('.drag-over-before, .drag-over-after').forEach((el) => {
          el.classList.remove('drag-over-before', 'drag-over-after');
        });
      });

      item.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types?.includes('application/x-samplevis-editor-slot')) return;
        e.preventDefault();
        const rect = item.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        item.classList.toggle('drag-over-before', before);
        item.classList.toggle('drag-over-after', !before);
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over-before', 'drag-over-after');
      });

      item.addEventListener('drop', (e) => {
        const raw = e.dataTransfer?.getData('application/x-samplevis-editor-slot');
        item.classList.remove('drag-over-before', 'drag-over-after');
        if (raw === '' || raw === undefined) return;
        e.preventDefault();
        const fromIdx = parseInt(raw, 10);
        if (!Number.isFinite(fromIdx) || fromIdx < 0 || fromIdx >= state.selectedClipIds.length) return;
        const rect = item.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        const insertIdx = before ? slotIdx : slotIdx + 1;
        const targetIdx = Math.max(0, Math.min(state.selectedClipIds.length - 1, fromIdx < insertIdx ? insertIdx - 1 : insertIdx));
        if (_editorSlotIdx === fromIdx) {
          _editorSlotIdx = targetIdx;
        } else if (fromIdx < _editorSlotIdx && targetIdx >= _editorSlotIdx) {
          _editorSlotIdx -= 1;
        } else if (fromIdx > _editorSlotIdx && targetIdx <= _editorSlotIdx) {
          _editorSlotIdx += 1;
        }
        movePlaylistSlot(fromIdx, targetIdx);
        loadPlaylistEditorSlot(_editorSlotIdx);
      });

      item.addEventListener('keydown', (e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          removeBtn.click();
        } else if (e.key === 'ArrowLeft' && slotIdx > 0) {
          e.preventDefault();
          if (_editorSlotIdx === slotIdx) _editorSlotIdx = slotIdx - 1;
          movePlaylistSlot(slotIdx, slotIdx - 1);
          els.playlistEditorGrid?.querySelectorAll('.playlist-editor-item')[slotIdx - 1]?.focus();
        } else if (e.key === 'ArrowRight' && slotIdx < ids.length - 1) {
          e.preventDefault();
          if (_editorSlotIdx === slotIdx) _editorSlotIdx = slotIdx + 1;
          movePlaylistSlot(slotIdx, slotIdx + 1);
          els.playlistEditorGrid?.querySelectorAll('.playlist-editor-item')[slotIdx + 1]?.focus();
        }
      });

      item.append(mediaEl, badge, removeBtn, timeTag);
      els.playlistEditorGrid.appendChild(item);
    });
  }

  function openPlaylistEditor(slotIdx = 0) {
    if (!els.playlistEditorDialog) return;
    if ((state.selectedClipIds || []).length === 0) return;
    _editorSlotIdx = Math.max(0, Math.min(state.selectedClipIds.length - 1, slotIdx));
    renderPlaylistEditorGrid();
    if (!els.playlistEditorDialog.open) {
      els.playlistEditorDialog.showModal();
    }
    loadPlaylistEditorSlot(_editorSlotIdx);
  }

  function clearPlaylistDropIndicators() {
    if (!els.clipPlaylistTrack) return;
    els.clipPlaylistTrack.classList.remove('drag-over-end');
    els.clipPlaylistTrack.querySelectorAll('.drag-over-before, .drag-over-after').forEach((el) => {
      el.classList.remove('drag-over-before', 'drag-over-after');
    });
  }

  function resolvePlaylistDropIndex(clientX) {
    if (!els.clipPlaylistTrack) return 0;
    const cards = Array.from(els.clipPlaylistTrack.querySelectorAll('.playlist-slot-card'));
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        return { insertIdx: i, targetCard: cards[i], side: 'before' };
      }
    }
    return { insertIdx: cards.length, targetCard: cards[cards.length - 1] || null, side: 'after' };
  }

  function getCutStartTimeForTimestamp(t) {
    if (!state.project) return 0;
    const dropTime = getProjectDropTime();
    const startAtDrop = visualizer?.modules?.clips?.startAtDrop === true || visualizer?.id === 'constellations';
    if (startAtDrop && t < dropTime) return 0;
    const anchor = startAtDrop ? dropTime : 0;

    const cutMode = visualizer?.params?.cutMode || 'chord';
    if (window.motionKit?.resolveCutInterval) {
      return window.motionKit.resolveCutInterval(t, state.project, cutMode, startAtDrop).start;
    }
    let cutStartTime = anchor;

    if (cutMode === 'chord') {
      const cuts = state.project.chordCutTimes || [];
      for (let i = 0; i < cuts.length; i++) {
        if (t >= cuts[i]) cutStartTime = cuts[i];
        else break;
      }
    } else if (cutMode === 'impact') {
      const cuts = (state.project.impactTimes || []).filter((c) => c > anchor + 0.05);
      for (let i = 0; i < cuts.length; i++) {
        if (t >= cuts[i]) cutStartTime = cuts[i];
        else break;
      }
    } else if (cutMode === '2bar' || cutMode === '4bar') {
      const secPerBar = (60 / (state.project.bpm || 120)) * 4;
      const barsPerCut = cutMode === '2bar' ? 2 : 4;
      const cutLenSec = secPerBar * barsPerCut;
      const cutIdx = Math.floor(Math.max(0, t - anchor) / cutLenSec);
      cutStartTime = anchor + cutIdx * cutLenSec;
    }

    return cutStartTime;
  }

  function getClipTimeForTimestamp(t, activeVid) {
    if (!state.project || !activeVid) return 0;
    const dropTime = getProjectDropTime();
    const startAtDrop = visualizer?.modules?.clips?.startAtDrop === true || visualizer?.id === 'constellations';
    if (startAtDrop && t < dropTime) return 0;

    const dur = activeVid.duration || 6.0;
    const startOffset = normalizeClipStartTime(activeVid.dataset?.startTime || 0, dur);
    const rawEnd = parseFloat(activeVid.dataset?.endTime || '');
    const endOffset = (Number.isFinite(rawEnd) && rawEnd > startOffset + 0.1) ? Math.min(dur, rawEnd) : dur;
    const span = Math.max(0.1, endOffset - startOffset);
    const speedPct = normalizeClipSpeedPct(activeVid.dataset?.speedPct || 100);
    const speedMult = speedPct / 100;

    if (visualizer?.params?.speedRamping && typeof visualizer.getSpeedRampInfo === 'function') {
      const ramp = visualizer.getSpeedRampInfo(t);
      return startOffset + ((ramp.clipTime * speedMult) % span);
    }

    const cutStartTime = getCutStartTimeForTimestamp(t);
    const elapsedInCut = Math.max(0, t - cutStartTime) * speedMult;
    return startOffset + (elapsedInCut % span);
  }

  function renderTrackList() {
    els.trackListContainer.innerHTML = '';
    const tracks = state.project?.tracks || [];
    els.midiSourceBadge.textContent = (state.project?.sourceType || 'midi').toLowerCase();

    tracks.forEach((tr) => {
      const isChecked = visualizer?.selectedTrackIds ? visualizer.selectedTrackIds.has(tr.id) : Boolean(tr.defaultSelected);
      const spanInfo = window.loopUtils?.getTrackSpanInfo
        ? window.loopUtils.getTrackSpanInfo(tr, state.project)
        : { canLoop: false };
      const loopActive = window.loopUtils?.isTrackLoopEnabled
        ? window.loopUtils.isTrackLoopEnabled(tr, state.project)
        : false;
      const loopBtnHtml = spanInfo.canLoop
        ? `<button type="button" class="track-loop-btn${loopActive ? ' active' : ''}" data-track-loop="${tr.id}" aria-pressed="${loopActive}" title="loop this pattern across remaining bars">loop</button>`
        : '';

      const row = document.createElement('div');
      row.className = `track-item${isChecked ? ' active' : ''}`;
      row.innerHTML = `
        <div class="track-item-left">
          <input type="checkbox" ${isChecked ? 'checked' : ''} data-track-id="${tr.id}" />
          <span class="track-name">${tr.name}</span>
        </div>
        <div class="track-item-right">
          ${loopBtnHtml}
          <span class="track-meta">${tr.noteCount}n · b${tr.startBar}–${tr.endBar}</span>
        </div>
      `;

      const loopBtn = row.querySelector('.track-loop-btn');
      if (loopBtn) {
        loopBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const nextLoop = !window.loopUtils?.isTrackLoopEnabled?.(tr, state.project);
          tr.loopMidi = nextLoop;
          if (nextLoop && visualizer?.selectedTrackIds && !visualizer.selectedTrackIds.has(tr.id)) {
            visualizer.toggleTrack?.(tr.id, true);
          } else {
            visualizer?.rebuildNoteNodes?.();
          }
          renderTrackList();
          const activeVid = getActiveVideoForTime(state.currentTime);
          visualizer?.renderFrame?.(state.currentTime, activeVid);
          markProjectDirty();
        });
      }

      row.addEventListener('click', (e) => {
        if (e.target.closest('.track-loop-btn')) return;
        const cb = row.querySelector('input[type="checkbox"]');
        if (e.target !== cb) cb.checked = !cb.checked;
        if (visualizer && typeof visualizer.toggleTrack === 'function') {
          visualizer.toggleTrack(tr.id, cb.checked);
        }
        row.classList.toggle('active', cb.checked);
        const activeVid = getActiveVideoForTime(state.currentTime);
        visualizer?.renderFrame?.(state.currentTime, activeVid);
      });
      els.trackListContainer.appendChild(row);
    });
  }

  function getFilteredClips() {
    const srcFilter = els.clipSourceSelect ? els.clipSourceSelect.value : 'anime';
    if (srcFilter === 'local') {
      return (state.clips || []).filter((c) => Boolean(c.isLocal || c.source === 'local')).slice(0, MAX_CLIP_PICKER_CLIPS);
    }
    if (srcFilter === 'real_life') {
      return (state.clips || []).filter((c) => c.source === 'real_life').slice(0, MAX_CLIP_PICKER_CLIPS);
    }
    return (state.clips || [])
      .filter((c) => c.source !== 'real_life' && !c.isLocal && c.source !== 'local')
      .slice(0, MAX_CLIP_PICKER_CLIPS);
  }

  const clipVideoObservers = new WeakMap();

  function formatClipThumbSrc(url, startSec = 0.1) {
    if (!url || typeof url !== 'string') return '';
    if (url.includes('#')) return url;
    const t = Math.max(0.05, Number(startSec) || 0.1).toFixed(2);
    return `${url}#t=${t}`;
  }

  function hydrateClipCardVideo(vid) {
    if (!vid || vid.dataset.hydrated === '1') return;
    const src = vid.dataset.src;
    if (!src) return;
    vid.dataset.hydrated = '1';
    vid.preload = 'metadata';
    vid.src = src;
  }

  function observeClipGridVideos(container) {
    if (!container) return;
    const prev = clipVideoObservers.get(container);
    if (prev) prev.disconnect();
    const videos = container.querySelectorAll('video[data-src]');
    if (typeof IntersectionObserver !== 'function') {
      videos.forEach(hydrateClipCardVideo);
      return;
    }
    const obs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          hydrateClipCardVideo(entry.target);
          obs.unobserve(entry.target);
        }
      }
    }, { root: container, rootMargin: '160px 0px' });
    videos.forEach((v) => obs.observe(v));
    clipVideoObservers.set(container, obs);
  }

  function createClipCardElement(clip) {
    const positions = [];
    state.selectedClipIds.forEach((id, idx) => {
      if (id === clip.id) positions.push(idx + 1);
    });
    const isSelected = positions.length > 0;
    const card = document.createElement('div');
    card.className = `clip-card${isSelected ? ' selected' : ''}`;
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData('application/x-samplevis-clip', JSON.stringify({
        id: clip.id,
        title: clip.title,
        url: clip.url,
        remoteUrl: clip.remoteUrl || null
      }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    const orderBadge = isSelected && visualizer?.params?.cutMode !== 'single'
      ? `<span class="clip-badge-order" title="playlist slots: ${positions.join(', ')}">${positions.join(' · ')}</span>`
      : '';
    const isFav = isClipFavorited(clip.id);
    const favBadge = `
      <button type="button" class="clip-fav-btn${isFav ? ' active' : ''}" title="${isFav ? 'remove from project favorites' : 'save to project favorites'}" data-clip-id="${clip.id}">
        ${isFav ? '★' : '☆'}
      </button>
    `;
    const safeTitle = String(clip.title || 'clip');
    const thumbSrc = formatClipThumbSrc(clip.url);
    card.innerHTML = `
      ${orderBadge}
      ${favBadge}
      <video data-src="${thumbSrc}" muted loop playsinline preload="none"></video>
      <div class="clip-card-info">
        <span class="clip-title" title="${safeTitle}">${safeTitle}</span>
        <div class="clip-frame-btns" title="crop: left / center / right">
          <button type="button" class="frame-btn${clip.manualFocalX === 0.25 ? ' active' : ''}" data-focal="0.25" title="frame left">L</button>
          <button type="button" class="frame-btn${(!clip.manualFocalX || clip.manualFocalX === 0.5) ? ' active' : ''}" data-focal="0.5" title="frame center">C</button>
          <button type="button" class="frame-btn${clip.manualFocalX === 0.75 ? ' active' : ''}" data-focal="0.75" title="frame right">R</button>
        </div>
      </div>
    `;

    card.querySelectorAll('.frame-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const focal = parseFloat(btn.dataset.focal);
        clip.manualFocalX = focal;
        const inClips = (state.clips || []).find((c) => c.id === clip.id);
        if (inClips) inClips.manualFocalX = focal;
        const inFavs = (state.favoriteClips || []).find((c) => c.id === clip.id);
        if (inFavs) inFavs.manualFocalX = focal;
        syncVideoPoolSources();
        renderClipGrid();
        renderFavoritesGrid();
        persistCurrentProjectState().catch(() => { });
      });
    });

    const favBtn = card.querySelector('.clip-fav-btn');
    favBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleClipFavorite(clip);
    });

    const vid = card.querySelector('video');
    card.addEventListener('mouseenter', () => {
      hydrateClipCardVideo(vid);
      vid.play().catch(() => { });
    });
    card.addEventListener('mouseleave', () => {
      vid.pause();
    });

    card.addEventListener('click', () => {
      const clipDefaultStart = normalizeClipStartTime(clip.startTime ?? 0);
      if (visualizer?.params?.cutMode === 'single') {
        if (state.selectedClipIds.length === 1 && state.selectedClipIds[0] === clip.id) {
          state.selectedClipIds = [];
          state.selectedClipStartTimes = [];
          state.selectedClipEndTimes = [];
          state.selectedClipSpeeds = [];
        } else {
          state.selectedClipIds = [clip.id];
          state.selectedClipStartTimes = [clipDefaultStart];
          state.selectedClipEndTimes = [null];
          state.selectedClipSpeeds = [100];
        }
      } else {
        if (state.selectedClipIds.length >= MAX_PLAYLIST_SLOTS) {
          const prevTitle = els.togglePlaylistStripBtn?.title || '';
          if (els.togglePlaylistStripBtn) {
            setPlaylistStripOpen(true);
            els.togglePlaylistStripBtn.title = 'playlist safety limit reached';
            setTimeout(() => {
              if (els.togglePlaylistStripBtn) {
                els.togglePlaylistStripBtn.title = prevTitle || 'open or close clip playlist order strip';
              }
            }, 1800);
          }
          return;
        }
        syncSelectedClipStartTimesLength();
        state.selectedClipIds = [...state.selectedClipIds, clip.id];
        state.selectedClipStartTimes = [...state.selectedClipStartTimes, clipDefaultStart];
        state.selectedClipEndTimes = [...state.selectedClipEndTimes, null];
        state.selectedClipSpeeds = [...state.selectedClipSpeeds, 100];
        if (state.selectedClipIds.length > 1 && !state._playlistStripOpen && !state._playlistStripUserCollapsed) {
          setPlaylistStripOpen(true);
        }
      }
      commitPlaylistMutation();
    });

    return card;
  }

  function renderClipGrid() {
    if (!els.clipGridContainer) return;
    els.clipGridContainer.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch { } });
    els.clipGridContainer.innerHTML = '';
    const visibleClips = getFilteredClips();
    if (els.clipsCountLabel) {
      els.clipsCountLabel.textContent = `${visibleClips.length} clip${visibleClips.length === 1 ? '' : 's'}`;
    }

    if (visibleClips.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-clips-msg';
      empty.style.gridColumn = '1 / -1';
      empty.style.padding = '18px 12px';
      empty.style.textAlign = 'center';
      empty.style.fontSize = '11px';
      empty.style.color = 'var(--text-secondary)';
      const srcFilter = els.clipSourceSelect ? els.clipSourceSelect.value : 'anime';
      empty.textContent =
        srcFilter === 'local'
          ? 'no local clips yet · click +file to add mp4/webm clips'
          : 'no clips in this view yet · click "fetch best", "fetch random", or "+file"';
      els.clipGridContainer.appendChild(empty);
      return;
    }

    visibleClips.forEach((clip) => {
      els.clipGridContainer.appendChild(createClipCardElement(clip));
    });
    observeClipGridVideos(els.clipGridContainer);
  }

  function renderFavoritesGrid() {
    updateFavoritesCountUi();
    if (!els.favoritesGridContainer) return;
    els.favoritesGridContainer.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch { } });
    els.favoritesGridContainer.innerHTML = '';
    const favs = state.favoriteClips || [];

    if (favs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-clips-msg';
      empty.style.gridColumn = '1 / -1';
      empty.style.padding = '22px 12px';
      empty.style.textAlign = 'center';
      empty.style.fontSize = '11px';
      empty.style.color = 'var(--ink-muted)';
      empty.textContent = 'no favorites in this project yet · click ☆ on any clip card to save it here';
      els.favoritesGridContainer.appendChild(empty);
      return;
    }

    favs.forEach((clip) => {
      els.favoritesGridContainer.appendChild(createClipCardElement(clip));
    });
    observeClipGridVideos(els.favoritesGridContainer);
  }

  function getActiveTimelineMarkers() {
    if (!state.project) return [];
    const activeSpec = visualizer?.preset || visualizer;
    if (window.loopUtils?.resolveTimelineMarkers) {
      return window.loopUtils.resolveTimelineMarkers(activeSpec, state.project);
    }
    return [];
  }

  function sampleWaveformPeaks(peaks, targetCount) {
    if (!peaks.length || targetCount <= 0) return [];
    if (peaks.length === targetCount) return peaks;
    const out = new Array(targetCount);
    const ratio = peaks.length / targetCount;
    for (let i = 0; i < targetCount; i++) {
      const start = i * ratio;
      const end = Math.min(peaks.length, (i + 1) * ratio);
      const i0 = Math.floor(start);
      const i1 = Math.max(i0 + 1, Math.ceil(end));
      if (ratio < 1) {
        // linear interpolation when expanding onto wide screens
        const frac = start - i0;
        const a = peaks[i0] || 0;
        const b = peaks[Math.min(peaks.length - 1, i0 + 1)] || a;
        out[i] = a + (b - a) * frac;
      } else {
        // preserve transient peaks when downsampling
        let peakMax = 0;
        for (let j = i0; j < i1; j++) {
          if (peaks[j] > peakMax) peakMax = peaks[j];
        }
        out[i] = peakMax;
      }
    }
    return out;
  }

  const TIMELINE_MIN_ZOOM = 1;
  const TIMELINE_MAX_ZOOM = 32;
  let timelineScrollRaf = 0;
  let _syncingTimelineScroll = false;

  function getTimelineScroller() {
    return els.waveformScroller || els.waveformContainer;
  }

  function getTimelineViewWindow() {
    const zoom = Math.max(TIMELINE_MIN_ZOOM, Math.min(TIMELINE_MAX_ZOOM, state.timelineZoom || 1));
    const dur = Math.max(0.1, state.project?.duration || 30.0);
    const scroller = getTimelineScroller();
    const viewW = Math.max(1, scroller?.clientWidth || els.waveformContainer?.clientWidth || 900);
    const totalW = Math.max(viewW, viewW * zoom);
    const scrollLeft = Math.max(0, Math.min(totalW - viewW, scroller?.scrollLeft || 0));
    const startRatio = Math.max(0, Math.min(1 - 1 / zoom, scrollLeft / totalW));
    const spanRatio = 1 / zoom;
    const endRatio = Math.min(1, startRatio + spanRatio);
    return {
      zoom,
      dur,
      viewW,
      totalW,
      scrollLeft,
      startRatio,
      endRatio,
      startTime: startRatio * dur,
      endTime: endRatio * dur,
      spanTime: dur * spanRatio
    };
  }

  function clientXToTimelineRatio(clientX, containerEl = null) {
    const target = containerEl || getTimelineScroller() || els.waveformContainer;
    if (!target) return 0;
    const rect = target.getBoundingClientRect();
    if (!rect.width) return 0;
    const zoom = Math.max(TIMELINE_MIN_ZOOM, state.timelineZoom || 1);
    const scrollLeft = target.scrollLeft || 0;
    const totalW = Math.max(rect.width, rect.width * zoom);
    return Math.max(0, Math.min(1, (clientX - rect.left + scrollLeft) / totalW));
  }

  function timelineDeltaXToSec(dx, containerEl = null) {
    const target = containerEl || getTimelineScroller() || els.waveformContainer;
    const dur = Math.max(0.1, state.project?.duration || 30.0);
    const viewW = Math.max(1, target?.getBoundingClientRect().width || 1);
    const totalW = Math.max(viewW, viewW * Math.max(1, state.timelineZoom || 1));
    return (dx / totalW) * dur;
  }

  function syncTimelineScroll(sourceEl) {
    if (_syncingTimelineScroll) return;
    _syncingTimelineScroll = true;
    const targetScroll = sourceEl ? sourceEl.scrollLeft : 0;
    if (els.waveformScroller && els.waveformScroller !== sourceEl) {
      els.waveformScroller.scrollLeft = targetScroll;
    }
    if (els.lyricsTimelineBar && els.lyricsTimelineBar !== sourceEl) {
      els.lyricsTimelineBar.scrollLeft = targetScroll;
    }
    _syncingTimelineScroll = false;

    if (!timelineScrollRaf) {
      timelineScrollRaf = requestAnimationFrame(() => {
        timelineScrollRaf = 0;
        drawWaveform();
      });
    }
  }

  function updateTimelineZoomUi() {
    const zoom = Math.max(TIMELINE_MIN_ZOOM, state.timelineZoom || 1);
    const rounded = zoom >= 10 ? Math.round(zoom) : Number(zoom.toFixed(1));
    if (els.timelineZoomResetBtn) {
      els.timelineZoomResetBtn.textContent = `${rounded}x`;
      els.timelineZoomResetBtn.classList.toggle('zoomed', zoom > 1.01);
    }
    if (els.timelineZoomOutBtn) {
      els.timelineZoomOutBtn.disabled = zoom <= TIMELINE_MIN_ZOOM + 0.01;
    }
    if (els.timelineZoomInBtn) {
      els.timelineZoomInBtn.disabled = zoom >= TIMELINE_MAX_ZOOM - 0.01;
    }
  }

  function setTimelineZoom(nextZoom, anchorClientX = null) {
    const clamped = Math.max(TIMELINE_MIN_ZOOM, Math.min(TIMELINE_MAX_ZOOM, Number(nextZoom) || 1));
    const prevZoom = state.timelineZoom || 1;
    const scroller = getTimelineScroller();
    const viewW = Math.max(1, scroller?.clientWidth || 900);
    const dur = Math.max(0.1, state.project?.duration || 30.0);

    let anchorRatio = Math.max(0, Math.min(1, (state.currentTime || 0) / dur));
    let anchorViewportOffset = 0.5 * viewW;
    if (scroller && anchorClientX !== null && Number.isFinite(anchorClientX)) {
      const rect = scroller.getBoundingClientRect();
      anchorViewportOffset = Math.max(0, Math.min(rect.width, anchorClientX - rect.left));
      const prevTotalW = Math.max(rect.width, rect.width * prevZoom);
      anchorRatio = Math.max(0, Math.min(1, (scroller.scrollLeft + anchorViewportOffset) / prevTotalW));
    } else if (scroller && prevZoom > 1) {
      const prevTotalW = Math.max(viewW, viewW * prevZoom);
      const playX = anchorRatio * prevTotalW - scroller.scrollLeft;
      if (playX >= 0 && playX <= viewW) {
        anchorViewportOffset = playX;
      }
    }

    state.timelineZoom = clamped;
    const dock = els.waveformContainer?.closest('.timeline-dock');
    if (dock) {
      dock.style.setProperty('--timeline-zoom', String(clamped));
    }
    if (els.waveformTrack) els.waveformTrack.style.width = `${clamped * 100}%`;
    if (els.lyricsTimelineTrack) els.lyricsTimelineTrack.style.width = `${clamped * 100}%`;

    if (scroller) {
      const nextTotalW = Math.max(viewW, viewW * clamped);
      const nextScrollLeft = clamped <= 1.001
        ? 0
        : Math.max(0, Math.min(nextTotalW - viewW, anchorRatio * nextTotalW - anchorViewportOffset));
      _syncingTimelineScroll = true;
      scroller.scrollLeft = nextScrollLeft;
      if (els.lyricsTimelineBar) els.lyricsTimelineBar.scrollLeft = nextScrollLeft;
      _syncingTimelineScroll = false;
    }

    updateTimelineZoomUi();
    drawWaveform();
  }

  function ensureTimelinePlayheadVisible(t) {
    if (!state.isPlaying || (state.timelineZoom || 1) <= 1.01) return;
    if (state.scrubbingWaveform || state.draggingMarkerId || state.draggingImpactIdx >= 0 || state.draggingCustomCue || state.draggingLyricWord) return;
    if (Date.now() < (state._timelineManualScrollUntil || 0)) return;
    const scroller = getTimelineScroller();
    if (!scroller) return;
    const win = getTimelineViewWindow();
    const pad = win.spanTime * 0.08;
    if (t >= win.startTime + pad * 0.5 && t <= win.endTime - pad) return;
    const targetStartTime = Math.max(0, Math.min(win.dur - win.spanTime, t - win.spanTime * 0.2));
    const nextScrollLeft = (targetStartTime / win.dur) * win.totalW;
    _syncingTimelineScroll = true;
    scroller.scrollLeft = nextScrollLeft;
    if (els.lyricsTimelineBar) els.lyricsTimelineBar.scrollLeft = nextScrollLeft;
    _syncingTimelineScroll = false;
    drawWaveform();
  }

  function sampleWaveformPeaksWindow(peaks, targetCount, startRatio = 0, endRatio = 1) {
    if (!peaks.length || targetCount <= 0) return [];
    const sRatio = Math.max(0, Math.min(1, startRatio));
    const eRatio = Math.max(sRatio + 1e-6, Math.min(1, endRatio));
    const out = new Array(targetCount);
    const totalLen = peaks.length;
    const startIdxF = sRatio * totalLen;
    const spanIdxF = (eRatio - sRatio) * totalLen;
    const stepF = spanIdxF / targetCount;
    for (let i = 0; i < targetCount; i++) {
      const start = startIdxF + i * stepF;
      const end = Math.min(totalLen, startIdxF + (i + 1) * stepF);
      const i0 = Math.max(0, Math.min(totalLen - 1, Math.floor(start)));
      const i1 = Math.max(i0 + 1, Math.min(totalLen, Math.ceil(end)));
      if (stepF < 1) {
        const frac = start - i0;
        const a = peaks[i0] || 0;
        const b = peaks[Math.min(totalLen - 1, i0 + 1)] || a;
        out[i] = a + (b - a) * frac;
      } else {
        let peakMax = 0;
        for (let j = i0; j < i1; j++) {
          if (peaks[j] > peakMax) peakMax = peaks[j];
        }
        out[i] = peakMax;
      }
    }
    return out;
  }

  let waveformResizeRaf = 0;
  if (typeof ResizeObserver === 'function' && els.waveformContainer) {
    const ro = new ResizeObserver(() => {
      if (waveformResizeRaf) cancelAnimationFrame(waveformResizeRaf);
      waveformResizeRaf = requestAnimationFrame(() => {
        waveformResizeRaf = 0;
        drawWaveform();
      });
    });
    ro.observe(els.waveformContainer);
  }

  function drawWaveform() {
    const ctx = waveformCanvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const W = waveformCanvas.clientWidth || 900;
    const H = waveformCanvas.clientHeight || 64;
    const targetW = Math.max(1, Math.round(W * dpr));
    const targetH = Math.max(1, Math.round(H * dpr));
    if (waveformCanvas.width !== targetW || waveformCanvas.height !== targetH) {
      waveformCanvas.width = targetW;
      waveformCanvas.height = targetH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const peaks = state.project?.peaks || [];
    if (peaks.length === 0) {
      updateTimelineMarkers([]);
      return;
    }

    const win = getTimelineViewWindow();
    const dur = win.dur;
    const markers = getActiveTimelineMarkers();
    const firstSplitRatio = markers.length > 0 ? markers[0].time / dur : -1;
    const theme = getComputedStyle(els.waveformContainer);
    const wavePre = theme.getPropertyValue('--wave-pre').trim();
    const wavePost = theme.getPropertyValue('--wave-post').trim();

    const step = 4;
    const barW = 2;
    const barCount = Math.max(24, Math.floor(W / step));
    const sampled = sampleWaveformPeaksWindow(peaks, barCount, win.startRatio, win.endRatio);
    const actualStep = W / barCount;
    const spanRatio = Math.max(1e-6, win.endRatio - win.startRatio);

    sampled.forEach((p, idx) => {
      const ratio = win.startRatio + ((idx + 0.5) / barCount) * spanRatio;
      const isHighlighted = firstSplitRatio < 0 || ratio >= firstSplitRatio;
      const h = Math.max(3, Math.round(p * (H - 14)));
      const x = Math.round(idx * actualStep);
      const y = Math.round((H - h) * 0.5);

      ctx.fillStyle = isHighlighted ? wavePost : wavePre;
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(x, y, barW, h, 1);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, barW, h);
      }
    });

    // cut markers on the waveform (impact mode renders interactive lines in #impactCutsLayer)
    const cutMode = visualizer?.params?.cutMode;
    const cuts = cutMode === 'chord' ? state.project?.chordCutTimes : null;

    if (cuts && cuts.length > 0) {
      ctx.fillStyle = theme.getPropertyValue('--wave-cut').trim();
      const spanTime = Math.max(1e-4, win.endTime - win.startTime);
      cuts.forEach((ct) => {
        if (ct < win.startTime || ct > win.endTime) return;
        const cx = Math.round(((ct - win.startTime) / spanTime) * W);
        ctx.fillRect(cx, 0, 1, H);
      });
    }

    updateTimelineMarkers(markers);
    renderImpactCutsUi();
    renderCustomCuesUi();
  }

  function updateTimelineMarkers(preResolvedMarkers) {
    if (!state.project) return;
    const dur = state.project.duration || 30.0;
    const secPerBar = (60 / (state.project.bpm || 120)) * 4;
    const markers = Array.isArray(preResolvedMarkers) ? preResolvedMarkers : getActiveTimelineMarkers();
    const hasMarkers = markers.length > 0;

    const dropMarker = markers.find((m) => m.id === 'drop');
    const dropT = dropMarker ? dropMarker.time : getProjectDropTime();
    const gridAnchor = Number.isFinite(state.project.downbeatOffset) ? state.project.downbeatOffset : 0;
    const dropBar = Math.max(1, Math.round(Math.max(0, dropT - gridAnchor) / secPerBar) + 1);
    state.project.dropBar = dropBar;
    if (visualizer?.project) visualizer.project.dropBar = dropBar;

    if (els.jumpDropBtn) els.jumpDropBtn.hidden = !hasMarkers;
    if (els.dropBadgeReadout) els.dropBadgeReadout.hidden = !hasMarkers;
    if (els.timelineMarkersLayer) els.timelineMarkersLayer.hidden = !hasMarkers;
    updateWaveformTooltip(hasMarkers);

    if (hasMarkers && els.timelineMarkersLayer) {
      const layer = els.timelineMarkersLayer;
      const existingById = new Map();
      layer.querySelectorAll('.drop-marker-line').forEach((node) => {
        if (node.dataset.markerId) existingById.set(node.dataset.markerId, node);
      });
      const wantedIds = new Set(markers.map((m) => m.id));
      existingById.forEach((node, id) => {
        if (!wantedIds.has(id)) node.remove();
      });

      const zoom = Math.max(TIMELINE_MIN_ZOOM, state.timelineZoom || 1);
      const staggerGapPct = 13 / zoom;
      const flipLeftPct = 100 - (20 / zoom);
      const rowLastPct = [-100, -100, -100];
      markers.forEach((m) => {
        const pct = Math.max(0, Math.min(100, (m.time / dur) * 100));
        let lineEl = existingById.get(m.id);
        let tagEl = lineEl ? lineEl.querySelector('.drop-marker-tag') : null;
        if (!lineEl) {
          lineEl = document.createElement('div');
          lineEl.className = 'drop-marker-line';
          lineEl.dataset.markerId = m.id;
          tagEl = document.createElement('span');
          tagEl.className = 'drop-marker-tag';
          lineEl.appendChild(tagEl);
          layer.appendChild(lineEl);
        }

        const alignLeft = pct > flipLeftPct;
        let staggerRow = 0;
        for (let r = 0; r < rowLastPct.length; r++) {
          if (pct - rowLastPct[r] >= staggerGapPct) {
            staggerRow = r;
            break;
          }
          if (r === rowLastPct.length - 1) staggerRow = r;
        }
        rowLastPct[staggerRow] = pct;

        lineEl.style.left = `${pct}%`;
        lineEl.style.setProperty('--marker-color', m.color || '#83ca90');
        lineEl.classList.toggle('align-left', alignLeft);
        lineEl.classList.toggle('stagger-1', staggerRow === 1);
        lineEl.classList.toggle('stagger-2', staggerRow === 2);
        lineEl.classList.toggle('dragging', state.draggingMarkerId === m.id);
        lineEl.title = `${m.label} · bar ${m.bar} (${m.time.toFixed(2)}s) · drag to adjust (hold shift for fine)`;
        if (tagEl) tagEl.textContent = `${m.label} · bar ${m.bar}`;
      });

      if (els.dropBadgeReadout) {
        if (markers.length === 1) {
          const only = markers[0];
          els.dropBadgeReadout.textContent = `${only.label} · bar ${only.bar} (${only.time.toFixed(2)}s)`;
        } else {
          const active = [...markers].reverse().find((m) => m.time <= state.currentTime + 0.05) || markers[0];
          els.dropBadgeReadout.textContent = `${active.label} · bar ${active.bar} (${markers.length} cues)`;
        }
      }

      if (els.jumpDropBtn) {
        if (markers.length === 1 && markers[0].id === 'drop') {
          els.jumpDropBtn.textContent = 'test drop';
          els.jumpDropBtn.title = 'preview 2 seconds before the drop';
        } else if (markers.length === 1) {
          els.jumpDropBtn.textContent = `test ${markers[0].label}`;
          els.jumpDropBtn.title = `preview before ${markers[0].label}`;
        } else {
          els.jumpDropBtn.textContent = 'next cue';
          els.jumpDropBtn.title = 'preview 1.5 seconds before next timeline cue';
        }
      }
    }

    const playPct = Math.max(0, Math.min(100, (state.currentTime / dur) * 100));
    els.timelinePlayhead.style.left = `${playPct}%`;
  }

  function updateTransportReadouts(t) {
    const dur = state.project?.duration || 30.0;
    els.timeReadout.textContent = `${formatTime(t)} / ${formatTime(dur)}`;
    const bpm = state.project?.bpm || 120;
    const gridAnchor = Number.isFinite(state.project?.downbeatOffset) ? state.project.downbeatOffset : 0;
    const totalBeats = Math.max(0, t - gridAnchor) * (bpm / 60);
    const bar = Math.floor(totalBeats / 4) + 1;
    const beat = Math.floor(totalBeats % 4) + 1;
    els.barReadout.textContent = `bar ${String(bar).padStart(2, '0')}.${beat}`;

    const playPct = Math.max(0, Math.min(100, (t / dur) * 100));
    els.timelinePlayhead.style.left = `${playPct}%`;
    if (els.lyricsTimelinePlayhead && els.lyricsTimelineBar && !els.lyricsTimelineBar.hidden) {
      els.lyricsTimelinePlayhead.style.left = `${playPct}%`;
    }
    ensureTimelinePlayheadVisible(t);
    updateActiveImpactHighlight(t);
    updateActiveCustomCueHighlight(t);

    if (els.dropBadgeReadout && !els.dropBadgeReadout.hidden) {
      const markers = getActiveTimelineMarkers();
      if (markers.length > 1) {
        const active = [...markers].reverse().find((m) => m.time <= t + 0.05) || markers[0];
        const nextText = `${active.label} · bar ${active.bar} (${markers.length} cues)`;
        if (els.dropBadgeReadout.textContent !== nextText) {
          els.dropBadgeReadout.textContent = nextText;
        }
      }
    }

    const lyricsFrame = (state.project?.lyrics && window.lyricsService &&
      ((els.lyricsLinesList && els.lyricsLinesPane && !els.lyricsLinesPane.hidden) ||
        (els.lyricsTimelineTrack && els.lyricsTimelineBar && !els.lyricsTimelineBar.hidden)))
      ? window.lyricsService.getLyricsFrameAt(state.project.lyrics, t)
      : null;

    if (els.lyricsLinesList && els.lyricsLinesPane && !els.lyricsLinesPane.hidden) {
      const activeIdx = lyricsFrame ? lyricsFrame.activeLineIndex : -1;
      els.lyricsLinesList.querySelectorAll('.lyric-line-row').forEach((row) => {
        const idx = parseInt(row.dataset.lineIdx || '-1', 10);
        row.classList.toggle('active', idx === activeIdx && idx >= 0);
      });
    }

    if (els.lyricsTimelineTrack && els.lyricsTimelineBar && !els.lyricsTimelineBar.hidden) {
      const activeLineIdx = lyricsFrame ? lyricsFrame.activeLineIndex : -1;
      const activeWordIdx = lyricsFrame ? lyricsFrame.activeWordIndex : -1;
      els.lyricsTimelineTrack.querySelectorAll('.lyrics-timeline-word').forEach((el) => {
        const lIdx = parseInt(el.dataset.lineIdx || '-1', 10);
        const wIdx = parseInt(el.dataset.wordIdx || '-1', 10);
        const isActive = activeLineIdx >= 0 && lIdx === activeLineIdx && (wIdx < 0 || activeWordIdx < 0 || wIdx === activeWordIdx);
        el.classList.toggle('active', isActive);
      });
    }
  }

  function getActivePresetIdSafe() {
    return window.templateRegistry?.activeTemplateId || visualizer?.preset?.id || visualizer?.id || activeTemplateId || 'constellations';
  }

  // the stream proxy is not edge-cached, so a clip that only ever loads through it costs a network
  // round trip on every seek. cache the active playlist once, after playback has settled, so later
  // loads hydrate from indexeddb and seek locally.
  const CLIP_CACHE_MAX = 12;
  let _clipCacheTimer = 0;

  function scheduleClipBlobCache() {
    if (!window.projectBundleService?.cacheClipBlob || !window.projectBundleService?.getCachedClipRecord) return;
    if (navigator.connection?.saveData) return;
    if (_clipCacheTimer) clearTimeout(_clipCacheTimer);
    _clipCacheTimer = setTimeout(() => {
      _clipCacheTimer = 0;
      cachePlaylistClipsInBackground().catch(() => { });
    }, 3000);
  }

  async function cachePlaylistClipsInBackground() {
    const ids = new Set(state.selectedClipIds || []);
    Object.values(getNormalizedPlaylistsByCutMode()).forEach((pl) => {
      (pl?.ids || []).forEach((id) => ids.add(id));
    });
    const queue = Array.from(ids).slice(0, CLIP_CACHE_MAX);
    for (const id of queue) {
      const clip = findClipById(id);
      if (!clip || !clip.url || !clip.url.startsWith('/api/clips/stream')) continue;
      try {
        const existing = await window.projectBundleService.getCachedClipRecord(clip.id);
        if (existing?.blob) continue;
        const res = await fetch(clip.url);
        if (!res.ok) continue;
        const blob = await res.blob();
        if (!blob || blob.size === 0) continue;
        await window.projectBundleService.cacheClipBlob(clip.id, blob, clip);
      } catch { }
    }
  }

  function sanitizeClipForJson(clip) {
    if (!clip || typeof clip !== 'object') return clip;
    const copy = { ...clip };
    delete copy.blob;
    if (typeof copy.objectUrl === 'string' && copy.objectUrl.startsWith('blob:')) {
      delete copy.objectUrl;
    }
    if (typeof copy.url === 'string' && copy.url.startsWith('blob:')) {
      delete copy.url;
    }
    return copy;
  }

  function buildProjectStatePayload({ includeBlobs = true } = {}) {
    const playlistsByMode = getNormalizedPlaylistsByCutMode();
    const selectedSet = new Set(state.selectedClipIds || []);
    Object.values(playlistsByMode).forEach((pl) => {
      (pl?.ids || []).forEach((id) => selectedSet.add(id));
    });
    const seenClipIds = new Set();
    const customClips = [];
    for (const c of (state.clips || [])) {
      if (!c || !c.id || seenClipIds.has(c.id)) continue;
      if (c.isLocal || c.source === 'local' || c.streamOnly || Boolean(c.fetchedAt) || selectedSet.has(c.id)) {
        seenClipIds.add(c.id);
        customClips.push(includeBlobs ? c : sanitizeClipForJson(c));
      }
    }
    for (const id of selectedSet) {
      if (seenClipIds.has(id)) continue;
      const archived = state._archivedSelectedClips?.get?.(id);
      if (archived) {
        seenClipIds.add(id);
        const entry = { ...archived, _archivedFromPicker: true };
        customClips.push(includeBlobs ? entry : sanitizeClipForJson(entry));
      }
    }
    const favoriteClips = includeBlobs
      ? (state.favoriteClips || [])
      : (state.favoriteClips || []).map(sanitizeClipForJson);

    const trackLoopStates = {};
    if (Array.isArray(state.project?.tracks)) {
      state.project.tracks.forEach((tr) => {
        if (tr?.id && typeof tr.loopMidi === 'boolean') {
          trackLoopStates[tr.id] = tr.loopMidi;
        }
      });
    }

    const payload = {
      projectMeta: state.project ? {
        brand: state.project.brand,
        sampleNumber: state.project.sampleNumber,
        title: state.project.title,
        key: state.project.key,
        bpm: state.project.bpm,
        aspectRatio: state.aspectRatio,
        dropBar: Number.isFinite(Number(state.project.dropBar)) ? Number(state.project.dropBar) : null,
        dropTime: Number.isFinite(Number(state.project.dropTime)) ? Number(state.project.dropTime) : null,
        selectedTrackIds: visualizer?.selectedTrackIds ? Array.from(visualizer.selectedTrackIds) : null,
        trackLoopStates: Object.keys(trackLoopStates).length > 0 ? trackLoopStates : null,
        impactTimes: Array.isArray(state.project.impactTimes) ? [...state.project.impactTimes] : null,
        impactTimesEdited: Boolean(state.project._impactTimesEdited),
        customCutTimes: Array.isArray(state.project.customCutTimes) ? [...state.project.customCutTimes] : null,
        customCues: (state.project._customCues && typeof state.project._customCues === 'object')
          ? JSON.parse(JSON.stringify(state.project._customCues))
          : null
      } : null,
      lyricsData: state.project?.lyrics ? JSON.parse(JSON.stringify(state.project.lyrics)) : null,
      selectedClipIds: Array.isArray(state.selectedClipIds) ? [...state.selectedClipIds] : [],
      selectedClipStartTimes: Array.isArray(state.selectedClipStartTimes) ? [...state.selectedClipStartTimes] : [],
      selectedClipEndTimes: Array.isArray(state.selectedClipEndTimes) ? [...state.selectedClipEndTimes] : [],
      selectedClipSpeeds: Array.isArray(state.selectedClipSpeeds) ? [...state.selectedClipSpeeds] : [],
      playlistsByCutMode: JSON.parse(JSON.stringify(playlistsByMode)),
      customClips,
      favoriteClips,
      clipSource: els.clipSourceSelect ? els.clipSourceSelect.value : null,
      clipQuery: els.clipCustomQueryInput ? els.clipCustomQueryInput.value.trim() : null
    };
    if (includeBlobs) {
      payload.audioBlob = state.hasCustomAudio ? state.audioBlob : null;
      payload.audioName = state.hasCustomAudio ? state.audioName : null;
      payload.midiBlob = state.hasCustomMidi ? state.midiBlob : null;
      payload.midiName = state.hasCustomMidi ? state.midiName : null;
    }
    return payload;
  }

  async function persistCurrentProjectState(overridePresetId = null, opts = {}) {
    if (!window.projectBundleService?.saveProjectState) return;
    if (!state.project && (state.favoriteClips || []).length === 0 && (state.selectedClipIds || []).length === 0) return;
    const pid = overridePresetId || getActivePresetIdSafe();
    if (!pid) return;
    try {
      await window.projectBundleService.saveProjectState(
        pid,
        buildProjectStatePayload({ includeBlobs: true }),
        { checkpoint: Boolean(opts?.checkpoint) }
      );
    } catch (err) {
      console.warn('Could not persist local project state:', err.message);
    }
  }

  /**
   * Lists the files this project owns: the song, the .mid/.als and any clip the user uploaded.
   *
   * Third-party clips are never collected: their bytes stay upstream and only the link is kept, so
   * a shared template references a clip instead of re-hosting it. Each row keeps its blob so a save
   * can decide what to do with those exact bytes.
   */
  async function listProjectMediaFiles(projectStateDoc) {
    const rows = [];

    if (state.hasCustomAudio && state.audioBlob instanceof Blob && state.audioBlob.size > 0) {
      rows.push({
        key: 'audio',
        kind: 'audio',
        name: state.audioName || 'sample.wav',
        bytes: state.audioBlob.size,
        mime: state.audioBlob.type || 'audio/wav',
        blob: state.audioBlob
      });
    }
    if (state.hasCustomMidi && state.midiBlob instanceof Blob && state.midiBlob.size > 0) {
      rows.push({
        key: 'midi',
        kind: 'midi',
        name: state.midiName || 'project.mid',
        bytes: state.midiBlob.size,
        // a dropped .mid/.als often arrives with no type at all, so the extension decides
        mime: window.projectBundleService?.trackMime?.(state.midiName) || state.midiBlob.type || 'audio/midi',
        blob: state.midiBlob
      });
    }

    const seen = new Set();
    for (const list of [projectStateDoc?.customClips, projectStateDoc?.favoriteClips]) {
      for (const clip of Array.isArray(list) ? list : []) {
        if (!clip?.id || seen.has(clip.id)) continue;
        if (!(clip.isLocal || clip.source === 'local')) continue;
        const record = await window.projectBundleService?.getCachedClipRecord?.(clip.id).catch(() => null);
        if (!record?.blob || record.blob.size === 0) continue;
        seen.add(clip.id);
        rows.push({
          key: `clip:${clip.id}`,
          clipId: clip.id,
          kind: 'video',
          name: record.title || clip.title || `${clip.id}.mp4`,
          bytes: record.blob.size,
          mime: record.mimeType || record.blob.type || 'video/mp4',
          blob: record.blob
        });
      }
    }
    return rows;
  }


  function setLyricsStatus(msg) {
    if (els.lyricsStatusText) {
      els.lyricsStatusText.textContent = String(msg || '').toLowerCase();
    }
  }

  function setLyricsTab(tabName) {
    const isLines = tabName === 'lines';
    if (els.lyricsTabEditBtn) {
      els.lyricsTabEditBtn.classList.toggle('active', !isLines);
      els.lyricsTabEditBtn.setAttribute('aria-selected', String(!isLines));
    }
    if (els.lyricsTabLinesBtn) {
      els.lyricsTabLinesBtn.classList.toggle('active', isLines);
      els.lyricsTabLinesBtn.setAttribute('aria-selected', String(isLines));
    }
    if (els.lyricsEditPane) els.lyricsEditPane.hidden = isLines;
    if (els.lyricsLinesPane) els.lyricsLinesPane.hidden = !isLines;
  }

  function getLyricsTimelineWords() {
    const lines = state.project?.lyrics?.lines || [];
    const out = [];
    lines.forEach((line, lineIdx) => {
      if (Array.isArray(line.words) && line.words.length > 0) {
        line.words.forEach((w, wordIdx) => {
          out.push({
            line,
            lineIdx,
            word: w,
            wordIdx,
            text: w.text || line.text || '',
            start: Number(w.start ?? line.start ?? 0),
            end: Number(w.end ?? line.end ?? 0)
          });
        });
      } else {
        out.push({
          line,
          lineIdx,
          word: null,
          wordIdx: -1,
          text: line.text || '',
          start: Number(line.start ?? 0),
          end: Number(line.end ?? 0)
        });
      }
    });
    return out;
  }

  function isLyricsSentenceMode(lyricsData) {
    if (lyricsData?.granularity === 'sentences') return true;
    if (lyricsData?.granularity === 'words') return false;
    if (Array.isArray(lyricsData?.lines) && lyricsData.lines.some((l) => Array.isArray(l?.words) && l.words.length > 1)) {
      return true;
    }
    return els.lyricsGranularitySelect?.value === 'sentences';
  }

  function updateLyricsTimelineVisibility() {
    const hasWords = (state.project?.lyrics?.lines?.length || 0) > 0;
    const available = Boolean(state._lyricsModuleEnabled || hasWords);
    const visible = Boolean(available && state.showLyricsTimelineBar);
    if (els.lyricsTimelineToggleBtn) {
      els.lyricsTimelineToggleBtn.hidden = !available;
      els.lyricsTimelineToggleBtn.classList.toggle('active', visible);
      els.lyricsTimelineToggleBtn.setAttribute('aria-pressed', String(visible));
      els.lyricsTimelineToggleBtn.setAttribute('aria-expanded', String(visible));
      els.lyricsTimelineToggleBtn.textContent = isLyricsSentenceMode(state.project?.lyrics) ? 'sentences' : 'words';
    }
    if (els.lyricsCutOverlapsBtn) {
      els.lyricsCutOverlapsBtn.hidden = !(visible && hasWords);
    }
    if (els.lyricsAddWordBtn) {
      els.lyricsAddWordBtn.hidden = !visible;
    }
    if (els.lyricsDelWordBtn) {
      const hasSelection = state.selectedLyricLineIdx >= 0 && state.selectedLyricLineIdx < (state.project?.lyrics?.lines?.length || 0);
      els.lyricsDelWordBtn.hidden = !(visible && hasWords && hasSelection);
    }
    if (els.lyricsTimelineBar) {
      els.lyricsTimelineBar.hidden = !visible;
    }
  }

  function renderLyricsTimelineBar() {
    updateLyricsTimelineVisibility();
    if (!els.lyricsTimelineTrack) return;
    els.lyricsTimelineTrack.innerHTML = '';
    if (els.lyricsTimelinePlayhead) {
      els.lyricsTimelineTrack.appendChild(els.lyricsTimelinePlayhead);
    }
    if (!els.lyricsTimelineBar || els.lyricsTimelineBar.hidden) return;

    const words = getLyricsTimelineWords();
    if (words.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'lyrics-timeline-empty';
      empty.textContent = 'no synced words yet';
      els.lyricsTimelineTrack.appendChild(empty);
      return;
    }

    const dur = Math.max(0.1, state.project?.duration || 30.0);
    const activeFrame = state.project?.lyrics && window.lyricsService
      ? window.lyricsService.getLyricsFrameAt(state.project.lyrics, state.currentTime || 0)
      : null;

    words.forEach((item) => {
      const start = Math.max(0, Math.min(dur, item.start));
      const end = Math.max(start + 0.04, Math.min(dur, item.end));
      const leftPct = (start / dur) * 100;
      const widthPct = Math.max(0.02, ((end - start) / dur) * 100);

      const chip = document.createElement('div');
      chip.className = 'lyrics-timeline-word';
      chip.dataset.lineIdx = String(item.lineIdx);
      chip.dataset.wordIdx = String(item.wordIdx);
      chip.style.left = `${leftPct.toFixed(4)}%`;
      chip.style.width = `${Math.min(100 - leftPct, widthPct).toFixed(4)}%`;
      chip.title = `${item.text} · ${start.toFixed(2)}s → ${end.toFixed(2)}s (${(end - start).toFixed(2)}s) · click to seek, drag to move, edges to trim`;

      const isActive = activeFrame && activeFrame.activeLineIndex === item.lineIdx &&
        (item.wordIdx < 0 || activeFrame.activeWordIndex < 0 || activeFrame.activeWordIndex === item.wordIdx);
      if (isActive) chip.classList.add('active');
      if (state.selectedLyricLineIdx === item.lineIdx &&
        (item.wordIdx < 0 || state.selectedLyricWordIdx < 0 || state.selectedLyricWordIdx === item.wordIdx)) {
        chip.classList.add('selected');
      }

      const startEdge = document.createElement('div');
      startEdge.className = 'lyrics-word-edge lyrics-word-edge-start';
      startEdge.dataset.edge = 'start';

      const label = document.createElement('span');
      label.className = 'lyrics-timeline-word-label';
      label.textContent = item.text;

      const endEdge = document.createElement('div');
      endEdge.className = 'lyrics-word-edge lyrics-word-edge-end';
      endEdge.dataset.edge = 'end';

      chip.append(startEdge, label, endEdge);
      els.lyricsTimelineTrack.appendChild(chip);
    });

    if (els.lyricsTimelinePlayhead) {
      const playPct = Math.max(0, Math.min(100, ((state.currentTime || 0) / dur) * 100));
      els.lyricsTimelinePlayhead.style.left = `${playPct}%`;
    }
  }

  function syncLyricsToEngine() {
    // any lyric mutation invalidates the one-level regroup undo: restoring a grouping on top of
    // later text/timing edits would silently discard them
    state._lyricsRegroupUndo = null;
    const data = state.project?.lyrics || null;
    if (visualizer && typeof visualizer.setLyricsData === 'function') {
      visualizer.setLyricsData(data);
    }
    updateLyricsRegroupButtons();
    const isSentences = isLyricsSentenceMode(data);
    const entryCount = Array.isArray(data?.lines) ? data.lines.length : 0;
    if (els.lyricsCountBadge) {
      const unit = isSentences ? 'sentence' : 'word';
      els.lyricsCountBadge.textContent = `${entryCount} ${unit}${entryCount === 1 ? '' : 's'}`;
    }
    if (els.lyricsTabLinesBtn) {
      els.lyricsTabLinesBtn.textContent = isSentences ? 'synced sentences' : 'synced words';
    }
    if (els.lyricsHoldLinesCheck) {
      els.lyricsHoldLinesCheck.checked = Boolean(data?.holdLines ?? state._pendingLyricsHold);
    }
    renderLyricsTimelineBar();
    const activeVid = getActiveVideoForTime(state.currentTime);
    visualizer?.renderFrame?.(state.currentTime, activeVid);
  }

  function shiftLineTiming(line, deltaSec) {
    const maxDur = state.project?.duration || 300;
    const prevStart = line.start || 0;
    const span = Math.max(0.05, (line.end ?? prevStart + 0.3) - prevStart);
    const nextStart = Math.max(0, Math.min(maxDur - 0.05, Number((prevStart + deltaSec).toFixed(3))));
    const actualDelta = nextStart - prevStart;
    line.start = nextStart;
    line.end = Math.min(maxDur, Math.max(nextStart + 0.05, Number((nextStart + span).toFixed(3))));
    if (Array.isArray(line.words)) {
      line.words.forEach((w) => {
        const wSpan = Math.max(0.04, (w.end ?? w.start + 0.2) - (w.start ?? prevStart));
        w.start = Math.max(0, Math.min(maxDur - 0.04, Number(((w.start ?? prevStart) + actualDelta).toFixed(3))));
        w.end = Math.min(maxDur, Math.max(w.start + 0.04, Number((w.start + wSpan).toFixed(3))));
      });
    }
  }

  function setLineStartAtTime(line, targetTime) {
    const maxDur = state.project?.duration || 300;
    const curEnd = Math.max(0.05, Math.min(maxDur, line.end ?? (line.start || 0) + 0.3));
    const nextStart = Math.max(0, Math.min(curEnd - 0.05, Number(targetTime.toFixed(3))));
    line.start = nextStart;
    if (Array.isArray(line.words) && line.words.length > 0) {
      line.words[0].start = nextStart;
      line.words[0].end = Math.max(nextStart + 0.04, line.words[0].end ?? curEnd);
    }
  }

  function setLineEndAtTime(line, targetTime) {
    const maxDur = state.project?.duration || 300;
    const curStart = Math.max(0, line.start || 0);
    const nextEnd = Math.max(curStart + 0.05, Math.min(maxDur, Number(targetTime.toFixed(3))));
    line.end = nextEnd;
    if (Array.isArray(line.words) && line.words.length > 0) {
      const last = line.words[line.words.length - 1];
      last.end = Math.max((last.start ?? curStart) + 0.04, nextEnd);
    }
  }

  function trimLyricWordTiming(lineIdx, wordIdx, edge, targetTime) {
    const lines = state.project?.lyrics?.lines;
    if (!Array.isArray(lines) || lineIdx < 0 || lineIdx >= lines.length) return;
    const line = lines[lineIdx];
    const maxDur = state.project?.duration || 300;
    const word = (wordIdx >= 0 && Array.isArray(line.words)) ? line.words[wordIdx] : null;
    const target = word || line;
    const curStart = Number(target.start ?? 0);
    const curEnd = Number(target.end ?? curStart + 0.2);

    if (edge === 'start') {
      const nextStart = Math.max(0, Math.min(curEnd - 0.04, Number(targetTime.toFixed(3))));
      target.start = nextStart;
      if (word) {
        line.start = Math.min(...line.words.map((w) => Number(w.start ?? nextStart)));
      }
    } else if (edge === 'end') {
      const nextEnd = Math.max(curStart + 0.04, Math.min(maxDur, Number(targetTime.toFixed(3))));
      target.end = nextEnd;
      if (word) {
        line.end = Math.max(...line.words.map((w) => Number(w.end ?? nextEnd)));
      }
    }
  }

  function moveLyricWordTiming(lineIdx, wordIdx, targetStart, spanSec) {
    const lines = state.project?.lyrics?.lines;
    if (!Array.isArray(lines) || lineIdx < 0 || lineIdx >= lines.length) return;
    const line = lines[lineIdx];
    const maxDur = state.project?.duration || 300;
    const word = (wordIdx >= 0 && Array.isArray(line.words)) ? line.words[wordIdx] : null;
    const target = word || line;
    const span = Math.max(0.04, Number(spanSec || ((target.end ?? (target.start || 0) + 0.2) - (target.start || 0))));
    const nextStart = Math.max(0, Math.min(Math.max(0, maxDur - span), Number(targetStart.toFixed(3))));
    const nextEnd = Math.min(maxDur, Number((nextStart + span).toFixed(3)));
    target.start = nextStart;
    target.end = Math.max(nextStart + 0.04, nextEnd);

    if (word && Array.isArray(line.words) && line.words.length > 0) {
      line.start = Math.min(...line.words.map((w) => Number(w.start ?? nextStart)));
      line.end = Math.max(...line.words.map((w) => Number(w.end ?? nextEnd)));
    }
  }

  function sortLyricWordsChronologically() {
    const lines = state.project?.lyrics?.lines;
    if (!Array.isArray(lines) || lines.length === 0) return;
    lines.forEach((line) => {
      if (Array.isArray(line.words) && line.words.length > 1) {
        line.words.sort((a, b) => (Number(a.start ?? 0) - Number(b.start ?? 0)) || (Number(a.end ?? 0) - Number(b.end ?? 0)));
        line.start = Math.min(...line.words.map((w) => Number(w.start ?? 0)));
        line.end = Math.max(...line.words.map((w) => Number(w.end ?? 0)));
      }
    });
    lines.sort((a, b) => (Number(a.start ?? 0) - Number(b.start ?? 0)) || (Number(a.end ?? 0) - Number(b.end ?? 0)));
  }

  function cutOverlappingLyricsWords() {
    const lines = state.project?.lyrics?.lines;
    if (!Array.isArray(lines) || lines.length === 0) return 0;

    sortLyricWordsChronologically();

    const entries = [];
    lines.forEach((line) => {
      if (Array.isArray(line.words) && line.words.length > 0) {
        line.words.forEach((w) => entries.push({ item: w, line }));
      } else {
        entries.push({ item: line, line: null });
      }
    });

    entries.sort((a, b) => (Number(a.item.start ?? 0) - Number(b.item.start ?? 0)) || (Number(a.item.end ?? 0) - Number(b.item.end ?? 0)));

    let cuts = 0;
    for (let i = 0; i < entries.length - 1; i++) {
      const prev = entries[i].item;
      const curr = entries[i + 1].item;
      const prevStart = Number(prev.start ?? 0);
      const prevEnd = Number(prev.end ?? prevStart + 0.04);
      const currStart = Number(curr.start ?? 0);
      const currEnd = Number(curr.end ?? currStart + 0.04);

      if (prevEnd > currStart) {
        const mid = (prevEnd + currStart) / 2;
        const minMid = prevStart + 0.04;
        const maxMid = currEnd - 0.04;
        const split = minMid <= maxMid
          ? Math.max(minMid, Math.min(maxMid, mid))
          : Math.max(prevStart + 0.02, Math.min(currEnd - 0.02, mid));
        const rounded = Number(split.toFixed(3));
        prev.end = Math.max(prevStart + 0.02, rounded);
        curr.start = Math.min(currEnd - 0.02, rounded);
        cuts += 1;
      }
    }

    lines.forEach((line) => {
      if (Array.isArray(line.words) && line.words.length > 0) {
        line.start = Math.min(...line.words.map((w) => Number(w.start ?? 0)));
        line.end = Math.max(...line.words.map((w) => Number(w.end ?? 0)));
      }
    });

    return cuts;
  }

  function insertLyricWord(rawText, startSec = state.currentTime || 0, spanSec = 0.35) {
    if (!state.project) return false;
    const text = String(rawText || '').trim();
    if (!text) return false;

    if (!state.project.lyrics || typeof state.project.lyrics !== 'object') {
      state.project.lyrics = { rawText: '', lines: [] };
    }
    if (!Array.isArray(state.project.lyrics.lines)) {
      state.project.lyrics.lines = [];
    }

    const maxDur = Math.max(0.2, state.project.duration || 300);
    const span = Math.max(0.08, Math.min(spanSec, maxDur));
    const start = Number(Math.max(0, Math.min(maxDur - 0.04, startSec)).toFixed(3));
    const end = Number(Math.max(start + 0.04, Math.min(maxDur, start + span)).toFixed(3));
    const newLine = {
      text,
      start,
      end,
      words: [{ text, start, end }]
    };

    state.project.lyrics.lines.push(newLine);
    sortLyricWordsChronologically();
    const newIdx = state.project.lyrics.lines.indexOf(newLine);
    state.selectedLyricLineIdx = newIdx;
    state.selectedLyricWordIdx = 0;

    syncLyricsToEngine();
    renderLyricsEditor();
    highlightLyricLineInEditor(newIdx, 0, true);
    persistCurrentProjectState();
    markProjectDirty();
    setStatus(`inserted "${text}" at ${start.toFixed(2)}s`);
    return true;
  }

  function deleteLyricWord(lineIdx, wordIdx = -1) {
    const lines = state.project?.lyrics?.lines;
    if (!Array.isArray(lines) || lineIdx < 0 || lineIdx >= lines.length) return false;
    const line = lines[lineIdx];
    let removedText = line.text || 'word';

    if (wordIdx >= 0 && Array.isArray(line.words) && line.words.length > 1 && wordIdx < line.words.length) {
      const [removed] = line.words.splice(wordIdx, 1);
      removedText = removed?.text || removedText;
      line.text = line.words.map((w) => w.text || '').join(' ').trim();
      line.start = Math.min(...line.words.map((w) => Number(w.start ?? 0)));
      line.end = Math.max(...line.words.map((w) => Number(w.end ?? 0)));
    } else {
      lines.splice(lineIdx, 1);
    }

    state.selectedLyricLineIdx = -1;
    state.selectedLyricWordIdx = -1;
    syncLyricsToEngine();
    renderLyricsEditor();
    persistCurrentProjectState();
    markProjectDirty();
    setStatus(`deleted "${removedText}"`);
    return true;
  }

  function highlightLyricLineInEditor(lineIdx, wordIdx = -1, shouldScroll = false) {
    state.selectedLyricLineIdx = lineIdx;
    state.selectedLyricWordIdx = wordIdx;

    if (els.lyricsDelWordBtn) {
      const visible = Boolean(state.showLyricsTimelineBar && (state._lyricsModuleEnabled || (state.project?.lyrics?.lines?.length || 0) > 0));
      const hasSelection = lineIdx >= 0 && lineIdx < (state.project?.lyrics?.lines?.length || 0);
      els.lyricsDelWordBtn.hidden = !(visible && hasSelection);
    }

    if (els.lyricsTimelineTrack) {
      els.lyricsTimelineTrack.querySelectorAll('.lyrics-timeline-word').forEach((el) => {
        const lIdx = parseInt(el.dataset.lineIdx || '-1', 10);
        const wIdx = parseInt(el.dataset.wordIdx || '-1', 10);
        const match = lineIdx >= 0 && lIdx === lineIdx && (wordIdx < 0 || wIdx < 0 || wIdx === wordIdx);
        el.classList.toggle('selected', match);
      });
    }

    if (els.lyricsSection && !els.lyricsSection.hidden && lineIdx >= 0) {
      if (els.lyricsLinesPane?.hidden) {
        setLyricsTab('lines');
      }
      if (els.lyricsLinesList) {
        let targetRow = null;
        els.lyricsLinesList.querySelectorAll('.lyric-line-row').forEach((row) => {
          const rIdx = parseInt(row.dataset.lineIdx || '-1', 10);
          const match = rIdx === lineIdx;
          row.classList.toggle('selected', match);
          if (match) targetRow = row;
        });
        if (shouldScroll && targetRow) {
          targetRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
    }
  }

  function updateLyricsRegroupButtons() {
    const lyrics = state.project?.lyrics || null;
    const hasLines = Array.isArray(lyrics?.lines) && lyrics.lines.length > 0;
    if (els.lyricsRegroupBtn) {
      // visible in words mode too: the click explains that sentence sync is the prerequisite
      els.lyricsRegroupBtn.hidden = !hasLines;
    }
    if (els.lyricsRegroupUndoBtn) {
      const undo = state._lyricsRegroupUndo;
      els.lyricsRegroupUndoBtn.hidden = !undo;
      if (undo) els.lyricsRegroupUndoBtn.title = `restore the grouping from before ${undo.summary}`;
    }
  }

  function renderLyricsRegroupPreview(preview) {
    if (els.lyricsRegroupSummary) {
      els.lyricsRegroupSummary.textContent = [
        `${preview.linesBefore} → ${preview.linesAfter} lines`,
        preview.merged ? `${preview.merged} merged` : '',
        preview.split ? `${preview.split} split` : '',
        preview.shortLines ? `${preview.shortLines} short line${preview.shortLines === 1 ? '' : 's'} kept` : ''
      ].filter(Boolean).join(' · ');
    }
    const list = els.lyricsRegroupList;
    if (!list) return;
    list.innerHTML = '';
    const changed = preview.after.filter((line) => line.sources.length !== 1 || line.sources[0].text !== line.text);
    const unchanged = preview.after.filter((line) => !changed.includes(line));

    changed.forEach((line) => {
      const card = document.createElement('div');
      card.className = 'lyrics-regroup-item';
      const after = document.createElement('div');
      after.className = 'lyrics-regroup-after';
      after.textContent = line.text;
      const from = document.createElement('div');
      from.className = 'lyrics-regroup-from';
      from.textContent = line.sources.length > 1
        ? `merged from ${line.sources.map((s) => `"${s.text}"`).join(' + ')}`
        : `split from "${line.sources[0]?.text || ''}"`;
      const meta = document.createElement('div');
      meta.className = 'lyrics-regroup-meta';
      const words = document.createElement('span');
      words.textContent = `${line.words} words`;
      const dur = document.createElement('span');
      dur.textContent = `${line.duration.toFixed(2)}s`;
      const weight = document.createElement('span');
      weight.className = 'lyrics-regroup-weight';
      weight.textContent = `weight ${line.weight.toFixed(2)}`;
      weight.title = '0.15 = fragment, 1 = full phrase. the camera accent scales by this.';
      const was = document.createElement('span');
      was.textContent = `was ${line.sources.map((s) => s.weight.toFixed(2)).join(' + ')}`;
      was.title = 'weight the affected source line(s) carried before regrouping';
      meta.append(words, dur, weight, was);
      card.append(after, from, meta);
      list.appendChild(card);
    });

    if (unchanged.length > 0) {
      const details = document.createElement('details');
      details.className = 'lyrics-regroup-unchanged';
      const summary = document.createElement('summary');
      summary.textContent = `${unchanged.length} line${unchanged.length === 1 ? '' : 's'} unchanged`;
      const ol = document.createElement('ol');
      unchanged.forEach((line) => {
        const li = document.createElement('li');
        li.textContent = `${line.text} · ${line.duration.toFixed(2)}s · weight ${line.weight.toFixed(2)}`;
        ol.appendChild(li);
      });
      details.append(summary, ol);
      list.appendChild(details);
    }
  }

  function openLyricsRegroupPreview() {
    const lyrics = state.project?.lyrics;
    if (!Array.isArray(lyrics?.lines) || lyrics.lines.length === 0) {
      setLyricsStatus('sync lyrics before regrouping');
      return;
    }
    if (!isLyricsSentenceMode(lyrics)) {
      setLyricsStatus('switch sync granularity to sentences, then regroup');
      return;
    }
    const result = window.lyricsService?.regroupLyricPhrases?.(lyrics);
    if (!result?.preview) {
      setLyricsStatus('nothing to regroup');
      return;
    }
    if (!result.changed) {
      setLyricsStatus(`lines already grouped · ${result.preview.linesAfter} lines, ${result.preview.shortLines} short`);
      return;
    }
    state._lyricsRegroupPreview = result;
    renderLyricsRegroupPreview(result.preview);
    if (typeof els.lyricsRegroupDialog?.showModal === 'function') {
      els.lyricsRegroupDialog.showModal();
    }
  }

  function applyLyricsRegroup() {
    const preview = state._lyricsRegroupPreview;
    if (!preview?.lyrics) return;
    const previous = state.project?.lyrics ? JSON.parse(JSON.stringify(state.project.lyrics)) : null;
    state.project.lyrics = preview.lyrics;
    state.selectedLyricLineIdx = -1;
    state.selectedLyricWordIdx = -1;
    syncLyricsToEngine();
    // set after the sync, which clears any older undo
    state._lyricsRegroupUndo = {
      lyrics: previous,
      summary: `${preview.preview.linesBefore} → ${preview.preview.linesAfter} lines`
    };
    state._lyricsRegroupPreview = null;
    els.lyricsRegroupDialog?.close();
    renderLyricsEditor();
    renderLyricsTimelineBar();
    updateLyricsRegroupButtons();
    persistCurrentProjectState();
    markProjectDirty();
    setLyricsStatus(`regrouped · ${preview.preview.linesBefore} → ${preview.preview.linesAfter} lines · ${preview.preview.merged} merged · ${preview.preview.split} split`);
  }

  function undoLyricsRegroup() {
    const undo = state._lyricsRegroupUndo;
    if (!undo?.lyrics) return;
    state.project.lyrics = undo.lyrics;
    state.selectedLyricLineIdx = -1;
    state.selectedLyricWordIdx = -1;
    syncLyricsToEngine();
    renderLyricsEditor();
    renderLyricsTimelineBar();
    persistCurrentProjectState();
    markProjectDirty();
    setLyricsStatus(`regroup undone · ${undo.summary}`);
  }

  function renderLyricsEditor() {
    if (!els.lyricsLinesList) return;
    els.lyricsLinesList.innerHTML = '';
    const lyricsData = state.project?.lyrics || null;
    const isSentences = isLyricsSentenceMode(lyricsData);
    const unit = isSentences ? 'sentence' : 'word';
    const lines = lyricsData?.lines || [];
    if (els.lyricsCountBadge) {
      els.lyricsCountBadge.textContent = `${lines.length} ${unit}${lines.length === 1 ? '' : 's'}`;
    }
    if (els.lyricsTabLinesBtn) {
      els.lyricsTabLinesBtn.textContent = isSentences ? 'synced sentences' : 'synced words';
    }
    if (lines.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'lyrics-status-line';
      empty.textContent = `no synced ${unit}s yet · transcribe or paste lyrics first`;
      els.lyricsLinesList.appendChild(empty);
      updateLyricsRegroupButtons();
      return;
    }

    lines.forEach((line, idx) => {
      const row = document.createElement('div');
      row.className = 'lyric-line-row';
      if (idx === state.selectedLyricLineIdx) row.classList.add('selected');
      row.dataset.lineIdx = String(idx);

      const mainRow = document.createElement('div');
      mainRow.className = 'lyric-line-main';

      const timeBtn = document.createElement('button');
      timeBtn.type = 'button';
      timeBtn.className = 'lyric-line-time-btn';
      const wStart = line.start || 0;
      const wEnd = line.end || wStart;
      const wLen = Math.max(0, wEnd - wStart);
      timeBtn.textContent = `${wStart.toFixed(2)}–${wEnd.toFixed(2)}s`;
      timeBtn.title = `${wStart.toFixed(2)}s → ${wEnd.toFixed(2)}s (${wLen.toFixed(2)}s) · click to seek playhead to word start`;
      timeBtn.addEventListener('click', () => {
        seekToTime(line.start || 0);
      });

      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.className = 'lyric-line-input';
      textInput.value = line.text || '';
      textInput.addEventListener('change', () => {
        line.text = textInput.value.trim();
        if (Array.isArray(line.words)) {
          if (line.words.length === 1) {
            line.words[0].text = line.text;
          } else if (line.words.length > 1) {
            const tokens = line.text.split(/\s+/).filter(Boolean);
            if (tokens.length === line.words.length) {
              tokens.forEach((tok, ti) => { line.words[ti].text = tok; });
            } else if (tokens.length > 0) {
              const lStart = Number(line.start ?? 0);
              const lEnd = Math.max(lStart + 0.05, Number(line.end ?? lStart + 0.3));
              const step = (lEnd - lStart) / tokens.length;
              line.words = tokens.map((tok, ti) => ({
                text: tok,
                start: Number((lStart + ti * step).toFixed(3)),
                end: Number((lStart + (ti + 1) * step).toFixed(3))
              }));
            }
          }
        }
        syncLyricsToEngine();
        persistCurrentProjectState();
      });

      mainRow.append(timeBtn, textInput);

      const metaRow = document.createElement('div');
      metaRow.className = 'lyric-line-meta';

      const durBadge = document.createElement('span');
      durBadge.className = 'lyric-line-dur';
      durBadge.textContent = `dur ${wLen.toFixed(2)}s`;

      const nudgeGroup = document.createElement('div');
      nudgeGroup.className = 'lyric-nudge-group';

      const inBtn = document.createElement('button');
      inBtn.type = 'button';
      inBtn.className = 'lyric-nudge-btn';
      inBtn.textContent = 'in';
      inBtn.title = 'set word start to current playhead time';
      inBtn.addEventListener('click', () => {
        setLineStartAtTime(line, state.currentTime || 0);
        syncLyricsToEngine();
        renderLyricsEditor();
        renderLyricsTimelineBar();
        persistCurrentProjectState();
      });

      const outBtn = document.createElement('button');
      outBtn.type = 'button';
      outBtn.className = 'lyric-nudge-btn';
      outBtn.textContent = 'out';
      outBtn.title = 'set word end to current playhead time';
      outBtn.addEventListener('click', () => {
        setLineEndAtTime(line, state.currentTime || 0);
        syncLyricsToEngine();
        renderLyricsEditor();
        renderLyricsTimelineBar();
        persistCurrentProjectState();
      });

      const minusBtn = document.createElement('button');
      minusBtn.type = 'button';
      minusBtn.className = 'lyric-nudge-btn';
      minusBtn.textContent = '-0.1';
      minusBtn.title = 'shift word 0.1s earlier';
      minusBtn.addEventListener('click', () => {
        shiftLineTiming(line, -0.1);
        syncLyricsToEngine();
        renderLyricsEditor();
        renderLyricsTimelineBar();
        persistCurrentProjectState();
      });

      const plusBtn = document.createElement('button');
      plusBtn.type = 'button';
      plusBtn.className = 'lyric-nudge-btn';
      plusBtn.textContent = '+0.1';
      plusBtn.title = 'shift word 0.1s later';
      plusBtn.addEventListener('click', () => {
        shiftLineTiming(line, 0.1);
        syncLyricsToEngine();
        renderLyricsEditor();
        renderLyricsTimelineBar();
        persistCurrentProjectState();
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'lyric-nudge-btn lyric-delete-btn';
      delBtn.textContent = 'del';
      delBtn.title = 'delete word';
      delBtn.setAttribute('aria-label', `delete word ${line.text || idx + 1}`);
      delBtn.addEventListener('click', () => {
        deleteLyricWord(idx, -1);
      });

      nudgeGroup.append(inBtn, outBtn, minusBtn, plusBtn, delBtn);
      metaRow.append(durBadge, nudgeGroup);
      row.append(mainRow, metaRow);
      els.lyricsLinesList.appendChild(row);
    });
    updateLyricsRegroupButtons();
  }

  async function decodeCurrentAudioBuffer() {
    if (!state.project?.audioUrl) throw new Error('no audio loaded yet');
    if (state._decodedAudioBuffer && state._decodedAudioUrl === state.project.audioUrl) {
      return state._decodedAudioBuffer;
    }
    const resp = await fetch(state.project.audioUrl);
    if (!resp.ok) throw new Error('could not read audio buffer');
    const arr = await resp.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const decoded = await audioCtx.decodeAudioData(arr);
      state._decodedAudioBuffer = decoded;
      state._decodedAudioUrl = state.project.audioUrl;
      return decoded;
    } finally {
      await audioCtx.close().catch(() => { });
    }
  }

  function resetClipPlaylistState() {
    state.selectedClipIds = [];
    state.selectedClipStartTimes = [];
    state.selectedClipEndTimes = [];
    state.selectedClipSpeeds = [];
    state.playlistsByCutMode = {};
    state._activeCutMode = null;
    state._archivedSelectedClips?.clear?.();
    state.favoriteClips = [];
  }

  function bundleStateHasClips(savedState) {
    if (!savedState || typeof savedState !== 'object') return false;
    if (Array.isArray(savedState.selectedClipIds) && savedState.selectedClipIds.length > 0) return true;
    if (savedState.playlistsByCutMode && typeof savedState.playlistsByCutMode === 'object') {
      for (const entry of Object.values(savedState.playlistsByCutMode)) {
        if (Array.isArray(entry?.ids) && entry.ids.length > 0) return true;
      }
    }
    if (Array.isArray(savedState.customClips) && savedState.customClips.some((c) => Boolean(c && (c.url || c.remoteUrl)))) {
      return true;
    }
    return false;
  }

  function resolveEffectiveBundleState(bundleState, presetProjectState, forceStarter = false) {
    if (forceStarter || !bundleState) return presetProjectState || null;
    // recover starter template clips if an earlier failed load persisted an empty bundle state
    if (!bundleStateHasClips(bundleState) && bundleStateHasClips(presetProjectState)) {
      return {
        ...presetProjectState,
        ...bundleState,
        selectedClipIds: presetProjectState.selectedClipIds,
        selectedClipStartTimes: presetProjectState.selectedClipStartTimes,
        selectedClipEndTimes: presetProjectState.selectedClipEndTimes,
        selectedClipSpeeds: presetProjectState.selectedClipSpeeds,
        playlistsByCutMode: presetProjectState.playlistsByCutMode,
        customClips: presetProjectState.customClips,
        favoriteClips: (Array.isArray(bundleState.favoriteClips) && bundleState.favoriteClips.length > 0)
          ? bundleState.favoriteClips
          : presetProjectState.favoriteClips
      };
    }
    return bundleState;
  }

  async function restoreBundleProjectState(savedState, opts = {}) {
    if (!savedState || !window.projectBundleService) return;
    if (opts?.resetPlaylistBeforeRestore) {
      resetClipPlaylistState();
    }
    const catalogById = new Map(
      (state.clips || [])
        .filter((c) => c && c.id && c.url)
        .map((c) => [c.id, c])
    );
    const hydrateClipUrl = async (c) => {
      if (!c) return c;
      // a blob: url saved into project state belongs to a previous document and is already dead
      const clip = (typeof c.url === 'string' && c.url.startsWith('blob:')) ? { ...c, url: undefined } : c;
      const proxied = typeof clip.url === 'string' && clip.url.startsWith('/api/clips/stream');
      // a cached blob beats the stream proxy: the proxy is not edge-cached, so every seek would
      // round-trip to the origin instead of reading bytes that are already on disk
      if ((!clip.url || proxied) && clip.id && window.projectBundleService?.getCachedClipRecord) {
        const rec = await window.projectBundleService.getCachedClipRecord(clip.id).catch(() => null);
        if (rec?.objectUrl) {
          return { ...clip, url: rec.objectUrl };
        }
      }
      if (!clip.url && clip.id) {
        const cat = catalogById.get(clip.id);
        if (cat?.url) {
          return { ...clip, url: cat.url, ...(!clip.remoteUrl && cat.remoteUrl ? { remoteUrl: cat.remoteUrl } : {}) };
        }
      }
      if (clip.url || !clip.remoteUrl) return clip;
      return { ...clip, url: `/api/clips/stream?url=${encodeURIComponent(clip.remoteUrl)}` };
    };
    if (Array.isArray(savedState.customClips) && savedState.customClips.length > 0) {
      const pickerSaved = [];
      for (const rawClip of savedState.customClips) {
        if (!rawClip || !rawClip.id) continue;
        const c = await hydrateClipUrl(rawClip);
        if (c._archivedFromPicker) {
          state._archivedSelectedClips?.set?.(c.id, c);
        } else if (c.url || c.remoteUrl || !catalogById.has(c.id)) {
          pickerSaved.push(c);
        }
      }
      if (pickerSaved.length > 0) {
        state.clips = mergeClipsIntoList(pickerSaved, state.clips || []);
      }
    }
    if (Array.isArray(savedState.favoriteClips)) {
      state.favoriteClips = await Promise.all(savedState.favoriteClips.map(hydrateClipUrl));
    } else if (Array.isArray(savedState.customClips)) {
      state.favoriteClips = await Promise.all(savedState.customClips.filter((c) => Boolean(c.favorite)).map(hydrateClipUrl));
    } else {
      state.favoriteClips = [];
    }
    if (typeof savedState.clipSource === 'string' && els.clipSourceSelect && ['anime', 'real_life', 'local'].includes(savedState.clipSource)) {
      els.clipSourceSelect.value = savedState.clipSource;
    }
    if (els.clipCustomQueryInput) {
      if (typeof savedState.clipQuery === 'string') {
        els.clipCustomQueryInput.value = savedState.clipQuery.trim();
      }
      if (els.clipSourceSelect) {
        els.clipCustomQueryInput.disabled = (els.clipSourceSelect.value === 'local');
      }
    }
    if (savedState.playlistsByCutMode && typeof savedState.playlistsByCutMode === 'object' && !Array.isArray(savedState.playlistsByCutMode)) {
      const restoredByMode = {};
      for (const [mode, entry] of Object.entries(savedState.playlistsByCutMode)) {
        if (!entry || !Array.isArray(entry.ids)) continue;
        const ids = entry.ids.slice(0, MAX_PLAYLIST_SLOTS);
        const starts = Array.isArray(entry.startTimes) ? entry.startTimes : [];
        const ends = Array.isArray(entry.endTimes) ? entry.endTimes : [];
        const speeds = Array.isArray(entry.speeds) ? entry.speeds : [];
        const normStarts = ids.map((id, i) => (
          starts[i] !== undefined ? normalizeClipStartTime(starts[i]) : normalizeClipStartTime(findClipById(id)?.startTime ?? 0)
        ));
        restoredByMode[mode] = {
          ids,
          startTimes: normStarts,
          endTimes: ids.map((_, i) => (ends[i] !== undefined ? normalizeClipEndTime(ends[i], normStarts[i]) : null)),
          speeds: ids.map((_, i) => (speeds[i] !== undefined ? normalizeClipSpeedPct(speeds[i]) : 100))
        };
      }
      state.playlistsByCutMode = restoredByMode;
    } else if (opts?.resetPlaylistBeforeRestore) {
      state.playlistsByCutMode = {};
    }
    const activeModeOnRestore = getActiveCutMode();
    if (Array.isArray(savedState.selectedClipIds)) {
      state.selectedClipIds = savedState.selectedClipIds.slice(0, MAX_PLAYLIST_SLOTS);
      const savedStarts = Array.isArray(savedState.selectedClipStartTimes) ? savedState.selectedClipStartTimes : [];
      const savedEnds = Array.isArray(savedState.selectedClipEndTimes) ? savedState.selectedClipEndTimes : [];
      const savedSpeeds = Array.isArray(savedState.selectedClipSpeeds) ? savedState.selectedClipSpeeds : [];
      state.selectedClipStartTimes = state.selectedClipIds.map((id, i) => (
        savedStarts[i] !== undefined
          ? normalizeClipStartTime(savedStarts[i])
          : normalizeClipStartTime(findClipById(id)?.startTime ?? 0)
      ));
      state.selectedClipEndTimes = state.selectedClipIds.map((_, i) => (
        savedEnds[i] !== undefined ? normalizeClipEndTime(savedEnds[i], state.selectedClipStartTimes[i]) : null
      ));
      state.selectedClipSpeeds = state.selectedClipIds.map((_, i) => (
        savedSpeeds[i] !== undefined ? normalizeClipSpeedPct(savedSpeeds[i]) : 100
      ));
      savePlaylistForCutMode(activeModeOnRestore);
    } else if (state.playlistsByCutMode?.[activeModeOnRestore]) {
      applyPlaylistSnapshot(state.playlistsByCutMode[activeModeOnRestore]);
      state._activeCutMode = activeModeOnRestore;
    } else if (opts?.resetPlaylistBeforeRestore) {
      state.selectedClipIds = [];
      state.selectedClipStartTimes = [];
      state.selectedClipEndTimes = [];
      state.selectedClipSpeeds = [];
    }
    syncVideoPoolSources();
    renderClipGrid();
    renderFavoritesGrid();

    if (savedState.audioAsset?.blob && savedState.audioAsset.blob.size > 0) {
      showProjectLoading('decoding audio & midi...');
      await yieldToPaint();
      const audioName = savedState.audioAsset.name || savedState.audioFileName || 'restored.wav';
      const audioFile = new File([savedState.audioAsset.blob], audioName, {
        type: savedState.audioAsset.mimeType || 'audio/wav'
      });
      const files = [audioFile];
      if (savedState.midiAsset?.blob && savedState.midiAsset.blob.size > 0) {
        const midiName = savedState.midiAsset.name || savedState.midiFileName || 'restored.mid';
        files.push(new File([savedState.midiAsset.blob], midiName));
      }
      await handleSampleFiles(files);
    }

    if (savedState.projectMeta) {
      if (savedState.projectMeta.brand !== undefined) els.inputBrand.value = savedState.projectMeta.brand || '';
      if (savedState.projectMeta.sampleNumber !== undefined) els.inputNumber.value = savedState.projectMeta.sampleNumber || '';
      if (savedState.projectMeta.title !== undefined) els.inputTitle.value = savedState.projectMeta.title || '';
      if (savedState.projectMeta.bpm) els.inputBpm.value = savedState.projectMeta.bpm;
      if (savedState.projectMeta.key !== undefined) els.inputKey.value = savedState.projectMeta.key || '';

      if (state.project) {
        if (Number.isFinite(Number(savedState.projectMeta.dropBar))) {
          state.project.dropBar = Number(savedState.projectMeta.dropBar);
          if (visualizer?.project) visualizer.project.dropBar = state.project.dropBar;
        }
        if (Number.isFinite(Number(savedState.projectMeta.dropTime))) {
          state.project.dropTime = Number(savedState.projectMeta.dropTime);
          if (visualizer?.project) visualizer.project.dropTime = state.project.dropTime;
        }
        let trackUiNeedsRefresh = false;
        if (Array.isArray(savedState.projectMeta.selectedTrackIds) && visualizer?.selectedTrackIds) {
          visualizer.selectedTrackIds = new Set(savedState.projectMeta.selectedTrackIds);
          trackUiNeedsRefresh = true;
        }
        const savedTrackLoops = savedState.projectMeta.trackLoopStates;
        if (savedTrackLoops && typeof savedTrackLoops === 'object' && Array.isArray(state.project.tracks)) {
          let touchedLoop = false;
          state.project.tracks.forEach((tr) => {
            if (tr && typeof savedTrackLoops[tr.id] === 'boolean') {
              tr.loopMidi = savedTrackLoops[tr.id];
              touchedLoop = true;
            }
          });
          if (touchedLoop) {
            visualizer?.rebuildNoteNodes?.();
            trackUiNeedsRefresh = true;
          }
        }
        if (trackUiNeedsRefresh) {
          renderTrackList();
        }
        updateMetadataToVisualizer();
        drawWaveform();
        if (Array.isArray(savedState.projectMeta.impactTimes) && savedState.projectMeta.impactTimesEdited) {
          syncImpactTimesToEngine(savedState.projectMeta.impactTimes, { mode: 'impact', edited: true, skipPersist: true });
        }
        if (Array.isArray(savedState.projectMeta.customCutTimes)) {
          syncImpactTimesToEngine(savedState.projectMeta.customCutTimes, { mode: 'custom', edited: true, skipPersist: true });
        }
        const restoredCues = savedState.projectMeta.customCues || savedState.projectMeta._customCues;
        if (restoredCues && typeof restoredCues === 'object' && !Array.isArray(restoredCues)) {
          syncCustomCuesToEngine(restoredCues, { skipPersist: true });
        }
        visualizer?.renderFrame?.(state.currentTime, getActiveVideoForTime(state.currentTime));
      } else if (els.headerPreviewTag && (savedState.projectMeta.title || savedState.projectMeta.brand || savedState.projectMeta.sampleNumber)) {
        const num = savedState.projectMeta.sampleNumber ? `#${String(savedState.projectMeta.sampleNumber).replace(/^#?\s*0*/, '') || '1'} - ` : '';
        const brandPart = savedState.projectMeta.brand ? ` · ${savedState.projectMeta.brand}` : '';
        els.headerPreviewTag.textContent = `[${num}${savedState.projectMeta.title || 'untitled'}${brandPart}]`;
      }
    }

    if (savedState.lyricsData && state.project) {
      state.project.lyrics = savedState.lyricsData;
      if (els.lyricsPasteInput && savedState.lyricsData.rawText) {
        els.lyricsPasteInput.value = savedState.lyricsData.rawText;
      }
      if (els.lyricsGranularitySelect) {
        els.lyricsGranularitySelect.value = isLyricsSentenceMode(savedState.lyricsData) ? 'sentences' : 'words';
      }
      syncLyricsToEngine();
      renderLyricsEditor();
      renderLyricsTimelineBar();
      setLyricsStatus(`restored ${savedState.lyricsData.lines?.length || 0} synced ${isLyricsSentenceMode(savedState.lyricsData) ? 'sentences' : 'words'}`);
    }
    if (!savedState.projectMeta || !state.project) {
      visualizer?.renderFrame?.(state.currentTime, getActiveVideoForTime(state.currentTime));
    }
  }

  function loadProjectIntoStudio(project, clips, opts = {}) {
    if (project && (!project.chordTimelineMarkers || project.chordTimelineMarkers.length === 0)) {
      if (window.clientAnalyzer && typeof window.clientAnalyzer.computeChordTimelineMarkers === 'function') {
        project.chordTimelineMarkers = window.clientAnalyzer.computeChordTimelineMarkers(project);
      }
    }
    if (project && (!Array.isArray(project.sections) || project.sections.length === 0)) {
      if (window.clientAnalyzer && typeof window.clientAnalyzer.detectTrackSections === 'function') {
        project.sections = window.clientAnalyzer.detectTrackSections(project);
      }
    }
    if (project) {
      const normalizedImpacts = normalizeImpactTimes(project.impactTimes, project.duration || 30.0);
      project.impactTimes = normalizedImpacts;
      if (!Array.isArray(project._defaultImpactTimes)) {
        project._defaultImpactTimes = [...normalizedImpacts];
      }
      project._impactTimesEdited = Boolean(project._impactTimesEdited);
      project.customCutTimes = normalizeImpactTimes(project.customCutTimes, project.duration || 30.0);
      if (!project._customCues || typeof project._customCues !== 'object') {
        project._customCues = {};
      }
    }
    state.project = project;
    if (clips) {
      state.clips = mergeClipsIntoList(clips, []);
    }

    els.inputBrand.value = project.brand || '';
    els.inputNumber.value = project.sampleNumber || '';
    els.inputTitle.value = project.title || 'untitled';
    els.inputBpm.value = project.bpm || 120;
    els.inputKey.value = project.key || '';

    syncProjectHeaderTags(project);

    if (visualizer) {
      if (typeof visualizer.setProject === 'function') {
        visualizer.setProject(project);
      }
      if (typeof visualizer.setLyricsData === 'function') {
        visualizer.setLyricsData(project.lyrics || null);
      }
      if (typeof visualizer.setActiveVideos === 'function') {
        visualizer.setActiveVideos(videoPool);
      }
    }

    if (els.lyricsGranularitySelect && project?.lyrics) {
      els.lyricsGranularitySelect.value = isLyricsSentenceMode(project.lyrics) ? 'sentences' : 'words';
    }
    renderLyricsEditor();
    renderLyricsTimelineBar();

    if (project.audioUrl) {
      if (audioEl.src !== project.audioUrl) {
        if (project.audioUrl.startsWith('blob:')) {
          audioEl.removeAttribute('crossorigin');
        } else {
          audioEl.crossOrigin = 'anonymous';
        }
        audioEl.src = project.audioUrl;
        audioEl.currentTime = 0;
      }
    }
    state.currentTime = 0;

    if (!opts?.skipVideoSync) {
      syncVideoPoolSources();
      renderClipGrid();
      renderFavoritesGrid();
    }
    renderTrackList();
    drawWaveform();
    updateTransportReadouts(0);
    if (!opts?.skipVideoSync && visualizer && typeof visualizer.renderFrame === 'function') {
      visualizer.renderFrame(state.currentTime, getActiveVideoForTime(state.currentTime));
    }
  }

  function seekVideoSafely(vid, targetTime, force = false) {
    if (!vid || !Number.isFinite(targetTime)) return;
    const rawDur = vid.duration;
    const maxSeek = (Number.isFinite(rawDur) && rawDur > 0.002) ? rawDur - 0.001 : Math.max(0, targetTime);
    const clamped = Math.max(0, Math.min(maxSeek, targetTime));
    const tol = force ? 0.02 : 0.05;
    if (Math.abs((vid.currentTime || 0) - clamped) <= tol) {
      vid._pendingSeekTime = null;
      return;
    }
    if (vid.seeking) {
      vid._pendingSeekTime = clamped;
      return;
    }
    vid._pendingSeekTime = null;
    try { vid.currentTime = clamped; } catch { }
  }

  function syncVideosToTime(t, { forceSeek = false } = {}) {
    const activeSlot = getActivePlaylistSlotForTime(t);
    const activeVid = activeSlot >= 0 ? getVideoForPlaylistSlot(activeSlot) : null;
    updateActivePlaylistSlotHighlight(activeSlot);

    const startAtDrop = visualizer?.modules?.clips?.startAtDrop === true || visualizer?.id === 'constellations';
    const isAfterDrop = !startAtDrop || t >= getProjectDropTime();
    const shouldPlayVid = Boolean(
      state.isPlaying
      && !state.scrubbingWaveform
      && !audioEl.paused
      && activeVid
      && isAfterDrop
    );

    if (activeVid && isAfterDrop) {
      const cutStartTime = getCutStartTimeForTimestamp(t);
      const clipTime = getClipTimeForTimestamp(t, activeVid);
      const switched = Boolean(
        forceSeek
        || state._forceVideoSync
        || state.lastActiveVid !== activeVid
        || state._lastCutStartTime !== cutStartTime
      );
      state.lastActiveVid = activeVid;
      state._lastCutStartTime = cutStartTime;

      if (shouldPlayVid) {
        const slotDur = activeVid.duration || 6.0;
        const slotStart = normalizeClipStartTime(activeVid.dataset?.startTime || 0, slotDur);
        const rawEnd = parseFloat(activeVid.dataset?.endTime || '');
        const slotEnd = (Number.isFinite(rawEnd) && rawEnd > slotStart + 0.1) ? Math.min(slotDur, rawEnd) : slotDur;
        if ((switched || Math.abs((activeVid.currentTime || 0) - clipTime) > 0.18) && Number.isFinite(clipTime)) {
          seekVideoSafely(activeVid, clipTime, true);
        } else if (slotEnd < slotDur - 0.05 && (activeVid.currentTime >= slotEnd || activeVid.currentTime < slotStart - 0.05)) {
          seekVideoSafely(activeVid, slotStart, true);
        }
        if (activeVid.paused) {
          activeVid.play().catch(() => { });
        }
        const slotSpeedMult = normalizeClipSpeedPct(activeVid.dataset?.speedPct || 100) / 100;
        if (visualizer?.params?.speedRamping && typeof visualizer.getSpeedRampInfo === 'function') {
          const ramp = visualizer.getSpeedRampInfo(t);
          activeVid.playbackRate = Math.max(0.25, Math.min(4.0, ramp.instSpeed * slotSpeedMult));
        } else if (Math.abs(activeVid.playbackRate - slotSpeedMult) > 0.01) {
          activeVid.playbackRate = Math.max(0.25, Math.min(4.0, slotSpeedMult));
        }
      } else {
        if (!activeVid.paused) activeVid.pause();
        if (Number.isFinite(clipTime)) {
          seekVideoSafely(activeVid, clipTime, forceSeek || state._forceVideoSync || switched);
        }
      }

      videoPool.forEach((v) => {
        if (v !== activeVid && !v.paused) v.pause();
      });
    } else {
      videoPool.forEach((v) => {
        if (!v.paused) v.pause();
      });
    }

    const auxVideos = typeof visualizer?.getMediaSlotElements === 'function'
      ? visualizer.getMediaSlotElements('video')
      : [];
    const shouldPlayAux = Boolean(state.isPlaying && !state.scrubbingWaveform && !audioEl.paused);
    for (const sv of auxVideos) {
      if (!sv._hasDetSeekListener) {
        sv._hasDetSeekListener = true;
        sv.addEventListener('seeked', () => {
          if (Number.isFinite(sv._pendingSeekTime) && Math.abs((sv.currentTime || 0) - sv._pendingSeekTime) > 0.04) {
            const nextTarget = sv._pendingSeekTime;
            sv._pendingSeekTime = null;
            try { sv.currentTime = nextTarget; } catch { }
            return;
          }
          sv._pendingSeekTime = null;
          state._needsRender = true;
          visualizer?.invalidateLoopCache?.();
          visualizer?.loopCache?.invalidate?.();
          visualizer?.engine?.loopCache?.invalidate?.();
        });
      }
      const svDur = (Number.isFinite(sv.duration) && sv.duration > 0.05) ? sv.duration : 0;
      const svTarget = svDur > 0 ? (Math.max(0, t) % svDur) : Math.max(0, t);
      if (shouldPlayAux) {
        if (forceSeek || state._forceVideoSync || Math.abs((sv.currentTime || 0) - svTarget) > 0.22) {
          seekVideoSafely(sv, svTarget, true);
        }
        if (sv.paused) sv.play().catch(() => { });
      } else {
        if (!sv.paused) sv.pause();
        seekVideoSafely(sv, svTarget, forceSeek || state._forceVideoSync);
      }
    }

    state._forceVideoSync = false;
    return { activeSlot, activeVid, shouldPlayVid };
  }

  function seekToTime(targetTime, { fromScrub = false } = {}) {
    const dur = state.project?.duration || 30.0;
    const clampedT = Math.max(0, Math.min(dur, Number(targetTime) || 0));
    state.currentTime = clampedT;
    if (!fromScrub || audioEl.paused) {
      try { audioEl.currentTime = clampedT; } catch { }
    }
    state._forceVideoSync = true;
    state._needsRender = true;
    updateTransportReadouts(clampedT);
    const { activeVid } = syncVideosToTime(clampedT, { forceSeek: true });
    visualizer?.invalidateLoopCache?.();
    visualizer?.loopCache?.invalidate?.();
    visualizer?.engine?.loopCache?.invalidate?.();
    if (visualizer && typeof visualizer.renderFrame === 'function') {
      visualizer.renderFrame(clampedT, activeVid);
      state._lastRenderedTime = clampedT;
      state._lastRenderedVid = activeVid;
      state._lastRenderedVidTime = activeVid ? (activeVid.currentTime || 0) : -1;
      state._needsRender = false;
    }
  }

  // 60fps preview loop
  function tick() {
    if (!state.isRendering) {
      if (state.isPlaying && !audioEl.paused) {
        const dur = state.project?.duration || 29.09;
        if (audioEl.currentTime >= dur || audioEl.ended) {
          audioEl.currentTime = 0;
          state.currentTime = 0;
          state._forceVideoSync = true;
          state._needsRender = true;
        } else {
          state.currentTime = audioEl.currentTime;
        }
      }
      updateTransportReadouts(state.currentTime);
      if (visualizer && typeof visualizer.setPlaying === 'function') {
        visualizer.setPlaying(state.isPlaying && !audioEl.paused);
      }
      const { activeVid, shouldPlayVid } = syncVideosToTime(state.currentTime);
      const shouldRender = Boolean(
        shouldPlayVid
        || state.isPlaying
        || state._needsRender
        || Math.abs(state.currentTime - state._lastRenderedTime) > 1e-5
        || state._lastRenderedVid !== activeVid
        || (activeVid && !activeVid.seeking && Math.abs((activeVid.currentTime || 0) - state._lastRenderedVidTime) > 0.005)
      );
      if (shouldRender && visualizer && typeof visualizer.renderFrame === 'function') {
        visualizer.renderFrame(state.currentTime, activeVid);
        state._lastRenderedTime = state.currentTime;
        state._lastRenderedVid = activeVid;
        state._lastRenderedVidTime = activeVid ? (activeVid.currentTime || 0) : -1;
        state._needsRender = false;
        if (previewRate) previewRate.renders += 1;
      }
      trackPreviewRate();
    }
    requestAnimationFrame(tick);
  }

  /**
   * Ticks per second, and how many of them asked for a frame. The two differ when the host loop is
   * the cost, which is indistinguishable from a slow renderer without the pair.
   */
  let previewRate = null;
  function trackPreviewRate() {
    const now = performance.now();
    if (!previewRate) {
      previewRate = { since: now, ticks: 0, renders: 0 };
      return;
    }
    previewRate.ticks += 1;
    if (now - previewRate.since < 2000) return;
    const seconds = (now - previewRate.since) / 1000;
    if (state.isPlaying) {
      const mode = document.documentElement.dataset.renderer || 'canvas';
      console.info(`[preview ${mode}] ${Math.round(previewRate.ticks / seconds)} hz · ${Math.round(previewRate.renders / seconds)} frames/s`);
    }
    previewRate = { since: now, ticks: 0, renders: 0 };
  }

  /**
   * Readers of #previewCanvas (save thumbnails, project copies) need current pixels. A sandboxed
   * preview paints in its own frame, so the host canvas only catches up on a captured render.
   */
  async function refreshPreviewCanvas(time = state.currentTime || 0) {
    if (!visualizer) return;
    if (typeof visualizer.renderFrameAwait === 'function') {
      try {
        await visualizer.renderFrameAwait(time, getActiveVideoForTime(time) || null);
      } catch (err) {
        console.warn('[preview] capture failed', err);
      }
      return;
    }
    if (typeof visualizer.renderFrame === 'function') {
      visualizer.renderFrame(time, getActiveVideoForTime(time));
    }
  }

  els.playPauseBtn.addEventListener('click', () => {
    if (state.isPlaying) {
      audioEl.pause();
      state.isPlaying = false;
      els.playPauseBtn.textContent = 'play';
      videoPool.forEach((v) => {
        if (!v.paused) v.pause();
      });
      if (typeof visualizer?.getMediaSlotElements === 'function') {
        visualizer.getMediaSlotElements('video').forEach((sv) => {
          if (!sv.paused) sv.pause();
        });
      }
      state._forceVideoSync = true;
      state._needsRender = true;
      syncVideosToTime(state.currentTime, { forceSeek: true });
    } else {
      state._forceVideoSync = true;
      state._needsRender = true;
      audioEl.play().catch(() => { });
      state.isPlaying = true;
      els.playPauseBtn.textContent = 'pause';
    }
  });

  els.jumpDropBtn.addEventListener('click', () => {
    const markers = getActiveTimelineMarkers();
    if (markers.length === 0) return;
    const targetMarker = markers.length === 1
      ? markers[0]
      : (markers.find((m) => m.time > state.currentTime + 0.2) || markers[0]);
    const leadIn = markers.length > 1 ? Math.min(1.5, Math.max(0.5, targetMarker.time)) : 2.2;
    const target = Math.max(0, targetMarker.time - leadIn);
    seekToTime(target);
    if (!state.isPlaying) {
      els.playPauseBtn.click();
    }
  });

  // waveform seek, impact cuts & multi-marker drag
  if (els.impactCutsToolbar && !('focusGroup' in HTMLElement.prototype)) {
    const toolbarItems = Array.from(els.impactCutsToolbar.querySelectorAll('button'));
    toolbarItems.forEach((btn, idx) => {
      btn.tabIndex = idx === 0 ? 0 : -1;
    });
    els.impactCutsToolbar.addEventListener('focusin', ({ target }) => {
      if (toolbarItems.includes(target)) {
        toolbarItems.forEach((b) => {
          b.tabIndex = b === target ? 0 : -1;
        });
      }
    });
    els.impactCutsToolbar.addEventListener('keydown', (e) => {
      const curIdx = toolbarItems.indexOf(document.activeElement);
      if (curIdx < 0) return;
      const rtl = getComputedStyle(els.impactCutsToolbar).direction === 'rtl';
      let nextIdx = -1;
      if (e.key === 'ArrowRight') nextIdx = (curIdx + (rtl ? -1 : 1) + toolbarItems.length) % toolbarItems.length;
      else if (e.key === 'ArrowLeft') nextIdx = (curIdx + (rtl ? 1 : -1) + toolbarItems.length) % toolbarItems.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = toolbarItems.length - 1;
      if (nextIdx >= 0) {
        e.preventDefault();
        toolbarItems[nextIdx].focus();
      }
    });
  }

  if (els.addImpactCutBtn) {
    els.addImpactCutBtn.addEventListener('click', () => {
      addImpactCutAt(state.currentTime || 0);
    });
  }

  if (els.resetImpactCutsBtn) {
    els.resetImpactCutsBtn.addEventListener('click', () => {
      if (els.resetImpactCutsBtn.getAttribute('aria-disabled') === 'true') return;
      resetImpactCutsToAuto();
    });
  }

  if (els.impactCutsLayer) {
    els.impactCutsLayer.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.impact-cut-remove')) return;
      const markerEl = e.target.closest('.impact-cut-marker');
      if (!markerEl) return;
      const idx = parseInt(markerEl.dataset.impactIdx || '-1', 10);
      if (idx < 0) return;
      e.stopPropagation();
      state.draggingImpactIdx = idx;
      state._impactDragMoved = false;
      markerEl.classList.add('dragging');
    });

    els.impactCutsLayer.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.impact-cut-remove');
      if (removeBtn) {
        e.stopPropagation();
        const markerEl = removeBtn.closest('.impact-cut-marker');
        const idx = parseInt(markerEl?.dataset.impactIdx || '-1', 10);
        if (idx >= 0) removeImpactCutAtIndex(idx);
        return;
      }
      const markerEl = e.target.closest('.impact-cut-marker');
      if (!markerEl || !state.project) return;
      e.stopPropagation();
      const idx = parseInt(markerEl.dataset.impactIdx || '-1', 10);
      const ct = state.project.impactTimes?.[idx];
      if (Number.isFinite(ct)) {
        seekToTime(ct);
      }
    });

    els.impactCutsLayer.addEventListener('contextmenu', (e) => {
      const markerEl = e.target.closest('.impact-cut-marker');
      if (!markerEl) return;
      e.preventDefault();
      e.stopPropagation();
      const idx = parseInt(markerEl.dataset.impactIdx || '-1', 10);
      if (idx >= 0) removeImpactCutAtIndex(idx);
    });

    els.impactCutsLayer.addEventListener('keydown', (e) => {
      const handleEl = e.target.closest('.impact-cut-handle');
      if (!handleEl || !state.project || !Array.isArray(state.project.impactTimes)) return;
      const markerEl = handleEl.closest('.impact-cut-marker');
      const idx = parseInt(markerEl?.dataset.impactIdx || '-1', 10);
      if (idx < 0 || idx >= state.project.impactTimes.length) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeImpactCutAtIndex(idx);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 0.1 : 0.02;
        const dur = state.project.duration || 30.0;
        const nextT = Number(Math.max(0, Math.min(dur, state.project.impactTimes[idx] + (e.key === 'ArrowRight' ? step : -step))).toFixed(3));
        const next = [...state.project.impactTimes];
        next[idx] = nextT;
        syncImpactTimesToEngine(next, { edited: true });
        const refocused = els.impactCutsLayer.querySelector(`.impact-cut-marker .impact-cut-handle`);
        const matching = Array.from(els.impactCutsLayer.querySelectorAll('.impact-cut-marker')).find((node) => {
          const nIdx = parseInt(node.dataset.impactIdx || '-1', 10);
          return nIdx >= 0 && Math.abs((state.project.impactTimes[nIdx] ?? -1) - nextT) < 0.002;
        });
        (matching?.querySelector('.impact-cut-handle') || refocused)?.focus();
      }
    });
  }

  if (els.timelineMarkersLayer) {
    els.timelineMarkersLayer.addEventListener('mousedown', (e) => {
      const lineEl = e.target.closest('.drop-marker-line');
      if (!lineEl || !lineEl.dataset.markerId) return;
      e.stopPropagation();
      state.draggingMarkerId = lineEl.dataset.markerId;
      lineEl.classList.add('dragging');
    });
  }

  if (els.markerCategoriesToolbar) {
    els.markerCategoriesToolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('.marker-category-toggle');
      if (!btn || !btn.dataset.cueCat) return;
      const catId = btn.dataset.cueCat;
      const nextVis = !isCueCategoryVisible(catId);
      state.visibleCueCategories[catId] = nextVis;
      if (nextVis) {
        state.activeCueCategoryId = catId;
      } else if (state.activeCueCategoryId === catId) {
        state.activeCueCategoryId = null;
      }
      renderCustomCuesUi();
      announceCustomCueStatus(`${catId} markers ${nextVis ? 'shown' : 'hidden'}`);
    });
  }

  if (els.customCuesCatList) {
    els.customCuesCatList.addEventListener('click', (e) => {
      const btn = e.target.closest('.custom-cue-cat-btn');
      if (!btn || !btn.dataset.cueCat) return;
      state.activeCueCategoryId = btn.dataset.cueCat;
      state.visibleCueCategories[btn.dataset.cueCat] = true;
      renderCustomCuesUi();
      announceCustomCueStatus(`editing ${btn.dataset.cueCat} markers`);
    });
  }

  if (els.addCustomCueBtn) {
    els.addCustomCueBtn.addEventListener('click', () => {
      const activeCat = getActiveCueCategory();
      if (activeCat) addCustomCueAt(activeCat.id, state.currentTime || 0);
    });
  }

  if (els.clearCustomCuesBtn) {
    els.clearCustomCuesBtn.addEventListener('click', () => {
      if (els.clearCustomCuesBtn.getAttribute('aria-disabled') === 'true') return;
      const activeCat = getActiveCueCategory();
      if (activeCat) clearCustomCuesForCategory(activeCat.id);
    });
  }

  if (els.customCuesLayer) {
    els.customCuesLayer.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !state.project) return;
      if (e.target.closest('.custom-cue-remove')) return;
      const cueEl = e.target.closest('.custom-cue-point, .custom-cue-range');
      if (!cueEl) return;
      const catId = cueEl.dataset.cueCat;
      const idx = parseInt(cueEl.dataset.cueIdx || '-1', 10);
      const { categories, byCategory } = getNormalizedCustomCuesMap();
      const cat = categories.find((c) => c.id === catId);
      const cue = byCategory[catId]?.[idx];
      if (!cat || !cue) return;
      e.stopPropagation();

      const edgeBtn = e.target.closest('.custom-cue-edge-handle');
      const mode = (cat.kind === 'range' && edgeBtn)
        ? (edgeBtn.dataset.edge === 'start' ? 'start' : 'end')
        : 'move';
      state.activeCueCategoryId = catId;
      state.draggingCustomCue = {
        catId,
        kind: cat.kind,
        index: idx,
        mode,
        startX: e.clientX,
        origTime: cue.time,
        origDuration: cue.duration
      };
      state._customCueDragMoved = false;
      cueEl.classList.add('dragging');
    });

    els.customCuesLayer.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.custom-cue-remove');
      if (removeBtn) {
        e.stopPropagation();
        const cueEl = removeBtn.closest('.custom-cue-point, .custom-cue-range');
        const catId = cueEl?.dataset.cueCat;
        const idx = parseInt(cueEl?.dataset.cueIdx || '-1', 10);
        if (catId && idx >= 0) removeCustomCueAt(catId, idx);
        return;
      }
      const cueEl = e.target.closest('.custom-cue-point, .custom-cue-range');
      if (!cueEl || !state.project) return;
      e.stopPropagation();
      const catId = cueEl.dataset.cueCat;
      const idx = parseInt(cueEl.dataset.cueIdx || '-1', 10);
      const { byCategory } = getNormalizedCustomCuesMap();
      const cue = byCategory[catId]?.[idx];
      if (!cue) return;
      state.activeCueCategoryId = catId;
      seekToTime(cue.time);
    });

    els.customCuesLayer.addEventListener('contextmenu', (e) => {
      const cueEl = e.target.closest('.custom-cue-point, .custom-cue-range');
      if (!cueEl) return;
      e.preventDefault();
      e.stopPropagation();
      const catId = cueEl.dataset.cueCat;
      const idx = parseInt(cueEl.dataset.cueIdx || '-1', 10);
      if (catId && idx >= 0) removeCustomCueAt(catId, idx);
    });

    els.customCuesLayer.addEventListener('keydown', (e) => {
      const focusTarget = e.target.closest('.custom-cue-handle, .custom-cue-edge-handle');
      if (!focusTarget || !state.project) return;
      const cueEl = focusTarget.closest('.custom-cue-point, .custom-cue-range');
      const catId = cueEl?.dataset.cueCat;
      const idx = parseInt(cueEl?.dataset.cueIdx || '-1', 10);
      const { categories, byCategory } = getNormalizedCustomCuesMap();
      const cat = categories.find((c) => c.id === catId);
      const list = byCategory[catId];
      if (!cat || !Array.isArray(list) || idx < 0 || idx >= list.length) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeCustomCueAt(catId, idx);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = (e.shiftKey ? 0.1 : 0.02) * (e.key === 'ArrowRight' ? 1 : -1);
        const dur = Math.max(0.1, state.project.duration || 30.0);
        const cur = list[idx];
        const nextList = list.map((item) => ({ ...item }));
        const minSpan = Math.min(0.05, dur * 0.25);
        if (cat.kind === 'range' && focusTarget.dataset.edge === 'end') {
          nextList[idx].duration = Number(Math.max(minSpan, Math.min(dur - cur.time, cur.duration + step)).toFixed(3));
        } else if (cat.kind === 'range' && focusTarget.dataset.edge === 'start') {
          const endT = cur.time + cur.duration;
          const nextStart = Number(Math.max(0, Math.min(endT - minSpan, cur.time + step)).toFixed(3));
          nextList[idx].time = nextStart;
          nextList[idx].duration = Number(Math.max(minSpan, endT - nextStart).toFixed(3));
        } else {
          const maxT = Math.max(0, dur - (cat.kind === 'range' ? cur.duration : 0.02));
          nextList[idx].time = Number(Math.max(0, Math.min(maxT, cur.time + step)).toFixed(3));
        }
        syncCustomCuesToEngine({ ...(state.project._customCues || {}), [catId]: nextList });
      }
    });
  }

  if (!globalThis.CommandEvent) {
    globalThis.CommandEvent = class CommandEvent extends Event {
      constructor(type, { source, command, ...options } = {}) {
        super(type, options);
        this.source = source;
        this.command = command;
      }
    };
    document.addEventListener('click', (event) => {
      const button = event.composedPath().find((el) => el.matches?.('button[commandfor]'));
      if (!button) return;
      const target = document.getElementById(button.getAttribute('commandfor'));
      const command = button.getAttribute('command');
      if (target && command) {
        target.dispatchEvent(new globalThis.CommandEvent('command', {
          command,
          source: button
        }));
      }
    });
  }

  if (els.lyricsCutOverlapsBtn) {
    els.lyricsCutOverlapsBtn.addEventListener('click', () => {
      if (!state.project) return;
      const cuts = cutOverlappingLyricsWords();
      if (cuts > 0) {
        syncLyricsToEngine();
        renderLyricsEditor();
        persistCurrentProjectState();
        markProjectDirty();
        setStatus(`cut ${cuts} overlap${cuts === 1 ? '' : 's'} at midpoint`);
      } else {
        setStatus('no overlapping words found');
      }
    });
  }

  function submitAddLyricWordInput() {
    if (!els.lyricsAddWordInput) return;
    const text = els.lyricsAddWordInput.value.trim();
    if (!text) {
      els.lyricsAddWordInput.focus();
      return;
    }
    if (insertLyricWord(text, state.currentTime || 0)) {
      els.lyricsAddWordInput.value = '';
    }
  }

  if (els.lyricsAddWordSubmitBtn) {
    els.lyricsAddWordSubmitBtn.addEventListener('click', submitAddLyricWordInput);
  }

  if (els.lyricsAddWordInput) {
    els.lyricsAddWordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitAddLyricWordInput();
      }
    });
  }

  if (els.lyricsAddWordBtn) {
    els.lyricsAddWordBtn.addEventListener('click', () => {
      if (!state.project) return;
      if (els.lyricsSection && !els.lyricsSection.hidden) {
        setLyricsTab('lines');
        els.lyricsAddWordInput?.focus();
      } else {
        insertLyricWord('word', state.currentTime || 0);
      }
    });
  }

  if (els.lyricsDelWordBtn) {
    els.lyricsDelWordBtn.addEventListener('click', () => {
      if (!state.project || state.selectedLyricLineIdx < 0) return;
      deleteLyricWord(state.selectedLyricLineIdx, state.selectedLyricWordIdx);
    });
  }

  if (els.lyricsTimelineBar) {
    els.lyricsTimelineBar.addEventListener('command', (event) => {
      if (event.command === '--toggle-lyrics-bar') {
        state.showLyricsTimelineBar = !state.showLyricsTimelineBar;
        updateLyricsTimelineVisibility();
        if (state.showLyricsTimelineBar) {
          renderLyricsTimelineBar();
        }
      }
    });

    els.lyricsTimelineBar.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !state.project) return;
      const edgeEl = e.target.closest('.lyrics-word-edge');
      const chipEl = (edgeEl || e.target).closest('.lyrics-timeline-word');
      if (!chipEl) return;
      const lineIdx = parseInt(chipEl.dataset.lineIdx || '-1', 10);
      const wordIdx = parseInt(chipEl.dataset.wordIdx || '-1', 10);
      if (lineIdx < 0) return;

      const line = state.project.lyrics?.lines?.[lineIdx];
      const word = (wordIdx >= 0 && Array.isArray(line?.words)) ? line.words[wordIdx] : null;
      const item = word || line;
      if (!item) return;

      e.stopPropagation();
      e.preventDefault();

      if (edgeEl) {
        const edge = edgeEl.dataset.edge === 'start' ? 'start' : 'end';
        state.draggingLyricWord = { mode: 'trim', lineIdx, wordIdx, edge };
        state._lyricWordDragMoved = false;
        chipEl.classList.add('dragging');
      } else {
        const origStart = Number(item.start ?? 0);
        const origEnd = Number(item.end ?? origStart + 0.2);
        state.draggingLyricWord = {
          mode: 'move',
          lineIdx,
          wordIdx,
          startX: e.clientX,
          origStart,
          spanSec: Math.max(0.04, origEnd - origStart)
        };
        state._lyricWordDragMoved = false;
      }
    });

    els.lyricsTimelineBar.addEventListener('click', (e) => {
      if (state._suppressNextLyricsBarClick) {
        state._suppressNextLyricsBarClick = false;
        return;
      }
      if (!state.project || state.draggingLyricWord) return;
      const chipEl = e.target.closest('.lyrics-timeline-word');
      if (chipEl) {
        const lineIdx = parseInt(chipEl.dataset.lineIdx || '-1', 10);
        const wordIdx = parseInt(chipEl.dataset.wordIdx || '-1', 10);
        const line = state.project.lyrics?.lines?.[lineIdx];
        const word = (wordIdx >= 0 && Array.isArray(line?.words)) ? line.words[wordIdx] : null;
        const seekT = Number((word?.start ?? line?.start ?? 0));
        highlightLyricLineInEditor(lineIdx, wordIdx, true);
        seekToTime(seekT);
        return;
      }
      seekTimelineToClientX(e.clientX);
    });
  }

  window.addEventListener('mousemove', (e) => {
    if (state.draggingLyricWord && state.project && els.lyricsTimelineBar) {
      const rect = els.lyricsTimelineBar.getBoundingClientRect();
      if (rect.width > 0) {
        const dur = Math.max(0.1, state.project.duration || 30.0);
        const drag = state.draggingLyricWord;
        const { lineIdx, wordIdx } = drag;

        const chipEl = els.lyricsTimelineTrack?.querySelector(
          `.lyrics-timeline-word[data-line-idx="${lineIdx}"][data-word-idx="${wordIdx}"]`
        );

        if (drag.mode === 'move') {
          const dx = e.clientX - drag.startX;
          if (!state._lyricWordDragMoved && Math.abs(dx) < 3) {
            return;
          }
          state._lyricWordDragMoved = true;
          if (chipEl) chipEl.classList.add('dragging');
          const deltaSec = timelineDeltaXToSec(dx, els.lyricsTimelineBar);
          moveLyricWordTiming(lineIdx, wordIdx, drag.origStart + deltaSec, drag.spanSec);
        } else {
          const ratio = clientXToTimelineRatio(e.clientX, els.lyricsTimelineBar);
          const targetTime = ratio * dur;
          trimLyricWordTiming(lineIdx, wordIdx, drag.edge, targetTime);
          state._lyricWordDragMoved = true;
        }

        const line = state.project.lyrics?.lines?.[lineIdx];
        const word = (wordIdx >= 0 && Array.isArray(line?.words)) ? line.words[wordIdx] : null;
        const item = word || line;
        if (chipEl && item) {
          const s = Math.max(0, Math.min(dur, Number(item.start ?? 0)));
          const en = Math.max(s + 0.04, Math.min(dur, Number(item.end ?? s + 0.2)));
          const leftPct = (s / dur) * 100;
          const widthPct = Math.max(0.02, ((en - s) / dur) * 100);
          chipEl.style.left = `${leftPct.toFixed(4)}%`;
          chipEl.style.width = `${Math.min(100 - leftPct, widthPct).toFixed(4)}%`;
          chipEl.title = `${item.text || line?.text || ''} · ${s.toFixed(2)}s → ${en.toFixed(2)}s (${(en - s).toFixed(2)}s) · click to seek, drag to move, edges to trim`;
        }
        if (visualizer && typeof visualizer.setLyricsData === 'function') {
          visualizer.setLyricsData(state.project.lyrics);
        }
        if (!state.isPlaying) {
          const activeVid = getActiveVideoForTime(state.currentTime);
          visualizer?.renderFrame?.(state.currentTime, activeVid);
        }
      }
      return;
    }

    if (state.draggingImpactIdx >= 0 && state.project && Array.isArray(state.project.impactTimes)) {
      const ratio = clientXToTimelineRatio(e.clientX);
      const dur = Math.max(0.1, state.project.duration || 30.0);
      const rawTime = ratio * dur;
      const secPerBar = (60 / (state.project.bpm || 120)) * 4;
      const gridAnchor = Number.isFinite(state.project.downbeatOffset) ? state.project.downbeatOffset : 0;
      const snapStep = secPerBar / 16;
      const nextT = Number((e.shiftKey
        ? Math.max(0, Math.min(dur, gridAnchor + Math.round((rawTime - gridAnchor) / snapStep) * snapStep))
        : rawTime).toFixed(3));
      const editMode = getEditableCutTimesMode() || 'impact';
      const activeArr = editMode === 'custom' ? state.project.customCutTimes : state.project.impactTimes;
      if (Array.isArray(activeArr)) {
        activeArr[state.draggingImpactIdx] = nextT;
      }
      if (editMode === 'impact') {
        state.project._impactTimesEdited = true;
      }
      state._impactDragMoved = true;
      if (visualizer?.project && visualizer.project !== state.project) {
        if (editMode === 'custom') {
          visualizer.project.customCutTimes = state.project.customCutTimes;
        } else {
          visualizer.project.impactTimes = state.project.impactTimes;
          visualizer.project._impactTimesEdited = true;
        }
      }
      const markerEl = els.impactCutsLayer?.querySelector(`.impact-cut-marker[data-impact-idx="${state.draggingImpactIdx}"]`);
      if (markerEl) {
        markerEl.style.left = `${Math.max(0, Math.min(100, (nextT / dur) * 100))}%`;
        const handleEl = markerEl.querySelector('.impact-cut-handle');
        if (handleEl) {
          handleEl.title = `impact cut ${nextT.toFixed(2)}s · drag to move · right-click or × to remove`;
        }
      }
      const chipEl = els.impactCutsList?.querySelector(`.impact-cut-chip[data-impact-idx="${state.draggingImpactIdx}"] .impact-cut-seek`);
      if (chipEl) {
        chipEl.textContent = `${nextT.toFixed(2)}s`;
      }
      if (!state.isPlaying) {
        const activeVid = getActiveVideoForTime(state.currentTime);
        visualizer?.renderFrame?.(state.currentTime, activeVid);
      }
      return;
    }

    if (state.draggingCustomCue && state.project && els.waveformContainer) {
      const drag = state.draggingCustomCue;
      const rect = els.waveformContainer.getBoundingClientRect();
      if (rect.width > 0) {
        const dur = Math.max(0.1, state.project.duration || 30.0);
        const secPerBar = (60 / (state.project.bpm || 120)) * 4;
        const gridAnchor = Number.isFinite(state.project.downbeatOffset) ? state.project.downbeatOffset : 0;
        const snapStep = secPerBar / 16;
        const snapTime = (raw) => (e.shiftKey
          ? Math.max(0, Math.min(dur, gridAnchor + Math.round((raw - gridAnchor) / snapStep) * snapStep))
          : Math.max(0, Math.min(dur, raw)));

        if (!state.project._customCues) state.project._customCues = {};
        const list = Array.isArray(state.project._customCues[drag.catId]) ? state.project._customCues[drag.catId] : [];
        const item = list[drag.index];
        if (item) {
          const minSpan = Math.min(0.05, dur * 0.25);
          if (drag.mode === 'move') {
            const dx = e.clientX - drag.startX;
            if (!state._customCueDragMoved && Math.abs(dx) < 3) return;
            state._customCueDragMoved = true;
            const deltaSec = timelineDeltaXToSec(dx);
            const maxStart = Math.max(0, dur - (drag.kind === 'range' ? drag.origDuration : 0.02));
            item.time = Number(Math.max(0, Math.min(maxStart, snapTime(drag.origTime + deltaSec))).toFixed(3));
            item.duration = drag.kind === 'range' ? Number(Math.min(dur - item.time, drag.origDuration).toFixed(3)) : 0;
            item.endTime = Number((item.time + item.duration).toFixed(3));
          } else if (drag.mode === 'start') {
            state._customCueDragMoved = true;
            const ratio = clientXToTimelineRatio(e.clientX);
            const endT = drag.origTime + drag.origDuration;
            const nextStart = Number(Math.max(0, Math.min(endT - minSpan, snapTime(ratio * dur))).toFixed(3));
            item.time = nextStart;
            item.duration = Number(Math.max(minSpan, endT - nextStart).toFixed(3));
            item.endTime = Number((item.time + item.duration).toFixed(3));
          } else if (drag.mode === 'end') {
            state._customCueDragMoved = true;
            const ratio = clientXToTimelineRatio(e.clientX);
            const nextEnd = Math.max(drag.origTime + minSpan, Math.min(dur, snapTime(ratio * dur)));
            item.duration = Number(Math.max(minSpan, nextEnd - drag.origTime).toFixed(3));
            item.endTime = Number((item.time + item.duration).toFixed(3));
          }

          if (visualizer?.project && visualizer.project !== state.project) {
            visualizer.project._customCues = state.project._customCues;
          }
          const cueEl = els.customCuesLayer?.querySelector(`[data-cue-cat="${drag.catId}"][data-cue-idx="${drag.index}"]`);
          if (cueEl) {
            cueEl.style.left = `${Math.max(0, Math.min(100, (item.time / dur) * 100)).toFixed(4)}%`;
            if (drag.kind === 'range') {
              cueEl.style.width = `${Math.max(0.05, (item.duration / dur) * 100).toFixed(4)}%`;
            }
          }
          const chipSeek = els.customCuesList?.querySelector(`.custom-cue-chip[data-cue-cat="${drag.catId}"][data-cue-idx="${drag.index}"] .custom-cue-seek`);
          if (chipSeek) {
            chipSeek.textContent = drag.kind === 'range'
              ? `${item.time.toFixed(2)}s–${item.endTime.toFixed(2)}s`
              : `${item.time.toFixed(2)}s`;
          }
          if (!state.isPlaying) {
            const activeVid = getActiveVideoForTime(state.currentTime);
            visualizer?.renderFrame?.(state.currentTime, activeVid);
          }
        }
      }
      return;
    }

    if (!state.draggingMarkerId || !state.project) return;
    const minRatio = state.draggingMarkerId === 'drop' ? 0.05 : 0.0;
    const maxRatio = state.draggingMarkerId === 'drop' ? 0.92 : 0.98;
    const ratio = Math.max(minRatio, Math.min(maxRatio, clientXToTimelineRatio(e.clientX)));
    const rawTime = ratio * state.project.duration;
    // snap to half-bar boundaries aligned to detected downbeat unless shift is held
    const secPerBar = (60 / (state.project.bpm || 120)) * 4;
    const gridAnchor = Number.isFinite(state.project.downbeatOffset) ? state.project.downbeatOffset : 0;
    const snapStep = secPerBar * 0.5;
    const snapped = Number((e.shiftKey ? rawTime : Math.max(0, Math.min(state.project.duration, gridAnchor + Math.round((rawTime - gridAnchor) / snapStep) * snapStep))).toFixed(3));
    if (!state.project._markerOverrides) state.project._markerOverrides = {};
    state.project._markerOverrides[state.draggingMarkerId] = snapped;

    if (state.draggingMarkerId === 'drop') {
      state.project.dropTime = snapped;
      if (visualizer?.project) visualizer.project.dropTime = snapped;
    }

    if (Array.isArray(state.project.sections)) {
      const secIdx = state.project.sections.findIndex((s) => s.id === state.draggingMarkerId || (state.draggingMarkerId === 'drop' && s.type === 'drop'));
      if (secIdx >= 0) {
        const sec = state.project.sections[secIdx];
        sec.time = snapped;
        sec.bar = Math.max(1, Math.round(Math.max(0, snapped - gridAnchor) / secPerBar) + 1);
        sec.duration = Number(Math.max(0.1, sec.endTime - sec.time).toFixed(3));
        if (secIdx > 0) {
          const prevSec = state.project.sections[secIdx - 1];
          prevSec.endTime = snapped;
          prevSec.endBar = Math.max(prevSec.bar, sec.bar - 1);
          prevSec.duration = Number(Math.max(0.1, prevSec.endTime - prevSec.time).toFixed(3));
        }
      }
    }

    if (visualizer?.project && visualizer.project !== state.project) {
      visualizer.project._markerOverrides = state.project._markerOverrides;
    }
    visualizer.rebuildNoteNodes();
    drawWaveform();
    if (!state.isPlaying) {
      const { activeVid } = syncVideosToTime(state.currentTime, { forceSeek: true });
      visualizer?.renderFrame?.(state.currentTime, activeVid);
      state._lastRenderedTime = state.currentTime;
      state._lastRenderedVid = activeVid;
      state._lastRenderedVidTime = activeVid ? (activeVid.currentTime || 0) : -1;
      state._needsRender = false;
    }
  });

  window.addEventListener('mouseup', () => {
    if (state.draggingLyricWord) {
      const moved = state._lyricWordDragMoved;
      state.draggingLyricWord = null;
      state._lyricWordDragMoved = false;
      if (moved) {
        state._suppressNextLyricsBarClick = true;
        setTimeout(() => { state._suppressNextLyricsBarClick = false; }, 0);
        sortLyricWordsChronologically();
        syncLyricsToEngine();
        renderLyricsEditor();
        persistCurrentProjectState();
        markProjectDirty();
      } else {
        els.lyricsTimelineTrack?.querySelectorAll('.lyrics-timeline-word.dragging').forEach((el) => {
          el.classList.remove('dragging');
        });
      }
    }
    if (state.draggingImpactIdx >= 0) {
      const moved = state._impactDragMoved;
      state.draggingImpactIdx = -1;
      state._impactDragMoved = false;
      if (moved) {
        state._suppressNextWaveformClick = true;
        setTimeout(() => { state._suppressNextWaveformClick = false; }, 0);
      }
      const editMode = getEditableCutTimesMode() || 'impact';
      const arr = getEditableCutTimesArray(editMode);
      if (state.project && Array.isArray(arr)) {
        syncImpactTimesToEngine(arr, { mode: editMode, edited: true });
      }
    }
    if (state.draggingCustomCue) {
      const moved = state._customCueDragMoved;
      state.draggingCustomCue = null;
      state._customCueDragMoved = false;
      if (moved) {
        state._suppressNextWaveformClick = true;
        setTimeout(() => { state._suppressNextWaveformClick = false; }, 0);
        syncCustomCuesToEngine(state.project?._customCues || {});
      } else {
        els.customCuesLayer?.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
      }
    }
    if (state.draggingMarkerId) {
      state.draggingMarkerId = null;
      state._suppressNextWaveformClick = true;
      setTimeout(() => { state._suppressNextWaveformClick = false; }, 0);
      drawWaveform();
      renderTrackList();
      const { activeVid } = syncVideosToTime(state.currentTime, { forceSeek: true });
      visualizer?.renderFrame?.(state.currentTime, activeVid);
      state._lastRenderedTime = state.currentTime;
      state._lastRenderedVid = activeVid;
      state._lastRenderedVidTime = activeVid ? (activeVid.currentTime || 0) : -1;
      state._needsRender = false;
    }
  });

  function seekTimelineToClientX(clientX) {
    if (!state.project || !els.waveformContainer) return;
    const ratio = clientXToTimelineRatio(clientX);
    const seekT = ratio * (state.project.duration || 30.0);
    seekToTime(seekT, { fromScrub: Boolean(state.scrubbingWaveform) });
  }

  function finishWaveformScrub() {
    if (!state.scrubbingWaveform) return;
    const wasPlaying = Boolean(state._scrubWasPlaying);
    state.scrubbingWaveform = false;
    state._scrubPointerId = null;
    state._scrubWasPlaying = false;
    els.waveformContainer.classList.remove('scrubbing');
    seekToTime(state.currentTime, { fromScrub: false });
    if (wasPlaying && state.isPlaying) {
      state._forceVideoSync = true;
      state._needsRender = true;
      audioEl.play().catch(() => { });
    }
    state._suppressNextWaveformClick = true;
    setTimeout(() => { state._suppressNextWaveformClick = false; }, 0);
  }

  els.waveformContainer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.project) return;
    if (e.target.closest('.drop-marker-line, .impact-cut-marker, .custom-cue-point, .custom-cue-range, button')) return;
    if (state.draggingMarkerId || state.draggingImpactIdx >= 0 || state.draggingCustomCue) return;

    state.scrubbingWaveform = true;
    state._scrubPointerId = e.pointerId;
    state._scrubWasPlaying = Boolean(state.isPlaying && !audioEl.paused);
    if (state._scrubWasPlaying) {
      audioEl.pause();
    }
    videoPool.forEach((v) => {
      if (!v.paused) v.pause();
    });
    if (typeof visualizer?.getMediaSlotElements === 'function') {
      visualizer.getMediaSlotElements('video').forEach((sv) => {
        if (!sv.paused) sv.pause();
      });
    }
    els.waveformContainer.classList.add('scrubbing');
    try {
      els.waveformContainer.setPointerCapture(e.pointerId);
    } catch {
      // fallback if pointer capture is unavailable
    }
    seekTimelineToClientX(e.clientX);
  });

  els.waveformContainer.addEventListener('pointermove', (e) => {
    if (!state.scrubbingWaveform || e.pointerId !== state._scrubPointerId) return;
    seekTimelineToClientX(e.clientX);
  });

  els.waveformContainer.addEventListener('pointerup', (e) => {
    if (!state.scrubbingWaveform || e.pointerId !== state._scrubPointerId) return;
    finishWaveformScrub();
  });

  els.waveformContainer.addEventListener('pointercancel', (e) => {
    if (!state.scrubbingWaveform || e.pointerId !== state._scrubPointerId) return;
    finishWaveformScrub();
  });

  els.waveformContainer.addEventListener('lostpointercapture', () => {
    finishWaveformScrub();
  });

  els.waveformContainer.addEventListener('click', (e) => {
    if (state._suppressNextWaveformClick) {
      state._suppressNextWaveformClick = false;
      return;
    }
    if (state.draggingMarkerId || state.draggingImpactIdx >= 0 || state.draggingCustomCue || state.scrubbingWaveform || !state.project) return;
    seekTimelineToClientX(e.clientX);
  });

  els.waveformContainer.addEventListener('dblclick', (e) => {
    if (!state.project) return;
    if (e.target.closest('.drop-marker-line, .impact-cut-marker, .custom-cue-point, .custom-cue-range')) return;
    const ratio = clientXToTimelineRatio(e.clientX);
    const cutT = ratio * (state.project.duration || 30.0);
    const activeCat = getActiveCueCategory();
    const editMode = getEditableCutTimesMode();
    if (activeCat && (!editMode || e.altKey)) {
      addCustomCueAt(activeCat.id, cutT);
      return;
    }
    if (editMode) {
      addImpactCutAt(cutT);
    }
  });

  if (els.timelineZoomInBtn) {
    els.timelineZoomInBtn.addEventListener('click', () => {
      setTimelineZoom((state.timelineZoom || 1) * 2);
    });
  }

  if (els.timelineZoomOutBtn) {
    els.timelineZoomOutBtn.addEventListener('click', () => {
      setTimelineZoom((state.timelineZoom || 1) / 2);
    });
  }

  if (els.timelineZoomResetBtn) {
    els.timelineZoomResetBtn.addEventListener('click', () => {
      setTimelineZoom(1);
    });
  }

  if (els.waveformScroller) {
    els.waveformScroller.addEventListener('scroll', () => {
      if (!_syncingTimelineScroll) {
        state._timelineManualScrollUntil = Date.now() + 2000;
      }
      syncTimelineScroll(els.waveformScroller);
    }, { passive: true });
  }

  if (els.lyricsTimelineBar) {
    els.lyricsTimelineBar.addEventListener('scroll', () => {
      if (!_syncingTimelineScroll) {
        state._timelineManualScrollUntil = Date.now() + 2000;
      }
      syncTimelineScroll(els.lyricsTimelineBar);
    }, { passive: true });
  }

  function handleTimelineWheel(e) {
    if (!state.project) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      setTimelineZoom((state.timelineZoom || 1) * factor, e.clientX);
      return;
    }
    if ((state.timelineZoom || 1) > 1.01) {
      const scroller = getTimelineScroller();
      if (!scroller) return;
      const panDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY)
        ? e.deltaX
        : (e.shiftKey ? e.deltaY : 0);
      if (panDelta !== 0) {
        e.preventDefault();
        state._timelineManualScrollUntil = Date.now() + 2000;
        scroller.scrollLeft += panDelta;
      }
    }
  }

  els.waveformContainer?.addEventListener('wheel', handleTimelineWheel, { passive: false });
  els.lyricsTimelineBar?.addEventListener('wheel', handleTimelineWheel, { passive: false });
  updateTimelineZoomUi();

  [els.inputBrand, els.inputNumber, els.inputTitle, els.inputBpm, els.inputKey].forEach((inp) => {
    inp.addEventListener('input', () => {
      updateMetadataToVisualizer();
      drawWaveform();
      markProjectDirty();
    });
  });

  if (els.seamlessReelLoopCheckbox) {
    els.seamlessReelLoopCheckbox.addEventListener('change', () => {
      state.seamlessLoop = els.seamlessReelLoopCheckbox.checked;
      if (visualizer && visualizer.params) visualizer.params.seamlessLoop = state.seamlessLoop;
      if (els.seamlessLoopStyleSelect) {
        els.seamlessLoopStyleSelect.disabled = !state.seamlessLoop;
      }
      if (visualizer?.engine && typeof visualizer.engine.invalidateLoopCache === 'function') {
        visualizer.engine.invalidateLoopCache();
      } else if (visualizer && typeof visualizer.invalidateLoopCache === 'function') {
        visualizer.invalidateLoopCache();
      }
      const activeVid = getActiveVideoForTime(state.currentTime);
      visualizer?.renderFrame?.(state.currentTime, activeVid);
      markProjectDirty();
    });
  }

  if (els.seamlessLoopStyleSelect) {
    els.seamlessLoopStyleSelect.addEventListener('change', () => {
      state.seamlessLoopStyle = els.seamlessLoopStyleSelect.value === 'fade' ? 'fade' : 'datamosh';
      if (visualizer && visualizer.params) visualizer.params.loopStyle = state.seamlessLoopStyle;
      if (visualizer?.engine && typeof visualizer.engine.invalidateLoopCache === 'function') {
        visualizer.engine.invalidateLoopCache();
      } else if (visualizer && typeof visualizer.invalidateLoopCache === 'function') {
        visualizer.invalidateLoopCache();
      }
      const activeVid = getActiveVideoForTime(state.currentTime);
      visualizer?.renderFrame?.(state.currentTime, activeVid);
      markProjectDirty();
    });
  }

  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prevMode = state._activeCutMode || getActiveCutMode();
      const mode = btn.dataset.cutmode;
      if (visualizer?.params) visualizer.params.cutMode = mode;
      if (visualizer?.preset?.modules?.clips) {
        visualizer.preset.modules.clips.defaultCutMode = mode;
      }
      switchCutModePlaylist(prevMode, mode);
      syncCutModeUi(visualizer);
      syncVideoPoolSources();
      renderClipGrid();
      drawWaveform();
      if (!state.isPlaying) {
        const activeVid = getActiveVideoForTime(state.currentTime);
        visualizer?.renderFrame?.(state.currentTime, activeVid);
      }
      persistCurrentProjectState().catch(() => { });
      markProjectDirty();
    });
  });

  window.addEventListener('samplevis:control-change', (e) => {
    const key = e.detail?.key;
    if (!key || !visualizer) return;
    if (key === 'cutMode') {
      const prevMode = state._activeCutMode || visualizer.preset?.modules?.clips?.defaultCutMode || 'chord';
      const mode = visualizer.params?.cutMode || 'chord';
      if (visualizer?.preset?.modules?.clips) {
        visualizer.preset.modules.clips.defaultCutMode = mode;
      }
      switchCutModePlaylist(prevMode, mode);
      syncCutModeUi(visualizer);
      syncVideoPoolSources();
      renderClipGrid();
      drawWaveform();
      if (!state.isPlaying) {
        const activeVid = getActiveVideoForTime(state.currentTime);
        visualizer?.renderFrame?.(state.currentTime, activeVid);
      }
      persistCurrentProjectState().catch(() => { });
    } else if (key === 'speedRamping' || key === 'dropGlitch' || key === 'clipTransition' || key === 'clipTransitionDuration' || key === 'autoFrame') {
      syncCutModeUi(visualizer);
    }
    // the tick loop only redraws on a time change, so a knob moved while parked would show nothing
    if (!state.isPlaying) state._needsRender = true;
  });

  window.addEventListener('samplevis:clip-transition-mode', () => {
    syncClipTransitionUi(visualizer);
  });

  if (els.speedRampToggle) {
    els.speedRampToggle.checked = Boolean(visualizer?.params?.speedRamping);
    els.speedRampToggle.addEventListener('change', (e) => {
      if (visualizer?.params) visualizer.params.speedRamping = e.target.checked;
      markProjectDirty();
    });
  }

  if (els.clipTransitionSelect) {
    syncClipTransitionUi(visualizer);
    els.clipTransitionSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      if (!VALID_CLIP_TRANSITIONS.has(val)) return;
      state.clipTransition = val;
      if (visualizer?.params) {
        visualizer.params.clipTransition = val;
        visualizer.params.dropGlitch = val !== 'none';
      }
      if (els.clipTransitionDurRow) {
        els.clipTransitionDurRow.hidden = (val === 'none');
      }
      if (!state.isPlaying) {
        const activeVid = getActiveVideoForTime(state.currentTime);
        visualizer?.renderFrame?.(state.currentTime, activeVid);
      }
      markProjectDirty();
    });
  }

  if (els.clipTransitionDurSlider) {
    els.clipTransitionDurSlider.addEventListener('input', (e) => {
      const dur = Math.max(0.10, Math.min(1.00, parseFloat(e.target.value) || 0.35));
      state.clipTransitionDuration = dur;
      if (visualizer?.params) {
        visualizer.params.clipTransitionDuration = dur;
      }
      els.clipTransitionDurSlider.setAttribute('aria-valuetext', `${dur.toFixed(2)}s`);
      if (els.clipTransitionDurVal) {
        els.clipTransitionDurVal.textContent = `${dur.toFixed(2)}s`;
      }
      if (!state.isPlaying) {
        const activeVid = getActiveVideoForTime(state.currentTime);
        visualizer?.renderFrame?.(state.currentTime, activeVid);
      }
      markProjectDirty();
    });
  }

  if (els.autoFrameToggle) {
    els.autoFrameToggle.checked = Boolean(visualizer?.params?.autoFrame !== false);
    els.autoFrameToggle.addEventListener('change', (e) => {
      if (visualizer?.params) visualizer.params.autoFrame = e.target.checked;
      markProjectDirty();
    });
  }

  if (els.togglePlaylistStripBtn) {
    els.togglePlaylistStripBtn.addEventListener('click', () => {
      setPlaylistStripOpen(!state._playlistStripOpen, { user: true });
    });
  }

  if (els.openPlaylistEditorBtn) {
    els.openPlaylistEditorBtn.addEventListener('click', () => {
      openPlaylistEditor(0);
    });
  }

  if (els.playlistEditorDialog) {
    const closePlaylistEditor = () => {
      els.playlistEditorVideo?.pause();
      if (els.playlistEditorDialog?.open) {
        els.playlistEditorDialog.close();
      }
    };

    els.playlistEditorCloseXBtn?.addEventListener('click', closePlaylistEditor);
    els.playlistEditorDoneBtn?.addEventListener('click', closePlaylistEditor);

    els.playlistEditorDialog.addEventListener('close', () => {
      els.playlistEditorVideo?.pause();
      els.playlistEditorDialog.returnValue = '';
    });

    const vid = els.playlistEditorVideo;
    let pendingSeekTime = null;
    const requestEditorVideoSeek = (targetTime) => {
      if (!vid || vid.readyState < 1 || !Number.isFinite(targetTime)) return;
      const dur = Number.isFinite(vid.duration) ? vid.duration : 0;
      const clamped = dur > 0 ? Math.max(0, Math.min(dur, targetTime)) : Math.max(0, targetTime);
      if (vid.seeking) {
        pendingSeekTime = clamped;
        return;
      }
      pendingSeekTime = null;
      if (Math.abs((vid.currentTime || 0) - clamped) < 0.005) return;
      try { vid.currentTime = clamped; } catch { }
    };

    if (vid) {
      vid.addEventListener('loadedmetadata', () => {
        pendingSeekTime = null;
        const pending = parseFloat(vid.dataset.pendingSeek || '0');
        const clamped = normalizeClipStartTime(pending, vid.duration);
        delete vid.dataset.pendingSeek;
        if (Number.isFinite(vid.duration) && vid.duration > 0.1) {
          if (els.playlistEditorStartInput) els.playlistEditorStartInput.max = Math.max(0, vid.duration - 0.1).toFixed(1);
          if (els.playlistEditorEndInput) {
            els.playlistEditorEndInput.max = vid.duration.toFixed(1);
            const curEnd = _editorSlotIdx >= 0 ? state.selectedClipEndTimes[_editorSlotIdx] : null;
            els.playlistEditorEndInput.value = (curEnd !== null && curEnd !== undefined ? Math.min(vid.duration, curEnd) : vid.duration).toFixed(1);
          }
        }
        try { vid.currentTime = clamped; } catch { }
        syncPlaylistEditorTimeline();
        syncPlaylistEditorScrubUi(clamped);
      });
      vid.addEventListener('seeked', () => {
        if (pendingSeekTime !== null) {
          const next = pendingSeekTime;
          pendingSeekTime = null;
          if (Math.abs((vid.currentTime || 0) - next) >= 0.005) {
            try { vid.currentTime = next; } catch { }
            return;
          }
        }
        syncPlaylistEditorScrubUi();
      });
      vid.addEventListener('timeupdate', () => {
        if (_editorSlotIdx >= 0 && !vid.paused && Number.isFinite(vid.duration) && vid.duration > 0.2) {
          const s = normalizeClipStartTime(state.selectedClipStartTimes[_editorSlotIdx] ?? 0, vid.duration);
          const rawEnd = state.selectedClipEndTimes[_editorSlotIdx];
          const e = (rawEnd !== null && rawEnd !== undefined) ? Math.min(vid.duration, rawEnd) : vid.duration;
          if (vid.currentTime >= e - 0.03) {
            try { vid.currentTime = s; } catch { }
          }
        }
        syncPlaylistEditorScrubUi();
      });
      vid.addEventListener('play', syncPlaylistEditorScrubUi);
      vid.addEventListener('pause', syncPlaylistEditorScrubUi);
      vid.addEventListener('error', () => {
        const expectedSrc = vid.dataset.editorSrc;
        if (!expectedSrc || (vid._retryCount || 0) >= 2) return;
        vid._retryCount = (vid._retryCount || 0) + 1;
        const delayMs = 350 * vid._retryCount;
        setTimeout(() => {
          if (vid.dataset.editorSrc !== expectedSrc) return;
          vid.src = expectedSrc;
          vid.load();
        }, delayMs);
      });
      vid.addEventListener('click', () => {
        if (!vid.src) return;
        if (vid.paused) vid.play().catch(() => { });
        else vid.pause();
      });
    }

    els.playlistEditorPlayBtn?.addEventListener('click', () => {
      if (!vid || !vid.src) return;
      if (vid.paused) vid.play().catch(() => { });
      else vid.pause();
    });

    if (els.playlistEditorTimeline && vid) {
      let dragMode = null;
      let lastClientX = 0;
      const clientXToTime = (clientX) => {
        const rect = els.playlistEditorTimeline.getBoundingClientRect();
        const dur = Number.isFinite(vid.duration) && vid.duration > 0.1 ? vid.duration : 0;
        if (!dur || rect.width <= 0) return 0;
        const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return Number((pct * dur).toFixed(2));
      };

      const applyDragAt = (clientX, persist) => {
        if (_editorSlotIdx < 0 || vid.readyState < 1) return;
        const t = clientXToTime(clientX);
        if (dragMode === 'in') {
          const rawEnd = state.selectedClipEndTimes[_editorSlotIdx];
          const maxIn = rawEnd !== null && rawEnd !== undefined ? Math.max(0, rawEnd - 0.1) : Math.max(0, vid.duration - 0.1);
          const clampedIn = Math.min(maxIn, t);
          const applied = setPlaylistSlotTiming(_editorSlotIdx, { startTime: clampedIn }, {
            renderStrip: persist,
            dirty: true,
            persist
          });
          requestEditorVideoSeek(applied.startTime);
          syncPlaylistEditorScrubUi(applied.startTime);
        } else if (dragMode === 'out') {
          const minOut = (state.selectedClipStartTimes[_editorSlotIdx] ?? 0) + 0.1;
          const clampedOut = Math.max(minOut, t);
          const applied = setPlaylistSlotTiming(_editorSlotIdx, { endTime: clampedOut }, {
            renderStrip: persist,
            dirty: true,
            persist
          });
          const targetOut = applied.endTime ?? vid.duration;
          requestEditorVideoSeek(targetOut);
          syncPlaylistEditorScrubUi(targetOut);
        } else if (dragMode === 'scrub') {
          requestEditorVideoSeek(t);
          syncPlaylistEditorScrubUi(t);
        }
      };

      els.playlistEditorTimeline.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (_editorSlotIdx < 0 || vid.readyState < 1) return;
        e.preventDefault();
        if (!vid.paused) vid.pause();
        if (e.target === els.playlistEditorInHandle || e.target.closest?.('#playlistEditorInHandle')) dragMode = 'in';
        else if (e.target === els.playlistEditorOutHandle || e.target.closest?.('#playlistEditorOutHandle')) dragMode = 'out';
        else dragMode = 'scrub';
        lastClientX = e.clientX;
        try { els.playlistEditorTimeline.setPointerCapture(e.pointerId); } catch { }
        applyDragAt(e.clientX, false);
      });

      els.playlistEditorTimeline.addEventListener('pointermove', (e) => {
        if (!dragMode) return;
        lastClientX = e.clientX;
        applyDragAt(e.clientX, false);
      });

      const endTimelineDrag = (e) => {
        if (!dragMode) return;
        const finalX = e.type === 'pointercancel' ? lastClientX : e.clientX;
        applyDragAt(finalX, true);
        dragMode = null;
        try {
          if (els.playlistEditorTimeline.hasPointerCapture?.(e.pointerId)) {
            els.playlistEditorTimeline.releasePointerCapture(e.pointerId);
          }
        } catch { }
      };
      els.playlistEditorTimeline.addEventListener('pointerup', endTimelineDrag);
      els.playlistEditorTimeline.addEventListener('pointercancel', endTimelineDrag);
    }

    els.playlistEditorSetStartBtn?.addEventListener('click', () => {
      if (_editorSlotIdx < 0 || !vid) return;
      setPlaylistSlotTiming(_editorSlotIdx, { startTime: vid.currentTime || 0 }, {
        renderStrip: true,
        dirty: true,
        persist: true
      });
    });

    els.playlistEditorSetEndBtn?.addEventListener('click', () => {
      if (_editorSlotIdx < 0 || !vid) return;
      setPlaylistSlotTiming(_editorSlotIdx, { endTime: vid.currentTime || 0 }, {
        renderStrip: true,
        dirty: true,
        persist: true
      });
    });

    els.playlistEditorResetStartBtn?.addEventListener('click', () => {
      if (_editorSlotIdx < 0) return;
      const applied = setPlaylistSlotTiming(_editorSlotIdx, { startTime: 0, endTime: null, speedPct: 100 }, {
        renderStrip: true,
        dirty: true,
        persist: true
      });
      if (vid && vid.readyState >= 1) {
        try { vid.currentTime = applied.startTime; } catch { }
      }
      syncPlaylistEditorScrubUi();
    });

    els.playlistEditorStartInput?.addEventListener('change', () => {
      if (_editorSlotIdx < 0) return;
      const applied = setPlaylistSlotTiming(_editorSlotIdx, { startTime: els.playlistEditorStartInput.value }, {
        renderStrip: true,
        dirty: true,
        persist: true
      });
      if (vid && vid.readyState >= 1) {
        try { vid.currentTime = applied.startTime; } catch { }
      }
      syncPlaylistEditorScrubUi();
    });

    els.playlistEditorEndInput?.addEventListener('change', () => {
      if (_editorSlotIdx < 0) return;
      const applied = setPlaylistSlotTiming(_editorSlotIdx, { endTime: els.playlistEditorEndInput.value }, {
        renderStrip: true,
        dirty: true,
        persist: true
      });
      if (vid && vid.readyState >= 1) {
        try { vid.currentTime = applied.endTime ?? vid.duration; } catch { }
      }
      syncPlaylistEditorScrubUi();
    });

    els.playlistEditorSpeedInput?.addEventListener('change', () => {
      if (_editorSlotIdx < 0) return;
      setPlaylistSlotTiming(_editorSlotIdx, { speedPct: els.playlistEditorSpeedInput.value }, {
        renderStrip: true,
        dirty: true,
        persist: true
      });
    });
  }

  if (els.clearPlaylistBtn) {
    els.clearPlaylistBtn.addEventListener('click', () => {
      state.selectedClipIds = [];
      state.selectedClipStartTimes = [];
      state.selectedClipEndTimes = [];
      state.selectedClipSpeeds = [];
      commitPlaylistMutation();
    });
  }

  if (els.clipPlaylistTrack) {
    els.clipPlaylistTrack.addEventListener('dragover', (e) => {
      const types = Array.from(e.dataTransfer?.types || []);
      const isSlot = types.includes('application/x-samplevis-playlist-slot');
      const isClip = types.includes('application/x-samplevis-clip');
      if (!isSlot && !isClip) return;
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = isSlot ? 'move' : 'copy';
      }
      clearPlaylistDropIndicators();
      const { insertIdx, targetCard, side } = resolvePlaylistDropIndex(e.clientX);
      if (targetCard && side === 'before') {
        targetCard.classList.add('drag-over-before');
      } else if (targetCard) {
        targetCard.classList.add('drag-over-after');
      } else if (insertIdx === 0) {
        els.clipPlaylistTrack.classList.add('drag-over-end');
      }
    });

    els.clipPlaylistTrack.addEventListener('dragleave', (e) => {
      if (!els.clipPlaylistTrack.contains(e.relatedTarget)) {
        clearPlaylistDropIndicators();
      }
    });

    els.clipPlaylistTrack.addEventListener('drop', (e) => {
      const slotRaw = e.dataTransfer?.getData('application/x-samplevis-playlist-slot');
      const clipRaw = e.dataTransfer?.getData('application/x-samplevis-clip');
      clearPlaylistDropIndicators();
      if (!slotRaw && !clipRaw) return;
      e.preventDefault();
      const { insertIdx } = resolvePlaylistDropIndex(e.clientX);

      if (slotRaw !== '' && slotRaw !== undefined) {
        const fromIdx = parseInt(slotRaw, 10);
        if (!Number.isFinite(fromIdx) || fromIdx < 0 || fromIdx >= state.selectedClipIds.length) return;
        const targetIdx = Math.max(0, Math.min(state.selectedClipIds.length - 1, fromIdx < insertIdx ? insertIdx - 1 : insertIdx));
        movePlaylistSlot(fromIdx, targetIdx);
        focusPlaylistSlot(targetIdx);
        return;
      }

      try {
        const parsed = JSON.parse(clipRaw);
        const clipId = parsed?.id;
        if (!clipId) return;
        const clipStart = normalizeClipStartTime(findClipById(clipId)?.startTime ?? parsed?.startTime ?? 0);
        if (visualizer?.params?.cutMode === 'single') {
          state.selectedClipIds = [clipId];
          state.selectedClipStartTimes = [clipStart];
          state.selectedClipEndTimes = [null];
          state.selectedClipSpeeds = [100];
          commitPlaylistMutation();
          return;
        }
        if (state.selectedClipIds.length >= MAX_PLAYLIST_SLOTS) return;
        syncSelectedClipStartTimesLength();
        const next = [...state.selectedClipIds];
        const nextStarts = [...state.selectedClipStartTimes];
        const nextEnds = [...state.selectedClipEndTimes];
        const nextSpeeds = [...state.selectedClipSpeeds];
        const bounded = Math.max(0, Math.min(next.length, insertIdx));
        next.splice(bounded, 0, clipId);
        nextStarts.splice(bounded, 0, clipStart);
        nextEnds.splice(bounded, 0, null);
        nextSpeeds.splice(bounded, 0, 100);
        state.selectedClipIds = next;
        state.selectedClipStartTimes = nextStarts;
        state.selectedClipEndTimes = nextEnds;
        state.selectedClipSpeeds = nextSpeeds;
        if (!state._playlistStripOpen) {
          setPlaylistStripOpen(true);
        }
        commitPlaylistMutation();
        focusPlaylistSlot(bounded);
      } catch { }
    });
  }

  if (els.toggleFavoritesDrawerBtn) {
    els.toggleFavoritesDrawerBtn.addEventListener('click', () => {
      const isOpen = els.favoritesDrawer && !els.favoritesDrawer.hidden;
      setFavoritesDrawerOpen(!isOpen);
    });
  }

  if (els.closeFavoritesDrawerBtn) {
    els.closeFavoritesDrawerBtn.addEventListener('click', () => setFavoritesDrawerOpen(false));
  }

  if (els.favoritesDrawerScrim) {
    els.favoritesDrawerScrim.addEventListener('click', () => setFavoritesDrawerOpen(false));
  }

  if (els.clipSearchForm) {
    els.clipSearchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      handleFetchClips();
    });
  }

  async function handleFetchClips() {
    const source = els.clipSourceSelect ? els.clipSourceSelect.value : 'anime';
    if (source === 'local') {
      els.customClipInput?.click();
      return;
    }

    const customQuery = els.clipCustomQueryInput ? els.clipCustomQueryInput.value.trim() : '';
    const activeBtn = els.fetchBestClipsBtn;
    const defaultLabel = 'search best';
    const count = (source === 'real_life' || Boolean(customQuery)) ? 12 : 8;
    const excludeIds = (state.clips || [])
      .filter((c) => getClipSourceBucket(c) === source)
      .map((c) => c.sourceId || c.id)
      .filter(Boolean)
      .slice(0, 200);

    if (activeBtn) {
      activeBtn.disabled = true;
      activeBtn.textContent = 'fetching...';
    }

    try {
      const res = await fetch('/api/clips/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: 'all', customQuery, count, mode: 'best', source, excludeIds })
      });
      const rawText = await res.text();
      let data = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        data = {};
      }
      if (!res.ok) throw new Error(data.error || rawText.slice(0, 140) || `http ${res.status}`);

      const nowIso = new Date().toISOString();
      const added = (Array.isArray(data.added) ? data.added : [])
        .filter(Boolean)
        .map((c) => ({
          ...c,
          fetchedAt: nowIso,
          addedAt: c.addedAt || nowIso,
          ...(customQuery ? { matchedQuery: customQuery } : {})
        }));
      if (visualizer?.preset?.modules?.clips) {
        visualizer.preset.modules.clips.query = customQuery;
        visualizer.preset.modules.clips.source = source;
      }

      if (added.length > 0) {
        const baseList = (state.clips && state.clips.length > 0)
          ? state.clips
          : (Array.isArray(data.catalog) ? data.catalog : []);
        state.clips = mergeClipsIntoList(added, baseList);
        syncVideoPoolSources();
        renderClipGrid();
        renderFavoritesGrid();
        if (els.clipGridContainer) {
          els.clipGridContainer.scrollTop = 0;
        }
      } else if (els.clipsCountLabel) {
        const visibleCount = getFilteredClips().length;
        els.clipsCountLabel.textContent = customQuery
          ? `no new clips for "${customQuery}" · ${visibleCount} clips`
          : `no new clips found · ${visibleCount} clips`;
        setTimeout(() => {
          if (els.clipsCountLabel) {
            const currentCount = getFilteredClips().length;
            els.clipsCountLabel.textContent = `${currentCount} clip${currentCount === 1 ? '' : 's'}`;
          }
        }, 2500);
      }

      persistCurrentProjectState().catch(() => { });

      // cache remote stream clips locally in indexeddb in the background for offline zip export
      if (window.projectBundleService?.cacheClipBlob && added.length > 0) {
        added.forEach((clip) => {
          if (!clip?.url || !clip.url.startsWith('/api/clips/stream')) return;
          fetch(clip.url)
            .then((r) => (r.ok ? r.blob() : null))
            .then((blob) => {
              if (!blob || blob.size === 0) return;
              return window.projectBundleService.cacheClipBlob(clip.id, blob, clip);
            })
            .catch(() => { });
        });
      }
    } catch (err) {
      alert(`fetch error: ${err.message}`);
    } finally {
      if (activeBtn) {
        activeBtn.disabled = false;
        activeBtn.textContent = defaultLabel;
      }
    }
  }

  if (els.clipSourceSelect) {
    els.clipSourceSelect.addEventListener('change', () => {
      if (els.clipCustomQueryInput) {
        els.clipCustomQueryInput.disabled = els.clipSourceSelect.value === 'local';
      }
      renderClipGrid();
    });
  }

  if (els.customClipInput) {
    els.customClipInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;
      const newIds = [];
      const newEntries = [];
      try {
        for (const file of files) {
          const clipId = `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          let url = null;
          if (window.projectBundleService?.cacheClipBlob) {
            const cached = await window.projectBundleService.cacheClipBlob(clipId, file, {
              title: file.name.replace(/\.[^/.]+$/, ''),
              vibe: 'local',
              source: 'local',
              tags: ['local', 'custom']
            });
            url = cached?.objectUrl || URL.createObjectURL(file);
          } else {
            url = URL.createObjectURL(file);
          }
          const nowIso = new Date().toISOString();
          const entry = {
            id: clipId,
            sourceId: clipId,
            title: file.name.replace(/\.[^/.]+$/, ''),
            vibe: 'local',
            source: 'local',
            isLocal: true,
            url,
            score: 100,
            tags: ['local', 'custom'],
            addedAt: nowIso,
            fetchedAt: nowIso
          };
          newEntries.push(entry);
          newIds.push(clipId);
        }
        if (newIds.length > 0) {
          state.clips = mergeClipsIntoList(newEntries, state.clips || []);
          if (els.clipSourceSelect && els.clipSourceSelect.value !== 'local') {
            els.clipSourceSelect.value = 'local';
            if (els.clipCustomQueryInput) els.clipCustomQueryInput.disabled = true;
          }
          syncVideoPoolSources();
          renderClipGrid();
          if (els.clipGridContainer) {
            els.clipGridContainer.scrollTop = 0;
          }
          await persistCurrentProjectState();
          markProjectDirty();
        }
      } catch (err) {
        alert(`Could not load local clip: ${err.message}`);
      } finally {
        els.customClipInput.value = '';
      }
    });
  }

  // wire lyrics & vocal sync module ui
  if (els.lyricsTabEditBtn) {
    els.lyricsTabEditBtn.addEventListener('click', () => setLyricsTab('edit'));
  }
  if (els.lyricsTabLinesBtn) {
    els.lyricsTabLinesBtn.addEventListener('click', () => {
      renderLyricsEditor();
      renderLyricsTimelineBar();
      setLyricsTab('lines');
    });
  }
  if (els.lyricsClearBtn) {
    els.lyricsClearBtn.addEventListener('click', () => {
      state._pendingLyricsHold = Boolean(state.project?.lyrics?.holdLines ?? state._pendingLyricsHold);
      if (state.project) state.project.lyrics = null;
      if (els.lyricsPasteInput) els.lyricsPasteInput.value = '';
      syncLyricsToEngine();
      renderLyricsEditor();
      renderLyricsTimelineBar();
      setLyricsStatus('cleared');
      persistCurrentProjectState();
      markProjectDirty();
    });
  }
  if (els.lyricsRegroupBtn) {
    els.lyricsRegroupBtn.addEventListener('click', openLyricsRegroupPreview);
  }
  if (els.lyricsRegroupUndoBtn) {
    els.lyricsRegroupUndoBtn.addEventListener('click', undoLyricsRegroup);
  }
  if (els.lyricsRegroupApplyBtn) {
    els.lyricsRegroupApplyBtn.addEventListener('click', applyLyricsRegroup);
  }
  const closeLyricsRegroupDialog = () => {
    state._lyricsRegroupPreview = null;
    els.lyricsRegroupDialog?.close();
  };
  if (els.lyricsRegroupCancelBtn) {
    els.lyricsRegroupCancelBtn.addEventListener('click', closeLyricsRegroupDialog);
  }
  if (els.lyricsRegroupCloseXBtn) {
    els.lyricsRegroupCloseXBtn.addEventListener('click', closeLyricsRegroupDialog);
  }
  if (els.lyricsRegroupDialog) {
    // backdrop / esc close leaves a stale preview otherwise
    els.lyricsRegroupDialog.addEventListener('close', () => {
      state._lyricsRegroupPreview = null;
    });
  }
  if (els.lyricsHoldLinesCheck) {
    els.lyricsHoldLinesCheck.addEventListener('change', () => {
      const on = Boolean(els.lyricsHoldLinesCheck.checked);
      if (state.project?.lyrics && typeof state.project.lyrics === 'object') {
        state.project.lyrics.holdLines = on;
        syncLyricsToEngine();
        renderLyricsEditor();
        persistCurrentProjectState();
        markProjectDirty();
        setLyricsStatus(on ? 'connected · each line holds until the next one starts' : 'lines clear after they are sung');
      } else {
        state._pendingLyricsHold = on;
        setLyricsStatus(on ? 'connected · applies to the next sync' : 'lines clear after they are sung');
      }
    });
  }
  if (els.lyricsGranularitySelect) {
    els.lyricsGranularitySelect.addEventListener('change', () => {
      const nextGranularity = els.lyricsGranularitySelect.value === 'sentences' ? 'sentences' : 'words';
      if (state.project?.lyrics?.lines?.length > 0 && window.lyricsService?.regroupLyrics) {
        state.project.lyrics = window.lyricsService.regroupLyrics(state.project.lyrics, nextGranularity);
        state.selectedLyricLineIdx = -1;
        state.selectedLyricWordIdx = -1;
        syncLyricsToEngine();
        renderLyricsEditor();
        renderLyricsTimelineBar();
        setLyricsStatus(`switched to ${state.project.lyrics.lines.length} ${nextGranularity}`);
        persistCurrentProjectState();
        markProjectDirty();
      } else {
        renderLyricsEditor();
        updateLyricsTimelineVisibility();
      }
    });
  }
  const LYRICS_STT_KEYS_STORAGE = 'samplevis_lyrics_stt_keys';
  const LYRICS_MODEL_STORAGE = 'samplevis_lyrics_model';
  const loadLyricsSttKeys = () => {
    try {
      const raw = localStorage.getItem(LYRICS_STT_KEYS_STORAGE);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  };
  const saveLyricsSttKey = (provider, key) => {
    try {
      const keys = loadLyricsSttKeys();
      if (key) keys[provider] = key;
      else delete keys[provider];
      localStorage.setItem(LYRICS_STT_KEYS_STORAGE, JSON.stringify(keys));
    } catch {}
  };
  const getCloudSttProvider = (modelVal) => (
    typeof modelVal === 'string' && modelVal.startsWith('cloud:')
      ? modelVal.slice('cloud:'.length)
      : ''
  );
  const getByokSttMatch = () => {
    const byok = window.ByokAiProvider?.getSettings?.();
    if (!byok?.apiKey) return null;
    if (byok.provider === 'openrouter' || byok.provider === 'openai') {
      return { provider: byok.provider, apiKey: byok.apiKey };
    }
    return null;
  };
  const resolveCloudSttKey = (provider) => {
    const typed = els.lyricsCloudApiKeyInput?.value?.trim() || '';
    if (typed) return typed;
    const saved = loadLyricsSttKeys()[provider] || '';
    if (saved) return saved;
    const byok = getByokSttMatch();
    if (byok && byok.provider === provider) return byok.apiKey;
    return '';
  };
  // the model select has to state what will actually run: local whisper (with its download and
  // device), or a cloud engine that costs quota/key. silence here is why a sync could feel
  // like it came from nowhere
  const describeSttPlan = () => {
    const modelVal = els.lyricsModelSelect?.value || 'base';
    const provider = getCloudSttProvider(modelVal);
    if (provider === 'saas') return 'cloud · whisper-large-v3-turbo · uses your quota';
    if (provider === 'saas-scribe') return 'cloud · elevenlabs scribe v3 · uses your quota';
    if (provider) {
      const named = {
        openrouter: 'openai/whisper-large-v3',
        groq: 'whisper-large-v3-turbo',
        openai: 'whisper-1',
        elevenlabs: 'scribe v1',
        deepgram: 'nova-3'
      }[provider] || provider;
      return `cloud · ${provider} ${named} · uses your ${provider} key`;
    }
    const labels = {
      tiny: 'whisper-tiny',
      base: 'whisper-base',
      small: 'whisper-small',
      medium: 'whisper-medium',
      large: 'whisper-large-v3-turbo'
    };
    const heavy = modelVal === 'medium' || modelVal === 'large';
    const hasGpu = typeof navigator !== 'undefined' && Boolean(navigator.gpu);
    const fallback = heavy && !hasGpu ? ' · no webgpu, will fall back to small' : '';
    return `local · ${labels[modelVal] || modelVal}${fallback} · runs in this browser`;
  };
  const refreshSttHint = (overrideText = '') => {
    if (!els.lyricsEngineHint) return;
    els.lyricsEngineHint.textContent = overrideText || `${savedChoiceNotice()}${describeSttPlan()}`;
  };
  // recomputed against the live option list instead of cached at boot: saas injects cloud:saas
  // after the studio initialises, and a notice latched before that would claim it is missing
  const savedChoiceNotice = () => {
    let saved = '';
    try { saved = localStorage.getItem(LYRICS_MODEL_STORAGE) || ''; } catch {}
    if (!saved || !els.lyricsModelSelect) return '';
    const available = Array.from(els.lyricsModelSelect.options).some((o) => o.value === saved);
    return available ? '' : `saved choice "${saved}" is not available here — `;
  };

  // local options carry their download size in data-size-mb, so the picker can say what is
  // already in the browser cache instead of letting people re-download blind
  const refreshModelCacheBadges = async () => {
    if (!els.lyricsModelSelect || !window.lyricsService?.getWhisperCacheStatus) return;
    const options = Array.from(els.lyricsModelSelect.options).filter((o) => o.dataset.sizeMb);
    options.forEach((o) => {
      if (!o.dataset.baseLabel) o.dataset.baseLabel = o.textContent;
    });
    let status = {};
    try {
      status = await window.lyricsService.getWhisperCacheStatus();
    } catch {
      return;
    }
    options.forEach((o) => {
      const base = o.dataset.baseLabel;
      o.textContent = `${base} · ${status[o.value] ? '✓ cached' : '↓ download'}`;
    });
  };

  const syncLyricsCloudKeyUi = () => {
    const provider = getCloudSttProvider(els.lyricsModelSelect?.value || '');
    const needsByokKey = Boolean(provider && !provider.startsWith('saas'));
    if (els.lyricsCloudKeyRow) els.lyricsCloudKeyRow.hidden = !needsByokKey;
    if (needsByokKey && els.lyricsCloudApiKeyInput) {
      const keys = loadLyricsSttKeys();
      const byok = getByokSttMatch();
      els.lyricsCloudApiKeyInput.value = keys[provider] || '';
      els.lyricsCloudApiKeyInput.placeholder = (byok && byok.provider === provider && !keys[provider])
        ? `using your byok ${provider} key (optional override)`
        : `${provider} api key (stored locally)`;
    }
    refreshSttHint();
  };
  const autoSelectLyricsModelFromByok = (force = false) => {
    if (!els.lyricsModelSelect) return;
    let savedChoice = '';
    try { savedChoice = localStorage.getItem(LYRICS_MODEL_STORAGE) || ''; } catch {}
    if (!force && savedChoice) {
      const available = Array.from(els.lyricsModelSelect.options).some((o) => o.value === savedChoice);
      if (available) els.lyricsModelSelect.value = savedChoice;
      syncLyricsCloudKeyUi();
      return;
    }
    const byok = getByokSttMatch();
    if (byok) {
      const targetVal = `cloud:${byok.provider}`;
      if (Array.from(els.lyricsModelSelect.options).some((o) => o.value === targetVal)) {
        els.lyricsModelSelect.value = targetVal;
      }
    }
    syncLyricsCloudKeyUi();
  };
  if (els.lyricsModelSelect) {
    els.lyricsModelSelect.addEventListener('change', () => {
      try { localStorage.setItem(LYRICS_MODEL_STORAGE, els.lyricsModelSelect.value); } catch {}
      syncLyricsCloudKeyUi();
    });
    els.lyricsModelSelect.addEventListener('focus', refreshModelCacheBadges);
    autoSelectLyricsModelFromByok(false);
    refreshModelCacheBadges();
  }
  window.addEventListener('samplevis:byok-updated', () => {
    // never silently replace a model the user picked themselves
    autoSelectLyricsModelFromByok(false);
  });
  if (els.lyricsCloudApiKeyInput) {
    els.lyricsCloudApiKeyInput.addEventListener('input', () => {
      const provider = getCloudSttProvider(els.lyricsModelSelect?.value || '');
      if (provider) saveLyricsSttKey(provider, els.lyricsCloudApiKeyInput.value.trim());
    });
  }
  let activeSttCancel = null;
  // one visible stop control for any running transcription, instead of repurposing a button
  const setSttRunning = (running) => {
    if (els.lyricsCancelBtn) {
      els.lyricsCancelBtn.hidden = !running;
      els.lyricsCancelBtn.disabled = false;
      els.lyricsCancelBtn.textContent = 'stop';
    }
    if (els.lyricsTranscribeBtn) els.lyricsTranscribeBtn.disabled = Boolean(running);
    if (els.lyricsSyncPastedBtn) els.lyricsSyncPastedBtn.disabled = Boolean(running);
  };
  if (els.lyricsCancelBtn) {
    els.lyricsCancelBtn.addEventListener('click', () => {
      if (typeof activeSttCancel === 'function') activeSttCancel();
      els.lyricsCancelBtn.disabled = true;
      els.lyricsCancelBtn.textContent = 'stopping…';
      setLyricsStatus('cancelling after the current window…');
    });
  }
  const runLyricsStt = async (buf, { model, language, granularity, initialPrompt, onProgress, shouldCancel }) => {
    const cloudProvider = getCloudSttProvider(model);
    if (cloudProvider) {
      const serverSide = cloudProvider.startsWith('saas');
      const apiKey = serverSide ? 'cloud-session' : resolveCloudSttKey(cloudProvider);
      if (!apiKey) {
        throw new Error(`enter your ${cloudProvider} api key above`);
      }
      return window.lyricsService.transcribeWithCloudApi(buf, {
        provider: cloudProvider,
        apiKey,
        language,
        granularity,
        initialPrompt,
        shouldCancel,
        onProgress
      });
    }
    return window.lyricsService.transcribeWithBrowserWhisper(buf, {
      model,
      language,
      granularity,
      initialPrompt,
      shouldCancel,
      onProgress
    });
  };

  if (els.lyricsTranscribeBtn) {
    els.lyricsTranscribeBtn.addEventListener('click', async () => {
      if (!window.lyricsService || !state.project) return;
      let cancelled = false;
      activeSttCancel = () => { cancelled = true; };
      setSttRunning(true);
      const startedAt = Date.now();
      let statusText = 'decoding audio...';
      const paint = (text) => {
        statusText = text;
        setLyricsStatus(text);
      };
      // a single long inference reports 55% and then nothing for minutes, so show elapsed time
      const ticker = setInterval(() => {
        const sec = Math.floor((Date.now() - startedAt) / 1000);
        setLyricsStatus(`${statusText} · ${sec}s`);
      }, 1000);
      try {
        paint('decoding audio...');
        const buf = await decodeCurrentAudioBuffer();
        const model = els.lyricsModelSelect?.value || 'base';
        const language = els.lyricsLangSelect?.value || '';
        const granularity = els.lyricsGranularitySelect?.value === 'sentences' ? 'sentences' : 'words';
        const result = await runLyricsStt(buf, {
          model,
          language,
          granularity,
          initialPrompt: (els.lyricsPasteInput?.value || '').trim(),
          shouldCancel: () => cancelled,
          onProgress: (info) => {
            const pct = info.progress ? ` ${info.progress}%` : '';
            paint(`${info.status || 'processing'}${pct}`);
          }
        });
        state._decodedSttWords = result.rawSttWords || result.sttWords || [];
        state._decodedSttKey = `${state.project.audioUrl}|${model}|${language}`;
        state._decodedSttEngine = result.engine || model;
        const keepHold = Boolean(state.project?.lyrics?.holdLines ?? state._pendingLyricsHold);
        state.project.lyrics = result;
        state.project.lyrics.holdLines = keepHold;
        if (els.lyricsPasteInput) els.lyricsPasteInput.value = result.rawText || '';
        syncLyricsToEngine();
        renderLyricsEditor();
        renderLyricsTimelineBar();
        setLyricsTab('lines');
        const unitLabel = granularity === 'sentences' ? 'sentences' : 'words';
        const engineLabel = result.engine || 'unknown engine';
        const requested = result.requestedModel || model;
        const fellBack = Boolean(result.modelKey) && requested !== result.modelKey;
        setLyricsStatus(`transcribed ${result.lines?.length || 0} ${unitLabel} · ${engineLabel}`);
        refreshSttHint(fellBack
          ? `last run: ${engineLabel} — ${requested} was unavailable, used ${result.modelKey}`
          : `last run: ${engineLabel}`);
        refreshModelCacheBadges();
        await persistCurrentProjectState();
        markProjectDirty();
      } catch (err) {
        if (cancelled || err?.cancelled) {
          paint('transcription cancelled');
        } else {
          paint(`error: ${err.message}`);
        }
      } finally {
        clearInterval(ticker);
        activeSttCancel = null;
        setSttRunning(false);
      }
    });
  }
  if (els.lyricsSyncPastedBtn) {
    els.lyricsSyncPastedBtn.addEventListener('click', async () => {
      const rawText = els.lyricsPasteInput?.value.trim() || '';
      if (!rawText) {
        setLyricsStatus('paste lyrics first or click auto-transcribe');
        return;
      }
      if (!window.lyricsService || !state.project) return;
      let cancelled = false;
      activeSttCancel = () => { cancelled = true; };
      setSttRunning(true);
      try {
        const buf = await decodeCurrentAudioBuffer();
        const model = els.lyricsModelSelect?.value || 'base';
        const language = els.lyricsLangSelect?.value || '';
        const granularity = els.lyricsGranularitySelect?.value === 'sentences' ? 'sentences' : 'words';
        const sttKey = `${state.project.audioUrl}|${model}|${language}`;
        let usedEngine = state._decodedSttEngine || 'cached stt words';
        // cached words only count when they came from the engine that is currently selected: the
        // dropdown is an instruction, and silently reusing another model's decode made "scribe"
        // look like it ran while whisper-base was doing the work
        const cachedForSelection = state._decodedSttKey === sttKey
          && Array.isArray(state._decodedSttWords)
          && state._decodedSttWords.length > 0;
        let sttWords = cachedForSelection ? state._decodedSttWords : null;
        let usedCachedWords = cachedForSelection;
        if (!sttWords) {
          usedCachedWords = false;
          setLyricsStatus(`listening to vocals · ${model}...`);
          const sttRes = await runLyricsStt(buf, {
            model,
            language,
            granularity,
            shouldCancel: () => cancelled,
            // the pasted text is right here, so let whisper decode toward it
            initialPrompt: rawText,
            onProgress: (info) => {
              const pct = info.progress ? ` ${info.progress}%` : '';
              setLyricsStatus(`${info.status || 'analyzing vocals'}${pct}`);
            }
          });
          sttWords = sttRes.rawSttWords || sttRes.sttWords || [];
          usedEngine = sttRes.engine || model;
          state._decodedSttEngine = usedEngine;
          state._decodedSttWords = sttWords;
          state._decodedSttKey = sttKey;
        }
        setLyricsStatus('aligning pasted lyrics + vocal onsets...');
        const onsetData = await window.lyricsService.extractVocalOnsets(buf);
        const aligned = window.lyricsService.alignPastedLyricsToAudio(
          rawText,
          sttWords,
          buf,
          state.project.duration || buf.duration,
          onsetData,
          { granularity }
        );
        const keepHold = Boolean(state.project?.lyrics?.holdLines ?? state._pendingLyricsHold);
        state.project.lyrics = aligned;
        state.project.lyrics.holdLines = keepHold;
        syncLyricsToEngine();
        renderLyricsEditor();
        renderLyricsTimelineBar();
        setLyricsTab('lines');
        const unitLabel = granularity === 'sentences' ? 'sentences' : 'words';
        const coverage = aligned.totalWords > 0 ? `${aligned.matchedWords}/${aligned.totalWords} words matched` : '';
        // coverage belongs on the always-visible status line, not only in the hint above the model
        // picker — that hint lives on the paste tab, so the number vanished when switching to lines
        const coverageShort = aligned.totalWords > 0
          ? `${aligned.matchedWords}/${aligned.totalWords} matched`
          : 'no recognizer matches';
        setLyricsStatus(`synced ${aligned.lines?.length || 0} ${unitLabel} · ${coverageShort}${aligned.estimated ? ' · estimated' : ''} · ${usedEngine}`);
        refreshSttHint(aligned.estimated
          ? `last sync: ${usedEngine} · ${coverage || 'no recognizer words matched'} — timing was estimated from duration, not detected. try auto-transcribe with the cloud model first.`
          : `last sync: ${usedEngine}${usedCachedWords ? ' (cached words)' : ''} · ${coverage} · aligned locally against vocal onsets`);
        await persistCurrentProjectState();
        markProjectDirty();
      } catch (err) {
        setLyricsStatus(cancelled || err?.cancelled ? 'sync cancelled' : `sync error: ${err.message}`);
      } finally {
        activeSttCancel = null;
        setSttRunning(false);
      }
    });
  }

  // sample file dropzone (.wav + .mid/.als)
  els.sampleDropzone.addEventListener('click', () => els.sampleFileInput.click());
  els.sampleDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.sampleDropzone.classList.add('dragover');
  });
  els.sampleDropzone.addEventListener('dragleave', () => {
    els.sampleDropzone.classList.remove('dragover');
  });
  els.sampleDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.sampleDropzone.classList.remove('dragover');
    if (e.dataTransfer?.files?.length) {
      handleSampleFiles(Array.from(e.dataTransfer.files));
    }
  });
  els.sampleFileInput.addEventListener('change', (e) => {
    if (e.target.files?.length) {
      handleSampleFiles(Array.from(e.target.files));
    }
  });

  async function handleSampleFiles(files) {
    const audioFile = files.find((f) => /\.(wav|mp3|flac|ogg|m4a)$/i.test(f.name));
    const midiOrAlsFile = files.find((f) => /\.(mid|midi|als)$/i.test(f.name));

    if (!audioFile) {
      alert('Please include an audio sample file (.wav, .mp3, .flac, .ogg).');
      return;
    }

    if (state.localAudioUrl) {
      try { URL.revokeObjectURL(state.localAudioUrl); } catch (e) { }
    }
    const localAudioUrl = URL.createObjectURL(audioFile);
    state.localAudioUrl = localAudioUrl;
    state.audioBlob = audioFile;
    state.audioName = audioFile.name;
    state.hasCustomAudio = true;
    state.midiBlob = midiOrAlsFile || null;
    state.midiName = midiOrAlsFile ? midiOrAlsFile.name : null;
    state.hasCustomMidi = Boolean(midiOrAlsFile);
    state._decodedAudioBuffer = null;
    state._decodedAudioUrl = null;
    state._decodedSttWords = null;
    state._decodedSttKey = null;

    audioEl.removeAttribute('crossorigin');
    audioEl.src = localAudioUrl;
    audioEl.currentTime = 0;
    state.currentTime = 0;

    els.uploadStatusText.textContent = `analyzing ${audioFile.name}...`;

    try {
      const meta = window.clientAnalyzer.parseSampleFilename(audioFile.name);
      let midiData = null;

      if (midiOrAlsFile) {
        const ext = midiOrAlsFile.name.split('.').pop().toLowerCase();
        if (ext === 'als') {
          midiData = await window.clientAnalyzer.parseAlsFileInBrowser(midiOrAlsFile, meta.bpm);
        } else if (ext === 'mid' || ext === 'midi') {
          midiData = await window.clientAnalyzer.parseMidiFileInBrowser(midiOrAlsFile, meta.bpm);
        }
      }

      const hasExplicitBpm = Boolean(midiData?.bpm || meta.bpm);
      const initialBpm = midiData?.bpm || meta.bpm || parseFloat(els.inputBpm.value) || 120;
      const effectiveKey = meta.key ? meta.key : (els.inputKey.value || '');
      const effectiveTitle = (meta.title && meta.title !== 'untitled')
        ? meta.title
        : audioFile.name.replace(/\.[^/.]+$/, '');
      const effectiveSampleNum = meta.sampleNumber || (els.inputNumber.value ? els.inputNumber.value.trim() : '');

      const audioAnalysis = await window.clientAnalyzer.analyzeAudioFileInBrowser(audioFile, initialBpm, {
        autoDetectBpm: !hasExplicitBpm
      });
      const effectiveBpm = audioAnalysis.bpm || initialBpm;

      if (!midiData || !midiData.tracks || midiData.tracks.length === 0) {
        midiData = {
          sourceType: 'audio-fallback',
          bpm: effectiveBpm,
          tracks: [
            {
              id: 'fallback_0',
              name: 'Audio Pitch / Onset Fallback',
              noteCount: audioAnalysis.fallbackNotes.length,
              startBar: 1,
              endBar: Math.ceil((audioAnalysis.duration * (effectiveBpm / 60)) / 4),
              defaultSelected: true,
              notes: audioAnalysis.fallbackNotes
            }
          ]
        };
      }

      const chordCutTimes = window.clientAnalyzer.extractChordCutTimes(
        midiData.tracks,
        audioAnalysis.dropTime,
        effectiveBpm,
        audioAnalysis.duration
      );

      const sections = window.clientAnalyzer.detectTrackSections({
        duration: audioAnalysis.duration,
        bpm: effectiveBpm,
        barFeatures: audioAnalysis.barFeatures,
        peaks: audioAnalysis.peaks,
        dropBar: audioAnalysis.dropBar,
        dropTime: audioAnalysis.dropTime,
        tracks: midiData.tracks,
        locators: midiData.locators
      });

      const starterBrand = state.project?.id?.startsWith('starter_')
        ? (state.project.brand || '').toLowerCase()
        : '';
      const rawInputBrand = (els.inputBrand.value || '').trim();
      const effectiveBrand = rawInputBrand && rawInputBrand.toLowerCase() !== starterBrand ? rawInputBrand : '';

      const project = {
        id: `sample_${Date.now()}`,
        brand: effectiveBrand,
        sampleNumber: effectiveSampleNum,
        title: effectiveTitle,
        key: effectiveKey,
        bpm: effectiveBpm,
        beatOffset: audioAnalysis.beatOffset || 0,
        downbeatOffset: audioAnalysis.downbeatOffset || 0,
        audioUrl: localAudioUrl,
        duration: audioAnalysis.duration,
        dropBar: audioAnalysis.dropBar,
        dropTime: audioAnalysis.dropTime,
        peaks: audioAnalysis.peaks,
        sections,
        sourceType: midiData.sourceType,
        tracks: midiData.tracks,
        chordCutTimes,
        impactTimes: audioAnalysis.impactTimes || [audioAnalysis.dropTime]
      };

      if (audioAnalysis._signalData) {
        Object.defineProperty(project, '_signalData', {
          enumerable: false,
          configurable: true,
          value: audioAnalysis._signalData
        });
        window.audioSignals?.registerSignalData?.(localAudioUrl, audioAnalysis._signalData);
      }

      loadProjectIntoStudio(project, null);
    } catch (err) {
      console.error('Client analysis error:', err);
      els.uploadStatusText.textContent = `error: ${err.message}`;
    }
  }

  els.reloadStarterBtn.addEventListener('click', () => {
    if (!hasUnsavedChanges) {
      initStarter({ forceStarter: true });
      return;
    }
    openUnsavedLeaveModal({
      saveLabel: 'save & reload',
      onLeave: () => {
        clearProjectDirty();
        initStarter({ forceStarter: true });
      }
    });
  });

  // client-side video export (webcodecs + mp4-muxer with mediarecorder fallback)
  function seekVideoElement(videoEl, timeSec) {
    return new Promise((resolve) => {
      if (!videoEl || !videoEl.src || !videoEl.duration) return resolve();
      const target = timeSec % Math.max(0.5, videoEl.duration);
      if (Math.abs(videoEl.currentTime - target) < 0.02) return resolve();
      const onSeeked = () => {
        videoEl.removeEventListener('seeked', onSeeked);
        resolve();
      };
      videoEl.addEventListener('seeked', onSeeked);
      videoEl.currentTime = target;
      setTimeout(() => {
        videoEl.removeEventListener('seeked', onSeeked);
        resolve();
      }, 120);
    });
  }

  els.renderMp4Btn.addEventListener('click', async () => {
    if (state.isRendering || !state.project) return;
    if (state.isPlaying) els.playPauseBtn.click();

    if (!state.project.audioUrl) {
      alert('Cannot render: No audio track loaded. Please drop a .wav or .mp3 sample file first.');
      return;
    }

    let preloadedAudioBuffer = null;
    try {
      const audioResp = await fetch(state.project.audioUrl);
      if (!audioResp.ok) throw new Error(`Audio fetch returned status ${audioResp.status}`);
      const audioArrayBuf = await audioResp.arrayBuffer();
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      preloadedAudioBuffer = await audioCtx.decodeAudioData(audioArrayBuf);
      await audioCtx.close();
      if (!preloadedAudioBuffer || preloadedAudioBuffer.length === 0) {
        throw new Error('Decoded audio stream contains zero samples');
      }
    } catch (audioCheckErr) {
      const proceed = confirm(
        `Warning: Audio could not be decoded (${audioCheckErr.message}).\n\nIf you proceed, the video will be rendered WITHOUT SOUND.\n\nClick Cancel to drop your .wav file first, or OK to render without audio.`
      );
      if (!proceed) return;
    }

    state.isRendering = true;
    els.renderOverlay.hidden = false;
    els.renderMp4Btn.disabled = true;

    try {
      if (typeof window.VideoEncoder === 'function' && window.Mp4Muxer) {
        await renderWithWebCodecs(preloadedAudioBuffer);
      } else {
        await renderWithMediaRecorderFallback();
      }
    } catch (err) {
      alert(`Render error: ${err.message}`);
    } finally {
      state.isRendering = false;
      els.renderOverlay.hidden = true;
      els.renderMp4Btn.disabled = false;
    }
  });

  async function renderWithWebCodecs(preloadedAudioBuffer) {
    const fps = 60;
    const duration = state.project.duration || 29.09;
    const totalFrames = Math.ceil(duration * fps);

    els.renderStatusTitle.textContent = 'initializing encoder & muxer...';
    els.renderProgressBar.style.width = '0%';

    let audioBuffer = preloadedAudioBuffer;
    if (!audioBuffer && state.project.audioUrl) {
      try {
        const audioResp = await fetch(state.project.audioUrl);
        const audioArrayBuf = await audioResp.arrayBuffer();
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioBuffer = await audioCtx.decodeAudioData(audioArrayBuf);
        await audioCtx.close();
      } catch (err) {
        console.warn('Audio decoding fallback notice:', err);
      }
    }

    if (audioBuffer && visualizer) {
      if (typeof visualizer.attachDecodedAudioBuffer === 'function') {
        visualizer.attachDecodedAudioBuffer(audioBuffer, state.project?.audioUrl);
      } else if (visualizer.engine?.attachDecodedAudioBuffer) {
        visualizer.engine.attachDecodedAudioBuffer(audioBuffer, state.project?.audioUrl);
      }
    }

    const origSampleRate = audioBuffer ? audioBuffer.sampleRate : 44100;
    const numberOfChannels = audioBuffer ? Math.min(2, audioBuffer.numberOfChannels) : 2;

    // probe aac first (widest player compatibility), then opus @ 48khz (firefox / linux chromium)
    let audioCodecMode = null;
    let encodeSampleRate = origSampleRate;
    let encodeAudioBuffer = audioBuffer;
    let targetAudioBitrate = 192_000;

    if (audioBuffer && typeof window.AudioEncoder === 'function') {
      for (const br of [192_000, 160_000, 128_000]) {
        try {
          const support = await AudioEncoder.isConfigSupported({
            codec: 'mp4a.40.2',
            sampleRate: origSampleRate,
            numberOfChannels,
            bitrate: br
          });
          if (support?.supported) {
            audioCodecMode = 'aac';
            encodeSampleRate = origSampleRate;
            targetAudioBitrate = br;
            break;
          }
        } catch {
          // continue probing
        }
      }

      if (!audioCodecMode) {
        for (const br of [192_000, 128_000]) {
          try {
            const support = await AudioEncoder.isConfigSupported({
              codec: 'opus',
              sampleRate: 48000,
              numberOfChannels,
              bitrate: br
            });
            if (support?.supported) {
              audioCodecMode = 'opus';
              encodeSampleRate = 48000;
              targetAudioBitrate = br;
              break;
            }
          } catch {
            // continue probing
          }
        }
      }
    }

    if (audioBuffer && !audioCodecMode && typeof MediaRecorder === 'function') {
      return renderWithMediaRecorderFallback();
    }

    if (audioCodecMode === 'opus' && encodeAudioBuffer && encodeAudioBuffer.sampleRate !== 48000) {
      const offlineCtx = new OfflineAudioContext(
        numberOfChannels,
        Math.max(1, Math.ceil(encodeAudioBuffer.duration * 48000)),
        48000
      );
      const src = offlineCtx.createBufferSource();
      src.buffer = encodeAudioBuffer;
      src.connect(offlineCtx.destination);
      src.start(0);
      encodeAudioBuffer = await offlineCtx.startRendering();
    }

    const renderWidth = previewCanvas.width || (state.aspectRatio === '16:9' ? 1920 : 1080);
    const renderHeight = previewCanvas.height || (state.aspectRatio === '16:9' ? 1080 : (state.aspectRatio === '1:1' ? 1080 : 1920));

    const muxerConfig = {
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: {
        codec: 'avc',
        width: renderWidth,
        height: renderHeight
      },
      fastStart: 'in-memory'
    };
    if (audioCodecMode) {
      muxerConfig.audio = {
        codec: audioCodecMode,
        sampleRate: encodeSampleRate,
        numberOfChannels
      };
    }

    const muxer = new Mp4Muxer.Muxer(muxerConfig);

    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => console.error('VideoEncoder error:', e)
    });

    videoEncoder.configure({
      codec: 'avc1.64002a', // h.264 high profile level 4.2 (1080p60)
      width: renderWidth,
      height: renderHeight,
      bitrate: 12_000_000,
      framerate: fps
    });

    if (audioCodecMode && encodeAudioBuffer) {
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => console.warn('AudioEncoder warning:', e)
      });
      audioEncoder.configure({
        codec: audioCodecMode === 'opus' ? 'opus' : 'mp4a.40.2',
        sampleRate: encodeSampleRate,
        numberOfChannels,
        bitrate: targetAudioBitrate
      });

      const chunkFrames = audioCodecMode === 'opus' ? 960 : 4096;
      const totalSamples = encodeAudioBuffer.length;
      const ch0 = encodeAudioBuffer.getChannelData(0);
      const ch1 = numberOfChannels > 1 ? encodeAudioBuffer.getChannelData(1) : ch0;

      for (let offset = 0; offset < totalSamples; offset += chunkFrames) {
        const len = Math.min(chunkFrames, totalSamples - offset);
        const planarData = new Float32Array(len * numberOfChannels);
        planarData.set(ch0.subarray(offset, offset + len), 0);
        if (numberOfChannels > 1) {
          planarData.set(ch1.subarray(offset, offset + len), len);
        }
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: encodeSampleRate,
          numberOfFrames: len,
          numberOfChannels,
          timestamp: Math.round((offset / encodeSampleRate) * 1_000_000),
          data: planarData
        });
        audioEncoder.encode(audioData);
        audioData.close();
      }
      await audioEncoder.flush();
    }

    els.renderStatusTitle.textContent = `encoding ${renderWidth}×${renderHeight} @ 60fps...`;
    for (let f = 0; f < totalFrames; f++) {
      const t = f / fps;
      const activeVid = getActiveVideoForTime(t);
      if (activeVid) {
        const clipTime = getClipTimeForTimestamp(t, activeVid);
        await seekVideoElement(activeVid, clipTime);
      }
      if (visualizer && typeof visualizer.getMediaSlotElements === 'function') {
        const slotVideos = visualizer.getMediaSlotElements('video');
        for (const sv of slotVideos) {
          await seekVideoElement(sv, t);
        }
      }

      await visualizer.renderFrameAwait(t, activeVid);

      const frame = new VideoFrame(previewCanvas, {
        timestamp: Math.round(t * 1_000_000),
        duration: Math.round(1_000_000 / fps)
      });
      videoEncoder.encode(frame, { keyFrame: f % 120 === 0 });
      frame.close();

      if (videoEncoder.encodeQueueSize > 12) {
        await videoEncoder.flush();
      }
      if (f % 8 === 0 || f === totalFrames - 1) {
        const pct = Math.round(((f + 1) / totalFrames) * 100);
        els.renderProgressBar.style.width = `${pct}%`;
        els.renderProgressMeta.textContent = `frame ${f + 1} / ${totalFrames} (${pct}%)`;
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    await videoEncoder.flush();
    muxer.finalize();

    const buffer = muxer.target.buffer;
    const blob = new Blob([buffer], { type: 'video/mp4' });

    finishClientRender(blob, '.mp4');
  }

  async function renderWithMediaRecorderFallback() {
    els.renderStatusTitle.textContent = 'recording 60fps stream...';
    const stream = previewCanvas.captureStream(60);

    try {
      const audioStream = audioEl.captureStream
        ? audioEl.captureStream()
        : audioEl.mozCaptureStream
          ? audioEl.mozCaptureStream()
          : null;
      if (audioStream) {
        for (const track of audioStream.getAudioTracks()) {
          stream.addTrack(track);
        }
      }
    } catch {
      // continue with video-only stream if audio capture is blocked
    }

    const chunks = [];
    const mime = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm;codecs=vp9';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const donePromise = new Promise((resolve) => {
      rec.onstop = () => resolve();
    });

    audioEl.currentTime = 0;
    state.currentTime = 0;
    rec.start(200);
    await audioEl.play();

    const dur = state.project.duration || 29.09;
    while (audioEl.currentTime < dur - 0.1 && !audioEl.paused) {
      state.currentTime = audioEl.currentTime;
      const activeVid = getActiveVideoForTime(state.currentTime);
      if (visualizer && typeof visualizer.renderFrameAwait === 'function') {
        // the recorder reads the host canvas, so a sandboxed frame has to land there first
        await visualizer.renderFrameAwait(state.currentTime, activeVid);
      } else {
        visualizer.renderFrame(state.currentTime, activeVid);
      }
      const pct = Math.round((state.currentTime / dur) * 100);
      els.renderProgressBar.style.width = `${pct}%`;
      els.renderProgressMeta.textContent = `${state.currentTime.toFixed(1)}s / ${dur.toFixed(1)}s (${pct}%)`;
      await new Promise((r) => setTimeout(r, 16));
    }

    audioEl.pause();
    rec.stop();
    await donePromise;

    const ext = mime.includes('mp4') ? '.mp4' : '.webm';
    const blob = new Blob(chunks, { type: mime });
    finishClientRender(blob, ext);
  }

  function finishClientRender(blob, ext) {
    state.lastRenderedBlob = blob;
    const cleanTitle = (state.project?.title || 'sample').replace(/[^a-z0-9_-]+/gi, '_');
    const numPart = state.project?.sampleNumber ? `${state.project.sampleNumber}_` : '';
    const bpmPart = state.project?.bpm ? `_${state.project.bpm}bpm` : '';
    state.lastRenderedFilename = `${numPart}${cleanTitle}${bpmPart}${ext}`;

    const url = URL.createObjectURL(blob);
    els.downloadLastRenderBtn.href = url;
    els.downloadLastRenderBtn.download = state.lastRenderedFilename;
    els.downloadLastRenderBtn.hidden = false;
    els.downloadLastRenderBtn.click();
  }

  // preset resolution, error modal & byok settings wiring
  function initDesignSwitcher() {
    const presetErrorModal = document.getElementById('presetErrorModal');
    const presetErrorMessage = document.getElementById('presetErrorMessage');

    function showPresetError(missingId) {
      hideProjectLoading();
      if (els.topPresetNameInput) els.topPresetNameInput.value = 'error';
      if (presetErrorMessage) {
        presetErrorMessage.textContent = `preset "${missingId}" could not be found in local storage or on the server.`;
      }
      if (presetErrorModal) presetErrorModal.hidden = false;
    }

    async function resolveInitialPreset() {
      showProjectLoading('loading preset...');
      if (!window.presetService) {
        if (!window.templateRegistry.activeTemplate) showPresetError(activeTemplateId);
        return;
      }

      if (activeTemplateId && !window.templateRegistry.get(activeTemplateId)) {
        await window.presetService.getPresetById(activeTemplateId);
      }

      await window.presetService.syncWithBackend();

      if (
        activeTemplateId &&
        activeTemplateId !== window.templateRegistry.activeTemplateId
      ) {
        if (window.templateRegistry.get(activeTemplateId)) {
          showProjectLoading('compiling shaders & preset...');
          await yieldToPaint();
          await window.templateRegistry.setTemplate(
            activeTemplateId,
            previewCanvas,
            state,
            els.templateControlsContainer
          );
          visualizer = window.templateRegistry.activeTemplate;
          state.customImageDataUrl = visualizer?.preset?.assets?.customImage || '';
          if (visualizer?.engine) {
            visualizer.engine.onAssetLoaded = () => {
              const activeVid = getActiveVideoForTime(state.currentTime);
              visualizer?.renderFrame?.(state.currentTime, activeVid);
            };
          }
          if (els.topPresetNameInput && visualizer) {
            els.topPresetNameInput.value = visualizer.name;
          }
          if (els.speedRampToggle) els.speedRampToggle.checked = Boolean(visualizer?.params?.speedRamping);
          if (els.autoFrameToggle) els.autoFrameToggle.checked = Boolean(visualizer?.params?.autoFrame !== false);
          applyTemplateModules(visualizer);
          syncSeamlessLoopControl(visualizer);
          applyAspectRatio(visualizer?.preset?.meta?.aspectRatio || state.aspectRatio || '9:16', false);
          updateMetadataToVisualizer();
          renderTrackList();
          renderClipGrid();
          const activeVid = getActiveVideoForTime(state.currentTime);
          if (visualizer && typeof visualizer.renderFrame === 'function') {
            visualizer.renderFrame(state.currentTime, activeVid);
          }
          if (state.project && state._restoredBundlePresetId !== activeTemplateId && window.projectBundleService?.loadProjectState) {
            state._restoredBundlePresetId = activeTemplateId;
            const isBuiltinStarterOnly = Boolean(
              (window.STARTER_PRESET_DEFINITIONS?.[activeTemplateId] || window.STARTER_PRESETS?.[activeTemplateId]) &&
              !(await window.presetService?.getPresetById?.(activeTemplateId).catch(() => null))
            );
            if (!isBuiltinStarterOnly && window.projectBundleService?.ensureProjectStateCheckpoint) {
              await window.projectBundleService.ensureProjectStateCheckpoint(activeTemplateId);
            }
            const bundleState = await window.projectBundleService.loadProjectState(activeTemplateId);
            if (bundleState) {
              await restoreBundleProjectState(bundleState);
            }
          }
        } else {
          showPresetError(activeTemplateId);
        }
      }
    }

    if (visualizer) {
      applyAspectRatio(visualizer?.preset?.meta?.aspectRatio || state.aspectRatio || '9:16', false);
    }

    const initialPresetPromise = window.presetService
      ? resolveInitialPreset().catch((err) => {
        console.warn('Initial preset resolution failed:', err);
      })
      : Promise.resolve();
    function syncQuickModelPickState() {
      const picksWrap = document.getElementById('byokQuickModelPicks');
      if (!picksWrap) return;
      const activeVal = els.byokModelInput?.value.trim() || '';
      picksWrap.querySelectorAll('.byok-model-pick-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.model === activeVal);
      });
    }

    function populateModelSuggestions(providerId) {
      const datalist = document.getElementById('byokModelSuggestions');
      const picksWrap = document.getElementById('byokQuickModelPicks');
      if (!window.ByokAiProvider) return;
      const presets = window.ByokAiProvider.getPresets();
      const preset = presets[providerId];

      if (datalist) {
        datalist.innerHTML = '';
        if (preset?.suggestedModels) {
          preset.suggestedModels.forEach((m) => {
            const opt = document.createElement('option');
            opt.value = m;
            datalist.appendChild(opt);
          });
        }
      }

      if (picksWrap) {
        picksWrap.textContent = '';
        if (preset?.suggestedModels) {
          preset.suggestedModels.forEach((m) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'byok-model-pick-btn';
            btn.dataset.model = m;
            btn.textContent = m;
            btn.addEventListener('click', () => {
              if (els.byokModelInput) {
                els.byokModelInput.value = m;
              }
              syncQuickModelPickState();
            });
            picksWrap.appendChild(btn);
          });
          syncQuickModelPickState();
        }
      }
    }

    function readByokForm() {
      return {
        provider: document.getElementById('byokProviderSelect')?.value || 'deepinfra',
        protocol: document.getElementById('byokProtocolSelect')?.value || 'openai',
        apiKey: els.byokApiKeyInput?.value || '',
        baseUrl: els.byokBaseUrlInput?.value || '',
        model: els.byokModelInput?.value || '',
        temperature: parseFloat(document.getElementById('byokTemperatureInput')?.value || '0.3'),
        maxTokens: parseInt(document.getElementById('byokMaxTokensInput')?.value || '65536', 10),
        jsonMode: Boolean(document.getElementById('byokJsonModeCheckbox')?.checked),
        extraHeaders: document.getElementById('byokExtraHeadersInput')?.value || ''
      };
    }

    function openAiSettingsModal() {
      const providerSelect = document.getElementById('byokProviderSelect');
      const protocolSelect = document.getElementById('byokProtocolSelect');
      const tempInput = document.getElementById('byokTemperatureInput');
      const maxTokInput = document.getElementById('byokMaxTokensInput');
      const jsonCheck = document.getElementById('byokJsonModeCheckbox');
      const extraHeadersInput = document.getElementById('byokExtraHeadersInput');
      const customDetails = document.getElementById('byokCustomOptions');

      if (window.ByokAiProvider) {
        const s = window.ByokAiProvider.getSettings();
        if (providerSelect) providerSelect.value = s.provider;
        if (protocolSelect) protocolSelect.value = s.protocol;
        if (els.byokApiKeyInput) els.byokApiKeyInput.value = s.apiKey;
        if (els.byokBaseUrlInput) els.byokBaseUrlInput.value = s.baseUrl;
        if (els.byokModelInput) els.byokModelInput.value = s.model;
        if (tempInput) tempInput.value = String(s.temperature);
        if (maxTokInput) maxTokInput.value = String(s.maxTokens);
        if (jsonCheck) jsonCheck.checked = s.jsonMode;
        if (extraHeadersInput) extraHeadersInput.value = s.extraHeaders;
        if (customDetails) customDetails.open = s.provider === 'custom';
        populateModelSuggestions(s.provider);
      }
      if (els.aiSettingsSaveStatus) els.aiSettingsSaveStatus.textContent = '';
      if (els.aiSettingsModal) els.aiSettingsModal.hidden = false;
    }

    function closeAiSettingsModal() {
      if (els.aiSettingsModal) els.aiSettingsModal.hidden = true;
    }

    if (els.byokModelInput) {
      els.byokModelInput.addEventListener('input', syncQuickModelPickState);
    }

    const byokProviderSelect = document.getElementById('byokProviderSelect');
    if (byokProviderSelect) {
      byokProviderSelect.addEventListener('change', () => {
        if (!window.ByokAiProvider) return;
        const presets = window.ByokAiProvider.getPresets();
        const preset = presets[byokProviderSelect.value];
        if (!preset) return;
        if (els.byokBaseUrlInput) els.byokBaseUrlInput.value = preset.baseUrl;
        if (els.byokModelInput) els.byokModelInput.value = preset.defaultModel;
        const protocolSelect = document.getElementById('byokProtocolSelect');
        if (protocolSelect) protocolSelect.value = preset.protocol;
        const customDetails = document.getElementById('byokCustomOptions');
        if (customDetails) customDetails.open = byokProviderSelect.value === 'custom';
        populateModelSuggestions(byokProviderSelect.value);
      });
    }

    if (els.openAiSettingsBtn) {
      els.openAiSettingsBtn.addEventListener('click', openAiSettingsModal);
    }
    if (els.closeAiSettingsBtn) {
      els.closeAiSettingsBtn.addEventListener('click', closeAiSettingsModal);
    }
    if (els.aiSettingsModal) {
      els.aiSettingsModal.addEventListener('click', (e) => {
        if (e.target === els.aiSettingsModal) closeAiSettingsModal();
      });
    }
    if (els.saveAiSettingsBtn) {
      els.saveAiSettingsBtn.addEventListener('click', () => {
        if (window.ByokAiProvider) {
          window.ByokAiProvider.saveSettings(readByokForm());
          const keyNotice = document.getElementById('vizKeyNotice');
          if (keyNotice) keyNotice.hidden = window.ByokAiProvider.hasKey();
          window.dispatchEvent(new CustomEvent('samplevis:byok-updated'));
          if (els.aiSettingsSaveStatus) {
            els.aiSettingsSaveStatus.textContent = 'saved in browser';
            setTimeout(() => {
              if (els.aiSettingsSaveStatus) els.aiSettingsSaveStatus.textContent = '';
              closeAiSettingsModal();
            }, 600);
          }
        }
      });
    }

    const testAiBtn = document.getElementById('testAiSettingsBtn');
    if (testAiBtn) {
      testAiBtn.addEventListener('click', async () => {
        if (!window.ByokAiProvider) return;
        testAiBtn.disabled = true;
        if (els.aiSettingsSaveStatus) els.aiSettingsSaveStatus.textContent = 'testing connection...';
        try {
          const reply = await window.ByokAiProvider.testConnection(readByokForm());
          if (els.aiSettingsSaveStatus) {
            els.aiSettingsSaveStatus.textContent = `connected (${reply.slice(0, 24)})`;
          }
        } catch (err) {
          if (els.aiSettingsSaveStatus) {
            els.aiSettingsSaveStatus.textContent = `error: ${err.message}`;
          }
        } finally {
          testAiBtn.disabled = false;
        }
      });
    }

    window.openAiSettingsModal = openAiSettingsModal;

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (els.unsavedLeaveModal && !els.unsavedLeaveModal.hidden) closeUnsavedLeaveModal();
        if (els.aiSettingsModal && !els.aiSettingsModal.hidden) closeAiSettingsModal();
        if (els.favoritesDrawer && !els.favoritesDrawer.hidden) setFavoritesDrawerOpen(false);
      }
    });

    window.templateRegistry.onTemplateChange((tpl) => {
      visualizer = tpl;
      state.customImageDataUrl = tpl.preset?.assets?.customImage || '';
      if (tpl.engine) {
        tpl.engine.onAssetLoaded = () => {
          const activeVid = getActiveVideoForTime(state.currentTime);
          visualizer?.renderFrame?.(state.currentTime, activeVid);
        };
      }
      if (els.topPresetNameInput) {
        els.topPresetNameInput.value = tpl.name;
      }
      if (els.speedRampToggle) els.speedRampToggle.checked = Boolean(tpl?.params?.speedRamping);
      if (els.autoFrameToggle) els.autoFrameToggle.checked = Boolean(tpl?.params?.autoFrame !== false);
      applyTemplateModules(tpl);
      syncSeamlessLoopControl(tpl);
      if (typeof visualizer.setActiveVideos === 'function') {
        visualizer.setActiveVideos(videoPool);
      }
      const nextRatio = tpl.preset?.meta?.aspectRatio || state.aspectRatio || '9:16';
      applyAspectRatio(nextRatio, false);
      updateMetadataToVisualizer();
    });

    if (els.aspectRatioToggleBtn) {
      els.aspectRatioToggleBtn.addEventListener('click', () => {
        const order = ['9:16', '16:9', '1:1'];
        const curIdx = Math.max(0, order.indexOf(state.aspectRatio || '9:16'));
        const nextAspect = order[(curIdx + 1) % order.length];
        applyAspectRatio(nextAspect, true);
      });
    }

    return initialPresetPromise;
  }

  async function fetchOptionalJson(url) {
    try {
      const res = await fetch(url);
      const ct = res.headers?.get?.('content-type') || '';
      if (!res.ok || !/json/i.test(ct)) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function initStarter({ forceStarter = false } = {}) {
    showProjectLoading(forceStarter ? 'loading initial preset...' : 'loading project media...');
    try {
      if (els.encoderBadge && typeof window.VideoEncoder !== 'function') {
        els.encoderBadge.textContent = 'encoder: mediarecorder 60fps';
      }

      const curPid = getActivePresetIdSafe();
      const tplEntry = window.templateRegistry?.get?.(curPid);
      const activePresetObj = visualizer?.preset || tplEntry?.preset || tplEntry;
      // the blank templates keep a fixed id, so anything persisted while a blank project was open
      // (a demo song dragged in, a clip, a lyric pass) would be handed to the next "new project".
      // a blank start is always a blank start.
      const isBlankStart = curPid === 'blank' || curPid === 'new_blank';
      state.favoriteClips = [];
      renderFavoritesGrid();
      let bundleState =
        !forceStarter && !isBlankStart && curPid && window.projectBundleService?.loadProjectState
          ? await window.projectBundleService.loadProjectState(curPid)
          : null;

      // a project saved on another machine has no local record here, so that copy is the only one
      // that exists. pull only when this device is behind, so a normal open never waits on the
      // network for a project it already has.
      if (!forceStarter && !isBlankStart && curPid && window.projectVault?.pullIfNewer) {
        try {
          const newerState = await window.projectVault.pullIfNewer(curPid, {
            hasLocal: Boolean(bundleState)
          });
          if (newerState) bundleState = newerState;
        } catch (err) {
          console.warn('[project] could not restore a newer copy of this project', err);
        }
      }

      if (bundleState?.audioAsset?.blob) {
        showProjectLoading('restoring project media...');
        let catalogClips = Array.isArray(state.clips) ? [...state.clips] : [];
        if (catalogClips.length === 0) {
          const clipsData = await fetchOptionalJson('/api/clips');
          if (Array.isArray(clipsData?.clips)) catalogClips = clipsData.clips;
        }
        if (window.projectBundleService?.listCachedClips) {
          try {
            const cachedClips = await window.projectBundleService.listCachedClips();
            const localCached = cachedClips
              .filter((cc) => cc && (cc.isLocal || cc.source === 'local'))
              .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
              .map((cc) => ({
                ...cc,
                id: cc.id || cc.clipId,
                sourceId: cc.sourceId || cc.id || cc.clipId,
                url: cc.objectUrl || cc.url,
                isLocal: true
              }));
            catalogClips = mergeClipsIntoList(localCached, catalogClips);
          } catch { }
        }
        state.clips = mergeClipsIntoList(catalogClips, []);
        state._restoredBundlePresetId = curPid;
        const effectiveAudioBundle = resolveEffectiveBundleState(bundleState, activePresetObj?.projectState, false);
        await restoreBundleProjectState(effectiveAudioBundle);
        return;
      }

      const starterKey =
        activePresetObj?.meta?.starterPresetId ||
        activePresetObj?.meta?.forkedFrom?.id ||
        curPid ||
        'constellations';
      const data = (await fetchOptionalJson(`/api/starter?preset=${encodeURIComponent(starterKey)}`)) || {};
      if (data.project) {
        state.hasCustomAudio = false;
        state.hasCustomMidi = false;
        state.audioBlob = null;
        state.midiBlob = null;
        state._restoredBundlePresetId = null;

        // cache starter audio in a local blob url for zero-latency seeking
        if (data.project.audioUrl) {
          showProjectLoading('loading starter audio...');
          try {
            const wavRes = await fetch(data.project.audioUrl);
            if (wavRes.ok) {
              const wavBlob = await wavRes.blob();
              const localBlobUrl = URL.createObjectURL(wavBlob);
              state.localAudioUrl = localBlobUrl;
              data.project.serverAudioUrl = data.project.audioUrl;
              data.project.audioUrl = localBlobUrl;
            }
          } catch (fetchErr) {
            console.warn('Starter audio pre-fetch notice:', fetchErr);
          }
        }

        const clipModule = activePresetObj?.modules?.clips;
        const clipsEnabled = clipModule !== false && clipModule?.enabled !== false;
        const targetClipSource = clipModule?.source === 'real_life' ? 'real_life' : 'anime';
        let starterClips = Array.isArray(data.clips) ? [...data.clips] : [];
        if (window.projectBundleService?.listCachedClips) {
          try {
            const cachedClips = await window.projectBundleService.listCachedClips();
            const localCached = cachedClips
              .filter((cc) => cc && (cc.isLocal || cc.source === 'local'))
              .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
              .map((cc) => ({
                ...cc,
                id: cc.id || cc.clipId,
                sourceId: cc.sourceId || cc.id || cc.clipId,
                url: cc.objectUrl || cc.url,
                isLocal: true
              }));
            starterClips = mergeClipsIntoList(localCached, starterClips);
          } catch { }
        }

        if (clipsEnabled && starterClips.filter((c) => getClipSourceBucket(c) === targetClipSource).length === 0) {
          showProjectLoading('loading starter clips...');
          try {
            const fetchCtrl = typeof AbortController === 'function' ? new AbortController() : null;
            const fetchTimer = fetchCtrl ? setTimeout(() => fetchCtrl.abort(), 4500) : null;
            const clipFetchRes = await fetch('/api/clips/fetch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                category: clipModule?.category || 'all',
                customQuery: clipModule?.query || '',
                count: 8,
                mode: 'best',
                source: targetClipSource,
                excludeIds: []
              }),
              ...(fetchCtrl ? { signal: fetchCtrl.signal } : {})
            });
            if (fetchTimer) clearTimeout(fetchTimer);
            if (clipFetchRes.ok) {
              const fetchedData = await clipFetchRes.json();
              if (Array.isArray(fetchedData.added) && fetchedData.added.length > 0) {
                starterClips = mergeClipsIntoList(fetchedData.added, starterClips);
              }
            }
          } catch { }
        }

        showProjectLoading('initializing studio...');
        await yieldToPaint();
        if (forceStarter) {
          state.selectedClipIds = [];
          state.selectedClipStartTimes = [];
          state.selectedClipEndTimes = [];
          state.selectedClipSpeeds = [];
        }
        const effectiveBundleState = resolveEffectiveBundleState(bundleState, activePresetObj?.projectState, forceStarter);
        const shouldRestoreBundle = Boolean(curPid && state._restoredBundlePresetId !== curPid && effectiveBundleState);
        if (clipsEnabled && !bundleStateHasClips(effectiveBundleState) && (forceStarter || !bundleState) && state.selectedClipIds.length === 0) {
          const matchingRecs = Array.isArray(data.recommendedClips)
            ? data.recommendedClips.filter((c) => getClipSourceBucket(c) === targetClipSource)
            : [];
          const recPool = matchingRecs.length > 0
            ? matchingRecs
            : starterClips.filter((c) => getClipSourceBucket(c) === targetClipSource);
          const pickSource = recPool.length > 0 ? recPool : starterClips;
          const initialCount = getActiveCutMode() === 'single' ? 1 : 4;
          const initialSelection = pickSource.slice(0, initialCount).filter((c) => c && c.id);
          if (initialSelection.length > 0) {
            state.selectedClipIds = initialSelection.map((c) => c.id);
            state.selectedClipStartTimes = initialSelection.map((c) => normalizeClipStartTime(c.startTime ?? 0));
            state.selectedClipEndTimes = initialSelection.map(() => null);
            state.selectedClipSpeeds = initialSelection.map(() => 100);
          }
        }
        loadProjectIntoStudio(data.project, starterClips, { skipVideoSync: shouldRestoreBundle });
        if (shouldRestoreBundle) {
          state._restoredBundlePresetId = curPid;
          await restoreBundleProjectState(effectiveBundleState);
        }
      } else {
        // blank preset: zero preloaded audio or session
        state.project = null;
        state.clips = [];
        state.selectedClipIds = [];
        state.selectedClipStartTimes = [];
        state.selectedClipEndTimes = [];
        state.selectedClipSpeeds = [];
        state.hasCustomAudio = false;
        state.hasCustomMidi = false;
        state.audioBlob = null;
        state.midiBlob = null;
        if (audioEl) {
          audioEl.pause();
          audioEl.removeAttribute('src');
          audioEl.load();
        }
        if (els.inputBrand) els.inputBrand.value = '';
        if (els.inputNumber) els.inputNumber.value = '';
        if (els.inputTitle) els.inputTitle.value = '';
        if (els.inputBpm) els.inputBpm.value = '';
        if (els.inputKey) els.inputKey.value = '';
        if (els.uploadStatusText) els.uploadStatusText.textContent = 'no audio loaded · drop a sample to start';
        if (els.headerPreviewTag) els.headerPreviewTag.textContent = '[blank]';
        if (els.timeReadout) els.timeReadout.textContent = '00:00.00 / 00:00.00';
        visualizer?.selectedTrackIds?.clear?.();
        visualizer?.setProject?.(null);
        renderTrackList();
        const effectiveBlankState = resolveEffectiveBundleState(bundleState, activePresetObj?.projectState, forceStarter);
        const shouldRestoreBlank = Boolean(curPid && state._restoredBundlePresetId !== curPid && effectiveBlankState);
        if (!shouldRestoreBlank) {
          syncVideoPoolSources();
          renderClipGrid();
          visualizer?.renderFrame?.(0, null);
        }
        drawWaveform();
        if (shouldRestoreBlank) {
          state._restoredBundlePresetId = curPid;
          await restoreBundleProjectState(effectiveBlankState);
        }
      }
    } catch (err) {
      console.error('Failed to load starter project:', err);
    } finally {
      hideProjectLoading();
    }
  }

  const PROJECT_NOTES_DRAFT_KEY = 'samplevis_project_notes_v1';

  // the import path runs outside initVizStudio, so the draft helpers cannot live inside it
  function loadNotesDraftMap() {
    try {
      const raw = localStorage.getItem(PROJECT_NOTES_DRAFT_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveNotesDraftMap(map) {
    try {
      localStorage.setItem(PROJECT_NOTES_DRAFT_KEY, JSON.stringify(map));
    } catch { }
  }

  function clearNotesDraft(presetId) {
    if (!presetId) return;
    const map = loadNotesDraftMap();
    if (Object.prototype.hasOwnProperty.call(map, presetId)) {
      delete map[presetId];
      saveNotesDraftMap(map);
    }
  }

  // the import path runs outside initVizStudio, so it needs a handle on the studio callbacks
  let vizHotReloadPreset = null;
  let vizSetStatus = null;

  function initVizStudio() {
    const VIZ_CHAT_STORAGE_KEY = 'samplevis_viz_threads_v1';
    // function declarations hoist within this scope, so the handles can be published here
    vizHotReloadPreset = hotReloadPreset;
    vizSetStatus = setStatus;
    const drawer = document.getElementById('vizStudioDrawer');
    const sourceDrawer = document.getElementById('sourceCodeDrawer');
    const openBtn = document.getElementById('openVizStudioBtn');
    const closeBtn = document.getElementById('closeVizStudioBtn');
    const openSourceBtn = document.getElementById('openSourceDrawerBtn');
    const closeSourceBtn = document.getElementById('closeSourceDrawerBtn');
    const newChatBtn = document.getElementById('vizNewChatBtn');
    const historyToggleBtn = document.getElementById('vizHistoryToggleBtn');
    const historyPanel = document.getElementById('vizHistoryPanel');
    const historyList = document.getElementById('vizHistoryList');
    const clearHistoryBtn = document.getElementById('vizClearHistoryBtn');
    const notesToggleBtn = document.getElementById('vizNotesToggleBtn');
    const notesPanel = document.getElementById('vizNotesPanel');
    const notesInput = document.getElementById('vizNotesInput');
    const notesCounter = document.getElementById('vizNotesCounter');
    const clearNotesBtn = document.getElementById('vizClearNotesBtn');
    const chatFeed = document.getElementById('vizChatFeed');
    const emptyState = document.getElementById('vizEmptyState');
    const chatMessages = document.getElementById('vizChatMessages');
    const modelChip = document.getElementById('vizModelChip');

    const tabBtns = document.querySelectorAll('.viz-tab-btn');
    const panes = {
      shader: document.getElementById('vizPaneShader'),
      overlay: document.getElementById('vizPaneOverlay'),
      ui: document.getElementById('vizPaneUi')
    };

    const promptInput = document.getElementById('vizPromptInput');
    const generateBtn = document.getElementById('vizGenerateBtn');
    const undoBtn = document.getElementById('vizUndoBtn');
    const keyNotice = document.getElementById('vizKeyNotice');
    const openByokLink = document.getElementById('vizOpenByokLink');
    const composerBox = document.getElementById('vizComposerBox');
    const attachmentStrip = document.getElementById('vizAttachmentStrip');
    const imageInput = document.getElementById('vizImageInput');
    const attachImageBtn = document.getElementById('vizAttachImageBtn');
    const attachCanvasBtn = document.getElementById('vizAttachCanvasBtn');
    const attachLogsBtn = document.getElementById('vizAttachLogsBtn');

    const shaderEditor = document.getElementById('codeEditorShader');
    const postShaderEditor = document.getElementById('codeEditorPostShader');
    const initEditor = document.getElementById('codeEditorInit');
    const drawEditor = document.getElementById('codeEditorDraw');
    const uiEditor = document.getElementById('codeEditorUi');

    const applyBtn = document.getElementById('vizApplyCodeBtn');
    const saveBtn = document.getElementById('vizSavePresetBtn');
    const statusBar = document.getElementById('vizStudioStatus');
    const sourceStatusBar = document.getElementById('sourceCodeStatus');

    const SESSION_REVISIONS_KEY = 'samplevis_session_revisions_v1';
    const SESSION_ASSETS_KEY = 'samplevis_session_assets_v1';
    let isGenerating = false;
    let activeAbortController = null;
    let activeThinkingTimer = null;
    let pendingAttachments = [];
    let pendingLogsSnapshot = null;
    let hasUnappliedSourceEdits = false;

    function hashStringFast(str) {
      let h = 2166136261;
      const len = str.length;
      const step = Math.max(1, Math.floor(len / 256));
      for (let i = 0; i < len; i += step) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return `${(h >>> 0).toString(36)}_${len}`;
    }

    function loadSessionJson(key, fallback) {
      try {
        const raw = sessionStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    }

    const sessionAssetPool = loadSessionJson(SESSION_ASSETS_KEY, {});
    const revisionStore = loadSessionJson(SESSION_REVISIONS_KEY, {
      stacks: {},
      snapshots: {},
      order: []
    });
    revisionStore.stacks = revisionStore.stacks && typeof revisionStore.stacks === 'object' ? revisionStore.stacks : {};
    revisionStore.snapshots = revisionStore.snapshots && typeof revisionStore.snapshots === 'object' ? revisionStore.snapshots : {};
    revisionStore.order = Array.isArray(revisionStore.order) ? revisionStore.order : [];

    function getActivePresetKey() {
      return window.templateRegistry?.activeTemplateId || getActivePresetCopy().id || 'default';
    }

    function dehydratePresetForSession(preset) {
      const copy = JSON.parse(JSON.stringify(preset));
      if (typeof copy.meta?.thumbnail === 'string' && copy.meta.thumbnail.startsWith('data:image/') && copy.meta.thumbnail.length > 1024) {
        const key = `t_${hashStringFast(copy.meta.thumbnail)}`;
        sessionAssetPool[key] = copy.meta.thumbnail;
        copy.meta.thumbnail = { __assetRef: key };
      }
      if (typeof copy.assets?.customImage === 'string' && copy.assets.customImage.startsWith('data:image/') && copy.assets.customImage.length > 1024) {
        const key = `a_${hashStringFast(copy.assets.customImage)}`;
        sessionAssetPool[key] = copy.assets.customImage;
        copy.assets.customImage = { __assetRef: key };
      }
      if (Array.isArray(copy.assets?.customFonts)) {
        copy.assets.customFonts = copy.assets.customFonts.map((font) => {
          if (font && typeof font.dataUrl === 'string' && font.dataUrl.startsWith('data:') && font.dataUrl.length > 1024) {
            const key = `f_${hashStringFast(font.dataUrl)}`;
            sessionAssetPool[key] = font.dataUrl;
            return { ...font, dataUrl: { __assetRef: key } };
          }
          return font;
        });
      }
      return copy;
    }

    function hydratePresetFromSession(snap) {
      const copy = JSON.parse(JSON.stringify(snap));
      if (copy.meta?.thumbnail && typeof copy.meta.thumbnail === 'object' && copy.meta.thumbnail.__assetRef) {
        copy.meta.thumbnail = sessionAssetPool[copy.meta.thumbnail.__assetRef] || null;
      }
      if (copy.assets?.customImage && typeof copy.assets.customImage === 'object' && copy.assets.customImage.__assetRef) {
        copy.assets.customImage = sessionAssetPool[copy.assets.customImage.__assetRef] || '';
      }
      if (Array.isArray(copy.assets?.customFonts)) {
        copy.assets.customFonts = copy.assets.customFonts
          .map((font) => {
            if (font?.dataUrl && typeof font.dataUrl === 'object' && font.dataUrl.__assetRef) {
              const resolved = sessionAssetPool[font.dataUrl.__assetRef] || '';
              return resolved ? { ...font, dataUrl: resolved } : null;
            }
            return font;
          })
          .filter(Boolean);
      }
      return copy;
    }

    function pruneUnusedSessionAssets() {
      const referenced = new Set();
      Object.values(revisionStore.snapshots).forEach((entry) => {
        const tRef = entry?.preset?.meta?.thumbnail?.__assetRef;
        const aRef = entry?.preset?.assets?.customImage?.__assetRef;
        if (tRef) referenced.add(tRef);
        if (aRef) referenced.add(aRef);
        const fonts = entry?.preset?.assets?.customFonts;
        if (Array.isArray(fonts)) {
          fonts.forEach((f) => {
            if (f?.dataUrl?.__assetRef) referenced.add(f.dataUrl.__assetRef);
          });
        }
      });
      Object.keys(sessionAssetPool).forEach((k) => {
        if (!referenced.has(k)) delete sessionAssetPool[k];
      });
    }

    function persistSessionRevisions() {
      const writeStorage = () => {
        sessionStorage.setItem(SESSION_ASSETS_KEY, JSON.stringify(sessionAssetPool));
        sessionStorage.setItem(SESSION_REVISIONS_KEY, JSON.stringify(revisionStore));
      };
      try {
        pruneUnusedSessionAssets();
        writeStorage();
      } catch {
        Object.values(revisionStore.snapshots).forEach((entry) => {
          if (entry?.preset?.meta?.thumbnail?.__assetRef) {
            entry.preset.meta.thumbnail = null;
          }
        });
        pruneUnusedSessionAssets();
        try {
          writeStorage();
          return;
        } catch {
          while (revisionStore.order.length > 1) {
            const oldestId = revisionStore.order.shift();
            delete revisionStore.snapshots[oldestId];
            Object.keys(revisionStore.stacks).forEach((pid) => {
              revisionStore.stacks[pid] = revisionStore.stacks[pid].filter((id) => id !== oldestId);
            });
            pruneUnusedSessionAssets();
            try {
              writeStorage();
              return;
            } catch {
              // continue evicting oldest revision until within quota
            }
          }
        }
      }
    }

    function getActiveUndoStack() {
      const key = getActivePresetKey();
      if (!Array.isArray(revisionStore.stacks[key])) {
        revisionStore.stacks[key] = [];
      }
      return revisionStore.stacks[key];
    }

    function pushSessionRevision(presetBeforeChange, label = 'before edit') {
      const targetId = presetBeforeChange?.id || getActivePresetKey();
      const revId = `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const entry = {
        id: revId,
        presetId: targetId,
        label,
        createdAt: new Date().toISOString(),
        preset: dehydratePresetForSession(presetBeforeChange)
      };
      if (!Array.isArray(revisionStore.stacks[targetId])) {
        revisionStore.stacks[targetId] = [];
      }
      revisionStore.stacks[targetId].push(revId);
      revisionStore.snapshots[revId] = entry;
      revisionStore.order.push(revId);
      persistSessionRevisions();
      return revId;
    }

    function getRevisionSnapshotPreset(revId) {
      const entry = revId ? revisionStore.snapshots[revId] : null;
      return entry?.preset ? hydratePresetFromSession(entry.preset) : null;
    }

    function popSessionRevisionPreset() {
      const stack = getActiveUndoStack();
      while (stack.length > 0) {
        const revId = stack.pop();
        const preset = getRevisionSnapshotPreset(revId);
        if (preset) {
          persistSessionRevisions();
          return preset;
        }
      }
      persistSessionRevisions();
      return null;
    }

    function migrateSessionRevisions(fromId, toId) {
      if (!fromId || !toId || fromId === toId) return;
      const fromStack = revisionStore.stacks[fromId] || [];
      if (fromStack.length > 0) {
        const toStack = revisionStore.stacks[toId] || [];
        revisionStore.stacks[toId] = [...toStack, ...fromStack];
        delete revisionStore.stacks[fromId];
        fromStack.forEach((revId) => {
          const entry = revisionStore.snapshots[revId];
          if (entry) {
            entry.presetId = toId;
            if (entry.preset) entry.preset.id = toId;
          }
        });
        persistSessionRevisions();
      }
      threadStore.threads.forEach((t) => {
        if (t.presetId === fromId) t.presetId = toId;
      });
      if (threadStore.activeThreadByPreset?.[fromId]) {
        threadStore.activeThreadByPreset[toId] = threadStore.activeThreadByPreset[fromId];
        delete threadStore.activeThreadByPreset[fromId];
      }
      persistThreadStore();
    }

    function buildInPlaceRestoredPreset(snapshotPreset) {
      const current = getActivePresetCopy();
      const restored = JSON.parse(JSON.stringify(snapshotPreset));
      restored.id = current.id;
      if (current.meta?.ownerId === 'local') {
        restored.meta = {
          ...(restored.meta || {}),
          name: current.meta.name || restored.meta?.name,
          title: current.meta.title || current.meta.name || restored.meta?.title,
          badge: current.meta.badge || 'Custom',
          ownerId: current.meta.ownerId,
          author: current.meta.author,
          forkedFrom: current.meta.forkedFrom ?? restored.meta?.forkedFrom ?? null,
          notes: current.meta.notes !== undefined ? current.meta.notes : restored.meta?.notes,
          createdAt: current.meta.createdAt || restored.meta?.createdAt,
          updatedAt: new Date().toISOString()
        };
      } else if (current.meta?.notes !== undefined) {
        restored.meta = {
          ...(restored.meta || {}),
          notes: current.meta.notes
        };
      }
      return restored;
    }

    const NORMAL_THINKING_LINES = window.VIZ_THINKING_LINES?.normal || [
      'thinking hard...',
      'visualizing...',
      'imagining things...',
      'sketching geometry...',
      'blending sky stops...',
      'calibrating shader math...',
      'wrangling glsl uniforms...',
      'checking 9:16 + 16:9 balance...',
      'syncing with the drop...'
    ];

    const EASTER_EGG_THINKING_LINES = window.VIZ_THINKING_LINES?.easterEggs || [
      'scrolling reels...',
      'getting distracted...',
      'listening to this loop for the 40th time...',
      'watching anime for "reference"...'
    ];

    function pickThinkingLine(tickCount, previousLine = '') {
      if (tickCount === 0) {
        const starterWindow = Math.min(8, NORMAL_THINKING_LINES.length);
        return NORMAL_THINKING_LINES[Math.floor(Math.random() * starterWindow)];
      }
      const pool = Math.random() < 0.25 ? EASTER_EGG_THINKING_LINES : NORMAL_THINKING_LINES;
      if (pool.length <= 1) return pool[0] || 'thinking hard...';
      let picked = pool[Math.floor(Math.random() * pool.length)];
      if (picked === previousLine) {
        picked = pool[(pool.indexOf(picked) + 1) % pool.length];
      }
      return picked;
    }

    function clearThinkingInterval() {
      if (activeThinkingTimer) {
        clearInterval(activeThinkingTimer);
        activeThinkingTimer = null;
      }
    }

    function renderScaledImageDataUrl(img, maxDim, allowAlpha) {
      const natW = Math.max(1, img.naturalWidth || img.videoWidth || img.width || 1);
      const natH = Math.max(1, img.naturalHeight || img.videoHeight || img.height || 1);
      const scale = Math.min(1, maxDim / Math.max(natW, natH));
      const w = Math.max(1, Math.round(natW * scale));
      const h = Math.max(1, Math.round(natH * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);

      let hasAlpha = false;
      if (allowAlpha) {
        const pixels = ctx.getImageData(0, 0, w, h).data;
        for (let i = 3; i < pixels.length; i += 64) {
          if (pixels[i] < 248) {
            hasAlpha = true;
            break;
          }
        }
      }

      if (hasAlpha) {
        const pngUrl = c.toDataURL('image/png');
        if (pngUrl.length <= 1_400_000) return pngUrl;
      }
      return c.toDataURL('image/jpeg', 0.85);
    }

    function compressImageFile(file) {
      return new Promise((resolve, reject) => {
        if (!file || !file.type.startsWith('image/')) {
          reject(new Error('only image files are supported'));
          return;
        }
        const objUrl = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          try {
            const aiDataUrl = renderScaledImageDataUrl(img, 1440, true);
            const assetDataUrl = renderScaledImageDataUrl(img, 1280, true);
            resolve({
              id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              name: file.name || 'image',
              aiDataUrl,
              assetDataUrl,
              mode: 'auto'
            });
          } catch (err) {
            reject(err);
          } finally {
            URL.revokeObjectURL(objUrl);
          }
        };
        img.onerror = () => {
          URL.revokeObjectURL(objUrl);
          reject(new Error(`could not decode ${file.name || 'image'}`));
        };
        img.src = objUrl;
      });
    }

    function isFontFile(file) {
      if (!file) return false;
      const type = String(file.type || '').toLowerCase();
      const name = String(file.name || '').toLowerCase();
      if (type.startsWith('font/')) return true;
      if (/^application\/(x-font-|font-|vnd\.ms-fontobject)/.test(type)) return true;
      return /\.(ttf|otf|woff2?)$/.test(name);
    }

    function normalizeFontMimeType(file) {
      const type = String(file?.type || '').toLowerCase();
      if (type.startsWith('font/')) return type;
      const name = String(file?.name || '').toLowerCase();
      if (name.endsWith('.woff2')) return 'font/woff2';
      if (name.endsWith('.woff')) return 'font/woff';
      if (name.endsWith('.otf')) return 'font/otf';
      return 'font/ttf';
    }

    function deriveFontFamilyName(fileName) {
      const base = String(fileName || 'CustomFont')
        .replace(/\.[^./\\]+$/, '')
        .replace(/[_-]+/g, ' ')
        .replace(/[^a-zA-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return base || 'CustomFont';
    }

    async function loadCustomFontFile(file) {
      if (!isFontFile(file)) {
        throw new Error('only .ttf, .otf, .woff, or .woff2 font files are supported');
      }
      if (typeof FontFace === 'undefined' || !document.fonts) {
        throw new Error('custom font loading is not supported in this browser');
      }
      const family = deriveFontFamilyName(file.name);
      const mimeType = normalizeFontMimeType(file);
      const [buffer, rawDataUrl] = await Promise.all([
        file.arrayBuffer(),
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error(`could not read ${file.name || 'font'}`));
          reader.readAsDataURL(file);
        })
      ]);

      const face = new FontFace(family, buffer);
      const loaded = await face.load();
      document.fonts.add(loaded);

      const commaIdx = rawDataUrl.indexOf(',');
      const dataUrl = commaIdx !== -1
        ? `data:${mimeType};base64,${rawDataUrl.slice(commaIdx + 1)}`
        : rawDataUrl;

      return {
        id: `font_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        kind: 'font',
        name: file.name || `${family}.ttf`,
        family,
        mimeType,
        dataUrl,
        mode: 'embed'
      };
    }

    function extractVideoKeyframes(file, maxFrames = 5) {
      return new Promise((resolve, reject) => {
        if (!file || !file.type.startsWith('video/')) {
          reject(new Error('only video files are supported'));
          return;
        }
        const objUrl = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';

        const cleanup = () => {
          URL.revokeObjectURL(objUrl);
          video.removeAttribute('src');
          video.load();
        };

        video.onerror = () => {
          cleanup();
          reject(new Error(`could not decode ${file.name || 'video'}`));
        };

        video.onloadedmetadata = async () => {
          try {
            const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
            const vw = Math.max(1, video.videoWidth || 640);
            const vh = Math.max(1, video.videoHeight || 640);
            const scale = Math.min(1, 960 / Math.max(vw, vh));
            const cw = Math.max(1, Math.round(vw * scale));
            const ch = Math.max(1, Math.round(vh * scale));
            const canvas = document.createElement('canvas');
            canvas.width = cw;
            canvas.height = ch;
            const ctx = canvas.getContext('2d');

            const ratios = duration <= 0.3
              ? [0]
              : Array.from({ length: maxFrames }, (_, i) => 0.05 + (i / Math.max(1, maxFrames - 1)) * 0.87);
            const frames = [];

            for (const r of ratios) {
              const targetTime = Math.min(Math.max(0, duration * r), Math.max(0, duration - 0.05));
              await new Promise((resSeek) => {
                const onSeeked = () => {
                  video.removeEventListener('seeked', onSeeked);
                  resSeek();
                };
                video.addEventListener('seeked', onSeeked);
                video.currentTime = targetTime;
              });
              ctx.drawImage(video, 0, 0, cw, ch);
              frames.push(canvas.toDataURL('image/jpeg', 0.82));
            }

            cleanup();
            resolve({
              id: `vid_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              kind: 'video',
              name: file.name || 'reel video',
              duration: Math.round(duration * 10) / 10,
              frames,
              aiDataUrl: frames[0],
              assetDataUrl: '',
              mode: 'ref'
            });
          } catch (err) {
            cleanup();
            reject(err);
          }
        };

        video.src = objUrl;
      });
    }

    async function capturePreviewSnapshot(modeAt = 'current', frameCount = 1, stepSec = 0.6) {
      if (!previewCanvas || !previewCanvas.width || !previewCanvas.height) {
        throw new Error('preview canvas is not ready');
      }
      const at = modeAt === 'drop' ? 'drop' : 'current';
      const dur = state.project?.duration || 29.09;
      const dropT = getProjectDropTime();
      const captureTime = at === 'drop'
        ? Math.min(Math.max(0, dur - 0.05), dropT + 0.35)
        : (state.currentTime || 0);
      const stripCount = Math.min(6, Math.max(1, Math.round(Number(frameCount) || 1)));
      if (stripCount > 1) return captureFilmstrip(captureTime, stripCount, stepSec);
      const canAwait = Boolean(visualizer && typeof visualizer.renderFrameAwait === 'function');
      // a sandboxed preview paints inside the frame, so the host canvas is stale until a captured
      // render lands; always render before reading, playing or not
      const shouldRender = canAwait || Boolean(!state.isPlaying && visualizer && typeof visualizer.renderFrame === 'function');
      const switchedTime = shouldRender && at === 'drop' && Math.abs(captureTime - (state.currentTime || 0)) > 0.05;
      let targetVid = null;
      let prevVidTime = null;
      const engineRef = visualizer?.engine || null;
      const prevTrigTime = engineRef ? engineRef.lastTriggeredTime : undefined;

      try {
        if (switchedTime) {
          targetVid = getActiveVideoForTime(captureTime);
          if (targetVid && targetVid.duration) {
            prevVidTime = targetVid.currentTime;
            await seekVideoElement(targetVid, getClipTimeForTimestamp(captureTime, targetVid));
          }
        }
        if (shouldRender) {
          if (canAwait) {
            const renderTime = switchedTime ? captureTime : (state.currentTime || 0);
            const renderVid = switchedTime ? targetVid : getActiveVideoForTime(renderTime);
            await visualizer.renderFrameAwait(renderTime, renderVid || null);
          } else {
            visualizer.renderFrame(state.currentTime || 0, getActiveVideoForTime(state.currentTime || 0));
          }
        }

        const aiDataUrl = renderScaledImageDataUrl(previewCanvas, 960, false);
        return {
          id: `canvas_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          kind: 'canvas',
          captureAt: at,
          name: at === 'drop' ? 'canvas (drop).jpg' : 'canvas.jpg',
          aiDataUrl,
          assetDataUrl: '',
          mode: 'ref',
          lockMode: true
        };
      } finally {
        if (switchedTime && visualizer && typeof visualizer.renderFrame === 'function') {
          if (targetVid && prevVidTime !== null) {
            try { targetVid.currentTime = prevVidTime; } catch { }
          }
          if (engineRef && prevTrigTime !== undefined) {
            engineRef.lastTriggeredTime = prevTrigTime;
          }
          visualizer.renderFrame(state.currentTime || 0, getActiveVideoForTime(state.currentTime || 0));
        }
      }
    }

    // a single still cannot show motion, which is the failure that keeps recurring: a camera pass that
    // reads as a slideshow, a wave that stutters on a line. a contact sheet of evenly spaced frames is
    // the cheapest view of time the model can actually look at.
    async function captureFilmstrip(baseTime, count, stepSec) {
      const dur = state.project?.duration || 29.09;
      const step = Math.min(2, Math.max(0.2, Number(stepSec) || 0.6));
      const times = [];
      for (let i = 0; i < count; i += 1) {
        times.push(Math.min(Math.max(0, dur - 0.05), baseTime + i * step));
      }
      const W = previewCanvas.width || 1080;
      const H = previewCanvas.height || 1920;
      const tileH = 360;
      const tileW = Math.max(1, Math.round(tileH * (W / H)));
      const compose = document.createElement('canvas');
      compose.width = tileW * count;
      compose.height = tileH;
      const cctx = compose.getContext('2d');
      cctx.fillStyle = '#121829';
      cctx.fillRect(0, 0, compose.width, compose.height);

      const canAwait = Boolean(visualizer && typeof visualizer.renderFrameAwait === 'function');
      const restoreTimes = new Map();
      try {
        for (let i = 0; i < times.length; i += 1) {
          const t = times[i];
          const vid = getActiveVideoForTime(t);
          const clipTime = vid ? getClipTimeForTimestamp(t, vid) : null;
          if (vid && Number.isFinite(clipTime)) {
            if (!restoreTimes.has(vid)) restoreTimes.set(vid, vid.currentTime);
            await seekVideoElement(vid, clipTime);
          }
          if (canAwait) await visualizer.renderFrameAwait(t, vid || null);
          else if (visualizer && typeof visualizer.renderFrame === 'function') visualizer.renderFrame(t, vid || null);

          cctx.drawImage(previewCanvas, i * tileW, 0, tileW, tileH);
          cctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
          cctx.fillRect(i * tileW + 6, tileH - 24, 62, 18);
          cctx.fillStyle = '#f0f7f2';
          cctx.font = '12px sans-serif';
          cctx.fillText(`${t.toFixed(1)}s`, i * tileW + 10, tileH - 11);
        }
      } finally {
        for (const [vid, prev] of restoreTimes) {
          try { vid.currentTime = prev; } catch { }
        }
        const cur = state.currentTime || 0;
        try {
          if (canAwait) await visualizer.renderFrameAwait(cur, getActiveVideoForTime(cur) || null);
          else if (visualizer && typeof visualizer.renderFrame === 'function') visualizer.renderFrame(cur, getActiveVideoForTime(cur));
        } catch { }
      }

      return {
        id: `canvas_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        kind: 'canvas',
        captureAt: 'strip',
        name: `filmstrip ${count} frames.jpg`,
        aiDataUrl: renderScaledImageDataUrl(compose, 1280, false),
        assetDataUrl: '',
        mode: 'ref',
        lockMode: true
      };
    }

    async function probeActiveRendererLogs(modeAt = 'both') {
      const at = (modeAt === 'current' || modeAt === 'drop' || modeAt === 'sweep') ? modeAt : 'both';
      const curTime = state.currentTime || 0;
      const dur = state.project?.duration || 29.09;
      const dropT = getProjectDropTime();
      const dropProbeTime = Math.min(Math.max(0, dur - 0.05), dropT + 0.35);
      const curVid = getActiveVideoForTime(curTime);
      const engineRef = visualizer?.engine || null;

      // a sweep walks the arrangement instead of two points: structure, luma and lyric state across
      // the song. media is detached so a video element stuck on some other frame cannot be read as
      // the preset's own output.
      const sweepTimes = at === 'sweep'
        ? Array.from({ length: 8 }, (_, i) => Math.min(Math.max(0, dur - 0.05), dur * 0.02 + (dur * 0.96 * i) / 7))
        : [];

      // the sandboxed engine lives in another document; ask it for its own diagnostics
      if (visualizer?._sandbox && typeof visualizer._sandbox.requestDiagnostics === 'function') {
        if (at === 'sweep') {
          const samples = [];
          let lastDiag = null;
          try {
            for (const t of sweepTimes) {
              if (typeof visualizer.renderFrameAwait === 'function') await visualizer.renderFrameAwait(t, null);
              lastDiag = await visualizer._sandbox.requestDiagnostics();
              samples.push({
                label: `t=${t.toFixed(2)}s`,
                time: Number(t.toFixed(3)),
                lastFrame: lastDiag?.lastFrame || null
              });
            }
          } finally {
            try {
              if (typeof visualizer.renderFrameAwait === 'function') await visualizer.renderFrameAwait(curTime, curVid);
            } catch { }
          }
          return {
            label: at,
            rendererType: visualizer.id || 'unknown',
            media: 'detached',
            runtimeErrors: Array.isArray(lastDiag?.errors) ? lastDiag.errors : [],
            renderLogs: Array.isArray(lastDiag?.logs) ? lastDiag.logs : [],
            deadUniforms: [],
            hasDrawScript: Boolean(lastDiag?.hasDrawScript),
            stateKeys: Array.isArray(lastDiag?.stateKeys) ? lastDiag.stateKeys : [],
            traces: lastDiag?.traces || {},
            samples
          };
        }
        const diag = await visualizer._sandbox.requestDiagnostics();
        return {
          label: at,
          rendererType: visualizer.id || 'unknown',
          runtimeErrors: Array.isArray(diag?.errors) ? diag.errors : [],
          renderLogs: Array.isArray(diag?.logs) ? diag.logs : [],
          deadUniforms: Array.isArray(diag?.deadUniforms) ? diag.deadUniforms : [],
          hasDrawScript: Boolean(diag?.hasDrawScript),
          stateKeys: Array.isArray(diag?.stateKeys) ? diag.stateKeys : [],
          traces: diag?.traces || {},
          samples: [
            {
              label: at === 'drop' ? 'drop' : 'current',
              time: Number((at === 'drop' ? dropProbeTime : curTime).toFixed(3)),
              width: previewCanvas?.width || 1080,
              height: previewCanvas?.height || 1920,
              aspectRatio: state.aspectRatio,
              midi: {
                hasMidi: Boolean(state.project?.tracks?.length),
                selectedTracks: visualizer?.selectedTrackIds?.size || 0
              },
              clips: {
                activeCount: state.selectedClipIds?.length || 0
              },
              lastFrame: diag?.lastFrame || null
            }
          ]
        };
      }

      if (engineRef && typeof engineRef.probeRenderLogs === 'function') {
        if (at === 'sweep') {
          const probed = engineRef.probeRenderLogs(
            sweepTimes.map((t) => ({ label: `t=${t.toFixed(2)}s`, time: t, activeVideo: null })),
            { time: curTime, activeVideo: curVid }
          );
          return { ...probed, label: at, media: 'detached' };
        }
        const samples = [];
        let dropVid = null;
        let prevDropVidTime = null;
        try {
          if (at === 'current' || at === 'both') {
            samples.push({ label: 'current', time: curTime, activeVideo: curVid });
          }
          if (at === 'drop' || (at === 'both' && Math.abs(dropProbeTime - curTime) > 0.05)) {
            dropVid = getActiveVideoForTime(dropProbeTime);
            if (!state.isPlaying && dropVid && dropVid.duration) {
              prevDropVidTime = dropVid.currentTime;
              await seekVideoElement(dropVid, getClipTimeForTimestamp(dropProbeTime, dropVid));
            }
            samples.push({ label: 'drop', time: dropProbeTime, activeVideo: dropVid });
          }
          const probed = engineRef.probeRenderLogs(samples, { time: curTime, activeVideo: curVid });
          return { ...probed, label: at };
        } finally {
          if (dropVid && prevDropVidTime !== null) {
            try { dropVid.currentTime = prevDropVidTime; } catch { }
          }
        }
      }

      return {
        label: at,
        rendererType: visualizer?.id || 'unknown',
        runtimeErrors: [],
        renderLogs: ['[info] built-in canvas template renderer active (detailed shader/script logs apply to 3-box presets)'],
        deadUniforms: [],
        samples: [
          {
            label: at === 'drop' ? 'drop' : 'current',
            time: Number((at === 'drop' ? dropProbeTime : curTime).toFixed(3)),
            width: previewCanvas?.width || 1080,
            height: previewCanvas?.height || 1920,
            aspectRatio: state.aspectRatio,
            midi: {
              hasMidi: Boolean(state.project?.tracks?.length),
              selectedTracks: visualizer?.selectedTrackIds?.size || 0
            },
            clips: {
              activeCount: state.selectedClipIds?.length || 0
            }
          }
        ]
      };
    }

    function renderAttachmentStrip() {
      if (!attachmentStrip) return;
      attachmentStrip.textContent = '';
      if (pendingAttachments.length === 0 && !pendingLogsSnapshot) {
        attachmentStrip.hidden = true;
        return;
      }

      attachmentStrip.hidden = false;
      const modeTitles = {
        auto: 'auto: viz decides reference vs canvas layer (click to cycle)',
        embed: 'embed: integrate directly into the visualizer (click to cycle)',
        ref: 'ref: style/color reference only (click to cycle)'
      };

      pendingAttachments.forEach((att) => {
        const item = document.createElement('div');
        item.className = 'viz-attach-item';

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'viz-attach-remove';
        removeBtn.textContent = '×';
        removeBtn.title = att.kind === 'video'
          ? 'remove video'
          : (att.kind === 'font' ? 'remove font' : 'remove image');
        removeBtn.addEventListener('click', () => {
          pendingAttachments = pendingAttachments.filter((p) => p.id !== att.id);
          renderAttachmentStrip();
        });

        if (att.kind === 'font') {
          const preview = document.createElement('div');
          preview.className = 'viz-attach-font-preview';
          preview.style.fontFamily = `"${att.family}", sans-serif`;
          preview.textContent = 'Aa';
          preview.title = att.name;

          const fontTag = document.createElement('span');
          fontTag.className = 'viz-attach-mode locked';
          fontTag.textContent = `font · ${att.family}`;
          fontTag.title = `${att.name} loaded into document.fonts`;
          item.append(preview, fontTag, removeBtn);
          attachmentStrip.appendChild(item);
          return;
        }

        const thumb = document.createElement('img');
        thumb.className = 'viz-attach-thumb';
        thumb.src = att.aiDataUrl;
        thumb.alt = att.name;

        if (att.kind === 'video') {
          const badge = document.createElement('span');
          badge.className = 'viz-attach-badge';
          badge.textContent = `vid · ${Math.round(att.duration || 0)}s`;
          badge.title = `${att.frames?.length || 1} keyframes extracted for viz`;
          item.append(thumb, badge, removeBtn);
        } else if (att.lockMode || att.kind === 'canvas') {
          const modeTag = document.createElement('span');
          modeTag.className = 'viz-attach-mode locked';
          modeTag.textContent = 'canvas · ref';
          modeTag.title = 'canvas screenshot: visual reference only (never embedded into preset artwork)';
          item.append(thumb, modeTag, removeBtn);
        } else {
          const modeBtn = document.createElement('button');
          modeBtn.type = 'button';
          modeBtn.className = 'viz-attach-mode';
          modeBtn.textContent = att.mode;
          modeBtn.title = modeTitles[att.mode] || modeTitles.auto;
          modeBtn.addEventListener('click', () => {
            const order = ['auto', 'embed', 'ref'];
            att.mode = order[(order.indexOf(att.mode) + 1) % order.length];
            renderAttachmentStrip();
          });
          item.append(thumb, modeBtn, removeBtn);
        }

        attachmentStrip.appendChild(item);
      });

      if (pendingLogsSnapshot) {
        const logItem = document.createElement('div');
        logItem.className = 'viz-attach-item';
        const logTag = document.createElement('span');
        logTag.className = 'viz-attach-mode locked';
        const logCount = (pendingLogsSnapshot.renderLogs?.length || 0) + (pendingLogsSnapshot.runtimeErrors?.length || 0);
        logTag.textContent = logCount > 0 ? `logs · ${logCount}` : 'logs · telemetry';
        logTag.title = 'live renderer logs, dead uniforms, and frame telemetry';
        const removeLogBtn = document.createElement('button');
        removeLogBtn.type = 'button';
        removeLogBtn.className = 'viz-attach-remove';
        removeLogBtn.textContent = '×';
        removeLogBtn.title = 'remove render logs';
        removeLogBtn.addEventListener('click', () => {
          pendingLogsSnapshot = null;
          renderAttachmentStrip();
        });
        logItem.append(logTag, removeLogBtn);
        attachmentStrip.appendChild(logItem);
      }
    }

    async function addAttachedFiles(fileList) {
      const files = Array.from(fileList || []).filter(
        (f) => f && ((f.type && (f.type.startsWith('image/') || f.type.startsWith('video/'))) || isFontFile(f))
      );
      if (files.length === 0) return;

      const slots = Math.max(0, 3 - pendingAttachments.length);
      if (slots === 0) {
        setStatus('max 3 attachments per message', 'error');
        return;
      }

      for (const file of files.slice(0, slots)) {
        try {
          if (isFontFile(file)) {
            const fontAtt = await loadCustomFontFile(file);
            pendingAttachments.push(fontAtt);
            setStatus(`font "${fontAtt.family}" loaded`);
          } else if (file.type.startsWith('video/')) {
            setStatus(`extracting keyframes from ${file.name || 'video'}...`);
            const extracted = await extractVideoKeyframes(file, 5);
            pendingAttachments.push(extracted);
            setStatus('video keyframes ready');
          } else {
            const compressed = await compressImageFile(file);
            pendingAttachments.push(compressed);
          }
        } catch (err) {
          setStatus(err.message || 'media load failed', 'error');
        }
      }
      renderAttachmentStrip();
      promptInput?.focus();
    }

    function loadThreadStore() {
      // clear legacy persistent localstorage threads so chat history stays session-scoped
      try { localStorage.removeItem(VIZ_CHAT_STORAGE_KEY); } catch { }
      try {
        const raw = sessionStorage.getItem(VIZ_CHAT_STORAGE_KEY);
        if (!raw) return { activeThreadByPreset: {}, threads: [] };
        const parsed = JSON.parse(raw);
        const threads = Array.isArray(parsed.threads) ? parsed.threads : [];
        threads.forEach((t) => {
          if (Array.isArray(t.messages)) {
            t.messages.forEach((m) => {
              if (m && m.pending) {
                m.pending = false;
                m.error = true;
                m.text = m.text || 'request interrupted before completion.';
              }
            });
          }
        });
        return {
          activeThreadByPreset: parsed.activeThreadByPreset && typeof parsed.activeThreadByPreset === 'object'
            ? parsed.activeThreadByPreset
            : {},
          threads
        };
      } catch {
        return { activeThreadByPreset: {}, threads: [] };
      }
    }

    let threadStore = loadThreadStore();

    function persistThreadStore() {
      // keep threads per session and strip old snapshots cleanly if sessionstorage nears quota
      threadStore.threads = threadStore.threads
        .filter((t) => Array.isArray(t.messages) && t.messages.length > 0)
        .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
        .slice(0, 20);
      try {
        sessionStorage.setItem(VIZ_CHAT_STORAGE_KEY, JSON.stringify(threadStore));
      } catch {
        threadStore.threads.forEach((t, tIdx) => {
          t.messages.forEach((m, mIdx) => {
            if (tIdx > 2 || mIdx < t.messages.length - 1) {
              delete m.presetSnapshot;
            }
            if (tIdx > 1 || mIdx < t.messages.length - 2) {
              delete m.images;
            }
          });
        });
        try {
          sessionStorage.setItem(VIZ_CHAT_STORAGE_KEY, JSON.stringify(threadStore));
        } catch {
          threadStore.threads.forEach((t) => t.messages.forEach((m) => delete m.images));
          try {
            sessionStorage.setItem(VIZ_CHAT_STORAGE_KEY, JSON.stringify(threadStore));
          } catch {
            // ignore storage quota errors gracefully
          }
        }
      }
    }

    function getActiveThread() {
      const key = getActivePresetKey();
      const activeId = threadStore.activeThreadByPreset?.[key];
      if (!activeId) return null;
      return threadStore.threads.find((t) => t.id === activeId && t.presetId === key) || null;
    }

    function createThread(firstPrompt, preset) {
      const id = `thr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const presetKey = preset?.id || getActivePresetKey();
      const cleanTitle = String(firstPrompt || 'new chat').replace(/\s+/g, ' ').trim().slice(0, 56);
      const thread = {
        id,
        title: cleanTitle || 'new chat',
        presetId: presetKey,
        presetName: preset?.meta?.name || presetKey || 'preset',
        updatedAt: new Date().toISOString(),
        messages: []
      };
      threadStore.threads.unshift(thread);
      if (!threadStore.activeThreadByPreset) threadStore.activeThreadByPreset = {};
      threadStore.activeThreadByPreset[presetKey] = id;
      return thread;
    }

    function formatShortTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function countLineDiff(beforeText, afterText) {
      const splitLines = (txt) => {
        const s = String(txt || '').replace(/\r\n/g, '\n');
        return s.length ? s.split('\n') : [];
      };
      const a = splitLines(beforeText);
      const b = splitLines(afterText);

      let start = 0;
      while (start < a.length && start < b.length && a[start] === b[start]) start += 1;

      let endA = a.length - 1;
      let endB = b.length - 1;
      while (endA >= start && endB >= start && a[endA] === b[endB]) {
        endA -= 1;
        endB -= 1;
      }

      const midA = a.slice(start, endA + 1);
      const midB = b.slice(start, endB + 1);
      if (midA.length === 0 && midB.length === 0) return { added: 0, removed: 0 };

      let common = 0;
      if (midA.length * midB.length <= 250_000) {
        let prevRow = new Uint32Array(midB.length + 1);
        for (let i = 1; i <= midA.length; i++) {
          const currRow = new Uint32Array(midB.length + 1);
          for (let j = 1; j <= midB.length; j++) {
            currRow[j] = midA[i - 1] === midB[j - 1]
              ? prevRow[j - 1] + 1
              : Math.max(prevRow[j], currRow[j - 1]);
          }
          prevRow = currRow;
        }
        common = prevRow[midB.length];
      } else {
        const counts = new Map();
        midA.forEach((line) => counts.set(line, (counts.get(line) || 0) + 1));
        midB.forEach((line) => {
          const c = counts.get(line) || 0;
          if (c > 0) {
            counts.set(line, c - 1);
            common += 1;
          }
        });
      }

      return {
        added: midB.length - common,
        removed: midA.length - common
      };
    }

    function summarizePresetChanges(prevPreset, nextPreset) {
      const entries = [];
      const pushIfChanged = (name, beforeText, afterText) => {
        if ((beforeText || '') === (afterText || '')) return;
        const { added, removed } = countLineDiff(beforeText, afterText);
        if (added > 0 || removed > 0) {
          entries.push({ name, added, removed });
        }
      };

      pushIfChanged('shader', prevPreset?.shaderBox?.fragmentShader || '', nextPreset?.shaderBox?.fragmentShader || '');
      pushIfChanged('post-fx', prevPreset?.shaderBox?.postShader || '', nextPreset?.shaderBox?.postShader || '');

      const prevOverlay = [prevPreset?.frontUiBox?.initScript || '', prevPreset?.frontUiBox?.drawScript || '']
        .filter(Boolean)
        .join('\n');
      const nextOverlay = [nextPreset?.frontUiBox?.initScript || '', nextPreset?.frontUiBox?.drawScript || '']
        .filter(Boolean)
        .join('\n');
      pushIfChanged('overlay', prevOverlay, nextOverlay);

      const prevUi = JSON.stringify(
        {
          modules: prevPreset?.modules || {},
          features: prevPreset?.features || undefined,
          controlsBox: prevPreset?.controlsBox || {}
        },
        null,
        2
      );
      const nextUi = JSON.stringify(
        {
          modules: nextPreset?.modules || {},
          features: nextPreset?.features || undefined,
          controlsBox: nextPreset?.controlsBox || {}
        },
        null,
        2
      );
      pushIfChanged('controls & modules', prevUi, nextUi);

      if ((prevPreset?.assets?.customImage || '') !== (nextPreset?.assets?.customImage || '')) {
        entries.push({
          name: 'image',
          added: nextPreset?.assets?.customImage ? 1 : 0,
          removed: prevPreset?.assets?.customImage ? 1 : 0
        });
      }

      const prevFonts = Array.isArray(prevPreset?.assets?.customFonts) ? prevPreset.assets.customFonts.map((f) => f?.family).filter(Boolean) : [];
      const nextFonts = Array.isArray(nextPreset?.assets?.customFonts) ? nextPreset.assets.customFonts.map((f) => f?.family).filter(Boolean) : [];
      if (JSON.stringify(prevFonts) !== JSON.stringify(nextFonts)) {
        const addedFonts = nextFonts.filter((f) => !prevFonts.includes(f)).length;
        const removedFonts = prevFonts.filter((f) => !nextFonts.includes(f)).length;
        if (addedFonts > 0 || removedFonts > 0) {
          entries.push({ name: 'fonts', added: addedFonts, removed: removedFonts });
        }
      }

      return entries.length > 0 ? entries : [{ name: 'no code changes', added: 0, removed: 0 }];
    }

    function setStatus(msg, type = '') {
      if (statusBar) {
        statusBar.textContent = msg;
        statusBar.className = `viz-status-bar ${type}`.trim();
      }
    }

    function setSourceStatus(msg, type = '') {
      if (sourceStatusBar) {
        sourceStatusBar.textContent = msg;
        sourceStatusBar.className = `viz-status-bar ${type}`.trim();
      }
    }

    function syncModelUi() {
      if (keyNotice) {
        keyNotice.hidden = Boolean(window.ByokAiProvider && window.ByokAiProvider.hasKey());
      }
      if (modelChip && window.ByokAiProvider) {
        const s = window.ByokAiProvider.getSettings();
        modelChip.textContent = window.ByokAiProvider.hasKey()
          ? s.model || s.provider || 'model'
          : 'setup ai key';
      }
    }

    function autoResizePrompt() {
      if (!promptInput) return;
      if (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('field-sizing', 'content')) return;
      promptInput.style.height = 'auto';
      promptInput.style.height = `${Math.min(promptInput.scrollHeight, 132)}px`;
    }

    function getActivePresetCopy() {
      const tpl = window.templateRegistry?.activeTemplate;
      const base = tpl?.preset || window.STARTER_PRESET_DEFINITIONS?.[tpl?.id];
      if (!base) {
        return JSON.parse(JSON.stringify(window.STARTER_PRESET_DEFINITIONS.new_blank));
      }
      return JSON.parse(JSON.stringify(base));
    }

    function getNotesLimits() {
      return window.ByokAiProvider?.getProjectNotesLimits?.() || { maxLines: 100, maxChars: 4000 };
    }

    function normalizeNotesText(raw, { trim = true } = {}) {
      if (window.ByokAiProvider?.normalizeProjectNotes) {
        return window.ByokAiProvider.normalizeProjectNotes(raw, { trim });
      }
      if (typeof raw !== 'string') return '';
      const { maxLines, maxChars } = getNotesLimits();
      let text = raw.replace(/\r\n?/g, '\n');
      if (trim) text = text.trim();
      const lines = text.split('\n');
      if (lines.length > maxLines) text = lines.slice(0, maxLines).join('\n');
      if (text.length > maxChars) text = text.slice(0, maxChars);
      return trim ? text.trimEnd() : text;
    }

    function getActiveProjectNotes() {
      const pid = getActivePresetKey();
      const drafts = loadNotesDraftMap();
      if (Object.prototype.hasOwnProperty.call(drafts, pid)) {
        return normalizeNotesText(drafts[pid], { trim: false });
      }
      const preset = getActivePresetCopy();
      return normalizeNotesText(preset?.meta?.notes || '', { trim: false });
    }

    function updateNotesUi(text) {
      const normalized = typeof text === 'string' ? text : '';
      const { maxLines, maxChars } = getNotesLimits();
      const lines = normalized ? normalized.split('\n') : [];
      const lineCount = lines.length;
      const nonEmptyCount = lines.filter((l) => l.trim().length > 0).length;
      if (notesCounter) {
        notesCounter.textContent = `${lineCount} / ${maxLines} lines · ${normalized.length}/${maxChars}`;
      }
      if (notesToggleBtn) {
        notesToggleBtn.textContent = nonEmptyCount > 0 ? `notes (${nonEmptyCount})` : 'notes';
      }
    }

    function setActiveProjectNotes(rawText, { markDirty = false, syncInput = true, trim = true } = {}) {
      const normalized = normalizeNotesText(rawText, { trim });
      const pid = getActivePresetKey();
      const drafts = loadNotesDraftMap();
      drafts[pid] = normalized;
      saveNotesDraftMap(drafts);

      const tplPreset = window.templateRegistry?.activeTemplate?.preset;
      if (tplPreset) {
        tplPreset.meta = tplPreset.meta || {};
        if (normalized.trim()) {
          tplPreset.meta.notes = normalized;
        } else {
          delete tplPreset.meta.notes;
        }
      }
      if (syncInput && notesInput && notesInput.value !== normalized) {
        notesInput.value = normalized;
      }
      updateNotesUi(normalized);
      if (markDirty) markProjectDirty();
      return normalized;
    }

    // the static audit lives in ControlsManager; this adds the one thing it cannot see — a uniform
    // that is declared but optimized out because the shader never reads it
    async function refreshControlWiring() {
      const container = els.templateControlsContainer;
      if (!container) return;
      let dead = [];
      try {
        if (visualizer?._sandbox && typeof visualizer._sandbox.requestDiagnostics === 'function') {
          const diag = await visualizer._sandbox.requestDiagnostics();
          dead = Array.isArray(diag?.deadUniforms) ? diag.deadUniforms : [];
        } else if (visualizer?.engine && Array.isArray(visualizer.engine.deadUniforms)) {
          dead = visualizer.engine.deadUniforms.slice();
        }
      } catch { }
      window.ControlsManager?.markDeadUniforms?.(container, dead);
    }

    function syncEditorsFromActive() {
      const preset = getActivePresetCopy();
      if (shaderEditor) shaderEditor.value = (preset.shaderBox?.fragmentShader || '').trim();
      if (postShaderEditor) postShaderEditor.value = (preset.shaderBox?.postShader || '').trim();
      if (initEditor) initEditor.value = (preset.frontUiBox?.initScript || '').trim();
      if (drawEditor) drawEditor.value = (preset.frontUiBox?.drawScript || '').trim();
      if (uiEditor) {
        const uiPayload = {
          modules: preset.modules || {},
          controlsBox: preset.controlsBox || { fields: [], values: {} }
        };
        if (preset.features) uiPayload.features = preset.features;
        uiEditor.value = JSON.stringify(uiPayload, null, 2);
      }
      hasUnappliedSourceEdits = false;
      syncModelUi();
      const activeNotes = getActiveProjectNotes();
      if (window.templateRegistry?.activeTemplate?.preset) {
        const tplPreset = window.templateRegistry.activeTemplate.preset;
        tplPreset.meta = tplPreset.meta || {};
        if (activeNotes.trim()) tplPreset.meta.notes = activeNotes;
        else delete tplPreset.meta.notes;
      }
      if (notesInput && document.activeElement !== notesInput) {
        notesInput.value = activeNotes;
      }
      updateNotesUi(activeNotes);
      const revCount = getActiveUndoStack().length;
      if (undoBtn) {
        undoBtn.disabled = revCount === 0;
        undoBtn.textContent = revCount > 0 ? `undo (${revCount})` : 'undo';
        undoBtn.title = revCount > 0
          ? `revert to previous revision (${revCount} stored in session)`
          : 'nothing to undo in this session';
      }
    }

    function setHistoryOpen(show) {
      if (!historyPanel || !chatFeed) return;
      if (show && notesPanel && !notesPanel.hidden) {
        notesPanel.hidden = true;
        if (notesToggleBtn) {
          notesToggleBtn.classList.remove('active');
          notesToggleBtn.setAttribute('aria-expanded', 'false');
        }
      }
      historyPanel.hidden = !show;
      chatFeed.hidden = show || (notesPanel ? !notesPanel.hidden : false);
      if (historyToggleBtn) {
        historyToggleBtn.classList.toggle('active', show);
        historyToggleBtn.setAttribute('aria-expanded', String(show));
      }
      if (show) renderHistoryList();
    }

    function setNotesOpen(show) {
      if (!notesPanel || !chatFeed) return;
      if (show && historyPanel && !historyPanel.hidden) {
        historyPanel.hidden = true;
        if (historyToggleBtn) {
          historyToggleBtn.classList.remove('active');
          historyToggleBtn.setAttribute('aria-expanded', 'false');
        }
      }
      notesPanel.hidden = !show;
      chatFeed.hidden = show || (historyPanel ? !historyPanel.hidden : false);
      if (notesToggleBtn) {
        notesToggleBtn.classList.toggle('active', show);
        notesToggleBtn.setAttribute('aria-expanded', String(show));
      }
      if (show) {
        const activeNotes = getActiveProjectNotes();
        if (notesInput) {
          notesInput.value = activeNotes;
          notesInput.focus();
        }
        updateNotesUi(activeNotes);
      }
    }

    function renderHistoryList() {
      if (!historyList) return;
      historyList.textContent = '';

      const activeKey = getActivePresetKey();
      const projectThreads = threadStore.threads.filter((t) => t.presetId === activeKey);
      const activeId = threadStore.activeThreadByPreset?.[activeKey] || null;

      if (projectThreads.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'viz-history-empty';
        empty.textContent = 'no saved conversations for this project yet.';
        historyList.appendChild(empty);
        return;
      }

      projectThreads.forEach((thread) => {
        const row = document.createElement('div');
        row.className = `viz-history-item${thread.id === activeId ? ' active' : ''}`;
        row.tabIndex = 0;

        const main = document.createElement('div');
        main.className = 'viz-history-item-main';

        const title = document.createElement('div');
        title.className = 'viz-history-item-title';
        title.textContent = thread.title || 'untitled chat';

        const meta = document.createElement('div');
        meta.className = 'viz-history-item-meta';
        const msgCount = thread.messages?.length || 0;
        const when = formatShortTime(thread.updatedAt);
        meta.textContent = `${msgCount} msg${msgCount === 1 ? '' : 's'}${when ? ` · ${when}` : ''}`;

        main.append(title, meta);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'viz-history-del-btn';
        delBtn.title = 'delete conversation';
        delBtn.textContent = '×';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          threadStore.threads = threadStore.threads.filter((t) => t.id !== thread.id);
          if (threadStore.activeThreadByPreset?.[activeKey] === thread.id) {
            const nextForProject = threadStore.threads.find((t) => t.presetId === activeKey);
            threadStore.activeThreadByPreset[activeKey] = nextForProject?.id || null;
          }
          persistThreadStore();
          renderHistoryList();
          renderChatMessages();
        });

        row.append(main, delBtn);
        const selectThread = () => {
          if (!threadStore.activeThreadByPreset) threadStore.activeThreadByPreset = {};
          threadStore.activeThreadByPreset[activeKey] = thread.id;
          persistThreadStore();
          setHistoryOpen(false);
          renderChatMessages();
        };
        row.addEventListener('click', selectThread);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectThread();
          }
        });
        historyList.appendChild(row);
      });
    }

    function renderChatMessages() {
      if (!chatMessages || !emptyState || !chatFeed) return;
      const thread = getActiveThread();
      const messages = thread?.messages || [];

      emptyState.hidden = messages.length > 0;
      chatMessages.textContent = '';

      messages.forEach((msg) => {
        if (msg.role === 'user') {
          const bubble = document.createElement('div');
          bubble.className = 'viz-msg viz-msg-user';
          if ((Array.isArray(msg.images) && msg.images.length > 0) || (Array.isArray(msg.fonts) && msg.fonts.length > 0)) {
            const thumbs = document.createElement('div');
            thumbs.className = 'viz-msg-thumbs';
            (msg.images || []).forEach((src) => {
              if (!src) return;
              const img = document.createElement('img');
              img.className = 'viz-msg-thumb';
              img.src = src;
              img.alt = 'uploaded reference';
              thumbs.appendChild(img);
            });
            (msg.fonts || []).forEach((f) => {
              if (!f?.family) return;
              const chip = document.createElement('span');
              chip.className = 'viz-msg-font-chip';
              const spec = document.createElement('span');
              spec.className = 'viz-msg-font-specimen';
              spec.style.fontFamily = `"${f.family}", sans-serif`;
              spec.textContent = 'Aa';
              const label = document.createElement('span');
              label.textContent = f.family;
              chip.append(spec, label);
              thumbs.appendChild(chip);
            });
            if (thumbs.childElementCount > 0) {
              bubble.appendChild(thumbs);
            }
          }
          if (msg.text) {
            const textNode = document.createElement('div');
            textNode.textContent = msg.text;
            bubble.appendChild(textNode);
          }
          chatMessages.appendChild(bubble);
          return;
        }

        const block = document.createElement('div');
        block.className = 'viz-msg viz-msg-assistant';

        const meta = document.createElement('div');
        meta.className = 'viz-msg-meta';
        const roleSpan = document.createElement('span');
        roleSpan.className = 'viz-msg-role';
        roleSpan.textContent = 'viz';
        meta.appendChild(roleSpan);

        if (msg.model) {
          const modelSpan = document.createElement('span');
          modelSpan.textContent = `· ${msg.model}`;
          meta.appendChild(modelSpan);
        }
        const timeStr = formatShortTime(msg.createdAt);
        if (timeStr) {
          const timeSpan = document.createElement('span');
          timeSpan.textContent = `· ${timeStr}`;
          meta.appendChild(timeSpan);
        }
        block.appendChild(meta);

        if (msg.pending) {
          const thinkWrap = document.createElement('div');
          thinkWrap.className = 'viz-thinking-wrap';

          const thinkRow = document.createElement('div');
          thinkRow.className = 'viz-thinking-row';

          const thinking = document.createElement('div');
          thinking.className = 'viz-msg-thinking';
          thinking.textContent = msg.thinkingText || 'thinking hard...';

          const timerEl = document.createElement('span');
          timerEl.className = 'viz-thinking-timer';
          timerEl.textContent = `${msg.elapsedSec || 0}s`;

          thinkRow.append(thinking, timerEl);

          const track = document.createElement('div');
          track.className = 'viz-thinking-track';
          const bar = document.createElement('div');
          bar.className = 'viz-thinking-bar';
          track.appendChild(bar);

          thinkWrap.append(thinkRow, track);
          block.appendChild(thinkWrap);
        } else if (msg.error) {
          const errBox = document.createElement('div');
          errBox.className = 'viz-msg-error-box';
          const errText = document.createElement('div');
          errText.textContent = msg.text;
          errBox.appendChild(errText);
          if (/api key|settings|401|403/i.test(msg.text)) {
            const fixBtn = document.createElement('button');
            fixBtn.type = 'button';
            fixBtn.className = 'viz-chip-action';
            fixBtn.style.alignSelf = 'flex-start';
            fixBtn.textContent = 'open ai settings [byok]';
            fixBtn.addEventListener('click', () => {
              document.getElementById('openAiSettingsBtn')?.click();
            });
            errBox.appendChild(fixBtn);
          }
          block.appendChild(errBox);
        } else {
          const textDiv = document.createElement('div');
          textDiv.className = 'viz-msg-text';
          textDiv.textContent = msg.text;
          block.appendChild(textDiv);

          if (msg.presetSnapshot) {
            const card = document.createElement('div');
            card.className = 'viz-change-card';

            const info = document.createElement('div');
            info.className = 'viz-change-info';

            const cardTitle = document.createElement('div');
            cardTitle.className = 'viz-change-title';
            cardTitle.textContent = msg.revisionNumber
              ? `revision #${msg.revisionNumber}`
              : 'revision';

            const cardTags = document.createElement('div');
            cardTags.className = 'viz-change-tags';
            const summaryItems = Array.isArray(msg.changesSummary) && msg.changesSummary.length > 0
              ? msg.changesSummary
              : ['preset json'];
            summaryItems.forEach((item) => {
              const span = document.createElement('span');
              span.className = 'viz-diff-item';
              if (typeof item === 'string') {
                span.textContent = item;
              } else if (item && item.name) {
                const nameEl = document.createElement('span');
                nameEl.className = 'viz-diff-name';
                nameEl.textContent = item.name;
                span.appendChild(nameEl);
                if (item.added > 0) {
                  const addEl = document.createElement('span');
                  addEl.className = 'viz-diff-add';
                  addEl.textContent = `+${item.added}`;
                  span.appendChild(addEl);
                }
                if (item.removed > 0) {
                  const delEl = document.createElement('span');
                  delEl.className = 'viz-diff-del';
                  delEl.textContent = `-${item.removed}`;
                  span.appendChild(delEl);
                }
              }
              cardTags.appendChild(span);
            });

            info.append(cardTitle, cardTags);

            const actions = document.createElement('div');
            actions.className = 'viz-change-actions';

            const beforeSnap = msg.beforeRevId ? getRevisionSnapshotPreset(msg.beforeRevId) : null;
            if (beforeSnap) {
              const revertBtn = document.createElement('button');
              revertBtn.type = 'button';
              revertBtn.className = 'viz-chip-action';
              revertBtn.textContent = 'revert before';
              revertBtn.title = 'revert to exact json before this change';
              revertBtn.addEventListener('click', async () => {
                const current = getActivePresetCopy();
                pushSessionRevision(current, 'before revert');
                const snap = getRevisionSnapshotPreset(msg.beforeRevId) || beforeSnap;
                await hotReloadPreset(buildInPlaceRestoredPreset(snap));
                markProjectDirty();
                setStatus('reverted to before this change', 'success');
              });
              actions.appendChild(revertBtn);
            }

            const restoreBtn = document.createElement('button');
            restoreBtn.type = 'button';
            restoreBtn.className = 'viz-chip-action';
            restoreBtn.textContent = 'apply this';
            restoreBtn.title = 'apply this revision json to current project';
            restoreBtn.addEventListener('click', async () => {
              const current = getActivePresetCopy();
              pushSessionRevision(current, 'before apply snapshot');
              await hotReloadPreset(buildInPlaceRestoredPreset(msg.presetSnapshot));
              markProjectDirty();
              setStatus('applied revision from chat', 'success');
            });

            const inspectBtn = document.createElement('button');
            inspectBtn.type = 'button';
            inspectBtn.className = 'viz-chip-action';
            inspectBtn.textContent = 'source';
            inspectBtn.title = 'view source code';
            inspectBtn.addEventListener('click', openSourceDrawer);

            actions.append(restoreBtn, inspectBtn);
            card.append(info, actions);
            block.appendChild(card);
          } else if (msg.noOpWarning) {
            const noOpCard = document.createElement('div');
            noOpCard.className = 'viz-change-card viz-peek-card';
            const info = document.createElement('div');
            info.className = 'viz-change-info';
            const title = document.createElement('div');
            title.className = 'viz-change-title';
            title.textContent = 'no code changes applied';
            const tags = document.createElement('div');
            tags.className = 'viz-change-tags';
            tags.textContent = 'model replied without modifying shader or overlay code';
            info.append(title, tags);
            noOpCard.appendChild(info);

            if (msg.retryPrompt) {
              const actions = document.createElement('div');
              actions.className = 'viz-change-actions';
              const retryBtn = document.createElement('button');
              retryBtn.type = 'button';
              retryBtn.className = 'viz-chip-action primary';
              retryBtn.textContent = 'retry fix';
              retryBtn.disabled = isGenerating;
              retryBtn.addEventListener('click', () => {
                if (isGenerating) return;
                sendVizMessage(null, {
                  promptText: `${msg.retryPrompt}\n\n(your previous response applied zero code changes—emit a complete updated preset object in json with actual shaderBox/frontUiBox edits.)`,
                  attachments: []
                });
              });
              actions.appendChild(retryBtn);
              noOpCard.appendChild(actions);
            }
            block.appendChild(noOpCard);
          }

          if (msg.notesUpdated && !msg.presetSnapshot) {
            const notesCard = document.createElement('div');
            notesCard.className = 'viz-change-card';
            const info = document.createElement('div');
            info.className = 'viz-change-info';
            const title = document.createElement('div');
            title.className = 'viz-change-title';
            title.textContent = 'project notes updated';
            info.appendChild(title);
            const actions = document.createElement('div');
            actions.className = 'viz-change-actions';
            const viewBtn = document.createElement('button');
            viewBtn.type = 'button';
            viewBtn.className = 'viz-chip-action';
            viewBtn.textContent = 'view notes';
            viewBtn.addEventListener('click', () => setNotesOpen(true));
            actions.appendChild(viewBtn);
            notesCard.append(info, actions);
            block.appendChild(notesCard);
          }

          if (msg.canvasPeekRequest && typeof msg.canvasPeekRequest === 'object') {
            const peek = msg.canvasPeekRequest;
            const peekStatus = peek.status || 'pending';
            const peekCard = document.createElement('div');
            peekCard.className = `viz-change-card viz-peek-card${peekStatus !== 'pending' ? ' is-resolved' : ''}`;

            const info = document.createElement('div');
            info.className = 'viz-change-info';
            const title = document.createElement('div');
            title.className = 'viz-change-title';
            const peekFrames = Math.min(6, Math.max(1, Math.round(Number(peek.frames) || 1)));
            title.textContent = peekStatus === 'sent'
              ? (peekFrames > 1 ? 'filmstrip sent' : 'canvas screenshot sent')
              : peekStatus === 'dismissed'
                ? 'canvas peek skipped'
                : 'viz would like to take a peek';

            const tags = document.createElement('div');
            tags.className = 'viz-change-tags';
            const hint = [
              peek.reason || 'inspect rendered canvas layout and pixels',
              peek.at === 'drop' ? 'drop frame' : 'current frame',
              peekFrames > 1 ? `${peekFrames} frames` : ''
            ].filter(Boolean).join(' · ');
            tags.textContent = hint;
            info.append(title, tags);
            peekCard.appendChild(info);

            if (peekStatus === 'pending') {
              const peekActions = document.createElement('div');
              peekActions.className = 'viz-change-actions';

              const sendPeekBtn = document.createElement('button');
              sendPeekBtn.type = 'button';
              sendPeekBtn.className = 'viz-chip-action primary viz-peek-btn';
              sendPeekBtn.textContent = peekFrames > 1 ? 'send filmstrip' : 'send screenshot';
              sendPeekBtn.disabled = isGenerating;
              sendPeekBtn.addEventListener('click', async () => {
                if (isGenerating) return;
                if (window.ByokAiProvider && typeof window.ByokAiProvider.supportsVision === 'function' && !window.ByokAiProvider.supportsVision()) {
                  const m = window.ByokAiProvider.getSettings?.()?.model || 'current model';
                  setStatus(`${m} is text-only — switch to a vision model in [byok]`, 'error');
                  return;
                }
                try {
                  const snap = await capturePreviewSnapshot(peek.at, peek.frames, peek.step);
                  peek.status = 'sent';
                  persistThreadStore();
                  renderChatMessages();
                  await sendVizMessage(null, {
                    promptText: peekFrames > 1
                      ? 'here is the requested filmstrip: evenly spaced frames from the current playhead, left to right, labelled with their time.'
                      : 'here is the requested canvas screenshot for visual inspection.',
                    attachments: [snap]
                  });
                } catch (err) {
                  setStatus(err.message || 'could not capture canvas screenshot', 'error');
                }
              });

              const skipPeekBtn = document.createElement('button');
              skipPeekBtn.type = 'button';
              skipPeekBtn.className = 'viz-chip-action viz-peek-btn';
              skipPeekBtn.textContent = 'skip';
              skipPeekBtn.disabled = isGenerating;
              skipPeekBtn.addEventListener('click', () => {
                if (isGenerating) return;
                peek.status = 'dismissed';
                persistThreadStore();
                renderChatMessages();
              });

              peekActions.append(sendPeekBtn, skipPeekBtn);
              peekCard.appendChild(peekActions);
            }

            block.appendChild(peekCard);
          }

          if (msg.renderLogsRequest && typeof msg.renderLogsRequest === 'object') {
            const req = msg.renderLogsRequest;
            const reqStatus = req.status || 'pending';
            const logsCard = document.createElement('div');
            logsCard.className = `viz-change-card viz-peek-card${reqStatus !== 'pending' ? ' is-resolved' : ''}`;

            const info = document.createElement('div');
            info.className = 'viz-change-info';
            const title = document.createElement('div');
            title.className = 'viz-change-title';
            title.textContent = reqStatus === 'sent'
              ? 'render logs sent'
              : reqStatus === 'dismissed'
                ? 'render logs skipped'
                : 'viz would like render logs';

            const tags = document.createElement('div');
            tags.className = 'viz-change-tags';
            const atText = req.at === 'drop' ? 'drop frame' : req.at === 'current' ? 'current frame' : req.at === 'sweep' ? '8-frame sweep' : 'current + drop';
            tags.textContent = [req.reason || 'inspect live renderer logs and frame telemetry', atText].filter(Boolean).join(' · ');
            info.append(title, tags);
            logsCard.appendChild(info);

            if (reqStatus === 'pending') {
              const logsActions = document.createElement('div');
              logsActions.className = 'viz-change-actions';

              const sendLogsBtn = document.createElement('button');
              sendLogsBtn.type = 'button';
              sendLogsBtn.className = 'viz-chip-action primary viz-peek-btn';
              sendLogsBtn.textContent = 'send render logs';
              sendLogsBtn.disabled = isGenerating;
              sendLogsBtn.addEventListener('click', async () => {
                if (isGenerating) return;
                try {
                  const probed = await probeActiveRendererLogs(req.at || 'both');
                  req.status = 'sent';
                  persistThreadStore();
                  renderChatMessages();
                  await sendVizMessage(null, {
                    promptText: 'here are the requested render logs and frame diagnostics.',
                    attachments: [],
                    renderDiagnostics: probed
                  });
                } catch (err) {
                  setStatus(err.message || 'could not collect render logs', 'error');
                }
              });

              const skipLogsBtn = document.createElement('button');
              skipLogsBtn.type = 'button';
              skipLogsBtn.className = 'viz-chip-action viz-peek-btn';
              skipLogsBtn.textContent = 'skip';
              skipLogsBtn.disabled = isGenerating;
              skipLogsBtn.addEventListener('click', () => {
                if (isGenerating) return;
                req.status = 'dismissed';
                persistThreadStore();
                renderChatMessages();
              });

              logsActions.append(sendLogsBtn, skipLogsBtn);
              logsCard.appendChild(logsActions);
            }

            block.appendChild(logsCard);
          }

          // a question inside the reply prose has no control attached to it, so it reads as an aside
          // and gets ignored. questions[] renders the fork as one-click answers instead.
          if (Array.isArray(msg.questions) && msg.questions.length > 0) {
            const qCard = document.createElement('div');
            qCard.className = 'viz-change-card viz-question-card';
            msg.questions.forEach((q) => {
              if (!q || !q.question) return;
              const row = document.createElement('div');
              row.className = 'viz-change-info';
              const qText = document.createElement('div');
              qText.className = 'viz-change-tags';
              qText.textContent = q.question;
              row.appendChild(qText);

              if (q.answered) {
                const answered = document.createElement('div');
                answered.className = 'viz-change-tags';
                answered.textContent = `answered · ${q.answered}`;
                row.appendChild(answered);
              } else {
                const chips = document.createElement('div');
                chips.className = 'viz-option-list';
                (Array.isArray(q.options) ? q.options : []).forEach((opt) => {
                  if (!opt || !opt.label) return;
                  const chip = document.createElement('button');
                  chip.type = 'button';
                  chip.className = 'viz-option-btn';
                  chip.textContent = opt.label;
                  chip.title = opt.prompt || opt.label;
                  chip.disabled = isGenerating;
                  chip.addEventListener('click', () => {
                    if (isGenerating) return;
                    q.answered = opt.label;
                    q.answerPrompt = opt.prompt || opt.label;
                    persistThreadStore();
                    // a turn can ask two questions, so answering one must not send: collect every
                    // fork in this reply, then send once with all of them. sending on the first chip
                    // left the second question unanswered on a turn that had already left.
                    const forks = msg.questions.filter((item) => item?.question && Array.isArray(item.options) && item.options.length > 0);
                    if (!forks.every((item) => Boolean(item.answered))) {
                      renderChatMessages();
                      return;
                    }
                    renderChatMessages();
                    sendVizMessage(forks.map((item) => item.answerPrompt || item.answered).join('\n\n'));
                  });
                  chips.appendChild(chip);
                });
                if (chips.childElementCount > 0) row.appendChild(chips);
              }
              qCard.appendChild(row);
            });
            if (qCard.childElementCount > 0) block.appendChild(qCard);
          }

          if (Array.isArray(msg.options) && msg.options.length > 0) {
            const optList = document.createElement('div');
            optList.className = 'viz-option-list';
            msg.options.forEach((opt) => {
              if (!opt || !opt.label) return;
              const optBtn = document.createElement('button');
              optBtn.type = 'button';
              optBtn.className = 'viz-option-btn';
              optBtn.textContent = opt.label;
              optBtn.title = opt.prompt || opt.label;
              optBtn.disabled = isGenerating;
              optBtn.addEventListener('click', () => {
                if (isGenerating) return;
                sendVizMessage(opt.prompt || opt.label);
              });
              optList.appendChild(optBtn);
            });
            if (optList.childElementCount > 0) {
              block.appendChild(optList);
            }
          }
        }

        chatMessages.appendChild(block);
      });

      chatFeed.scrollTop = chatFeed.scrollHeight;
    }

    async function hotReloadPreset(nextPreset) {
      if (!nextPreset.id) nextPreset.id = window.templateRegistry?.activeTemplateId || `viz_${Date.now()}`;
      if (!nextPreset.version) nextPreset.version = '1.0';
      if (!nextPreset.meta) nextPreset.meta = { name: nextPreset.id, aspectRatio: state.aspectRatio || '9:16' };

      // keep runtime custom image state synchronized with active preset
      state.customImageDataUrl = nextPreset.assets?.customImage || '';

      // clear any stale localstorage knob overrides so the preset definition applies cleanly
      try {
        localStorage.removeItem(`samplevis_preset_${nextPreset.id}`);
        localStorage.removeItem(`samplevis_template_${nextPreset.id}`);
      } catch { }

      const prevCutMode = state._activeCutMode || getActiveCutMode();
      const prevSelectedTrackIds = visualizer?.engine?.selectedTrackIds
        ? new Set(visualizer.engine.selectedTrackIds)
        : null;
      const prevSeamlessLoop = visualizer?.params?.seamlessLoop;
      const prevLoopStyle = visualizer?.params?.loopStyle;
      const prevClipTransition = visualizer?.params?.clipTransition;
      const prevClipTransitionDuration = visualizer?.params?.clipTransitionDuration;
      const nextIsCustomTrans = nextPreset?.modules?.clips?.customTransition === true;
      if (prevSeamlessLoop !== undefined || prevLoopStyle !== undefined || (!nextIsCustomTrans && (prevClipTransition !== undefined || prevClipTransitionDuration !== undefined))) {
        nextPreset.controlsBox = nextPreset.controlsBox || { fields: [], values: {} };
        nextPreset.controlsBox.values = nextPreset.controlsBox.values || {};
        if (prevSeamlessLoop !== undefined && nextPreset.controlsBox.values.seamlessLoop === undefined) {
          nextPreset.controlsBox.values.seamlessLoop = prevSeamlessLoop;
        }
        if (prevLoopStyle !== undefined && nextPreset.controlsBox.values.loopStyle === undefined) {
          nextPreset.controlsBox.values.loopStyle = prevLoopStyle;
        }
        if (!nextIsCustomTrans) {
          if (prevClipTransition !== undefined && nextPreset.controlsBox.values.clipTransition === undefined) {
            nextPreset.controlsBox.values.clipTransition = prevClipTransition;
          }
          if (prevClipTransitionDuration !== undefined && nextPreset.controlsBox.values.clipTransitionDuration === undefined) {
            nextPreset.controlsBox.values.clipTransitionDuration = prevClipTransitionDuration;
          }
        }
      }

      // force re-registration of the updated preset definition
      window.templateRegistry.templates.delete(nextPreset.id);
      window.templateRegistry.registerPreset(nextPreset);

      await window.templateRegistry.setTemplate(
        nextPreset.id,
        previewCanvas,
        state,
        els.templateControlsContainer
      );

      visualizer = window.templateRegistry.activeTemplate;
      if (prevSelectedTrackIds && visualizer?.engine && state.project?.tracks) {
        const validIds = new Set(state.project.tracks.map((tr) => tr.id));
        const restored = Array.from(prevSelectedTrackIds).filter((tid) => validIds.has(tid));
        if (restored.length > 0 || prevSelectedTrackIds.size === 0) {
          visualizer.engine.selectedTrackIds = new Set(restored);
          visualizer.engine.reinitPresetState();
        }
      }
      if (visualizer?.engine) {
        visualizer.engine.onAssetLoaded = () => {
          const activeVid = getActiveVideoForTime(state.currentTime);
          visualizer?.renderFrame?.(state.currentTime, activeVid);
        };
      }
      if (els.topPresetNameInput && visualizer) {
        els.topPresetNameInput.value = visualizer.name;
      }
      const nextCutMode = getActiveCutMode(visualizer);
      if (nextCutMode !== prevCutMode) {
        switchCutModePlaylist(prevCutMode, nextCutMode);
      }
      applyTemplateModules(visualizer);
      syncSeamlessLoopControl(visualizer);
      applyAspectRatio(nextPreset.meta?.aspectRatio || state.aspectRatio || '9:16', false);
      updateMetadataToVisualizer();
      renderTrackList();
      syncVideoPoolSources();
      renderClipGrid();

      const activeVid = getActiveVideoForTime(state.currentTime);
      if (visualizer && typeof visualizer.renderFrame === 'function') {
        visualizer.renderFrame(state.currentTime, activeVid);
      }
      refreshControlWiring();

      syncEditorsFromActive();
    }

    function openDrawer() {
      if (!drawer) return;
      syncEditorsFromActive();
      renderChatMessages();
      drawer.hidden = false;
      drawer.inert = false;
      setStatus('ready');
      setTimeout(() => promptInput?.focus(), 60);
    }

    function closeDrawer() {
      if (!drawer) return;
      drawer.hidden = true;
      drawer.inert = true;
      closeSourceDrawer();
    }

    function openSourceDrawer() {
      if (!sourceDrawer) return;
      if (drawer?.hidden) openDrawer();
      syncEditorsFromActive();
      sourceDrawer.hidden = false;
      sourceDrawer.inert = false;
      openSourceBtn?.setAttribute('aria-expanded', 'true');
      setSourceStatus('ready');
    }

    function closeSourceDrawer() {
      if (!sourceDrawer) return;
      sourceDrawer.hidden = true;
      sourceDrawer.inert = true;
      openSourceBtn?.setAttribute('aria-expanded', 'false');
    }

    if (openBtn) openBtn.addEventListener('click', () => (drawer.hidden ? openDrawer() : closeDrawer()));
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    if (openSourceBtn) openSourceBtn.addEventListener('click', () => (sourceDrawer.hidden ? openSourceDrawer() : closeSourceDrawer()));
    if (closeSourceBtn) closeSourceBtn.addEventListener('click', closeSourceDrawer);

    if (newChatBtn) {
      newChatBtn.addEventListener('click', () => {
        const activeKey = getActivePresetKey();
        if (threadStore.activeThreadByPreset) {
          delete threadStore.activeThreadByPreset[activeKey];
        }
        persistThreadStore();
        setHistoryOpen(false);
        setNotesOpen(false);
        renderChatMessages();
        setStatus('ready');
        promptInput?.focus();
      });
    }

    if (historyToggleBtn) {
      historyToggleBtn.addEventListener('click', () => {
        setHistoryOpen(historyPanel?.hidden ?? true);
      });
    }

    if (notesToggleBtn) {
      notesToggleBtn.addEventListener('click', () => {
        setNotesOpen(notesPanel?.hidden ?? true);
      });
    }

    if (notesInput) {
      notesInput.addEventListener('input', () => {
        const clamped = normalizeNotesText(notesInput.value, { trim: false });
        if (notesInput.value !== clamped) {
          const selStart = notesInput.selectionStart;
          notesInput.value = clamped;
          if (typeof selStart === 'number') {
            const pos = Math.min(selStart, clamped.length);
            notesInput.setSelectionRange(pos, pos);
          }
        }
        setActiveProjectNotes(clamped, { markDirty: true, syncInput: false, trim: false });
      });
    }

    if (clearNotesBtn) {
      clearNotesBtn.addEventListener('click', () => {
        setActiveProjectNotes('', { markDirty: true, syncInput: true, trim: true });
        notesInput?.focus();
      });
    }

    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener('click', () => {
        const activeKey = getActivePresetKey();
        threadStore.threads = threadStore.threads.filter((t) => t.presetId !== activeKey);
        if (threadStore.activeThreadByPreset) {
          delete threadStore.activeThreadByPreset[activeKey];
        }
        persistThreadStore();
        renderHistoryList();
        renderChatMessages();
      });
    }

    if (modelChip) {
      modelChip.addEventListener('click', () => {
        document.getElementById('openAiSettingsBtn')?.click();
      });
    }

    if (openByokLink) {
      openByokLink.addEventListener('click', () => {
        const aiBtn = document.getElementById('openAiSettingsBtn');
        if (aiBtn) aiBtn.click();
      });
    }

    window.addEventListener('samplevis:byok-updated', syncModelUi);

    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.vizTab;
        tabBtns.forEach((b) => b.classList.toggle('active', b === btn));
        Object.entries(panes).forEach(([key, pane]) => {
          if (pane) {
            pane.hidden = key !== target;
            pane.classList.toggle('active', key === target);
          }
        });
      });
    });

    document.querySelectorAll('.viz-chip-btn').forEach((chip) => {
      chip.addEventListener('click', () => {
        if (!promptInput) return;
        const text = chip.dataset.prompt || '';
        promptInput.value = promptInput.value ? `${promptInput.value.trim()} ${text}` : text;
        autoResizePrompt();
        promptInput.focus();
      });
    });

    [shaderEditor, postShaderEditor, initEditor, drawEditor, uiEditor].forEach((ed) => {
      if (ed) {
        ed.addEventListener('input', () => {
          hasUnappliedSourceEdits = true;
          markProjectDirty();
        });
      }
    });

    async function applySourceEdits() {
      let pushedRev = false;
      try {
        const current = getActivePresetCopy();
        pushSessionRevision(current, 'before manual source edit');
        pushedRev = true;

        const parsedUi = JSON.parse(uiEditor?.value || '{}');
        // a source edit rewrites layer 1 but must not delete a layer-3 pass it never mentioned;
        // clearing the textarea is the explicit way to remove one
        const nextShaderBox = {
          ...(current.shaderBox || {}),
          fragmentShader: shaderEditor?.value ?? (current.shaderBox?.fragmentShader || '')
        };
        if (postShaderEditor) {
          if (postShaderEditor.value.trim()) nextShaderBox.postShader = postShaderEditor.value;
          else delete nextShaderBox.postShader;
        }
        const updated = {
          ...current,
          meta: {
            ...(current.meta || {}),
            aspectRatio: state.aspectRatio || current.meta?.aspectRatio || '9:16'
          },
          modules: parsedUi.modules || current.modules || {},
          features: parsedUi.features !== undefined ? parsedUi.features : current.features,
          shaderBox: nextShaderBox,
          frontUiBox: {
            initScript: initEditor?.value ?? (current.frontUiBox?.initScript || ''),
            drawScript: drawEditor?.value ?? (current.frontUiBox?.drawScript || '')
          },
          controlsBox: parsedUi.controlsBox || current.controlsBox || { fields: [], values: {} }
        };

        await hotReloadPreset(updated);
        hasUnappliedSourceEdits = false;
        markProjectDirty();
        setSourceStatus('applied & reloaded', 'success');
        return true;
      } catch (err) {
        if (pushedRev) popSessionRevisionPreset();
        setSourceStatus(`error: ${err.message}`, 'error');
        throw err;
      }
    }

    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        applySourceEdits().catch(() => { });
      });
    }

    async function sendVizMessage(overridePrompt = null, customPayload = null) {
      if (isGenerating) return;
      const hasCustomPayload = Boolean(customPayload && typeof customPayload === 'object');
      const isQuickOption = typeof overridePrompt === 'string';
      const typedPrompt = hasCustomPayload
        ? String(customPayload.promptText || '').trim()
        : isQuickOption
          ? overridePrompt.trim()
          : (promptInput?.value.trim() || '');
      const currentAttachments = hasCustomPayload
        ? (Array.isArray(customPayload.attachments) ? [...customPayload.attachments] : [])
        : isQuickOption
          ? []
          : [...pendingAttachments];
      const currentLogsSnapshot = hasCustomPayload
        ? (customPayload.renderDiagnostics || null)
        : isQuickOption
          ? null
          : pendingLogsSnapshot;

      if (!typedPrompt && currentAttachments.length === 0 && !currentLogsSnapshot) {
        setStatus('type a message or attach media', 'error');
        promptInput?.focus();
        return;
      }

      const displayPrompt = typedPrompt || (currentAttachments.some((a) => a.kind === 'video')
        ? 'analyze the attached video keyframes and remake the visual layout and motion.'
        : currentAttachments.some((a) => a.kind === 'canvas')
          ? 'inspect the attached canvas screenshot and refine or fix the visual.'
          : currentAttachments.some((a) => a.kind === 'font')
            ? 'use the attached custom font in the visualizer.'
            : currentLogsSnapshot
              ? 'inspect the attached render logs and frame diagnostics.'
              : 'use or analyze the attached image for the visual.');
      const embedNotes = currentAttachments
        .map((att, idx) => {
          if (att.kind === 'font') {
            return `Font "${att.family}" (file: "${att.name}") is attached, registered in document.fonts, and stored in preset.assets.customFonts. Use it in drawScript via ctx.font = \`\${size}px "${att.family}", sans-serif\`.`;
          }
          if (att.kind === 'video') {
            return `Video "${att.name}" (${att.duration}s): ${att.frames?.length || 1} sequential keyframes attached in order from start to end.`;
          }
          if (att.kind === 'canvas' || att.lockMode) {
            const loc = att.captureAt === 'drop' ? 'drop frame' : 'current preview frame';
            return `Image ${idx + 1}: CANVAS SCREENSHOT (${loc}) — VISUAL INSPECTION ONLY (do NOT set embedUploadedImage: true or embed into u_image_tex/assets).`;
          }
          if (att.mode === 'embed') return `Image ${idx + 1}: EMBED inside visualizer (u_image_tex / frame.assets.drawImage).`;
          if (att.mode === 'ref') return `Image ${idx + 1}: VISUAL REFERENCE ONLY (palette/mood/composition).`;
          return '';
        })
        .filter(Boolean);
      const aiPrompt = embedNotes.length > 0
        ? `${displayPrompt}\n\n[attachment guidance]\n${embedNotes.join('\n')}`
        : displayPrompt;

      const previous = getActivePresetCopy();
      setHistoryOpen(false);
      setNotesOpen(false);
      let thread = getActiveThread();
      if (!thread) {
        thread = createThread(displayPrompt, previous);
      }

      const priorHistory = [...thread.messages];
      const settings = window.ByokAiProvider?.getSettings?.() || {};

      const attachedFonts = currentAttachments.filter((a) => a.kind === 'font');

      thread.messages.push({
        id: `m_${Date.now()}_u`,
        role: 'user',
        text: displayPrompt,
        images: currentAttachments.map((a) => a.aiDataUrl).filter(Boolean),
        fonts: attachedFonts.map((f) => ({ name: f.name, family: f.family })),
        createdAt: new Date().toISOString()
      });

      const pendingMsg = {
        id: `m_${Date.now()}_a`,
        role: 'assistant',
        text: '',
        model: settings.model || '',
        pending: true,
        thinkingText: pickThinkingLine(0),
        elapsedSec: 0,
        createdAt: new Date().toISOString()
      };
      thread.messages.push(pendingMsg);
      thread.updatedAt = new Date().toISOString();

      if (!isQuickOption && !hasCustomPayload) {
        if (promptInput) {
          promptInput.value = '';
          autoResizePrompt();
        }
        pendingAttachments = [];
        pendingLogsSnapshot = null;
        renderAttachmentStrip();
      }
      renderChatMessages();

      if (!window.ByokAiProvider?.hasKey()) {
        pendingMsg.pending = false;
        pendingMsg.error = true;
        pendingMsg.text = 'no api key configured yet. open ai settings [byok] to connect deepseek, claude, gemini, or local models.';
        if (keyNotice) keyNotice.hidden = false;
        persistThreadStore();
        renderChatMessages();
        setStatus('api key missing', 'error');
        return;
      }

      if (
        currentAttachments.some((a) => a.aiDataUrl || (Array.isArray(a.frames) && a.frames.length > 0)) &&
        typeof window.ByokAiProvider?.supportsVision === 'function' &&
        !window.ByokAiProvider.supportsVision()
      ) {
        pendingMsg.pending = false;
        pendingMsg.error = true;
        pendingMsg.text = `selected model "${settings.model}" does not accept image input. switch to a vision model in ai settings [byok] to send screenshots or media.`;
        persistThreadStore();
        renderChatMessages();
        setStatus('vision model required', 'error');
        return;
      }

      isGenerating = true;
      activeAbortController = new AbortController();
      if (generateBtn) {
        generateBtn.disabled = false;
        generateBtn.textContent = '■';
        generateBtn.title = 'stop generation';
        generateBtn.classList.add('is-stop');
      }
      chatMessages?.querySelectorAll('.viz-option-btn, .viz-peek-btn').forEach((btn) => {
        btn.disabled = true;
      });
      setStatus('viz is thinking...');

      const startedAt = Date.now();
      let timerTick = 0;
      let phraseTick = 0;
      clearThinkingInterval();
      activeThinkingTimer = setInterval(() => {
        timerTick += 1;
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        pendingMsg.elapsedSec = elapsedSec;
        const timerEl = chatMessages?.querySelector('.viz-thinking-timer');
        if (timerEl) timerEl.textContent = `${elapsedSec}s`;

        if (timerTick % 4 === 0) {
          phraseTick += 1;
          const line = pickThinkingLine(phraseTick, pendingMsg.thinkingText);
          pendingMsg.thinkingText = line;
          const thinkEl = chatMessages?.querySelector('.viz-msg-thinking');
          if (thinkEl) thinkEl.textContent = line;
        }
      }, 500);

      try {
        const visionFrames = [];
        const videoMeta = [];
        currentAttachments.forEach((a) => {
          if (a.kind === 'video' && Array.isArray(a.frames)) {
            videoMeta.push({ name: a.name, duration: a.duration, frameCount: a.frames.length });
            a.frames.forEach((frameUrl) => {
              if (visionFrames.length < 6) visionFrames.push({ aiDataUrl: frameUrl, dataUrl: frameUrl, name: a.name });
            });
          } else if (a.aiDataUrl && visionFrames.length < 6) {
            visionFrames.push({ aiDataUrl: a.aiDataUrl, dataUrl: a.aiDataUrl, name: a.name });
          }
        });

        const renderDiagnostics = currentLogsSnapshot || undefined;
        const runtimeErrors = Array.isArray(currentLogsSnapshot?.runtimeErrors)
          ? currentLogsSnapshot.runtimeErrors
          : [...(visualizer?.lastRuntimeErrors || visualizer?.engine?.lastRuntimeErrors || [])];

        const result = await window.ByokAiProvider.chatWithViz(
          aiPrompt,
          previous,
          {
            bpm: state.project?.bpm,
            key: state.project?.key,
            duration: state.project?.duration,
            dropTime: state.project?.dropTime,
            dropBar: state.project?.dropBar,
            sections: state.project?.sections,
            midi: { hasMidi: Boolean(state.project?.tracks?.length), tracks: state.project?.tracks },
            lyrics: { hasLyrics: Boolean(state.project?.lyrics?.lines?.length) },
            clips: {
              count: state.selectedClipIds?.length || 0,
              transition: state.clipTransition || 'glitch',
              transitionDuration: state.clipTransitionDuration || 0.35,
              isCustomTransition: isCustomClipTransitionActive(visualizer)
            },
            customFonts: (() => {
              const merged = new Map();
              (Array.isArray(previous?.assets?.customFonts) ? previous.assets.customFonts : []).forEach((f) => {
                if (f?.family) merged.set(f.family, { family: f.family, name: f.name || f.family });
              });
              attachedFonts.forEach((f) => {
                if (f?.family) merged.set(f.family, { family: f.family, name: f.name || f.family });
              });
              return Array.from(merged.values());
            })(),
            studioFonts: Array.isArray(window.STUDIO_FONTS?.families) ? [...window.STUDIO_FONTS.families] : undefined,
            pools: (() => {
              const out = {};
              const fields = Array.isArray(previous?.controlsBox?.fields) ? previous.controlsBox.fields : [];
              const vals = previous?.controlsBox?.values || {};
              for (const f of fields) {
                if (!f || f.type !== 'media_pool') continue;
                const arr = Array.isArray(vals[f.id]) ? vals[f.id] : [];
                const active = arr.filter((it) => it && it.enabled !== false);
                out[f.id] = {
                  label: f.label || f.id,
                  total: arr.length,
                  enabled: active.length,
                  names: arr.slice(0, 20).map((it) => it.name || it.id)
                };
              }
              return out;
            })(),
            aspectRatio: state.aspectRatio,
            customCues: state.project?._customCues || undefined,
            projectNotes: getActiveProjectNotes(),
            runtimeErrors,
            renderDiagnostics
          },
          priorHistory,
          visionFrames,
          { signal: activeAbortController.signal, videos: videoMeta }
        );

        pendingMsg.pending = false;
        pendingMsg.text = result.reply || 'done.';
        pendingMsg.options = Array.isArray(result.options) ? result.options : [];
        pendingMsg.questions = Array.isArray(result.questions) ? result.questions : [];
        pendingMsg.canvasPeekRequest = result.requestCanvasSnapshot
          ? { ...result.requestCanvasSnapshot, status: 'pending' }
          : null;
        pendingMsg.renderLogsRequest = result.requestRenderLogs
          ? { ...result.requestRenderLogs, status: 'pending' }
          : null;
        pendingMsg.createdAt = new Date().toISOString();

        const prevNotesNorm = normalizeNotesText(getActiveProjectNotes());
        let notesDiff = null;
        if (typeof result.projectNotes === 'string') {
          const nextNotesNorm = normalizeNotesText(result.projectNotes);
          if (nextNotesNorm !== prevNotesNorm) {
            setActiveProjectNotes(nextNotesNorm, { markDirty: true });
            pendingMsg.notesUpdated = true;
            notesDiff = countLineDiff(prevNotesNorm, nextNotesNorm);
          }
        }
        const activeNotesAfterTurn = normalizeNotesText(getActiveProjectNotes());

        if (result.preset) {
          const rawAiPreset = result.preset;

          // operate strictly inside the open project with the user's own identity/name/scope
          const mergedMeta = {
            ...(previous.meta || {}),
            // a description the creator already has is theirs; viz only names an empty project
            description: window.PresetDescription
              ? window.PresetDescription.resolveDescription(previous.meta?.description, rawAiPreset.meta?.description)
              : (rawAiPreset.meta?.description || previous.meta?.description || 'custom visual preset'),
            aspectRatio: state.aspectRatio || previous.meta?.aspectRatio || rawAiPreset.meta?.aspectRatio || '9:16',
            updatedAt: new Date().toISOString()
          };
          if (activeNotesAfterTurn) {
            mergedMeta.notes = activeNotesAfterTurn;
          } else {
            delete mergedMeta.notes;
          }
          const activeTopName = els.topPresetNameInput?.value.trim();
          if (activeTopName && activeTopName !== 'error') {
            mergedMeta.name = activeTopName;
            mergedMeta.title = activeTopName;
          }

          const prevModules = previous.modules || {};
          const rawModules = (rawAiPreset.modules && typeof rawAiPreset.modules === 'object') ? rawAiPreset.modules : null;
          const mergedModules = rawModules
            ? {
              ...prevModules,
              ...rawModules,
              clips: rawModules.clips && typeof rawModules.clips === 'object'
                ? { ...(prevModules.clips || {}), ...rawModules.clips }
                : prevModules.clips,
              midiTracks: rawModules.midiTracks && typeof rawModules.midiTracks === 'object'
                ? { ...(prevModules.midiTracks || {}), ...rawModules.midiTracks }
                : prevModules.midiTracks,
              dropMarker: rawModules.dropMarker && typeof rawModules.dropMarker === 'object'
                ? { ...(prevModules.dropMarker || {}), ...rawModules.dropMarker }
                : prevModules.dropMarker
            }
            : prevModules;

          const prevFeatures = previous.features || {};
          const rawFeatures = (rawAiPreset.features && typeof rawAiPreset.features === 'object') ? rawAiPreset.features : null;
          const mergedFeaturesRaw = rawFeatures
            ? {
              ...prevFeatures,
              ...rawFeatures,
              timeline: rawFeatures.timeline && typeof rawFeatures.timeline === 'object'
                ? { ...(prevFeatures.timeline || {}), ...rawFeatures.timeline }
                : prevFeatures.timeline
            }
            : prevFeatures;
          const inlineCueSeeds = {};
          if (Array.isArray(mergedFeaturesRaw?.timeline?.categories)) {
            mergedFeaturesRaw.timeline.categories = mergedFeaturesRaw.timeline.categories
              .filter((c) => c && typeof c === 'object')
              .map((c) => {
                const { cues, initialCues, ...cleanCat } = c;
                const seedArr = Array.isArray(cues) ? cues : (Array.isArray(initialCues) ? initialCues : null);
                const key = String(cleanCat.id || cleanCat.label || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
                if (key && seedArr) inlineCueSeeds[key] = seedArr;
                return cleanCat;
              });
          }
          const mergedFeatures = Object.keys(mergedFeaturesRaw).length > 0 ? mergedFeaturesRaw : undefined;

          const rawShader = (rawAiPreset.shaderBox && typeof rawAiPreset.shaderBox === 'object') ? rawAiPreset.shaderBox : null;
          const mergedShaderBox = {
            ...(previous.shaderBox || {}),
            ...(typeof rawShader?.fragmentShader === 'string' ? { fragmentShader: rawShader.fragmentShader } : {})
          };
          // an explicit empty string is how a turn removes a post pass; omitting the key keeps it
          if (typeof rawShader?.postShader === 'string') {
            if (rawShader.postShader.trim()) mergedShaderBox.postShader = rawShader.postShader;
            else delete mergedShaderBox.postShader;
          }

          const rawFrontUi = (rawAiPreset.frontUiBox && typeof rawAiPreset.frontUiBox === 'object') ? rawAiPreset.frontUiBox : null;
          const mergedFrontUiBox = {
            ...(previous.frontUiBox || {}),
            ...(typeof rawFrontUi?.initScript === 'string' ? { initScript: rawFrontUi.initScript } : {}),
            ...(typeof rawFrontUi?.drawScript === 'string' ? { drawScript: rawFrontUi.drawScript } : {})
          };

          const prevControls = previous.controlsBox || { fields: [], values: {} };
          const rawControls = (rawAiPreset.controlsBox && typeof rawAiPreset.controlsBox === 'object') ? rawAiPreset.controlsBox : null;
          const mergedControlsBox = {
            fields: Array.isArray(rawControls?.fields) ? rawControls.fields : (Array.isArray(prevControls.fields) ? prevControls.fields : []),
            values: {
              ...(prevControls.values && typeof prevControls.values === 'object' ? prevControls.values : {}),
              ...(rawControls?.values && typeof rawControls.values === 'object' ? rawControls.values : {})
            }
          };

          const nextPreset = {
            ...previous,
            id: previous.id,
            version: previous.version || rawAiPreset.version || '1.0',
            meta: mergedMeta,
            modules: mergedModules,
            features: mergedFeatures,
            shaderBox: mergedShaderBox,
            frontUiBox: mergedFrontUiBox,
            controlsBox: mergedControlsBox
          };

          if (window.MediaPoolHelper?.normalizePoolItems && nextPreset.controlsBox?.fields) {
            for (const f of nextPreset.controlsBox.fields) {
              if (f && f.type === 'media_pool') {
                const rawArr = nextPreset.controlsBox.values?.[f.id];
                nextPreset.controlsBox.values[f.id] = Array.isArray(rawArr)
                  ? window.MediaPoolHelper.normalizePoolItems(rawArr)
                  : [];
              }
            }
          }

          if (Array.isArray(result.imageGenerationRequests) && result.imageGenerationRequests.length > 0 && typeof window.ByokAiProvider?.generateImage === 'function') {
            const totalGen = result.imageGenerationRequests.length;
            for (let gi = 0; gi < totalGen; gi++) {
              const req = result.imageGenerationRequests[gi];
              setStatus(`generating library asset ${gi + 1}/${totalGen}...`);
              pendingMsg.thinkingText = `generating "${req.name}" (${gi + 1}/${totalGen})...`;
              try {
                const generatedDataUrl = await window.ByokAiProvider.generateImage(req.prompt, {
                  aspectRatio: req.aspectRatio || '1:1',
                  signal: activeAbortController.signal
                });
                const hasField = nextPreset.controlsBox.fields.some((f) => f && f.id === req.poolId);
                if (!hasField) {
                  nextPreset.controlsBox.fields.push({
                    id: req.poolId,
                    label: req.poolId.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(),
                    type: 'media_pool',
                    accept: 'any'
                  });
                }
                if (!Array.isArray(nextPreset.controlsBox.values[req.poolId])) {
                  nextPreset.controlsBox.values[req.poolId] = [];
                }
                const itemId = `gen_${Date.now().toString(36)}_${gi}`;
                let itemSrc = generatedDataUrl;
                const bundleSvc = window.projectBundleService;
                if (bundleSvc?.dataUrlToBlob && bundleSvc?.saveSlotMedia) {
                  const blob = bundleSvc.dataUrlToBlob(generatedDataUrl);
                  if (blob) {
                    const saved = await bundleSvc.saveSlotMedia(nextPreset.id || 'default', `${req.poolId}__${itemId}`, blob, {
                      kind: 'image',
                      name: `${req.name}.png`,
                      mimeType: blob.type || 'image/png'
                    });
                    if (saved?.idbRef) itemSrc = saved.idbRef;
                  }
                }
                nextPreset.controlsBox.values[req.poolId].push({
                  id: itemId,
                  name: req.name,
                  kind: 'image',
                  src: itemSrc,
                  enabled: true,
                  mimeType: 'image/png'
                });
              } catch (poolImgErr) {
                if (poolImgErr?.name === 'AbortError') throw poolImgErr;
                pendingMsg.text = `${pendingMsg.text} (asset "${req.name}" skipped: ${poolImgErr.message})`;
              }
            }
          }

          const combinedCode = `${nextPreset.shaderBox?.fragmentShader || ''}\n${nextPreset.frontUiBox?.drawScript || ''}`;
          const usesCustomImageApi = /u_image_tex|u_has_image|frame\.assets\.(customImage|drawImage)/.test(combinedCode);
          const embeddableImages = currentAttachments.filter(
            (a) => a.kind !== 'video' && a.kind !== 'canvas' && !a.lockMode && a.mode !== 'ref' && Boolean(a.assetDataUrl)
          );
          const embedAttachment = embeddableImages.find((a) => a.mode === 'embed')
            || ((result.embedUploadedImage || usesCustomImageApi) ? embeddableImages[0] : null);

          if (result.imageGenerationPrompt && typeof window.ByokAiProvider?.generateImage === 'function') {
            setStatus('generating custom image...');
            pendingMsg.thinkingText = 'generating custom image asset...';
            try {
              const generatedDataUrl = await window.ByokAiProvider.generateImage(result.imageGenerationPrompt, {
                aspectRatio: state.aspectRatio,
                signal: activeAbortController.signal
              });
              nextPreset.assets = {
                ...(nextPreset.assets || {}),
                customImage: generatedDataUrl
              };
            } catch (imgErr) {
              if (imgErr?.name === 'AbortError') throw imgErr;
              pendingMsg.text = `${pendingMsg.text} (image generation skipped: ${imgErr.message})`;
            }
          } else if (embedAttachment?.assetDataUrl) {
            nextPreset.assets = {
              ...(nextPreset.assets || {}),
              customImage: embedAttachment.assetDataUrl
            };
          } else if (usesCustomImageApi && previous.assets?.customImage) {
            nextPreset.assets = {
              ...(nextPreset.assets || {}),
              customImage: previous.assets.customImage
            };
          } else if (!nextPreset.assets && previous.assets?.customImage && embeddableImages.length === 0) {
            // preserve existing attached asset across reference/canvas turns unless explicitly cleared
            nextPreset.assets = { customImage: previous.assets.customImage };
          }

          const mergedFontsMap = new Map();
          (Array.isArray(previous.assets?.customFonts) ? previous.assets.customFonts : []).forEach((f) => {
            if (f?.family && f?.dataUrl) mergedFontsMap.set(f.family, f);
          });
          attachedFonts.forEach((f) => {
            if (f?.family && f?.dataUrl) {
              mergedFontsMap.set(f.family, {
                family: f.family,
                name: f.name,
                mimeType: f.mimeType,
                dataUrl: f.dataUrl
              });
            }
          });
          if (mergedFontsMap.size > 0) {
            nextPreset.assets = {
              ...(nextPreset.assets || {}),
              customFonts: Array.from(mergedFontsMap.values())
            };
          }

          const changesSummary = summarizePresetChanges(previous, nextPreset);
          const hasRealChanges = !(changesSummary.length === 1 && changesSummary[0]?.name === 'no code changes');
          if (hasRealChanges) {
            if (notesDiff && (notesDiff.added > 0 || notesDiff.removed > 0)) {
              changesSummary.push({ name: 'project notes', added: notesDiff.added, removed: notesDiff.removed });
            }
            const revId = pushSessionRevision(previous, `before: ${displayPrompt.slice(0, 36)}`);
            const revNum = (thread.messages.filter((m) => m.role === 'assistant' && Boolean(m.presetSnapshot)).length) + 1;
            pendingMsg.beforeRevId = revId;
            pendingMsg.revisionNumber = revNum;
            pendingMsg.changesSummary = changesSummary;
            pendingMsg.presetSnapshot = JSON.parse(JSON.stringify(nextPreset));
            thread.presetId = nextPreset.id;
            thread.presetName = nextPreset.meta.name || thread.presetName;

            await hotReloadPreset(nextPreset);
            applyTimelineCueSeeds({
              ...inlineCueSeeds,
              ...(result.timelineCueSeeds && typeof result.timelineCueSeeds === 'object' ? result.timelineCueSeeds : {})
            });
            markProjectDirty();
            setStatus(`revision #${revNum} applied`, 'success');
          } else {
            pendingMsg.noOpWarning = true;
            pendingMsg.retryPrompt = displayPrompt;
            setStatus('no code changes applied');
          }
        } else {
          applyTimelineCueSeeds(result.timelineCueSeeds);
          if (attachedFonts.length > 0 && window.templateRegistry?.activeTemplateId) {
            const activeTpl = window.templateRegistry.templates?.get(window.templateRegistry.activeTemplateId);
            if (activeTpl?.preset) {
              const mergedFontsMap = new Map();
              (Array.isArray(activeTpl.preset.assets?.customFonts) ? activeTpl.preset.assets.customFonts : []).forEach((f) => {
                if (f?.family && f?.dataUrl) mergedFontsMap.set(f.family, f);
              });
              attachedFonts.forEach((f) => {
                if (f?.family && f?.dataUrl) {
                  mergedFontsMap.set(f.family, {
                    family: f.family,
                    name: f.name,
                    mimeType: f.mimeType,
                    dataUrl: f.dataUrl
                  });
                }
              });
              activeTpl.preset.assets = {
                ...(activeTpl.preset.assets || {}),
                customFonts: Array.from(mergedFontsMap.values())
              };
              markProjectDirty();
            }
          }
          // a reply-only turn that says "done — sunColor is now #f7a4c6" is the most corrosive
          // failure in the loop: the claim persists in the transcript, the preset never changed,
          // and the old phrase list below only caught code talk, so the studio stayed silent
          const replyText = pendingMsg.text || '';
          const claimsCodeEdit = /\b(updated the preset|rebuilt the|fixed it in code|changed the shader|now pulling directly|now reads from|both should now animate|now animate live)\b/i.test(replyText);
          const claimsValueEdit = /\b(done|updated|swapped|renamed|replaced|changed|rewrote|rebuilt|added|removed|fixed|set|made)\b/i.test(replyText)
            && (/#[0-9a-f]{6}\b/i.test(replyText) || /`[^`]+`\s*(?:is|are)\s+now/i.test(replyText) || /\b(?:is|are)\s+now\b/i.test(replyText));
          if (claimsCodeEdit || claimsValueEdit) {
            pendingMsg.noOpWarning = true;
            pendingMsg.retryPrompt = displayPrompt;
          }
          setStatus('replied', 'success');
        }
      } catch (err) {
        pendingMsg.pending = false;
        if (err?.name === 'AbortError') {
          pendingMsg.error = false;
          pendingMsg.text = 'generation stopped.';
          setStatus('stopped');
        } else {
          pendingMsg.error = true;
          pendingMsg.text = err.message || 'request failed';
          setStatus('viz error', 'error');
        }
      } finally {
        clearThinkingInterval();
        activeAbortController = null;
        isGenerating = false;
        if (generateBtn) {
          generateBtn.disabled = false;
          generateBtn.textContent = '↑';
          generateBtn.title = 'send message [enter]';
          generateBtn.classList.remove('is-stop');
        }
        persistThreadStore();
        renderChatMessages();
      }
    }

    if (generateBtn) {
      generateBtn.addEventListener('click', () => {
        if (isGenerating && activeAbortController) {
          activeAbortController.abort();
          return;
        }
        sendVizMessage();
      });
    }

    if (attachImageBtn && imageInput) {
      attachImageBtn.addEventListener('click', () => imageInput.click());
      imageInput.addEventListener('change', (e) => {
        addAttachedFiles(e.target.files);
        imageInput.value = '';
      });
    }

    if (attachCanvasBtn) {
      attachCanvasBtn.addEventListener('click', async () => {
        if (pendingAttachments.length >= 3) {
          setStatus('max 3 attachments per message', 'error');
          return;
        }
        try {
          const snap = await capturePreviewSnapshot('current');
          pendingAttachments.push(snap);
          renderAttachmentStrip();
          if (window.ByokAiProvider && typeof window.ByokAiProvider.supportsVision === 'function' && !window.ByokAiProvider.supportsVision()) {
            const m = window.ByokAiProvider.getSettings?.()?.model || 'current model';
            setStatus(`canvas attached (${m} is text-only — switch in [byok])`, 'error');
          } else {
            setStatus('canvas screenshot attached');
          }
          promptInput?.focus();
        } catch (err) {
          setStatus(err.message || 'could not capture canvas', 'error');
        }
      });
    }

    if (attachLogsBtn) {
      attachLogsBtn.addEventListener('click', async () => {
        try {
          const probed = await probeActiveRendererLogs('both');
          pendingLogsSnapshot = probed;
          renderAttachmentStrip();
          setStatus('render logs attached');
          promptInput?.focus();
        } catch (err) {
          setStatus(err.message || 'could not collect render logs', 'error');
        }
      });
    }

    if (composerBox) {
      let dragDepth = 0;
      const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

      composerBox.addEventListener('dragenter', (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth += 1;
        composerBox.classList.add('drag-over');
      });
      composerBox.addEventListener('dragover', (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        composerBox.classList.add('drag-over');
      });
      composerBox.addEventListener('dragleave', (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) composerBox.classList.remove('drag-over');
      });
      composerBox.addEventListener('drop', (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth = 0;
        composerBox.classList.remove('drag-over');
        addAttachedFiles(e.dataTransfer?.files);
      });
    }

    if (chatFeed) {
      chatFeed.addEventListener('dragover', (e) => {
        if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
      });
      chatFeed.addEventListener('drop', (e) => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
        e.preventDefault();
        addAttachedFiles(e.dataTransfer?.files);
      });
    }

    if (promptInput) {
      promptInput.addEventListener('input', autoResizePrompt);
      promptInput.addEventListener('paste', (e) => {
        const items = Array.from(e.clipboardData?.items || []);
        const imageFiles = items
          .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
          .map((item) => item.getAsFile())
          .filter(Boolean);
        if (imageFiles.length > 0) {
          addAttachedFiles(imageFiles);
        }
      });
      promptInput.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendVizMessage();
        }
      });
    }

    if (undoBtn) {
      undoBtn.addEventListener('click', async () => {
        const prev = popSessionRevisionPreset();
        if (!prev) {
          syncEditorsFromActive();
          return;
        }
        await hotReloadPreset(buildInPlaceRestoredPreset(prev));
        markProjectDirty();
        setStatus('reverted to previous revision', 'success');
      });
    }

    async function buildCurrentPresetSnapshot(overrideName = null, overrideDescription = null) {
      if (hasUnappliedSourceEdits) {
        await applySourceEdits();
      }
      const current = getActivePresetCopy();
      const inputName = els.topPresetNameInput?.value.trim();
      const chosenName = (typeof overrideName === 'string' && overrideName.trim())
        ? overrideName.trim()
        : (inputName || current.meta?.name || 'Custom Preset');
      const chosenDesc = typeof overrideDescription === 'string'
        ? overrideDescription.trim()
        : current.meta?.description;

      const activeNotes = normalizeNotesText(getActiveProjectNotes());
      current.meta = {
        ...(current.meta || {}),
        name: chosenName,
        title: chosenName,
        ...(chosenDesc ? { description: chosenDesc } : {}),
        aspectRatio: state.aspectRatio || current.meta?.aspectRatio || '9:16',
        badge: 'Custom',
        updatedAt: new Date().toISOString()
      };
      if (activeNotes) current.meta.notes = activeNotes;
      else delete current.meta.notes;
      if (visualizer?.params) {
        current.controlsBox = current.controlsBox || { fields: [], values: {} };
        current.controlsBox.values = {
          ...(current.controlsBox.values || {}),
          ...visualizer.params
        };
      }
      if (state.project || (state.selectedClipIds || []).length > 0 || (state.favoriteClips || []).length > 0) {
        current.projectState = buildProjectStatePayload({ includeBlobs: false });
      }
      return current;
    }

    async function saveActivePreset(triggerBtn = null) {
      let current = null;
      try {
        current = await buildCurrentPresetSnapshot();
      } catch (err) {
        const msg = `could not save preset because source code edits are invalid:\n\n${err.message}`;
        setStatus(`save aborted: ${err.message}`, 'error');
        alert(msg);
        return false;
      }

      // where this project's files go is a per-save decision; without a vault (standalone) this is
      // null and the save behaves exactly as a local save
      let savePlan = null;
      if (window.projectVault?.beginSave) {
        // the song and uploaded clips are quoted in the same dialog as the preset's own slots,
        // because one answer decides whether anything at all leaves this device
        const rows = await listProjectMediaFiles(current.projectState);
        savePlan = await window.projectVault.beginSave({
          preset: current,
          presetId: current.id,
          rows: await window.projectVault.annotateRows?.(rows) || rows,
          setStatus
        });
        if (savePlan === null) {
          setStatus('save cancelled');
          return false;
        }
        current = savePlan.preset || current;
      }

      try {
        if (window.presetService) {
          await refreshPreviewCanvas();
          const saved = await window.presetService.savePreset(current, previewCanvas);
          // the half of a save that only exists when this build has somewhere else to put the
          // files: substituted refs, the project-state document, and remote refs resolved back to
          // local ones before the hot reload reads them
          const saveOutcome = savePlan ? await savePlan.afterSave(saved) : null;
          migrateSessionRevisions(current.id, saved.id);
          clearNotesDraft(current.id);
          clearNotesDraft(saved.id);
          await persistCurrentProjectState(saved.id, { checkpoint: true });
          state._restoredBundlePresetId = saved.id;

          await hotReloadPreset(saved);
          window.history.replaceState(null, '', `/?preset=${encodeURIComponent(saved.id)}`);
          clearProjectDirty();
          hideProjectLoading();
          if (saveOutcome?.status) {
            setStatus(saveOutcome.status.text, saveOutcome.status.tone);
          } else if (saved?.remoteError) {
            setStatus(`saved locally - ${saved.remoteError.message}`, 'error');
          } else {
            setStatus(`saved "${saved.meta.name}"`, 'success');
          }
          if (triggerBtn) {
            triggerBtn.textContent = 'saved ✓';
            setTimeout(() => {
              triggerBtn.textContent = '';
              updateSaveDirtyUi();
            }, 1200);
          }
          return true;
        }
      } catch (err) {
        hideProjectLoading();
        const msg = err?.message || 'unknown save error';
        setStatus(`save failed: ${msg}`, 'error');
        updateSaveDirtyUi();
        alert(`could not save preset safely — your existing saved file was not altered and your current session edits remain open.\n\n${msg}`);
      }
      hideProjectLoading();
      return false;
    }

    pendingSaveAction = saveActivePreset;

    if (saveBtn) {
      saveBtn.addEventListener('click', () => saveActivePreset(saveBtn));
    }

    if (els.topSavePresetBtn) {
      els.topSavePresetBtn.addEventListener('click', () => saveActivePreset(els.topSavePresetBtn));
    }

    const supportsPopoverApi = Object.hasOwn(HTMLElement.prototype, 'popover');
    const supportsCommandFor = 'commandForElement' in HTMLButtonElement.prototype;
    let projectMenuKeyIntent = null;
    let projectMenuSuppressRestore = false;
    let projectMenuClosedByEscape = false;

    function isProjectMenuOpen() {
      if (!els.topProjectMenuPopover) return false;
      return supportsPopoverApi
        ? els.topProjectMenuPopover.matches(':popover-open')
        : els.topProjectMenuPopover.classList.contains(':popover-open');
    }

    function positionProjectMenuFallback() {
      if (!els.topProjectMenuBtn || !els.topProjectMenuPopover) return;
      if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('position-area', 'block-end')) {
        return;
      }
      const btnRect = els.topProjectMenuBtn.getBoundingClientRect();
      const popW = els.topProjectMenuPopover.offsetWidth || 220;
      const popH = els.topProjectMenuPopover.offsetHeight || 190;
      const left = Math.max(8, Math.min(window.innerWidth - popW - 8, btnRect.left));
      const top = btnRect.bottom + 6 + popH <= window.innerHeight - 8
        ? btnRect.bottom + 6
        : Math.max(8, btnRect.top - popH - 6);
      els.topProjectMenuPopover.style.left = `${Math.round(left)}px`;
      els.topProjectMenuPopover.style.top = `${Math.round(top)}px`;
    }

    function syncProjectMenuStateOnOpen() {
      if (els.menuRevertSavedBtn) {
        const activeId = visualizer?.id || getActivePresetIdSafe();
        const isFreshBlank = (activeId === 'blank' || activeId === 'new_blank') &&
          !window.presetService?.inMemoryCache?.has?.(activeId);
        els.menuRevertSavedBtn.disabled = isFreshBlank;
      }
    }

    function onProjectMenuToggle(isOpen) {
      if (els.topProjectMenuBtn) {
        els.topProjectMenuBtn.setAttribute('aria-expanded', String(isOpen));
      }
      if (isOpen) {
        projectMenuClosedByEscape = false;
        syncProjectMenuStateOnOpen();
        positionProjectMenuFallback();
        if (projectMenuKeyIntent && els.topProjectMenuPopover) {
          const items = Array.from(els.topProjectMenuPopover.querySelectorAll('.project-menu-item:not(:disabled)'));
          const target = projectMenuKeyIntent === 'last' ? items[items.length - 1] : items[0];
          projectMenuKeyIntent = null;
          if (target) requestAnimationFrame(() => target.focus());
        }
      } else {
        projectMenuKeyIntent = null;
        if (!projectMenuSuppressRestore && els.topProjectMenuBtn &&
          (projectMenuClosedByEscape || els.topProjectMenuPopover?.contains(document.activeElement))) {
          els.topProjectMenuBtn.focus({ focusVisible: projectMenuClosedByEscape });
        }
        projectMenuSuppressRestore = false;
        projectMenuClosedByEscape = false;
      }
    }

    function openProjectMenu() {
      if (!els.topProjectMenuPopover) return;
      if (supportsPopoverApi) {
        if (!els.topProjectMenuPopover.matches(':popover-open')) {
          try {
            els.topProjectMenuPopover.showPopover({ source: els.topProjectMenuBtn });
          } catch {
            els.topProjectMenuPopover.showPopover();
          }
        }
      } else {
        els.topProjectMenuPopover.classList.add(':popover-open');
        onProjectMenuToggle(true);
      }
    }

    function closeProjectMenu({ suppressFocusRestore = false } = {}) {
      if (!els.topProjectMenuPopover) return;
      projectMenuSuppressRestore = suppressFocusRestore;
      if (supportsPopoverApi) {
        if (els.topProjectMenuPopover.matches(':popover-open')) {
          els.topProjectMenuPopover.hidePopover();
        }
      } else if (els.topProjectMenuPopover.classList.contains(':popover-open')) {
        els.topProjectMenuPopover.classList.remove(':popover-open');
        onProjectMenuToggle(false);
      }
    }

    if (els.topProjectMenuBtn && els.topProjectMenuPopover) {
      els.topProjectMenuPopover.addEventListener('toggle', (e) => {
        onProjectMenuToggle(e.newState === 'open');
      });

      els.topProjectMenuPopover.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          projectMenuClosedByEscape = true;
          if (!supportsPopoverApi) {
            e.preventDefault();
            closeProjectMenu();
          }
        }
      });

      if (!supportsCommandFor) {
        els.topProjectMenuBtn.addEventListener('click', () => {
          if (supportsPopoverApi) {
            els.topProjectMenuPopover.togglePopover();
          } else if (isProjectMenuOpen()) {
            closeProjectMenu();
          } else {
            openProjectMenu();
          }
        });
      }

      if (!supportsPopoverApi) {
        document.addEventListener('pointerdown', (e) => {
          if (!isProjectMenuOpen()) return;
          if (els.topProjectMenuPopover.contains(e.target) || els.topProjectMenuBtn.contains(e.target)) return;
          closeProjectMenu({ suppressFocusRestore: true });
        });
      }

      els.topProjectMenuBtn.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          projectMenuKeyIntent = 'first';
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            openProjectMenu();
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          projectMenuKeyIntent = 'last';
          openProjectMenu();
        }
      });

      const menuList = els.topProjectMenuPopover.querySelector('.project-menu-list');
      if (menuList && !('focusGroup' in HTMLElement.prototype)) {
        menuList.setAttribute('role', 'menu');
        const menuItems = Array.from(menuList.querySelectorAll('.project-menu-item'));
        menuItems.forEach((item, idx) => {
          item.setAttribute('role', 'menuitem');
          item.tabIndex = idx === 0 ? 0 : -1;
        });
        menuList.addEventListener('focusin', ({ target }) => {
          if (!menuItems.includes(target)) return;
          menuItems.forEach((item) => {
            item.tabIndex = item === target ? 0 : -1;
          });
        });
        menuList.addEventListener('keydown', (e) => {
          const enabled = menuItems.filter((item) => !item.disabled);
          if (enabled.length === 0) return;
          const curIdx = enabled.indexOf(document.activeElement);
          let nextIdx = -1;
          if (e.key === 'ArrowDown') nextIdx = curIdx < 0 ? 0 : (curIdx + 1) % enabled.length;
          else if (e.key === 'ArrowUp') nextIdx = curIdx < 0 ? enabled.length - 1 : (curIdx - 1 + enabled.length) % enabled.length;
          else if (e.key === 'Home') nextIdx = 0;
          else if (e.key === 'End') nextIdx = enabled.length - 1;
          if (nextIdx >= 0) {
            e.preventDefault();
            enabled[nextIdx].focus();
          }
        });
      }
    }

    function openSaveCopyAsDialog() {
      if (!els.saveCopyAsDialog) return;
      const curName = (els.topPresetNameInput?.value || visualizer?.name || 'untitled preset').trim();
      const curDesc = visualizer?.preset?.meta?.description || visualizer?.tagline || '';
      if (els.saveCopyNameInput) els.saveCopyNameInput.value = `${curName} (copy)`;
      if (els.saveCopyDescInput) els.saveCopyDescInput.value = curDesc;
      if (els.saveCopyIncludeStateCheck) els.saveCopyIncludeStateCheck.checked = true;
      if (els.saveCopyErrorMsg) {
        els.saveCopyErrorMsg.hidden = true;
        els.saveCopyErrorMsg.textContent = '';
      }
      if (els.saveCopyConfirmBtn) {
        els.saveCopyConfirmBtn.disabled = false;
        els.saveCopyConfirmBtn.textContent = 'create copy';
      }
      if (!els.saveCopyAsDialog.open) {
        els.saveCopyAsDialog.showModal();
      }
      if (els.saveCopyNameInput) {
        els.saveCopyNameInput.focus();
        els.saveCopyNameInput.select();
      }
    }

    if (els.saveCopyAsDialog) {
      els.saveCopyAsDialog.addEventListener('close', () => {
        els.saveCopyAsDialog.returnValue = '';
      });

      if (!('closedBy' in HTMLDialogElement.prototype)) {
        const isOutsideDialog = (e) => {
          const r = els.saveCopyAsDialog.getBoundingClientRect();
          return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        };
        let backdropPointerDown = false;
        els.saveCopyAsDialog.addEventListener('pointerdown', (e) => {
          backdropPointerDown = isOutsideDialog(e);
        });
        els.saveCopyAsDialog.addEventListener('pointerup', (e) => {
          if (backdropPointerDown && isOutsideDialog(e)) {
            els.saveCopyAsDialog.close('cancel');
          }
          backdropPointerDown = false;
        });
      }

      const closeCopyDialog = () => {
        if (els.saveCopyAsDialog.open) els.saveCopyAsDialog.close('cancel');
      };
      if (els.saveCopyCancelBtn) els.saveCopyCancelBtn.addEventListener('click', closeCopyDialog);
      if (els.saveCopyCancelXBtn) els.saveCopyCancelXBtn.addEventListener('click', closeCopyDialog);
    }

    if (els.saveCopyAsForm) {
      els.saveCopyAsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const nextName = els.saveCopyNameInput?.value.trim() || '';
        const nextDesc = els.saveCopyDescInput?.value.trim() || '';
        const includeProjectState = els.saveCopyIncludeStateCheck ? els.saveCopyIncludeStateCheck.checked : true;
        if (!nextName) {
          if (els.saveCopyErrorMsg) {
            els.saveCopyErrorMsg.textContent = 'enter a name for the project copy.';
            els.saveCopyErrorMsg.hidden = false;
          }
          els.saveCopyNameInput?.focus();
          return;
        }
        if (els.saveCopyErrorMsg) els.saveCopyErrorMsg.hidden = true;
        if (els.saveCopyConfirmBtn) {
          els.saveCopyConfirmBtn.disabled = true;
          els.saveCopyConfirmBtn.textContent = 'saving copy...';
        }
        try {
          const current = await buildCurrentPresetSnapshot(nextName, nextDesc);
          if (!window.presetService?.duplicatePreset) {
            throw new Error('preset duplicator service is unavailable.');
          }
          await refreshPreviewCanvas();
          const savedCopy = await window.presetService.duplicatePreset(current, {
            sourceId: current.id,
            name: nextName,
            description: nextDesc,
            includeProjectState,
            canvasEl: previewCanvas
          });
          migrateSessionRevisions(current.id, savedCopy.id);
          clearNotesDraft(savedCopy.id);
          if (includeProjectState) {
            await persistCurrentProjectState(savedCopy.id, { checkpoint: true });
            state._restoredBundlePresetId = savedCopy.id;
          } else {
            state._restoredBundlePresetId = null;
            state.selectedClipIds = [];
            state.selectedClipStartTimes = [];
            state.selectedClipEndTimes = [];
            state.selectedClipSpeeds = [];
            state.favoriteClips = [];
            renderFavoritesGrid();
          }
          if (els.saveCopyAsDialog?.open) els.saveCopyAsDialog.close('confirm');
          await hotReloadPreset(savedCopy);
          window.history.replaceState(null, '', `/?preset=${encodeURIComponent(savedCopy.id)}`);
          if (els.topPresetNameInput) els.topPresetNameInput.value = savedCopy.meta?.name || nextName;
          clearProjectDirty();
          setStatus(`saved copy "${savedCopy.meta?.name || nextName}"`, 'success');
        } catch (err) {
          if (els.saveCopyErrorMsg) {
            els.saveCopyErrorMsg.textContent = err?.message || 'could not create project copy.';
            els.saveCopyErrorMsg.hidden = false;
          } else {
            alert(`save copy failed: ${err?.message || 'unknown error'}`);
          }
        } finally {
          if (els.saveCopyConfirmBtn) {
            els.saveCopyConfirmBtn.disabled = false;
            els.saveCopyConfirmBtn.textContent = 'create copy';
          }
        }
      });
    }

    async function revertActivePresetToSaved() {
      const activeId = visualizer?.id || getActivePresetIdSafe();
      const savedPreset =
        (await window.presetService?.getPresetById?.(activeId).catch(() => null)) ||
        window.STARTER_PRESET_DEFINITIONS?.[activeId] ||
        window.STARTER_PRESETS?.[activeId] ||
        null;

      if (!savedPreset && !window.templateRegistry?.get?.(activeId)) {
        setStatus('no saved version found for this preset', 'error');
        return;
      }
      if (hasUnsavedChanges && !confirm('discard unsaved changes and revert to the last saved version?')) {
        return;
      }
      showProjectLoading('reverting to saved project...');
      await yieldToPaint();
      try {
        clearNotesDraft(activeId);
        state._restoredBundlePresetId = null;
        if (savedPreset) {
          const clone = JSON.parse(JSON.stringify(savedPreset));
          await hotReloadPreset(clone);
          resetClipPlaylistState();
          const bundleState =
            (await window.projectBundleService?.revertProjectStateToCheckpoint?.(clone.id)) ||
            (await window.projectBundleService?.loadProjectState?.(clone.id, { checkpoint: true })) ||
            clone.projectState ||
            null;
          if (bundleState) {
            state._restoredBundlePresetId = clone.id;
            await restoreBundleProjectState(bundleState, { resetPlaylistBeforeRestore: true });
          } else {
            syncVideoPoolSources();
            renderClipGrid();
            renderFavoritesGrid();
          }
          if (els.playlistEditorDialog?.open && state.selectedClipIds.length === 0) {
            els.playlistEditorDialog.close();
          }
          const activeVid = getActiveVideoForTime(state.currentTime);
          visualizer?.renderFrame?.(state.currentTime, activeVid);
          clearProjectDirty();
          setStatus(`reverted "${clone.meta?.name || clone.id}" to saved`, 'success');
        } else {
          await window.projectBundleService?.revertProjectStateToCheckpoint?.(activeId);
          resetClipPlaylistState();
          syncVideoPoolSources();
          renderClipGrid();
          renderFavoritesGrid();
          if (els.playlistEditorDialog?.open) {
            els.playlistEditorDialog.close();
          }
          clearProjectDirty();
          await initStarter({ forceStarter: true });
          setStatus('reverted to starter preset', 'success');
        }
      } catch (err) {
        setStatus(`revert failed: ${err.message}`, 'error');
      } finally {
        hideProjectLoading();
      }
    }

    if (els.menuSaveCopyBtn) {
      els.menuSaveCopyBtn.addEventListener('click', () => {
        closeProjectMenu({ suppressFocusRestore: true });
        openSaveCopyAsDialog();
      });
    }

    if (els.menuNewBlankProjectBtn) {
      els.menuNewBlankProjectBtn.addEventListener('click', () => {
        closeProjectMenu({ suppressFocusRestore: true });
        const hasBlank = Boolean(window.templateRegistry?.get?.('blank'));
        const targetHref = `/?preset=${hasBlank ? 'blank' : 'new_blank'}`;
        confirmLeaveAndRun('save & new blank', () => {
          window.location.href = targetHref;
        });
      });
    }

    if (els.menuRevertSavedBtn) {
      els.menuRevertSavedBtn.addEventListener('click', () => {
        closeProjectMenu({ suppressFocusRestore: true });
        revertActivePresetToSaved();
      });
    }

    async function exportCurrentBundleZip(triggerBtn = null) {
      if (!window.projectBundleService?.exportProjectZip) {
        alert('bundle exporter is unavailable.');
        return;
      }
      const labelEl = triggerBtn?.querySelector?.('span') || triggerBtn;
      const prevLabel = labelEl ? labelEl.textContent : '';
      if (triggerBtn) triggerBtn.disabled = true;
      if (labelEl) labelEl.textContent = 'packing .zip...';
      try {
        const activePreset = await buildCurrentPresetSnapshot();
        const clipPickerEnabled = activePreset?.modules?.clipPicker?.enabled === true || activePreset?.modules?.clips?.enabled === true;
        const selectedTrackIds = visualizer?.selectedTrackIds ? Array.from(visualizer.selectedTrackIds) : null;
        const exportProject = state.project
          ? { ...state.project, ...(selectedTrackIds ? { selectedTrackIds } : {}) }
          : null;
        await window.projectBundleService.exportProjectZip({
          preset: activePreset,
          project: exportProject,
          lyricsData: state.project?.lyrics || null,
          selectedClipIds: clipPickerEnabled ? state.selectedClipIds : [],
          selectedClipStartTimes: clipPickerEnabled ? state.selectedClipStartTimes : [],
          selectedClipEndTimes: clipPickerEnabled ? state.selectedClipEndTimes : [],
          selectedClipSpeeds: clipPickerEnabled ? state.selectedClipSpeeds : [],
          playlistsByCutMode: clipPickerEnabled ? getNormalizedPlaylistsByCutMode() : null,
          clips: clipPickerEnabled ? state.clips : [],
          favoriteClips: clipPickerEnabled ? (state.favoriteClips || []) : [],
          clipSource: els.clipSourceSelect ? els.clipSourceSelect.value : null,
          clipQuery: els.clipCustomQueryInput ? els.clipCustomQueryInput.value.trim() : null,
          audioBlob: state.hasCustomAudio ? state.audioBlob : null,
          audioName: state.hasCustomAudio ? state.audioName : null,
          midiBlob: state.hasCustomMidi ? state.midiBlob : null,
          midiName: state.hasCustomMidi ? state.midiName : null
        });
      } catch (err) {
        alert(`zip export failed: ${err.message}`);
      } finally {
        if (triggerBtn) triggerBtn.disabled = false;
        if (labelEl) labelEl.textContent = prevLabel;
      }
    }

    if (els.topExportZipBtn) {
      els.topExportZipBtn.addEventListener('click', () => {
        closeProjectMenu({ suppressFocusRestore: true });
        exportCurrentBundleZip(els.topExportZipBtn);
      });
    }

    if (els.menuExportZipBtn) {
      els.menuExportZipBtn.addEventListener('click', () => {
        closeProjectMenu({ suppressFocusRestore: true });
        exportCurrentBundleZip(els.menuExportZipBtn);
      });
    }

    if (els.topImportBundleBtn && els.topImportBundleInput) {
      els.topImportBundleBtn.addEventListener('click', () => {
        closeProjectMenu({ suppressFocusRestore: true });
        els.topImportBundleInput.click();
      });
      els.topImportBundleInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        await importBundleOrPresetFile(file);
        els.topImportBundleInput.value = '';
      });
    }

    if (els.menuImportBundleBtn && els.topImportBundleInput) {
      els.menuImportBundleBtn.addEventListener('click', () => {
        closeProjectMenu({ suppressFocusRestore: true });
        els.topImportBundleInput.click();
      });
    }

    if (els.topPresetNameInput) {
      els.topPresetNameInput.addEventListener('input', markProjectDirty);
      const commitInlineRename = () => {
        const nextName = els.topPresetNameInput.value.trim();
        if (!nextName) {
          els.topPresetNameInput.value = visualizer?.name || 'preset';
          return;
        }
        const prevName = visualizer?.name || '';
        if (visualizer) {
          visualizer.name = nextName;
          visualizer.title = nextName;
          if (visualizer.preset?.meta) {
            visualizer.preset.meta.name = nextName;
            visualizer.preset.meta.title = nextName;
          }
        }
        if (nextName !== prevName) markProjectDirty();
      };
      els.topPresetNameInput.addEventListener('change', commitInlineRename);
      els.topPresetNameInput.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          els.topPresetNameInput.blur();
        }
      });
    }

    window.templateRegistry?.onTemplateChange?.(() => {
      syncEditorsFromActive();
      renderChatMessages();
      if (historyPanel && !historyPanel.hidden) renderHistoryList();
    });
    syncEditorsFromActive();

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target;
        const isEditable = target && (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable
        );
        const isInteractive = target && target.closest && target.closest('button, a, [role="button"]');
        if (!isEditable && !isInteractive && els.playPauseBtn) {
          e.preventDefault();
          els.playPauseBtn.click();
          return;
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target;
        const isEditable = target && (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable
        );
        if (!isEditable && state.selectedLyricLineIdx >= 0 && state.showLyricsTimelineBar && els.lyricsTimelineBar && !els.lyricsTimelineBar.hidden) {
          e.preventDefault();
          deleteLyricWord(state.selectedLyricLineIdx, state.selectedLyricWordIdx);
          return;
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        closeProjectMenu({ suppressFocusRestore: true });
        if (e.shiftKey) {
          openSaveCopyAsDialog();
        } else {
          saveActivePreset(els.topSavePresetBtn);
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (drawer.hidden) openDrawer();
        else closeDrawer();
      } else if (e.key === 'Escape') {
        if (els.saveCopyAsDialog?.open) return;
        if (isProjectMenuOpen()) {
          closeProjectMenu();
          return;
        }
        if (notesPanel && !notesPanel.hidden) {
          setNotesOpen(false);
          return;
        }
        if (historyPanel && !historyPanel.hidden) {
          setHistoryOpen(false);
          return;
        }
        if (drawer && !drawer.hidden) closeDrawer();
        if (sourceDrawer && !sourceDrawer.hidden) closeSourceDrawer();
      }
    });
  }

  window.samplevisClipPool = {
    getSelectedClips: () => {
      const byId = new Map([...(state.clips || []), ...(state.favoriteClips || [])].map((c) => [c.id, c]));
      return (state.selectedClipIds || []).map((id, idx) => {
        const c = byId.get(id);
        if (!c) return null;
        return {
          ...c,
          startTime: normalizeClipStartTime(state.selectedClipStartTimes?.[idx] ?? c.startTime ?? 0),
          endTime: state.selectedClipEndTimes?.[idx] ?? null,
          speedPct: normalizeClipSpeedPct(state.selectedClipSpeeds?.[idx])
        };
      }).filter(Boolean);
    },
    getAllClips: () => [...(state.clips || [])]
  };

  async function importBundleOrPresetFile(file) {
    if (!file || !window.presetService) return;
    showProjectLoading('importing project...');
    await yieldToPaint();
    try {
      const imported = await window.presetService.importPresetFile(file);
      if (imported) {
        clearNotesDraft(imported.id);
        state._restoredBundlePresetId = imported.id;
        showProjectLoading('compiling shaders & preset...');
        await yieldToPaint();
        await vizHotReloadPreset(imported);
        window.history.replaceState(null, '', `/?preset=${encodeURIComponent(imported.id)}`);
        const bundleState = imported.__importedProjectState ||
          (await window.projectBundleService?.loadProjectState?.(imported.id)) ||
          imported.projectState ||
          null;
        if (bundleState) {
          showProjectLoading('restoring project media...');
          await restoreBundleProjectState(bundleState, { resetPlaylistBeforeRestore: true });
          if (!imported.__importedProjectState && imported.projectState) {
            await persistCurrentProjectState(imported.id, { checkpoint: true });
          }
        }
        clearProjectDirty();
        vizSetStatus(`imported "${imported.meta?.name || imported.id}"`, 'success');
      }
    } catch (err) {
      alert(`import failed: ${err.message}`);
    } finally {
      hideProjectLoading();
    }
  }

  async function handleOpenedElectronPayloads(payloads) {
    if (!Array.isArray(payloads) || payloads.length === 0) return;
    const files = payloads
      .filter((p) => p && p.bytes)
      .map((p) => new File([p.bytes], p.name || 'file', { type: p.mimeType || 'application/octet-stream' }));
    if (files.length === 0) return;

    const bundleOrPreset = files.find((f) => /\.(zip|json)$/i.test(f.name));
    if (bundleOrPreset) {
      await importBundleOrPresetFile(bundleOrPreset);
      return;
    }

    const audioFile = files.find((f) => /\.(wav|mp3|flac|ogg|m4a)$/i.test(f.name));
    const midiOrAlsFile = files.find((f) => /\.(mid|midi|als)$/i.test(f.name));

    if (audioFile) {
      await handleSampleFiles(midiOrAlsFile ? [audioFile, midiOrAlsFile] : [audioFile]);
    } else if (midiOrAlsFile) {
      if (state.audioBlob) {
        const pairedAudio = state.audioBlob instanceof File
          ? state.audioBlob
          : new File([state.audioBlob], state.audioName || 'sample.wav', { type: state.audioBlob.type || 'audio/wav' });
        await handleSampleFiles([pairedAudio, midiOrAlsFile]);
      } else {
        alert('Load an audio sample (.wav) first or drop the audio + .als/.mid files together.');
      }
    }
  }

  function initResponsiveWorkspace() {
    const topbarEl = document.querySelector('.topbar');
    if (topbarEl) {
      const syncTopbarHeight = () => {
        const h = Math.max(48, Math.round(topbarEl.getBoundingClientRect().height));
        document.documentElement.style.setProperty('--topbar-h', `${h}px`);
      };
      syncTopbarHeight();
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(syncTopbarHeight).observe(topbarEl);
      } else {
        window.addEventListener('resize', syncTopbarHeight);
      }
    }

    const gridEl = els.studioGrid;
    const tabsRoot = els.studioPaneTabs;
    if (!gridEl || !tabsRoot) return;

    const tabButtons = Array.from(tabsRoot.querySelectorAll('.studio-pane-tab[data-pane]'));
    const mobileMq = window.matchMedia('(max-width: 899px)');

    const setActivePane = (pane) => {
      let target = pane || 'optics';
      if (target === 'clips' && els.clipsSection?.hidden) {
        target = 'optics';
      }
      if (!mobileMq.matches && target === 'stage') {
        target = 'optics';
      }
      gridEl.dataset.activePane = target;
      for (const btn of tabButtons) {
        const isActive = btn.dataset.pane === target;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', String(isActive));
      }
      if (target === 'stage') {
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      }
    };

    for (const btn of tabButtons) {
      btn.addEventListener('click', () => {
        setActivePane(btn.dataset.pane);
      });
    }

    mobileMq.addEventListener('change', (ev) => {
      if (ev.matches) {
        setActivePane('stage');
      } else if (gridEl.dataset.activePane === 'stage') {
        setActivePane('optics');
      }
    });

    setActivePane(mobileMq.matches ? 'stage' : 'optics');

    if (els.paneQuickPlayBtn && els.playPauseBtn) {
      const syncPlayLabel = () => {
        els.paneQuickPlayBtn.textContent = els.playPauseBtn.textContent;
      };
      syncPlayLabel();
      els.paneQuickPlayBtn.addEventListener('click', () => {
        els.playPauseBtn.click();
      });
      if (typeof MutationObserver === 'function') {
        new MutationObserver(syncPlayLabel).observe(els.playPauseBtn, {
          childList: true,
          characterData: true,
          subtree: true
        });
      }
    }
  }

  const initialPresetPromise = initDesignSwitcher();
  initResponsiveWorkspace();
  initVizStudio();
  Promise.resolve(initialPresetPromise)
    .finally(() => initStarter())
    .finally(() => {
      if (window.electronAPI?.isElectron) {
        window.electronAPI.consumePendingFiles()
          .then((files) => handleOpenedElectronPayloads(files))
          .catch(() => { });
        window.electronAPI.onOpenFile((payload) => {
          handleOpenedElectronPayloads([payload]).catch(() => { });
        });
      }
    });
  requestAnimationFrame(tick);
})();

