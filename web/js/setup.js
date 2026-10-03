// Màn 01 · Thiết lập: tải tài liệu lên máy chủ để soạn câu hỏi, chọn tài liệu, tên người học,
// hình thức phỏng vấn (giọng nói hoặc nhắn tin) và thử micro.

import * as api from "./api.js";
import { $, ICONS, formatClock, h, img, notice, setContent } from "./dom.js";
import { BAR_COUNT, MicCheck, TEST_PHRASE } from "./mic-check.js";

const SAMPLE = { url: "/samples/Mang_may_tinh_Chuong3.pdf", name: "Mang_may_tinh_Chuong3.pdf" };
const SUPPORTED = /\.(pdf|docx|txt|md)$/i;
const IMPORTANCE = { 3: "Cốt lõi", 2: "Quan trọng", 1: "Bổ trợ" };
const LEVEL_ON = 0.15;
const MODE_NOTES = {
  voice: "Trò chuyện real-time với giám khảo AI bằng giọng nói qua Gemini Live. Bạn có thể ngắt lời, AI dừng ngay.",
  dictate: "Giám khảo đọc câu hỏi, bạn nói câu trả lời rồi bấm Trả lời để xem lại và sửa chữ máy nghe nhầm, bấm Trả lời lần nữa để nộp. Cần Chrome hoặc Edge.",
  text: "Trả lời bằng cách gõ phím. Cùng bộ não chấm điểm, tiện để thử mà không tốn quota giọng nói.",
};
const MIC_PROBLEMS = {
  blocked: {
    icon: ICONS.lock,
    chip: "Bị chặn",
    title: "Trình duyệt đang chặn micro",
    body: "Bấm biểu tượng ổ khoá trên thanh địa chỉ, chọn Cho phép micro, rồi bấm Thử lại.",
  },
  "no-device": {
    icon: ICONS.alert,
    chip: "Chưa dùng được",
    title: "Không tìm thấy micro",
    body: "Cắm tai nghe hoặc micro vào máy rồi bấm Thử lại.",
  },
  busy: {
    icon: ICONS.alert,
    chip: "Chưa dùng được",
    title: "Micro đang bận",
    body: "Một ứng dụng khác đang dùng micro. Đóng ứng dụng đó rồi bấm Thử lại.",
  },
  unsupported: {
    icon: ICONS.alert,
    chip: "Chưa dùng được",
    title: "Trình duyệt chưa cho dùng micro ở đây",
    body: "Hãy mở trang bằng Chrome hoặc Edge, qua localhost hoặc HTTPS.",
  },
  "not-heard": {
    icon: ICONS.alert,
    chip: "Chưa nghe thấy",
    title: "Chưa nghe thấy bạn nói",
    body: "Kiểm tra micro hoặc nói gần hơn, rồi bấm Thử lại.",
  },
  error: {
    icon: ICONS.alert,
    chip: "Chưa dùng được",
    title: "Không mở được micro",
    body: "Bấm Thử lại. Nếu vẫn lỗi, hãy tải lại trang.",
  },
};

const els = {
  form: $("#setup-form"),
  docField: $("#field-document"),
  dropzone: $("#dropzone"),
  fileInput: $("#file-input"),
  docStatus: $("#document-status"),
  docListWrap: $("#doc-list-wrap"),
  docList: $("#doc-list"),
  conceptsField: $("#field-concepts"),
  conceptCount: $("#concept-count"),
  docTitle: $("#doc-title"),
  docSummary: $("#doc-summary"),
  docTruncated: $("#doc-truncated"),
  conceptList: $("#concept-list"),
  learnerName: $("#learner-name"),
  modeOptions: [...document.querySelectorAll(".mode-option")],
  modeNote: $("#mode-note"),
  timeLimitHint: $("#time-limit-hint"),
  bargeInRow: $("#barge-in-row"),
  bargeIn: $("#barge-in"),
  micField: $("#field-mic"),
  micChip: $("#mic-chip"),
  micPanel: $("#mic-panel"),
  micBadge: $("#mic-badge"),
  micDevice: $("#mic-device"),
  micDeviceNote: $("#mic-device-note"),
  micLevel: $("#mic-level"),
  micSay: $("#mic-say"),
  micStart: $("#mic-start"),
  micProblem: $("#mic-problem"),
  micProblemIcon: $("#mic-problem-icon"),
  micProblemTitle: $("#mic-problem-title"),
  micProblemBody: $("#mic-problem-body"),
  micRetry: $("#mic-retry"),
  submit: $("#submit-btn"),
  ctaNote: $("#cta-note"),
};

