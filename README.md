# SampleVis

A desktop audio and MIDI reel studio. Drop in a track, optionally an Ableton `.als` or a `.mid` file, and build 9:16 reels, 16:9 visuals and 1:1 covers with WebGL shaders, Canvas 2D overlays, synced lyrics and video clips — then export an MP4 locally.

Audio decoding, MIDI parsing, speech recognition for lyrics, rendering and export all run on your machine. Nothing is uploaded: presets and samples stay on your disk, and reference clips are cached in the browser.

## requirements

- Node 20 or newer, for the local runtime and the packaging step
- a Chromium-based browser with WebCodecs for the browser runtime, or the Electron build
- no ffmpeg, no account, no network after `npm install`

## run it

```
npm install
npm start          # studio at http://localhost:3450
npm run electron   # desktop window
npm run dist       # package an installer with electron-builder
```

`npm start` runs the reference Node/Express runtime in `server.js`, which is the quickest way to iterate on the studio without packaging. The shipped target is the Electron app.

## features

- **three-box presets** — a WebGL fragment shader (with an optional post-processing pass), a 60 fps Canvas 2D overlay, and a control schema that generates the inspector. Presets are portable JSON and apply to any song.
- **musical analysis** — chord detection from MIDI or `.als`, bar-aligned drop detection, structural sections, and per-track note data for piano rolls and note-triggered motion.
- **lyrics** — transcribe with Whisper in the browser, or paste lyrics and align them to the vocal, then edit words and phrase grouping on the timeline.
- **clips** — fetch reference clips or upload your own, with cut modes on chord, bar, impact or custom cues, plus trim, speed and playlist ordering.
- **export** — 60 fps H.264 MP4 at 1080×1920, 1920×1080 or 1080×1080, muxed in the browser with WebCodecs.
- **design assistant** — optional, and bring your own API key. It edits the open preset and runs entirely through your provider.
- **project bundles** — `.samplevis.zip` carries a project's preset, media and timing between machines.

## project layout

```
public/            studio UI, engine, presets, self-hosted fonts
public/fonts/      13 OFL families, latin + latin-ext subsets
src/parsers/       .wav, .als and .mid parsing
src/media/         clip fetching and the stream proxy
src/presets/       preset validation
electron/          desktop wrapper (app:// protocol, file associations)
tests/             node-only checks, run with npm test
```

In Electron, presets are written to `~/Documents/SampleVis/Presets/`. Running the Node runtime writes them to `data/presets/custom/`.

## fonts

Typography is self-hosted, so the app makes no third-party font request. To regenerate the stylesheet and the manifest the inspector and renderer read:

```
npm run fonts:sync
```

## clips

Clips are links, not files. `data/anime-library.json` records each cut's source url and the studio streams it through the local `/api/clips/stream` proxy, then caches the bytes in the browser's IndexedDB on first play. Nothing is written to `data/anime-clips`, and no footage ships with the app.

If the catalog loses a source url, `npm run fetch-clips` re-resolves it from the origin (metadata only, no downloads).

## tests

```
npm test
```

The suite is plain Node — parser round-trips, preset validation, control wiring, shader contracts, lyric alignment and regrouping, render telemetry thresholds, and bundle persistence.

## license

MIT. See [LICENSE](LICENSE).
