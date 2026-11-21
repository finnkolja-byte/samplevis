// dynamic sidebar control builder for preset controlsBox schemas
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // the engine reads these straight from controlsBox.values (clip cuts, loop, framing), so they
  // are legitimately absent from a preset's own overlay script
  const ENGINE_CONTROL_IDS = new Set([
    'cutMode',
    'speedRamping',
    'clipTransition',
    'clipTransitionDuration',
    'dropGlitch',
    'autoFrame',
    'seamlessLoop',
    'loopStyle'
  ]);


  function slugifySectionId(label, fallbackIdx) {
    const clean = String(label || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return clean || `section_${fallbackIdx}`;
  }

  class ControlsManager {
    static _getSectionStore(presetId) {
      if (typeof sessionStorage === 'undefined') return {};
      try {
        const raw = sessionStorage.getItem(`samplevis_ctrl_sections_${presetId || 'default'}`);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    static _setSectionOpen(presetId, sectionId, isOpen) {
      if (typeof sessionStorage === 'undefined' || !sectionId) return;
      try {
        const store = ControlsManager._getSectionStore(presetId);
        store[sectionId] = Boolean(isOpen);
        sessionStorage.setItem(`samplevis_ctrl_sections_${presetId || 'default'}`, JSON.stringify(store));
      } catch {
        // ignore sessionStorage quota errors
      }
    }

    static createSectionElement({ presetId = 'default', sectionId, title, count = 0, defaultOpen = true, onToggle }) {
      const details = document.createElement('details');
      details.className = 'control-section';
      const resolvedId = sectionId || slugifySectionId(title, 0);
      details.dataset.sectionId = resolvedId;

      const store = ControlsManager._getSectionStore(presetId);
      const savedOpen = Object.prototype.hasOwnProperty.call(store, resolvedId)
        ? Boolean(store[resolvedId])
        : Boolean(defaultOpen);
      details.open = savedOpen;

      const summary = document.createElement('summary');
      summary.className = 'control-section-summary';

      const left = document.createElement('span');
      left.className = 'control-section-left';

      const chevron = document.createElementNS(SVG_NS, 'svg');
      chevron.setAttribute('class', 'control-section-chevron');
      chevron.setAttribute('viewBox', '0 0 12 12');
      chevron.setAttribute('fill', 'none');
      chevron.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M4.25 2.5L7.75 6L4.25 9.5');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      chevron.appendChild(path);

      const titleSpan = document.createElement('span');
      titleSpan.className = 'control-section-title';
      titleSpan.textContent = String(title || 'controls').toLowerCase();

      left.appendChild(chevron);
      left.appendChild(titleSpan);

      const countSpan = document.createElement('span');
      countSpan.className = 'control-section-count';
      countSpan.textContent = String(count);

      summary.appendChild(left);
      summary.appendChild(countSpan);

      const body = document.createElement('div');
      body.className = 'control-section-body';

      details.appendChild(summary);
      details.appendChild(body);

      details.addEventListener('toggle', () => {
        ControlsManager._setSectionOpen(presetId, resolvedId, details.open);
        const container = details.parentElement;
        if (container) {
          ControlsManager.syncSectionHeaderActions(container, presetId);
        }
        if (typeof onToggle === 'function') {
          onToggle(resolvedId, details.open);
        }
      });

      return { details, body };
    }

    static syncSectionHeaderActions(container, presetId = 'default') {
      if (typeof document === 'undefined' || !container) return;
      const actionsEl = document.getElementById('controlsSectionActions');
      const toggleBtn = document.getElementById('toggleControlSectionsBtn');
      if (!actionsEl || !toggleBtn) return;

      const sections = Array.from(container.querySelectorAll('details.control-section'));
      if (sections.length < 2) {
        actionsEl.hidden = true;
        toggleBtn.onclick = null;
        return;
      }

      actionsEl.hidden = false;
      const updateBtnLabel = () => {
        const anyOpen = sections.some((d) => d.open);
        toggleBtn.textContent = anyOpen ? 'collapse all' : 'expand all';
        toggleBtn.title = anyOpen
          ? 'collapse all control sections'
          : 'expand all control sections';
      };

      updateBtnLabel();

      toggleBtn.onclick = () => {
        const anyOpen = sections.some((d) => d.open);
        const nextOpen = !anyOpen;
        sections.forEach((d, idx) => {
          d.open = nextOpen;
          const sid = d.dataset.sectionId || `section_${idx}`;
          ControlsManager._setSectionOpen(presetId, sid, nextOpen);
        });
        updateBtnLabel();
      };
    }

    static _buildFieldNode(field, currentVal, values, presetId, isStarter, onChange, preset = null) {
      if (!field || !field.id || field.type === 'section') return null;

      if (field.type === 'slider') {
        const group = document.createElement('div');
        group.className = 'slider-group';

        const row = document.createElement('div');
        row.className = 'slider-row';

        const label = document.createElement('label');
        label.htmlFor = `ctrl_${field.id}`;
        label.textContent = field.label || field.id;

        const valReadout = document.createElement('span');
        valReadout.className = 'slider-val';
        valReadout.id = `readout_${field.id}`;
        valReadout.textContent = field.formatValue ? field.formatValue(currentVal) : String(currentVal);

        row.appendChild(label);
        row.appendChild(valReadout);

        const input = document.createElement('input');
        input.type = 'range';
        input.id = `ctrl_${field.id}`;
        input.min = field.min !== undefined ? field.min : 0;
        input.max = field.max !== undefined ? field.max : 100;
        input.step = field.step !== undefined ? field.step : 1;
        input.value = currentVal;

        input.addEventListener('input', (e) => {
          const v = parseFloat(e.target.value);
          values[field.id] = v;
          valReadout.textContent = field.formatValue ? field.formatValue(v) : String(v);
          if (isStarter) ControlsManager._persist(presetId, values);
          if (typeof onChange === 'function') onChange(field.id, v);
        });

        group.appendChild(row);
        group.appendChild(input);
        return group;
      }

      if (field.type === 'toggle') {
        const row = document.createElement('div');
        row.className = 'speedramp-row';
        row.style.marginTop = '6px';
        row.style.marginBottom = '8px';

        const label = document.createElement('label');
        label.className = 'speedramp-label';
        label.htmlFor = `ctrl_${field.id}`;

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = `ctrl_${field.id}`;
        input.checked = Boolean(currentVal);

        const textSpan = document.createElement('span');
        textSpan.className = 'speedramp-text';
        textSpan.textContent = field.label || field.id;

        label.appendChild(input);
        label.appendChild(textSpan);

        if (field.subtext) {
          const sub = document.createElement('span');
          sub.className = 'speedramp-subtext';
          sub.textContent = ` · ${field.subtext}`;
          label.appendChild(sub);
        }

        input.addEventListener('change', (e) => {
          const v = e.target.checked;
          values[field.id] = v;
          if (isStarter) ControlsManager._persist(presetId, values);
          if (typeof onChange === 'function') onChange(field.id, v);
        });

        row.appendChild(label);
        return row;
      }

      if (field.type === 'color') {
        const row = document.createElement('div');
        row.className = 'color-control-row';

        const label = document.createElement('label');
        label.className = 'color-control-label';
        label.htmlFor = `ctrl_${field.id}`;
        label.textContent = field.label || field.id;

        const colorWrap = document.createElement('div');
        colorWrap.className = 'color-picker-chip';

        const input = document.createElement('input');
        input.type = 'color';
        input.id = `ctrl_${field.id}`;
        input.value = String(currentVal || '#83ca90');

        const hexText = document.createElement('span');
        hexText.className = 'color-hex-tag';
        hexText.textContent = String(input.value);

        input.addEventListener('input', (e) => {
          const v = e.target.value;
          values[field.id] = v;
          hexText.textContent = v;
          if (isStarter) ControlsManager._persist(presetId, values);
          if (typeof onChange === 'function') onChange(field.id, v);
        });

        colorWrap.appendChild(input);
        colorWrap.appendChild(hexText);
        row.appendChild(label);
        row.appendChild(colorWrap);
        return row;
      }

      if (field.type === 'select') {
        const row = document.createElement('div');
        row.className = 'slider-row';
        row.style.marginTop = '8px';
        row.style.marginBottom = '8px';
        row.style.gap = '8px';
        row.style.alignItems = 'center';

        const label = document.createElement('label');
        label.htmlFor = `ctrl_${field.id}`;
        label.textContent = field.label || field.id;

        const select = document.createElement('select');
        select.id = `ctrl_${field.id}`;
        select.className = 'select-compact';

        (field.options || []).forEach((opt) => {
          const el = document.createElement('option');
          el.value = opt;
          el.textContent = opt;
          if (opt === currentVal) el.selected = true;
          select.appendChild(el);
        });

        select.addEventListener('change', (e) => {
          const v = e.target.value;
          values[field.id] = v;
          if (isStarter) ControlsManager._persist(presetId, values);
          if (typeof onChange === 'function') onChange(field.id, v);
        });

        row.appendChild(label);
        row.appendChild(select);
        return row;
      }

      if (field.type === 'font') {
        // one library for the page and the sandbox; fontLibrary.js is generated by scripts/fetch-fonts.mjs
        const defaultFonts = [...(window.STUDIO_FONTS?.families || [])];
        if (defaultFonts.length === 0) {
          defaultFonts.push('Space Grotesk', 'Instrument Serif', 'Playfair Display', 'Geist Mono', 'Plus Jakarta Sans', 'Geist');
        }
        const wrap = document.createElement('div');
        wrap.className = 'font-control-row';

        const header = document.createElement('div');
        header.className = 'media-control-header';

        const label = document.createElement('label');
        label.htmlFor = `ctrl_${field.id}`;
        label.textContent = field.label || field.id;

        const uploadBtn = document.createElement('button');
        uploadBtn.type = 'button';
        uploadBtn.className = 'font-upload-btn';
        uploadBtn.textContent = '+ font';
        uploadBtn.title = 'upload custom font (.ttf, .otf, .woff, .woff2)';
        uploadBtn.setAttribute('aria-label', `upload custom font for ${field.label || field.id}`);

        header.appendChild(label);
        header.appendChild(uploadBtn);

        const controlsLine = document.createElement('div');
        controlsLine.className = 'font-control-inputs';

        const select = document.createElement('select');
        select.id = `ctrl_${field.id}`;
        select.className = 'select-compact font-control-select';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2';
        fileInput.hidden = true;

        const statusEl = document.createElement('span');
        statusEl.className = 'font-control-status';
        statusEl.setAttribute('role', 'status');
        statusEl.setAttribute('aria-live', 'polite');
        statusEl.hidden = true;

        const resolvedCurrent = currentVal !== undefined && currentVal !== null
          ? String(currentVal)
          : (field.default !== undefined ? String(field.default) : '');

        const rebuildOptions = (selectedFamily) => {
          // the preset's own families come first, then the whole studio library, so the control is
          // never a one-item list just because viz only named one family in the schema
          const declared = Array.isArray(field.options) && field.options.length > 0
            ? field.options
            : (Array.isArray(field.fonts) && field.fonts.length > 0 ? field.fonts : []);
          const baseList = declared.length > 0 ? [...declared, ...defaultFonts] : defaultFonts;
          const customFonts = Array.isArray(preset?.assets?.customFonts) ? preset.assets.customFonts : [];
          const customSet = new Set(customFonts.map((f) => String(f?.family || '').trim().toLowerCase()).filter(Boolean));
          const seen = new Set();
          const entries = [];

          const pushOption = (rawName, isCustom = false) => {
            const name = String(rawName || '').trim();
            if (!name) return;
            const key = name.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            entries.push({ value: name, label: isCustom || customSet.has(key) ? `${name} (custom)` : name });
          };

          baseList.forEach((opt) => pushOption(opt, false));
          customFonts.forEach((f) => pushOption(f?.family, true));
          if (selectedFamily) pushOption(selectedFamily, customSet.has(selectedFamily.toLowerCase()));

          select.textContent = '';
          entries.forEach((entry) => {
            const opt = document.createElement('option');
            opt.value = entry.value;
            opt.textContent = entry.label;
            if (entry.value === selectedFamily) opt.selected = true;
            select.appendChild(opt);
          });

          if (!selectedFamily && entries.length > 0) {
            select.value = entries[0].value;
          }
        };

        rebuildOptions(resolvedCurrent);
        if (values[field.id] === undefined && select.value) {
          values[field.id] = select.value;
        }

        select.addEventListener('change', (e) => {
          const v = e.target.value;
          values[field.id] = v;
          if (isStarter) ControlsManager._persist(presetId, values);
          if (typeof onChange === 'function') onChange(field.id, v, { type: 'font', family: v });
        });

        uploadBtn.addEventListener('click', () => {
          fileInput.click();
        });

        fileInput.addEventListener('change', async (e) => {
          const file = e.target.files?.[0];
          fileInput.value = '';
          if (!file) return;

          const extMatch = String(file.name || '').toLowerCase().match(/\.(ttf|otf|woff2?)$/);
          if (!extMatch) {
            statusEl.textContent = 'only .ttf, .otf, .woff, .woff2 supported';
            statusEl.dataset.state = 'error';
            statusEl.hidden = false;
            return;
          }

          const ext = extMatch[1];
          const mimeMap = {
            ttf: 'font/ttf',
            otf: 'font/otf',
            woff: 'font/woff',
            woff2: 'font/woff2'
          };
          const mimeType = mimeMap[ext] || 'font/ttf';
          const family = String(file.name || '')
            .replace(/\.(ttf|otf|woff2?)$/i, '')
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || 'Custom Font';

          try {
            statusEl.textContent = `loading "${family}"...`;
            statusEl.dataset.state = 'info';
            statusEl.hidden = false;

            const [buffer, rawDataUrl] = await Promise.all([
              file.arrayBuffer(),
              new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(new Error(`could not read ${file.name || 'font'}`));
                reader.readAsDataURL(file);
              })
            ]);

            if (typeof FontFace !== 'undefined' && typeof document !== 'undefined' && document.fonts) {
              const face = new FontFace(family, buffer);
              const loaded = await face.load();
              document.fonts.add(loaded);
            }

            const commaIdx = rawDataUrl.indexOf(',');
            const dataUrl = commaIdx !== -1
              ? `data:${mimeType};base64,${rawDataUrl.slice(commaIdx + 1)}`
              : rawDataUrl;

            const fontEntry = {
              family,
              name: file.name || `${family}.${ext}`,
              mimeType,
              dataUrl
            };

            if (preset && typeof preset === 'object') {
              preset.assets = preset.assets && typeof preset.assets === 'object' ? preset.assets : {};
              const existing = Array.isArray(preset.assets.customFonts) ? preset.assets.customFonts : [];
              const filtered = existing.filter((f) => String(f?.family || '').toLowerCase() !== family.toLowerCase());
              filtered.push(fontEntry);
              preset.assets.customFonts = filtered.slice(-12);
            }

            values[field.id] = family;
            rebuildOptions(family);
            select.value = family;
            if (isStarter) ControlsManager._persist(presetId, values);
            if (typeof onChange === 'function') {
              onChange(field.id, family, { type: 'font', family, customFont: fontEntry });
            }

            statusEl.textContent = `loaded "${family}"`;
            statusEl.dataset.state = 'ok';
            statusEl.hidden = false;
          } catch (err) {
            statusEl.textContent = err?.message || 'failed to load font';
            statusEl.dataset.state = 'error';
            statusEl.hidden = false;
          }
        });

        controlsLine.appendChild(select);
        controlsLine.appendChild(fileInput);

        wrap.appendChild(header);
        wrap.appendChild(controlsLine);
        wrap.appendChild(statusEl);
        return wrap;
      }

      if (field.type === 'text') {
        const row = document.createElement('div');
        row.className = 'slider-row';
        row.style.marginTop = '6px';
        row.style.marginBottom = '6px';
        row.style.gap = '8px';
        row.style.alignItems = 'center';

        const label = document.createElement('label');
        label.htmlFor = `ctrl_${field.id}`;
        label.textContent = field.label || field.id;

        const input = document.createElement('input');
        input.type = 'text';
        input.id = `ctrl_${field.id}`;
        input.value = currentVal !== undefined && currentVal !== null ? String(currentVal) : '';
        input.placeholder = field.placeholder ? String(field.placeholder) : '';
        input.style.minWidth = '0';
        input.style.flex = '1';
        input.style.maxWidth = '145px';
        input.style.padding = '4px 8px';
        input.style.fontSize = '11px';

        input.addEventListener('input', (e) => {
          const v = e.target.value;
          values[field.id] = v;
          if (isStarter) ControlsManager._persist(presetId, values);
          if (typeof onChange === 'function') onChange(field.id, v);
        });

        row.appendChild(label);
        row.appendChild(input);
        return row;
      }

      if (field.type === 'image' || field.type === 'video') {
        const mediaKind = field.type;
        const wrap = document.createElement('div');
        wrap.className = 'media-control-row';

        const header = document.createElement('div');
        header.className = 'media-control-header';

        const label = document.createElement('label');
        label.className = 'color-control-label';
        label.htmlFor = `ctrl_${field.id}`;
        label.textContent = field.label || field.id;

        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'media-slot-clear-btn';
        clearBtn.textContent = 'clear';
        clearBtn.hidden = true;

        header.appendChild(label);
        header.appendChild(clearBtn);

        const dropzone = document.createElement('div');
        dropzone.className = 'media-slot-dropzone';
        dropzone.tabIndex = 0;
        dropzone.setAttribute('role', 'button');
        dropzone.setAttribute('aria-label', `${field.label || field.id} ${mediaKind} upload`);

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.id = `ctrl_${field.id}`;
        fileInput.accept = mediaKind === 'video' ? 'video/*,.mp4,.webm,.mov' : 'image/*';
        fileInput.hidden = true;

        const previewImg = document.createElement('img');
        previewImg.className = 'media-slot-thumb';
        previewImg.alt = '';
        previewImg.hidden = true;

        const previewVid = document.createElement('video');
        previewVid.className = 'media-slot-thumb';
        previewVid.muted = true;
        previewVid.playsInline = true;
        previewVid.loop = true;
        previewVid.preload = 'metadata';
        previewVid.hidden = true;

        const metaBox = document.createElement('div');
        metaBox.className = 'media-slot-meta';

        const nameEl = document.createElement('span');
        nameEl.className = 'media-slot-name';
        nameEl.textContent = `drop ${mediaKind} or click`;

        const hintEl = document.createElement('span');
        hintEl.className = 'media-slot-hint';
        hintEl.textContent = field.subtext || 'kept locally in browser';

        metaBox.appendChild(nameEl);
        metaBox.appendChild(hintEl);

        dropzone.appendChild(previewImg);
        dropzone.appendChild(previewVid);
        dropzone.appendChild(metaBox);
        dropzone.appendChild(fileInput);

        const applyPreview = (url, name) => {
          if (url) {
            if (mediaKind === 'video') {
              previewImg.hidden = true;
              previewVid.src = url;
              previewVid.hidden = false;
            } else {
              previewVid.hidden = true;
              previewVid.removeAttribute('src');
              previewImg.src = url;
              previewImg.hidden = false;
            }
            nameEl.textContent = name || `${mediaKind} loaded`;
            dropzone.classList.add('has-media');
            clearBtn.hidden = false;
          } else {
            previewImg.hidden = true;
            previewImg.removeAttribute('src');
            previewVid.hidden = true;
            previewVid.removeAttribute('src');
            nameEl.textContent = `drop ${mediaKind} or click`;
            dropzone.classList.remove('has-media');
            clearBtn.hidden = true;
          }
        };

        const handleSelectedFile = async (file) => {
          if (!file) return;
          const bundleSvc = typeof window !== 'undefined' ? window.projectBundleService : null;
          let storedRef = null;
          let previewUrl = null;

          if (bundleSvc && typeof bundleSvc.saveSlotMedia === 'function') {
            const saved = await bundleSvc.saveSlotMedia(presetId, field.id, file, {
              kind: mediaKind,
              name: file.name,
              mimeType: file.type
            });
            storedRef = saved?.idbRef || null;
            previewUrl = saved?.objectUrl || null;
          } else {
            previewUrl = URL.createObjectURL(file);
            storedRef = previewUrl;
          }

          values[field.id] = storedRef || previewUrl;
          applyPreview(previewUrl, file.name);
          if (isStarter) ControlsManager._persist(presetId, values);
          if (typeof onChange === 'function') {
            onChange(field.id, values[field.id], {
              type: mediaKind,
              url: previewUrl,
              name: file.name,
              cleared: false
            });
          }
        };

        dropzone.addEventListener('click', (e) => {
          if (e.target === fileInput) return;
          fileInput.click();
        });
        dropzone.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.click();
          }
        });
        dropzone.addEventListener('dragover', (e) => {
          e.preventDefault();
          dropzone.classList.add('dragover');
        });
        dropzone.addEventListener('dragleave', () => {
          dropzone.classList.remove('dragover');
        });
        dropzone.addEventListener('drop', (e) => {
          e.preventDefault();
          dropzone.classList.remove('dragover');
          const file = e.dataTransfer?.files?.[0];
          if (file) handleSelectedFile(file);
        });
        fileInput.addEventListener('change', (e) => {
          const file = e.target.files?.[0];
          if (file) handleSelectedFile(file);
          fileInput.value = '';
        });

        clearBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          values[field.id] = null;
          const bundleSvc = typeof window !== 'undefined' ? window.projectBundleService : null;
          if (bundleSvc && typeof bundleSvc.deleteSlotMedia === 'function') {
            await bundleSvc.deleteSlotMedia(presetId, field.id);
          }
          applyPreview(null, null);
          if (isStarter) ControlsManager._persist(presetId, values);
          if (typeof onChange === 'function') {
            onChange(field.id, null, { type: mediaKind, url: null, cleared: true });
          }
        });

        // hydrate initial preview from indexeddb ref or inline url
        if (typeof currentVal === 'string' && currentVal) {
          if (currentVal.startsWith('idb://') && typeof window !== 'undefined' && window.projectBundleService) {
            const parsed = window.projectBundleService.parseIdbRef(currentVal);
            const targetPid = parsed?.presetId || presetId;
            const targetSlot = parsed?.slotId || field.id;
            window.projectBundleService.getSlotMedia(targetPid, targetSlot).then((rec) => {
              if (rec?.objectUrl) applyPreview(rec.objectUrl, rec.name);
            }).catch(() => { });
          } else {
            applyPreview(currentVal, field.name || `${mediaKind} asset`);
          }
        } else if (typeof window !== 'undefined' && window.projectBundleService) {
          window.projectBundleService.getSlotMedia(presetId, field.id).then((rec) => {
            if (rec?.objectUrl) {
              values[field.id] = window.projectBundleService.makeIdbRef(presetId, field.id);
              applyPreview(rec.objectUrl, rec.name);
            }
          }).catch(() => { });
        }

        wrap.appendChild(header);
        wrap.appendChild(dropzone);
        return wrap;
      }

      if (field.type === 'media_pool') {
        return ControlsManager._buildMediaPoolNode(field, currentVal, values, presetId, isStarter, onChange);
      }

      return null;
    }

    static _buildMediaPoolNode(field, currentVal, values, presetId, isStarter, onChange) {
      const acceptMode = field.accept === 'image' || field.accept === 'video' ? field.accept : 'any';
      const acceptAttr = acceptMode === 'image'
        ? 'image/*,.png,.svg,.webp,.gif'
        : acceptMode === 'video'
          ? 'video/*,.mp4,.webm,.mov'
          : 'image/*,video/*,.png,.svg,.webp,.gif,.mp4,.webm,.mov';

      const normalizeList = (raw) => {
        const helper = typeof window !== 'undefined' ? window.MediaPoolHelper : null;
        if (helper?.normalizePoolItems) return helper.normalizePoolItems(raw);
        return Array.isArray(raw) ? raw.filter((x) => x && typeof x === 'object' && x.src) : [];
      };

      let items = normalizeList(Array.isArray(currentVal) ? currentVal : values[field.id]);
      values[field.id] = items;

      const wrap = document.createElement('div');
      wrap.className = 'media-pool-control';

      const header = document.createElement('div');
      header.className = 'media-pool-header';

      const titleWrap = document.createElement('div');
      titleWrap.className = 'media-pool-title-wrap';
      const titleEl = document.createElement('span');
      titleEl.className = 'media-pool-label';
      titleEl.textContent = field.label || field.id;
      const countEl = document.createElement('span');
      countEl.className = 'media-pool-count';
      titleWrap.appendChild(titleEl);
      titleWrap.appendChild(countEl);

      const headerActions = document.createElement('div');
      headerActions.className = 'media-pool-actions';

      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className = 'btn-inline';
      allBtn.textContent = 'all';
      allBtn.title = 'enable all items';

      const noneBtn = document.createElement('button');
      noneBtn.type = 'button';
      noneBtn.className = 'btn-inline';
      noneBtn.textContent = 'none';
      noneBtn.title = 'disable all items';

      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'btn-inline';
      expandBtn.textContent = 'expand';
      expandBtn.title = 'open larger gallery view';

      headerActions.appendChild(allBtn);
      headerActions.appendChild(noneBtn);
      headerActions.appendChild(expandBtn);
      header.appendChild(titleWrap);
      header.appendChild(headerActions);

      const toolbar = document.createElement('div');
      toolbar.className = 'media-pool-toolbar';

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.id = `ctrl_${field.id}`;
      fileInput.accept = acceptAttr;
      fileInput.multiple = true;
      fileInput.hidden = true;

      const uploadBtn = document.createElement('button');
      uploadBtn.type = 'button';
      uploadBtn.className = 'btn btn-secondary btn-sm media-pool-add-btn';
      uploadBtn.textContent = acceptMode === 'image' ? '+ add images' : acceptMode === 'video' ? '+ add clips' : '+ add media';

      const addClipsBtn = document.createElement('button');
      addClipsBtn.type = 'button';
      addClipsBtn.className = 'btn btn-ghost btn-sm media-pool-clips-btn';
      addClipsBtn.textContent = '+ from clips';
      addClipsBtn.title = 'add selected clips from the clips panel into this pool';
      addClipsBtn.hidden = acceptMode === 'image';

      toolbar.appendChild(uploadBtn);
      toolbar.appendChild(addClipsBtn);
      toolbar.appendChild(fileInput);

      const grid = document.createElement('div');
      grid.className = 'pool-gallery-grid';
      grid.setAttribute('aria-label', `${field.label || field.id} gallery`);

      let modalGrid = null;
      let modalCountEl = null;
      let modalFilterInput = null;

      const commit = () => {
        values[field.id] = items;
        if (isStarter) ControlsManager._persist(presetId, values);
        if (typeof onChange === 'function') {
          onChange(field.id, items, { type: 'media_pool' });
        }
        renderGrids();
      };

      const hydrateMediaEl = (mediaEl, item) => {
        if (!item?.src) return;
        if (item.src.startsWith('idb://') && typeof window !== 'undefined' && window.projectBundleService) {
          const parsed = window.projectBundleService.parseIdbRef(item.src);
          const targetPid = parsed?.presetId || presetId;
          const targetSlot = parsed?.slotId || `${field.id}__${item.id}`;
          window.projectBundleService.getSlotMedia(targetPid, targetSlot).then((rec) => {
            if (rec?.objectUrl) mediaEl.src = rec.objectUrl;
          }).catch(() => { });
        } else {
          mediaEl.src = item.src;
        }
      };

      const buildCard = (item) => {
        const card = document.createElement('label');
        card.className = 'pool-card';
        card.title = `${item.name} (${item.kind})`;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'pool-card-check';
        checkbox.checked = item.enabled !== false;
        checkbox.addEventListener('change', () => {
          item.enabled = checkbox.checked;
          commit();
        });

        let mediaEl;
        if (item.kind === 'video') {
          mediaEl = document.createElement('video');
          mediaEl.className = 'pool-card-thumb pool-card-video';
          mediaEl.muted = true;
          mediaEl.loop = true;
          mediaEl.playsInline = true;
          mediaEl.preload = 'metadata';
          card.addEventListener('mouseenter', () => { mediaEl.play().catch(() => { }); });
          card.addEventListener('mouseleave', () => { try { mediaEl.pause(); } catch { } });
        } else {
          mediaEl = document.createElement('img');
          mediaEl.className = 'pool-card-thumb';
          mediaEl.alt = '';
          mediaEl.loading = 'lazy';
        }
        hydrateMediaEl(mediaEl, item);

        const nameEl = document.createElement('span');
        nameEl.className = 'pool-card-name';
        nameEl.textContent = item.name || item.id;

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'pool-card-delete';
        delBtn.setAttribute('aria-label', `remove ${item.name || item.id}`);
        delBtn.title = 'remove from pool';
        delBtn.textContent = '×';
        delBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (typeof item.src === 'string' && item.src.startsWith('idb://') && typeof window !== 'undefined' && window.projectBundleService) {
            const parsed = window.projectBundleService.parseIdbRef(item.src);
            if (parsed?.slotId) {
              await window.projectBundleService.deleteSlotMedia(parsed.presetId || presetId, parsed.slotId).catch(() => { });
            }
          }
          items = items.filter((entry) => entry.id !== item.id);
          commit();
        });

        card.appendChild(checkbox);
        card.appendChild(mediaEl);
        card.appendChild(nameEl);
        card.appendChild(delBtn);
        return card;
      };

      const renderInto = (targetGrid, queryText = '') => {
        if (!targetGrid) return;
        targetGrid.innerHTML = '';
        const q = queryText.trim().toLowerCase();
        const visible = q ? items.filter((it) => (it.name || '').toLowerCase().includes(q)) : items;
        if (!visible.length) {
          const empty = document.createElement('div');
          empty.className = 'pool-gallery-empty';
          empty.textContent = items.length
            ? 'no items match filter'
            : (acceptMode === 'image' ? 'drop images or ask viz to generate items' : 'drop images/clips or ask viz to populate');
          targetGrid.appendChild(empty);
          return;
        }
        visible.forEach((it) => targetGrid.appendChild(buildCard(it)));
      };

      const renderGrids = () => {
        const activeCount = items.filter((it) => it.enabled !== false).length;
        const summary = `${activeCount}/${items.length}`;
        countEl.textContent = summary;
        if (modalCountEl) modalCountEl.textContent = summary;
        renderInto(grid);
        if (modalGrid) renderInto(modalGrid, modalFilterInput?.value || '');
      };

      const addFiles = async (fileList) => {
        const files = Array.from(fileList || []).filter((f) => {
          const t = (f.type || '').toLowerCase();
          const n = (f.name || '').toLowerCase();
          const isImg = t.startsWith('image/') || /\.(png|svg|webp|gif|jpe?g)$/.test(n);
          const isVid = t.startsWith('video/') || /\.(mp4|webm|mov)$/.test(n);
          if (acceptMode === 'image') return isImg;
          if (acceptMode === 'video') return isVid;
          return isImg || isVid;
        });
        if (!files.length) return;

        const bundleSvc = typeof window !== 'undefined' ? window.projectBundleService : null;
        for (const file of files) {
          const isVid = (file.type || '').startsWith('video/') || /\.(mp4|webm|mov)$/i.test(file.name || '');
          const kind = isVid ? 'video' : 'image';
          const itemId = `item_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          const slotId = `${field.id}__${itemId}`;
          let src = null;
          if (bundleSvc && typeof bundleSvc.saveSlotMedia === 'function') {
            const saved = await bundleSvc.saveSlotMedia(presetId, slotId, file, {
              kind,
              name: file.name,
              mimeType: file.type
            });
            src = saved?.idbRef || saved?.objectUrl || null;
          }
          if (!src) src = URL.createObjectURL(file);
          const cleanName = (file.name || itemId).replace(/\.[^.]+$/, '');
          items = [...items, { id: itemId, name: cleanName, kind, src, enabled: true, mimeType: file.type || (kind === 'video' ? 'video/mp4' : 'image/png') }];
        }
        commit();
      };

      const addClipObjects = (clipsList) => {
        if (!Array.isArray(clipsList) || !clipsList.length || acceptMode === 'image') return;
        const existingSrcs = new Set(items.map((it) => it.src));
        let changed = false;
        for (const clip of clipsList) {
          const url = clip?.url || (clip?.remoteUrl ? `/api/clips/stream?url=${encodeURIComponent(clip.remoteUrl)}` : null);
          if (!url || existingSrcs.has(url)) continue;
          existingSrcs.add(url);
          items = [
            ...items,
            {
              id: `clip_${clip.id || Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
              name: String(clip.title || clip.id || 'clip'),
              kind: 'video',
              src: url,
              enabled: true
            }
          ];
          changed = true;
        }
        if (changed) commit();
      };

      const bindDropTarget = (el) => {
        el.addEventListener('dragover', (e) => {
          e.preventDefault();
          el.classList.add('dragover');
        });
        el.addEventListener('dragleave', () => {
          el.classList.remove('dragover');
        });
        el.addEventListener('drop', async (e) => {
          e.preventDefault();
          el.classList.remove('dragover');
          const clipJson = e.dataTransfer?.getData('application/x-samplevis-clip');
          if (clipJson) {
            try {
              const clip = JSON.parse(clipJson);
              addClipObjects([clip]);
              return;
            } catch { }
          }
          if (e.dataTransfer?.files?.length) {
            await addFiles(e.dataTransfer.files);
          }
        });
      };

      bindDropTarget(grid);

      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async (e) => {
        await addFiles(e.target.files);
        e.target.value = '';
      });

      addClipsBtn.addEventListener('click', () => {
        const selected = window.samplevisClipPool?.getSelectedClips?.() || [];
        const fallback = window.samplevisClipPool?.getAllClips?.() || [];
        const source = selected.length ? selected : fallback.slice(0, 4);
        addClipObjects(source);
      });

      allBtn.addEventListener('click', () => {
        items = items.map((it) => ({ ...it, enabled: true }));
        commit();
      });
      noneBtn.addEventListener('click', () => {
        items = items.map((it) => ({ ...it, enabled: false }));
        commit();
      });

      expandBtn.addEventListener('click', () => {
        const dlgId = `mediaPoolDialog_${field.id}`;
        let dlg = document.getElementById(dlgId);
        if (dlg) dlg.remove();

        dlg = document.createElement('dialog');
        dlg.id = dlgId;
        dlg.className = 'media-pool-dialog';
        dlg.setAttribute('closedby', 'any');
        dlg.setAttribute('aria-labelledby', `${dlgId}_title`);

        const dlgHeader = document.createElement('div');
        dlgHeader.className = 'media-pool-dialog-header';

        const dlgTitleWrap = document.createElement('div');
        dlgTitleWrap.className = 'media-pool-title-wrap';
        const dlgTitle = document.createElement('h3');
        dlgTitle.id = `${dlgId}_title`;
        dlgTitle.textContent = field.label || field.id;
        modalCountEl = document.createElement('span');
        modalCountEl.className = 'media-pool-count';
        dlgTitleWrap.appendChild(dlgTitle);
        dlgTitleWrap.appendChild(modalCountEl);

        const closeForm = document.createElement('form');
        closeForm.method = 'dialog';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn btn-secondary btn-sm';
        closeBtn.value = 'close';
        closeBtn.textContent = 'done';
        closeBtn.autofocus = true;
        closeForm.appendChild(closeBtn);

        dlgHeader.appendChild(dlgTitleWrap);
        dlgHeader.appendChild(closeForm);

        const dlgBar = document.createElement('div');
        dlgBar.className = 'media-pool-dialog-bar';

        modalFilterInput = document.createElement('input');
        modalFilterInput.type = 'search';
        modalFilterInput.className = 'clip-query-input';
        modalFilterInput.placeholder = 'filter items...';
        modalFilterInput.setAttribute('aria-label', 'filter pool items');
        modalFilterInput.addEventListener('input', () => renderInto(modalGrid, modalFilterInput.value));

        const dlgUploadBtn = document.createElement('button');
        dlgUploadBtn.type = 'button';
        dlgUploadBtn.className = 'btn btn-secondary btn-sm';
        dlgUploadBtn.textContent = uploadBtn.textContent;
        dlgUploadBtn.addEventListener('click', () => fileInput.click());

        const dlgClipsBtn = document.createElement('button');
        dlgClipsBtn.type = 'button';
        dlgClipsBtn.className = 'btn btn-ghost btn-sm';
        dlgClipsBtn.textContent = '+ from clips';
        dlgClipsBtn.hidden = acceptMode === 'image';
        dlgClipsBtn.addEventListener('click', () => addClipsBtn.click());

        const dlgAllBtn = document.createElement('button');
        dlgAllBtn.type = 'button';
        dlgAllBtn.className = 'btn-inline';
        dlgAllBtn.textContent = 'all';
        dlgAllBtn.addEventListener('click', () => allBtn.click());

        const dlgNoneBtn = document.createElement('button');
        dlgNoneBtn.type = 'button';
        dlgNoneBtn.className = 'btn-inline';
        dlgNoneBtn.textContent = 'none';
        dlgNoneBtn.addEventListener('click', () => noneBtn.click());

        dlgBar.appendChild(modalFilterInput);
        dlgBar.appendChild(dlgUploadBtn);
        dlgBar.appendChild(dlgClipsBtn);
        dlgBar.appendChild(dlgAllBtn);
        dlgBar.appendChild(dlgNoneBtn);

        modalGrid = document.createElement('div');
        modalGrid.className = 'pool-gallery-grid pool-gallery-grid-lg';
        bindDropTarget(modalGrid);

        dlg.appendChild(dlgHeader);
        dlg.appendChild(dlgBar);
        dlg.appendChild(modalGrid);

        if (!('closedBy' in HTMLDialogElement.prototype)) {
          const outside = (e) => {
            const r = dlg.getBoundingClientRect();
            return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
          };
          let pressedOutside = false;
          dlg.addEventListener('pointerdown', (e) => { pressedOutside = outside(e); });
          dlg.addEventListener('pointerup', (e) => { if (pressedOutside && outside(e)) dlg.close(); });
        }

        dlg.addEventListener('close', () => {
          dlg.returnValue = '';
          modalGrid = null;
          modalCountEl = null;
          modalFilterInput = null;
          dlg.remove();
        });

        document.body.appendChild(dlg);
        renderInto(modalGrid);
        modalCountEl.textContent = countEl.textContent;
        dlg.showModal();
      });

      renderGrids();
      wrap.appendChild(header);
      wrap.appendChild(toolbar);
      wrap.appendChild(grid);
      return wrap;
    }

    static _groupFields(fields, declaredSections) {
      const sectionMetaByKey = new Map();
      if (Array.isArray(declaredSections)) {
        declaredSections.forEach((sec, idx) => {
          if (!sec) return;
          const label = String(sec.label || sec.title || sec.id || `section ${idx + 1}`).trim();
          const id = sec.id ? String(sec.id) : slugifySectionId(label, idx);
          const defaultOpen = sec.collapsed !== undefined ? !sec.collapsed : (sec.open !== undefined ? Boolean(sec.open) : true);
          const meta = { id, label, defaultOpen };
          sectionMetaByKey.set(id.toLowerCase(), meta);
          sectionMetaByKey.set(label.toLowerCase(), meta);
        });
      }

      const hasExplicitSections =
        (Array.isArray(declaredSections) && declaredSections.length > 0) ||
        fields.some((f) => f && (f.type === 'section' || f.section || f.group || f.category));

      if (hasExplicitSections) {
        const groups = [];
        const groupMap = new Map();
        const ensureGroup = (key, title, defaultOpen = true) => {
          const normKey = String(key || title || 'general').toLowerCase();
          if (groupMap.has(normKey)) return groupMap.get(normKey);
          const declared = sectionMetaByKey.get(normKey);
          const group = {
            id: declared?.id || slugifySectionId(key || title, groups.length),
            title: declared?.label || title || 'general',
            defaultOpen: declared ? declared.defaultOpen : defaultOpen,
            fields: []
          };
          groupMap.set(normKey, group);
          groups.push(group);
          return group;
        };

        let activeDivider = null;
        fields.forEach((field) => {
          if (!field) return;
          if (field.type === 'section') {
            const label = String(field.label || field.title || field.id || 'controls').trim();
            const secId = field.id || slugifySectionId(label, groups.length);
            const openFlag = field.collapsed !== undefined
              ? !field.collapsed
              : (field.open !== undefined ? Boolean(field.open) : true);
            activeDivider = ensureGroup(secId, label, openFlag);
            if (field.collapsed !== undefined || field.open !== undefined) {
              activeDivider.defaultOpen = openFlag;
            }
            return;
          }

          const explicitTag = field.section || field.group || field.category;
          if (explicitTag) {
            const targetGroup = ensureGroup(explicitTag, String(explicitTag).trim(), field.sectionCollapsed ? false : true);
            targetGroup.fields.push(field);
          } else if (activeDivider) {
            activeDivider.fields.push(field);
          } else {
            const fallbackGroup = ensureGroup('general', 'general', true);
            fallbackGroup.fields.push(field);
          }
        });

        const nonEmpty = groups.filter((g) => g.fields.length > 0);
        return { useSections: nonEmpty.length >= 1, groups: nonEmpty };
      }

      const controlFields = fields.filter((f) => f && f.id && f.type !== 'section');
      if (controlFields.length >= 7) {
        const buckets = new Map([
          ['shader & optics', { id: 'shader_optics', title: 'shader & optics', defaultOpen: true, fields: [] }],
          ['colors & palette', { id: 'colors_palette', title: 'colors & palette', defaultOpen: true, fields: [] }],
          ['overlay & motion', { id: 'overlay_motion', title: 'overlay & motion', defaultOpen: true, fields: [] }]
        ]);

        controlFields.forEach((field) => {
          if (field.type === 'color') {
            buckets.get('colors & palette').fields.push(field);
          } else if (field.target === 'shader_uniform') {
            buckets.get('shader & optics').fields.push(field);
          } else {
            buckets.get('overlay & motion').fields.push(field);
          }
        });

        const nonEmpty = Array.from(buckets.values()).filter((b) => b.fields.length > 0);
        if (nonEmpty.length >= 2) {
          return { useSections: true, groups: nonEmpty };
        }
      }

      return { useSections: false, groups: [] };
    }

    /**
     * Static wiring audit: a control can look right in the inspector and never reach the GPU. These
     * are the failures that produce "the slider does nothing" without an error anywhere.
     */
    static auditWiring(preset) {
      const fields = Array.isArray(preset?.controlsBox?.fields) ? preset.controlsBox.fields : [];
      const shader = String(preset?.shaderBox?.fragmentShader || '');
      const postShader = String(preset?.shaderBox?.postShader || '');
      const issues = [];
      if (fields.length === 0) return issues;
      const overlay = [preset?.frontUiBox?.initScript, preset?.frontUiBox?.drawScript]
        .filter((source) => typeof source === 'string' && source.trim())
        .join('\n');
      // a preset may hand the whole bag to a helper instead of naming each key
      const overlayReadsAll = /Object\.(keys|values|entries)\s*\(\s*(frame\.)?controls\b|\.\.\.\s*(frame\.)?controls\b/.test(overlay);
      const escapeId = (id) => String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const declIn = (source, id) => (source
        ? source.match(new RegExp(`uniform\\s+(\\w+)\\s+${escapeId(id)}\\b`))
        : null);
      for (const field of fields) {
        if (!field || !field.id || field.type === 'section') continue;
        // read by the engine's bloom prefilter, not uploaded as a shader uniform
        if (field.id === 'u_bloom_threshold') continue;
        // layer 1 and layer 3 are separate programs; a control is wired if either declares it
        const declLayer1 = declIn(shader, field.id);
        const declPost = declIn(postShader, field.id);
        const declared = Boolean(declLayer1 || declPost);
        const targetsShader = field.target === 'shader_uniform' || field.target === 'both';
        if (!targetsShader) {
          if (declared) {
            issues.push({ id: field.id, reason: 'not_targeted', message: 'uniform is declared in the shader but this control only targets the overlay' });
            continue;
          }
          if (!overlay || overlayReadsAll) continue;
          // media ids are read through frame.assets instead of frame.controls, so absence proves
          // nothing; the engine also owns the studio toggles and reads them by name
          if (field.type === 'image' || field.type === 'video' || field.type === 'media_pool') continue;
          if (ENGINE_CONTROL_IDS.has(field.id)) continue;
          const mentioned = new RegExp(`(^|[^A-Za-z0-9_$])${escapeId(field.id)}([^A-Za-z0-9_$]|$)`).test(overlay);
          if (!mentioned) {
            issues.push({
              id: field.id,
              reason: 'unused',
              message: 'no drawScript or initScript mentions this id, so the control cannot change the frame — read it from frame.controls or drop the field'
            });
          }
          continue;
        }
        if (field.type !== 'slider' && field.type !== 'toggle' && field.type !== 'color') {
          issues.push({ id: field.id, reason: 'unsupported_type', message: `${field.type} controls cannot drive a shader uniform; use slider, toggle or color` });
          continue;
        }
        if (!shader && !postShader) continue;
        if (!declared) {
          issues.push({ id: field.id, reason: 'missing_uniform', message: `neither shader declares "uniform ... ${field.id}" — ids must match exactly, including any u_ prefix` });
          continue;
        }
        const expected = field.type === 'color' ? 'vec3' : 'float';
        // the same id typed differently in the two programs would take the upload in one and not
        // the other, which looks like a control that only half works
        if (declLayer1 && declPost && declLayer1[1] !== declPost[1]) {
          issues.push({ id: field.id, reason: 'conflicting_types', message: `fragmentShader declares ${declLayer1[1]}, postShader declares ${declPost[1]}` });
          continue;
        }
        if (declLayer1 && declLayer1[1] !== expected) {
          issues.push({ id: field.id, reason: 'type_mismatch', message: `fragmentShader declares ${declLayer1[1]}, this ${field.type} uploads ${expected}` });
          continue;
        }
        if (declPost && declPost[1] !== expected) {
          issues.push({ id: field.id, reason: 'type_mismatch', message: `postShader declares ${declPost[1]}, this ${field.type} uploads ${expected}` });
        }
      }
      return issues;
    }

    static _decorateWiringIssue(node, issue) {
      if (!node || !issue) return;
      node.classList.add('has-wiring-issue');
      node.dataset.wiringIssue = issue.message;
      if (node.querySelector(':scope > .control-wiring-badge')) return;
      const badge = document.createElement('span');
      badge.className = 'control-wiring-badge';
      badge.textContent = issue.reason === 'unused' ? 'unused' : 'unwired';
      badge.title = issue.message;
      node.appendChild(badge);
      if (!node.title) node.title = issue.message;
    }

    // filled in after the engine has drawn a frame: a uniform can be declared and still be optimized
    // out, which the static audit cannot see
    static markDeadUniforms(container, ids) {
      if (!container || !Array.isArray(ids) || ids.length === 0) return;
      const dead = new Set(ids.filter(Boolean));
      if (dead.size === 0) return;
      container.querySelectorAll('[data-control-id]').forEach((node) => {
        if (!dead.has(node.dataset.controlId)) return;
        ControlsManager._decorateWiringIssue(node, {
          id: node.dataset.controlId,
          reason: 'unused',
          message: 'declared in the shader but never read (optimized out), so the value has no effect'
        });
      });
    }

    static render(container, preset, onChange) {
      if (!container || !preset || !preset.controlsBox) return;

      const fields = preset.controlsBox.fields || [];
      if (!preset.controlsBox.values || typeof preset.controlsBox.values !== 'object') {
        preset.controlsBox.values = {};
      }
      const values = preset.controlsBox.values;
      const presetId = preset.id || preset.meta?.name || 'default';
      const isStarter = Boolean(
        (typeof window !== 'undefined' && (window.STARTER_PRESET_DEFINITIONS?.[presetId] || window.STARTER_PRESETS?.[presetId]))
      );

      // built-in starter presets remember knob tweaks in localstorage; user-saved presets open exact saved values
      if (isStarter && typeof localStorage !== 'undefined') {
        try {
          const saved = localStorage.getItem(`samplevis_preset_${presetId}`);
          if (saved) {
            const parsed = JSON.parse(saved);
            Object.assign(values, parsed);
          }
        } catch (e) {
          console.warn('Could not restore preset controls from localStorage', e);
        }
      }

      fields.forEach((field) => {
        if (field && field.id && field.type !== 'section' && values[field.id] === undefined && field.defaultValue !== undefined) {
          values[field.id] = field.defaultValue;
        }
      });

      container.innerHTML = '';

      const wiringIssues = ControlsManager.auditWiring(preset);
      const wiringMap = new Map(wiringIssues.map((issue) => [issue.id, issue]));
      if (wiringIssues.length > 0) {
        const note = document.createElement('div');
        note.className = 'control-wiring-note';
        note.textContent = `${wiringIssues.length} control${wiringIssues.length === 1 ? '' : 's'} not wired`;
        note.title = wiringIssues.map((issue) => `${issue.id}: ${issue.message}`).join('\n');
        container.appendChild(note);
      }

      const grouped = ControlsManager._groupFields(fields, preset.controlsBox.sections);
      if (grouped.useSections) {
        grouped.groups.forEach((group) => {
          const { details, body } = ControlsManager.createSectionElement({
            presetId,
            sectionId: group.id,
            title: group.title,
            count: group.fields.length,
            defaultOpen: group.defaultOpen
          });
          group.fields.forEach((field) => {
            const currentVal = values[field.id] !== undefined ? values[field.id] : field.defaultValue;
            const node = ControlsManager._buildFieldNode(field, currentVal, values, presetId, isStarter, onChange, preset);
            if (node) {
              node.dataset.controlId = field.id;
              ControlsManager._decorateWiringIssue(node, wiringMap.get(field.id));
              body.appendChild(node);
            }
          });
          container.appendChild(details);
        });
        ControlsManager.syncSectionHeaderActions(container, presetId);
        return;
      }

      fields.forEach((field) => {
        if (!field || field.type === 'section') return;
        const currentVal = values[field.id] !== undefined ? values[field.id] : field.defaultValue;
        const node = ControlsManager._buildFieldNode(field, currentVal, values, presetId, isStarter, onChange, preset);
        if (node) {
          node.dataset.controlId = field.id;
          ControlsManager._decorateWiringIssue(node, wiringMap.get(field.id));
          container.appendChild(node);
        }
      });
      ControlsManager.syncSectionHeaderActions(container, presetId);
    }

    static _persist(presetId, values) {
      if (typeof localStorage === 'undefined') return;
      try {
        localStorage.setItem(`samplevis_preset_${presetId}`, JSON.stringify(values));
      } catch (e) {
        // storage quota or private browsing
      }
    }
  }

  if (typeof window !== 'undefined') {
    window.ControlsManager = ControlsManager;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ControlsManager;
  }
})();
