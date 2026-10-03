// Phát PCM 16-bit 24 kHz từ Gemini. Lệnh "flush" xóa ngay hàng đợi khi người học ngắt lời.
const IDLE_QUANTA = 60; // khoảng 320 ms ở 24 kHz, tránh nhấp nháy trạng thái giữa các gói audio

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.offset = 0;
    this.playing = false;
    this.idle = 0;
    this.port.onmessage = (event) => {
      const { type, buffer } = event.data;
      if (type === "audio") {
        this.queue.push(new Int16Array(buffer));
      } else if (type === "flush") {
        this.queue = [];
        this.current = null;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    let i = 0;
    while (i < output.length) {
      if (!this.current) {
        this.current = this.queue.shift() || null;
        this.offset = 0;
        if (!this.current) break;
      }
      const count = Math.min(output.length - i, this.current.length - this.offset);
      for (let k = 0; k < count; k++) output[i + k] = this.current[this.offset + k] / 32768;
      i += count;
      this.offset += count;
      if (this.offset >= this.current.length) this.current = null;
    }
    output.fill(0, i);

    const hasAudio = i > 0 || this.current !== null || this.queue.length > 0;
    this.idle = hasAudio ? 0 : this.idle + 1;
    const playing = hasAudio || (this.playing && this.idle < IDLE_QUANTA);
    if (playing !== this.playing) {
      this.playing = playing;
      this.port.postMessage({ type: "state", playing });
    }
    return true;
  }
}

registerProcessor("playback-processor", PlaybackProcessor);
