// Chuyển audio micro (tần số gốc của thiết bị) thành PCM 16-bit 16 kHz, gửi về main thread theo từng khối 40 ms.
const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 640;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outIndex = 0;
    this.acc = 0;
    this.accCount = 0;
    this.position = 0;
    this.boundary = this.ratio;
    this.muted = false;
    this.levelSum = 0;
    this.levelBlocks = 0;
    this.port.onmessage = (event) => {
      if (event.data.type === "mute") this.muted = event.data.value;
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    let energy = 0;
    for (let i = 0; i < channel.length; i++) {
      const sample = this.muted ? 0 : channel[i];
      energy += sample * sample;
      // Lấy trung bình các mẫu trong mỗi khoảng để giảm méo khi hạ tần số lấy mẫu.
      this.acc += sample;
      this.accCount += 1;
      this.position += 1;
      if (this.position >= this.boundary) {
        const value = Math.max(-1, Math.min(1, this.acc / this.accCount));
        this.out[this.outIndex++] = value < 0 ? value * 0x8000 : value * 0x7fff;
        this.acc = 0;
        this.accCount = 0;
        this.boundary += this.ratio;
        if (this.outIndex === CHUNK_SAMPLES) {
          this.port.postMessage({ type: "audio", buffer: this.out.buffer }, [this.out.buffer]);
          this.out = new Int16Array(CHUNK_SAMPLES);
          this.outIndex = 0;
        }
      }
    }
    if (this.position > 1e7) {
      this.position -= 1e7;
      this.boundary -= 1e7;
    }

    this.levelSum += energy / channel.length;
    this.levelBlocks += 1;
    if (this.levelBlocks >= 8) {
      this.port.postMessage({ type: "level", value: Math.sqrt(this.levelSum / this.levelBlocks) });
      this.levelSum = 0;
      this.levelBlocks = 0;
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
