# SampleVis

> In-browser audio & MIDI reel studio with client-side WebGL fragment shaders, Canvas 2D overlays, and hardware WebCodecs GPU rendering.

SampleVis transforms audio samples, stems, and Ableton projects into vertical 9:16 reels and 16:9 widescreen visuals entirely inside your browser. No server-side media processing, zero cloud tracking, and zero framework bloat.

---

## Features

- **Dual-Layer Composite Engine:** WebGL fragment shader background (`shaderBox`) composited with a 60 FPS Canvas 2D overlay (`frontUiBox`), driven by a dynamic controls schema (`controlsBox`).
- **100% In-Browser Audio & Project Parsing:**
  - Drag and drop `.wav` audio alongside Ableton Live Sets (`.als`) or standard MIDI files (`.mid`).
  - `.als` projects are decompressed and parsed in browser memory via native `DecompressionStream('gzip')` and `DOMParser` without server uploads.
  - Automatic tempo detection, 240-point RMS peak extraction, bar-aligned drop detection, and MIDI chord onset extraction.
- **Hardware-Accelerated WebCodecs Export:** Deterministic 60 FPS MP4 rendering directly in the browser using `VideoEncoder` + `AudioEncoder` + `mp4-muxer`. Zero load on server CPU.
- **Flexible Aspect Ratios:** Toggle smoothly between `9:16` vertical reels (1080×1920) and `16:9` widescreen visuals (1920×1080).
- **Built-in Starter Presets:**
  - **Constellations:** Shinkai needle starbursts, celestial stardust drift, dynamic chord-switched video drops, and bottom liquid glass piano roll.
  - **Cinematic Minimal:** Tokyo letterbox anamorphic matte bars, recording telemetry HUD, and audio-reactive spectrum waveforms.
  - **Anime Chord Flow:** Kinetic typography HUD, chord badge indicators, and GLSL chromatic aberration glitch transitions synced to harmonic changes.
- **Bring Your Own Key (BYOK) AI:** Connect your personal OpenAI-compatible API key (DeepInfra, OpenRouter, OpenAI, Groq, Ollama) directly in the browser settings. Keys remain strictly local in your browser's `localStorage`.

---

## Quick Start

### Prerequisites
- Node.js >= 20.0.0

### Run Locally

```bash
# Clone the repository
git clone https://github.com/finnkolja-byte/samplevis.git
cd samplevis

# Install dependencies and start server
npm install
npm start
```

Open [http://localhost:3450](http://localhost:3450) in your browser.

### Docker Deployment

```bash
docker compose up -d
```

---

## Preset Architecture (3-Box Engine)

Visual presets are portable JSON objects (`ReelPreset`) consisting of:
1. `shaderBox`: A GLSL fragment shader receiving audio spectrum (`u_fft`), amplitude bands (`u_bass`, `u_mid`, `u_high`, `u_rms`), MIDI note impulses (`u_note_hit`), and video textures (`u_video_tex`).
2. `frontUiBox`: Two-stage script execution:
   - `initScript`: Analyzes audio and MIDI data on load to set up custom state.
   - `drawScript`: 60 FPS Canvas 2D drawing routine layered over the WebGL background.
3. `controlsBox`: Dynamic schema generating sidebar controls (sliders, colors, toggles) mapped to shader uniforms and overlay variables.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
