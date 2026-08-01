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
  const MIN_AUDIO_SEC = 0.5;      // don't transcribe less than this (Whisper hallucinates)
  const MAX_UTTERANCE_SEC = 6;    // force-commit a run-on with no pause/sentence break
  const SILENCE_RMS = 0.008;      // audio level below this counts as silence
  const SILENCE_COMMIT_MS = 600;  // this much trailing silence finalizes the line
  const HIDE_AFTER_MS = 4000;     // after this much inactivity, the box floats up & fades
  const HISTORY_CAP = 280;        // max chars of scrolled-back transcript kept

  const POS_CLASS = {
    'bottom-center': 'sc-pos-bc',
    'bottom-left': 'sc-pos-bl',
    'bottom-right': 'sc-pos-br',
    'top-center': 'sc-pos-tc',
  };

  const SPACE = ' ';

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

  // Streaming state.
  let pending = new Float32Array(0); // audio for the in-progress utterance (16kHz)
  let interim = '';                  // latest full hypothesis (for commit)
  let history = '';                  // finalized transcript that has scrolled back
  let prevHyp = [];                  // previous pass's words (for agreement)
  let displayed = [];                // [{text, final}] words of the current utterance
  let lastRunAt = 0;
  let silenceMs = 0;
  let processing = false;

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

    const whole = [history, finalWords].filter(Boolean).join(SPACE);
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

  function bumpHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (textEl) textEl.classList.add('sc-hidden'); }, HIDE_AFTER_MS);
  }

  function pushHistory(text) {
    if (!text) return;
    history = (history ? history + SPACE : '') + text;
    if (history.length > HISTORY_CAP) history = history.slice(-HISTORY_CAP);
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

  // Whisper sometimes loops on a token ("no no no no…"). Collapse runs of the
  // same word, and guard against a runaway loop filling memory.
  function clean(text) {
    if (!text) return '';
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
    return s;
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
    } catch (err) {
      console.error('[Stream Captions] engine load failed:', err);
      setStatus(`⚠️ ${err && err.message ? err.message : err}`);
    } finally {
      engineLoading = false;
    }
  }

  function appendAudio(chunk, sr) {
    const res = resampleTo16k(chunk, sr);
    const chunkMs = (res.length / TARGET_SR) * 1000;
    if (rms(res) < SILENCE_RMS) silenceMs += chunkMs;
    else silenceMs = 0;

    const merged = new Float32Array(pending.length + res.length);
    merged.set(pending, 0);
    merged.set(res, pending.length);
    pending = merged;

    scheduleTranscribe();
  }

  // Write each word's first guess immediately; update a word at most ONCE — when
  // it becomes confirmed (the leading words two consecutive passes agree on).
  // Intermediate re-guesses for an unconfirmed word are ignored (less churn).
  function updateHypothesis(words) {
    let n = 0;
    while (n < prevHyp.length && n < words.length && norm(prevHyp[n]) === norm(words[n])) n++;
    prevHyp = words;

    for (let i = 0; i < words.length; i++) {
      if (i >= displayed.length) displayed.push({ text: words[i], final: i < n });
      else if (!displayed[i].final && i < n) displayed[i] = { text: words[i], final: true };
      // else: keep the word already shown (ignore volatile intermediate edits)
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
    const audio = pending;
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
      const text = clean((out && out.text ? out.text : '').trim());

      updateHypothesis(text ? text.split(/\s+/) : []);
      maybeFlushSentence();
      render();

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
    setStatus('Loading Whisper model…');
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
  setInterval(() => {
    if (!settings.enabled) return;
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
