// Chuyển audio micro (tần số gốc của thiết bị) thành PCM 16-bit 16 kHz, gửi về main thread theo từng khối 40 ms.
// Trước khi gửi, audio được lọc nhiễu nhẹ để Gemini Live nhận dạng tốt hơn trong phòng ồn:
// - lọc thông cao ~120 Hz bỏ tiếng ù điện, quạt, rung bàn;
// - cổng nhiễu tự học mức ồn nền, giảm mạnh âm lượng khi không có tiếng nói để tạp âm không bị coi là lời nói.
const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 640;
const HIGHPASS_HZ = 120;
const GATE_OPEN_RATIO = 2.8; // tiếng nói phải to hơn ồn nền chừng này lần
const GATE_MIN_OPEN = 0.006; // ngưỡng tuyệt đối tối thiểu (RMS) để mở cổng
const GATE_HOLD_S = 0.35; // giữ cổng mở sau âm tiết cuối để không cắt đuôi câu
const GATE_FLOOR_GAIN = 0.06; // mức giữ lại khi cổng đóng, không tắt hẳn để VAD vẫn thấy đang im lặng tự nhiên
const NOISE_FLOOR_MIN = 0.0008;

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
    this.filterOn = true;
    this.levelSum = 0;
    this.levelBlocks = 0;

    // Bộ lọc thông cao bậc một: y[n] = a * (y[n-1] + x[n] - x[n-1]).
    const rc = 1 / (2 * Math.PI * HIGHPASS_HZ);
    this.hpA = rc / (rc + 1 / sampleRate);
    this.hpPrevIn = 0;
    this.hpPrevOut = 0;

    this.noiseFloor = 0.003;
    this.gain = 1;
    this.holdSamples = 0;
    this.holdMax = Math.round(GATE_HOLD_S * sampleRate);
    // Hệ số làm mượt độ lợi cho mỗi mẫu: mở nhanh (~5 ms), đóng chậm (~80 ms) để không nghe giật.
    this.attack = 1 - Math.exp(-1 / (0.005 * sampleRate));
    this.release = 1 - Math.exp(-1 / (0.08 * sampleRate));
    this.filtered = new Float32Array(128);

    this.port.onmessage = (event) => {
      if (event.data.type === "mute") this.muted = event.data.value;
      else if (event.data.type === "filter") this.filterOn = event.data.value;
    };
  }

  /** Lọc thông cao rồi tính RMS của khối, cập nhật mức ồn nền và trạng thái cổng. Trả về độ lợi mục tiêu. */
  analyse(channel) {
    if (this.filtered.length !== channel.length) this.filtered = new Float32Array(channel.length);
    let energy = 0;
    for (let i = 0; i < channel.length; i++) {
      const x = channel[i];
      const y = this.hpA * (this.hpPrevOut + x - this.hpPrevIn);
      this.hpPrevIn = x;
      this.hpPrevOut = y;
      this.filtered[i] = y;
      energy += y * y;
    }
    const rms = Math.sqrt(energy / channel.length);

    // Ồn nền giảm nhanh khi yên tĩnh, tăng rất chậm khi có tiếng (để tiếng nói kéo dài không bị học thành ồn nền).
    if (rms < this.noiseFloor) this.noiseFloor = this.noiseFloor * 0.9 + rms * 0.1;
    else this.noiseFloor = this.noiseFloor * 0.9995 + rms * 0.0005;
    this.noiseFloor = Math.max(this.noiseFloor, NOISE_FLOOR_MIN);

    const threshold = Math.max(this.noiseFloor * GATE_OPEN_RATIO, GATE_MIN_OPEN);
    if (rms >= threshold) this.holdSamples = this.holdMax;
    else this.holdSamples = Math.max(0, this.holdSamples - channel.length);
    return this.holdSamples > 0 ? 1 : GATE_FLOOR_GAIN;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    const target = this.filterOn ? this.analyse(channel) : 1;
    const source = this.filterOn ? this.filtered : channel;

    let energy = 0;
    for (let i = 0; i < channel.length; i++) {
      this.gain += (target - this.gain) * (target > this.gain ? this.attack : this.release);
      const sample = this.muted ? 0 : source[i] * this.gain;
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
