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
  const DEFAULT_MAX_TOKENS = 65536;
  const MAX_PROJECT_NOTES_LINES = 100;
  const MAX_PROJECT_NOTES_CHARS = 4000;

  function normalizeProjectNotes(raw, { trim = true } = {}) {
    if (typeof raw !== 'string') return '';
    let text = raw.replace(/\r\n?/g, '\n');
    if (trim) text = text.trim();
    const lines = text.split('\n');
    if (lines.length > MAX_PROJECT_NOTES_LINES) {
      text = lines.slice(0, MAX_PROJECT_NOTES_LINES).join('\n');
    }
    if (text.length > MAX_PROJECT_NOTES_CHARS) {
      text = text.slice(0, MAX_PROJECT_NOTES_CHARS);
    }
    return trim ? text.trimEnd() : text;
  }

  const PROVIDER_PRESETS = {
    openrouter: {
      label: 'OpenRouter',
      protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'anthropic/claude-haiku-4.5',
      requiresKey: true,
      suggestedModels: [
        'anthropic/claude-haiku-4.5',
        'google/gemini-3.8-flash',
        'google/gemini-4-carbon',
        'deepseek/deepseek-v4.1-flash',
        'deepseek/deepseek-v4-pro',
        'qwen/qwen3.8-flash',
        'qwen/qwen-3.8-27b',
        'openai/gpt-5',
        'openai/gpt-4.1-mini',
        'google/gemini-2.5-flash'
      ]
    },
    deepseek: {
      label: 'DeepSeek API',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      defaultModel: 'deepseek-flash',
      requiresKey: true,
      suggestedModels: [
        'deepseek-flash',
        'deepseek-chat',
        'deepseek-reasoner'
      ]
    },
    deepinfra: {
      label: 'DeepInfra',
      protocol: 'openai',
      baseUrl: 'https://api.deepinfra.com/v1/openai',
      defaultModel: 'deepseek-ai/DeepSeek-V4.1-Flash',
      requiresKey: true,
      suggestedModels: [
        'deepseek-ai/DeepSeek-V4.1-Flash',
        'deepseek-ai/DeepSeek-V4-Pro',
        'deepseek-ai/DeepSeek-V3.2',
        'deepseek-ai/DeepSeek-R1',
        'Qwen/Qwen3.8-27B',
        'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        'anthropic/claude-haiku-4.5'
      ]
    },
    gemini: {
      label: 'Google Gemini API',
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      defaultModel: 'gemini-3.8-flash',
      requiresKey: true,
      suggestedModels: [
        'gemini-3.8-flash',
        'gemini-2.5-flash',
        'gemini-2.5-pro'
      ]
    },
    anthropic: {
      label: 'Anthropic Claude API',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      defaultModel: 'claude-haiku-4-5-20251001',
      requiresKey: true,
      suggestedModels: [
        'claude-haiku-4-5-20251001',
        'claude-sonnet-4-20250514'
      ]
    },
    openai: {
      label: 'OpenAI API',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4.1-mini',
      requiresKey: true,
      suggestedModels: [
        'gpt-4.1-mini',
        'gpt-5',
        'o4-mini',
        'gpt-4.1',
        'gpt-4o-mini'
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

  function getSystemPrompt(outputMode) {
    if (typeof window !== 'undefined' && typeof window.VizSkill?.getSystemPrompt === 'function') {
      return window.VizSkill.getSystemPrompt(outputMode);
    }
    return 'You are Viz, the visual designer inside SampleVis. Output ONLY a single compact JSON object with reply, options, embedUploadedImage, imageGenerationPrompt, imageGenerationRequests, requestCanvasSnapshot, requestRenderLogs, projectNotes, timelineCueSeeds, and preset.';
  }

  function repairJsonControlChars(str) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (inString && ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        out += ch;
        continue;
      }
      if (inString) {
        if (ch === '\n') { out += '\\n'; continue; }
        if (ch === '\r') { out += '\\r'; continue; }
        if (ch === '\t') { out += '\\t'; continue; }
      }
      out += ch;
    }
    return out;
  }

  function parseJsonResponse(rawText) {
    let cleaned = String(rawText || '').trim();
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
    try {
      return JSON.parse(cleaned);
    } catch (err) {
      const repaired = repairJsonControlChars(cleaned);
      if (repaired !== cleaned) {
        try {
          return JSON.parse(repaired);
        } catch (_) {
          // fall through to original parse error
        }
      }
      throw err;
    }
  }

  function clampMaxTokensFromError(errText, currentMax) {
    if (!/max_tokens|max_output_tokens|maxOutputTokens|max_completion_tokens/i.test(errText)) {
      return null;
    }
    const m = String(errText).match(/(?:<=|at most|maximum(?: allowed)?(?: is| of)?|max(?:imum)?(?: output)? tokens(?: is| of)?|limit(?: is| of)?|exceeds?(?: the)?(?: maximum)?(?: of)?)\s*[:=]?\s*(\d{3,6})/i)
      || String(errText).match(/>\s*(\d{3,6})/);
    const parsed = m ? parseInt(m[1], 10) : NaN;
    if (Number.isFinite(parsed) && parsed >= 256 && parsed < currentMax) {
      return parsed;
    }
    const stepped = currentMax > 16384 ? 16384 : (currentMax > 8192 ? 8192 : Math.floor(currentMax / 2));
    return stepped >= 256 && stepped < currentMax ? stepped : null;
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

  function splitDataUrl(dataUrl) {
    const str = String(dataUrl || '');
    const m = str.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return null;
    return { mimeType: m[1], base64: m[2] };
  }

  function sanitizePresetForPrompt(preset) {
    if (!preset || typeof preset !== 'object') return null;
    const copy = JSON.parse(JSON.stringify(preset));
    if (copy.meta?.thumbnail) {
      copy.meta.thumbnail = '[thumbnail omitted]';
    }
    if (copy.meta && Object.prototype.hasOwnProperty.call(copy.meta, 'notes')) {
      delete copy.meta.notes;
    }
    if (copy.assets && typeof copy.assets === 'object') {
      const sanitizedAssets = {};
      if (copy.assets.customImage) {
        sanitizedAssets.hasCustomImage = true;
      }
      if (Array.isArray(copy.assets.customFonts) && copy.assets.customFonts.length > 0) {
        sanitizedAssets.customFonts = copy.assets.customFonts
          .filter((f) => f && f.family)
          .map((f) => ({ family: f.family, name: f.name || f.family }));
      }
      copy.assets = Object.keys(sanitizedAssets).length > 0 ? sanitizedAssets : undefined;
    }
    if (Array.isArray(copy.features?.timeline?.categories)) {
      copy.features.timeline.categories = copy.features.timeline.categories
        .filter((c) => c && typeof c === 'object')
        .map(({ cues, initialCues, ...rest }) => rest);
    }
    return copy;
  }

  class ByokAiProvider {
    static normalizeProjectNotes(raw, opts) {
      return normalizeProjectNotes(raw, opts);
    }

    static getProjectNotesLimits() {
      return { maxLines: MAX_PROJECT_NOTES_LINES, maxChars: MAX_PROJECT_NOTES_CHARS };
    }

    static getPresets() {
      return PROVIDER_PRESETS;
    }

    static supportsVision(overrideSettings) {
      const settings = overrideSettings || ByokAiProvider.getSettings();
      const model = String(settings?.model || '').trim().toLowerCase();
      if (!model) return true;
      if (/(vision|vl|multimodal)/.test(model)) return true;
      if (/(^|\/)(deepseek-(chat|reasoner|coder|r1|v3(\.\d+)?))([^a-z0-9]|$)/.test(model)) {
        return false;
      }
      return true;
    }

    static getSettings() {
      const provider = localStorage.getItem(STORAGE_KEY_PROVIDER) || 'openrouter';
      const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.openrouter;
      const storedMaxTokens = localStorage.getItem(STORAGE_KEY_MAX_TOKENS);
      const parsedMaxTokens = storedMaxTokens ? parseInt(storedMaxTokens, 10) : NaN;
      // upgrade untouched legacy defaults (3500 / 16384) so thinking models are not clipped
      const maxTokens = (!Number.isFinite(parsedMaxTokens) || parsedMaxTokens === 3500 || parsedMaxTokens === 16384)
        ? DEFAULT_MAX_TOKENS
        : parsedMaxTokens;
      return {
        provider,
        protocol: localStorage.getItem(STORAGE_KEY_PROTOCOL) || preset.protocol,
        apiKey: localStorage.getItem(STORAGE_KEY_API_KEY) || '',
        baseUrl: localStorage.getItem(STORAGE_KEY_BASE_URL) || preset.baseUrl,
        model: localStorage.getItem(STORAGE_KEY_MODEL) || preset.defaultModel,
        temperature: parseFloat(localStorage.getItem(STORAGE_KEY_TEMPERATURE) || '0.35'),
        maxTokens,
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

    static async _sendRequest(settings, systemPrompt, messagesOrText, signal) {
      const extra = parseExtraHeaders(settings.extraHeaders);
      const base = settings.baseUrl.replace(/\/+$/, '');
      const temp = Number.isFinite(settings.temperature) ? settings.temperature : 0.35;
      const maxTok = Number.isFinite(settings.maxTokens) && settings.maxTokens > 0
        ? settings.maxTokens
        : DEFAULT_MAX_TOKENS;
      const conversation = Array.isArray(messagesOrText)
        ? messagesOrText
        : [{ role: 'user', content: String(messagesOrText || '') }];
      const hasAnyImages = conversation.some((m) => m.role === 'user' && Array.isArray(m.images) && m.images.length > 0);

      if (settings.protocol === 'anthropic') {
        const headers = {
          'Content-Type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          ...extra
        };
        const anthropicPayload = {
          model: settings.model,
          max_tokens: maxTok > 64 ? Math.min(maxTok, 64000) : maxTok,
          temperature: temp,
          system: systemPrompt,
          messages: conversation.map((m) => {
            const role = m.role === 'assistant' ? 'assistant' : 'user';
            const text = String(m.content || '');
            if (role === 'user' && Array.isArray(m.images) && m.images.length > 0) {
              const blocks = [];
              m.images.forEach((imgUrl) => {
                const parts = splitDataUrl(imgUrl);
                if (parts) {
                  blocks.push({
                    type: 'image',
                    source: { type: 'base64', media_type: parts.mimeType, data: parts.base64 }
                  });
                }
              });
              blocks.push({ type: 'text', text });
              return { role, content: blocks };
            }
            return { role, content: text };
          })
        };
        let res = await fetch(`${base}/messages`, {
          method: 'POST',
          signal,
          headers,
          body: JSON.stringify(anthropicPayload)
        });
        if (!res.ok && res.status === 400) {
          const errText = await res.text();
          const clamped = clampMaxTokensFromError(errText, anthropicPayload.max_tokens);
          if (clamped) {
            anthropicPayload.max_tokens = clamped;
            res = await fetch(`${base}/messages`, {
              method: 'POST',
              signal,
              headers,
              body: JSON.stringify(anthropicPayload)
            });
          } else {
            throw new Error(`Anthropic request failed (${res.status}): ${errText}`);
          }
        }
        if (!res.ok) {
          throw new Error(`Anthropic request failed (${res.status}): ${await res.text()}`);
        }
        const data = await res.json();
        if (anthropicPayload.max_tokens > 64 && data.stop_reason === 'max_tokens') {
          throw new Error(`ai response was truncated at max_tokens (${anthropicPayload.max_tokens}). raise max tokens or retry with a shorter request.`);
        }
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
        const geminiBody = {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: conversation.map((m) => {
            const role = m.role === 'assistant' ? 'model' : 'user';
            const parts = [{ text: String(m.content || '') }];
            if (role === 'user' && Array.isArray(m.images) && m.images.length > 0) {
              m.images.forEach((imgUrl) => {
                const split = splitDataUrl(imgUrl);
                if (split) {
                  parts.push({ inlineData: { mimeType: split.mimeType, data: split.base64 } });
                }
              });
            }
            return { role, parts };
          }),
          generationConfig: genConfig
        };
        let res = await fetch(url, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json', ...extra },
          body: JSON.stringify(geminiBody)
        });
        if (!res.ok && res.status === 400) {
          const errText = await res.text();
          const clamped = clampMaxTokensFromError(errText, genConfig.maxOutputTokens);
          if (clamped) {
            genConfig.maxOutputTokens = clamped;
            res = await fetch(url, {
              method: 'POST',
              signal,
              headers: { 'Content-Type': 'application/json', ...extra },
              body: JSON.stringify(geminiBody)
            });
          } else {
            throw new Error(`Gemini request failed (${res.status}): ${errText}`);
          }
        }
        if (!res.ok) {
          throw new Error(`Gemini request failed (${res.status}): ${await res.text()}`);
        }
        const data = await res.json();
        if (genConfig.maxOutputTokens > 64 && data.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
          throw new Error(`ai response was truncated at maxTokens (${genConfig.maxOutputTokens}). raise max tokens or retry with a shorter request.`);
        }
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      }

      // default: openai-compatible (openai, openrouter, deepseek, deepinfra, ollama, lm studio)
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
          ...conversation.map((m) => {
            const role = m.role === 'assistant' ? 'assistant' : 'user';
            const text = String(m.content || '');
            if (role === 'user' && Array.isArray(m.images) && m.images.length > 0) {
              return {
                role,
                content: [
                  { type: 'text', text },
                  ...m.images.map((imgUrl) => ({
                    type: 'image_url',
                    image_url: { url: imgUrl, detail: 'high' }
                  }))
                ]
              };
            }
            return { role, content: text };
          })
        ],
        max_tokens: maxTok,
        temperature: temp
      };
      if (settings.jsonMode) {
        payload.response_format = { type: 'json_object' };
      }

      let res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal,
        headers,
        body: JSON.stringify(payload)
      });

      // fallback if endpoint/model rejects response_format or exceeds model max_tokens cap
      for (let retry = 0; retry < 2 && !res.ok && res.status === 400; retry++) {
        const errText = await res.text();
        let retried = false;
        if (payload.response_format && /response_format|json_object/i.test(errText)) {
          delete payload.response_format;
          retried = true;
        }
        const clamped = clampMaxTokensFromError(errText, payload.max_tokens);
        if (clamped) {
          payload.max_tokens = clamped;
          retried = true;
        }
        if (retried) {
          res = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            signal,
            headers,
            body: JSON.stringify(payload)
          });
          continue;
        }
        if (hasAnyImages && /image|vision|multimodal|content.*array/i.test(errText)) {
          throw new Error(`selected model "${settings.model}" does not support image input. try a vision model like google/gemini-3.8-flash or deepseek-flash in [byok] settings.`);
        }
        throw new Error(`AI request failed (${res.status}): ${errText}`);
      }

      if (!res.ok) {
        const errText = await res.text();
        if (hasAnyImages && res.status === 400 && /image|vision|multimodal|content.*array/i.test(errText)) {
          throw new Error(`selected model "${settings.model}" does not support image input. try a vision model like google/gemini-3.8-flash or deepseek-flash in [byok] settings.`);
        }
        throw new Error(`AI request failed (${res.status}): ${errText}`);
      }
      const data = await res.json();
      if (payload.max_tokens > 64 && data.choices?.[0]?.finish_reason === 'length') {
        throw new Error(`ai response was truncated at max_tokens (${payload.max_tokens}). reasoning models spend part of this budget thinking — raise max tokens or switch models.`);
      }
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

    static async chatWithViz(prompt, currentPreset, projectContext, history = [], images = [], options = {}) {
      const settings = ByokAiProvider.getSettings();
      const preset = PROVIDER_PRESETS[settings.provider];
      if ((preset?.requiresKey ?? true) && !settings.apiKey) {
        throw new Error('API key required. Please open AI Settings to configure your key.');
      }

      const recentHistory = Array.isArray(history)
        ? history
          .filter((m) => m && !m.error && (m.role === 'user' || m.role === 'assistant') && m.text)
          .slice(-8)
          .map((m) => ({
            role: m.role,
            content:
              m.role === 'assistant'
                ? JSON.stringify({
                  reply: m.text,
                  updatedPreset: Boolean(m.presetSnapshot),
                  changes: m.changesSummary || []
                })
                : m.text
          }))
        : [];

      const attachedImages = Array.isArray(images)
        ? images
          .map((item) => (typeof item === 'string' ? item : item?.aiDataUrl || item?.dataUrl))
          .filter((u) => typeof u === 'string' && u.startsWith('data:image/'))
          .slice(0, 6)
        : [];

      const normalizedNotes = normalizeProjectNotes(
        projectContext?.projectNotes ?? currentPreset?.meta?.notes ?? ''
      );

      const userMessageBody = {
        instruction: prompt,
        attachedImageCount: attachedImages.length,
        attachedVideos: Array.isArray(options?.videos) && options.videos.length > 0 ? options.videos : undefined,
        hasActiveCustomImageAsset: Boolean(attachedImages.length > 0 || currentPreset?.assets?.customImage),
        currentPreset: sanitizePresetForPrompt(currentPreset),
        projectContext: {
          bpm: projectContext?.bpm || 120,
          key: projectContext?.key || '',
          duration: projectContext?.duration || undefined,
          dropTime: projectContext?.dropTime,
          dropBar: projectContext?.dropBar,
          sections: Array.isArray(projectContext?.sections) && projectContext.sections.length > 0
            ? projectContext.sections.map((s) => ({
              id: s.id,
              type: s.type,
              label: s.label,
              bar: s.bar,
              time: s.time,
              endBar: s.endBar,
              energy: s.energy
            }))
            : undefined,
          hasMidi: Boolean(projectContext?.midi?.hasMidi),
          hasLyrics: Boolean(projectContext?.lyrics?.hasLyrics),
          trackNames: projectContext?.midi?.tracks?.map((t) => t.name) || [],
          clipCount: projectContext?.clips?.count || 0,
          clipTransition: projectContext?.clips?.transition || undefined,
          clipTransitionDuration: projectContext?.clips?.transitionDuration || undefined,
          isCustomClipTransition: projectContext?.clips?.isCustomTransition || undefined,
          pools: (projectContext?.pools && typeof projectContext.pools === 'object' && Object.keys(projectContext.pools).length > 0)
            ? projectContext.pools
            : undefined,
          customFonts: Array.isArray(projectContext?.customFonts) && projectContext.customFonts.length > 0
            ? projectContext.customFonts
            : undefined,
          studioFonts: Array.isArray(projectContext?.studioFonts) && projectContext.studioFonts.length > 0
            ? projectContext.studioFonts
            : undefined,
          aspectRatio: projectContext?.aspectRatio || '9:16',
          customCues: (projectContext?.customCues && typeof projectContext.customCues === 'object' && Object.keys(projectContext.customCues).length > 0)
            ? projectContext.customCues
            : undefined,
          visionCapable: ByokAiProvider.supportsVision(settings),
          projectNotes: normalizedNotes || undefined,
          runtimeErrors: Array.isArray(projectContext?.runtimeErrors) && projectContext.runtimeErrors.length > 0
            ? projectContext.runtimeErrors
            : undefined,
          renderDiagnostics: projectContext?.renderDiagnostics || undefined
        }
      };

      // patch mode is chosen client-side because desktop/BYOK has no server to ask. it is only a
      // default: the model can veto, and a full preset in a patch turn is accepted as an answer.
      let outputMode = options?.outputMode === 'patch' || options?.outputMode === 'full'
        ? options.outputMode
        : (window.PresetPatch?.classifyTurn({
          prompt,
          preset: currentPreset,
          hasAttachedMedia: attachedImages.length > 0 || (Array.isArray(options?.videos) && options.videos.length > 0)
        }) || 'full');

      const runTurn = async (mode) => {
        const content = await ByokAiProvider._sendRequest(settings, getSystemPrompt(mode), [
          ...recentHistory,
          {
            role: 'user',
            content: JSON.stringify({ ...userMessageBody, outputMode: mode === 'patch' ? 'patch' : undefined }),
            images: attachedImages
          }
        ], options?.signal);
        if (!content) {
          throw new Error('AI returned an empty response');
        }
        return content;
      };

      let content = await runTurn(outputMode);
      if (outputMode === 'patch') {
        // a veto or an inapplicable patch costs one retry in full mode. the refusal is the whole
        // point of the cheap escape hatch: it is cheaper than a truncated rewrite either way, and
        // an applied-then-half-broken preset is the one outcome worth spending a retry to avoid
        let firstShape = null;
        try {
          firstShape = window.PresetPatch?.detectOutputShape(parseJsonResponse(content)) || null;
        } catch {
          firstShape = null; // unparseable reply: fall through to a full retry
        }
        const patchApplies = firstShape?.kind === 'patch'
          ? Boolean(window.PresetPatch?.applyOps(currentPreset, firstShape.ops)?.ok)
          : false;
        if (firstShape && firstShape.kind === 'patch' && !patchApplies) {
          content = await runTurn('full');
          outputMode = 'full';
        } else if (!firstShape || firstShape.kind === 'veto' || firstShape.kind === 'invalid') {
          content = await runTurn('full');
          outputMode = 'full';
        }
      }

      try {
        const parsed = parseJsonResponse(content);
        // a patch is merged onto the live preset, not the sanitized copy the model was shown, so
        // assets, notes, thumbnails and cue payloads survive an edit that never mentioned them
        const outputShape = window.PresetPatch?.detectOutputShape(parsed) || { kind: 'full' };
        const patchResult = outputShape.kind === 'patch' && window.PresetPatch
          ? window.PresetPatch.applyOps(currentPreset, outputShape.ops)
          : null;
        const patchedPreset = patchResult?.ok ? patchResult.preset : null;
        const normalizedOptions = Array.isArray(parsed?.options)
          ? parsed.options
            .map((opt) => {
              if (typeof opt === 'string') return { label: opt.slice(0, 48), prompt: opt };
              if (opt && typeof opt === 'object' && (opt.label || opt.prompt)) {
                const label = String(opt.label || opt.prompt).trim().slice(0, 48);
                const optPrompt = String(opt.prompt || opt.label).trim();
                return label && optPrompt ? { label, prompt: optPrompt } : null;
              }
              return null;
            })
            .filter(Boolean)
            .slice(0, 4)
          : [];

        const normalizedQuestions = Array.isArray(parsed?.questions)
          ? parsed.questions
            .map((q) => {
              if (!q || typeof q !== 'object') return null;
              const question = String(q.question || q.q || '').trim().slice(0, 200);
              const answers = (Array.isArray(q.options) ? q.options : [])
                .map((opt) => {
                  if (typeof opt === 'string') return { label: opt.slice(0, 48), prompt: opt };
                  if (opt && typeof opt === 'object' && (opt.label || opt.prompt)) {
                    const label = String(opt.label || opt.prompt).trim().slice(0, 48);
                    const answerPrompt = String(opt.prompt || opt.label).trim();
                    return label && answerPrompt ? { label, prompt: answerPrompt } : null;
                  }
                  return null;
                })
                .filter(Boolean)
                .slice(0, 4);
              return question && answers.length > 0 ? { question, options: answers } : null;
            })
            .filter(Boolean)
            .slice(0, 2)
          : [];

        if (parsed && (Object.prototype.hasOwnProperty.call(parsed, 'preset') || Object.prototype.hasOwnProperty.call(parsed, 'projectNotes') || parsed.reply || normalizedOptions.length || normalizedQuestions.length || parsed.requestCanvasSnapshot || parsed.requestRenderLogs)) {
          const nextPreset = patchedPreset || parsed.preset || (parsed.shaderBox || parsed.frontUiBox ? parsed : null);
          const rawPeek = parsed.requestCanvasSnapshot;
          const requestCanvasSnapshot = (rawPeek && typeof rawPeek === 'object' && ByokAiProvider.supportsVision(settings))
            ? {
              at: String(rawPeek.at || 'current').toLowerCase() === 'drop' ? 'drop' : 'current',
              reason: typeof rawPeek.reason === 'string' ? rawPeek.reason.trim().slice(0, 140) : '',
              frames: Math.min(6, Math.max(1, Math.round(Number(rawPeek.frames) || 1))),
              step: Math.min(2, Math.max(0.2, Number(rawPeek.step) || 0.6))
            }
            : null;
          const rawLogsReq = parsed.requestRenderLogs;
          const logsAtRaw = String(rawLogsReq?.at || 'both').toLowerCase();
          const requestRenderLogs = (rawLogsReq && typeof rawLogsReq === 'object')
            ? {
              at: (logsAtRaw === 'current' || logsAtRaw === 'drop' || logsAtRaw === 'sweep') ? logsAtRaw : 'both',
              reason: typeof rawLogsReq.reason === 'string' ? rawLogsReq.reason.trim().slice(0, 140) : ''
            }
            : null;
          const nextProjectNotes = typeof parsed.projectNotes === 'string'
            ? normalizeProjectNotes(parsed.projectNotes)
            : null;
          const rawPoolReqs = Array.isArray(parsed.imageGenerationRequests) ? parsed.imageGenerationRequests : [];
          const imageGenerationRequests = rawPoolReqs
            .filter((r) => r && typeof r === 'object' && typeof r.poolId === 'string' && r.poolId.trim() && typeof r.prompt === 'string' && r.prompt.trim())
            .slice(0, 8)
            .map((r, idx) => ({
              poolId: r.poolId.trim(),
              name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : `generated_${idx + 1}`,
              prompt: r.prompt.trim(),
              aspectRatio: ['1:1', '9:16', '16:9'].includes(r.aspectRatio) ? r.aspectRatio : '1:1'
            }));
          return {
            reply: typeof parsed.reply === 'string' && parsed.reply.trim()
              ? parsed.reply.trim()
              : nextPreset
                ? 'updated the visual.'
                : 'here are a few directions:',
            preset: nextPreset,
            outputMode: patchedPreset ? 'patch' : 'full',
            outputModeRequested: outputMode,
            projectNotes: nextProjectNotes,
            questions: normalizedQuestions,
            timelineCueSeeds: (parsed.timelineCueSeeds && typeof parsed.timelineCueSeeds === 'object' && !Array.isArray(parsed.timelineCueSeeds))
              ? parsed.timelineCueSeeds
              : null,
            options: normalizedOptions,
            embedUploadedImage: Boolean(parsed.embedUploadedImage),
            imageGenerationPrompt: typeof parsed.imageGenerationPrompt === 'string' && parsed.imageGenerationPrompt.trim()
              ? parsed.imageGenerationPrompt.trim()
              : null,
            imageGenerationRequests: imageGenerationRequests.length ? imageGenerationRequests : null,
            requestCanvasSnapshot,
            requestRenderLogs
          };
        }
        return {
          reply: 'updated the visual.',
          preset: parsed,
          projectNotes: null,
          options: [],
          embedUploadedImage: false,
          imageGenerationPrompt: null,
          imageGenerationRequests: null,
          requestCanvasSnapshot: null,
          requestRenderLogs: null
        };
      } catch (err) {
        throw new Error(`Could not parse AI response as valid JSON: ${err.message}`);
      }
    }

    static async generateImage(prompt, { aspectRatio = '9:16', signal } = {}) {
      const settings = ByokAiProvider.getSettings();
      const extra = parseExtraHeaders(settings.extraHeaders);
      const base = settings.baseUrl.replace(/\/+$/, '');
      const cleanPrompt = String(prompt || '').trim();
      if (!cleanPrompt) throw new Error('empty image generation prompt');

      if (settings.provider === 'openrouter') {
        const headers = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
          'HTTP-Referer': window.location.origin,
          'X-Title': 'SampleVis',
          ...extra
        };
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          signal,
          headers,
          body: JSON.stringify({
            model: 'google/gemini-2.5-flash-image',
            modalities: ['image', 'text'],
            image_config: { aspect_ratio: aspectRatio === '16:9' ? '16:9' : (aspectRatio === '1:1' ? '1:1' : '9:16') },
            messages: [{ role: 'user', content: cleanPrompt }]
          })
        });
        if (!res.ok) {
          throw new Error(`image generation failed (${res.status}): ${await res.text()}`);
        }
        const data = await res.json();
        const msg = data.choices?.[0]?.message;
        const imgUrl = msg?.images?.[0]?.image_url?.url || msg?.images?.[0]?.url;
        if (typeof imgUrl === 'string' && imgUrl.startsWith('data:image/')) {
          return imgUrl;
        }
        if (Array.isArray(msg?.content)) {
          const part = msg.content.find((c) => c?.type === 'image_url' && c?.image_url?.url);
          if (part?.image_url?.url) return part.image_url.url;
        }
        throw new Error('openrouter image model returned no image data');
      }

      if (settings.provider === 'gemini') {
        const url = `${base}/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
        const res = await fetch(url, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json', ...extra },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: cleanPrompt }] }],
            generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
          })
        });
        if (!res.ok) {
          throw new Error(`gemini image generation failed (${res.status}): ${await res.text()}`);
        }
        const data = await res.json();
        const parts = data.candidates?.[0]?.content?.parts || [];
        const imgPart = parts.find((p) => p?.inlineData?.data);
        if (imgPart) {
          const mime = imgPart.inlineData.mimeType || 'image/png';
          return `data:${mime};base64,${imgPart.inlineData.data}`;
        }
        throw new Error('gemini image model returned no image data');
      }

      if (settings.provider === 'openai' || settings.provider === 'deepinfra') {
        const endpoint = settings.provider === 'deepinfra'
          ? 'https://api.deepinfra.com/v1/openai/images/generations'
          : `${base}/images/generations`;
        const model = settings.provider === 'deepinfra'
          ? 'black-forest-labs/FLUX-1-schnell'
          : 'gpt-image-1';
        const size = aspectRatio === '16:9' ? '1536x1024' : (aspectRatio === '1:1' ? '1024x1024' : '1024x1536');
        const res = await fetch(endpoint, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${settings.apiKey}`,
            ...extra
          },
          body: JSON.stringify({
            model,
            prompt: cleanPrompt,
            n: 1,
            size,
            response_format: 'b64_json'
          })
        });
        if (!res.ok) {
          throw new Error(`image generation failed (${res.status}): ${await res.text()}`);
        }
        const data = await res.json();
        const b64 = data.data?.[0]?.b64_json;
        if (b64) return `data:image/png;base64,${b64}`;
        if (data.data?.[0]?.url) return data.data[0].url;
        throw new Error('image endpoint returned no image data');
      }

      throw new Error(`image generation is not supported on "${settings.provider}" (use openrouter, gemini, openai, or deepinfra).`);
    }

    static async generatePreset(prompt, currentPreset, projectContext) {
      const result = await ByokAiProvider.chatWithViz(prompt, currentPreset, projectContext, [], []);
      return result.preset;
    }
  }

  window.ByokAiProvider = ByokAiProvider;
})();
