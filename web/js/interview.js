// Màn 02 · Phỏng vấn, cùng luồng với giao diện cũ (web/app.js): giọng nói real-time qua Gemini Live hoặc nhắn tin.

import * as api from "./api.js";
import { ICONS, formatClock, h, img, maskIcon, notice, pillButton, toast, truncate } from "./dom.js";
import { VoiceClient } from "./voice.js";

const STATUS = {
  pending: "Chưa hỏi", in_progress: "Đang hỏi", mastered: "Hiểu tốt",
  partial: "Hiểu một phần", gap: "Chưa nắm", unassessed: "Chưa đủ dữ liệu",
};
const STATUS_CHIP = { in_progress: "chip-solid", mastered: "is-success", partial: "is-warn", gap: "chip-danger" };
const ACTIONS = {
  ask_main: "Hỏi câu chính", probe_deeper: "Hỏi sâu", challenge: "Phản biện", hint: "Gợi ý",
  clarify: "Diễn đạt lại", encourage: "Động viên", redirect: "Kéo về câu hỏi",
  next_concept: "Chuyển chủ đề", wrap_up: "Kết thúc",
};
const FOLLOW_UP = new Set(["probe_deeper", "challenge", "hint", "clarify", "encourage", "redirect"]);
const BLOOM = ["—", "Nhớ", "Hiểu", "Vận dụng", "Phân tích", "Đánh giá", "Sáng tạo"];
const SPEAKING_LEVEL = 0.04;
const FULL_SCALE_LEVEL = 0.12;
const LEVEL_BARS = 28;
const LEVEL_SAMPLE_MS = 70;
const INSIGHTS_MS = 3000;

/** Quyết định của giám khảo vẫn ở lại chủ đề cũ, tức câu hỏi tiếp theo là câu đào sâu. */
export function isFollowUp(action) {
  return FOLLOW_UP.has(action);
}

export class Interview {
  constructor({ root, strip, dialog, onFinish }) {
    this.root = root;
    this.strip = strip;
    this.dialog = dialog;
    this.onFinish = onFinish;
    this.timer = 0;
    this.insightsTimer = 0;
    dialog.querySelector("#confirm-end-cancel").addEventListener("click", () => dialog.close());
    dialog.querySelector("#confirm-end-ok").addEventListener("click", () => {
      dialog.close();
      this.finish();
    });
  }

  get active() {
    return Boolean(this.session) && !this.ended;
  }

  /** Tạo VoiceClient ngay trong thao tác bấm nút, để trình duyệt cho phép phát âm thanh. */
  createVoice() {
    const voice = new VoiceClient({
      onState: () => this.renderVoiceState(),
      onLevel: (level) => this.renderLevel(level),
      onTranscript: (role, text) => this.appendTranscript(role, text),
      onTurnEnd: (interrupted) => this.endTranscriptTurn(interrupted),
      onWarning: (message) => toast(message, "warn"),
      onError: (message) => toast(message),
      onEnded: () => {
        this.markFinished();
        this.finish();
      },
      onDisconnected: (error) => {
        this.renderVoiceState();
        this.markFinished();
        if (!error) toast("Mất kết nối giọng nói. Bạn có thể xem kết quả với phần đã trả lời.", "warn");
      },
    });
    voice.prepareAudio();
    return voice;
  }

  async start({ session, message, voice, bargeIn }) {
    clearInterval(this.timer);
    clearInterval(this.insightsTimer);
    Object.assign(this, {
      session,
      voice,
      mode: session.mode,
      startedAt: Date.now(),
      finished: false,
      ended: false,
      sending: false,
      bubbles: { learner: null, interviewer: null },
      learnerTurns: 0,
      levels: new Array(LEVEL_BARS).fill(0),
      lastLevelAt: 0,
      learnerSpeaking: false,
      statusKey: "",
    });
    this.build();
    this.renderClock();
    this.timer = setInterval(() => this.renderClock(), 1000);
    if (this.mode === "text") {
      this.addTurn("interviewer", message);
      this.renderTextStatus(false);
      this.input.focus();
      return;
    }
    this.renderVoiceState();
    await voice.start(session.id, bargeIn);
  }

  // -- Dựng màn ----------------------------------------------------------------

