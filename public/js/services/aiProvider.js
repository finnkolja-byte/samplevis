/**
 * AI Provider Service (BYOK Community Edition)
 *
 * Allows self-hosters to generate and modify ReelPresets using their personal
 * OpenAI-compatible API key (DeepInfra, OpenRouter, OpenAI, Groq, Ollama).
 * Keys are stored locally in the user's browser (localStorage) and never transmitted to external servers.
 */
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

      const systemPrompt = `You are a GLSL shader and Canvas 2D expert generating interactive audio/MIDI visualizer presets for SampleVis.
Return strictly valid JSON conforming to the ReelPreset schema:
{
  "version": "1.0",
  "meta": {
    "name": string,
    "description": string,
    "aspectRatio": "9:16" | "16:9" | "1:1"
  },
  "shaderBox": {
    "fragmentShader": string (valid GLSL fragment shader code)
  },
  "frontUiBox": {
    "initScript": string (JavaScript code executed once: (project, state, controls) => void),
    "drawScript": string (JavaScript code executed at 60 FPS: (ctx, width, height, frame, state) => void)
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
GLSL Uniforms available: u_time (float), u_resolution (vec2), u_bass (float), u_mid (float), u_high (float), u_rms (float), u_fft (sampler2D), u_has_midi (float), u_bpm (float), u_note_hit (float), u_active_pitch (float), u_video_tex (sampler2D), u_has_video (float), plus dynamic controls uniforms.
FrameContext available in drawScript: frame.audio, frame.midi, frame.clips.drawClip(ctx, idx, x, y, w, h), frame.controls.
Return ONLY raw JSON, with no markdown code blocks.`;

      const userMessage = JSON.stringify({
        instruction: prompt,
        currentPreset: currentPreset || null,
        projectContext: {
          bpm: projectContext?.bpm || 132,
          key: projectContext?.key || 'bmaj',
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
