# Stream Captions

Real-time subtitles for **any video or music on any site** — built first for
**Kick**, and working out of the box on **Twitch** and **YouTube** too. Speech
recognition runs **fully on-device** with
[Whisper](https://github.com/openai/whisper) via
[transformers.js](https://github.com/huggingface/transformers.js) (WebGPU, WASM
fallback). No server, no API key, no per-minute cost, nothing leaves your
machine.

Because it taps the audio that's *already playing in the tab*, the same code
handles **live streams, VODs, and music** — it just transcribes whatever's
playing. For audio-only pages (music), captions float at the bottom of the page;
for video, they overlay the player.

## Why not Google Speech-to-Text?
Google's STT is only free for 60 min/month, then billed per minute. Whisper is
free, unlimited, and MIT-licensed (fine for commercial use). The only cost is
your own compute.

## Install (from source)
```bash
cd stream-captions
npm install
npm run setup   # copies transformers.js + ONNX runtime into vendor/
```

Then load it in Chrome:
1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder
4. Open a Kick / Twitch / YouTube stream or VOD, click the extension icon, flip
   **Captions** on.

First activation downloads the Whisper model (cached afterward). Give it a few
seconds, then captions appear over the player.

## Site access
The extension runs automatically on **kick.com**, **twitch.tv** and
**youtube.com**. It requests no other site access at install time.

For any other site, open the popup and click **Enable on this site** — Chrome
asks for permission for that one site, the overlay is injected immediately, and
the choice is remembered for future visits. Revoke it whenever you like from
`chrome://extensions`.

## How it works
```
content script (overlay.js)
  ├─ finds the player <video>/<audio>
  ├─ AudioContext + MediaElementSource  → speakers (playback untouched)
  │                                      → AudioWorklet (capture-worklet.js)
  ├─ Whisper via transformers.js (WebGPU → WASM fallback), on this thread
  │    └─ local-agreement streaming: a word locks once two passes agree
  └─ overlay <div> renders a two-line "lens" the transcript scrolls through
```
Inference runs on the content-script thread rather than in a Worker because
content scripts can't construct a Worker from an extension URL.

## Settings (popup)
- **Captions** — on/off, per tab
- **Language** — English (the engine already handles the full multilingual set
  and translate-to-English; the picker doesn't expose them yet)
- **Model** — tiny (fastest) / base / small (most accurate), switches on the fly
- **Position** — which corner the overlay sits in

## Privacy
Nothing is collected or transmitted. Audio and transcripts stay in memory on
your device and are discarded as you go. See [PRIVACY.md](PRIVACY.md).

## Status / roadmap
Working:
- [x] On-device transcription overlay for Kick, Twitch, YouTube (live & VOD)
- [x] Any other site via per-site opt-in
- [x] Model switching, overlay position, streaming word-lock display
- [x] ONNX runtime + transformers.js vendored locally (no remotely hosted code)

Planned:
- [ ] Expose the multilingual picker + translate-to-English (engine already does both)
- [ ] Timestamp-accurate audio trimming (currently trims by word-count fraction)
- [ ] Real VAD instead of an RMS gate, so music/noise stops triggering hallucinations
- [ ] `.srt` / `.vtt` export for VODs
- [ ] Caption styling controls (size, opacity, line count)
- [ ] Keyboard shortcut to toggle without opening the popup

## Notes & limitations
- **WebGPU** gives near-real-time on `tiny`/`base`; WASM-only is much slower.
- **Live latency** is a few seconds. Use `tiny`/`base` for live.
- Sentence trimming currently assumes a roughly constant speaking rate, so a long
  mid-utterance pause can smear a line. Timestamp-based trimming is the fix.
- Sites that serve media cross-origin without CORS headers produce silence —
  `createMediaElementSource` can't read those samples. Kick, Twitch and YouTube
  all use MSE, so they're fine.
- **Legal:** Whisper's license is clean for commercial use, but re-publishing
  *other people's* stream content has Kick/Twitch ToS and copyright implications
  independent of the transcription tech. Fine for personal use or your own channels.

## License
MIT