  build() {
    const limit = this.session.time_limit_seconds;
    this.stripClock = h("span", { class: "mono" });
    this.teacherBtn = pillButton("Bảng giáo viên", { icon: ICONS.list14, onclick: () => this.toggleTeacher() });
    this.teacherBtn.setAttribute("aria-pressed", "false");
    this.strip.replaceChildren(
      h("div", { class: "strip-clock" }, img(ICONS.clock16, 16), this.stripClock, `/ ${formatClock(limit, true)} đã dùng`),
      h("div", { class: "strip-right" },
        pillButton("Kết thúc sớm", { icon: ICONS.x, onclick: () => this.confirmEnd() })));

    this.errorSlot = h("div", { class: "voice-error" });
    const column = [this.errorSlot, this.buildExaminerCard()];
    if (this.mode === "voice") column.push(this.buildVoiceCard());
    column.push(this.buildChatCard());
    this.doneBox = h("section", { class: "done-box", role: "status", hidden: true },
      h("span", { class: "chip is-success" }, img(ICONS.check, 14), "Buổi phỏng vấn đã kết thúc"),
      h("p", {}, "Bấm Xem kết quả để giám khảo tổng hợp điểm và viết nhận xét."),
      pillButton("Xem kết quả", { className: "btn-pill btn-lg btn-solid", onclick: () => this.finish() }));
    column.push(this.doneBox);

    this.progressList = h("div", { class: "progress-list" });
    this.evalList = h("div", { class: "eval-list" });
    this.teacher = h("aside", { class: "result-card teacher-panel", hidden: true },
      h("div", { class: "teacher-head" }, h("h2", {}, "Đánh giá ngầm"), h("span", { class: "chip chip-small" }, "Chỉ giáo viên")),
      this.progressList,
      h("p", { class: "label-caps" }, "Lượt chấm gần nhất"),
      this.evalList);

    this.root.classList.remove("with-teacher");
    this.root.replaceChildren(h("div", { class: "interview-layout" },
      h("div", { class: "interview-col" }, column.flat()),
      this.teacher));
  }

  /** Card giám khảo: tên, trạng thái và câu giám khảo vừa nói, chữ lớn như câu hỏi. */
  buildExaminerCard() {
    this.avatar = h("span", { class: "avatar", "aria-hidden": "true" }, h("span", {}, "M"));
    this.statusSlot = h("div", { class: "status-slot", "aria-live": "polite" });
    this.questionEl = h("p", { class: "question-text" },
      h("span", { class: "placeholder" }, this.mode === "voice" ? "Giám khảo sẽ chào và hỏi câu đầu tiên…" : ""));
    this.thinkingEl = h("div", { class: "skeleton", "aria-hidden": "true", hidden: true }, h("span"), h("span"), h("span"));
    const controls = [];
    if (this.mode === "voice") {
      const captions = h("input", { type: "checkbox", checked: true, onchange: (event) => this.setCaptions(event.target.checked) });
      controls.push(h("label", { class: "check" }, captions, h("span", {}, "Hiện phụ đề")));
    } else {
      controls.push(h("span", { class: "note" }, "Gõ câu trả lời của bạn bên dưới."));
    }
    this.captionsOff = h("p", { class: "thinking-text", hidden: true }, "Phụ đề đang tắt. Hội thoại vẫn được ghi lại để chấm điểm.");
    return h("section", { class: "card-lg", "aria-live": "polite" },
      h("div", { class: "examiner-head" },
        h("div", { class: "examiner" }, this.avatar,
          h("div", { class: "examiner-name" }, h("strong", {}, "Anh Minh"), h("span", {}, `Hỏi theo ${this.session.document_title}`))),
        this.statusSlot),
      this.questionEl,
      this.thinkingEl,
      this.captionsOff,
      h("div", { class: "control-row" }, controls));
  }

  /** Ô trả lời của chế độ giọng nói: sóng âm micro và lời người học đang nói. */
  buildVoiceCard() {
    this.listenLabel = h("strong", {}, "Đang kết nối");
    this.listenDot = h("span", { class: "live" });
    this.waveEl = h("div", { class: "waveform", "aria-hidden": "true" }, Array.from({ length: LEVEL_BARS }, () => h("i")));
    this.answerEl = h("p", { class: "transcript", "aria-live": "polite" });
    this.muteBtn = h("button", { type: "button", class: "btn-pill btn-lg", onclick: () => this.voice && this.voice.setMuted(!this.voice.muted) });
    this.clearAnswer();
    this.answerCard = h("section", { class: "answer-card is-listening" },
      h("div", { class: "answer-part" },
        h("div", { class: "listen-row" }, h("div", { class: "listen-state" }, this.listenDot, this.listenLabel), this.waveEl),
        this.answerEl),
      h("hr", { class: "divider" }),
      h("div", { class: "answer-foot" },
        h("div", { class: "foot-left" }, img(ICONS.micOn64, 64), h("div", { class: "foot-text" },
          h("span", {}, "Cứ nói tự nhiên, giám khảo nghe liên tục"),
          h("span", {}, "Bạn có thể ngắt lời, giám khảo dừng ngay"))),
        h("div", { class: "foot-buttons" }, this.muteBtn)));
    return this.answerCard;
  }

