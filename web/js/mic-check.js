// Kiểm tra micro trước buổi phỏng vấn: xin quyền, đo âm lượng và nhận dạng câu nói thử nếu trình duyệt hỗ trợ.
// Micro chỉ mở trong lúc kiểm tra và được tắt ngay khi có kết quả.

export const TEST_PHRASE = "Tôi đã sẵn sàng phỏng vấn";
export const BAR_COUNT = 26;

const SAMPLE_MS = 70;
const LISTEN_MS = 8000;
const VOICE_RMS = 0.02;
const FULL_SCALE_RMS = 0.12;
const VOICE_MIN_MS = 500;
const SILENCE_AFTER_VOICE_MS = 800;
const RECOGNITION_GRACE_MS = 2500;

/**
 * Trạng thái: idle → requesting → listening → ready, hoặc một trong các lỗi
 * blocked, no-device, busy, unsupported, not-heard, error.
 */
export class MicCheck {
  constructor({ onChange, onLevels }) {
    this.onChange = onChange;
    this.onLevels = onLevels;
    this.levels = new Array(BAR_COUNT).fill(0);
    this.run = null;
    this.state = { status: "idle", device: "", transcript: "", interim: "", matched: false };
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  async start() {
    this.release();
    this.levels = new Array(BAR_COUNT).fill(0);
    this.onLevels(this.levels);
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.set({ status: "unsupported" });
      return;
    }
    const run = {};
    this.run = run;
    this.set({ status: "requesting", transcript: "", interim: "", matched: false });

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      if (this.run === run) {
        this.run = null;
        this.set({ status: micErrorStatus(error) });
      }
      return;
    }
    if (this.run !== run) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    this.stream = stream;
    this.audio = new AudioContext();
    this.analyser = this.audio.createAnalyser();
    this.analyser.fftSize = 1024;
    this.audio.createMediaStreamSource(stream).connect(this.analyser);
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.snapshot = null;

    const [track] = stream.getAudioTracks();
    this.set({ status: "listening", device: deviceName(track ? track.label : "") });
    this.sampler = setInterval(() => this.sample(), SAMPLE_MS);
    this.deadline = setTimeout(() => this.finish(), LISTEN_MS);
    this.startRecognition(run);
  }

  sample() {
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (const value of this.buffer) sum += value * value;
    const rms = Math.sqrt(sum / this.buffer.length);
    this.levels = [...this.levels.slice(1), Math.min(1, rms / FULL_SCALE_RMS)];
    this.onLevels(this.levels);

    if (rms >= VOICE_RMS) {
      this.voicedMs += SAMPLE_MS;
      this.silenceMs = 0;
      return;
    }
    if (this.voicedMs < VOICE_MIN_MS) return;
    this.silenceMs += SAMPLE_MS;
    if (this.silenceMs >= SILENCE_AFTER_VOICE_MS && this.silenceMs < SILENCE_AFTER_VOICE_MS + SAMPLE_MS) {
      // Giữ lại sóng âm ngay sau câu nói để hiển thị khi đã xong.
      this.snapshot = this.levels;
      if (!this.recognition) {
        this.finish();
      } else {
        clearTimeout(this.grace);
        this.grace = setTimeout(() => this.finish(), RECOGNITION_GRACE_MS);
      }
    }
  }

  startRecognition(run) {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.lang = "vi-VN";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      if (this.run !== run) return;
      let text = "";
      let final = false;
      for (const result of event.results) {
        text += result[0].transcript;
        if (result.isFinal) final = true;
      }
      if (final) {
        this.state = { ...this.state, transcript: text.trim(), interim: "" };
        this.finish();
      } else {
        this.set({ interim: text.trim() });
      }
    };
    // Dịch vụ nhận dạng lỗi (mất mạng, trình duyệt chặn…) thì chỉ dựa vào âm lượng.
    const fallBack = () => {
      if (this.run !== run || this.recognition !== recognition) return;
      this.recognition = null;
      if (this.snapshot) this.finish();
    };
    recognition.onerror = fallBack;
    recognition.onend = fallBack;
    try {
      recognition.start();
      this.recognition = recognition;
    } catch {
      this.recognition = null;
    }
  }

  finish() {
    if (this.state.status !== "listening") return;
    const transcript = this.state.transcript;
    const heard = Boolean(transcript) || this.voicedMs >= VOICE_MIN_MS;
    const levels = this.snapshot || this.levels;
    this.release();
    this.levels = levels;
    this.onLevels(levels);
    if (!heard) {
      this.set({ status: "not-heard", interim: "" });
      return;
    }
    this.set({ status: "ready", interim: "", matched: Boolean(transcript) && matchesPhrase(transcript) });
  }

  /** Dừng giữa chừng (ví dụ khi rời trang): tắt micro, coi như chưa kiểm tra. */
  stop() {
    const running = this.state.status === "requesting" || this.state.status === "listening";
    this.release();
    if (running) this.set({ status: "idle", interim: "" });
  }

  /** Tắt micro và mọi bộ đếm, giữ nguyên trạng thái đang hiển thị. */
  release() {
    this.run = null;
    clearInterval(this.sampler);
    clearTimeout(this.deadline);
    clearTimeout(this.grace);
    if (this.recognition) {
      const recognition = this.recognition;
      this.recognition = null;
      try {
        recognition.abort();
      } catch {
        // Đã dừng.
      }
    }
    if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.audio && this.audio.state !== "closed") this.audio.close();
    this.audio = null;
  }
}

function micErrorStatus(error) {
  switch (error && error.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "blocked";
    case "NotFoundError":
    case "OverconstrainedError":
      return "no-device";
    case "NotReadableError":
    case "AbortError":
      return "busy";
    default:
      return "error";
  }
}

function deviceName(label) {
  const name = label
    .replace(/^(default|communications|mặc định|liên lạc)\s*-\s*/i, "")
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "")
    .trim();
  return name || "Micro của bạn";
}

function words(text) {
  return text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

/** Câu nhận dạng được khớp ít nhất 60% số từ của câu mẫu. */
export function matchesPhrase(transcript) {
  const said = new Set(words(transcript));
  const expected = words(TEST_PHRASE);
  const hits = expected.filter((word) => said.has(word)).length;
  return hits / expected.length >= 0.6;
}
