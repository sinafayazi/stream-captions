# Privacy Policy — Stream Captions

**Last updated: 1 August 2026**

Stream Captions does not collect, transmit, store, or sell any personal data.

## What the extension does with audio

Captions are produced entirely on your own device. The extension taps the audio
of a video or audio element already playing in your tab, converts it to raw
samples in memory, and runs speech recognition locally using
[Whisper](https://github.com/openai/whisper) via
[transformers.js](https://github.com/huggingface/transformers.js).

- Audio is **never uploaded** to any server.
- Audio is held in memory only for the few seconds needed to transcribe it, and
  is discarded immediately afterwards. Nothing is written to disk.
- Transcripts are **never uploaded** and are not saved. They exist only in the
  page overlay and disappear when you turn captions off, navigate away, or close
  the tab.

There is no analytics, no telemetry, no tracking, no advertising, and no
third-party SDK of any kind in this extension.

## Network connections

The extension makes exactly one kind of network request: on first use it
downloads the Whisper speech-recognition model files from the Hugging Face CDN
(`huggingface.co`). These are model weights only — no information about you,
your browsing, or your audio is included in the request beyond what any normal
file download requires (your IP address and browser user-agent, as seen by
Hugging Face under their own privacy policy).

The model is then cached by your browser, so subsequent use is fully offline.

The popup contains a donation link to NOWPayments. Its button image is bundled
inside the extension rather than hot-linked, so simply opening the popup contacts
nobody. If — and only if — you click it, a normal browser tab opens to
`nowpayments.io`, at which point their site and privacy policy apply. Nothing
about you or your use of the extension is passed along.

## What is stored

The extension stores your preferences — caption language, model size, and
overlay position — using Chrome's `storage.sync` API. If you are signed into
Chrome, these settings sync across your own devices via your Google account, the
same as your bookmarks. They contain no personal information and no transcript
content. You can erase them at any time by removing the extension.

## Permissions and why they are needed

- **`storage`** — save the preferences described above.
- **`activeTab`** and **`scripting`** — place the caption overlay into the tab
  you are currently watching, when you ask for it.
- **Site access on kick.com and twitch.tv** — run the caption overlay
  automatically on those sites.
- **Optional access to other sites** — only granted when you explicitly click
  "Enable on this site" for a specific site, and revocable at any time from
  Chrome's extension settings.

## Contact

Questions or concerns: open an issue at
<https://github.com/sinafayazi/stream-captions/issues>.
