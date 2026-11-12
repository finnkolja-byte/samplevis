// dynamic sidebar control builder for preset controlsBox schemas
(function () {
  'use strict';

  class ControlsManager {
    static render(container, preset, onChange) {
      if (!container || !preset || !preset.controlsBox) return;

      const fields = preset.controlsBox.fields || [];
      const values = preset.controlsBox.values || {};
      const presetId = preset.id || preset.meta?.name || 'default';

      // restore saved values from localstorage if available
      try {
        const saved = localStorage.getItem(`samplevis_preset_${presetId}`);
        if (saved) {
          const parsed = JSON.parse(saved);
          Object.assign(values, parsed);
        }
      } catch (e) {
        console.warn('Could not restore preset controls from localStorage', e);
      }

      container.innerHTML = '';

      fields.forEach((field) => {
        const currentVal = values[field.id] !== undefined ? values[field.id] : field.defaultValue;

        if (field.type === 'slider') {
          const group = document.createElement('div');
          group.className = 'slider-group';

          const row = document.createElement('div');
          row.className = 'slider-row';

          const label = document.createElement('label');
          label.htmlFor = `ctrl_${field.id}`;
          label.textContent = field.label;

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
            ControlsManager._persist(presetId, values);
            if (typeof onChange === 'function') onChange(field.id, v);
          });

          group.appendChild(row);
          group.appendChild(input);
          container.appendChild(group);

        } else if (field.type === 'toggle') {
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
          textSpan.textContent = field.label;

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
            ControlsManager._persist(presetId, values);
            if (typeof onChange === 'function') onChange(field.id, v);
          });

          row.appendChild(label);
          container.appendChild(row);

        } else if (field.type === 'color') {
          const row = document.createElement('div');
          row.className = 'slider-row';
          row.style.marginTop = '8px';
          row.style.marginBottom = '8px';

          const label = document.createElement('label');
          label.htmlFor = `ctrl_${field.id}`;
          label.textContent = field.label;

          const colorWrap = document.createElement('div');
          colorWrap.style.display = 'flex';
          colorWrap.style.alignItems = 'center';
          colorWrap.style.gap = '8px';

          const input = document.createElement('input');
          input.type = 'color';
          input.id = `ctrl_${field.id}`;
          input.value = String(currentVal || '#5e8a7d');
          input.style.border = 'none';
          input.style.background = 'transparent';
          input.style.cursor = 'pointer';
          input.style.width = '28px';
          input.style.height = '24px';

          const hexText = document.createElement('span');
          hexText.className = 'slider-val';
          hexText.textContent = String(input.value);

          input.addEventListener('input', (e) => {
            const v = e.target.value;
            values[field.id] = v;
            hexText.textContent = v;
            ControlsManager._persist(presetId, values);
            if (typeof onChange === 'function') onChange(field.id, v);
          });

          colorWrap.appendChild(input);
          colorWrap.appendChild(hexText);
          row.appendChild(label);
          row.appendChild(colorWrap);
          container.appendChild(row);

        } else if (field.type === 'select') {
          const row = document.createElement('div');
          row.className = 'slider-row';
          row.style.marginTop = '8px';
          row.style.marginBottom = '8px';

          const label = document.createElement('label');
          label.htmlFor = `ctrl_${field.id}`;
          label.textContent = field.label;

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
            ControlsManager._persist(presetId, values);
            if (typeof onChange === 'function') onChange(field.id, v);
          });

          row.appendChild(label);
          row.appendChild(select);
          container.appendChild(row);
        }
      });
    }

    static _persist(presetId, values) {
      try {
        localStorage.setItem(`samplevis_preset_${presetId}`, JSON.stringify(values));
      } catch (e) {
        // storage quota or private browsing
      }
    }
  }

  window.ControlsManager = ControlsManager;
})();
