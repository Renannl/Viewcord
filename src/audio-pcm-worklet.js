class PcmAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.capacity = Math.floor(48000 * 2 * 0.1);
    this.buffer = new Float32Array(this.capacity);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.length = 0;

    this.port.onmessage = (event) => {
      if (
        event.data?.type !== "pcm" ||
        !(event.data.samples instanceof Float32Array)
      ) {
        return;
      }

      const samples = event.data.samples;
      const start = Math.max(0, samples.length - this.capacity);

      for (let i = start; i < samples.length; i++) {
        if (this.length === this.capacity) {
          this.readIndex = (this.readIndex + 1) % this.capacity;
          this.length--;
        }

        this.buffer[this.writeIndex] = samples[i];
        this.writeIndex = (this.writeIndex + 1) % this.capacity;
        this.length++;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];
    const frames = left.length;

    for (let frame = 0; frame < frames; frame++) {
      if (this.length >= 2) {
        left[frame] = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.capacity;

        right[frame] = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.capacity;

        this.length -= 2;
      } else {
        left[frame] = 0;
        right[frame] = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-audio-processor", PcmAudioProcessor);
