// Phỏng vấn giọng nói real-time qua Gemini Live: micro gửi PCM 16 kHz lên WebSocket của backend,
// nhận PCM 24 kHz của AI cùng các sự kiện JSON (transcript, interrupted, turn_complete, status, warning, error, session_ended).

export class VoiceClient {
  /**
   * handlers: onState(), onLevel(level), onTranscript(role, text), onTurnEnd(interrupted),
   * onWarning(message), onError(message), onEnded(), onDisconnected(error).
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.allowBargeIn = true;
    this.muted = false;
    this.playing = false;
    this.ended = false;
    this.stopped = false;
    this.connection = "connecting";
    this.error = null;
  }

  // Tạo AudioContext ngay trong thao tác bấm nút để trình duyệt cho phép phát âm thanh.
  prepareAudio() {
    this.captureCtx = new AudioContext();
    this.playCtx = new AudioContext({ sampleRate: 24000 });
  }

  async start(sessionId, allowBargeIn) {
    this.allowBargeIn = allowBargeIn;
    await Promise.all([
      this.captureCtx.audioWorklet.addModule("/capture-worklet.js"),
      this.playCtx.audioWorklet.addModule("/playback-worklet.js"),
    ]);
    this.stream = await navigator.mediaDevices.getUserMedia({
      // Lọc nhiễu của trình duyệt chạy trước; capture-worklet.js lọc thêm tiếng ù và tạp âm nền.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, voiceIsolation: true },
    });
    await Promise.all([this.captureCtx.resume(), this.playCtx.resume()]);

    this.capture = new AudioWorkletNode(this.captureCtx, "capture-processor");
    const silent = this.captureCtx.createGain();
    silent.gain.value = 0;
    this.captureCtx.createMediaStreamSource(this.stream).connect(this.capture);
    this.capture.connect(silent).connect(this.captureCtx.destination);
    this.capture.port.onmessage = (event) => {
      if (event.data.type === "audio") {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(event.data.buffer);
      } else if (event.data.type === "level") {
        this.handlers.onLevel(this.isMicOpen() ? event.data.value : 0);
      }
    };

    this.player = new AudioWorkletNode(this.playCtx, "playback-processor", {
      numberOfInputs: 0,
      outputChannelCount: [1],
    });
    this.player.connect(this.playCtx.destination);
    this.player.port.onmessage = (event) => {
      if (event.data.type === "state") this.setPlaying(event.data.playing);
    };

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${protocol}://${location.host}/api/sessions/${sessionId}/voice`);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (event) => this.onMessage(event);
    this.ws.onclose = (event) => this.onClose(event);
  }

  isMicOpen() {
    return !this.muted && (this.allowBargeIn || !this.playing);
  }

  syncMic() {
    if (this.capture) this.capture.port.postMessage({ type: "mute", value: !this.isMicOpen() });
  }

  setMuted(muted) {
    this.muted = muted;
    this.syncMic();
    this.handlers.onState();
  }

  setPlaying(playing) {
    this.playing = playing;
    this.syncMic();
    this.handlers.onState();
    if (!playing && this.ended) this.finishSoon();
  }

  onMessage(event) {
    if (typeof event.data !== "string") {
      const buffer = event.data.byteLength % 2 ? event.data.slice(0, event.data.byteLength - 1) : event.data;
      this.player.port.postMessage({ type: "audio", buffer }, [buffer]);
      return;
    }
    const message = JSON.parse(event.data);
    switch (message.type) {
      case "transcript":
        this.handlers.onTranscript(message.role, message.text);
        break;
      case "interrupted":
        this.player.port.postMessage({ type: "flush" });
        this.handlers.onTurnEnd(true);
        break;
      case "turn_complete":
        this.handlers.onTurnEnd(false);
        break;
      case "status":
        this.connection = message.state;
        this.handlers.onState();
        break;
      case "warning":
        this.handlers.onWarning(message.message);
        break;
      case "error":
        this.error = message.message;
        this.handlers.onState();
        this.handlers.onError(message.message);
        break;
      case "session_ended":
        this.ended = true;
        this.handlers.onState();
        if (!this.playing) this.finishSoon();
        break;
      default:
        break;
    }
  }

  finishSoon() {
    clearTimeout(this.finishTimer);
    this.finishTimer = setTimeout(() => {
      this.stop();
      this.handlers.onEnded();
    }, 600);
  }

  onClose(event) {
    const unexpected = !this.stopped && !this.ended;
    if (unexpected && !this.error && event.code === 4401) this.error = "Cần đăng nhập để dùng giọng nói. Hãy tải lại trang.";
    this.stop();
    if (unexpected) this.handlers.onDisconnected(this.error);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.finishTimer);
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "end" }));
        this.ws.close();
      }
    } catch {
      // WebSocket đã đóng.
    }
    if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
    for (const ctx of [this.captureCtx, this.playCtx]) {
      if (ctx && ctx.state !== "closed") ctx.close();
    }
    this.handlers.onState();
  }

  get label() {
    if (this.error) return "Có lỗi kết nối giọng nói";
    if (this.ended) return "Buổi phỏng vấn đã kết thúc";
    if (this.stopped) return "Đã dừng";
    if (this.connection === "reconnecting") return "Đang nối lại…";
    if (this.connection !== "connected") return "Đang kết nối…";
    if (this.playing) return this.allowBargeIn ? "AI đang nói · bạn có thể ngắt lời" : "AI đang nói";
    if (this.muted) return "Mic đang tắt";
    return "Đang nghe bạn nói…";
  }

  get visualState() {
    if (this.error) return "error";
    if (this.ended || this.stopped) return "ended";
    if (this.connection !== "connected") return this.connection === "reconnecting" ? "reconnecting" : "connecting";
    if (this.playing) return "speaking";
    if (this.muted) return "muted";
    return "listening";
  }
}
