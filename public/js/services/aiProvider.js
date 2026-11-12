// byok preset generator — stores api credentials in localstorage only
(function () {
  'use strict';

  const STORAGE_KEY_API_KEY = 'samplevis_byok_api_key';
  const STORAGE_KEY_BASE_URL = 'samplevis_byok_base_url';
  const STORAGE_KEY_MODEL = 'samplevis_byok_model';

  const DEFAULT_BASE_URL = 'https://api.deepinfra.com/v1/openai';
  const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3';

  class ByokAiProvider {
    static getSettings() {
      return {
        apiKey: localStorage.getItem(STORAGE_KEY_API_KEY) || '',
        baseUrl: localStorage.getItem(STORAGE_KEY_BASE_URL) || DEFAULT_BASE_URL,
        model: localStorage.getItem(STORAGE_KEY_MODEL) || DEFAULT_MODEL
      };
    }

    static saveSettings(settings) {
      if (!settings) return;
      if (settings.apiKey !== undefined) {
        localStorage.setItem(STORAGE_KEY_API_KEY, String(settings.apiKey).trim());
      }
      if (settings.baseUrl !== undefined) {
        localStorage.setItem(STORAGE_KEY_BASE_URL, String(settings.baseUrl).trim() || DEFAULT_BASE_URL);
      }
      if (settings.model !== undefined) {
        localStorage.setItem(STORAGE_KEY_MODEL, String(settings.model).trim() || DEFAULT_MODEL);
      }
    }

    static hasKey() {
      return Boolean(localStorage.getItem(STORAGE_KEY_API_KEY));
    }

    static async generatePreset(prompt, currentPreset, projectContext) {
      const settings = ByokAiProvider.getSettings();
      if (!settings.apiKey) {
        throw new Error('API key required. Please open AI Settings to configure your key.');
      }

      const systemPrompt = `You are Viz, the embedded visual designer AI inside SampleVis.
Your sole job is to generate or modify portable 3-Box ReelPreset JSON objects for audio/MIDI music visualizers.
Return strictly valid JSON conforming to this schema:
{
  "version": "1.0",
  "meta": {
    "name": string,
    "description": string,
    "aspectRatio": "9:16" | "16:9" | "1:1"
  },
  "modules": {
    "clips": { "enabled": boolean, "startAtDrop": boolean },
    "midiTracks": { "enabled": boolean, "label": string }
  },
  "shaderBox": {
    "fragmentShader": string (valid GLSL ES 1.00 fragment shader)
  },
  "frontUiBox": {
    "initScript": string (JavaScript executed once: (project, state, controls) => void),
    "drawScript": string (JavaScript executed at 60 FPS: (ctx, width, height, frame, state) => void)
  },
  "controlsBox": {
    "fields": Array<{
      "id": string,
      "target": "shader_uniform" | "overlay_control" | "both",
      "label": string,
      "type": "slider" | "color" | "toggle" | "select",
      "defaultValue": number | string | boolean,
      "min"?: number,
      "max"?: number,
      "step"?: number,
      "options"?: string[]
    }>,
    "values": Record<string, any>
  }
}

PRE-WIRED RUNTIME HOOKS (use directly instead of writing DSP/parsers):
- GLSL Uniforms: u_time (float), u_resolution (vec2), u_bass (float), u_mid (float), u_high (float), u_rms (float), u_fft (sampler2D), u_has_midi (float), u_bpm (float), u_note_hit (float), u_chord_hit (float 0..1 spike on chord changes), u_active_pitch (float), u_video_tex (sampler2D), u_has_video (float), plus any field in controlsBox with target "shader_uniform" or "both" (colors become vec3 RGB 0..1).
- FrameContext in drawScript:
  - frame.audio: { time, duration, progress, bass, mid, high, rms, fft, waveform }
  - frame.chord: { name, root, time } (proven bar-level harmonic chord detection, e.g. "Bmaj7")
  - frame.midi: { hasMidi, bpm, allNotes, activeNotes, triggeredNotes }
  - frame.project: { title, artist, brand, sampleNumber, key, bpm, duration, dropBar, dropTime, chordTimelineMarkers }
  - frame.clips: { count, drawClip(ctx, idx, x, y, w, h, opts) } (automatically cover-fits 16:9 video without distortion)
  - frame.controls: Record<string, any> (live values from controlsBox)

CRITICAL RULES FOR VIZ:
1. NEVER duplicate studio clip controls (cutMode, speedRamping, clip search tags) inside controlsBox.fields. Enabling modules.clips automatically renders the studio Clips panel. Reserve controlsBox for visual aesthetics only (colors, intensities, scales).
2. Always adapt cleanly to both 9:16 and 16:9 using width, height, and u_resolution. When sampling u_video_tex in GLSL, use cover-fit UV math:
   float canvasAspect = u_resolution.x / u_resolution.y; float videoAspect = 16.0 / 9.0;
   vec2 uv = canvasAspect < videoAspect ? vec2((v_uv.x - 0.5) * (canvasAspect / videoAspect) + 0.5, v_uv.y) : vec2(v_uv.x, (v_uv.y - 0.5) * (videoAspect / canvasAspect) + 0.5);
3. Use u_chord_hit (not u_note_hit) for major glitches or transitions so fast melody notes don't cause chaotic flickering.
Return ONLY raw JSON, with no markdown code blocks.`;

      const userMessage = JSON.stringify({
        instruction: prompt,
        currentPreset: currentPreset || null,
        projectContext: {
          bpm: projectContext?.bpm || 120,
          key: projectContext?.key || '',
          hasMidi: Boolean(projectContext?.midi?.hasMidi),
          trackNames: projectContext?.midi?.tracks?.map((t) => t.name) || [],
          clipCount: projectContext?.clips?.count || 0,
          aspectRatio: projectContext?.aspectRatio || '9:16'
        }
      });

      const endpoint = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify({
          model: settings.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
          ],
          response_format: { type: 'json_object' },
          max_tokens: 3500,
          temperature: 0.3
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`AI request failed (${res.status}): ${errText}`);
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('AI returned an empty response');
      }

      try {
        const cleaned = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        return JSON.parse(cleaned);
      } catch (err) {
        throw new Error(`Could not parse AI response as valid JSON: ${err.message}`);
      }
    }
  }

  window.ByokAiProvider = ByokAiProvider;
})();

