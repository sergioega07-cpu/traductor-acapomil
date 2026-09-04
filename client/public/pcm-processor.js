class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._targetRate = 16000;
    this._ratio = sampleRate / this._targetRate;
    this._frac = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];

    // Downsample to 16kHz mono
    for (let i = 0; i < channel.length; i++) {
      this._frac += 1;
      if (this._frac >= this._ratio) {
        this._frac -= this._ratio;
        const s = Math.max(-1, Math.min(1, channel[i]));
        const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
        this._buffer.push(int16);
      }
    }

    // Emit ~100ms chunks (1600 samples @ 16kHz)
    const chunkSize = 1600;
    while (this._buffer.length >= chunkSize) {
      const slice = this._buffer.splice(0, chunkSize);
      const ab = new ArrayBuffer(slice.length * 2);
      const view = new DataView(ab);
      for (let i = 0; i < slice.length; i++) {
        view.setInt16(i * 2, slice[i], true);
      }
      this.port.postMessage(ab, [ab]);
    }
    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