  /** Lịch sử hội thoại; ở chế độ nhắn tin thì kèm ô trả lời. */
  buildChatCard() {
    this.chat = h("div", { class: "chat", "aria-live": "polite" });
    // Theo thiết kế không hiện lịch sử; khung vẫn giữ vì hội thoại được ghi vào đây.
    const history = h("section", { class: "card-lg chat-card", hidden: true },
      h("p", { class: "label-caps" }, this.mode === "voice" ? "Phụ đề hội thoại" : "Hội thoại"), this.chat);
    if (this.mode !== "text") return history;

    this.input = h("textarea", {
      class: "answer-input",
      rows: "4",
      maxlength: "4000",
      "aria-label": "Câu trả lời của bạn",
      placeholder: "Gõ câu trả lời… (Enter để gửi, Shift + Enter để xuống dòng)",
      onkeydown: (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          this.sendMessage();
        }
      },
    });
    this.sendBtn = pillButton("Gửi", { icon: ICONS.checkWhite16, iconSize: 16, className: "btn-pill btn-lg btn-solid", onclick: () => this.sendMessage() });
    const clearBtn = pillButton("Xoá", { icon: ICONS.replay, iconSize: 14, className: "btn-pill btn-lg", onclick: () => {
      this.input.value = "";
      this.input.focus();
    } });
    this.composer = h("section", { class: "answer-card is-listening" },
      this.input,
      h("hr", { class: "divider" }),
      h("div", { class: "answer-foot" },
        h("div", { class: "foot-text" }, h("span", {}, "Bấm Gửi khi trả lời xong"), h("span", {}, "Shift + Enter để xuống dòng")),
        h("div", { class: "foot-buttons" }, clearBtn, this.sendBtn)));
    return [this.composer, history];
  }

  clearAnswer() {
    if (this.answerEl) this.answerEl.replaceChildren(h("span", { class: "placeholder" }, "Bắt đầu nói câu trả lời của bạn…"));
  }

  /** Hiện câu giám khảo vừa nói ở card giám khảo và lời người học ở ô trả lời. */
  showTurn(role, text) {
    if (role === "interviewer") {
      this.questionEl.textContent = text;
      return;
    }
    if (this.answerEl) this.answerEl.textContent = text;
  }

  renderTextStatus(thinking) {
    this.statusSlot.replaceChildren(thinking
      ? h("span", { class: "chip status-chip", style: "color: var(--ink); font-weight: 600" }, img(ICONS.loader14, 14, "spin"), "Đang suy nghĩ")
      : h("span", { class: "chip is-success status-chip" }, img(ICONS.dot, 6), "Đang chờ bạn trả lời"));
    this.questionEl.hidden = thinking;
    this.thinkingEl.hidden = !thinking;
  }

  // -- Hội thoại ---------------------------------------------------------------

  scrollChat() {
    this.chat.scrollTop = this.chat.scrollHeight;
  }

  addTurn(role, text) {
    const label = role === "interviewer" ? "Giám khảo AI" : this.session.learner_name;
    const turn = h("div", { class: `turn${role === "learner" ? " is-learner" : ""}` }, h("span", {}, label), h("p", { class: "turn-text" }, text));
    if (role === "learner") this.learnerTurns += 1;
    this.chat.append(turn);
    this.scrollChat();
    if (text) this.showTurn(role, text);
    return turn;
  }

  appendTranscript(role, text) {
    if (this.ended) return;
    let turn = this.bubbles[role];
    if (!turn) {
      turn = this.addTurn(role, "");
      // Lời người học thuộc về lượt hiện tại nên luôn đứng trước câu trả lời của AI trong cùng lượt.
      if (role === "learner" && this.bubbles.interviewer) this.chat.insertBefore(turn, this.bubbles.interviewer);
      // Câu hỏi mới mà người học chưa nói gì trong lượt này thì làm trống ô trả lời.
      if (role === "interviewer" && !this.bubbles.learner) this.clearAnswer();
      this.bubbles[role] = turn;
    }
    const turnText = turn.querySelector(".turn-text");
    turnText.textContent += text;
    this.showTurn(role, turnText.textContent);
    this.scrollChat();
  }

  endTranscriptTurn(interrupted) {
    if (interrupted && this.bubbles.interviewer) this.bubbles.interviewer.classList.add("is-interrupted");
    this.bubbles = { learner: null, interviewer: null };
  }

  setCaptions(on) {
    this.chat.hidden = !on;
    this.questionEl.hidden = !on;
    if (this.answerEl) this.answerEl.hidden = !on;
    this.captionsOff.hidden = on;
    if (on) this.scrollChat();
  }

  async sendMessage() {
    const text = this.input.value.trim();
    if (!text || this.sending || this.finished) return;
    this.sendBtn.disabled = true;
    this.input.value = "";
    const ok = await this.postAnswer(text);
    // Máy chủ không lưu lượt bị lỗi nên trả lại nội dung để người học gửi lại.
    if (!ok && !this.ended) this.input.value = text;
    this.sendBtn.disabled = false;
    if (!this.finished && !this.ended) this.input.focus();
  }

  /** Gửi câu trả lời qua phiên nhắn tin. Lỗi thì bỏ lượt vừa thêm và trả về false. */
  async postAnswer(text) {
    this.sending = true;
    const turn = this.addTurn("learner", text);
    const typing = h("div", { class: "typing", "aria-label": "Giám khảo đang soạn câu trả lời" }, h("span"), h("span"), h("span"));
    this.chat.append(typing);
    this.scrollChat();
    this.renderTextStatus(true);
    try {
      const result = await api.sendAnswer(this.session.id, text);
      if (this.ended) return false;
      typing.remove();
      this.addTurn("interviewer", result.message);
      if (result.finished) this.markFinished();
      return true;
    } catch (error) {
      typing.remove();
      turn.remove();
      this.learnerTurns -= 1;
      if (error.status === 409) this.markFinished();
      toast(error.message);
      return false;
    } finally {
      this.sending = false;
      this.renderTextStatus(false);
      this.refreshInsights();
    }
  }

  // -- Giọng nói ---------------------------------------------------------------

  renderVoiceState() {
    const voice = this.voice;
    if (!voice || !this.statusSlot || this.mode !== "voice") return;
    const state = voice.visualState;
    this.avatar.classList.toggle("is-speaking", state === "speaking");
    this.muteBtn.replaceChildren(voice.muted ? maskIcon(ICONS.mic, 14) : img(ICONS.micOff14, 14), h("span", {}, voice.muted ? "Bật mic" : "Tắt mic"));
    this.muteBtn.setAttribute("aria-pressed", String(voice.muted));
    this.muteBtn.disabled = state === "ended" || state === "error";

    const label = state === "listening" && this.learnerSpeaking ? "Bạn đang nói…" : voice.label;
    const key = `${state}|${label}`;
    if (key !== this.statusKey) {
      this.statusKey = key;
      this.statusSlot.replaceChildren(statusChip(state, label));
      const listening = state === "listening";
      this.listenLabel.textContent = listening ? (this.learnerSpeaking ? "Bạn đang nói" : "Đang nghe")
        : state === "speaking" ? "Giám khảo đang nói" : label;
      this.listenDot.hidden = !listening;
    }
    this.errorSlot.replaceChildren(voice.error ? notice("danger", img(ICONS.alert, 18), "Giọng nói gặp lỗi", voice.error) : "");
  }

  renderLevel(level) {
    if (!this.waveEl) return;
    const speaking = level > SPEAKING_LEVEL;
    if (speaking !== this.learnerSpeaking) {
      this.learnerSpeaking = speaking;
      this.renderVoiceState();
    }
    const now = performance.now();
    if (now - this.lastLevelAt < LEVEL_SAMPLE_MS) return;
    this.lastLevelAt = now;
    this.levels = [...this.levels.slice(1), Math.min(1, level / FULL_SCALE_LEVEL)];
    const bars = this.waveEl.children;
    this.levels.forEach((value, i) => {
      bars[i].style.height = `${Math.round(4 + value * 28)}px`;
    });
  }

  // -- Kết thúc ----------------------------------------------------------------

  renderClock() {
    if (!this.stripClock) return;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    this.stripClock.textContent = formatClock(elapsed, true);
    this.stripClock.parentElement.classList.toggle("is-warn", elapsed >= this.session.time_limit_seconds);
  }

  markFinished() {
    if (this.finished || !this.session) return;
    this.finished = true;
    clearInterval(this.timer);
    if (this.composer) this.composer.hidden = true;
    if (this.answerCard) this.answerCard.hidden = true;
    this.doneBox.hidden = false;
    this.refreshInsights();
  }

  confirmEnd() {
    if (this.finished) this.finish();
    else this.dialog.showModal();
  }

  finish() {
    if (this.ended || !this.session) return;
    const usedSeconds = (Date.now() - this.startedAt) / 1000;
    this.dispose();
    this.onFinish({ session: this.session, answered: this.learnerTurns, usedSeconds });
  }

  /** Dừng hẳn: tắt giọng nói và các bộ đếm. */
  dispose() {
    this.ended = true;
    clearInterval(this.timer);
    clearInterval(this.insightsTimer);
    if (this.voice) this.voice.stop();
    if (this.dialog.open) this.dialog.close();
  }

  // -- Bảng giáo viên ----------------------------------------------------------

  toggleTeacher() {
    const open = this.teacher.hidden;
    this.teacher.hidden = !open;
    this.root.classList.toggle("with-teacher", open);
    this.teacherBtn.setAttribute("aria-pressed", String(open));
    this.teacherBtn.classList.toggle("is-on", open);
    clearInterval(this.insightsTimer);
    if (open) {
      this.refreshInsights();
      this.insightsTimer = setInterval(() => this.refreshInsights(), INSIGHTS_MS);
    }
  }

  async refreshInsights() {
    if (!this.session || !this.teacher || this.teacher.hidden) return;
    try {
      this.renderInsights(await api.getInsights(this.session.id));
    } catch {
      // Lần làm mới sau sẽ thử lại.
    }
  }

  renderInsights(data) {
    this.progressList.replaceChildren(...data.concepts.map((c) => {
      const meta = [
        c.evidence_count ? `${c.score}/100` : "Chưa có dữ liệu",
        `Bloom cao nhất: ${BLOOM[c.max_bloom] || "—"}`,
        `ý chính ${c.covered_key_points}/${c.total_key_points}`,
      ];
      if (c.hints) meta.push(`${c.hints} gợi ý`);
      if (c.rote_flags) meta.push(`${c.rote_flags} lần có dấu hiệu học thuộc`);
      return h("div", { class: `progress-item${c.id === data.current_concept_id ? " is-current" : ""}` },
        h("div", { class: "progress-top" },
          h("strong", {}, c.name),
          h("span", { class: `chip chip-small ${STATUS_CHIP[c.status] || "chip-white"}` }, STATUS[c.status] || c.status)),
        h("div", { class: "thin-track progress-bar", style: `--value: ${c.evidence_count ? c.score : 0}%` }, h("span")),
        h("p", { class: "progress-meta" }, meta.join(" · ")),
        c.misconceptions.length ? h("p", { class: "progress-warn" }, `Hiểu lầm: ${c.misconceptions.join("; ")}`) : null);
    }));

    if (!data.evaluations.length) {
      this.evalList.replaceChildren(h("p", { class: "muted" }, "Chưa có lượt nào được chấm."));
      return;
    }
    this.evalList.replaceChildren(...data.evaluations.map((e) =>
      h("article", { class: "log-item" },
        h("div", { class: "log-head" },
          h("strong", {}, e.concept_name),
          h("span", { class: "spacer" }),
          e.action ? h("span", { class: "chip chip-white chip-small" }, ACTIONS[e.action] || e.action) : null),
        h("p", { class: "said" }, `“${truncate(e.answer, 180)}”`),
        h("div", { class: "chip-row" },
          scoreChip("Đúng", e.correctness),
          scoreChip("Đủ ý", e.completeness),
          scoreChip("Lập luận", e.reasoning),
          h("span", { class: "chip chip-white chip-small" }, `Bloom: ${BLOOM[e.bloom_level] || "—"}`),
          e.rote_signal === "high" ? h("span", { class: "chip chip-danger chip-small" }, "Nghi học thuộc") : null),
        h("p", { class: "summary" }, e.summary),
        e.reason ? h("p", {}, `Quyết định: ${e.reason}`) : null)));
  }
}

function scoreChip(label, value) {
  return h("span", { class: "chip chip-white chip-small" }, `${label} ${value}/4`);
}

function statusChip(state, label) {
  switch (state) {
    case "speaking":
      return h("span", { class: "chip chip-solid status-chip" },
        h("span", { class: "wave-mini", "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"), h("i")), label);
    case "listening":
      return h("span", { class: "chip is-success status-chip" }, img(ICONS.dot, 6, "live-dot"), label);
    case "muted":
      return h("span", { class: "chip is-warn status-chip" }, img(ICONS.micOff14, 14), label);
    case "ended":
      return h("span", { class: "chip is-success status-chip" }, img(ICONS.check, 14), label);
    case "error":
      return h("span", { class: "chip chip-danger status-chip" }, maskIcon(ICONS.alert, 14), label);
    default:
      return h("span", { class: "chip status-chip" }, img(ICONS.loader14, 14, "spin"), label);
  }
}
