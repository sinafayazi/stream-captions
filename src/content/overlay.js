// Content script: finds the player <video>/<audio>, taps its audio, transcribes
// it with Whisper (loaded in-page via dynamic import of transformers.js), and
// renders captions as a fixed two-line "lens" that the transcript scrolls
// through (YouTube-style). We run inference here rather than in a Worker because
// content scripts can't construct a Worker from an extension URL.
//
// Captions are per-tab: each tab starts disabled and is toggled independently
// from the popup (the on/off state is not synced across tabs).
(() => {
  // This script arrives three ways: the declared content script (Kick/Twitch),
  // an on-demand scripting.executeScript from the popup, and the dynamic
  // registration that persists that opt-in. They share one isolated world, so
  // bail if we're already running here.
  if (window.__streamCaptionsLoaded) return;
  window.__streamCaptionsLoaded = true;

  const DEFAULTS = {
    enabled: false,
    language: 'english',
    model: 'Xenova/whisper-tiny',
    task: 'transcribe',
    position: 'bottom-center',
  };
  let settings = { ...DEFAULTS };

  const TARGET_SR = 16000;
  const STEP_MS = 500;            // min interval between interim re-transcriptions
  const MIN_AUDIO_SEC = 1.0;      // don't transcribe less than this (Whisper hallucinates)
  const HOLD_TAIL = 2;            // trailing words kept revisable even once agreed
  const MAX_UTTERANCE_SEC = 6;    // force-commit a run-on with no pause/sentence break
  const SILENCE_RMS = 0.008;      // audio level below this counts as silence
  const SILENCE_COMMIT_MS = 600;  // this much trailing silence finalizes the line
  const SILENCE_MARK_MS = 1500;   // ...and this much more replaces it with the silence marker
  const SEEK_JUMP_SEC = 2;        // playhead move above this is a real seek, not a live-edge nudge
  const SEG_MODEL = 'onnx-community/pyannote-segmentation-3.0';
  const SPEAKER_CONF = 0.5;       // ignore low-confidence speaker boundaries
  const SEG_MIN_SEC = 2;          // don't look for a turn in less audio than this
  const SEG_EVERY_MS = 1000;      // ...and at most this often, it's a second model per pass
  const HIDE_AFTER_MS = 4000;     // after this much inactivity, the box floats up & fades
  const HISTORY_CAP = 280;        // max chars of scrolled-back transcript kept

  const POS_CLASS = {
    'bottom-center': 'sc-pos-bc',
    'bottom-left': 'sc-pos-bl',
    'bottom-right': 'sc-pos-br',
    'top-center': 'sc-pos-tc',
  };

  const SPACE = ' ';
  const MUSIC_MARK = '♪ Music';
  const SILENCE_MARK = '···';

  let audioCtx = null;
  let workletNode = null;
  let muteGain = null;
  let captureSource = null;
  let hookedVideo = null;

  // Overlay DOM.
  let overlayEl = null;
  let textEl = null;
  let lensEl = null;
  let scrollEl = null;
  let finalSpan = null;
  let tentSpan = null;
  let overlayFloating = false;
  let lastSig = null;
  let hideTimer = null;

  // Whisper engine state (runs on this thread).
  let transcriber = null;
  let engineLoading = false;
  let device = 'unknown';

  // Speaker segmentation, loaded after Whisper so it never delays first captions.
  let segmenter = null;
  let segLoading = false;
  let lastSegAt = 0;

  // Streaming state.
  let pending = new Float32Array(0); // audio for the in-progress utterance (16kHz)
  let interim = '';                  // latest full hypothesis (for commit)
  let history = '';                  // finalized transcript that has scrolled back
  let prevHyp = [];                  // previous pass's words (for agreement)
  let displayed = [];                // [{text, final}] words of the current utterance
  let lastRunAt = 0;
  let silenceMs = 0;
  let processing = false;
  let mediaTime = 0;                 // playhead as of the last audio chunk, to size seeks

  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

  // ---- overlay rendering -------------------------------------------------
  function ensureOverlay(media) {
    if (overlayEl && overlayEl.isConnected) return;

    overlayEl = document.createElement('div');
    textEl = document.createElement('div');
    textEl.className = 'sc-text sc-hidden';
    lensEl = document.createElement('div');
    lensEl.className = 'sc-lens';
    scrollEl = document.createElement('div');
    scrollEl.className = 'sc-scroll';
    scrollEl.dir = 'auto'; // bidi: renders Persian/Arabic etc. right-to-left
    finalSpan = document.createElement('span');
    tentSpan = document.createElement('span');
    tentSpan.className = 'sc-tent';
    scrollEl.append(finalSpan, tentSpan);
    lensEl.appendChild(scrollEl);
    textEl.appendChild(lensEl);
    overlayEl.appendChild(textEl);

    overlayFloating = media.tagName !== 'VIDEO';
    const host = overlayFloating ? document.body : media.parentElement || document.body;
    if (!overlayFloating && getComputedStyle(host).position === 'static') host.style.position = 'relative';
    applyPosition();
    host.appendChild(overlayEl);
  }

  function applyPosition() {
    if (!overlayEl) return;
    const cls = ['sc-overlay'];
    if (overlayFloating) cls.push('sc-overlay-floating');
    cls.push(POS_CLASS[settings.position] || POS_CLASS['bottom-center']);
    overlayEl.className = cls.join(SPACE);
  }

  // Keep the transcript top-aligned while it fits two lines; once it's taller,
  // scroll the newest text up into view (smoothly, via CSS transition).
  function updateScroll() {
    if (!lensEl || !scrollEl) return;
    const offset = Math.min(0, lensEl.clientHeight - scrollEl.scrollHeight);
    scrollEl.style.transform = `translateY(${offset}px)`;
  }

  function render() {
    if (!overlayEl) return;
    let fp = 0;
    while (fp < displayed.length && displayed[fp].final) fp++;
    const finalWords = displayed.slice(0, fp).map((d) => d.text).join(SPACE);
    const tentWords = displayed.slice(fp).map((d) => d.text).join(SPACE);
    const sig = history + '\n' + finalWords + '\n' + tentWords;
    if (sig === lastSig) { bumpHide(); return; }

    const whole = joinText(history, finalWords);
    finalSpan.textContent = whole;
    tentSpan.textContent = tentWords ? (whole ? SPACE : '') + tentWords : '';

    const has = whole || tentWords;
    textEl.classList.toggle('sc-hidden', !has);
    requestAnimationFrame(updateScroll);
    lastSig = sig;
    bumpHide();
  }

  function setStatus(msg) {
    if (!overlayEl) return;
    finalSpan.textContent = msg;
    tentSpan.textContent = '';
    lastSig = '\n\n';
    textEl.classList.remove('sc-hidden');
    requestAnimationFrame(updateScroll);
  }

  // Non-speech state (music playing, or nothing at all). Rendered like a caption
  // but kept out of the transcript, so it never scrolls into the history.
  //
  // keepAlive holds the marker on screen while the condition lasts — right for
  // music, wrong for silence, which should fade away like any other inactivity.
  function showMarker(mark, keepAlive) {
    if (!overlayEl) return;
    if (finalSpan.textContent === mark) {
      if (keepAlive) bumpHide();
      return;
    }
    finalSpan.textContent = mark;
    tentSpan.textContent = '';
    lastSig = null; // force a full re-render when speech resumes
    textEl.classList.remove('sc-hidden');
    requestAnimationFrame(updateScroll);
    bumpHide();
  }

  function bumpHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (textEl) textEl.classList.add('sc-hidden'); }, HIDE_AFTER_MS);
  }

  // Join two runs of transcript, respecting a pending speaker break.
  const joinText = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    return a.endsWith('\n') ? a + b : a + SPACE + b;
  };

  function pushHistory(text) {
    if (!text) return;
    history = joinText(history, text);
    if (history.length > HISTORY_CAP) history = history.slice(-HISTORY_CAP);
  }

  // Speaker changed: put the next line on its own row, the way captions
  // conventionally separate turns. The lens is pre-wrap, so \n is a real break.
  function breakLine() {
    if (history && !history.endsWith('\n')) history += '\n';
  }

  // ---- whisper engine ----------------------------------------------------
  function resampleTo16k(input, srcRate) {
    if (srcRate === TARGET_SR) return input;
    const ratio = TARGET_SR / srcRate;
    const outLen = Math.max(1, Math.round(input.length * ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = i / ratio;
      const i0 = Math.floor(idx);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const frac = idx - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  }

  function rms(buf) {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / Math.max(1, buf.length));
  }

  // Whisper narrates non-speech instead of staying quiet, and the annotations
  // fall into three groups we treat differently:
  //
  //   [BLANK_AUDIO], [silence], [static]  — nothing is happening. Drop it.
  //   [Music], (upbeat music), ♪♪♪        — worth telling the viewer about, the
  //                                         way broadcast captions do. Show ♪.
  //   ♪ lyrics ♪, (singing) lyrics        — actual sung words. Keep the words.
  //
  // Anything bracketed that isn't stage-direction vocabulary is speech the model
  // parenthesised, so keep the words and drop only the brackets.
  const MUSIC_WORDS = [
    'music', 'musical', 'instrumental', 'song', 'melody', 'theme', 'jingle',
    'upbeat', 'soft', 'gentle', 'dramatic', 'tense', 'somber', 'playful', 'slow',
    'singing', 'sings', 'humming', 'hums', 'vocalizing', 'whistling',
    'playing', 'continues', 'fades', 'in', 'out', 'background',
  ];
  const OTHER_NON_SPEECH_WORDS = [
    'blank', 'audio', 'silence', 'silent', 'no', 'sound', 'none',
    'applause', 'clapping', 'cheering', 'cheers', 'crowd', 'laughter', 'laughs',
    'laughing', 'inaudible', 'indistinct', 'unintelligible', 'crosstalk',
    'noise', 'static', 'beep', 'beeping', 'chime', 'buzzer', 'sighs', 'coughs',
    'coughing', 'breathing', 'footsteps', 'wind', 'rain', 'thunder', 'engine',
    'speaking', 'foreign', 'language', 'non', 'english', 'translated',
  ];
  const vocabRx = (words) => new RegExp(
    '^(?:[^\\p{L}\\p{N}]|\\d|\\b(?:' + words.join('|') + ')\\b)+$', 'iu');

  const MUSIC_RX = vocabRx(MUSIC_WORDS);
  const NON_SPEECH_RX = vocabRx([...MUSIC_WORDS, ...OTHER_NON_SPEECH_WORDS]);

  // BLANK_AUDIO joins its words with an underscore, which regex counts as a word
  // character — so split on it before testing, or \b never lands between them.
  const forTest = (inner) => inner.replace(/_/g, SPACE).trim();

  // Returns the annotation-free text, plus whether music was announced.
  function stripNonSpeech(text) {
    let music = /[♪♫]/.test(text);
    const group = (_, inner) => {
      if (!NON_SPEECH_RX.test(forTest(inner))) return SPACE + inner + SPACE;
      if (MUSIC_RX.test(forTest(inner))) music = true;
      return SPACE;
    };
    const out = text
      .replace(/\[([^\]]*)\]/g, group)
      .replace(/\(([^)]*)\)/g, group)
      // An unclosed group is an annotation the decoder cut off mid-word; real
      // speech never contains a bracket, so there's nothing to salvage.
      .replace(/[[(][^\])]*$/, SPACE)
      .replace(/[♪♫]/g, SPACE)
      .replace(/\s+/g, SPACE)
      .trim();
    return { text: out, music };
  }

  // Whisper sometimes loops on a token ("no no no no…"). Collapse runs of the
  // same word, and guard against a runaway loop filling memory.
  function clean(raw) {
    if (!raw) return { text: '', music: false };
    const { text, music } = stripNonSpeech(raw);
    if (!text) return { text: '', music };
    const words = text.split(/\s+/);
    const out = [];
    let last = '';
    let run = 0;
    for (const w of words) {
      const key = norm(w);
      if (key && key === last) {
        run++;
        if (run <= 1) out.push(w);
      } else {
        run = 0;
        last = key;
        out.push(w);
      }
    }
    let s = out.join(SPACE);
    if (s.length > 400) s = s.slice(-400);
    return { text: s, music };
  }

  async function reloadEngine() {
    transcriber = null;
    engineLoading = false;
    pending = new Float32Array(0);
    interim = '';
    prevHyp = [];
    displayed = [];
    setStatus('Switching model…');
    await startEngine();
  }

  async function startEngine() {
    if (transcriber || engineLoading) return;
    engineLoading = true;
    try {
      const { pipeline, env } = await import(chrome.runtime.getURL('vendor/transformers.min.js'));
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
      env.backends.onnx.wasm.numThreads = 1;

      const progress_callback = (p) => {
        if (p.status === 'progress' && p.total) {
          setStatus(`Downloading model… ${p.file} ${Math.round((p.loaded / p.total) * 100)}%`);
        }
      };

      try {
        transcriber = await pipeline('automatic-speech-recognition', settings.model, { device: 'webgpu', dtype: 'fp32', progress_callback });
        device = 'webgpu';
      } catch (e) {
        setStatus('WebGPU unavailable — loading WASM…');
        transcriber = await pipeline('automatic-speech-recognition', settings.model, { device: 'wasm', progress_callback });
        device = 'wasm';
      }
      setStatus(`Captions on · ${device.toUpperCase()} · listening…`);
      startSegmenter(); // background: captions must not wait on it
    } catch (err) {
      console.error('[Stream Captions] engine load failed:', err);
      setStatus(`⚠️ ${err && err.message ? err.message : err}`);
    } finally {
      engineLoading = false;
    }
  }

  // ---- speaker turns -----------------------------------------------------
  // PyAnnote tells us when the voice changes, which is all we need to break the
  // caption onto a new line. It labels speakers only within the window it was
  // given, so those ids mean nothing across calls — identifying *who* is talking
  // would need embedding + clustering (WeSpeaker) on top. We only look for the
  // boundary.
  async function startSegmenter() {
    if (segmenter || segLoading) return;
    segLoading = true;
    try {
      const { AutoModelForAudioFrameClassification, AutoProcessor } =
        await import(chrome.runtime.getURL('vendor/transformers.min.js'));
      const [model, processor] = await Promise.all([
        AutoModelForAudioFrameClassification.from_pretrained(SEG_MODEL, { device }),
        AutoProcessor.from_pretrained(SEG_MODEL),
      ]);
      segmenter = { model, processor };
      console.log('[Stream Captions] speaker segmentation ready');
    } catch (err) {
      // Fail open: captions are the product, speaker breaks are a nicety.
      console.warn('[Stream Captions] speaker segmentation unavailable:', err);
      segmenter = null;
    } finally {
      segLoading = false;
    }
  }

  // Seconds into `audio` where the speaker last changes, or -1.
  async function speakerTurnAt(audio) {
    if (!segmenter) return -1;
    try {
      const { input_values } = await segmenter.processor(audio);
      const { logits } = await segmenter.model({ input_values });
      const segments = segmenter.processor.post_process_speaker_diarization(logits, audio.length)[0];
      if (!segments || segments.length < 2) return -1;

      const dur = audio.length / TARGET_SR;
      let change = -1;
      for (let i = 1; i < segments.length; i++) {
        if (segments[i].id === segments[i - 1].id) continue;
        if (segments[i].confidence < SPEAKER_CONF) continue;
        change = segments[i].start;
      }
      // Both sides must be worth decoding on their own.
      if (change < MIN_AUDIO_SEC || dur - change < 0.3) return -1;
      return change;
    } catch (err) {
      console.warn('[Stream Captions] segmentation failed:', err);
      return -1;
    }
  }

  function appendAudio(chunk, sr) {
    if (hookedVideo) mediaTime = hookedVideo.currentTime;
    const res = resampleTo16k(chunk, sr);
    const chunkMs = (res.length / TARGET_SR) * 1000;
    if (rms(res) < SILENCE_RMS) silenceMs += chunkMs;
    else silenceMs = 0;

    // Long enough pause that the last line has already been committed: say the
    // extension is listening and there's genuinely nothing, rather than leaving
    // a stale caption sitting there.
    if (silenceMs >= SILENCE_MARK_MS && !interim) showMarker(SILENCE_MARK, false);

    const merged = new Float32Array(pending.length + res.length);
    merged.set(pending, 0);
    merged.set(res, pending.length);
    pending = merged;

    scheduleTranscribe();
  }

  // Each pass re-decodes the whole utterance, so a later pass has more right
  // context and often fixes an earlier mistake. Unlocked words therefore always
  // take the newest guess — freezing them at first sight (as this used to do)
  // made every early error permanent.
  //
  // A word locks once two consecutive passes agree on the prefix up to it, minus
  // the last few: trailing words are the ones the next chunk of audio is most
  // likely to revise, so agreeing on them twice isn't yet worth trusting.
  function updateHypothesis(words) {
    let n = 0;
    while (n < prevHyp.length && n < words.length && norm(prevHyp[n]) === norm(words[n])) n++;
    prevHyp = words;
    const lockTo = Math.max(0, Math.min(n, words.length - HOLD_TAIL));

    for (let i = 0; i < words.length; i++) {
      if (i >= displayed.length) displayed.push({ text: words[i], final: i < lockTo });
      else if (!displayed[i].final) displayed[i] = { text: words[i], final: i < lockTo };
      // else: already locked — never rewrite text the viewer has read.
    }
    while (displayed.length > words.length && !displayed[displayed.length - 1].final) displayed.pop();
    interim = displayed.map((d) => d.text).join(SPACE);
  }

  // Utterance ended (silence / length cap): finalize the line, reset.
  function commit() {
    if (interim) pushHistory(interim);
    interim = '';
    prevHyp = [];
    displayed = [];
    pending = new Float32Array(0);
    silenceMs = 0;
    render();
  }

  // Continuous speech: once a full sentence is confirmed, push it into history
  // (so the lens scrolls) and trim the consumed audio proportionally so it isn't
  // re-transcribed.
  function maybeFlushSentence() {
    let fp = 0;
    while (fp < displayed.length && displayed[fp].final) fp++;
    let cut = -1;
    for (let i = 0; i < fp; i++) {
      if (/[.!?…]$/.test(displayed[i].text)) cut = i;
    }
    if (cut < 1) return;
    const sentenceWords = displayed.slice(0, cut + 1).map((d) => d.text);
    const frac = Math.min(0.95, (cut + 1) / Math.max(1, displayed.length));
    pending = pending.slice(Math.floor(pending.length * frac));
    displayed = displayed.slice(cut + 1);
    prevHyp = prevHyp.slice(cut + 1);
    interim = displayed.map((d) => d.text).join(SPACE);
    pushHistory(sentenceWords.join(SPACE).trim());
  }

  async function scheduleTranscribe() {
    if (processing || !transcriber) return;
    if (pending.length < TARGET_SR * MIN_AUDIO_SEC) return;

    const now = performance.now();
    const tooLong = pending.length >= TARGET_SR * MAX_UTTERANCE_SEC;
    const silent = silenceMs >= SILENCE_COMMIT_MS && pending.length > TARGET_SR * 0.8;
    if (now - lastRunAt < STEP_MS && !tooLong && !silent) return;

    if (rms(pending) < SILENCE_RMS) {
      if (silent || tooLong) {
        if (interim) commit();
        else { pending = new Float32Array(0); silenceMs = 0; }
      }
      return;
    }

    processing = true;
    lastRunAt = now;
    let audio = pending;

    // Split at a speaker change before decoding, not after: decoding the whole
    // window first would put the new speaker's words at the tail of the old
    // speaker's line, and then repeat them on the next line.
    let turnCut = -1;
    if (segmenter && audio.length >= TARGET_SR * SEG_MIN_SEC && now - lastSegAt >= SEG_EVERY_MS) {
      lastSegAt = now;
      const turnSec = await speakerTurnAt(audio);
      if (turnSec > 0) {
        turnCut = Math.floor(turnSec * TARGET_SR);
        audio = audio.slice(0, turnCut);
      }
    }

    try {
      const opts = {
        task: settings.task,
        chunk_length_s: 30,
        return_timestamps: false,
        no_repeat_ngram_size: 3,
        repetition_penalty: 1.3,
        temperature: 0,
      };
      if (settings.language && settings.language !== 'auto') opts.language = settings.language;

      const t0 = performance.now();
      const out = await transcriber(audio, opts);
      const ms = Math.round(performance.now() - t0);
      const { text, music } = clean((out && out.text ? out.text : '').trim());

      // Music with no discernible lyrics: mark it and start a fresh window. The
      // marker deliberately bypasses the word pipeline — feeding it through
      // would scroll a trail of ♪ into the transcript history.
      if (!text && music) {
        showMarker(MUSIC_MARK, true);
        pending = new Float32Array(0);
        silenceMs = 0;
        console.log(`[Stream Captions] ${device} · ${(audio.length / TARGET_SR).toFixed(1)}s in ${ms}ms · MUSIC`);
        return;
      }

      updateHypothesis(text ? text.split(/\s+/) : []);
      maybeFlushSentence();
      render();

      // A speaker turn ends the line here and hands the rest of the audio to the
      // next pass, so the new voice starts fresh. commit() clears pending, so
      // the tail has to be rescued first.
      if (turnCut > 0) {
        const rest = pending.slice(turnCut);
        commit();
        breakLine();
        pending = rest;
        silenceMs = 0;
        console.log(`[Stream Captions] ${device} · ${(audio.length / TARGET_SR).toFixed(1)}s in ${ms}ms · SPEAKER TURN`);
        return;
      }

      const shouldCommit = silent || tooLong;
      if (shouldCommit && interim) commit();
      console.log(`[Stream Captions] ${device} · ${(audio.length / TARGET_SR).toFixed(1)}s in ${ms}ms · ${shouldCommit ? 'COMMIT' : 'interim'}`);
    } catch (err) {
      console.warn('[Stream Captions] transcribe error:', err);
    } finally {
      processing = false;
      scheduleTranscribe();
    }
  }

  // ---- audio graph -------------------------------------------------------
  // The AudioContext, worklet node, and each element's MediaElementSource are
  // created ONCE and never torn down: createMediaElementSource permanently binds
  // the element to that context, so closing/recreating it breaks playback.
  async function ensureAudioGraph() {
    if (audioCtx) return;
    audioCtx = new AudioContext();
    await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('src/content/capture-worklet.js'));
    workletNode = new AudioWorkletNode(audioCtx, 'capture-processor');
    muteGain = audioCtx.createGain();
    muteGain.gain.value = 0;
    workletNode.connect(muteGain).connect(audioCtx.destination);
    workletNode.port.onmessage = (e) => {
      if (settings.enabled) appendAudio(e.data.audio, e.data.sampleRate);
    };
  }

  // Rewinding a live stream (or any seek) makes the audio jump. Everything
  // buffered belongs to the old playhead, and the in-progress hypothesis was
  // built from it, so carrying either across the discontinuity produces a line
  // spliced together from two different points in the stream.
  function resetStream() {
    pending = new Float32Array(0);
    interim = '';
    history = '';
    prevHyp = [];
    displayed = [];
    silenceMs = 0;
    lastSig = null;
    render();
  }

  async function hookVideo(media) {
    if (hookedVideo === media && audioCtx) return;
    await ensureAudioGraph();
    await audioCtx.resume().catch(() => {});

    let source = media._scSource;
    if (!source) {
      source = audioCtx.createMediaElementSource(media);
      source.connect(audioCtx.destination); // keep playback audible (once)
      media._scSource = source;
    }
    if (captureSource && captureSource !== source) {
      try { captureSource.disconnect(workletNode); } catch {}
    }
    source.connect(workletNode);
    captureSource = source;
    hookedVideo = media;

    if (!media._scBound) {
      // Only a real jump counts. Live players nudge currentTime constantly to
      // hold the live edge and to skip buffer gaps, and every nudge fires a seek
      // event — resetting on those clears the buffer faster than it can fill, so
      // nothing ever reaches MIN_AUDIO_SEC and captions never appear.
      media.addEventListener('seeked', () => {
        if (hookedVideo !== media) return;
        const jumped = Math.abs(media.currentTime - mediaTime) > SEEK_JUMP_SEC;
        mediaTime = media.currentTime;
        if (jumped) resetStream();
      });
      media.addEventListener('ended', () => { if (hookedVideo === media) resetStream(); });
      media._scBound = true;
    }
  }

  function stopCapture() {
    if (captureSource) { try { captureSource.disconnect(workletNode); } catch {} }
    captureSource = null;
    hookedVideo = null;
  }

  // ---- enable / disable --------------------------------------------------
  async function enable() {
    const media = findMedia();
    if (!media) {
      // Nothing to listen to yet. Say so rather than looking silently broken —
      // the SPA poll below re-runs enable() once a player shows up.
      ensureOverlay(document.body);
      setStatus('No video or audio found on this page.');
      return;
    }
    ensureOverlay(media);
    // Only announce the load on a cold start — a re-hook mid-stream shouldn't
    // wipe the captions currently on screen.
    if (!transcriber) setStatus('Loading Whisper model…');
    startEngine();
    await hookVideo(media);
  }

  function disable() {
    stopCapture();
    clearTimeout(hideTimer);
    transcriber = null;
    pending = new Float32Array(0);
    interim = '';
    history = '';
    prevHyp = [];
    displayed = [];
    silenceMs = 0;
    lastSig = null;
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = textEl = lensEl = scrollEl = finalSpan = tentSpan = null;
    }
  }

  function findMedia() {
    const all = [...document.querySelectorAll('video, audio')];
    const playing = all.find((m) => !m.paused && m.readyState > 2);
    if (playing) return playing;
    const ready = all.find((m) => m.readyState > 0 || m.currentTime > 0);
    return ready || all[0] || null;
  }

  // ---- SPA navigation: re-hook when the page swaps media elements --------
  // Only when the element we're on is really gone. During a seek findMedia() can
  // briefly prefer some other element on the page, and re-hooking to that would
  // drop the capture for good. It must still hold media, so a player that swaps
  // sources but leaves the old node in the DOM doesn't strand us on a dead one.
  setInterval(() => {
    if (!settings.enabled) return;
    if (hookedVideo && hookedVideo.isConnected && hookedVideo.readyState > 0) return;
    const m = findMedia();
    if (m && m !== hookedVideo) enable();
  }, 2000);

  // ---- settings + messaging ---------------------------------------------
  // Load shared settings (language/model/position), but captions stay OFF until
  // this specific tab is toggled on — so tabs are independent.
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored, enabled: false };
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'toggle') {
      settings.enabled = msg.enabled;
      if (settings.enabled) enable(); else disable();
      sendResponse({ ok: true });
    } else if (msg.type === 'config') {
      const prevModel = settings.model;
      Object.assign(settings, msg.config);
      applyPosition();
      if (settings.enabled && settings.model !== prevModel) reloadEngine();
      sendResponse({ ok: true });
    } else if (msg.type === 'status') {
      sendResponse({ enabled: settings.enabled });
    }
    return true;
  });
})();
