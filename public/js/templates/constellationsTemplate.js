/**
 * Constellations Template Wrapper
 * Wraps SampleVisualizer into the modular template architecture.
 */
(function () {
  function formatTimeOfDay(v) {
    if (v < 20) return 'deep night (blue/violet)';
    if (v < 40) return 'midnight (deep navy)';
    if (v < 60) return 'pre-dawn twilight';
    if (v < 80) return 'golden sunrise';
    return 'daylight glow';
  }

  class ConstellationsTemplate {
    constructor() {
      this.id = 'constellations';
      this.name = 'constellations';
      this.subtitle = 'shinkai celestial starfield';
      this.tagline = 'shinkai needle starbursts · celestial band drift · 3-stage dynamic sky';
      this.badge = 'signature';
      this.visualizer = null;
      this.params = {};
    }

    init(canvas, state) {
      if (!this.visualizer) {
        this.visualizer = new window.SampleVisualizer(canvas);
      }
      this.params = this.visualizer.params;
      if (state && state.project) {
        this.visualizer.setProject(state.project);
      }
    }

    get project() {
      return this.visualizer ? this.visualizer.project : null;
    }

    get selectedTrackIds() {
      return this.visualizer ? this.visualizer.selectedTrackIds : new Set();
    }

    setProject(project) {
      if (this.visualizer) {
        this.visualizer.setProject(project);
      }
    }

    rebuildNoteNodes() {
      if (this.visualizer) {
        this.visualizer.rebuildNoteNodes();
      }
    }

    toggleTrack(trackId, enabled) {
      if (this.visualizer) {
        this.visualizer.toggleTrack(trackId, enabled);
      }
    }

    getSpeedRampInfo(time) {
      if (this.visualizer && typeof this.visualizer.getSpeedRampInfo === 'function') {
        return this.visualizer.getSpeedRampInfo(time);
      }
      return { clipTime: time, instSpeed: 1.0 };
    }

    renderFrame(time, activeVid) {
      if (this.visualizer) {
        this.visualizer.renderFrame(time, activeVid);
      }
    }

    cleanup() {
      // Nothing heavy to cleanup
    }

    renderControls(container, onChange) {
      const p = this.visualizer ? this.visualizer.params : {};
      const timeOfDayVal = p.timeOfDay !== undefined ? p.timeOfDay : 25;
      const sunsetDropChecked = Boolean(p.sunsetDropTransition);
      const driftVal = p.driftSpeed !== undefined ? p.driftSpeed : 1.0;
      const linkDistVal = p.linkDistance !== undefined ? p.linkDistance : 220;
      const bloomVal = Math.round((p.bloomIntensity !== undefined ? p.bloomIntensity : 0.88) * 100);
      const animeOpVal = Math.round((p.animeOpacity !== undefined ? p.animeOpacity : 0.62) * 100);
      const motionVal = p.cameraMotion !== undefined ? p.cameraMotion : 1.0;

      container.innerHTML = `
        <div class="slider-group">
          <div class="slider-row">
            <label for="sliderTimeOfDay">time of day (sky palette)</label>
            <span class="slider-val" id="valTimeOfDay">${formatTimeOfDay(timeOfDayVal)}</span>
          </div>
          <input type="range" id="sliderTimeOfDay" min="0" max="100" step="1" value="${timeOfDayVal}" />
          <div class="speedramp-row" style="margin-top: 6px; margin-bottom: 12px;">
            <label class="speedramp-label" for="sunsetDropToggle">
              <input type="checkbox" id="sunsetDropToggle" ${sunsetDropChecked ? 'checked' : ''} />
              <span class="speedramp-text">sunset drop transition</span>
              <span class="speedramp-subtext">· morph sky to sunset on drop lift</span>
            </label>
          </div>

          <div class="slider-row">
            <label for="sliderDrift">organic star drift</label>
            <span class="slider-val" id="valDrift">${driftVal.toFixed(1)}x</span>
          </div>
          <input type="range" id="sliderDrift" min="0.2" max="2.5" step="0.1" value="${driftVal}" />

          <div class="slider-row">
            <label for="sliderLinkDist">constellation link span</label>
            <span class="slider-val" id="valLinkDist">${linkDistVal}px</span>
          </div>
          <input type="range" id="sliderLinkDist" min="90" max="380" step="10" value="${linkDistVal}" />

          <div class="slider-row">
            <label for="sliderBloom">star bloom &amp; golden warmth</label>
            <span class="slider-val" id="valBloom">${bloomVal}%</span>
          </div>
          <input type="range" id="sliderBloom" min="20" max="100" step="4" value="${bloomVal}" />

          <div class="slider-row">
            <label for="sliderAnimeOpacity">anime sky blend opacity</label>
            <span class="slider-val" id="valAnimeOpacity">${animeOpVal}%</span>
          </div>
          <input type="range" id="sliderAnimeOpacity" min="20" max="95" step="5" value="${animeOpVal}" />

          <div class="slider-row">
            <label for="sliderMotion">cinematic camera sway &amp; shake</label>
            <span class="slider-val" id="valMotion">${motionVal.toFixed(1)}x</span>
          </div>
          <input type="range" id="sliderMotion" min="0" max="2.0" step="0.1" value="${motionVal}" />
        </div>
      `;

      // Attach events
      const sliderTod = container.querySelector('#sliderTimeOfDay');
      const valTod = container.querySelector('#valTimeOfDay');
      sliderTod.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        valTod.textContent = formatTimeOfDay(v);
        this.visualizer.params.timeOfDay = v;
        onChange('timeOfDay', v);
      });

      const sunsetToggle = container.querySelector('#sunsetDropToggle');
      sunsetToggle.addEventListener('change', (e) => {
        this.visualizer.params.sunsetDropTransition = e.target.checked;
        onChange('sunsetDropTransition', e.target.checked);
      });

      const sliderDrift = container.querySelector('#sliderDrift');
      const valDrift = container.querySelector('#valDrift');
      sliderDrift.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        valDrift.textContent = `${v.toFixed(1)}x`;
        this.visualizer.params.driftSpeed = v;
        onChange('driftSpeed', v);
      });

      const sliderLink = container.querySelector('#sliderLinkDist');
      const valLink = container.querySelector('#valLinkDist');
      sliderLink.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        valLink.textContent = `${v}px`;
        this.visualizer.params.linkDistance = v;
        onChange('linkDistance', v);
      });

      const sliderBloom = container.querySelector('#sliderBloom');
      const valBloom = container.querySelector('#valBloom');
      sliderBloom.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        valBloom.textContent = `${v}%`;
        this.visualizer.params.bloomIntensity = v / 100;
        onChange('bloomIntensity', v / 100);
      });

      const sliderAnime = container.querySelector('#sliderAnimeOpacity');
      const valAnime = container.querySelector('#valAnimeOpacity');
      sliderAnime.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        valAnime.textContent = `${v}%`;
        this.visualizer.params.animeOpacity = v / 100;
        onChange('animeOpacity', v / 100);
      });

      const sliderMotion = container.querySelector('#sliderMotion');
      const valMotion = container.querySelector('#valMotion');
      sliderMotion.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        valMotion.textContent = `${v.toFixed(1)}x`;
        this.visualizer.params.cameraMotion = v;
        onChange('cameraMotion', v);
      });
    }
  }

  window.templateRegistry.register(new ConstellationsTemplate());
})();

