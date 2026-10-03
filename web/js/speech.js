// Giọng nói chạy trên trình duyệt: đọc câu hỏi (speechSynthesis) và nhận dạng câu trả lời (SpeechRecognition).

const CHARS_PER_SECOND = 14;
const LEVEL_BARS = 28;
const FULL_SCALE_RMS = 0.12;

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function splitSentences(text) {
  return text.split(/(?<=[.!?…:;])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** Đọc câu hỏi bằng giọng tiếng Việt của trình duyệt. Không có giọng tiếng Việt thì available = false. */
export class Speaker {
  constructor() {
    this.voice = null;
    this.muted = false;
    this.ready = this.loadVoice();
    this.finish = null;
  }

  get available() {
    return Boolean(this.voice);
  }

  async loadVoice() {
    if (!("speechSynthesis" in window)) return;
    let voices = speechSynthesis.getVoices();
    if (!voices.length) {
      await new Promise((resolve) => {
        const done = () => resolve();
        speechSynthesis.addEventListener("voiceschanged", done, { once: true });
        setTimeout(done, 1500);
      });
      voices = speechSynthesis.getVoices();
    }
    const vietnamese = voices.filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith("vi"));
    // Giọng "Natural"/"Online" (Edge) tự nhiên hơn giọng cài sẵn.
    this.voice = vietnamese.find((v) => /natural|online/i.test(v.name)) || vietnamese[0] || null;
  }

  /** Ước lượng thời lượng đọc (giây), dùng cho thanh tiến độ. */
  estimate(text) {
    return Math.max(2, text.length / CHARS_PER_SECOND);
  }

  /** Đọc hết câu; resolve khi đọc xong hoặc bị dừng. */
  speak(text) {
    this.stop();
    if (!this.available || this.muted) return Promise.resolve();
    const sentences = splitSentences(text);
    return new Promise((resolve) => {
      let index = 0;
      this.finish = () => {
        this.finish = null;
        resolve();
      };
      const next = () => {
        if (!this.finish) return;
        if (index >= sentences.length) {
          this.finish();
          return;
        }
        const utterance = new SpeechSynthesisUtterance(sentences[index]);
        index += 1;
        utterance.voice = this.voice;
        utterance.lang = this.voice.lang;
        utterance.onend = next;
        utterance.onerror = next;
        speechSynthesis.speak(utterance);
      };
      next();
    });
  }

  stop() {
    const finish = this.finish;
    this.finish = null;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (finish) finish();
  }
}

/**
 * Nghe câu trả lời: chữ đã chốt (final) và chữ đang nhận dạng (interim), cùng mức âm lượng để vẽ sóng.
 * Lỗi: "blocked" (bị chặn micro), "network" (dịch vụ nhận dạng không phản hồi), "no-device".
 */
export class Listener {
  constructor({ onText, onLevels, onError }) {
    this.onText = onText;
    this.onLevels = onLevels;
    this.onError = onError;
    this.active = false;
    this.final = "";
    this.interim = "";
    this.levels = new Array(LEVEL_BARS).fill(0);
  }

  static get supported() {
    return Boolean(Recognition);
  }

  async start() {
    this.stop();
    this.active = true;
    this.final = "";
    this.interim = "";
    this.startRecognition();
    await this.startLevels();
  }

  /** Xoá phần đã nói và nghe lại từ đầu. */
  restart() {
    this.final = "";
    this.interim = "";
    this.onText(this.final, this.interim);
    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch {
        // Đã dừng.
      }
    }
  }

  get text() {
    return `${this.final} ${this.interim}`.replace(/\s+/g, " ").trim();
  }

  startRecognition() {
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.lang = "vi-VN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      if (this.recognition !== recognition) return;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) this.final = `${this.final} ${piece}`.replace(/\s+/g, " ").trim();
        else interim += piece;
      }
      this.interim = interim.trim();
      this.onText(this.final, this.interim);
    };
    recognition.onerror = (event) => {
      if (this.recognition !== recognition) return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") this.fail("blocked");
      else if (event.error === "network") this.fail("network");
      else if (event.error === "audio-capture") this.fail("no-device");
    };
    // Chrome tự dừng nhận dạng sau một lúc im lặng; còn đang nghe thì mở lại.
    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      if (this.interim) {
        this.final = `${this.final} ${this.interim}`.trim();
        this.interim = "";
        this.onText(this.final, this.interim);
      }
      if (this.active) setTimeout(() => this.active && this.recognition === recognition && this.safeStart(recognition), 150);
    };
    this.recognition = recognition;
    this.safeStart(recognition);
  }

  safeStart(recognition) {
    try {
      recognition.start();
    } catch {
      // Đang chạy.
    }
  }

  fail(reason) {
    const recognition = this.recognition;
    this.recognition = null;
    try {
      if (recognition) recognition.abort();
    } catch {
      // Đã dừng.
    }
    this.onError(reason);
  }

  async startLevels() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return;
    }
    if (!this.active) {
      this.stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.audio = new AudioContext();
    const analyser = this.audio.createAnalyser();
    analyser.fftSize = 1024;
    this.audio.createMediaStreamSource(this.stream).connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    this.sampler = setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (const v of buffer) sum += v * v;
      const level = Math.min(1, Math.sqrt(sum / buffer.length) / FULL_SCALE_RMS);
      this.levels = [...this.levels.slice(1), level];
      this.onLevels(this.levels);
    }, 70);
  }

  stop() {
    this.active = false;
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      try {
        recognition.abort();
      } catch {
        // Đã dừng.
      }
    }
    clearInterval(this.sampler);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.audio && this.audio.state !== "closed") this.audio.close();
    this.audio = null;
    this.levels = new Array(LEVEL_BARS).fill(0);
  }
}

export { LEVEL_BARS };
