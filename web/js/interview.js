// Màn 04 · Phỏng vấn: giám khảo đọc câu hỏi (04a), nghe câu trả lời (04b), suy nghĩ (04c).
// Câu hỏi và chấm điểm do backend lo; đọc và nghe chạy trên trình duyệt (speech.js).

import * as api from "./api.js";
import { ICONS, formatClock, h, img, maskIcon, notice, pillButton, truncate } from "./dom.js";
import { LEVEL_BARS, Listener, Speaker } from "./speech.js";

const NOT_HEARD_MS = 8000;
const WARN_S = 15;
const DONE_DELAY_MS = 2000;
// Các quyết định của giám khảo vẫn ở lại khái niệm cũ, tính là câu hỏi đào sâu.
const FOLLOW_UP = new Set(["probe_deeper", "challenge", "hint", "clarify", "encourage", "redirect"]);

export function isFollowUp(action) {
  return FOLLOW_UP.has(action);
}

export class Interview {
  constructor({ root, strip, dialog, onFinish }) {
    this.root = root;
    this.strip = strip;
    this.dialog = dialog;
    this.onFinish = onFinish;
    this.speaker = new Speaker();
    this.listener = new Listener({
      onText: () => this.onText(),
      onLevels: (levels) => this.renderWave(levels),
      onError: (reason) => this.onListenError(reason),
    });
    this.timer = 0;
    window.addEventListener("online", () => this.active && this.render());
    window.addEventListener("offline", () => this.active && this.render());
    dialog.querySelector("#confirm-end-cancel").addEventListener("click", () => dialog.close());
    dialog.querySelector("#confirm-end-ok").addEventListener("click", () => {
      dialog.close();
      this.finish("early");
    });
  }

  get active() {
    return Boolean(this.session) && !this.ended;
  }

