// Content script: finds the player <video>, taps its audio, runs it through the
// Whisper worker, and renders captions as an overlay on the player.
(() => {
  const DEFAULTS = { enabled: false, language: 'auto', model: 'Xenova/whisper-base', task: 'transcribe' };
  let settings = { ...DEFAULTS };

  let audioCtx = null;
  let workletNode = null;
  let muteGain = null;
  let worker = null;
  let hookedVideo = null;
  let overlayEl = null;
  let textEl = null;
  let hideTimer = null;
  const captionLines = [];
  const MAX_LINES = 2;

  // ---- overlay rendering -------------------------------------------------
  function ensureOverlay(media) {
    if (overlayEl && overlayEl.isConnected) return;

    overlayEl = document.createElement('div');
    textEl = document.createElement('div');
    textEl.className = 'sc-text';
    overlayEl.appendChild(textEl);

    if (media.tagName === 'VIDEO') {
      // Anchor over the player; position:relative on the host so the overlay
      // rides along into fullscreen (which fullscreens the player container).
      const host = media.parentElement || document.body;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      overlayEl.className = 'sc-overlay';
      host.appendChild(overlayEl);
    } else {
      // Audio / music: no video frame to anchor to — float over the page.
      overlayEl.className = 'sc-overlay sc-overlay-floating';
      document.body.appendChild(overlayEl);
    }
  }

  function showCaption(text) {
    if (!overlayEl) return;
    captionLines.push(text);
    while (captionLines.length > MAX_LINES) captionLines.shift();
    textEl.textContent = captionLines.join('\n');
    overlayEl.style.opacity = '1';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (overlayEl) overlayEl.style.opacity = '0';
    }, 6000);
  }

  function setStatus(msg) {
    if (!overlayEl) return;
    textEl.textContent = msg;
    overlayEl.style.opacity = '1';
  }

  // ---- audio graph -------------------------------------------------------
  async function hookVideo(video) {
    if (hookedVideo === video && audioCtx) return;
    teardownAudio();

    audioCtx = new AudioContext(); // native rate; we resample in the worker
    await audioCtx.resume().catch(() => {});

    // createMediaElementSource can only be called once per element per context.
    let source = video._scSource;
    if (!source) {
      source = audioCtx.createMediaElementSource(video);
      video._scSource = source;
    }
    // Always route to speakers so playback is unaffected.
    source.connect(audioCtx.destination);

    await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('src/content/capture-worklet.js'));
    workletNode = new AudioWorkletNode(audioCtx, 'capture-processor');
    muteGain = audioCtx.createGain();
    muteGain.gain.value = 0; // silent path that exists only to drive the worklet
    workletNode.connect(muteGain).connect(audioCtx.destination);
    source.connect(workletNode);

    workletNode.port.onmessage = (e) => {
      if (worker) worker.postMessage({ type: 'audio', audio: e.data.audio, sampleRate: e.data.sampleRate }, [e.data.audio.buffer]);
    };

    hookedVideo = video;
  }

  function teardownAudio() {
    try { workletNode && workletNode.disconnect(); } catch {}
    try { muteGain && muteGain.disconnect(); } catch {}
    // Note: we intentionally keep _scSource connected to destination so the
    // user keeps hearing audio; we only close our context.
    try { audioCtx && audioCtx.close(); } catch {}
    workletNode = null;
    muteGain = null;
    audioCtx = null;
    hookedVideo = null;
  }

  // ---- worker ------------------------------------------------------------
  function startWorker() {
    if (worker) return;
    worker = new Worker(chrome.runtime.getURL('src/worker/whisper-worker.js'), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') setStatus(`Captions on · ${m.device.toUpperCase()} · loading audio…`);
      else if (m.type === 'caption') showCaption(m.text);
      else if (m.type === 'error') console.warn('[Stream Captions] worker error:', m.error);
    };
    worker.postMessage({ type: 'init', model: settings.model, language: settings.language, task: settings.task });
  }

  function stopWorker() {
    if (worker) { worker.terminate(); worker = null; }
  }

  // ---- enable / disable --------------------------------------------------
  async function enable() {
    const media = findMedia();
    if (!media) { return; }
    ensureOverlay(media);
    setStatus('Loading Whisper model…');
    startWorker();
    await hookVideo(media);
  }

  function disable() {
    stopWorker();
    teardownAudio();
    if (overlayEl) { overlayEl.remove(); overlayEl = null; textEl = null; }
    captionLines.length = 0;
  }

  // Find the most relevant playing media element (video or audio/music).
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
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    if (settings.enabled) enable();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'toggle') {
      settings.enabled = msg.enabled;
      if (settings.enabled) enable(); else disable();
      sendResponse({ ok: true });
    } else if (msg.type === 'config') {
      Object.assign(settings, msg.config);
      if (worker) worker.postMessage({ type: 'config', language: settings.language, task: settings.task });
      sendResponse({ ok: true });
    } else if (msg.type === 'status') {
      sendResponse({ enabled: settings.enabled });
    }
    return true;
  });
})();
