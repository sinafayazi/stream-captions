// AudioWorklet processor: batches raw PCM frames from the player's audio graph
// and posts them (at the context's native sample rate) to the content script,
// which forwards them to the Whisper worker. Runs on the audio thread, so we
// keep it minimal: accumulate ~250ms, post, repeat.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._count = 0;
    this._target = Math.round(sampleRate * 0.25); // ~250ms batches
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // Mix down to mono by averaging channels (usually already 1-2 channels).
      const frameLen = input[0].length;
      const mono = new Float32Array(frameLen);
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        for (let i = 0; i < frameLen; i++) mono[i] += ch[i];
      }
      if (input.length > 1) {
        for (let i = 0; i < frameLen; i++) mono[i] /= input.length;
      }
      this._chunks.push(mono);
      this._count += frameLen;

      if (this._count >= this._target) {
        const merged = new Float32Array(this._count);
        let off = 0;
        for (const b of this._chunks) {
          merged.set(b, off);
          off += b.length;
        }
        this.port.postMessage({ audio: merged, sampleRate }, [merged.buffer]);
        this._chunks = [];
        this._count = 0;
      }
    }
    return true; // keep processor alive
  }
}

registerProcessor('capture-processor', CaptureProcessor);
