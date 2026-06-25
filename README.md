# Stream Captions

Real-time **multilingual subtitles** for **any video or music on any site** —
built first for **Kick** (and Twitch), but it works on any `<video>` or
`<audio>` element anywhere. Speech-to-text runs **fully on-device** with
[Whisper](https://github.com/openai/whisper) via
[transformers.js](https://github.com/huggingface/transformers.js) (WebGPU, WASM
fallback). No server, no API key, no per-minute cost.

Because it taps the audio that's *already playing in the tab*, the same code
handles **live streams, VODs, and music** — it just transcribes whatever's
playing. For audio-only pages (music), captions float at the bottom of the page;
for video, they overlay the player.

## Why not Google Speech-to-Text?
Google's STT is only free for 60 min/month, then billed per minute. Whisper is
free, unlimited, and MIT-licensed (fine for commercial use). The only cost is
your own compute.

## Setup
```bash
cd stream-captions
npm install
npm run setup   # copies transformers.js into vendor/
```

Then load it in Chrome:
1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder
4. Open a Twitch or Kick stream/VOD, click the extension icon, flip **Captions** on.

First activation downloads the Whisper model (cached afterward). Give it a few
seconds, then captions appear over the player.

## How it works
```
content script (overlay.js)
  ├─ finds the player <video>
  ├─ AudioContext + MediaElementSource  → speakers (playback untouched)
  │                                      → AudioWorklet (capture-worklet.js)
  └─ overlay <div> renders captions
                │ PCM batches
                ▼
whisper-worker.js (module Web Worker)
  ├─ resample → 16kHz mono
  ├─ transformers.js Whisper (WebGPU → WASM fallback)
  └─ posts caption text back to the overlay
```

## Settings (popup)
- **Captions** — on/off
- **Language** — auto-detect or pick one (multilingual model)
- **Output** — original language, or translate-to-English
- **Model** — tiny (fastest) / base / small (most accurate). Reload the tab after changing.

## Status / roadmap
Working v1:
- [x] On-device multilingual transcription overlay for Twitch + Kick (live & VOD)
- [x] Language / translate / model controls

Planned:
- [ ] `.srt` / `.vtt` export for VODs
- [ ] Overlapping windows + VAD (avoid cutting words at 5s boundaries)
- [ ] Caption styling controls (size, position)
- [ ] Bundle ONNX WASM locally for Chrome Web Store submission (see below)

## Notes & limitations
- **WebGPU** gives near-real-time on `tiny`/`base`; WASM-only is much slower.
- **Live latency** is a few seconds (window-based). Use `tiny`/`base` for live.
- v1 uses non-overlapping 5s windows, so words can occasionally be clipped at the
  boundary — fine for gist, to be improved with VAD.
- **Web Store submission:** transformers.js pulls model weights (data, OK) and
  ONNX runtime `.wasm` from a CDN by default. For store policy you should vendor
  the `.wasm` files locally and set `env.backends.onnx.wasm.wasmPaths` to a local
  path. Fine as-is for local/dev use.
- **Legal:** Whisper's license is clean for commercial use, but pulling and
  re-publishing *other people's* stream content has Twitch/Kick ToS and copyright
  implications independent of the transcription tech. Fine for personal use or
  your own channels.
