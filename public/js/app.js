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
      audioEl.play().catch(() => {});
    }
  });

  // pool of video elements for multi-clip cuts without decode stalls
  const videoPool = [0, 1, 2, 3, 4, 5, 6, 7].map(() => {
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.crossOrigin = 'anonymous';
    v.preload = 'auto';
    return v;
  });

  const state = {
    project: null,
    clips: [],
    selectedClipIds: [],
    isPlaying: false,
    isRendering: false,
    currentTime: 0,
    lastRenderedBlob: null,
    lastRenderedFilename: 'samplevis_render.mp4',
    draggingDropMarker: false,
    aspectRatio: '9:16',
    videoPool
  };

  const els = {
    aspectRatioToggleBtn: document.getElementById('aspectRatioToggleBtn'),
    aspectRatioTelemetry: document.getElementById('aspectRatioTelemetry'),
    canvasHousing: document.querySelector('.canvas-housing'),
    studioGrid: document.getElementById('studioGrid'),
    authBadge: document.getElementById('authBadge'),
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
    loopIntroMidiCheckbox: document.getElementById('loopIntroMidiCheckbox'),
    seamlessReelLoopCheckbox: document.getElementById('seamlessReelLoopCheckbox'),
    playPauseBtn: document.getElementById('playPauseBtn'),
    jumpDropBtn: document.getElementById('jumpDropBtn'),
    timeReadout: document.getElementById('timeReadout'),
    barReadout: document.getElementById('barReadout'),
    dropBadgeReadout: document.getElementById('dropBadgeReadout'),
    waveformContainer: document.getElementById('waveformContainer'),
    dropMarkerLine: document.getElementById('dropMarkerLine'),
    dropMarkerTag: document.getElementById('dropMarkerTag'),
    timelinePlayhead: document.getElementById('timelinePlayhead'),
    headerPreviewTag: document.getElementById('headerPreviewTag'),
    midiTracksSection: document.getElementById('midiTracksSection'),
    midiTracksTitle: document.getElementById('midiTracksTitle'),
    clipsSection: document.getElementById('clipsSection'),
    clipsSectionTitle: document.getElementById('clipsSectionTitle'),
    autoPickChordClipsBtn: document.getElementById('autoPickChordClipsBtn'),
    shuffleClipBtn: document.getElementById('shuffleClipBtn'),
    unselectAllClipsBtn: document.getElementById('unselectAllClipsBtn'),
    cutmodeHint: document.getElementById('cutmodeHint'),
    speedRampToggle: document.getElementById('speedRampToggle'),
    dropGlitchToggle: document.getElementById('dropGlitchToggle'),
    autoFrameToggle: document.getElementById('autoFrameToggle'),
    fetchCategorySelect: document.getElementById('fetchCategorySelect'),
    fetchBestClipsBtn: document.getElementById('fetchBestClipsBtn'),
    fetchRandomClipsBtn: document.getElementById('fetchRandomClipsBtn'),
    customClipInput: document.getElementById('customClipInput'),
    clipGridContainer: document.getElementById('clipGridContainer'),
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
    topActiveDesignLabel: document.getElementById('topActiveDesignLabel'),
    openDesignModalBtn: document.getElementById('openDesignModalBtn'),
    designModal: document.getElementById('designModal'),
    closeDesignModalBtn: document.getElementById('closeDesignModalBtn'),
    designTemplateGrid: document.getElementById('designTemplateGrid'),
    templateControlsContainer: document.getElementById('templateControlsContainer'),
    importPresetBtn: document.getElementById('importPresetBtn'),
    exportActivePresetBtn: document.getElementById('exportActivePresetBtn'),
    cloneDesignBtn: document.getElementById('cloneDesignBtn'),
    importPresetFileInput: document.getElementById('importPresetFileInput')
  };

  // initialize active template from registry
  // parse url search params for direct preset launching from gallery
  const urlParams = new URLSearchParams(window.location.search);
  const requestedPreset = urlParams.get('preset');
  const activeTemplateId = requestedPreset || localStorage.getItem('samplevis_active_template_id') || 'constellations';
  window.templateRegistry.setTemplate(
    activeTemplateId,
    previewCanvas,
    state,
    els.templateControlsContainer
  );
  visualizer = window.templateRegistry.activeTemplate;
  if (els.topActiveDesignLabel && visualizer) {
    els.topActiveDesignLabel.textContent = visualizer.name;
  }
  applyTemplateModules(visualizer);

  function applyTemplateModules(tpl) {
    if (!tpl) return;
    const clipModule = tpl.modules?.clips || tpl.preset?.modules?.clips || tpl.features?.clips;
    const clipsEnabled = clipModule !== false && (clipModule?.enabled !== false);

    if (els.clipsSection) {
      els.clipsSection.hidden = !clipsEnabled;
      if (clipsEnabled && els.clipsSectionTitle) {
        els.clipsSectionTitle.textContent = clipModule?.label || 'clips';
      }
      if (clipsEnabled && clipModule?.category && els.fetchCategorySelect) {
        els.fetchCategorySelect.value = clipModule.category;
      }
    }

    if (els.studioGrid) {
      els.studioGrid.classList.toggle('no-clips', !clipsEnabled);
    }

    const midiModule = tpl.modules?.midiTracks || tpl.preset?.modules?.midiTracks;
    const midiEnabled = tpl.id === 'constellations' || (midiModule !== undefined && midiModule.enabled !== false);
    if (els.midiTracksSection) {
      els.midiTracksSection.hidden = !midiEnabled;
      if (midiEnabled && els.midiTracksTitle) {
        els.midiTracksTitle.textContent = midiModule?.label || (tpl.id === 'constellations' ? 'midi constellation tracks' : 'midi tracks');
      }
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

  function updateMetadataToVisualizer() {
    if (!state.project) return;
    state.project.brand = (els.inputBrand.value.trim() || 'aesttc').toLowerCase();
    state.project.sampleNumber = els.inputNumber.value.trim();
    state.project.title = (els.inputTitle.value.trim() || 'untitled').toLowerCase();
    state.project.bpm = parseFloat(els.inputBpm.value) || 120;
    state.project.key = (els.inputKey.value.trim() || '').toLowerCase();
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

    if (els.headerPreviewTag) {
      const num = state.project.sampleNumber ? `#${String(state.project.sampleNumber).replace(/^#?\s*0*/, '') || '1'} - ` : '';
      els.headerPreviewTag.textContent = `[${num}${state.project.title || 'untitled'} · ${state.project.brand || 'aesttc'}]`;
    }
  }

  function syncVideoPoolSources() {
    const chosen = state.selectedClipIds
      .map((id) => state.clips.find((c) => c.id === id))
      .filter(Boolean);

    videoPool.forEach((v, idx) => {
      if (chosen.length === 0) {
        v.pause();
        v.removeAttribute('src');
        v.dataset.clipUrl = '';
        v.load();
        return;
      }
      const clip = chosen[idx % chosen.length];
      if (clip && v.dataset.clipUrl !== clip.url) {
        v.dataset.clipUrl = clip.url;
        v.src = clip.url;
        v.load();
      }
      if (clip) {
        v.dataset.manualFocalX = clip.manualFocalX !== undefined ? clip.manualFocalX : '';
      }
    });

    if (visualizer && typeof visualizer.setActiveVideos === 'function') {
      visualizer.setActiveVideos(videoPool);
    }
  }

  function getProjectDropTime() {
    const p = state.project;
    if (!p) return 15.0;
    return (typeof p.dropTime === 'number' && !isNaN(p.dropTime))
      ? p.dropTime
      : ((p.duration || 30.0) * 0.5);
  }

  function getActiveVideoForTime(t) {
    if (!state.project || state.selectedClipIds.length === 0) return null;
    const dropTime = getProjectDropTime();
    const startAtDrop = visualizer?.modules?.clips?.startAtDrop === true || visualizer?.id === 'constellations';
    if (startAtDrop && t < dropTime) return null;

    const cutMode = visualizer.params.cutMode || 'chord';
    if (cutMode === 'single' || state.selectedClipIds.length === 1) {
      return videoPool[0];
    }

    let poolIdx = 0;
    if (cutMode === 'chord') {
      const cuts = state.project.chordCutTimes || [];
      let cutIdx = 0;
      for (let i = 0; i < cuts.length; i++) {
        if (t >= cuts[i]) cutIdx = i;
        else break;
      }
      poolIdx = cutIdx % Math.min(videoPool.length, state.selectedClipIds.length);
    } else if (cutMode === 'impact') {
      const cuts = state.project.impactTimes || [];
      let cutIdx = 0;
      for (let i = 0; i < cuts.length; i++) {
        if (t >= cuts[i]) cutIdx = i;
        else break;
      }
      poolIdx = cutIdx % Math.min(videoPool.length, state.selectedClipIds.length);
    } else {
      const secPerBar = (60 / (state.project.bpm || 120)) * 4;
      const barsPerCut = cutMode === '2bar' ? 2 : 4;
      const cutLenSec = secPerBar * barsPerCut;
      const cutIdx = Math.floor(Math.max(0, t - dropTime) / cutLenSec);
      poolIdx = cutIdx % Math.min(videoPool.length, state.selectedClipIds.length);
    }

    return videoPool[poolIdx];
  }

  function getClipTimeForTimestamp(t, activeVid) {
    if (!state.project || !activeVid) return 0;
    const dropTime = getProjectDropTime();
    const startAtDrop = visualizer?.modules?.clips?.startAtDrop === true || visualizer?.id === 'constellations';
    if (startAtDrop && t < dropTime) return 0;

    const dur = activeVid.duration || 6.0;

    if (visualizer.params.speedRamping) {
      const ramp = visualizer.getSpeedRampInfo(t);
      return ramp.clipTime % Math.max(0.5, dur);
    }

    const cutMode = visualizer.params.cutMode || 'chord';
    let cutStartTime = dropTime;

    if (cutMode === 'chord') {
      const cuts = state.project.chordCutTimes || [];
      for (let i = 0; i < cuts.length; i++) {
        if (t >= cuts[i]) cutStartTime = cuts[i];
        else break;
      }
    } else if (cutMode === 'impact') {
      const cuts = state.project.impactTimes || [];
      for (let i = 0; i < cuts.length; i++) {
        if (t >= cuts[i]) cutStartTime = cuts[i];
        else break;
      }
    } else if (cutMode === '2bar' || cutMode === '4bar') {
      const secPerBar = (60 / (state.project.bpm || 120)) * 4;
      const barsPerCut = cutMode === '2bar' ? 2 : 4;
      const cutLenSec = secPerBar * barsPerCut;
      const cutIdx = Math.floor(Math.max(0, t - dropTime) / cutLenSec);
      cutStartTime = dropTime + cutIdx * cutLenSec;
    }

    const elapsedInCut = Math.max(0, t - cutStartTime);
    return elapsedInCut % Math.max(0.5, dur);
  }

  function renderTrackList() {
    els.trackListContainer.innerHTML = '';
    const tracks = state.project?.tracks || [];
    els.midiSourceBadge.textContent = (state.project?.sourceType || 'midi').toLowerCase();

    tracks.forEach((tr) => {
      const isChecked = visualizer.selectedTrackIds.has(tr.id);
      const row = document.createElement('div');
      row.className = `track-item${isChecked ? ' active' : ''}`;
      row.innerHTML = `
        <div class="track-item-left">
          <input type="checkbox" ${isChecked ? 'checked' : ''} data-track-id="${tr.id}" />
          <span class="track-name">${tr.name.toLowerCase()}</span>
        </div>
        <span class="track-meta">${tr.noteCount} notes · bars ${tr.startBar}–${tr.endBar}</span>
      `;
      row.addEventListener('click', (e) => {
        const cb = row.querySelector('input[type="checkbox"]');
        if (e.target !== cb) cb.checked = !cb.checked;
        visualizer.toggleTrack(tr.id, cb.checked);
        row.classList.toggle('active', cb.checked);
      });
      els.trackListContainer.appendChild(row);
    });
  }

  function getFilteredClips() {
    const cat = els.fetchCategorySelect ? els.fetchCategorySelect.value : 'all';
    let filtered = [];
    if (cat === 'favorites') {
      filtered = state.clips.filter((c) => Boolean(c.favorite));
    } else if (!cat || cat === 'all') {
      filtered = [...state.clips];
    } else {
      filtered = state.clips.filter((c) => {
        const tagStr = (c.tags || []).join(' ') + ' ' + (c.title || '') + ' ' + (c.vibe || '');
        if (cat === 'kimi_no_na_wa') {
          return /kimi_no_na_wa|your_name/i.test(tagStr) || c.vibe === 'kimi_no_na_wa';
        }
        if (cat === 'weathering_with_you') {
          return /tenki_no_ko|weathering/i.test(tagStr) || c.vibe === 'weathering_with_you';
        }
        if (cat === 'suzume') {
          return /suzume/i.test(tagStr) || c.vibe === 'suzume';
        }
        if (cat === '5_centimeters_per_second') {
          return /5_centimeters|byousoku/i.test(tagStr) || c.vibe === '5_centimeters_per_second';
        }
        if (cat === 'the_garden_of_words') {
          return /garden_of_words|kotonoha/i.test(tagStr) || c.vibe === 'the_garden_of_words';
        }
        if (cat === 'violet_evergarden') {
          return /violet_evergarden|violet/i.test(tagStr) || c.vibe === 'violet_evergarden';
        }
        if (cat === 'a_silent_voice') {
          return /koe_no_katachi|silent_voice/i.test(tagStr) || c.vibe === 'a_silent_voice';
        }
        if (cat === 'your_lie_in_april') {
          return /shigatsu|your_lie_in_april/i.test(tagStr) || c.vibe === 'your_lie_in_april';
        }
        if (cat === 'josee') {
          return /josee/i.test(tagStr) || c.vibe === 'josee';
        }
        if (cat === 'frieren') {
          return /sousou_no_frieren|frieren/i.test(tagStr) || c.vibe === 'frieren';
        }
        if (cat === 'night_sunset') {
          return c.vibe === 'night_sunset' || /night|sunset|twilight|yuru_camp|hibike/i.test(tagStr);
        }
        if (cat === 'calm') {
          return c.vibe === 'calm' || /hyouka|peaceful|quiet|non_non_biyori|tamako/i.test(tagStr);
        }
        if (cat === 'character_melancholic') {
          return c.vibe === 'character' || /violet|liz_to_aoi|koe_no_katachi|frieren/i.test(tagStr);
        }
        if (cat === 'city_walk_stairs') {
          return c.vibe === 'city' || /city|stairs|bridge|train|street|tokyo/i.test(tagStr);
        }
        if (cat === 'beach_ocean_breeze') {
          return c.vibe === 'beach' || /beach|ocean|sea|coast|water/i.test(tagStr);
        }
        if (cat === 'meadows_sky_night') {
          return c.vibe === 'scenery' || /meadow|nature|sky|clouds|grass/i.test(tagStr);
        }
        return c.vibe === cat;
      });
    }

    // sort favorites first, then community score with character bonus
    return filtered.sort((a, b) => {
      if (a.favorite && !b.favorite) return -1;
      if (!a.favorite && b.favorite) return 1;
      const scoreA = (typeof a.score === 'number' ? a.score : 0) + (a.hasCharacter ? 20 : 0);
      const scoreB = (typeof b.score === 'number' ? b.score : 0) + (b.hasCharacter ? 20 : 0);
      return scoreB - scoreA;
    });
  }

  function renderClipGrid() {
    els.clipGridContainer.innerHTML = '';
    const cat = els.fetchCategorySelect ? els.fetchCategorySelect.value : 'all';
    const visibleClips = getFilteredClips();

    if (visibleClips.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-clips-msg';
      empty.style.gridColumn = '1 / -1';
      empty.style.padding = '18px 12px';
      empty.style.textAlign = 'center';
      empty.style.fontSize = '11px';
      empty.style.color = 'var(--text-secondary)';
      empty.textContent =
        cat === 'favorites'
          ? 'no saved favorites yet · click ★ on any clip card to save it'
          : 'no clips in this category yet · click "fetch best" to download';
      els.clipGridContainer.appendChild(empty);
      return;
    }

    visibleClips.forEach((clip) => {
      const isSelected = state.selectedClipIds.includes(clip.id);
      const selIndex = state.selectedClipIds.indexOf(clip.id);
      const card = document.createElement('div');
      card.className = `clip-card${isSelected ? ' selected' : ''}`;
      const orderBadge = isSelected && visualizer.params.cutMode !== 'single'
        ? `<span class="clip-badge-order">${selIndex + 1}</span>`
        : '';
      const isFav = Boolean(clip.favorite);
      const favBadge = `
        <button type="button" class="clip-fav-btn${isFav ? ' active' : ''}" title="${isFav ? 'unfavorite' : 'save to favorites'}" data-clip-id="${clip.id}">
          ${isFav ? '★' : '☆'}
        </button>
      `;
      card.innerHTML = `
        ${orderBadge}
        ${favBadge}
        <video src="${clip.url}" muted loop playsinline preload="metadata"></video>
        <div class="clip-card-info">
          <span class="clip-title" title="${clip.title}">${clip.title.toLowerCase()}</span>
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
          syncVideoPoolSources();
          renderClipGrid();
        });
      });

      const favBtn = card.querySelector('.clip-fav-btn');
      favBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        clip.favorite = !clip.favorite;
        favBtn.classList.toggle('active', clip.favorite);
        favBtn.textContent = clip.favorite ? '★' : '☆';
        favBtn.title = clip.favorite ? 'unfavorite' : 'save to favorites';

        if (els.fetchCategorySelect?.value === 'favorites' && !clip.favorite) {
          renderClipGrid();
        }

        try {
          await fetch(`/api/clips/${encodeURIComponent(clip.id)}/favorite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorite: clip.favorite })
          });
        } catch (err) {
          console.warn('Could not save favorite to server:', err);
        }
      });

      const vid = card.querySelector('video');
      card.addEventListener('mouseenter', () => {
        vid.play().catch(() => {});
      });
      card.addEventListener('mouseleave', () => {
        vid.pause();
      });

      card.addEventListener('click', () => {
        if (visualizer.params.cutMode === 'single') {
          if (state.selectedClipIds.includes(clip.id)) {
            state.selectedClipIds = [];
          } else {
            state.selectedClipIds = [clip.id];
          }
        } else {
          if (state.selectedClipIds.includes(clip.id)) {
            state.selectedClipIds = state.selectedClipIds.filter((id) => id !== clip.id);
          } else {
            state.selectedClipIds = [...state.selectedClipIds.slice(-5), clip.id];
          }
        }
        syncVideoPoolSources();
        renderClipGrid();
      });

      els.clipGridContainer.appendChild(card);
    });
  }

  function drawWaveform() {
    const ctx = waveformCanvas.getContext('2d');
    const W = waveformCanvas.width;
    const H = waveformCanvas.height;
    ctx.clearRect(0, 0, W, H);

    const peaks = state.project?.peaks || [];
    if (peaks.length === 0) return;

    const dur = state.project?.duration || 30.0;
    const dropT = getProjectDropTime();
    const dropRatio = dropT / dur;
    const barW = W / peaks.length;
    const theme = getComputedStyle(els.waveformContainer);
    const wavePre = theme.getPropertyValue('--wave-pre').trim();
    const wavePost = theme.getPropertyValue('--wave-post').trim();

    peaks.forEach((p, idx) => {
      const ratio = idx / peaks.length;
      const isAfterDrop = ratio >= dropRatio;
      const h = Math.max(3, p * (H - 12));
      const x = idx * barW;
      const y = (H - h) * 0.5;

      ctx.fillStyle = isAfterDrop ? wavePost : wavePre;
      ctx.fillRect(x, y, Math.max(1.5, barW - 1), h);
    });

    // cut markers on the waveform
    const cutMode = visualizer.params.cutMode;
    const cuts = cutMode === 'chord'
      ? state.project?.chordCutTimes
      : cutMode === 'impact'
      ? state.project?.impactTimes
      : null;

    if (cuts && cuts.length > 0) {
      ctx.fillStyle = theme.getPropertyValue('--wave-cut').trim();
      cuts.forEach((ct) => {
        const cx = (ct / dur) * W;
        ctx.fillRect(cx - 0.75, 0, 1.5, H);
      });
    }

    updateTimelineMarkers();
  }

  function updateTimelineMarkers() {
    if (!state.project) return;
    const dur = state.project.duration || 30.0;
    const dropT = getProjectDropTime();
    const secPerBar = (60 / (state.project.bpm || 120)) * 4;
    const dropBar = Math.round(dropT / secPerBar) + 1;
    state.project.dropBar = dropBar;
    visualizer.project.dropBar = dropBar;

    const dropPct = Math.max(0, Math.min(100, (dropT / dur) * 100));
    els.dropMarkerLine.style.left = `${dropPct}%`;
    els.dropMarkerTag.textContent = `drop · bar ${dropBar}`;
    els.dropBadgeReadout.textContent = `drop · bar ${dropBar} (${dropT.toFixed(2)}s)`;

    const playPct = Math.max(0, Math.min(100, (state.currentTime / dur) * 100));
    els.timelinePlayhead.style.left = `${playPct}%`;
  }

  function updateTransportReadouts(t) {
    const dur = state.project?.duration || 30.0;
    els.timeReadout.textContent = `${formatTime(t)} / ${formatTime(dur)}`;
    const bpm = state.project?.bpm || 120;
    const totalBeats = t * (bpm / 60);
    const bar = Math.floor(totalBeats / 4) + 1;
    const beat = Math.floor(totalBeats % 4) + 1;
    els.barReadout.textContent = `bar ${String(bar).padStart(2, '0')}.${beat}`;

    const playPct = Math.max(0, Math.min(100, (t / dur) * 100));
    els.timelinePlayhead.style.left = `${playPct}%`;
  }

  function loadProjectIntoStudio(project, clips, recommendedClips) {
    if (project && (!project.chordTimelineMarkers || project.chordTimelineMarkers.length === 0)) {
      if (window.clientAnalyzer && typeof window.clientAnalyzer.computeChordTimelineMarkers === 'function') {
        project.chordTimelineMarkers = window.clientAnalyzer.computeChordTimelineMarkers(project);
      }
    }
    state.project = project;
    if (clips) state.clips = clips;

    els.inputBrand.value = (project.brand || 'aesttc').toLowerCase();
    els.inputNumber.value = project.sampleNumber || '';
    els.inputTitle.value = (project.title || 'untitled').toLowerCase();
    els.inputBpm.value = project.bpm || 120;
    els.inputKey.value = (project.key || '').toLowerCase();

    const metaParts = [];
    if (project.sampleNumber) metaParts.push(`#${project.sampleNumber}`);
    if (project.title) metaParts.push(project.title);
    const subParts = [];
    if (project.bpm) subParts.push(`${project.bpm}bpm`);
    if (project.key) subParts.push(project.key);
    const subStr = subParts.length ? ` (${subParts.join(' · ')})` : '';
    els.uploadStatusText.textContent = `active: ${metaParts.join(' - ')}${subStr}`;

    if (els.headerPreviewTag) {
      const num = project.sampleNumber ? `#${String(project.sampleNumber).replace(/^#?\s*0*/, '') || '1'} - ` : '';
      els.headerPreviewTag.textContent = `[${num}${project.title || 'untitled'} · ${project.brand || 'aesttc'}]`;
    }

    visualizer.setProject(project);
    if (typeof visualizer.setActiveVideos === 'function') {
      visualizer.setActiveVideos(videoPool);
    }

    const initialClips = (recommendedClips && recommendedClips.length ? recommendedClips : state.clips).slice(0, 4);
    if (initialClips.length > 0) {
      state.selectedClipIds =
        visualizer.params.cutMode === 'single'
          ? [initialClips[0].id]
          : initialClips.map((c) => c.id);
    }

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

    syncVideoPoolSources();
    renderTrackList();
    renderClipGrid();
    drawWaveform();
    updateTransportReadouts(0);
  }

  // 60fps preview loop
  function tick() {
    if (!state.isRendering) {
      if (state.isPlaying && !audioEl.paused) {
        const dur = state.project?.duration || 29.09;
        if (audioEl.currentTime >= dur || audioEl.ended) {
          audioEl.currentTime = 0;
          state.currentTime = 0;
        } else {
          state.currentTime = audioEl.currentTime;
        }
      }
      updateTransportReadouts(state.currentTime);
      const activeVid = getActiveVideoForTime(state.currentTime);
      const startAtDrop = visualizer?.modules?.clips?.startAtDrop === true || visualizer?.id === 'constellations';
      if (activeVid && (!startAtDrop || state.currentTime >= getProjectDropTime())) {
        if (state.lastActiveVid !== activeVid) {
          state.lastActiveVid = activeVid;
          const clipTime = getClipTimeForTimestamp(state.currentTime, activeVid);
          if (Number.isFinite(clipTime) && Math.abs(activeVid.currentTime - clipTime) > 0.15) {
            activeVid.currentTime = clipTime;
          }
        }
        if (activeVid.paused) {
          activeVid.play().catch(() => {});
        }
        if (visualizer.params.speedRamping) {
          const ramp = visualizer.getSpeedRampInfo(state.currentTime);
          activeVid.playbackRate = Math.max(0.25, Math.min(4.0, ramp.instSpeed));
        } else if (activeVid.playbackRate !== 1.0) {
          activeVid.playbackRate = 1.0;
        }
        videoPool.forEach((v) => {
          if (v !== activeVid && !v.paused) v.pause();
        });
      }
      visualizer.renderFrame(state.currentTime, activeVid);
    }
    requestAnimationFrame(tick);
  }

  els.playPauseBtn.addEventListener('click', () => {
    if (state.isPlaying) {
      audioEl.pause();
      state.isPlaying = false;
      els.playPauseBtn.textContent = 'play';
    } else {
      audioEl.play().catch(() => {});
      videoPool.forEach((v) => {
        if (v.src) v.play().catch(() => {});
      });
      state.isPlaying = true;
      els.playPauseBtn.textContent = 'pause';
    }
  });

  els.jumpDropBtn.addEventListener('click', () => {
    const dropT = getProjectDropTime();
    const target = Math.max(0, dropT - 2.2);
    audioEl.currentTime = target;
    state.currentTime = target;
    if (!state.isPlaying) {
      els.playPauseBtn.click();
    }
  });

  // waveform seek & drop marker drag
  els.dropMarkerLine.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    state.draggingDropMarker = true;
  });

  window.addEventListener('mousemove', (e) => {
    if (!state.draggingDropMarker || !state.project) return;
    const rect = els.waveformContainer.getBoundingClientRect();
    const ratio = Math.max(0.05, Math.min(0.92, (e.clientX - rect.left) / rect.width));
    const rawTime = ratio * state.project.duration;
    // snap to half-bar boundaries unless shift is held
    const secPerBar = (60 / (state.project.bpm || 120)) * 4;
    const snapped = e.shiftKey ? rawTime : Math.round(rawTime / (secPerBar * 0.5)) * (secPerBar * 0.5);
    state.project.dropTime = Number(snapped.toFixed(3));
    visualizer.project.dropTime = state.project.dropTime;
    visualizer.rebuildNoteNodes();
    drawWaveform();
  });

  window.addEventListener('mouseup', () => {
    state.draggingDropMarker = false;
  });

  els.waveformContainer.addEventListener('click', (e) => {
    if (state.draggingDropMarker || !state.project) return;
    const rect = els.waveformContainer.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const seekT = ratio * state.project.duration;
    state.currentTime = seekT;
    audioEl.currentTime = seekT;
    updateTransportReadouts(seekT);
  });

  [els.inputBrand, els.inputNumber, els.inputTitle, els.inputBpm, els.inputKey].forEach((inp) => {
    inp.addEventListener('input', () => {
      updateMetadataToVisualizer();
      drawWaveform();
    });
  });

  if (els.loopIntroMidiCheckbox) {
    els.loopIntroMidiCheckbox.addEventListener('change', () => {
      if (visualizer && visualizer.params) visualizer.params.loopIntroMidi = els.loopIntroMidiCheckbox.checked;
      if (visualizer && typeof visualizer.rebuildNoteNodes === 'function') visualizer.rebuildNoteNodes();
    });
  }

  if (els.seamlessReelLoopCheckbox) {
    els.seamlessReelLoopCheckbox.addEventListener('change', () => {
      if (visualizer && visualizer.params) visualizer.params.seamlessLoop = els.seamlessReelLoopCheckbox.checked;
    });
  }

  const CUT_MODE_HINTS = {
    chord: 'dynamic chord cuts · switches clips on every harmony change',
    single: 'single serene loop · one atmospheric scene for the entire drop',
    '2bar': '2-bar rhythmic cuts · switches clips every 2 bars',
    '4bar': '4-bar phrasing cuts · switches clips every 4 bars',
    impact: 'transient impact cuts · switches clips on major audio energy peaks'
  };

  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.cutmode;
      visualizer.params.cutMode = mode;
      if (els.cutmodeHint && CUT_MODE_HINTS[mode]) {
        els.cutmodeHint.textContent = CUT_MODE_HINTS[mode];
      }
      if (mode !== 'single' && state.selectedClipIds.length < 2 && state.clips.length >= 4) {
        state.selectedClipIds = state.clips.slice(0, 4).map((c) => c.id);
      } else if (mode === 'single' && state.selectedClipIds.length > 1) {
        state.selectedClipIds = [state.selectedClipIds[0]];
      }
      syncVideoPoolSources();
      renderClipGrid();
      drawWaveform();
    });
  });

  if (els.speedRampToggle) {
    els.speedRampToggle.checked = Boolean(visualizer.params.speedRamping);
    els.speedRampToggle.addEventListener('change', (e) => {
      visualizer.params.speedRamping = e.target.checked;
    });
  }

  if (els.dropGlitchToggle) {
    els.dropGlitchToggle.checked = Boolean(visualizer.params.dropGlitch !== false);
    els.dropGlitchToggle.addEventListener('change', (e) => {
      visualizer.params.dropGlitch = e.target.checked;
    });
  }

  if (els.autoFrameToggle) {
    els.autoFrameToggle.checked = Boolean(visualizer.params.autoFrame !== false);
    els.autoFrameToggle.addEventListener('change', (e) => {
      visualizer.params.autoFrame = e.target.checked;
    });
  }

  if (els.autoPickChordClipsBtn) {
    els.autoPickChordClipsBtn.addEventListener('click', () => {
      if (state.clips.length === 0) return;
      const filtered = getFilteredClips();
      const pool = filtered.length > 0 ? filtered : state.clips;
      state.selectedClipIds = pool.slice(0, Math.min(4, pool.length)).map((c) => c.id);
      syncVideoPoolSources();
      renderClipGrid();
    });
  }

  els.shuffleClipBtn.addEventListener('click', () => {
    if (state.clips.length === 0) return;
    const filtered = getFilteredClips();
    const favs = filtered.filter((c) => Boolean(c.favorite));
    const pool = favs.length > 0 && Math.random() > 0.35 ? favs : (filtered.length > 0 ? filtered : state.clips);
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const count = visualizer.params.cutMode === 'single' ? 1 : Math.min(4, shuffled.length);
    state.selectedClipIds = shuffled.slice(0, count).map((c) => c.id);
    syncVideoPoolSources();
    renderClipGrid();
  });

  if (els.unselectAllClipsBtn) {
    els.unselectAllClipsBtn.addEventListener('click', () => {
      state.selectedClipIds = [];
      syncVideoPoolSources();
      renderClipGrid();
    });
  }

  if (els.fetchCategorySelect) {
    els.fetchCategorySelect.addEventListener('change', () => {
      const pool = getFilteredClips();
      if (pool.length > 0) {
        state.selectedClipIds =
          visualizer.params.cutMode === 'single'
            ? [pool[0].id]
            : pool.slice(0, Math.min(4, pool.length)).map((c) => c.id);
        syncVideoPoolSources();
      }
      renderClipGrid();
    });
  }

  async function handleFetchClips(mode = 'best') {
    const category = els.fetchCategorySelect ? els.fetchCategorySelect.value : 'all';
    const activeBtn = mode === 'random' ? els.fetchRandomClipsBtn : els.fetchBestClipsBtn;
    const defaultLabel = mode === 'random' ? 'fetch random' : 'fetch best';

    if (activeBtn) {
      activeBtn.disabled = true;
      activeBtn.textContent = 'fetching...';
    }

    try {
      const res = await fetch('/api/clips/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, count: 4, mode })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Fetch failed');

      if (data.catalog) {
        state.clips = data.catalog;
        if (data.added && data.added.length > 0) {
          state.selectedClipIds =
            visualizer.params.cutMode === 'single'
              ? [data.added[0].id]
              : data.added.slice(0, 4).map((c) => c.id);
        } else {
          const filtered = getFilteredClips();
          const pool = filtered.length >= 4 ? filtered : state.clips;
          if (mode === 'random') {
            const shuffled = [...pool].sort(() => Math.random() - 0.5);
            state.selectedClipIds =
              visualizer.params.cutMode === 'single'
                ? [shuffled[0].id]
                : shuffled.slice(0, Math.min(4, shuffled.length)).map((c) => c.id);
          } else {
            state.selectedClipIds =
              visualizer.params.cutMode === 'single'
                ? [pool[0].id]
                : pool.slice(0, Math.min(4, pool.length)).map((c) => c.id);
          }
        }
        syncVideoPoolSources();
        renderClipGrid();
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

  if (els.fetchBestClipsBtn) {
    els.fetchBestClipsBtn.addEventListener('click', () => handleFetchClips('best'));
  }

  if (els.fetchRandomClipsBtn) {
    els.fetchRandomClipsBtn.addEventListener('click', () => handleFetchClips('random'));
  }

  els.customClipInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('clip', file);
    try {
      const res = await fetch('/api/clips/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.catalog) {
        state.clips = data.catalog;
        if (data.added) {
          state.selectedClipIds = [data.added.id];
          syncVideoPoolSources();
        }
        renderClipGrid();
      }
    } catch (err) {
      alert(`Clip upload failed: ${err.message}`);
    }
  });

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
      try { URL.revokeObjectURL(state.localAudioUrl); } catch (e) {}
    }
    const localAudioUrl = URL.createObjectURL(audioFile);
    state.localAudioUrl = localAudioUrl;

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

      const effectiveBpm = midiData?.bpm || meta.bpm || parseFloat(els.inputBpm.value) || 120;
      const effectiveKey = meta.key ? meta.key.toLowerCase() : (els.inputKey.value ? els.inputKey.value.toLowerCase() : '');
      const effectiveTitle = (meta.title && meta.title !== 'untitled')
        ? meta.title.toLowerCase()
        : audioFile.name.replace(/\.[^/.]+$/, '').toLowerCase();
      const effectiveSampleNum = meta.sampleNumber || (els.inputNumber.value ? els.inputNumber.value.trim() : '');

      const audioAnalysis = await window.clientAnalyzer.analyzeAudioFileInBrowser(audioFile, effectiveBpm);

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

      const matchedClips = state.clips && state.clips.length ? state.clips.slice(0, 4) : [];

      const project = {
        id: `sample_${Date.now()}`,
        brand: (els.inputBrand.value || 'aesttc').toLowerCase(),
        sampleNumber: effectiveSampleNum,
        title: effectiveTitle,
        key: effectiveKey,
        bpm: effectiveBpm,
        audioUrl: localAudioUrl,
        duration: audioAnalysis.duration,
        dropBar: audioAnalysis.dropBar,
        dropTime: audioAnalysis.dropTime,
        peaks: audioAnalysis.peaks,
        sourceType: midiData.sourceType,
        tracks: midiData.tracks,
        chordCutTimes,
        impactTimes: audioAnalysis.impactTimes || [audioAnalysis.dropTime]
      };

      loadProjectIntoStudio(project, null, matchedClips);
    } catch (err) {
      console.error('Client analysis error:', err);
      els.uploadStatusText.textContent = `error: ${err.message}`;
    }
  }

  els.reloadStarterBtn.addEventListener('click', () => initStarter());

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

    const sampleRate = audioBuffer ? audioBuffer.sampleRate : 44100;
    const numberOfChannels = audioBuffer ? Math.min(2, audioBuffer.numberOfChannels) : 2;

    // probe aac support across standard bitrates
    let useAudioEncoder = false;
    let targetAudioBitrate = 192_000;
    if (audioBuffer && typeof window.AudioEncoder === 'function') {
      for (const br of [192_000, 160_000, 128_000]) {
        try {
          const support = await AudioEncoder.isConfigSupported({
            codec: 'mp4a.40.2',
            sampleRate,
            numberOfChannels,
            bitrate: br
          });
          if (support?.supported) {
            useAudioEncoder = true;
            targetAudioBitrate = br;
            break;
          }
        } catch {
          // continue probing
        }
      }
    }

    const renderWidth = previewCanvas.width || (state.aspectRatio === '16:9' ? 1920 : 1080);
    const renderHeight = previewCanvas.height || (state.aspectRatio === '16:9' ? 1080 : 1920);

    const muxerConfig = {
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: {
        codec: 'avc',
        width: renderWidth,
        height: renderHeight
      },
      fastStart: 'in-memory'
    };
    if (useAudioEncoder) {
      muxerConfig.audio = {
        codec: 'aac',
        sampleRate,
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

    if (useAudioEncoder) {
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => console.warn('AudioEncoder warning:', e)
      });
      audioEncoder.configure({
        codec: 'mp4a.40.2',
        sampleRate,
        numberOfChannels,
        bitrate: targetAudioBitrate
      });

      const chunkFrames = 4096;
      const totalSamples = audioBuffer.length;
      const ch0 = audioBuffer.getChannelData(0);
      const ch1 = numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;

      for (let offset = 0; offset < totalSamples; offset += chunkFrames) {
        const len = Math.min(chunkFrames, totalSamples - offset);
        const planarData = new Float32Array(len * numberOfChannels);
        planarData.set(ch0.subarray(offset, offset + len), 0);
        if (numberOfChannels > 1) {
          planarData.set(ch1.subarray(offset, offset + len), len);
        }
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate,
          numberOfFrames: len,
          numberOfChannels,
          timestamp: Math.round((offset / sampleRate) * 1_000_000),
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
      if (activeVid && t >= getProjectDropTime()) {
        const clipTime = getClipTimeForTimestamp(t, activeVid);
        await seekVideoElement(activeVid, clipTime);
      }

      visualizer.renderFrame(t, activeVid);

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
    let blob = new Blob([buffer], { type: 'video/mp4' });

    // if the browser lacks aac audioencoder support, remux audio via server ffmpeg
    if (!useAudioEncoder && state.project?.audioUrl) {
      els.renderStatusTitle.textContent = 'muxing audio track...';
      try {
        const fd = new FormData();
        fd.append('video', blob, 'video.mp4');
        fd.append('audioUrl', state.project.serverAudioUrl || state.project.audioUrl);
        const remuxRes = await fetch('/api/remux-audio', { method: 'POST', body: fd });
        if (remuxRes.ok) {
          blob = await remuxRes.blob();
        }
      } catch (err) {
        console.warn('Remux fallback notice:', err);
      }
    }

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
      visualizer.renderFrame(state.currentTime, activeVid);
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

  // design switcher modal & registry wiring
  function initDesignSwitcher() {
    function renderGalleryCards() {
      if (!els.designTemplateGrid) return;
      els.designTemplateGrid.innerHTML = '';
      const templates = window.templateRegistry.getAll();
      const activeId = window.templateRegistry.activeTemplateId;

      templates.forEach((tpl) => {
        const isActive = tpl.id === activeId;
        const isCustom = tpl.badge === 'Custom' || Boolean(tpl.isCustom);
        const card = document.createElement('div');
        card.className = `template-card${isActive ? ' active' : ''}`;
        card.innerHTML = `
          <div class="template-card-header">
            <span class="template-card-title">${tpl.name}</span>
            <span class="template-card-badge">${tpl.badge || 'preset'}</span>
          </div>
          <div class="template-card-desc">${tpl.tagline || ''}</div>
          <div class="template-card-footer">
            <span class="template-status-tag">${isActive ? 'active' : 'select'}</span>
            <div class="template-card-actions">
              ${isCustom ? `<button class="template-delete-btn" type="button" title="delete preset">delete</button>` : ''}
              <span class="template-btn-action">${isActive ? 'selected' : 'apply'}</span>
            </div>
          </div>
        `;

        if (isCustom) {
          const delBtn = card.querySelector('.template-delete-btn');
          if (delBtn) {
            delBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              if (confirm(`Delete custom preset "${tpl.name}"?`)) {
                if (window.presetService) {
                  await window.presetService.deletePreset(tpl.id);
                } else if (window.templateRegistry?.templates) {
                  window.templateRegistry.templates.delete(tpl.id);
                }
                renderGalleryCards();
              }
            });
          }
        }

        card.addEventListener('click', async () => {
          await window.templateRegistry.setTemplate(
            tpl.id,
            previewCanvas,
            state,
            els.templateControlsContainer
          );
          visualizer = window.templateRegistry.activeTemplate;
          if (els.topActiveDesignLabel) {
            els.topActiveDesignLabel.textContent = tpl.name;
          }
          applyTemplateModules(visualizer);
          updateMetadataToVisualizer();
          renderGalleryCards();
          closeDesignModal();

          const activeVid = getActiveVideoForTime(state.currentTime);
          if (visualizer && typeof visualizer.renderFrame === 'function') {
            visualizer.renderFrame(state.currentTime, activeVid);
          }
        });
        els.designTemplateGrid.appendChild(card);
      });
    }

    // import preset
    if (els.importPresetBtn && els.importPresetFileInput) {
      els.importPresetBtn.addEventListener('click', () => {
        els.importPresetFileInput.click();
      });

      els.importPresetFileInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          if (!window.presetService) {
            throw new Error('Preset service not initialized');
          }
          const imported = await window.presetService.importPresetFile(file);
          renderGalleryCards();
          if (imported && imported.id) {
            await window.templateRegistry.setTemplate(
              imported.id,
              previewCanvas,
              state,
              els.templateControlsContainer
            );
            visualizer = window.templateRegistry.activeTemplate;
            if (els.topActiveDesignLabel) {
              els.topActiveDesignLabel.textContent = imported.meta.name;
            }
            closeDesignModal();
          }
        } catch (err) {
          alert(`Failed to import preset: ${err.message}`);
        }
        els.importPresetFileInput.value = '';
      });
    }

    // export active preset
    if (els.exportActivePresetBtn) {
      els.exportActivePresetBtn.addEventListener('click', () => {
        const activeId = window.templateRegistry?.activeTemplateId || 'constellations';
        if (window.presetService) {
          window.presetService.exportPreset(activeId);
        }
      });
    }

    // clone & customize active design
    if (els.cloneDesignBtn) {
      els.cloneDesignBtn.addEventListener('click', async () => {
        const activeId = window.templateRegistry?.activeTemplateId || 'constellations';
        const activeTpl = window.templateRegistry?.activeTemplate;
        const defaultName = `${activeTpl ? activeTpl.name : 'Custom Style'} (Clone)`;
        const newName = prompt('Enter a name for the cloned design style:', defaultName);
        if (!newName || !newName.trim()) return;

        // retrieve base 3-box definition
        let baseDef = activeTpl?.preset;
        if (!baseDef && window.STARTER_PRESET_DEFINITIONS) {
          baseDef = window.STARTER_PRESET_DEFINITIONS[activeId];
        }

        const cloneId = newName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
        const clonedPreset = {
          version: '1.0',
          id: cloneId,
          meta: {
            name: newName.trim(),
            title: newName.trim(),
            description: `Customized from ${activeTpl ? activeTpl.name : 'starter style'}`,
            aspectRatio: state.aspectRatio || '9:16',
            badge: 'Custom',
            createdAt: new Date().toISOString()
          },
          features: baseDef?.features || {
            timeline: {
              markers: [{ id: 'drop', label: 'drop', color: '#83ca90' }]
            }
          },
          shaderBox: {
            fragmentShader: baseDef?.shaderBox?.fragmentShader || ''
          },
          frontUiBox: {
            initScript: baseDef?.frontUiBox?.initScript || '',
            drawScript: baseDef?.frontUiBox?.drawScript || ''
          },
          controlsBox: {
            fields: baseDef?.controlsBox?.fields ? JSON.parse(JSON.stringify(baseDef.controlsBox.fields)) : [],
            values: baseDef?.controlsBox?.values ? JSON.parse(JSON.stringify(baseDef.controlsBox.values)) : {}
          }
        };

        try {
          if (window.presetService) {
            const saved = await window.presetService.savePreset(clonedPreset);
            renderGalleryCards();
            await window.templateRegistry.setTemplate(
              saved.id,
              previewCanvas,
              state,
              els.templateControlsContainer
            );
            visualizer = window.templateRegistry.activeTemplate;
            if (els.topActiveDesignLabel) {
              els.topActiveDesignLabel.textContent = saved.meta.name;
            }
            closeDesignModal();
          }
        } catch (err) {
          alert(`Could not clone design: ${err.message}`);
        }
      });
    }

    if (window.presetService) {
      window.presetService.onPresetsChange(() => renderGalleryCards());
      window.presetService.syncWithBackend().then(() => renderGalleryCards());
    }

    function openDesignModal() {
      if (els.designModal) {
        renderGalleryCards();
        els.designModal.hidden = false;
      }
    }

    function closeDesignModal() {
      if (els.designModal) {
        els.designModal.hidden = true;
      }
    }

    if (els.openDesignModalBtn) {
      els.openDesignModalBtn.addEventListener('click', openDesignModal);
    }
    if (els.closeDesignModalBtn) {
      els.closeDesignModalBtn.addEventListener('click', closeDesignModal);
    }
    if (els.designModal) {
      els.designModal.addEventListener('click', (e) => {
        if (e.target === els.designModal) closeDesignModal();
      });
    }
    function openAiSettingsModal() {
      if (window.ByokAiProvider) {
        const s = window.ByokAiProvider.getSettings();
        if (els.byokApiKeyInput) els.byokApiKeyInput.value = s.apiKey;
        if (els.byokBaseUrlInput) els.byokBaseUrlInput.value = s.baseUrl;
        if (els.byokModelInput) els.byokModelInput.value = s.model;
      }
      if (els.aiSettingsSaveStatus) els.aiSettingsSaveStatus.textContent = '';
      if (els.aiSettingsModal) els.aiSettingsModal.hidden = false;
    }

    function closeAiSettingsModal() {
      if (els.aiSettingsModal) els.aiSettingsModal.hidden = true;
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
          window.ByokAiProvider.saveSettings({
            apiKey: els.byokApiKeyInput.value,
            baseUrl: els.byokBaseUrlInput.value,
            model: els.byokModelInput.value
          });
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

    window.openAiSettingsModal = openAiSettingsModal;

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (els.designModal && !els.designModal.hidden) closeDesignModal();
        if (els.aiSettingsModal && !els.aiSettingsModal.hidden) closeAiSettingsModal();
      }
    });

    window.templateRegistry.onTemplateChange((tpl) => {
      visualizer = tpl;
      if (els.topActiveDesignLabel) {
        els.topActiveDesignLabel.textContent = tpl.name;
      }
      applyTemplateModules(tpl);
      if (typeof visualizer.setActiveVideos === 'function') {
        visualizer.setActiveVideos(videoPool);
      }
      if (typeof visualizer.setAspectRatio === 'function') {
        visualizer.setAspectRatio(state.aspectRatio || '9:16');
      }
      updateMetadataToVisualizer();
    });

    if (els.aspectRatioToggleBtn) {
      els.aspectRatioToggleBtn.addEventListener('click', () => {
        const nextAspect = state.aspectRatio === '9:16' ? '16:9' : '9:16';
        state.aspectRatio = nextAspect;

        if (els.canvasHousing) {
          els.canvasHousing.classList.toggle('aspect-16-9', nextAspect === '16:9');
        }

        previewCanvas.width = nextAspect === '16:9' ? 1920 : 1080;
        previewCanvas.height = nextAspect === '16:9' ? 1080 : 1920;

        if (typeof visualizer.setAspectRatio === 'function') {
          visualizer.setAspectRatio(nextAspect);
        }

        const activeVid = getActiveVideoForTime(state.currentTime);
        if (visualizer && typeof visualizer.renderFrame === 'function') {
          visualizer.renderFrame(state.currentTime, activeVid);
        }

        if (els.aspectRatioTelemetry) {
          els.aspectRatioTelemetry.textContent =
            nextAspect === '16:9' ? 'res: 1920×1080 (16:9)' : 'res: 1080×1920 (9:16)';
        }

        els.aspectRatioToggleBtn.textContent =
          nextAspect === '16:9'
            ? 'switch to 9:16 vertical'
            : 'switch to 16:9 widescreen';
      });
    }
  }

  async function initStarter() {
    try {
      const sessionRes = await fetch('/api/session');
      const sessionData = await sessionRes.json();
      if (els.authBadge && sessionData.authelia?.username) {
        els.authBadge.textContent = `authelia · ${sessionData.authelia.username.toLowerCase()}`;
      }
      if (els.encoderBadge && typeof window.VideoEncoder !== 'function') {
        els.encoderBadge.textContent = 'encoder: mediarecorder 60fps';
      }

      const res = await fetch('/api/starter');
      const data = await res.json();
      if (data.project) {
        // cache starter audio in a local blob url for zero-latency seeking
        if (data.project.audioUrl) {
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
        loadProjectIntoStudio(data.project, data.clips, data.recommendedClips);
      }
    } catch (err) {
      console.error('Failed to load starter project:', err);
    }
  }

  function initVizStudio() {
    const drawer = document.getElementById('vizStudioDrawer');
    const openBtn = document.getElementById('openVizStudioBtn');
    const closeBtn = document.getElementById('closeVizStudioBtn');
    const tabBtns = document.querySelectorAll('.viz-tab-btn');
    const panes = {
      viz: document.getElementById('vizPaneViz'),
      shader: document.getElementById('vizPaneShader'),
      overlay: document.getElementById('vizPaneOverlay'),
      ui: document.getElementById('vizPaneUi')
    };

    const presetLabel = document.getElementById('vizActivePresetLabel');
    const promptInput = document.getElementById('vizPromptInput');
    const generateBtn = document.getElementById('vizGenerateBtn');
    const undoBtn = document.getElementById('vizUndoBtn');
    const keyNotice = document.getElementById('vizKeyNotice');
    const openByokLink = document.getElementById('vizOpenByokLink');

    const shaderEditor = document.getElementById('codeEditorShader');
    const initEditor = document.getElementById('codeEditorInit');
    const drawEditor = document.getElementById('codeEditorDraw');
    const uiEditor = document.getElementById('codeEditorUi');

    const applyBtn = document.getElementById('vizApplyCodeBtn');
    const saveBtn = document.getElementById('vizSavePresetBtn');
    const statusBar = document.getElementById('vizStudioStatus');

    const undoStack = [];

    function setStatus(msg, type = '') {
      if (!statusBar) return;
      statusBar.textContent = msg;
      statusBar.className = `viz-status-bar ${type}`.trim();
    }

    function getActivePresetCopy() {
      const tpl = window.templateRegistry?.activeTemplate;
      const base = tpl?.preset || window.STARTER_PRESET_DEFINITIONS?.[tpl?.id];
      if (!base) {
        return JSON.parse(JSON.stringify(window.STARTER_PRESET_DEFINITIONS.new_blank));
      }
      return JSON.parse(JSON.stringify(base));
    }

    function syncEditorsFromActive() {
      const preset = getActivePresetCopy();
      if (presetLabel) presetLabel.textContent = preset.meta?.name || preset.id || 'preset';
      if (shaderEditor) shaderEditor.value = (preset.shaderBox?.fragmentShader || '').trim();
      if (initEditor) initEditor.value = (preset.frontUiBox?.initScript || '').trim();
      if (drawEditor) drawEditor.value = (preset.frontUiBox?.drawScript || '').trim();
      if (uiEditor) {
        uiEditor.value = JSON.stringify(
          {
            modules: preset.modules || {},
            controlsBox: preset.controlsBox || { fields: [], values: {} }
          },
          null,
          2
        );
      }
      if (keyNotice) {
        keyNotice.hidden = Boolean(window.ByokAiProvider && window.ByokAiProvider.hasKey());
      }
      if (undoBtn) {
        undoBtn.disabled = undoStack.length === 0;
      }
    }

    async function hotReloadPreset(nextPreset) {
      if (!nextPreset.id) nextPreset.id = window.templateRegistry?.activeTemplateId || `viz_${Date.now()}`;
      if (!nextPreset.version) nextPreset.version = '1.0';
      if (!nextPreset.meta) nextPreset.meta = { name: nextPreset.id, aspectRatio: state.aspectRatio || '9:16' };

      // force re-registration of the updated 3-box definition
      window.templateRegistry.templates.delete(nextPreset.id);
      window.templateRegistry.registerPreset(nextPreset);

      await window.templateRegistry.setTemplate(
        nextPreset.id,
        previewCanvas,
        state,
        els.templateControlsContainer
      );

      visualizer = window.templateRegistry.activeTemplate;
      if (els.topActiveDesignLabel && visualizer) {
        els.topActiveDesignLabel.textContent = visualizer.name;
      }
      applyTemplateModules(visualizer);

      if (typeof visualizer.setAspectRatio === 'function') {
        visualizer.setAspectRatio(state.aspectRatio || '9:16');
      }
      updateMetadataToVisualizer();

      const activeVid = getActiveVideoForTime(state.currentTime);
      if (visualizer && typeof visualizer.renderFrame === 'function') {
        visualizer.renderFrame(state.currentTime, activeVid);
      }

      syncEditorsFromActive();
    }

    function openDrawer() {
      if (!drawer) return;
      syncEditorsFromActive();
      drawer.hidden = false;
      setStatus('ready');
    }

    function closeDrawer() {
      if (!drawer) return;
      drawer.hidden = true;
    }

    if (openBtn) openBtn.addEventListener('click', () => (drawer.hidden ? openDrawer() : closeDrawer()));
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);

    if (openByokLink) {
      openByokLink.addEventListener('click', () => {
        const aiBtn = document.getElementById('openAiSettingsBtn');
        if (aiBtn) aiBtn.click();
      });
    }

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
        promptInput.focus();
      });
    });

    if (applyBtn) {
      applyBtn.addEventListener('click', async () => {
        try {
          const current = getActivePresetCopy();
          undoStack.push(current);

          const parsedUi = JSON.parse(uiEditor.value || '{}');
          const updated = {
            ...current,
            modules: parsedUi.modules || current.modules || {},
            shaderBox: {
              fragmentShader: shaderEditor.value
            },
            frontUiBox: {
              initScript: initEditor.value,
              drawScript: drawEditor.value
            },
            controlsBox: parsedUi.controlsBox || current.controlsBox || { fields: [], values: {} }
          };

          await hotReloadPreset(updated);
          setStatus('applied & reloaded', 'success');
        } catch (err) {
          undoStack.pop();
          setStatus(`error: ${err.message}`, 'error');
        }
      });
    }

    if (generateBtn) {
      generateBtn.addEventListener('click', async () => {
        const promptText = promptInput?.value.trim();
        if (!promptText) {
          setStatus('enter a prompt for viz first', 'error');
          return;
        }
        if (!window.ByokAiProvider?.hasKey()) {
          setStatus('api key missing — open ai settings [byok]', 'error');
          if (keyNotice) keyNotice.hidden = false;
          return;
        }

        const previous = getActivePresetCopy();
        generateBtn.disabled = true;
        generateBtn.textContent = 'viz is designing...';
        setStatus('generating 3-box preset with viz...');

        try {
          const generated = await window.ByokAiProvider.generatePreset(
            promptText,
            previous,
            {
              bpm: state.project?.bpm,
              key: state.project?.key,
              midi: { hasMidi: Boolean(state.project?.tracks?.length), tracks: state.project?.tracks },
              clips: { count: state.selectedClipIds?.length || 0 },
              aspectRatio: state.aspectRatio
            }
          );

          undoStack.push(previous);
          generated.id = previous.id === 'constellations' ? `viz_${Date.now()}` : previous.id;
          if (!generated.meta) generated.meta = {};
          generated.meta.badge = 'Viz AI';

          await hotReloadPreset(generated);
          setStatus('viz preset applied', 'success');
        } catch (err) {
          setStatus(`viz error: ${err.message}`, 'error');
        } finally {
          generateBtn.disabled = false;
          generateBtn.textContent = 'generate with viz';
        }
      });
    }

    if (undoBtn) {
      undoBtn.addEventListener('click', async () => {
        if (undoStack.length === 0) return;
        const prev = undoStack.pop();
        await hotReloadPreset(prev);
        setStatus('reverted to previous state', 'success');
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const current = getActivePresetCopy();
        const defaultTitle = current.meta?.name ? `${current.meta.name} (Custom)` : 'My Viz Preset';
        const name = prompt('Save preset as:', defaultTitle);
        if (!name || !name.trim()) return;

        current.id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
        current.meta = {
          ...(current.meta || {}),
          name: name.trim(),
          title: name.trim(),
          badge: 'Custom',
          updatedAt: new Date().toISOString()
        };

        try {
          if (window.presetService) {
            const saved = await window.presetService.savePreset(current);
            await hotReloadPreset(saved);
            setStatus(`saved "${saved.meta.name}"`, 'success');
          }
        } catch (err) {
          setStatus(`save failed: ${err.message}`, 'error');
        }
      });
    }

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (drawer.hidden) openDrawer();
        else closeDrawer();
      } else if (e.key === 'Escape' && drawer && !drawer.hidden) {
        closeDrawer();
      }
    });
  }

  initDesignSwitcher();
  initVizStudio();
  initStarter();
  requestAnimationFrame(tick);
})();

