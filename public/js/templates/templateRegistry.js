/**
 * template registry for samplevis studio
 * allows seamless switching between visual designs and 3-box reelpresets while preserving
 * audio, anime clip playback, cut modes, transport, and webcodecs export.
 */
class ReelPresetTemplateAdapter {
  constructor(preset) {
    this.id = preset.id;
    this.name = preset.meta?.name || preset.id;
    this.title = preset.meta?.title || preset.meta?.name || preset.id;
    this.subtitle = preset.meta?.description || '';
    this.tagline = preset.meta?.description || '';
    this.badge = preset.meta?.badge || 'preset';
    this.preset = preset;
    this.engine = null;
    this._project = null;
  }

  init(canvas, state) {
    if (!this.engine) {
      this.engine = new window.ReelEngine(canvas);
    }
    this.engine.loadPreset(this.preset);
    if (state && state.project) {
      this._project = state.project;
      this.engine.setProject(state.project);
    }
    if (state && state.aspectRatio) {
      this.engine.setAspectRatio(state.aspectRatio);
    }
    if (state && state.videoPool) {
      this.engine.setActiveVideos(state.videoPool);
    }
  }

  get params() {
    return this.preset?.controlsBox?.values || {};
  }

  get project() {
    return this.engine ? this.engine.project : this._project;
  }

  set project(p) {
    this._project = p;
    if (this.engine) this.engine.setProject(p);
  }

  get selectedTrackIds() {
    return this.engine ? this.engine.selectedTrackIds : new Set();
  }

  setProject(project) {
    this._project = project;
    if (this.engine) {
      this.engine.setProject(project);
    }
  }

  setAspectRatio(ratio) {
    if (this.engine) {
      this.engine.setAspectRatio(ratio);
    }
  }

  setActiveVideos(videos) {
    if (this.engine) {
      this.engine.setActiveVideos(videos);
    }
  }

  rebuildNoteNodes() {
    if (this.engine) {
      this.engine.rebuildNoteNodes();
    }
  }

  toggleTrack(trackId, enabled) {
    if (this.engine) {
      this.engine.toggleTrack(trackId, enabled);
    }
  }

  getSpeedRampInfo(time) {
    if (this.engine) {
      return this.engine.getSpeedRampInfo(time);
    }
    return { clipTime: time, instSpeed: 1.0 };
  }

  renderFrame(time, activeVid) {
    if (this.engine) {
      this.engine.renderFrame(time, activeVid);
    }
  }

  renderControls(container, onChange) {
    if (window.ControlsManager) {
      window.ControlsManager.render(container, this.preset, (key, value) => {
        if (typeof onChange === 'function') onChange(key, value);
      });
    }
  }

  cleanup() {
    // nothing heavy to clean
  }
}

class TemplateRegistry {
  constructor() {
    this.templates = new Map();
    this.activeTemplate = null;
    this.activeTemplateId = null;
    this.listeners = [];
  }

  register(template) {
    if (!template || !template.id) {
      console.error('Invalid template passed to register', template);
      return;
    }
    // don't overwrite 3-box presets with legacy class templates
    if (this.templates.has(template.id) && this.templates.get(template.id) instanceof ReelPresetTemplateAdapter) {
      return;
    }
    this.templates.set(template.id, template);
  }

  registerPreset(preset) {
    if (!preset || !preset.id) return;
    this.register(new ReelPresetTemplateAdapter(preset));
  }

  getAll() {
    return Array.from(this.templates.values());
  }

  get(id) {
    return this.templates.get(id);
  }

  async setTemplate(id, canvas, state, controlsContainer) {
    const next = this.templates.get(id);
    if (!next) {
      console.warn(`Template "${id}" not found. Falling back to default.`);
      return this.activeTemplate;
    }

    if (this.activeTemplate && this.activeTemplate !== next) {
      if (typeof this.activeTemplate.cleanup === 'function') {
        this.activeTemplate.cleanup();
      }
    }

    // preserve universal studio params across templates
    const universalKeys = ['cutMode', 'speedRamping', 'dropGlitch', 'autoFrame'];
    if (this.activeTemplate && next.params) {
      for (const k of universalKeys) {
        if (this.activeTemplate.params && this.activeTemplate.params[k] !== undefined) {
          next.params[k] = this.activeTemplate.params[k];
        }
      }
    }

    // restore template-specific saved params from localstorage
    const saved = localStorage.getItem(`samplevis_preset_${id}`) || localStorage.getItem(`samplevis_template_${id}`);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        Object.assign(next.params, parsed);
      } catch (err) {
        console.warn('Could not restore template params', err);
      }
    }

    this.activeTemplate = next;
    this.activeTemplateId = id;
    localStorage.setItem('samplevis_active_template_id', id);

    // initialize template with canvas
    if (typeof next.init === 'function') {
      next.init(canvas, state);
    }

    if (state && state.project && typeof next.setProject === 'function') {
      next.setProject(state.project);
    }

    if (state && state.videoPool && typeof next.setActiveVideos === 'function') {
      next.setActiveVideos(state.videoPool);
    }

    // render template-specific sidebar controls
    if (controlsContainer && typeof next.renderControls === 'function') {
      controlsContainer.innerHTML = '';
      next.renderControls(controlsContainer, (key, value) => {
        next.params[key] = value;
        try {
          localStorage.setItem(`samplevis_preset_${id}`, JSON.stringify(next.params));
        } catch (e) {}
      });
    }

    // notify listeners
    this.listeners.forEach((fn) => {
      try {
        fn(next);
      } catch (err) {
        console.error('Error in template change listener:', err);
      }
    });

    return next;
  }

  onTemplateChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
    }
  }
}

window.ReelPresetTemplateAdapter = ReelPresetTemplateAdapter;
window.templateRegistry = new TemplateRegistry();

// auto-register built-in starter presets if loaded
if (window.STARTER_PRESETS) {
  Object.values(window.STARTER_PRESETS).forEach((preset) => {
    window.templateRegistry.registerPreset(preset);
  });
}