const state = {
  docs: [],
  selectedId: null,
  upload: { status: "idle", name: "", startedAt: 0, message: "" },
  mode: "voice",
  health: null,
  mic: null,
  starting: false,
};

const mic = new MicCheck({
  onChange: (micState) => {
    state.mic = micState;
    render();
  },
  onLevels: renderLevels,
});
state.mic = mic.state;

let levelBars = [];
let onStart = async () => {};
let uploadTimer = 0;

function selectedDoc() {
  return state.docs.find((doc) => doc.id === state.selectedId) || null;
}

// -- Tài liệu ---------------------------------------------------------------

async function loadDocuments() {
  try {
    state.docs = await api.listDocuments();
  } catch (error) {
    state.upload = { status: "error", name: "", startedAt: 0, message: error.message };
    render();
    return;
  }
  if (!selectedDoc() && state.docs.length) state.selectedId = state.docs[0].id;
  render();
}

async function uploadFile(file) {
  if (state.upload.status === "busy") return;
  if (!SUPPORTED.test(file.name)) {
    state.upload = { status: "error", name: file.name, startedAt: 0, message: "Chỉ hỗ trợ file PDF, DOCX, TXT hoặc MD." };
    render();
    return;
  }
  state.upload = { status: "busy", name: file.name, startedAt: Date.now(), message: "" };
  render();
  clearInterval(uploadTimer);
  uploadTimer = setInterval(renderDocument, 1000);
  try {
    const doc = await api.uploadDocument(file);
    state.docs = [doc, ...state.docs.filter((d) => d.id !== doc.id)];
    state.selectedId = doc.id;
    state.upload = {
      status: "ok",
      name: doc.filename,
      startedAt: 0,
      message: `Đã soạn ${doc.concepts.length} chủ đề từ "${doc.filename}".`,
    };
  } catch (error) {
    state.upload = { status: "error", name: file.name, startedAt: 0, message: error.message };
  } finally {
    clearInterval(uploadTimer);
    render();
  }
}

