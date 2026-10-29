class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(0);
    this.readOffset = 0;

    this.port.onmessage = (e) => {
      const pcmData = e.data;
      let float32Data;

      if (pcmData instanceof Int16Array) {
        float32Data = new Float32Array(pcmData.length);
        for (let i = 0; i < pcmData.length; i++) {
          float32Data[i] = pcmData[i] / 32768.0;
        }
      } else if (pcmData instanceof Float32Array) {
        float32Data = pcmData;
      } else {
        return;
      }

      const newBuffer = new Float32Array(
        this.buffer.length - this.readOffset + float32Data.length
      );
      newBuffer.set(this.buffer.subarray(this.readOffset));
      newBuffer.set(float32Data, this.buffer.length - this.readOffset);
      this.buffer = newBuffer;
      this.readOffset = 0;
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const channelCount = output.length;
    const frameCount = output[0].length;

    const availableFrames = this.buffer.length - this.readOffset;
    if (availableFrames < frameCount) {
      for (let ch = 0; ch < channelCount; ch++) {
        output[ch].fill(0);
      }
      return true;
    }

    for (let i = 0; i < frameCount; i++) {
      const sample = this.buffer[this.readOffset + i];
      for (let ch = 0; ch < channelCount; ch++) {
        output[ch][i] = sample;
      }
    }

    this.readOffset += frameCount;

    if (this.readOffset > 48000) {
      this.buffer = this.buffer.subarray(this.readOffset);
      this.readOffset = 0;
    }

    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
