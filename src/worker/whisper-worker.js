// Whisper inference worker (module worker).
// Receives native-rate PCM batches, resamples to 16kHz, and transcribes in
// fixed windows using transformers.js. Tries WebGPU first, falls back to WASM.
import { pipeline, env } from '../../vendor/transformers.min.js';

// Models are fetched from the Hugging Face hub at first run and cached by the
// browser. (Model weights are data, not remote code — fine for MV3.)
env.allowLocalModels = false;
env.useBrowserCache = true;

const TARGET_SR = 16000;
const WINDOW_SEC = 5; // size of each transcription window (non-overlapping for v1)

let transcriber = null;
let device = 'unknown';
let modelId = 'Xenova/whisper-base';
let language = 'auto'; // 'auto' => let Whisper detect
let task = 'transcribe'; // or 'translate' (=> English)
let buffer = new Float32Array(0);
let processing = false;

// Linear-interpolation resample to 16kHz mono.
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

async function init(opts) {
  modelId = opts.model || modelId;
  language = opts.language || 'auto';
  task = opts.task || 'transcribe';
  try {
    transcriber = await pipeline('automatic-speech-recognition', modelId, {
      device: 'webgpu',
      dtype: 'fp32',
    });
    device = 'webgpu';
  } catch (e) {
    transcriber = await pipeline('automatic-speech-recognition', modelId, {
      device: 'wasm',
    });
    device = 'wasm';
  }
  self.postMessage({ type: 'ready', device, model: modelId });
  maybeProcess();
}

function appendAudio(chunk, sr) {
  const res = resampleTo16k(chunk, sr);
  const merged = new Float32Array(buffer.length + res.length);
  merged.set(buffer, 0);
  merged.set(res, buffer.length);
  buffer = merged;
  maybeProcess();
}

async function maybeProcess() {
  if (processing || !transcriber) return;
  const windowSamples = TARGET_SR * WINDOW_SEC;
  if (buffer.length < windowSamples) return;

  processing = true;
  const audio = buffer.slice(0, windowSamples);
  buffer = buffer.slice(windowSamples);

  try {
    const opts = { task, chunk_length_s: WINDOW_SEC + 2, return_timestamps: false };
    if (language && language !== 'auto') opts.language = language;
    const out = await transcriber(audio, opts);
    const text = (out && out.text ? out.text : '').trim();
    if (text) self.postMessage({ type: 'caption', text });
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err) });
  } finally {
    processing = false;
    maybeProcess(); // drain any audio that piled up while we were busy
  }
}

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      init(m);
      break;
    case 'audio':
      appendAudio(m.audio, m.sampleRate);
      break;
    case 'config':
      if (m.language) language = m.language;
      if (m.task) task = m.task;
      break;
    case 'reset':
      buffer = new Float32Array(0);
      break;
  }
};
