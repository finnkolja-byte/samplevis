// byok preset generator — stores api credentials in localstorage only
(function () {
  'use strict';

  const STORAGE_KEY_PROVIDER = 'samplevis_byok_provider';
  const STORAGE_KEY_PROTOCOL = 'samplevis_byok_protocol';
  const STORAGE_KEY_API_KEY = 'samplevis_byok_api_key';
  const STORAGE_KEY_BASE_URL = 'samplevis_byok_base_url';
  const STORAGE_KEY_MODEL = 'samplevis_byok_model';
  const STORAGE_KEY_TEMPERATURE = 'samplevis_byok_temperature';
  const STORAGE_KEY_MAX_TOKENS = 'samplevis_byok_max_tokens';
  const STORAGE_KEY_JSON_MODE = 'samplevis_byok_json_mode';
  const STORAGE_KEY_EXTRA_HEADERS = 'samplevis_byok_extra_headers';

  const PROVIDER_PRESETS = {
    deepseek: {
      label: 'DeepSeek API',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      defaultModel: 'deepseek-chat',
      requiresKey: true,
      suggestedModels: [
        'deepseek-chat',
        'deepseek-reasoner'
      ]
    },
    deepinfra: {
      label: 'DeepInfra',
      protocol: 'openai',
      baseUrl: 'https://api.deepinfra.com/v1/openai',
      defaultModel: 'deepseek-ai/DeepSeek-V3',
      requiresKey: true,
      suggestedModels: [
        'deepseek-ai/DeepSeek-V3',
        'deepseek-ai/DeepSeek-R1',
        'Qwen/Qwen2.5-Coder-32B-Instruct'
      ]
    },
    openrouter: {
      label: 'OpenRouter',
      protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'deepseek/deepseek-chat',
      requiresKey: true,
      suggestedModels: [
        'deepseek/deepseek-chat',
        'anthropic/claude-sonnet-4',
        'google/gemini-2.5-flash',
        'openai/gpt-4o'
      ]
    },
    gemini: {
      label: 'Google Gemini API',
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      defaultModel: 'gemini-2.5-flash',
      requiresKey: true,
      suggestedModels: [
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-2.0-flash'
      ]
    },
    anthropic: {
      label: 'Anthropic Claude API',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      defaultModel: 'claude-sonnet-4-20250514',
      requiresKey: true,
      suggestedModels: [
        'claude-sonnet-4-20250514',
        'claude-3-5-haiku-20241022'
      ]
    },
    openai: {
      label: 'OpenAI API',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
      requiresKey: true,
      suggestedModels: [
        'gpt-4o',
        'gpt-4o-mini',
        'o3-mini'
      ]
    },
    custom: {
      label: 'Custom / Local Model (Ollama, LM Studio, vLLM)',
      protocol: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      defaultModel: 'qwen2.5-coder:14b',
      requiresKey: false,
      suggestedModels: [
        'qwen2.5-coder:14b',
        'deepseek-coder-v2',
        'llama3.2'
      ]
    }
  };

  function getSystemPrompt() {
    return `You are Viz, the embedded visual designer AI inside SampleVis.
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
  }

  function parseJsonResponse(rawText) {
    let cleaned = String(rawText || '').trim();
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
    return JSON.parse(cleaned);
  }

  function parseExtraHeaders(raw) {
    if (!raw || !raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  class ByokAiProvider {
    static getPresets() {
      return PROVIDER_PRESETS;
    }

    static getSettings() {
      const provider = localStorage.getItem(STORAGE_KEY_PROVIDER) || 'deepinfra';
      const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.deepinfra;
      return {
        provider,
        protocol: localStorage.getItem(STORAGE_KEY_PROTOCOL) || preset.protocol,
        apiKey: localStorage.getItem(STORAGE_KEY_API_KEY) || '',
        baseUrl: localStorage.getItem(STORAGE_KEY_BASE_URL) || preset.baseUrl,
        model: localStorage.getItem(STORAGE_KEY_MODEL) || preset.defaultModel,
        temperature: parseFloat(localStorage.getItem(STORAGE_KEY_TEMPERATURE) || '0.3'),
        maxTokens: parseInt(localStorage.getItem(STORAGE_KEY_MAX_TOKENS) || '3500', 10),
        jsonMode: localStorage.getItem(STORAGE_KEY_JSON_MODE) !== 'false',
        extraHeaders: localStorage.getItem(STORAGE_KEY_EXTRA_HEADERS) || ''
      };
    }

    static saveSettings(settings) {
      if (!settings) return;
      if (settings.provider !== undefined) {
        localStorage.setItem(STORAGE_KEY_PROVIDER, String(settings.provider).trim() || 'deepinfra');
      }
      if (settings.protocol !== undefined) {
        localStorage.setItem(STORAGE_KEY_PROTOCOL, String(settings.protocol).trim() || 'openai');
      }
      if (settings.apiKey !== undefined) {
        localStorage.setItem(STORAGE_KEY_API_KEY, String(settings.apiKey).trim());
      }
      if (settings.baseUrl !== undefined) {
        localStorage.setItem(STORAGE_KEY_BASE_URL, String(settings.baseUrl).trim());
      }
      if (settings.model !== undefined) {
        localStorage.setItem(STORAGE_KEY_MODEL, String(settings.model).trim());
      }
      if (settings.temperature !== undefined) {
        localStorage.setItem(STORAGE_KEY_TEMPERATURE, String(settings.temperature));
      }
      if (settings.maxTokens !== undefined) {
        localStorage.setItem(STORAGE_KEY_MAX_TOKENS, String(settings.maxTokens));
      }
      if (settings.jsonMode !== undefined) {
        localStorage.setItem(STORAGE_KEY_JSON_MODE, String(Boolean(settings.jsonMode)));
      }
      if (settings.extraHeaders !== undefined) {
        localStorage.setItem(STORAGE_KEY_EXTRA_HEADERS, String(settings.extraHeaders).trim());
      }
    }

    static hasKey() {
      const s = ByokAiProvider.getSettings();
      const preset = PROVIDER_PRESETS[s.provider];
      if (s.provider === 'custom' || (preset && !preset.requiresKey)) {
        return Boolean(s.baseUrl && s.model);
      }
      return Boolean(s.apiKey);
    }

    static async _sendRequest(settings, systemPrompt, userMessage) {
      const extra = parseExtraHeaders(settings.extraHeaders);
      const base = settings.baseUrl.replace(/\/+$/, '');
      const temp = Number.isFinite(settings.temperature) ? settings.temperature : 0.3;
      const maxTok = Number.isFinite(settings.maxTokens) ? settings.maxTokens : 3500;

      if (settings.protocol === 'anthropic') {
        const headers = {
          'Content-Type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          ...extra
        };
        const res = await fetch(`${base}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: settings.model,
            max_tokens: maxTok,
            temperature: temp,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }]
          })
        });
        if (!res.ok) {
          throw new Error(`Anthropic request failed (${res.status}): ${await res.text()}`);
        }
        const data = await res.json();
        return data.content?.[0]?.text || '';
      }

      if (settings.protocol === 'gemini') {
        const url = `${base}/models/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
        const genConfig = {
          temperature: temp,
          maxOutputTokens: maxTok
        };
        if (settings.jsonMode) {
          genConfig.responseMimeType = 'application/json';
        }
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...extra },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userMessage }] }],
            generationConfig: genConfig
          })
        });
        if (!res.ok) {
          throw new Error(`Gemini request failed (${res.status}): ${await res.text()}`);
        }
        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      }

      // default: openai-compatible (openai, openrouter, deepinfra, ollama, lm studio)
      const headers = {
        'Content-Type': 'application/json',
        ...extra
      };
      if (settings.apiKey) {
        headers.Authorization = `Bearer ${settings.apiKey}`;
      }
      if (settings.provider === 'openrouter') {
        headers['HTTP-Referer'] = window.location.origin;
        headers['X-Title'] = 'SampleVis';
      }

      const payload = {
        model: settings.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        max_tokens: maxTok,
        temperature: temp
      };
      if (settings.jsonMode) {
        payload.response_format = { type: 'json_object' };
      }

      let res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      // fallback if endpoint/model rejects response_format
      if (!res.ok && res.status === 400 && payload.response_format) {
        const errText = await res.text();
        if (/response_format|json_object/i.test(errText)) {
          delete payload.response_format;
          res = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
          });
        } else {
          throw new Error(`AI request failed (${res.status}): ${errText}`);
        }
      }

      if (!res.ok) {
        throw new Error(`AI request failed (${res.status}): ${await res.text()}`);
      }
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    }

    static async testConnection(overrideSettings) {
      const settings = overrideSettings || ByokAiProvider.getSettings();
      const preset = PROVIDER_PRESETS[settings.provider];
      if ((preset?.requiresKey ?? true) && !settings.apiKey) {
        throw new Error('API key is required for this provider.');
      }
      const testSettings = { ...settings, jsonMode: false, maxTokens: 32 };
      const text = await ByokAiProvider._sendRequest(
        testSettings,
        'Reply with the word OK.',
        'Ping'
      );
      if (!text) throw new Error('Provider returned an empty response.');
      return text.trim();
    }

    static async generatePreset(prompt, currentPreset, projectContext) {
      const settings = ByokAiProvider.getSettings();
      const preset = PROVIDER_PRESETS[settings.provider];
      if ((preset?.requiresKey ?? true) && !settings.apiKey) {
        throw new Error('API key required. Please open AI Settings to configure your key.');
      }

      const systemPrompt = getSystemPrompt();
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

      const content = await ByokAiProvider._sendRequest(settings, systemPrompt, userMessage);
      if (!content) {
        throw new Error('AI returned an empty response');
      }

      try {
        return parseJsonResponse(content);
      } catch (err) {
        throw new Error(`Could not parse AI response as valid JSON: ${err.message}`);
      }
    }
  }

  window.ByokAiProvider = ByokAiProvider;
})();