  async start({ setup, document, session, message }) {
    Object.assign(this, {
      setup,
      document,
      session,
      limitMs: setup.durationMinutes * 60_000,
      usedMs: 0,
      lastTick: performance.now(),
      questions: [{ text: message, kind: "new", follows: null, answer: "", answerSeconds: 0 }],
      answered: 0,
      phase: "reading",
      inputMode: Listener.supported ? "voice" : "typing",
      muted: false,
      ended: false,
      timeUp: false,
      error: null,
      draft: "",
      historyOpen: true,
      listenError: null,
      doneReason: null,
    });
    await this.speaker.ready;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 250);
    this.ask();
  }

  get current() {
    return this.questions[this.questions.length - 1];
  }

  // -- Luồng câu hỏi ---------------------------------------------------------

  async ask() {
    this.phase = "reading";
    this.readStart = performance.now();
    this.readTotal = this.speaker.estimate(this.current.text);
    this.render();
    if (this.speaker.available && !this.muted) await this.speaker.speak(this.current.text);
    if (this.ended || this.phase !== "reading") return;
    this.startListening();
  }

  skipReading() {
    this.speaker.stop();
  }

  replay() {
    if (this.phase === "listening") {
      this.draft = this.inputMode === "voice" ? this.listener.text : this.textarea?.value.trim() || "";
      this.listener.stop();
    }
    this.speaker.stop();
    this.ask();
  }

  toggleMute() {
    this.muted = !this.muted;
    this.speaker.muted = this.muted;
    if (this.muted) this.speaker.stop();
    else this.render();
  }

  startListening() {
    this.phase = "listening";
    this.listenStart = performance.now();
    this.notHeard = false;
    this.render();
    if (this.inputMode === "voice") {
      this.listener.start();
      this.listener.final = this.draft;
    } else if (this.textarea) {
      this.textarea.value = this.draft;
      this.textarea.focus();
    }
    this.draft = "";
    this.onText();
  }

  // Dừng micro và mở chữ máy vừa nghe được để người học sửa trước khi gửi.
  review() {
    if (this.phase !== "listening" || !this.listener.text) return;
    this.switchToTyping(true);
  }

  switchToTyping(reviewing = false) {
    this.reviewing = reviewing;
    const text = this.listener.text;
    this.listener.stop();
    this.inputMode = "typing";
    this.draft = text;
    this.startListening();
  }

  switchToVoice() {
    const text = (this.textarea?.value || "").trim();
    this.inputMode = "voice";
    this.reviewing = false;
    this.listenError = null;
    this.draft = text ? `${text} ` : "";
    this.startListening();
  }

  answerText() {
    return this.inputMode === "voice" ? this.listener.text : (this.textarea?.value || "").trim();
  }

  submit() {
    if (this.phase !== "listening") return;
    const text = this.answerText();
    if (!text) {
      if (this.timeUp) this.done("time");
      return;
    }
    this.listener.stop();
    // Sau khi gửi bản đã sửa, câu sau lại trả lời bằng giọng nói.
    if (this.reviewing) this.inputMode = "voice";
    this.reviewing = false;
    this.current.answer = text;
    this.current.answerSeconds = (performance.now() - this.listenStart) / 1000;
    this.phase = "thinking";
    this.render();
    this.send(text);
  }

  async send(text) {
    this.error = null;
    this.render();
    let result;
    try {
      result = await api.sendAnswer(this.session.id, text);
    } catch (error) {
      if (this.ended) return;
      if (error.status === 409) {
        this.done("server");
        return;
      }
      this.error = error.offline || !navigator.onLine ? "offline" : "ai";
      this.render();
      return;
    }
    if (this.ended) return;
    this.answered += 1;
    if (result.finished || this.answered >= this.setup.questionCount || this.timeUp) {
      this.done(this.timeUp ? "time" : result.finished && this.answered < this.setup.questionCount ? "server" : "count");
      return;
    }
    const action = await this.latestAction();
    if (this.ended) return;
    const follow = isFollowUp(action);
    this.questions.push({
      text: result.message,
      kind: follow ? "follow" : "new",
      follows: follow ? this.questions.length : null,
      answer: "",
      answerSeconds: 0,
    });
    this.ask();
  }

  /** Quyết định của giám khảo cho câu vừa trả lời (hỏi sâu hay chuyển chủ đề); không có thì bỏ qua. */
  async latestAction() {
    try {
      const insights = await Promise.race([
        api.getInsights(this.session.id),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000)),
      ]);
      return insights.evaluations[0]?.action || null;
    } catch {
      return null;
    }
  }

  retrySend() {
    this.send(this.current.answer);
  }

  done(reason) {
    if (this.phase === "done" || this.ended) return;
    this.phase = "done";
    this.doneReason = reason;
    this.speaker.stop();
    this.listener.stop();
    this.render();
    setTimeout(() => this.finish(reason), DONE_DELAY_MS);
  }

  finish(reason) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    this.speaker.stop();
    this.listener.stop();
    if (this.dialog.open) this.dialog.close();
    this.onFinish({
      session: this.session,
      answered: this.answered,
      questions: this.questions.slice(0, this.answered),
      usedSeconds: Math.min(this.usedMs, this.limitMs) / 1000,
      reason,
    });
  }

  confirmEnd() {
    this.dialog.querySelector("#confirm-end-text").textContent = this.answered
      ? `Giám khảo sẽ chấm dựa trên ${this.answered} câu bạn đã trả lời.`
      : "Bạn chưa trả lời câu nào nên kết quả sẽ chưa có điểm.";
    this.dialog.showModal();
  }

  // -- Đồng hồ và nghe -------------------------------------------------------

  tick() {
    if (this.ended) return;
    const now = performance.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    // Đồng hồ tạm dừng khi giám khảo suy nghĩ hoặc đã xong.
    if (this.phase === "reading" || this.phase === "listening") this.usedMs += dt;
    if (!this.timeUp && this.usedMs >= this.limitMs) this.onTimeUp();
    this.renderClock();
    if (this.phase === "reading") this.renderReading(now);
    if (this.phase === "listening") this.checkSilence(now);
  }

  onTimeUp() {
    this.timeUp = true;
    if (this.phase === "listening" && this.answerText()) this.submit();
    else if (this.phase === "reading" || this.phase === "listening") this.done("time");
  }

  onText() {
    if (this.phase !== "listening") return;
    if (this.notHeard && this.answerText()) {
      this.notHeard = false;
      this.render();
      return;
    }
    this.renderTranscript();
    this.renderFoot();
  }

  checkSilence(now) {
    if (this.inputMode !== "voice") return;
    const hasText = Boolean(this.listener.text);
    if (!hasText && !this.notHeard && now - this.listenStart >= NOT_HEARD_MS) {
      this.notHeard = true;
      this.render();
      return;
    }
    this.renderListenTime(now);
  }

  restartAnswer() {
    this.notHeard = false;
    this.listenStart = performance.now();
    if (this.inputMode === "voice") this.listener.restart();
    else if (this.textarea) this.textarea.value = "";
    this.render();
  }

  onListenError(reason) {
    // Không nhận dạng được giọng nói thì chuyển sang gõ, giữ phần đã nói.
    this.listenError = reason;
    if (this.phase === "listening") this.switchToTyping();
  }

  // -- Hiển thị --------------------------------------------------------------

  remainingSeconds() {
    return Math.max(0, (this.limitMs - this.usedMs) / 1000);
  }

  render() {
    if (!this.session) return;
    this.renderStrip();
    const parts = [];
    if (!navigator.onLine) {
      parts.push(notice("danger", img(ICONS.wifiOff, 18), "Mất kết nối mạng",
        "Kiểm tra wifi hoặc 4G. Câu trả lời của bạn vẫn được giữ, có mạng lại thì bấm Thử lại."));
    }
    if (!this.speaker.available && this.phase !== "done") {
      parts.push(notice("warn", maskIcon(ICONS.alert, 18), "Máy chưa có giọng đọc tiếng Việt.",
        "Câu hỏi chỉ hiện bằng chữ. Trên Edge có sẵn giọng tiếng Việt; trên Windows có thể cài thêm trong Cài đặt › Thời gian và ngôn ngữ › Giọng nói."));
    }
    if (this.listenError && this.inputMode === "typing" && this.phase !== "done") {
      const text = this.listenError === "blocked"
        ? "Trình duyệt đang chặn micro nên bạn gõ câu trả lời thay vì nói."
        : "Dịch vụ nhận dạng giọng nói không phản hồi nên bạn gõ câu trả lời thay vì nói.";
      parts.push(notice("warn", maskIcon(ICONS.alert, 18), "Đã chuyển sang gõ câu trả lời", text));
    }
    if (this.phase === "done") parts.push(this.doneBox());
    else {
      parts.push(this.examinerCard());
      parts.push(this.answerArea());
      if (this.error) parts.push(this.errorBar());
    }
    this.root.replaceChildren(...parts);
    this.renderClock();
    if (this.phase === "listening") {
      this.renderTranscript();
      this.renderFoot();
      this.renderListenTime(performance.now());
      this.renderWave(this.listener.levels);
    }
  }

  renderStrip() {
    this.stripClock = h("span", { class: "mono" });
    this.strip.replaceChildren(
      h("div", { class: "strip-clock", id: "strip-clock" }, img(ICONS.clock16, 16), this.stripClock, `/ ${formatClock(this.limitMs / 1000, true)} đã dùng`),
      h("div", { class: "strip-right" }, pillButton("Kết thúc sớm", { icon: ICONS.x, onclick: () => this.confirmEnd() })),
    );
  }

  renderClock() {
    if (this.stripClock) {
      this.stripClock.textContent = formatClock(this.usedMs / 1000, true);
      this.stripClock.parentElement.classList.toggle("is-warn", this.remainingSeconds() <= WARN_S);
    }
  }

  renderReading(now) {
    if (!this.readFill) return;
    const elapsed = Math.min(this.readTotal, (now - this.readStart) / 1000);
    this.readFill.style.setProperty("--value", `${(elapsed / this.readTotal) * 100}%`);
    this.readTime.textContent = `${formatClock(elapsed)} / ${formatClock(this.readTotal)}`;
  }

  examinerCard() {
    const reading = this.phase === "reading";
    const thinking = this.phase === "thinking";
    let status;
    if (reading) {
      status = h("span", { class: "chip chip-solid status-chip" },
        h("span", { class: "wave-mini", "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"), h("i")),
        this.speaker.available && !this.muted ? "Đang đọc câu hỏi" : "Câu hỏi mới");
    } else if (thinking) {
      status = h("span", { class: "chip status-chip", style: "color: var(--ink); font-weight: 600" }, img(ICONS.loader14, 14, "spin"), "Đang suy nghĩ");
    } else {
      status = h("span", { class: "chip is-success status-chip" }, img(ICONS.dot, 6), "Đang chờ bạn trả lời");
    }
    const head = h("div", { class: "examiner-head" },
      h("div", { class: "examiner" },
        h("span", { class: `avatar${reading && this.speaker.available && !this.muted ? " is-speaking" : ""}`, "aria-hidden": "true" }, h("span", {}, "M")),
        h("div", { class: "examiner-name" }, h("strong", {}, "Anh Minh"), h("span", {}, `Hỏi theo ${this.document.title}`))),
      status);

    if (thinking) {
      return h("section", { class: "card-lg", "aria-live": "polite" }, head,
        h("div", { class: "skeleton", "aria-hidden": "true" }, h("span"), h("span"), h("span")),
        h("p", { class: "thinking-text" }, this.error
          ? "Giám khảo chưa nhận được câu trả lời của bạn. Bấm Thử lại ở bên dưới."
          : "Giám khảo đang cân nhắc câu trả lời của bạn để chọn bước tiếp theo: hỏi đào sâu thêm, hay chuyển sang chủ đề mới."));
    }

    const canSpeak = this.speaker.available;
    const controls = [];
    if (reading) {
      if (canSpeak && !this.muted) {
        this.readFill = h("span");
        this.readTime = h("span", { class: "mono" });
        controls.push(h("div", { class: "reading-row" }, h("div", { class: "thin-track" }, this.readFill), this.readTime));
      } else {
        this.readFill = null;
      }
      controls.push(h("div", { class: "control-row" },
        canSpeak ? pillButton("Nghe lại", { icon: ICONS.replay, onclick: () => this.replay() }) : null,
        canSpeak ? pillButton(this.muted ? "Bật tiếng" : "Tắt tiếng", { icon: ICONS.mute, onclick: () => this.toggleMute() }) : null,
        pillButton("Bỏ qua, trả lời ngay", { icon: ICONS.skip, onclick: () => this.skipReading() })));
    } else {
      this.readFill = null;
      controls.push(h("div", { class: "control-row" },
        canSpeak ? pillButton("Nghe lại", { icon: ICONS.replay, onclick: () => this.replay() }) : null,
        h("span", { class: "note" }, this.inputMode === "voice" ? "Câu hỏi đã đọc xong, micro đang bật." : "Gõ câu trả lời của bạn bên dưới.")));
    }
    return h("section", { class: "card-lg", "aria-live": "polite" }, head,
      h("p", { class: "question-text" }, this.current.text), controls);
  }

  answerArea() {
    this.textarea = null;
    this.transcriptEl = null;
    this.footEl = null;
    if (this.phase === "reading") {
      return h("section", { class: "answer-card is-waiting" },
        h("span", { class: "mic-off-circle" }, img(ICONS.micOff28, 28)),
        h("p", { class: "waiting-title" }, this.inputMode === "voice" ? "Micro sẽ tự bật khi giám khảo đọc xong" : "Ô trả lời sẽ mở khi giám khảo đọc xong"),
        h("p", { class: "waiting-hint" }, 'Hoặc bấm "Bỏ qua, trả lời ngay" để trả lời luôn'));
    }
    if (this.phase === "thinking") {
      const q = this.current;
      return h("section", { class: "answer-card is-sent" },
        h("div", { class: "sent-head" },
          h("span", { class: "label-caps" }, `Câu trả lời của bạn · Câu ${this.questions.length}`),
          this.error ? h("span", { class: "chip is-warn" }, "Chưa gửi được")
            : h("span", { class: "chip is-success" }, img(ICONS.check, 14), `Đã gửi · ${formatClock(q.answerSeconds)}`)),
        h("p", { class: "sent-text" }, q.answer),
        h("p", { class: "sent-foot" }, img(ICONS.micOff14, 14), "Micro đã tắt trong lúc giám khảo suy nghĩ"));
    }

    // Đang nghe hoặc đang gõ.
    const voice = this.inputMode === "voice";
    const body = [];
    if (voice) {
      this.listenTimeEl = h("span", { class: "mono" });
      this.waveEl = h("div", { class: "waveform", "aria-hidden": "true" }, Array.from({ length: LEVEL_BARS }, () => h("i")));
      body.push(h("div", { class: "listen-row" },
        h("div", { class: "listen-state" }, h("span", { class: "live" }), h("strong", {}, "Đang nghe"), this.listenTimeEl),
        this.waveEl));
      if (this.notHeard) {
        body.push(h("div", { class: "not-heard", role: "status" },
          h("span", { class: "circle" }, img(ICONS.micOff20, 20)),
          h("strong", {}, "Chưa nghe thấy bạn nói"),
          h("span", {}, "Kiểm tra micro hoặc nói gần hơn."),
          pillButton("Nói lại", { icon: ICONS.replay, onclick: () => this.restartAnswer() })));
      } else {
        this.transcriptEl = h("p", { class: "transcript", "aria-live": "polite" });
        body.push(this.transcriptEl);
      }
    } else {
      this.textarea = h("textarea", {
        class: "answer-input",
        id: "answer-input",
        rows: "4",
        maxlength: "4000",
        "aria-label": "Câu trả lời của bạn",
        placeholder: this.reviewing ? "Sửa câu trả lời…" : "Gõ câu trả lời… (Enter để gửi, Shift + Enter để xuống dòng)",
        oninput: () => this.onText(),
        onkeydown: (event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            this.submit();
          }
        },
      });
      body.push(this.textarea);
    }
    body.push(h("hr", { class: "divider" }));
    this.footEl = h("div", { class: "answer-foot" });
    body.push(this.footEl);
    const card = h("section", { class: "answer-card is-listening" }, body);
    if (!Listener.supported || this.reviewing) return card;
    return h("div", { class: "flow-actions-col" }, card,
      voice
        ? pillButton("Chuyển sang viết câu trả lời", { onclick: () => this.switchToTyping(), className: "btn-pill mode-switch" })
        : pillButton("Chuyển sang nói câu trả lời", { icon: ICONS.mic, onclick: () => this.switchToVoice(), className: "btn-pill mode-switch" }));
  }

  renderTranscript() {
    if (!this.transcriptEl) return;
    const { final, interim } = this.listener;
    if (!final && !interim) {
      this.transcriptEl.replaceChildren(h("span", { class: "placeholder" }, "Bắt đầu nói câu trả lời của bạn…"));
      return;
    }
    this.transcriptEl.replaceChildren(final ? `${final} ` : "", interim ? h("span", { class: "interim" }, interim) : "");
  }

  renderFoot() {
    if (!this.footEl) return;
    const voice = this.inputMode === "voice";
    const hasText = Boolean(this.answerText());
    let left;
    if (voice) {
      left = h("div", { class: "foot-left" }, img(ICONS.micOn64, 64),
        h("div", { class: "foot-text" },
          h("span", {}, "Chữ đen là phần đã chốt, chữ xám đang nhận dạng"),
          h("span", {}, "Bấm Xong để xem lại và sửa chữ trước khi gửi")));
    } else if (this.reviewing) {
      left = h("div", { class: "foot-text" }, h("span", {}, "Sửa lại những chỗ máy nghe nhầm"), h("span", {}, "Bấm Nói tiếp để nói thêm, hoặc Gửi khi đã xong"));
    } else {
      left = h("div", { class: "foot-text" }, h("span", {}, "Bấm Gửi khi trả lời xong"), h("span", {}, "Câu trả lời được giữ nếu mạng chập chờn"));
    }
    this.footEl.replaceChildren(left, h("div", { class: "foot-buttons" },
      this.reviewing
        ? pillButton("Nói tiếp", { icon: ICONS.mic, iconSize: 14, className: "btn-pill btn-lg", onclick: () => this.switchToVoice() })
        : pillButton(voice ? "Nói lại" : "Xoá", { icon: ICONS.replay, iconSize: 14, className: "btn-pill btn-lg", onclick: () => this.restartAnswer() }),
      pillButton(voice ? "Xong" : "Gửi", { icon: ICONS.checkWhite16, iconSize: 16, className: "btn-pill btn-lg btn-solid", disabled: !hasText, onclick: () => (voice ? this.review() : this.submit()) })));
  }

  renderListenTime(now) {
    if (this.listenTimeEl) this.listenTimeEl.textContent = formatClock((now - this.listenStart) / 1000);
  }

  renderWave(levels) {
    if (!this.waveEl) return;
    const bars = this.waveEl.children;
    levels.forEach((value, i) => {
      if (bars[i]) bars[i].style.height = `${Math.round(4 + Math.min(1, value) * 28)}px`;
    });
  }

  errorBar() {
    const offline = this.error === "offline";
    return h("div", { class: "ai-error", role: "alert" },
      maskIcon(offline ? ICONS.wifiOff : ICONS.alert, 18),
      h("p", {}, offline
        ? "Mất kết nối mạng. Câu trả lời của bạn vẫn được giữ."
        : "Không kết nối được với giám khảo AI. Câu trả lời của bạn vẫn được giữ."),
      h("button", { type: "button", class: "btn-pill", onclick: () => this.retrySend() }, "Thử lại"));
  }

  doneBox() {
    const timeUp = this.doneReason === "time";
    const chip = timeUp
      ? h("span", { class: "chip is-warn" }, img(ICONS.clock14, 14), this.answered ? "Hết giờ · đã tự gửi phần bạn đã nói" : "Hết giờ phỏng vấn")
      : h("span", { class: "chip is-success" }, img(ICONS.check, 14), this.doneReason === "server"
        ? `Giám khảo đã hỏi hết nội dung · ${this.answered} câu`
        : `Đã trả lời ${this.answered}/${this.setup.questionCount} câu`);
    return h("section", { class: "done-box", role: "status" }, chip, h("p", {}, "Chuyển sang chấm điểm sau 2 giây…"));
  }

  /** Dừng hẳn khi rời màn (ví dụ tải lại trang). */
  dispose() {
    this.ended = true;
    clearInterval(this.timer);
    this.speaker.stop();
    this.listener.stop();
  }
}