async function useSample() {
  // File mẫu đã được soạn câu hỏi trước đó thì dùng lại, khỏi gọi Gemini thêm lần nữa.
  const existing = state.docs.find((doc) => doc.filename === SAMPLE.name);
  if (existing) {
    state.selectedId = existing.id;
    state.upload = { status: "ok", name: SAMPLE.name, startedAt: 0, message: `Đã chọn file mẫu "${SAMPLE.name}" đã tải trước đó.` };
    render();
    return;
  }
  let blob;
  try {
    const response = await fetch(SAMPLE.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    blob = await response.blob();
  } catch {
    state.upload = { status: "error", name: SAMPLE.name, startedAt: 0, message: "Không tải được file mẫu. Kiểm tra kết nối tới máy chủ rồi thử lại." };
    render();
    return;
  }
  await uploadFile(new File([blob], SAMPLE.name, { type: "application/pdf" }));
}

function selectDocument(id) {
  state.selectedId = id;
  render();
}

// -- Bắt đầu ---------------------------------------------------------------

function firstProblem() {
  if (state.upload.status === "busy") {
    return { section: els.docField, focus: null, message: "Đang soạn câu hỏi từ tài liệu…" };
  }
  if (!selectedDoc()) {
    return { section: els.docField, focus: els.fileInput, message: "Cần tải hoặc chọn một tài liệu trước khi bắt đầu." };
  }
  return null;
}

function focusProblem(problem) {
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  problem.section.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  if (problem.focus && !problem.focus.disabled) problem.focus.focus({ preventScroll: true });
}

async function submit(event) {
  event.preventDefault();
  if (state.starting) return;
  const problem = firstProblem();
  if (problem) {
    focusProblem(problem);
    return;
  }
  mic.stop();
  state.starting = true;
  render();
  try {
    // onStart phải được gọi đồng bộ trong thao tác bấm nút để trình duyệt cho phát âm thanh.
    await onStart({
      doc: selectedDoc(),
      learnerName: els.learnerName.value.trim() || "bạn",
      mode: state.mode,
      bargeIn: els.bargeIn.checked,
    });
  } finally {
    state.starting = false;
    render();
  }
}

// -- Hiển thị ---------------------------------------------------------------

function renderDocument() {
  const { upload } = state;
  let key = "none";
  let build = () => [];
  if (upload.status === "busy") {
    const seconds = Math.round((Date.now() - upload.startedAt) / 1000);
    key = `busy:${seconds}`;
    build = () => [h("span", { class: "chip" }, h("span", { class: "spinner" }),
      `Đang đọc "${upload.name}" và soạn câu hỏi… ${seconds}s`)];
  } else if (upload.status === "error") {
    key = `error:${upload.message}`;
    build = () => [notice("danger", img(ICONS.alert, 18), upload.name ? `Chưa dùng được "${upload.name}"` : "Có lỗi khi tải tài liệu", upload.message)];
  } else if (upload.status === "ok") {
    key = `ok:${upload.message}`;
    build = () => [h("span", { class: "chip is-success" }, img(ICONS.check, 14), upload.message)];
  }
  setContent(els.docStatus, key, build);
  els.dropzone.classList.toggle("is-busy", upload.status === "busy");
}

function renderDocList() {
  els.docListWrap.hidden = state.docs.length === 0;
  els.docList.replaceChildren(...state.docs.map((doc) => {
    const active = doc.id === state.selectedId;
    return h("li", {},
      h("button", {
        type: "button",
        class: `file-row doc-item${active ? " is-active" : ""}`,
        "aria-pressed": String(active),
        onclick: () => selectDocument(doc.id),
      },
      h("span", { class: "file-row-icon" }, img(ICONS.filePrimary, 18)),
      h("span", { class: "file-row-text" },
        h("span", { class: "file-row-name" }, doc.title),
        h("span", { class: "file-row-meta" }, `${doc.filename} · ${doc.concepts.length} chủ đề`)),
      active ? img(ICONS.check, 16) : null));
  }));
}

function renderConcepts() {
  const doc = selectedDoc();
  els.conceptsField.hidden = !doc;
  if (!doc) return;
  els.conceptCount.textContent = `${doc.concepts.length} chủ đề`;
  els.docTitle.textContent = doc.title;
  els.docSummary.textContent = doc.summary;
  els.docTruncated.hidden = !doc.truncated;
  setContent(els.conceptList, doc.id, () => doc.concepts.map((concept) =>
    h("li", {},
      h("div", { class: "concept-row-head" },
        h("strong", {}, concept.name),
        IMPORTANCE[concept.importance]
          ? h("span", { class: `chip chip-small${concept.importance === 3 ? " chip-solid" : ""}` }, IMPORTANCE[concept.importance])
          : null),
      h("p", {}, concept.summary))));
}

function renderMode() {
  for (const option of els.modeOptions) option.setAttribute("aria-pressed", String(option.dataset.mode === state.mode));
  els.modeNote.textContent = MODE_NOTES[state.mode];
  els.bargeInRow.hidden = state.mode !== "voice";
  els.micField.hidden = state.mode === "text";
  const minutes = state.health && state.health.interview_minutes;
  els.timeLimitHint.textContent = minutes ? `Tối đa ${formatClock(minutes * 60)} mỗi buổi` : "";
}

function renderLevels(levels) {
  levels.forEach((value, index) => {
    const bar = levelBars[index];
    if (!bar) return;
    const on = value >= LEVEL_ON;
    bar.classList.toggle("is-on", on);
    bar.style.height = on ? `${Math.round(6 + value * 16)}px` : "";
  });
}

function micChip(status) {
  if (status === "ready") return { cls: "chip is-success", dot: true, text: "Đã sẵn sàng" };
  if (status === "listening") return { cls: "chip", dot: true, live: true, text: "Đang nghe" };
  if (status === "requesting") return { cls: "chip", text: "Đang xin quyền…" };
  if (MIC_PROBLEMS[status]) return { cls: "chip is-warn", text: MIC_PROBLEMS[status].chip };
  return { cls: "chip", text: "Không bắt buộc" };
}

function renderMic() {
  const { status, device, transcript, interim, matched } = state.mic;
  const chip = micChip(status);
  els.micChip.className = chip.cls;
  setContent(els.micChip, `${status}`, () => [
    chip.dot ? h("img", { src: ICONS.dot, width: 6, height: 6, alt: "", class: chip.live ? "live-dot" : null }) : null,
    chip.text,
  ]);

  const problem = MIC_PROBLEMS[status];
  els.micPanel.hidden = Boolean(problem);
  els.micProblem.hidden = !problem;
  if (problem) {
    els.micProblemIcon.style.setProperty("--icon", `url('${problem.icon}')`);
    els.micProblemTitle.textContent = problem.title;
    els.micProblemBody.textContent = problem.body;
    return;
  }

  const granted = status === "listening" || status === "ready";
  els.micBadge.classList.toggle("is-on", granted);
  els.micDevice.textContent = granted ? device : "Micro của bạn";
  els.micDeviceNote.textContent = granted ? "· đã cấp quyền micro" : status === "requesting" ? "· đang xin quyền" : "· chưa kiểm tra";

  const phrase = h("span", { class: "phrase" }, `"${TEST_PHRASE}"`);
  let say;
  if (status === "ready" && matched) {
    say = ["Nói thử: ", phrase, h("span", { class: "ok" }, "  ·  nhận dạng đúng")];
  } else if (status === "ready" && transcript) {
    say = ["Nghe được: ", h("span", { class: "phrase" }, `"${transcript}"`), h("span", { class: "ok" }, "  ·  micro hoạt động tốt")];
  } else if (status === "ready") {
    say = ["Đã nghe thấy giọng của bạn", h("span", { class: "ok" }, "  ·  micro hoạt động tốt")];
  } else if (status === "listening") {
    say = ["Nói thử: ", phrase, interim ? h("span", { class: "interim" }, `  ·  "${interim}"`) : null];
  } else if (status === "requesting") {
    say = ["Trình duyệt sẽ hỏi quyền dùng micro, hãy chọn Cho phép."];
  } else {
    say = ["Bấm Kiểm tra micro rồi nói: ", phrase];
  }
  setContent(els.micSay, `${status}|${matched}|${transcript}|${interim}`, () => say);

  els.micStart.disabled = status === "requesting";
  setContent(els.micStart, granted ? "retry" : "start", () => (granted
    ? [img(ICONS.replay, 14), h("span", {}, "Thử lại")]
    : [h("span", {}, "Kiểm tra micro")]));
}

function renderCta() {
  const problem = firstProblem();
  els.submit.setAttribute("aria-disabled", String(Boolean(problem) || state.starting));
  els.submit.setAttribute("aria-busy", String(state.starting));
  els.submit.querySelector("span").textContent = state.starting ? "Đang chuẩn bị…" : "Bắt đầu phỏng vấn";
  let note = state.mode !== "text"
    ? "Trình duyệt sẽ xin quyền dùng micro khi bắt đầu. Giám khảo AI sẽ chào và hỏi câu đầu tiên."
    : "Giám khảo AI sẽ gửi câu hỏi đầu tiên ngay khi bắt đầu.";
  if (problem) note = problem.message;
  else if (state.health && !state.health.llm_configured) note = "Máy chủ chưa có GEMINI_API_KEY nên chưa phỏng vấn được.";
  els.ctaNote.textContent = note;
}

function render() {
  renderDocument();
  renderDocList();
  renderConcepts();
  renderMode();
  renderMic();
  renderCta();
}

// -- Khởi động --------------------------------------------------------------

function hasFiles(event) {
  return Boolean(event.dataTransfer) && [...event.dataTransfer.types].includes("Files");
}

function setupDocumentInput() {
  els.fileInput.addEventListener("change", () => {
    const [file] = els.fileInput.files;
    els.fileInput.value = "";
    if (file) uploadFile(file);
  });
  els.dropzone.addEventListener("click", (event) => {
    if (!event.target.closest("button, label, input")) els.fileInput.click();
  });
  els.docField.addEventListener("click", (event) => {
    if (event.target.closest('[data-action="use-sample"]')) useSample();
  });

  let dragDepth = 0;
  els.dropzone.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    els.dropzone.classList.add("is-dragging");
  });
  els.dropzone.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  els.dropzone.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.dropzone.classList.remove("is-dragging");
  });
  els.dropzone.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    els.dropzone.classList.remove("is-dragging");
    const [file] = event.dataTransfer.files;
    if (file) uploadFile(file);
  });
  // Thả nhầm ra ngoài thì không để trình duyệt mở file thay cho trang.
  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (!els.dropzone.contains(event.target)) event.dataTransfer.dropEffect = "none";
  });
  window.addEventListener("drop", (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
}

function setupMode() {
  for (const option of els.modeOptions) {
    option.addEventListener("click", () => {
      state.mode = option.dataset.mode;
      if (state.mode === "text") mic.stop();
      render();
    });
  }
}

/** Thông tin máy chủ (thời lượng tối đa, đã có key Gemini chưa) để hiển thị trên màn thiết lập. */
export function setHealth(health) {
  state.health = health;
  render();
}

/** Gắn sự kiện cho màn Thiết lập. onStartInterview({ doc, learnerName, mode, bargeIn }) trả về Promise. */
export function initSetup({ onStartInterview }) {
  onStart = onStartInterview;
  els.micLevel.append(...Array.from({ length: BAR_COUNT }, () => h("span")));
  levelBars = [...els.micLevel.children];
  setupDocumentInput();
  setupMode();
  els.micStart.addEventListener("click", () => mic.start());
  els.micRetry.addEventListener("click", () => mic.start());
  els.form.addEventListener("submit", submit);
  window.addEventListener("pagehide", () => mic.stop());
  render();
  loadDocuments();
}
