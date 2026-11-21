// browser-first whisper stt, vocal-band onset alignment, and frame-level lyrics evaluator
(function () {
  'use strict';

  const WHISPER_MODELS = {
    tiny: 'onnx-community/whisper-tiny_timestamped',
    base: 'onnx-community/whisper-base_timestamped',
    small: 'onnx-community/whisper-small_timestamped',
    medium: 'onnx-community/whisper-medium_timestamped',
    // the same weights groq serves at whisper-large-v3-turbo, so cloud buys speed and no
    // download rather than a better model; ~725 mb at q4, webgpu only
    large: 'onnx-community/whisper-large-v3-turbo_timestamped'
  };
  const DEFAULT_WHISPER_MODEL = 'base';
  const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
  const STOP_WORDS = new Set(['a', 'an', 'the', 'i', 'me', 'my', 'you', 'to', 'in', 'on', 'it', 'is', 'of', 'and', 'or']);
  // a highlight landing exactly on the attack can read as late at 60 fps, so a small lead helps.
  // 140 ms of lead on individual words is too much — every word fires before the singer reaches
  // it — while whole phrases do want the larger lead so the line is already up as they arrive
  const WORD_LEAD_SEC = 0.05;
  const LINE_LEAD_SEC = 0.14;
  const TRANSCRIPTION_LEAD_SEC = WORD_LEAD_SEC;
  const SECTION_LABEL_PHRASE = /^(?:intro|outro|chorus|pre[\s-]?chorus|post[\s-]?chorus|verse(?:\s+\d+)?|bridge|hook|instrumental|interlude|refrain|fade\s*out|ad[\s-]?lib)[.!?…,:;-]*$/i;
  const HALLUCINATION_PHRASES = [
    /^thank(s|\s+you)(\s+so\s+much)?(\s+for\s+(watching|listening))?[.!?]*$/i,
    /^please\s+(subscribe|like|comment)[.!?]*$/i,
    /^(subtitles?|captions?)\s+by\b/i,
    /^amara\.org$/i,
    /^mbc\b/i,
    /^bye(\s+bye)?[.!?]*$/i,
    /^(?:music|musique|música|musica|applause|laughter|silence|instrumental|singing|noise|crowd)[.!?…]*$/i,
    /^\.+$/,
    SECTION_LABEL_PHRASE
  ];

  const pipelineCache = new Map();
  let cachedDevice = null;
  let cachedTransformersMod = null;

  async function loadTransformersLibrary() {
    if (cachedTransformersMod) return cachedTransformersMod;
    const mod = await import(TRANSFORMERS_CDN);
    if (mod?.env) {
      mod.env.allowLocalModels = false;
      mod.env.useBrowserCache = true;
    }
    cachedTransformersMod = mod;
    return mod;
  }

  async function getWhisperPipeline(onProgress = null, modelKey = DEFAULT_WHISPER_MODEL) {
    const requestedKey = WHISPER_MODELS[modelKey] ? modelKey : DEFAULT_WHISPER_MODEL;
    const { pipeline } = await loadTransformersLibrary();

    const notify = (info) => {
      if (typeof onProgress !== 'function') return;
      if (info && typeof info.progress === 'number') {
        onProgress({
          stage: 'model',
          progress: Math.max(0, Math.min(100, Math.round(info.progress))),
          status: info.status || `loading whisper-${requestedKey}`
        });
      } else if (info?.status) {
        onProgress({ stage: 'model', progress: 0, status: info.status });
      }
    };

    const canWebGpu = typeof navigator !== 'undefined' && Boolean(navigator.gpu);
    const devicesToTry = canWebGpu ? ['webgpu', 'wasm'] : ['wasm'];
    const prefersHeavy = requestedKey === 'medium' || requestedKey === 'large';
    // medium/large on a cpu is unusable and would download gigabytes, so they silently land on
    // small instead; everything else keeps the small-model fallback chain
    const keysToTry = prefersHeavy
      ? (canWebGpu ? [requestedKey, 'small'] : ['small', 'base'])
      : (requestedKey === 'tiny' ? ['tiny'] : [requestedKey, 'tiny']);
    let lastErr = null;

    for (const key of keysToTry) {
      const modelId = WHISPER_MODELS[key];
      const keyHeavy = key === 'medium' || key === 'large';
      const devicesForKey = keyHeavy ? ['webgpu'] : devicesToTry;
      for (const device of devicesForKey) {
        const cacheKey = `${key}:${device}`;
        if (pipelineCache.has(cacheKey)) {
          cachedDevice = device;
          return { transcriber: pipelineCache.get(cacheKey), modelKey: key, device };
        }
        try {
          const pipe = await pipeline('automatic-speech-recognition', modelId, {
            device,
            dtype: device === 'webgpu'
              ? { encoder_model: keyHeavy ? 'q4' : 'fp32', decoder_model_merged: 'q4' }
              : 'q8',
            progress_callback: notify
          });
          pipelineCache.set(cacheKey, pipe);
          cachedDevice = device;
          return { transcriber: pipe, modelKey: key, device };
        } catch (err) {
          lastErr = err;
        }
      }
    }

    throw new Error(`failed to initialize whisper stt (${lastErr?.message || 'unknown error'})`);
  }

  // emphasizes center-panned vocal formants (150 hz - 6.2 khz) and normalizes dynamics before stt
  async function prepareVocalPcm16k(audioBuffer) {
    if (!audioBuffer) throw new Error('missing audio buffer');
    const duration = Math.max(0.05, audioBuffer.duration || (audioBuffer.length / (audioBuffer.sampleRate || 44100)));
    const targetRate = 16000;
    const targetLength = Math.max(1, Math.ceil(duration * targetRate));
    let pcm = null;

    if (typeof OfflineAudioContext !== 'undefined') {
      try {
        const offline = new OfflineAudioContext(1, targetLength, targetRate);
        const src = offline.createBufferSource();
        src.buffer = audioBuffer;

        const hp = offline.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 100;
        hp.Q.value = 0.707;

        const presence = offline.createBiquadFilter();
        presence.type = 'peaking';
        presence.frequency.value = 2400;
        presence.Q.value = 0.85;
        presence.gain.value = 2.0;

        const lp = offline.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 7200;
        lp.Q.value = 0.707;

        src.connect(hp);
        hp.connect(presence);
        presence.connect(lp);
        lp.connect(offline.destination);
        src.start(0);

        const rendered = await offline.startRendering();
        pcm = rendered.getChannelData(0).slice();
      } catch {
        pcm = null;
      }
    }

    if (!pcm) {
      pcm = new Float32Array(targetLength);
      const ch0 = audioBuffer.getChannelData(0);
      const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
      const ratio = audioBuffer.length / targetLength;
      for (let i = 0; i < targetLength; i++) {
        const pos = i * ratio;
        const i0 = Math.min(audioBuffer.length - 1, Math.floor(pos));
        const i1 = Math.min(audioBuffer.length - 1, i0 + 1);
        const frac = pos - i0;
        const s0 = ch1 ? 0.5 * (ch0[i0] + ch1[i0]) : ch0[i0];
        const s1 = ch1 ? 0.5 * (ch0[i1] + ch1[i1]) : ch0[i1];
        pcm[i] = s0 + (s1 - s0) * frac;
      }
    }

    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]);
      if (a > peak) peak = a;
    }
    if (peak > 1e-4) {
      const gain = Math.min(4.0, 0.9 / peak);
      for (let i = 0; i < pcm.length; i++) {
        pcm[i] *= gain;
      }
    }
    return pcm;
  }

  // trims only true leading/trailing silence so whisper keeps full stride context across the track
  function detectActiveVocalRegions(pcm16k, totalDuration) {
    const rate = 16000;
    const hop = 800; // 50ms
    const frames = Math.floor(pcm16k.length / hop);
    if (frames < 10) return [{ startSec: 0, endSec: totalDuration }];

    const env = new Float32Array(frames);
    let maxRms = 0;
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      const s = f * hop;
      const e = Math.min(pcm16k.length, s + hop);
      for (let i = s; i < e; i++) sum += pcm16k[i] * pcm16k[i];
      env[f] = Math.sqrt(sum / Math.max(1, e - s));
      if (env[f] > maxRms) maxRms = env[f];
    }

    const silenceThresh = Math.max(maxRms * 0.015, 0.004);
    let firstFrame = 0;
    while (firstFrame < frames && env[firstFrame] < silenceThresh) firstFrame++;
    let lastFrame = frames - 1;
    while (lastFrame > firstFrame && env[lastFrame] < silenceThresh) lastFrame--;

    if (firstFrame >= frames) return [{ startSec: 0, endSec: totalDuration }];
    const startSec = Math.max(0, (firstFrame * hop) / rate - 0.5);
    const endSec = Math.min(totalDuration, ((lastFrame + 1) * hop) / rate + 0.5);
    if (endSec - startSec < 0.4) return [{ startSec: 0, endSec: totalDuration }];
    return [{ startSec, endSec }];
  }

  function cleanWordText(raw) {
    return String(raw || '')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\((?:music|singing|applause|laughter|instrumental|intro|outro|chorus|verse|bridge|hook|interlude|fade\s*out)[^)]*\)/gi, ' ')
      .replace(/[♪♫]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function filterHallucinatedWords(words) {
    if (!Array.isArray(words) || words.length === 0) return [];
    const fullText = words.map((w) => w.text).join(' ').trim();
    if (HALLUCINATION_PHRASES.some((re) => re.test(fullText))) {
      return [];
    }

    const cleaned = [];
    let repeatRun = 1;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!w.text || HALLUCINATION_PHRASES.some((re) => re.test(w.text))) continue;
      const norm = w.text.toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf\uac00-\ud7af]/g, '');
      const prevNorm = cleaned.length > 0
        ? cleaned[cleaned.length - 1].text.toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf\uac00-\ud7af]/g, '')
        : '';
      if (norm && norm === prevNorm) {
        repeatRun += 1;
        // cap whisper decoder stuttering loops (e.g. 5+ identical words in a row)
        if (repeatRun > 2) continue;
      } else {
        repeatRun = 1;
      }
      cleaned.push(w);
    }
    return cleaned;
  }

  function expandSttChunksToWords(chunks, totalDuration) {
    if (!Array.isArray(chunks) || chunks.length === 0) return [];
    const words = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const text = cleanWordText(chunk?.text);
      if (!text) continue;
      const ts = Array.isArray(chunk.timestamp) ? chunk.timestamp : [0, null];
      const start = Number.isFinite(ts[0]) ? Math.max(0, ts[0]) : 0;
      let end = Number.isFinite(ts[1]) ? ts[1] : null;
      if (end === null || end <= start) {
        const nextTs = chunks[i + 1]?.timestamp?.[0];
        end = Number.isFinite(nextTs) && nextTs > start
          ? Math.min(nextTs, start + 1.2)
          : Math.min(totalDuration || start + 0.5, start + 0.45);
      }
      // whisper will happily stretch a phrase across seconds of instrumental audio
      end = Math.min(end, start + maxWordDuration(text));

      const subTokens = text.split(/\s+/).filter(Boolean);
      if (subTokens.length <= 1) {
        words.push({ text, start, end });
      } else {
        const totalChars = subTokens.reduce((sum, t) => sum + Math.max(1, t.length), 0);
        let cursor = start;
        const span = Math.max(0.08, end - start);
        for (const tok of subTokens) {
          const frac = Math.max(1, tok.length) / totalChars;
          const wEnd = cursor + span * frac;
          words.push({ text: tok, start: cursor, end: wEnd });
          cursor = wEnd;
        }
      }
    }

    words.sort((a, b) => a.start - b.start);
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i].end > words[i + 1].start) {
        words[i].end = Math.max(words[i].start + 0.04, words[i + 1].start);
      }
    }
    return words;
  }

  // shifts word timestamps earlier so lyrics lead the vocal slightly for readability
  function applyLeadOffset(words, leadSec = TRANSCRIPTION_LEAD_SEC) {
    if (!Array.isArray(words) || !Number.isFinite(leadSec) || leadSec <= 0) return words;
    return words.map((w) => {
      const start = Math.max(0, w.start - leadSec);
      const end = Math.max(start + 0.04, w.end - leadSec);
      return {
        ...w,
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3))
      };
    });
  }

  function wordsToEntries(words) {
    if (!Array.isArray(words) || words.length === 0) return [];
    return words.map((w) => {
      const entry = { text: w.text, start: w.start, end: w.end };
      if (w.confidence !== undefined) entry.confidence = w.confidence;
      return {
        text: w.text,
        start: w.start,
        end: w.end,
        words: [entry]
      };
    });
  }

  function joinWordsText(words) {
    return words.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();
  }

  function groupWordsIntoLines(words) {
    if (!Array.isArray(words) || words.length === 0) return [];
    const lines = [];
    let current = [];

    const flush = () => {
      if (current.length === 0) return;
      lines.push({
        text: current.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim(),
        start: current[0].start,
        end: current[current.length - 1].end,
        words: current.map((w) => ({ ...w }))
      });
      current = [];
    };

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (current.length > 0) {
        const prev = current[current.length - 1];
        const gap = w.start - prev.end;
        const lineSpan = w.end - current[0].start;
        const endsSentence = /[.!?,;]$/.test(prev.text);
        if (gap > 0.55 || (endsSentence && current.length >= 2) || current.length >= 8 || lineSpan > 4.2) {
          flush();
        }
      }
      current.push(w);
    }
    flush();
    return lines;
  }

  // transformers.js keeps downloaded weights in the browser cache api, so we can tell people what
  // is already on disk instead of letting them re-download blind
  async function getWhisperCacheStatus() {
    const status = {};
    let urls = [];
    if (typeof caches !== 'undefined') {
      try {
        const names = await caches.keys();
        for (const name of names) {
          const cache = await caches.open(name);
          const requests = await cache.keys();
          for (const req of requests) urls.push(req.url);
        }
      } catch {
        urls = [];
      }
    }
    for (const [key, id] of Object.entries(WHISPER_MODELS)) {
      status[key] = urls.some((url) => url.includes(id));
    }
    return status;
  }

  async function transcribeWithBrowserWhisper(audioBuffer, options = {}) {
    const onProgress = options.onProgress;
    if (typeof onProgress === 'function') {
      onProgress({ stage: 'audio', progress: 10, status: 'isolating vocal band (16khz)' });
    }
    const pcm16k = await prepareVocalPcm16k(audioBuffer);
    const { transcriber, modelKey, device } = await getWhisperPipeline(onProgress, options.model || DEFAULT_WHISPER_MODEL);
    const duration = audioBuffer.duration || (pcm16k.length / 16000);
    const regions = detectActiveVocalRegions(pcm16k, duration);
    const language = options.language ? String(options.language).trim().toLowerCase() : '';
    const initialPrompt = normalizeInitialPrompt(options.initialPrompt);

    const rawWords = [];
    const cancelCheck = () => {
      if (typeof options.shouldCancel === 'function' && options.shouldCancel()) {
        const err = new Error('transcription cancelled');
        err.cancelled = true;
        throw err;
      }
    };
    for (let rIdx = 0; rIdx < regions.length; rIdx++) {
      cancelCheck();
      const reg = regions[rIdx];
      if (typeof onProgress === 'function') {
        const pct = 55 + Math.round((rIdx / regions.length) * 35);
        onProgress({ stage: 'transcribe', progress: pct, status: `transcribing ${rIdx + 1}/${regions.length} (${modelKey}·${device})` });
      }
      const sSample = Math.max(0, Math.floor(reg.startSec * 16000));
      const eSample = Math.min(pcm16k.length, Math.ceil(reg.endSec * 16000));
      const slice = pcm16k.subarray(sSample, eSample);
      if (slice.length < 3200) continue;

      const inferOpts = {
        task: 'transcribe',
        chunk_length_s: 28,
        stride_length_s: 5,
        return_timestamps: 'word'
      };
      if (language) inferOpts.language = language;
      if (initialPrompt) inferOpts.initial_prompt = initialPrompt;

      let output;
      try {
        output = await transcriber(slice, inferOpts);
      } catch (err) {
        if (!/cross.?attentions|output_attentions/i.test(String(err?.message || ''))) {
          throw err;
        }
        output = await transcriber(slice, {
          ...inferOpts,
          return_timestamps: true
        });
      }

      cancelCheck();
      const segWords = filterHallucinatedWords(
        expandSttChunksToWords(output?.chunks || [], reg.endSec - reg.startSec)
      );
      for (const w of segWords) {
        rawWords.push({
          text: w.text,
          start: w.start + reg.startSec,
          end: w.end + reg.startSec
        });
      }
    }

    // snap transcribed word start times to vocal onsets and measure word end from vocal energy
    if (typeof onProgress === 'function') {
      onProgress({ stage: 'align', progress: 93, status: 'snapping words & lengths to vocals' });
    }
    const envelopeData = await extractVocalOnsets(audioBuffer);
    const { onsets } = envelopeData;
    const onsetSnapped = rawWords.map((w, idx) => {
      const snapped = findOnsetForward(w.start, onsets, { back: 0.06, ahead: 0.16 });
      const candidateStart = snapped !== null ? snapped : w.start;
      const nextStart = idx < rawWords.length - 1 ? rawWords[idx + 1].start : duration;
      const start = Math.max(0, Math.min(candidateStart, nextStart - 0.04));
      const fallbackEnd = Math.max(start + 0.06, Math.min(w.end, nextStart));
      const end = measureWordEndFromEnvelope(start, fallbackEnd, nextStart, envelopeData, {
        syllables: countSyllables(w.text)
      });
      return { text: w.text, start, end };
    });

    // drop words whisper invented over instrumental audio, then cap any end that got stretched
    // toward the next word — both produce words that are seconds long and obviously wrong
    const energyGated = onsetSnapped.filter((w) => hasVocalEnergy(w.start, w.end, envelopeData));
    const keptWords = energyGated.length > 0 ? energyGated : onsetSnapped;
    for (const w of keptWords) {
      const cap = w.start + maxWordDuration(w.text);
      if (w.end > cap) w.end = cap;
    }

    for (let i = 0; i < keptWords.length - 1; i++) {
      if (keptWords[i].end > keptWords[i + 1].start) {
        keptWords[i].end = Math.max(keptWords[i].start + 0.05, keptWords[i + 1].start);
      }
    }
    enforceWordOrder(keptWords);

    const granularity = options.granularity === 'sentences' ? 'sentences' : 'words';
    const leadSec = Number.isFinite(options.leadOffsetSec)
      ? options.leadOffsetSec
      : (granularity === 'sentences' ? LINE_LEAD_SEC : WORD_LEAD_SEC);
    const words = applyLeadOffset(keptWords, leadSec);
    const lines = granularity === 'sentences' ? groupWordsIntoLines(words) : wordsToEntries(words);

    if (typeof onProgress === 'function') {
      onProgress({ stage: 'done', progress: 100, status: 'done' });
    }

    return {
      mode: 'transcribed',
      granularity,
      engine: `whisper-${modelKey}-${device}`,
      requestedModel: options.model || DEFAULT_WHISPER_MODEL,
      modelKey,
      device,
      rawText: joinWordsText(words),
      sttWords: words,
      rawSttWords: keptWords,
      lines
    };
  }

  function toIsoLanguageCode(lang) {
    const clean = String(lang || '').trim().toLowerCase();
    if (!clean) return '';
    const map = {
      english: 'en',
      japanese: 'ja',
      korean: 'ko',
      spanish: 'es',
      french: 'fr',
      german: 'de'
    };
    if (map[clean]) return map[clean];
    if (/^[a-z]{2}(-[a-z]{2})?$/.test(clean)) return clean.slice(0, 2);
    return '';
  }

  async function encodeAudioBufferToWavBlob(audioBuffer) {
    if (!audioBuffer) throw new Error('missing audio buffer');
    const pcm16k = await prepareVocalPcm16k(audioBuffer);
    const numSamples = pcm16k.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    const writeAscii = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, pcm16k[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  async function transcribeWithCloudApi(audioOrBlob, { provider = 'openai', apiKey = '', language = '', leadOffsetSec = null, initialPrompt = '', shouldCancel = null, granularity: rawGranularity = 'words', onProgress = null } = {}) {
    const cleanKey = String(apiKey || '').trim();
    const prov = String(provider || 'openai').trim().toLowerCase();
    if (!audioOrBlob || !cleanKey) {
      throw new Error('cloud stt requires both audio and an api key');
    }
    if (typeof shouldCancel === 'function' && shouldCancel()) {
      const err = new Error('transcription cancelled');
      err.cancelled = true;
      throw err;
    }

    const isAudioBuffer = typeof audioOrBlob.getChannelData === 'function';
    if (typeof onProgress === 'function') {
      onProgress({ stage: 'audio', progress: 15, status: 'encoding 16khz vocal wav' });
    }
    const audioBlob = isAudioBuffer ? await encodeAudioBufferToWavBlob(audioOrBlob) : audioOrBlob;
    const isoLang = toIsoLanguageCode(language);

    if (typeof onProgress === 'function') {
      onProgress({ stage: 'transcribe', progress: 45, status: `uploading to ${prov} stt...` });
    }

    let rawWords = [];
    let rawTranscriptText = '';

    if (prov === 'openai' || prov === 'groq') {
      const endpoint = prov === 'groq'
        ? 'https://api.groq.com/openai/v1/audio/transcriptions'
        : 'https://api.openai.com/v1/audio/transcriptions';
      const model = prov === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';
      const form = new FormData();
      form.append('file', audioBlob, 'audio.wav');
      form.append('model', model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      if (isoLang) form.append('language', isoLang);
      const promptHint = normalizeInitialPrompt(initialPrompt);
      if (promptHint) form.append('prompt', promptHint);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cleanKey}` },
        body: form
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`${prov} stt failed (${res.status}): ${txt.slice(0, 160)}`);
      }
      const data = await res.json();
      rawTranscriptText = data.text || '';
      if (Array.isArray(data.words) && data.words.length > 0) {
        rawWords = data.words.map((w) => ({
          text: cleanWordText(w.word),
          start: Number(w.start) || 0,
          end: Math.max((Number(w.start) || 0) + 0.05, Number(w.end) || (Number(w.start) || 0) + 0.3)
        })).filter((w) => w.text);
      } else if (Array.isArray(data.segments)) {
        rawWords = expandSttChunksToWords(
          data.segments.map((s) => ({ text: s.text, timestamp: [s.start, s.end] })),
          isAudioBuffer ? audioOrBlob.duration : 0
        );
      }
    } else if (prov === 'openrouter') {
      const arrayBuf = await audioBlob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const base64Audio = btoa(binary);
      const body = {
        model: 'openai/whisper-large-v3',
        input_audio: { data: base64Audio, format: 'wav' },
        response_format: 'verbose_json',
        timestamp_granularities: ['word', 'segment']
      };
      if (isoLang) body.language = isoLang;

      const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cleanKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`openrouter stt failed (${res.status}): ${txt.slice(0, 160)}`);
      }
      const data = await res.json();
      rawTranscriptText = data.text || '';
      if (Array.isArray(data.words) && data.words.length > 0) {
        rawWords = data.words.map((w) => ({
          text: cleanWordText(w.word || w.text),
          start: Number(w.start) || 0,
          end: Math.max((Number(w.start) || 0) + 0.05, Number(w.end) || (Number(w.start) || 0) + 0.3)
        })).filter((w) => w.text);
      } else if (Array.isArray(data.segments)) {
        rawWords = expandSttChunksToWords(
          data.segments.map((s) => ({ text: s.text, timestamp: [s.start, s.end] })),
          isAudioBuffer ? audioOrBlob.duration : 0
        );
      } else if (rawTranscriptText) {
        rawWords = expandSttChunksToWords(
          [{ text: rawTranscriptText, timestamp: [0, isAudioBuffer ? audioOrBlob.duration : 0] }],
          isAudioBuffer ? audioOrBlob.duration : 0
        );
      }
    } else if (prov === 'elevenlabs') {
      const form = new FormData();
      form.append('file', audioBlob, 'audio.wav');
      form.append('model_id', 'scribe_v1');
      form.append('timestamps_granularity', 'word');
      if (isoLang) form.append('language_code', isoLang);

      const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': cleanKey },
        body: form
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`elevenlabs stt failed (${res.status}): ${txt.slice(0, 160)}`);
      }
      const data = await res.json();
      rawTranscriptText = data.text || '';
      if (Array.isArray(data.words)) {
        rawWords = data.words
          .filter((w) => !w.type || w.type === 'word')
          .map((w) => ({
            text: cleanWordText(w.text),
            start: Number(w.start) || 0,
            end: Math.max((Number(w.start) || 0) + 0.05, Number(w.end) || (Number(w.start) || 0) + 0.3)
          }))
          .filter((w) => w.text);
      }
    } else if (prov === 'deepgram') {
      const params = new URLSearchParams({
        model: 'nova-3',
        smart_format: 'true',
        punctuate: 'true'
      });
      if (isoLang) params.set('language', isoLang);
      const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${cleanKey}`,
          'Content-Type': audioBlob.type || 'audio/wav'
        },
        body: audioBlob
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`deepgram stt failed (${res.status}): ${txt.slice(0, 160)}`);
      }
      const data = await res.json();
      const alt = data?.results?.channels?.[0]?.alternatives?.[0];
      rawTranscriptText = alt?.transcript || '';
      if (Array.isArray(alt?.words)) {
        rawWords = alt.words.map((w) => ({
          text: cleanWordText(w.punctuated_word || w.word),
          start: Number(w.start) || 0,
          end: Math.max((Number(w.start) || 0) + 0.05, Number(w.end) || (Number(w.start) || 0) + 0.3)
        })).filter((w) => w.text);
      }
    } else {
      throw new Error(`unsupported cloud stt provider: ${prov}`);
    }

    rawWords = filterHallucinatedWords(rawWords);
    let refinedWords = rawWords;
    if (isAudioBuffer && rawWords.length > 0) {
      if (typeof onProgress === 'function') {
        onProgress({ stage: 'align', progress: 88, status: 'snapping words to vocal onsets' });
      }
      const duration = audioOrBlob.duration || 1;
      const envelopeData = await extractVocalOnsets(audioOrBlob);
      const { onsets } = envelopeData;
      refinedWords = rawWords.map((w, idx) => {
        const snapped = findOnsetForward(w.start, onsets, { back: 0.06, ahead: 0.14 });
        const candidateStart = snapped !== null ? snapped : w.start;
        const nextStart = idx < rawWords.length - 1 ? rawWords[idx + 1].start : duration;
        const start = Math.max(0, Math.min(candidateStart, nextStart - 0.04));
        const fallbackEnd = Math.max(start + 0.06, Math.min(w.end, nextStart));
        const end = measureWordEndFromEnvelope(start, fallbackEnd, nextStart, envelopeData, {
          syllables: countSyllables(w.text)
        });
        return { text: w.text, start, end };
      });
      const energyGated = refinedWords.filter((w) => hasVocalEnergy(w.start, w.end, envelopeData));
      refinedWords = energyGated.length > 0 ? energyGated : refinedWords;
      for (const w of refinedWords) {
        const cap = w.start + maxWordDuration(w.text);
        if (w.end > cap) w.end = cap;
      }
      for (let i = 0; i < refinedWords.length - 1; i++) {
        if (refinedWords[i].end > refinedWords[i + 1].start) {
          refinedWords[i].end = Math.max(refinedWords[i].start + 0.05, refinedWords[i + 1].start);
        }
      }
      enforceWordOrder(refinedWords);
    }

    const granularity = rawGranularity === 'sentences' ? 'sentences' : 'words';
    const resolvedLead = Number.isFinite(leadOffsetSec)
      ? leadOffsetSec
      : (granularity === 'sentences' ? LINE_LEAD_SEC : WORD_LEAD_SEC);
    const words = applyLeadOffset(refinedWords, resolvedLead);
    const lines = granularity === 'sentences' ? groupWordsIntoLines(words) : wordsToEntries(words);
    if (typeof onProgress === 'function') {
      onProgress({ stage: 'done', progress: 100, status: 'done' });
    }
    return {
      mode: 'transcribed',
      granularity,
      engine: `cloud-${prov}`,
      rawText: rawTranscriptText || joinWordsText(words),
      sttWords: words,
      rawSttWords: refinedWords,
      lines
    };
  }

  // isolates 250 hz - 3.5 khz vocal presence via offline biquad cascade and extracts onset spikes
  async function extractVocalOnsets(audioBuffer) {
    if (!audioBuffer) return { onsets: [], firstActive: 0.15, lastActive: 1, env: null, hopSec: 0.02, maxEnv: 0, activeThresh: 0, duration: 1 };
    const duration = audioBuffer.duration || 1;
    const rate = 12000;
    const targetLen = Math.max(1, Math.ceil(duration * rate));
    const isStereo = audioBuffer.numberOfChannels >= 2;

    const filterVocalBand = async (monoSamples) => {
      if (typeof OfflineAudioContext === 'undefined') return monoSamples;
      try {
        const ctx = new OfflineAudioContext(1, targetLen, rate);
        const buf = ctx.createBuffer(1, audioBuffer.length, audioBuffer.sampleRate);
        buf.getChannelData(0).set(monoSamples);
        const src = ctx.createBufferSource();
        src.buffer = buf;

        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 300;
        hp.Q.value = 0.707;

        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 3200;
        lp.Q.value = 0.707;

        src.connect(hp);
        hp.connect(lp);
        lp.connect(ctx.destination);
        src.start(0);

        const rendered = await ctx.startRendering();
        return rendered.getChannelData(0);
      } catch {
        return monoSamples;
      }
    };

    let midFiltered = null;
    let sideFiltered = null;
    if (isStereo) {
      const ch0 = audioBuffer.getChannelData(0);
      const ch1 = audioBuffer.getChannelData(1);
      const midRaw = new Float32Array(audioBuffer.length);
      const sideRaw = new Float32Array(audioBuffer.length);
      for (let i = 0; i < audioBuffer.length; i++) {
        midRaw[i] = 0.5 * (ch0[i] + ch1[i]);
        sideRaw[i] = 0.5 * (ch0[i] - ch1[i]);
      }
      midFiltered = await filterVocalBand(midRaw);
      sideFiltered = await filterVocalBand(sideRaw);
    } else {
      midFiltered = await filterVocalBand(audioBuffer.getChannelData(0));
    }

    const effRate = midFiltered.length / duration;
    const hop = Math.max(1, Math.round(effRate * 0.02));
    const hopSec = effRate > 0 ? hop / effRate : 0.02;
    const frameCount = Math.floor(midFiltered.length / hop);
    if (frameCount < 4) {
      return {
        onsets: [],
        firstActive: 0.1,
        lastActive: Math.max(0.2, duration - 0.1),
        env: null,
        hopSec,
        maxEnv: 0,
        activeThresh: 0,
        duration
      };
    }

    const rawEnv = new Float32Array(frameCount);
    let maxEnv = 1e-6;
    for (let f = 0; f < frameCount; f++) {
      let sumMid = 0;
      let sumSide = 0;
      const start = f * hop;
      const end = Math.min(midFiltered.length, start + hop);
      const count = Math.max(1, end - start);
      for (let i = start; i < end; i++) {
        sumMid += midFiltered[i] * midFiltered[i];
        if (sideFiltered) sumSide += sideFiltered[i] * sideFiltered[i];
      }
      const rmsMid = Math.sqrt(sumMid / count);
      const rmsSide = sideFiltered ? Math.sqrt(sumSide / count) : 0;
      // center-panned vocals sit in mid while wide stereo instruments sit in side
      rawEnv[f] = Math.max(0, rmsMid - 0.65 * rmsSide);
    }

    const env = new Float32Array(frameCount);
    for (let f = 0; f < frameCount; f++) {
      const prev = f > 0 ? rawEnv[f - 1] : rawEnv[f];
      const next = f < frameCount - 1 ? rawEnv[f + 1] : rawEnv[f];
      env[f] = 0.25 * prev + 0.5 * rawEnv[f] + 0.25 * next;
      if (env[f] > maxEnv) maxEnv = env[f];
    }

    const sortedEnv = Array.from(env).sort((a, b) => a - b);
    const noiseFloor = sortedEnv[Math.floor(sortedEnv.length * 0.2)] || 0;
    const activeThresh = Math.max(maxEnv * 0.11, noiseFloor * 1.85);

    let firstActive = 0.1;
    let lastActive = Math.max(0.2, duration - 0.1);
    let run = 0;
    for (let f = 0; f < frameCount; f++) {
      if (env[f] >= activeThresh) {
        run++;
        if (run >= 3) {
          firstActive = Math.max(0, (f - 2) * hopSec);
          break;
        }
      } else {
        run = 0;
      }
    }
    run = 0;
    for (let f = frameCount - 1; f >= 0; f--) {
      if (env[f] >= activeThresh) {
        run++;
        if (run >= 3) {
          lastActive = Math.min(duration, (f + 3) * hopSec + 0.2);
          break;
        }
      } else {
        run = 0;
      }
    }

    const flux = new Float32Array(frameCount);
    for (let f = 1; f < frameCount; f++) {
      flux[f] = Math.max(0, env[f] - env[f - 1]);
    }

    const onsets = [];
    for (let f = 2; f < frameCount - 2; f++) {
      let localMean = 0;
      const lo = Math.max(0, f - 10);
      const hi = Math.min(frameCount - 1, f + 10);
      for (let k = lo; k <= hi; k++) localMean += flux[k];
      localMean /= (hi - lo + 1);

      const isPeak = flux[f] > flux[f - 1] && flux[f] >= flux[f + 1];
      if (isPeak && flux[f] > Math.max(maxEnv * 0.055, localMean * 1.55) && env[f] > activeThresh * 0.85) {
        const t = f * hopSec;
        if (onsets.length === 0 || t - onsets[onsets.length - 1] >= 0.09) {
          onsets.push(t);
        }
      }
    }

    return { onsets, firstActive, lastActive, env, hopSec, maxEnv, activeThresh, duration };
  }

  function normalizeRawToken(word) {
    let s = String(word || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9'\u3040-\u30ff\u4e00-\u9faf\uac00-\ud7af]/g, '')
      .replace(/'/g, '');
    const contractions = {
      im: 'iam',
      ive: 'ihave',
      id: 'iwill',
      dont: 'donot',
      cant: 'cannot',
      wont: 'willnot',
      didnt: 'didnot',
      isnt: 'isnot',
      arent: 'arenot',
      youre: 'youare',
      theyre: 'theyare',
      were: 'weare',
      thats: 'thatis',
      whats: 'whatis',
      gonna: 'goingto',
      wanna: 'wantto',
      gotta: 'gotto',
      kinda: 'kindof',
      cos: 'because',
      cuz: 'because'
    };
    return contractions[s] || s;
  }

  function normalizePhonetic(word) {
    let s = normalizeRawToken(word);
    if (!s) return '';
    if (!/^[a-z0-9]+$/.test(s)) return s;
    s = s
      .replace(/ph/g, 'f')
      .replace(/gh(?=$|[^aeiou])/g, '')
      .replace(/^kn/, 'n')
      .replace(/^wr/, 'r')
      .replace(/^wh/, 'w')
      .replace(/qu/g, 'kw')
      .replace(/tion|sion/g, 'shn')
      .replace(/c([eiy])/g, 's$1')
      .replace(/c/g, 'k')
      .replace(/x/g, 'ks')
      .replace(/z/g, 's')
      .replace(/v/g, 'f')
      .replace(/d+/g, 't')
      .replace(/t+/g, 't')
      .replace(/p+/g, 'b');
    const first = s[0];
    const rest = s.slice(1).replace(/[aeiouyh]+/g, 'a');
    return (first + rest).replace(/(.)\1+/g, '$1');
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    const al = a.length;
    const bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    const prev = new Uint16Array(bl + 1);
    const curr = new Uint16Array(bl + 1);
    for (let j = 0; j <= bl; j++) prev[j] = j;
    for (let i = 1; i <= al; i++) {
      curr[0] = i;
      for (let j = 1; j <= bl; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      prev.set(curr);
    }
    return prev[bl];
  }

  function tokenSimilarity(a, b) {
    const ra = normalizeRawToken(a);
    const rb = normalizeRawToken(b);
    if (!ra || !rb) return 0;
    if (ra === rb) return 1.0;

    const rawDist = levenshtein(ra, rb);
    const rawSim = 1 - rawDist / Math.max(ra.length, rb.length);

    const pa = normalizePhonetic(a);
    const pb = normalizePhonetic(b);
    let phonSim = 0;
    if (pa && pb) {
      if (pa === pb) {
        phonSim = 0.96;
      } else {
        const pDist = levenshtein(pa, pb);
        phonSim = (1 - pDist / Math.max(pa.length, pb.length)) * 0.94;
      }
    }

    let subBonus = 0;
    if (Math.min(ra.length, rb.length) >= 3 && (ra.includes(rb) || rb.includes(ra))) {
      subBonus = 0.72;
    }

    return Math.max(rawSim, phonSim, subBonus);
  }

  function countSyllables(word) {
    const clean = normalizeRawToken(word).replace(/[^a-z]/g, '');
    if (!clean) return 1;
    if (clean.length <= 3) return 1;
    const trimmed = clean.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
    const groups = trimmed.match(/[aeiouy]{1,2}/g);
    return Math.max(1, groups ? groups.length : 1);
  }

  // a sung word never genuinely lasts for seconds; long spans are whisper stretching a phrase
  // across instrumental audio, which is where multi-second "words" came from
  function maxWordDuration(text) {
    const syllables = Math.max(1, countSyllables(text));
    return Math.min(2.6, 0.34 * syllables + 0.55);
  }

  // whisper accepts a short text hint; feeding it the known lyrics measurably cuts misheard
  // words, because the decoder stops guessing what the vocal is singing from scratch
  function normalizeInitialPrompt(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean ? clean.slice(0, 220) : '';
  }

  // drops words with no vocal-band energy underneath — music and breath hallucinations
  function hasVocalEnergy(start, end, envelopeData) {
    const env = envelopeData?.env;
    if (!env || !env.length) return true;
    const hop = envelopeData.hopSec || 0.02;
    const thresh = Math.max(1e-6, (envelopeData.activeThresh || 0) * 0.55);
    const from = Math.max(0, Math.floor(start / hop));
    const to = Math.min(env.length - 1, Math.ceil((end + 0.05) / hop));
    for (let i = from; i <= to; i++) {
      if (env[i] >= thresh) return true;
    }
    return false;
  }

  function parsePastedLines(rawText) {
    const lines = String(rawText || '').split(/\r?\n/);
    const parsedLines = [];
    let pendingGapAfterPrev = false;

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        if (parsedLines.length > 0) pendingGapAfterPrev = true;
        continue;
      }
      // skip section markers like [chorus] or [verse 1]
      if (/^\[[^\]]{1,40}\]$/.test(trimmed)) {
        if (parsedLines.length > 0) pendingGapAfterPrev = true;
        continue;
      }
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;

      parsedLines.push({
        text: trimmed,
        gapBefore: pendingGapAfterPrev,
        tokens: tokens.map((tok) => ({
          text: tok,
          syllables: countSyllables(tok),
          isStopWord: STOP_WORDS.has(normalizeRawToken(tok))
        }))
      });
      pendingGapAfterPrev = false;
    }
    return parsedLines;
  }

  // picks the first vocal attack at or slightly before the estimate. snapping to the *nearest*
  // onset let a word land on the syllable before it whenever two attacks straddled whisper's
  // guess — the most visible sync error, since the highlight appears on the wrong syllable
  function findOnsetForward(targetTime, onsets, { back = 0.06, ahead = 0.18 } = {}) {
    if (!Array.isArray(onsets) || onsets.length === 0) return null;
    const from = targetTime - back;
    let lo = 0;
    let hi = onsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (onsets[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= onsets.length) return null;
    return onsets[lo] <= targetTime + ahead ? onsets[lo] : null;
  }

  // last onset at or before the target, within a small window — used only as a fallback when
  // nothing is ahead, because whisper's word starts are more often late than early
  function findOnsetBackward(targetTime, onsets, { back = 0.18 } = {}) {
    if (!Array.isArray(onsets) || onsets.length === 0) return null;
    const from = targetTime - back;
    let lo = 0;
    let hi = onsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (onsets[mid] <= targetTime) lo = mid + 1;
      else hi = mid;
    }
    const idx = lo - 1;
    if (idx < 0) return null;
    const candidate = onsets[idx];
    return candidate >= from ? candidate : null;
  }

  // snapped starts must stay strictly ordered, otherwise two words can share one attack
  function enforceWordOrder(words, minGap = 0.07) {
    for (let i = 1; i < words.length; i++) {
      const prev = words[i - 1];
      const cur = words[i];
      const floor = prev.start + minGap;
      if (cur.start < floor) cur.start = floor;
      if (cur.end < cur.start + 0.04) cur.end = cur.start + 0.04;
      if (prev.end > cur.start) prev.end = Math.max(prev.start + 0.04, cur.start);
    }
    return words;
  }

  // measures where vocal sustain drops off after wordStart using the 250hz-3.5khz rms envelope
  function measureWordEndFromEnvelope(wordStart, fallbackEnd, maxEnd, envelopeData, { syllables = 1 } = {}) {
    const safeMax = Math.max(wordStart + 0.05, maxEnd);
    const minEnd = Math.min(safeMax, wordStart + 0.06);
    const clampedFallback = Math.max(minEnd, Math.min(safeMax, fallbackEnd));

    const env = envelopeData?.env;
    const hopSec = envelopeData?.hopSec || 0.02;
    const maxEnv = envelopeData?.maxEnv || 0;
    if (!env || env.length === 0 || maxEnv <= 1e-6) {
      return clampedFallback;
    }

    const startFrame = Math.max(0, Math.min(env.length - 1, Math.floor(wordStart / hopSec)));
    const limitFrame = Math.max(startFrame, Math.min(env.length - 1, Math.floor(safeMax / hopSec)));
    const peakWindowSec = Math.min(0.45, Math.max(0.22, syllables * 0.16));
    const peakSearchEnd = Math.min(limitFrame, startFrame + Math.max(1, Math.round(peakWindowSec / hopSec)));

    let wordPeak = 0;
    let peakFrame = startFrame;
    for (let f = startFrame; f <= peakSearchEnd; f++) {
      if (env[f] > wordPeak) {
        wordPeak = env[f];
        peakFrame = f;
      }
    }

    if (wordPeak < maxEnv * 0.075) {
      return clampedFallback;
    }

    const expectedDur = Math.min(1.6, Math.max(0.18, syllables * 0.30));
    const cappedSafeMax = Math.min(safeMax, Math.max(clampedFallback, wordStart + expectedDur * 1.8));
    const sustainThresh = Math.max(maxEnv * 0.08, wordPeak * 0.24);
    let lastActiveFrame = peakFrame;
    let belowCount = 0;
    for (let f = peakFrame + 1; f <= limitFrame; f++) {
      if (env[f] >= sustainThresh) {
        lastActiveFrame = f;
        belowCount = 0;
      } else {
        belowCount++;
        if (belowCount >= 3) {
          const detectedEnd = (lastActiveFrame + 1) * hopSec + 0.03;
          return Math.max(minEnd, Math.min(safeMax, detectedEnd));
        }
      }
    }

    return Math.max(minEnd, Math.min(cappedSafeMax, Math.max(clampedFallback, wordStart + expectedDur)));
  }

  // finds where the sung phrase containing `anchorStart` began, by walking back to the most
  // recent sustained quiet stretch in the vocal band. this is what actually separates the
  // opening line from the intro, instead of extrapolating from an average syllable rate.
  function findPhraseStartBefore(anchorStart, envelopeData, { minGapSec = 0.45, factor = 0.8 } = {}) {
    const env = envelopeData?.env;
    if (!env || !env.length || !Number.isFinite(anchorStart)) return null;
    const hop = envelopeData.hopSec || 0.02;
    const thresh = Math.max(1e-6, (envelopeData.activeThresh || 0) * factor);
    const minGapFrames = Math.max(3, Math.round(minGapSec / hop));
    let quietRun = 0;
    const fromFrame = Math.min(env.length - 1, Math.floor(anchorStart / hop));
    for (let f = fromFrame; f >= 0; f--) {
      if (env[f] < thresh) {
        quietRun += 1;
        if (quietRun >= minGapFrames) return Math.max(0, (f + quietRun) * hop);
      } else {
        quietRun = 0;
      }
    }
    return null;
  }

  function alignPastedLyricsToAudio(rawLyricsText, sttWords = [], audioBuffer = null, durationHint = 0, precomputedOnsets = null, options = {}) {
    const granularity = options?.granularity === 'sentences' ? 'sentences' : 'words';
    const parsedLines = parsePastedLines(rawLyricsText);
    const duration = Math.max(1, durationHint || audioBuffer?.duration || 30);

    if (parsedLines.length === 0) {
      return {
        mode: 'pasted',
        granularity,
        rawText: rawLyricsText || '',
        lines: []
      };
    }

    const flatWords = [];
    for (let li = 0; li < parsedLines.length; li++) {
      for (let wi = 0; wi < parsedLines[li].tokens.length; wi++) {
        flatWords.push({
          ...parsedLines[li].tokens[wi],
          lineIndex: li,
          wordInLine: wi,
          flatIndex: flatWords.length
        });
      }
    }

    const M = flatWords.length;
    const N = Array.isArray(sttWords) ? sttWords.length : 0;
    const leadSec = Number.isFinite(options?.leadOffsetSec) ? options.leadOffsetSec : TRANSCRIPTION_LEAD_SEC;
    // normalize stt timestamps to raw audio time so dp anchors, onset snapping, and envelope probing share one timebase
    const rawStt = options?.sttHasLead
      ? sttWords.map((sw) => ({ ...sw, start: Math.max(0, sw.start + leadSec), end: Math.max(0.05, sw.end + leadSec) }))
      : sttWords;
    const anchors = new Map();

    if (M > 0 && N > 0) {
      const GAP_P = -0.55;
      const GAP_S = -0.62;
      const cols = N + 1;
      const dp = new Float32Array((M + 1) * cols);
      // 1: 1-1, 2: up (gap in stt), 3: left (gap in pasted), 4: 2-1 (two pasted -> one stt), 5: 1-2 (one pasted -> two stt)
      const trace = new Uint8Array((M + 1) * cols);

      for (let i = 1; i <= M; i++) {
        dp[i * cols] = i * GAP_P;
        trace[i * cols] = 2;
      }
      for (let j = 1; j <= N; j++) {
        dp[j] = j * GAP_S;
        trace[j] = 3;
      }

      const scoreSimilarity = (sim, wordMeta) => {
        if (sim >= 0.48) {
          const cleanLen = normalizeRawToken(wordMeta?.text || '').length;
          const infoWeight = wordMeta?.isStopWord || cleanLen <= 2 ? 0.58 : (cleanLen >= 5 ? 1.15 : 1.0);
          return 2.3 * sim * infoWeight;
        }
        if (sim >= 0.30) return -0.35;
        return -1.15;
      };

      for (let i = 1; i <= M; i++) {
        const pMeta = flatWords[i - 1];
        const pTok = pMeta.text;
        for (let j = 1; j <= N; j++) {
          const sim11 = tokenSimilarity(pTok, rawStt[j - 1].text);
          let best = dp[(i - 1) * cols + (j - 1)] + scoreSimilarity(sim11, pMeta);
          let bestDir = 1;

          const up = dp[(i - 1) * cols + j] + GAP_P;
          if (up > best) {
            best = up;
            bestDir = 2;
          }

          const left = dp[i * cols + (j - 1)] + GAP_S;
          if (left > best) {
            best = left;
            bestDir = 3;
          }

          if (i >= 2) {
            const mergedP = flatWords[i - 2].text + flatWords[i - 1].text;
            const sim21 = tokenSimilarity(mergedP, rawStt[j - 1].text);
            if (sim21 >= 0.58) {
              const cand21 = dp[(i - 2) * cols + (j - 1)] + scoreSimilarity(sim21, pMeta) * 0.92 - 0.08;
              if (cand21 > best) {
                best = cand21;
                bestDir = 4;
              }
            }
          }

          if (j >= 2) {
            const mergedS = rawStt[j - 2].text + rawStt[j - 1].text;
            const sim12 = tokenSimilarity(pTok, mergedS);
            if (sim12 >= 0.58) {
              const cand12 = dp[(i - 1) * cols + (j - 2)] + scoreSimilarity(sim12, pMeta) * 0.92 - 0.08;
              if (cand12 > best) {
                best = cand12;
                bestDir = 5;
              }
            }
          }

          dp[i * cols + j] = best;
          trace[i * cols + j] = bestDir;
        }
      }

      const rawPairs = [];
      let i = M;
      let j = N;
      while (i > 0 || j > 0) {
        const dir = trace[i * cols + j];
        if (dir === 1 && i > 0 && j > 0) {
          const sim = tokenSimilarity(flatWords[i - 1].text, rawStt[j - 1].text);
          if (sim >= 0.46) {
            rawPairs.push({ pIdx: i - 1, sIdx: j - 1, sim, spanP: 1, spanS: 1 });
          }
          i--;
          j--;
        } else if (dir === 4 && i >= 2 && j > 0) {
          const sim = tokenSimilarity(flatWords[i - 2].text + flatWords[i - 1].text, rawStt[j - 1].text);
          if (sim >= 0.62) {
            rawPairs.push({ pIdx: i - 2, sIdx: j - 1, sim, spanP: 2, spanS: 1 });
          }
          i -= 2;
          j--;
        } else if (dir === 5 && i > 0 && j >= 2) {
          const sim = tokenSimilarity(flatWords[i - 1].text, rawStt[j - 2].text + rawStt[j - 1].text);
          if (sim >= 0.62) {
            rawPairs.push({ pIdx: i - 1, sIdx: j - 2, sim, spanP: 1, spanS: 2 });
          }
          i--;
          j -= 2;
        } else if (dir === 2 && i > 0) {
          i--;
        } else {
          j--;
        }
      }
      rawPairs.reverse();

      // drop isolated stopword hallucinations far away from a consonant cluster
      for (let k = 0; k < rawPairs.length; k++) {
        const cur = rawPairs[k];
        const prev = k > 0 ? rawPairs[k - 1] : null;
        const next = k < rawPairs.length - 1 ? rawPairs[k + 1] : null;
        const nearPrev = prev && cur.pIdx - prev.pIdx <= 3 && cur.sIdx - prev.sIdx <= 4;
        const nearNext = next && next.pIdx - cur.pIdx <= 3 && next.sIdx - cur.sIdx <= 4;
        const isIsolatedWeakStop = cur.spanP === 1 && flatWords[cur.pIdx].isStopWord && cur.sim < 0.78 && !nearPrev && !nearNext;
        if (!isIsolatedWeakStop && (cur.sim >= 0.56 || nearPrev || nearNext)) {
          if (cur.spanP === 2) {
            const sw = rawStt[cur.sIdx];
            const s1 = flatWords[cur.pIdx].syllables || 1;
            const s2 = flatWords[cur.pIdx + 1].syllables || 1;
            const span = Math.max(0.10, sw.end - sw.start);
            const split = sw.start + span * (s1 / (s1 + s2));
            anchors.set(cur.pIdx, { start: sw.start, end: Math.max(sw.start + 0.05, split), confidence: cur.sim });
            anchors.set(cur.pIdx + 1, { start: split, end: Math.max(split + 0.05, sw.end), confidence: cur.sim });
          } else if (cur.spanS === 2) {
            const sw1 = rawStt[cur.sIdx];
            const sw2 = rawStt[cur.sIdx + 1];
            // merging two recognizer words only makes sense when they are contiguous in time: a
            // repeated word seconds apart used to create one multi-second anchor that swallowed
            // the whole intro and pinned the opening lyric to 0:00
            if (sw2.start - sw1.end <= 0.6) {
              anchors.set(cur.pIdx, { start: sw1.start, end: Math.max(sw1.start + 0.06, sw2.end), confidence: cur.sim });
            }
          } else {
            const sw = rawStt[cur.sIdx];
            const cap = maxWordDuration(flatWords[cur.pIdx].text);
            anchors.set(cur.pIdx, {
              start: sw.start,
              end: Math.max(sw.start + 0.06, Math.min(sw.end, sw.start + cap)),
              confidence: cur.sim
            });
          }
        }
      }
    }

    const vocalFirst = precomputedOnsets?.firstActive ?? Math.min(0.25, duration * 0.05);
    const vocalLast = Math.max(vocalFirst + 0.8, precomputedOnsets?.lastActive ?? Math.max(duration - 0.25, duration * 0.92));
    const onsets = precomputedOnsets?.onsets || [];

    // reject outlier anchors that violate local pacing or squeeze adjacent spans into impossible rates
    let anchoredIndices = Array.from(anchors.keys()).sort((a, b) => a - b);
    if (anchoredIndices.length >= 3) {
      const pairRates = [];
      for (let a = 0; a < anchoredIndices.length - 1; a++) {
        const i0 = anchoredIndices[a];
        const i1 = anchoredIndices[a + 1];
        if (i1 - i0 <= 12) {
          let syl = 0;
          for (let k = i0; k < i1; k++) syl += flatWords[k].syllables;
          const dt = anchors.get(i1).start - anchors.get(i0).start;
          if (dt > 0.05 && syl > 0) pairRates.push(dt / syl);
        }
      }
      pairRates.sort((x, y) => x - y);
      const medRate = pairRates.length > 0
        ? Math.max(0.12, Math.min(0.65, pairRates[Math.floor(pairRates.length / 2)]))
        : 0.26;

      let lastKeptIdx = anchoredIndices[0];
      const toDelete = [];
      for (let a = 1; a < anchoredIndices.length - 1; a++) {
        const prevIdx = lastKeptIdx;
        const curIdx = anchoredIndices[a];
        const nextIdx = anchoredIndices[a + 1];
        const curAnchor = anchors.get(curIdx);
        const prevAnchor = anchors.get(prevIdx);
        const nextAnchor = anchors.get(nextIdx);
        if (!curAnchor || !prevAnchor || !nextAnchor) continue;
        const isWeak = curAnchor.confidence < 0.78 || flatWords[curIdx].isStopWord;
        if (!isWeak) {
          lastKeptIdx = curIdx;
          continue;
        }

        const leftWords = curIdx - prevIdx;
        const rightWords = nextIdx - curIdx;
        const leftDt = curAnchor.start - prevAnchor.end;
        const rightDt = nextAnchor.start - curAnchor.end;
        const spanDt = nextAnchor.start - prevAnchor.end;
        const spanRate = spanDt / Math.max(1, nextIdx - prevIdx);
        const leftTooTight = leftWords >= 2 && leftDt < leftWords * 0.06 && spanRate >= medRate * 0.5;
        const rightTooTight = rightWords >= 2 && rightDt < rightWords * 0.06 && spanRate >= medRate * 0.5;
        if (leftTooTight || rightTooTight) {
          toDelete.push(curIdx);
        } else {
          lastKeptIdx = curIdx;
        }
      }
      for (const idx of toDelete) anchors.delete(idx);
      anchoredIndices = Array.from(anchors.keys()).sort((a, b) => a - b);
    }

    // enforce strictly non-decreasing anchor timestamps
    for (let a = 1; a < anchoredIndices.length; a++) {
      const prevA = anchors.get(anchoredIndices[a - 1]);
      const curA = anchors.get(anchoredIndices[a]);
      if (curA.start < prevA.start + 0.05) {
        curA.start = prevA.start + 0.05;
        curA.end = Math.max(curA.start + 0.05, curA.end);
      }
      if (prevA.end > curA.start) {
        prevA.end = Math.max(prevA.start + 0.04, curA.start);
      }
    }

    // a lone anchor inside the first two seconds followed by a long silent gap is almost always a
    // whisper hallucination on the intro; keeping it drags the opening lyric to 0:00 and skews
    // every fill that follows, which is what put the first words at the very start of the track
    if (anchoredIndices.length >= 3) {
      const firstIdx = anchoredIndices[0];
      const secondIdx = anchoredIndices[1];
      const firstAnchor = anchors.get(firstIdx);
      const secondAnchor = anchors.get(secondIdx);
      if (firstAnchor && secondAnchor) {
        const gap = secondAnchor.start - firstAnchor.end;
        const wordsBetween = Math.max(1, secondIdx - firstIdx);
        if (firstAnchor.start < 2.0 && gap > 6 && gap / wordsBetween > 2.5) {
          anchors.delete(firstIdx);
          anchoredIndices = anchoredIndices.slice(1);
        }
      }
    }

    // hallucinations usually arrive as a short cluster ("you thought") rather than one word, so
    // dropping a single anchor just moved the problem one word along — drop the whole run that
    // sits before the singing starts when the pacing to the next anchor is impossible
    if (anchoredIndices.length >= 2) {
      const early = anchoredIndices.filter((idx) => anchors.get(idx).start < 2.5);
      if (early.length > 0 && early.length < anchoredIndices.length) {
        const lastEarly = early[early.length - 1];
        const lastEarlyPos = anchoredIndices.indexOf(lastEarly);
        const nextIdx = anchoredIndices[lastEarlyPos + 1];
        const lastEarlyAnchor = anchors.get(lastEarly);
        const nextAnchor = anchors.get(nextIdx);
        if (lastEarlyAnchor && nextAnchor) {
          const gap = nextAnchor.start - lastEarlyAnchor.end;
          const wordsBetween = Math.max(1, nextIdx - lastEarly);
          if (gap > 3 && gap / wordsBetween > 1.8) {
            for (const idx of early) anchors.delete(idx);
            anchoredIndices = anchoredIndices.filter((idx) => !early.includes(idx));
          }
        }
      }
    }

    const wordTimes = new Array(M);
    for (const idx of anchoredIndices) {
      const a = anchors.get(idx);
      wordTimes[idx] = { start: a.start, end: a.end, confidence: a.confidence };
    }

    const anchoredRates = [];
    for (let a = 0; a < anchoredIndices.length - 1; a++) {
      const i0 = anchoredIndices[a];
      const i1 = anchoredIndices[a + 1];
      if (i1 - i0 <= 16) {
        let syl = 0;
        for (let k = i0; k < i1; k++) syl += flatWords[k].syllables;
        const dt = wordTimes[i1].start - wordTimes[i0].start;
        if (dt > 0.06 && syl > 0) anchoredRates.push(dt / syl);
      }
    }
    anchoredRates.sort((x, y) => x - y);
    const totalSyllables = flatWords.reduce((sum, w) => sum + w.syllables, 0) || M || 1;
    const avgSecPerSyllable = anchoredRates.length > 0
      ? Math.max(0.14, Math.min(0.55, anchoredRates[Math.floor(anchoredRates.length / 2)]))
      : Math.max(0.14, Math.min(0.55, (vocalLast - vocalFirst) / totalSyllables));

    const envData = precomputedOnsets?.env ? precomputedOnsets : null;

    // maps normalized syllable progress [0..1] across [tStart..tEnd] weighting active vocal frames above instrumental floor
    const buildEnergyTimeMapper = (tStart, tEnd) => {
      const span = Math.max(0.05, tEnd - tStart);
      if (!envData || !envData.env || envData.maxEnv <= 1e-6 || span < 0.35) {
        return (u) => tStart + u * span;
      }
      const hopSec = envData.hopSec || 0.02;
      const f0 = Math.max(0, Math.floor(tStart / hopSec));
      const f1 = Math.min(envData.env.length - 1, Math.ceil(tEnd / hopSec));
      const count = f1 - f0 + 1;
      if (count < 4) return (u) => tStart + u * span;

      const activeFloor = envData.activeThresh || envData.maxEnv * 0.1;
      const idleWeight = activeFloor * 0.04;
      const cum = new Float64Array(count + 1);
      for (let idx = 0; idx < count; idx++) {
        const val = envData.env[f0 + idx];
        const w = val >= activeFloor ? (val - activeFloor * 0.5) : idleWeight;
        cum[idx + 1] = cum[idx] + Math.max(idleWeight, w);
      }
      const totalW = cum[count];
      if (totalW <= 0) return (u) => tStart + u * span;

      return (u) => {
        const target = Math.max(0, Math.min(1, u)) * totalW;
        let lo = 0;
        let hi = count;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cum[mid] < target) lo = mid + 1;
          else hi = mid;
        }
        const prevIdx = Math.max(0, lo - 1);
        const segW = Math.max(1e-9, cum[prevIdx + 1] - cum[prevIdx]);
        const frac = lo === 0 ? 0 : Math.max(0, Math.min(1, (target - cum[prevIdx]) / segW));
        const framePos = (prevIdx + frac) / count;
        return tStart + framePos * span;
      };
    };

    const fillSpan = (fromIdx, toIdx, tStart, tEnd, boundedRight = true) => {
      if (fromIdx > toIdx) return;
      let sylSum = 0;
      for (let k = fromIdx; k <= toIdx; k++) {
        sylSum += flatWords[k].syllables;
        if (k > fromIdx && flatWords[k].wordInLine === 0) {
          sylSum += parsedLines[flatWords[k].lineIndex].gapBefore ? 1.8 : 0.7;
        }
      }
      const denom = Math.max(1, sylSum);
      const count = toIdx - fromIdx + 1;
      const safeEnd = boundedRight
        ? Math.max(tStart + 0.03 * count, tEnd)
        : Math.max(tStart + 0.12 * count, tEnd);
      const mapTime = buildEnergyTimeMapper(tStart, safeEnd);
      let sylCursor = 0;
      for (let k = fromIdx; k <= toIdx; k++) {
        if (k > fromIdx && flatWords[k].wordInLine === 0) {
          sylCursor += parsedLines[flatWords[k].lineIndex].gapBefore ? 1.8 : 0.7;
        }
        const wStart = mapTime(sylCursor / denom);
        sylCursor += flatWords[k].syllables;
        const wEnd = mapTime(sylCursor / denom);
        wordTimes[k] = {
          start: wStart,
          end: Math.min(safeEnd, Math.max(wStart + 0.04, wEnd)),
          confidence: 0
        };
      }
    };

    if (anchoredIndices.length === 0) {
      fillSpan(0, M - 1, vocalFirst, vocalLast, false);
    } else {
      const firstAnchorIdx = anchoredIndices[0];
      if (firstAnchorIdx > 0) {
        let prefixSyl = 0;
        for (let k = 0; k < firstAnchorIdx; k++) prefixSyl += flatWords[k].syllables;
        const firstAnchorStart = wordTimes[firstAnchorIdx].start;
        // a quiet gap just before the anchor marks the start of that *phrase*, not the start of the
        // whole lyric. with many prefix words it cannot hold them, and using it crushed an entire
        // verse into the few hundred milliseconds before the drop
        const phraseStart = findPhraseStartBefore(firstAnchorStart, precomputedOnsets);
        const fastestSpan = prefixSyl * 0.12;
        const slowestSpan = prefixSyl * 0.75;
        const phraseSpan = phraseStart !== null ? firstAnchorStart - phraseStart : null;
        const fitsPhrase = phraseSpan !== null
          && phraseSpan >= fastestSpan * 0.6
          && phraseSpan <= slowestSpan * 1.35;
        const startBound = fitsPhrase
          ? Math.max(vocalFirst, phraseStart)
          : Math.max(vocalFirst, firstAnchorStart - slowestSpan);
        fillSpan(0, firstAnchorIdx - 1, Math.min(startBound, firstAnchorStart - 0.2), firstAnchorStart, true);
      }

      for (let a = 0; a < anchoredIndices.length - 1; a++) {
        const leftIdx = anchoredIndices[a];
        const rightIdx = anchoredIndices[a + 1];
        if (rightIdx - leftIdx > 1) {
          fillSpan(leftIdx + 1, rightIdx - 1, wordTimes[leftIdx].end, wordTimes[rightIdx].start, true);
        }
      }

      const lastAnchorIdx = anchoredIndices[anchoredIndices.length - 1];
      if (lastAnchorIdx < M - 1) {
        let suffixSyl = 0;
        for (let k = lastAnchorIdx + 1; k < M; k++) suffixSyl += flatWords[k].syllables;
        const lastEnd = wordTimes[lastAnchorIdx].end;
        const estEnd = Math.min(duration, Math.max(lastEnd + 0.4, lastEnd + suffixSyl * avgSecPerSyllable));
        const endBound = vocalLast > estEnd ? Math.min(vocalLast, estEnd + 1.5) : estEnd;
        fillSpan(lastAnchorIdx + 1, M - 1, lastEnd, endBound, false);
      }
    }

    // snap line boundaries and low-confidence words to 250hz-3.5khz vocal onsets
    for (let k = 0; k < M; k++) {
      const wt = wordTimes[k];
      if (!wt) continue;
      const isLineStart = flatWords[k].wordInLine === 0;
      // a phrase opening gets snapped even when the recognizer was confident: whisper routinely
      // marks a line's first word slightly before the actual attack, which is why the opening
      // word shows up before the sentence starts while the rest of the line reads fine
      if (wt.confidence >= 0.78 && !isLineStart) continue;
      if (onsets.length > 0) {
        const forward = isLineStart
          ? findOnsetForward(wt.start, onsets, { back: 0.02, ahead: 0.3 })
          : findOnsetForward(wt.start, onsets, { back: 0.05, ahead: 0.12 });
        // forward-only snapping could never correct a late estimate, which made opening words
        // arrive after they were sung; fall back to the last onset behind the estimate instead.
        // line starts never fall back — pulling one onto the previous syllable is what made them
        // appear before the sentence began
        const snapped = forward !== null
          ? forward
          : (isLineStart ? null : findOnsetBackward(wt.start, onsets, { back: 0.18 }));
        if (snapped !== null) {
          const prevEnd = k > 0 ? wordTimes[k - 1].end : 0;
          const nextStart = k < M - 1 ? wordTimes[k + 1].start : duration;
          if (snapped >= prevEnd - 0.02 && snapped < nextStart - 0.04) {
            wt.start = Math.max(prevEnd, snapped);
            wt.end = Math.max(wt.start + 0.06, Math.min(wt.end, nextStart));
          }
        }
      }
    }

    // measure each word's length from vocal energy drop-off in raw audio time
    if (precomputedOnsets?.env) {
      for (let k = 0; k < M; k++) {
        const wt = wordTimes[k];
        if (!wt) continue;
        const nextStart = k < M - 1 ? wordTimes[k + 1].start : duration;
        const maxDur = Math.max(0.06, nextStart - wt.start);
        const probeStart = Math.min(duration, Math.max(0, wt.start));
        const probeMaxEnd = Math.min(duration, probeStart + maxDur);
        const fallbackEnd = Math.min(probeMaxEnd, Math.max(probeStart + 0.06, wt.end));
        const measuredEnd = measureWordEndFromEnvelope(
          probeStart,
          fallbackEnd,
          probeMaxEnd,
          precomputedOnsets,
          { syllables: flatWords[k].syllables }
        );
        const measuredDur = Math.max(0.06, Math.min(maxDur, measuredEnd - probeStart));
        wt.end = wt.start + measuredDur;
      }
    }

    // enforce strict monotonic ordering and non-overlap before shifting lead offset
    for (let k = 0; k < M; k++) {
      const wt = wordTimes[k];
      if (!wt) continue;
      if (k > 0 && wordTimes[k - 1]) {
        const prev = wordTimes[k - 1];
        if (wt.start < prev.start + 0.04) {
          wt.start = prev.start + 0.04;
        }
        if (prev.end > wt.start) {
          prev.end = Math.max(prev.start + 0.04, wt.start);
        }
      }
      wt.end = Math.max(wt.start + 0.05, Math.min(duration, wt.end));
    }

    // apply lead offset uniformly across all words after raw-time alignment and envelope probing
    for (let k = 0; k < M; k++) {
      const wt = wordTimes[k];
      if (!wt) continue;
      const shiftedStart = Math.max(0, wt.start - leadSec);
      const shiftedEnd = Math.max(shiftedStart + 0.05, wt.end - leadSec);
      wt.start = shiftedStart;
      wt.end = shiftedEnd;
    }

    // rebuild synced entries strictly monotonically as words or sentences
    const outLines = [];
    let flatCursor = 0;
    for (let li = 0; li < parsedLines.length; li++) {
      const pLine = parsedLines[li];
      const lineWords = [];
      for (let wi = 0; wi < pLine.tokens.length; wi++) {
        const wt = wordTimes[flatCursor] || { start: 0, end: 0.3, confidence: 0 };
        const clampedStart = Math.max(0, wt.start);
        const clampedEnd = Math.max(clampedStart + 0.05, Math.min(duration, wt.end));
        const wordEntry = {
          text: pLine.tokens[wi].text,
          start: Number(clampedStart.toFixed(3)),
          end: Number(clampedEnd.toFixed(3)),
          confidence: Number((wt.confidence || 0).toFixed(2))
        };
        lineWords.push(wordEntry);
        if (granularity === 'words') {
          outLines.push({
            text: wordEntry.text,
            start: wordEntry.start,
            end: wordEntry.end,
            words: [wordEntry]
          });
        }
        flatCursor++;
      }
      if (granularity === 'sentences' && lineWords.length > 0) {
        outLines.push({
          text: joinWordsText(lineWords),
          start: lineWords[0].start,
          end: lineWords[lineWords.length - 1].end,
          words: lineWords
        });
      }
    }

    // lines must not overlap: a few milliseconds of negative gap reads as two lines active at once
    for (let i = 1; i < outLines.length; i++) {
      const prev = outLines[i - 1];
      const cur = outLines[i];
      if (cur.start < prev.end) {
        prev.end = Math.max(prev.start + 0.05, cur.start);
      }
    }

    // coverage tells the studio whether this alignment actually anchored on recognized words or
    // fell back to slicing the lyrics by duration — those two produce very different confidence
    const matchedWords = anchoredIndices.length;
    const matchedRatio = M > 0 ? matchedWords / M : 0;
    const estimated = matchedWords === 0 || matchedRatio < 0.15;

    return {
      mode: 'pasted',
      granularity,
      rawText: rawLyricsText,
      matchedWords,
      totalWords: M,
      estimated,
      lines: outLines
    };
  }

  // a one-2 word line singing for 0.4s cannot carry the same camera move as a two-second phrase:
  // the same amplitude becomes a whip. 0.15..1 by sung length, used by the engine uniform and the
  // regroup preview so both agree on what "too short" means
  function computeLineWeight(durationSec) {
    const dur = Math.max(0, Number(durationSec) || 0);
    return Number((0.15 + 0.85 * Math.min(1, Math.max(0, (dur - 0.3) / 1.2))).toFixed(3));
  }

  const REGROUP_LIMITS = {
    mergeUnderWords: 3,
    maxMergedWords: 10,
    splitOverWords: 7,
    maxMergeGap: 1.2,
    maxSplits: 3
  };
  const TERMINAL_PUNCT = /[.!?…]["'”’)\]]?$/;
  const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'no', 'feat', 'ft', 'prod', 'pt']);

  function wordEndsSentence(text) {
    return TERMINAL_PUNCT.test(String(text || ''));
  }

  function isSentenceBoundaryAfter(words, index) {
    const word = words[index];
    if (!word || !wordEndsSentence(word.text)) return false;
    const raw = String(word.text || '');
    const bare = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (bare && ABBREVIATIONS.has(bare)) return false;
    // a period only ends a sentence when the next word starts a new one. "sly. plenty" is likely a
    // run-on, so leave it whole rather than split on a guess
    if (/\.$/.test(raw.replace(/["'”’)\]]+$/, ''))) {
      const next = words[index + 1];
      if (next && !/^["'“‘(]?[A-Z0-9]/.test(String(next.text || ''))) return false;
    }
    return true;
  }

  function findSentenceCut(words, startWord, endWord) {
    let best = -1;
    let bestBalance = Infinity;
    for (let i = startWord; i < endWord - 1; i++) {
      if (!isSentenceBoundaryAfter(words, i)) continue;
      const left = i + 1 - startWord;
      const right = endWord - (i + 1);
      const leftOk = left >= 2 || (left === 1 && wordEndsSentence(words[i].text));
      if (!leftOk || right < 2) continue;
      const balance = Math.abs(left - right);
      if (balance < bestBalance) {
        bestBalance = balance;
        best = i + 1;
      }
    }
    return best;
  }

  function shouldMergeFragment(words, prev, cur, limits) {
    const prevCount = prev.endWord - prev.startWord;
    const curCount = cur.endWord - cur.startWord;
    if (prevCount + curCount > limits.maxMergedWords) return false;
    const first = words[cur.startWord];
    const lastCur = words[cur.endWord - 1];
    const lastPrev = words[prev.endWord - 1];
    if (!first || !lastCur || !lastPrev) return false;
    // a complete short sentence ("Sly.") is an editorial choice, not a fragment of the line above
    const completeSentence = wordEndsSentence(lastCur.text) && /^["'“‘(]?[A-Z0-9]/.test(String(first.text || ''));
    const fragment = curCount < limits.mergeUnderWords || /^[a-z]/.test(String(first.text || ''));
    if (!fragment || completeSentence) return false;
    if (wordEndsSentence(lastPrev.text)) return false;
    const gap = Number(first.start) - Number(lastPrev.end);
    if (Number.isFinite(gap) && gap > limits.maxMergeGap) return false;
    return true;
  }

  /**
   * Merges lyric fragments into the sentence they belong to and splits overlong lines at sentence
   * boundaries, without touching the pasted text. Returns a preview (before/after + the ops that
   * would run) and a new lyrics object; the caller decides whether to apply it.
   */
  function regroupLyricPhrases(lyricsData, opts = {}) {
    const limits = { ...REGROUP_LIMITS, ...(opts && typeof opts === 'object' ? opts : {}) };
    const lines = Array.isArray(lyricsData?.lines) ? lyricsData.lines : [];
    if (lines.length === 0) return { changed: false, lyrics: lyricsData || null, preview: null };

    const words = [];
    const sourceLines = [];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li] || {};
      const lineWords = Array.isArray(line.words) && line.words.length > 0
        ? line.words
        : [{
          text: String(line.text || '').trim(),
          start: Number(line.start ?? 0),
          end: Number(line.end ?? (Number(line.start ?? 0) + 0.3))
        }];
      const startWord = words.length;
      for (const w of lineWords) {
        const text = String(w?.text || '').trim();
        if (!text) continue;
        const start = Number(w.start ?? 0);
        words.push({ text, start, end: Number(w.end ?? (start + 0.3)) });
      }
      if (words.length > startWord) {
        sourceLines.push({
          index: li,
          text: String(line.text || '').trim() || joinWordsText(words.slice(startWord)),
          start: words[startWord].start,
          end: words[words.length - 1].end,
          startWord,
          endWord: words.length
        });
      }
    }
    if (words.length === 0) return { changed: false, lyrics: lyricsData, preview: null };

    const ops = [];
    let groups = sourceLines.map((s) => ({ startWord: s.startWord, endWord: s.endWord }));

    // split before merging: a line carrying two sentences has to break before a fragment can be
    // recognised as belonging to the second half of it
    for (let pass = 0; pass < limits.maxSplits; pass += 1) {
      let splitDone = false;
      const next = [];
      for (const group of groups) {
        if (group.endWord - group.startWord > limits.splitOverWords) {
          const cut = findSentenceCut(words, group.startWord, group.endWord);
          if (cut > group.startWord && cut < group.endWord) {
            next.push({ startWord: group.startWord, endWord: cut });
            next.push({ startWord: cut, endWord: group.endWord });
            ops.push({ type: 'split', at: cut, text: [joinWordsText(words.slice(group.startWord, cut)), joinWordsText(words.slice(cut, group.endWord))] });
            splitDone = true;
            continue;
          }
        }
        next.push(group);
      }
      groups = next;
      if (!splitDone) break;
    }

    const merged = [];
    for (const group of groups) {
      const prev = merged[merged.length - 1];
      if (prev && shouldMergeFragment(words, prev, group, limits)) {
        prev.endWord = group.endWord;
        ops.push({ type: 'merge', text: joinWordsText(words.slice(prev.startWord, prev.endWord)) });
        continue;
      }
      merged.push({ ...group });
    }
    groups = merged;

    const summarize = (group) => {
      const slice = words.slice(group.startWord, group.endWord);
      const duration = Math.max(0, slice[slice.length - 1].end - slice[0].start);
      return {
        text: joinWordsText(slice),
        start: Number(slice[0].start.toFixed(3)),
        end: Number(slice[slice.length - 1].end.toFixed(3)),
        duration: Number(duration.toFixed(2)),
        words: slice.length,
        weight: computeLineWeight(duration)
      };
    };

    const before = sourceLines.map(summarize);
    const after = groups.map((group) => {
      const entry = summarize(group);
      const sources = sourceLines.filter((s) => s.startWord < group.endWord && s.endWord > group.startWord);
      return {
        ...entry,
        sources: sources.map((s) => {
          const sourceDuration = Math.max(0, s.end - s.start);
          return {
            index: s.index,
            text: s.text,
            start: Number(s.start.toFixed(2)),
            end: Number(s.end.toFixed(2)),
            duration: Number(sourceDuration.toFixed(2)),
            weight: computeLineWeight(sourceDuration)
          };
        })
      };
    });

    const nextLines = groups.map((group) => {
      const slice = words.slice(group.startWord, group.endWord);
      return {
        text: joinWordsText(slice),
        start: slice[0].start,
        end: slice[slice.length - 1].end,
        words: slice.map((w) => ({ ...w }))
      };
    });

    const changed = nextLines.length !== before.length
      || nextLines.some((line, i) => line.text !== before[i]?.text);
    const countOps = (type) => ops.filter((op) => op.type === type).length;

    return {
      changed,
      // the applied result must not claim to be the pasted grouping: switching granularity later
      // would otherwise re-slice rawText and silently restore the line breaks this pass just fixed
      lyrics: { ...lyricsData, mode: 'regrouped', granularity: 'sentences', lines: nextLines },
      preview: {
        before,
        after,
        ops,
        linesBefore: before.length,
        linesAfter: nextLines.length,
        merged: countOps('merge'),
        split: countOps('split'),
        shortLines: after.filter((line) => line.words < 3).length,
        fragmentsLeft: after.filter((line) => line.weight < 0.4).length
      }
    };
  }

  function regroupLyrics(lyricsData, targetGranularity = 'words') {
    const granularity = targetGranularity === 'sentences' ? 'sentences' : 'words';
    if (!lyricsData || !Array.isArray(lyricsData.lines) || lyricsData.lines.length === 0) {
      return lyricsData ? { ...lyricsData, granularity } : lyricsData;
    }

    const flatWords = [];
    for (const line of lyricsData.lines) {
      if (Array.isArray(line?.words) && line.words.length > 0) {
        for (const w of line.words) {
          if (w && w.text) flatWords.push({ ...w });
        }
      } else if (line && line.text) {
        flatWords.push({
          text: line.text,
          start: Number(line.start ?? 0),
          end: Number(line.end ?? (Number(line.start ?? 0) + 0.3))
        });
      }
    }

    if (granularity === 'words') {
      return {
        ...lyricsData,
        granularity,
        lines: wordsToEntries(flatWords)
      };
    }

    if (lyricsData.mode === 'pasted' && lyricsData.rawText) {
      const parsedLines = parsePastedLines(lyricsData.rawText);
      const totalTokens = parsedLines.reduce((sum, pl) => sum + pl.tokens.length, 0);
      if (parsedLines.length > 0 && totalTokens === flatWords.length) {
        const grouped = [];
        let cursor = 0;
        for (const pl of parsedLines) {
          const slice = flatWords.slice(cursor, cursor + pl.tokens.length);
          cursor += pl.tokens.length;
          if (slice.length > 0) {
            grouped.push({
              text: joinWordsText(slice),
              start: slice[0].start,
              end: slice[slice.length - 1].end,
              words: slice.map((w) => ({ ...w }))
            });
          }
        }
        return {
          ...lyricsData,
          granularity,
          lines: grouped
        };
      }
    }

    return {
      ...lyricsData,
      granularity,
      lines: groupWordsIntoLines(flatWords)
    };
  }

  function getLyricsFrameAt(lyricsData, time = 0) {
    const lines = Array.isArray(lyricsData?.lines) ? lyricsData.lines : [];
    if (lines.length === 0) {
      return {
        hasLyrics: false,
        lines: [],
        activeLineIndex: -1,
        line: '',
        prevLine: '',
        nextLine: lines[0]?.text || '',
        lineStart: 0,
        lineEnd: 0,
        lineAge: 0,
        nextLineStart: null,
        nextIn: null,
        travel: 0,
        lineDuration: 0,
        lineWords: 0,
        lineWeight: 1,
        holdLines: Boolean(lyricsData?.holdLines),
        held: false,
        heldFor: 0,
        progress: 0,
        word: '',
        activeWordIndex: -1,
        wordProgress: 0,
        wordHit: 0,
        words: []
      };
    }

    const lineBounds = lines.map((l) => {
      const ws = Array.isArray(l?.words) ? l.words : [];
      let effStart = Number(l?.start ?? 0);
      let effEnd = Number(l?.end ?? effStart);
      for (let w = 0; w < ws.length; w++) {
        const wsStart = Number(ws[w]?.start);
        const wsEnd = Number(ws[w]?.end);
        if (Number.isFinite(wsStart) && wsStart < effStart) effStart = wsStart;
        if (Number.isFinite(wsEnd) && wsEnd > effEnd) effEnd = wsEnd;
      }
      return { effStart, effEnd: Math.max(effStart, effEnd), words: ws };
    });

    // monotonic accumulated lyric travel: one unit per line walked through in real time, holding
    // during gaps. a 0-to-1 envelope (sin(pi*progress)) multiplies motion to nothing and back, which
    // reverses any travel coordinate it is added to; this one only ever moves forward
    let lineTravel = 0;
    for (let i = 0; i < lineBounds.length; i++) {
      const span = Math.max(0.02, lineBounds[i].effEnd - lineBounds[i].effStart);
      lineTravel += Math.min(1, Math.max(0, (time - lineBounds[i].effStart) / span));
    }

    const findActiveWordInList = (words, activeLineGraceEnd) => {
      let bestIdx = -1;
      let bestStart = -Infinity;
      let maxStart = -Infinity;
      for (let j = 0; j < words.length; j++) {
        const s = Number(words[j]?.start ?? 0);
        if (s > maxStart) maxStart = s;
      }
      for (let w = 0; w < words.length; w++) {
        const wStart = Number(words[w]?.start ?? 0);
        const wEnd = Number(words[w]?.end ?? wStart);
        let nextWordStart = Infinity;
        for (let j = 0; j < words.length; j++) {
          if (j === w) continue;
          const otherStart = Number(words[j]?.start ?? 0);
          if (otherStart > wStart && otherStart < nextWordStart) {
            nextWordStart = otherStart;
          }
        }
        const wordGraceEnd = words.length === 1
          ? activeLineGraceEnd
          : Math.min(wEnd + 0.08, nextWordStart);
        const isLastWord = wStart === maxStart;
        if (time >= wStart && (time < wordGraceEnd || (isLastWord && time <= wordGraceEnd))) {
          if (wStart >= bestStart) {
            bestStart = wStart;
            bestIdx = w;
          }
        }
      }
      return bestIdx;
    };

    let maxLineStart = -Infinity;
    for (let i = 0; i < lineBounds.length; i++) {
      if (lineBounds[i].effStart > maxLineStart) maxLineStart = lineBounds[i].effStart;
    }

    // "connect words": keep the last sung line on screen through the gap instead of clearing it,
    // so the text holds until the next line starts. the line keeps its sung bounds, so weight,
    // progress and word state still describe the performance — only visibility changes.
    const holdLines = Boolean(lyricsData?.holdLines);

    let activeLineIndex = -1;
    let bestLineScore = -Infinity;
    let bestLineHasWord = false;
    for (let i = 0; i < lines.length; i++) {
      const b = lineBounds[i];
      let nextLineStart = Infinity;
      for (let j = 0; j < lineBounds.length; j++) {
        if (j === i) continue;
        if (lineBounds[j].effStart > b.effStart && lineBounds[j].effStart < nextLineStart) {
          nextLineStart = lineBounds[j].effStart;
        }
      }
      const lineGraceEnd = Math.min(b.effEnd + 0.12, nextLineStart);
      const isLastLine = b.effStart === maxLineStart;
      const visible = holdLines
        ? true
        : (time < lineGraceEnd || (isLastLine && time <= lineGraceEnd));
      if (time >= b.effStart && visible) {
        const matchedWordIdx = findActiveWordInList(b.words, lineGraceEnd);
        const hasWord = matchedWordIdx >= 0;
        if ((hasWord && !bestLineHasWord) || (hasWord === bestLineHasWord && b.effStart >= bestLineScore)) {
          bestLineHasWord = hasWord;
          bestLineScore = b.effStart;
          activeLineIndex = i;
        }
      }
    }

    if (activeLineIndex < 0) {
      let prevIdx = -1;
      let prevStart = -Infinity;
      let nextIdx = -1;
      let nextStart = Infinity;
      for (let i = 0; i < lineBounds.length; i++) {
        const s = lineBounds[i].effStart;
        if (s < time && s >= prevStart) {
          prevStart = s;
          prevIdx = i;
        }
        if (s > time && s < nextStart) {
          nextStart = s;
          nextIdx = i;
        }
      }
      return {
        hasLyrics: true,
        lines,
        activeLineIndex: -1,
        line: '',
        prevLine: prevIdx >= 0 ? lines[prevIdx].text : '',
        nextLine: nextIdx >= 0 ? lines[nextIdx].text : '',
        lineStart: 0,
        lineEnd: 0,
        lineAge: 0,
        nextLineStart: nextIdx >= 0 ? lineBounds[nextIdx].effStart : null,
        nextIn: nextIdx >= 0 ? Math.max(0, lineBounds[nextIdx].effStart - time) : null,
        travel: lineTravel,
        lineDuration: 0,
        lineWords: 0,
        lineWeight: 1,
        holdLines: Boolean(lyricsData?.holdLines),
        held: false,
        heldFor: 0,
        progress: 0,
        word: '',
        activeWordIndex: -1,
        wordProgress: 0,
        wordHit: 0,
        words: []
      };
    }

    const active = lines[activeLineIndex];
    const activeBounds = lineBounds[activeLineIndex];
    const lineSpan = Math.max(0.05, activeBounds.effEnd - activeBounds.effStart);
    const progress = Math.max(0, Math.min(1, (time - activeBounds.effStart) / lineSpan));
    const held = holdLines && time > activeBounds.effEnd + 0.12;
    const heldFor = held ? Number((time - (activeBounds.effEnd + 0.12)).toFixed(2)) : 0;
    // a one-word fragment singing for 0.4s cannot carry the same move as a two-second phrase: the
    // same amplitude becomes a whip. 0.15..1 by sung length, 1 in gaps so multiplying is always safe.
    const lineWeight = computeLineWeight(lineSpan);
    const lineWords = Array.isArray(activeBounds.words) && activeBounds.words.length > 0
      ? activeBounds.words.length
      : String(active?.text || '').split(/\s+/).filter(Boolean).length;
    const words = activeBounds.words;
    let nextActiveLineStart = Infinity;
    for (let j = 0; j < lineBounds.length; j++) {
      if (j === activeLineIndex) continue;
      if (lineBounds[j].effStart > activeBounds.effStart && lineBounds[j].effStart < nextActiveLineStart) {
        nextActiveLineStart = lineBounds[j].effStart;
      }
    }
    const activeLineGraceEnd = Math.min(activeBounds.effEnd + 0.12, nextActiveLineStart);

    const activeWordIndex = findActiveWordInList(words, activeLineGraceEnd);

    let word = '';
    let wordProgress = 0;
    let wordHit = 0;
    if (activeWordIndex >= 0) {
      const aw = words[activeWordIndex];
      word = aw.text || '';
      const wSpan = Math.max(0.04, aw.end - aw.start);
      const dt = Math.max(0, time - aw.start);
      wordProgress = Math.max(0, Math.min(1, dt / wSpan));
      wordHit = Number(Math.exp(-dt * 9).toFixed(4));
    }

    return {
      hasLyrics: true,
      lines,
      activeLineIndex,
      line: active.text || '',
      prevLine: activeLineIndex > 0 ? lines[activeLineIndex - 1].text : '',
      nextLine: activeLineIndex + 1 < lines.length ? lines[activeLineIndex + 1].text : '',
      lineStart: active.start,
      lineEnd: active.end,
      // effective bounds and the next line's start drive lyric-locked motion (u_lyric_*): the raw
      // line.start can lead its first word, so a camera keyed to it arrives early
      lineEffStart: activeBounds.effStart,
      lineAge: Math.max(0, time - activeBounds.effStart),
      nextLineStart: Number.isFinite(nextActiveLineStart) ? nextActiveLineStart : null,
      nextIn: Number.isFinite(nextActiveLineStart) ? Math.max(0, nextActiveLineStart - time) : null,
      travel: lineTravel,
      lineDuration: Number(lineSpan.toFixed(3)),
      lineWords,
      lineWeight,
      holdLines,
      held,
      heldFor,
      progress,
      word,
      activeWordIndex,
      wordProgress,
      wordHit,
      words
    };
  }

  window.lyricsService = {
    transcribeWithBrowserWhisper,
    getWhisperCacheStatus,
    transcribeWithCloudApi,
    encodeAudioBufferToWavBlob,
    extractVocalOnsets,
    measureWordEndFromEnvelope,
    alignPastedLyricsToAudio,
    groupWordsIntoLines,
    regroupLyrics,
    regroupLyricPhrases,
    computeLineWeight,
    getLyricsFrameAt,
    tokenSimilarity,
    normalizePhonetic,
    cleanWordText,
    filterHallucinatedWords
  };
})();
