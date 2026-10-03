// Màn 01 · Thiết lập: chọn tài liệu, phạm vi trang, số câu hỏi, thời gian và kiểm tra micro.
// File PDF được đọc ngay trên trình duyệt; chỉ chữ của các trang đã chọn được gửi đi ở bước sau.

import { LIMITS } from "./contract.js";
import { $, ICONS, formatDuration, formatRange, h, img, notice, numberVi, roundWords, setContent } from "./dom.js";
import { BAR_COUNT, MicCheck, TEST_PHRASE } from "./mic-check.js";
import { PdfError, closePdf, countWords, extractPageText, hasLetters, looksVietnamese, openPdf } from "./pdf-text.js";

const SAMPLE = { url: "/samples/Mang_may_tinh_Chuong3.pdf", name: "Mang_may_tinh_Chuong3.pdf" };
const EXTRACT_DELAY_MS = 250;
const LEVEL_ON = 0.15;
const READY_NOTE = "Giám khảo sẽ đọc các trang bạn chọn rồi đặt câu hỏi. Tài liệu được ẩn cho đến khi có kết quả.";
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

const decimalVi = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });

function sampleButton(label) {
  return h("button", { type: "button", class: "btn-pill", "data-action": "use-sample" }, img(ICONS.file, 14), h("span", {}, label));
}

const els = {
  form: $("#setup-form"),
  docField: $("#field-document"),
  dropzone: $("#dropzone"),
  fileInput: $("#file-input"),
  fileRow: $("#file-row"),
  fileName: $("#file-name"),
  fileMeta: $("#file-meta"),
  fileRemove: $("#file-remove"),
  docStatus: $("#document-status"),
  rangeField: $("#field-range"),
  rangeChip: $("#range-chip"),
  pageFrom: $("#page-from"),
  pageFromField: $("#page-from-field"),
  pageFromError: $("#page-from-error"),
  pageTo: $("#page-to"),
  pageToField: $("#page-to-field"),
  pageToError: $("#page-to-error"),
  coverageTotal: $("#coverage-total"),
  coverageRange: $("#coverage-range"),
  coverageFill: $("#coverage-fill"),
  rangeNote: $("#range-note"),
  questions: $("#questions"),
  questionsOutput: $("#questions-output"),
  questionsScale: $("#questions-scale"),
  duration: $("#duration"),
  durationOutput: $("#duration-output"),
  presets: [...document.querySelectorAll(".preset")],
  durationSummary: $("#duration-summary"),
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
  submitLabel: $("#submit-label"),
  ctaNote: $("#cta-note"),
};

const EMPTY_DOC = Object.freeze({ status: "empty", name: "", size: 0, pdf: null, pageCount: 0, error: null });
const EMPTY_EXTRACT = Object.freeze({ status: "idle", key: "", total: 0, words: 0, chars: 0, emptyPages: [], vietnamese: false });

const state = {
  doc: EMPTY_DOC,
  pageFrom: "",
  pageTo: "",
  texts: new Map(),
  extract: EMPTY_EXTRACT,
  questionCount: LIMITS.questionCount.default,
  durationMinutes: LIMITS.durationMinutes.default,
  mic: null,
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
let onStart = () => {};
let docToken = 0;
let extractToken = 0;
let extractTimer = 0;

// -- Định dạng --------------------------------------------------------------

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${numberVi.format(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${decimalVi.format(bytes / (1024 * 1024))} MB`;
}




function formatPageList(pages) {
  const shown = pages.length > 6 ? pages.slice(0, 5) : pages;
  const rest = pages.length - shown.length;
  if (rest) return `${shown.join(", ")} và ${rest} trang khác`;
  if (shown.length === 1) return String(shown[0]);
  return `${shown.slice(0, -1).join(", ")} và ${shown.at(-1)}`;
}

function ratio(value, { min, max }) {
  return String((value - min) / (max - min));
}

// -- Trạng thái dẫn xuất ----------------------------------------------------


function parsePage(value) {
  return /^\d+$/.test(value) ? Number(value) : null;
}

function rangeErrors() {
  const errors = { from: "", to: "" };
  if (state.doc.status !== "open") return errors;
  const total = state.doc.pageCount;
  const from = parsePage(state.pageFrom);
  const to = parsePage(state.pageTo);
  if (from === null) errors.from = "Nhập số trang.";
  else if (from < 1) errors.from = "Trang đầu tiên là 1.";
  else if (from > total) errors.from = `File chỉ có ${total} trang.`;
  const fromValid = !errors.from;

  if (to === null) errors.to = "Nhập số trang.";
  else if (to < 1) errors.to = "Trang đầu tiên là 1.";
  else if (to > total) errors.to = `File chỉ có ${total} trang.`;
  else if (fromValid && to < from) errors.to = `Phải từ trang ${from} trở đi.`;
  else if (fromValid && to - from + 1 > LIMITS.maxPages) {
    errors.to = `Tối đa ${LIMITS.maxPages} trang mỗi lần, tức đến trang ${from + LIMITS.maxPages - 1}.`;
  }
  return errors;
}

function selectedRange() {
  if (state.doc.status !== "open") return null;
  const errors = rangeErrors();
  if (errors.from || errors.to) return null;
  return { from: Number(state.pageFrom), to: Number(state.pageTo) };
}

function documentProblem() {
  const { doc, extract } = state;
  if (doc.status === "opening") return { section: els.docField, focus: null, message: "Đang mở tài liệu…" };
  if (doc.status !== "open") {
    return { section: els.docField, focus: els.fileInput, message: "Cần tải tài liệu trước khi tiếp tục." };
  }
  const errors = rangeErrors();
  if (errors.from || errors.to) {
    return { section: els.rangeField, focus: errors.from ? els.pageFrom : els.pageTo, message: "Phạm vi trang chưa hợp lệ." };
  }
  if (extract.status === "error") return { section: els.docField, focus: null, message: "Chưa đọc được chữ trong tài liệu." };
  if (extract.status !== "done") {
    return { section: els.rangeField, focus: null, message: "Đang đọc chữ trong các trang đã chọn…" };
  }
  if (extract.emptyPages.length === extract.total) {
    return { section: els.docField, focus: null, message: "Các trang đã chọn chưa có chữ để giám khảo đọc." };
  }
  if (extract.chars > LIMITS.maxTotalChars) {
    return { section: els.rangeField, focus: els.pageTo, message: "Các trang đã chọn có quá nhiều chữ. Hãy chọn ít trang hơn." };
  }
  return null;
}

function firstProblem() {
  const problem = documentProblem();
  if (problem) return problem;
  if (state.mic.status !== "ready") {
    const focus = MIC_PROBLEMS[state.mic.status] ? els.micRetry : els.micStart;
    return { section: els.micField, focus, message: "Cần thử micro trước khi tiếp tục." };
  }
  return null;
}

// -- Tài liệu ---------------------------------------------------------------

function cancelExtract() {
  clearTimeout(extractTimer);
  extractToken += 1;
}

function closeDocument() {
  docToken += 1;
  cancelExtract();
  if (state.doc.pdf) closePdf(state.doc.pdf);
  state.doc = EMPTY_DOC;
  state.texts = new Map();
  state.pageFrom = "";
  state.pageTo = "";
  state.extract = EMPTY_EXTRACT;
}

function showDocumentError(title, body) {
  closeDocument();
  state.doc = { ...EMPTY_DOC, status: "error", error: { title, body } };
  render();
}

function documentErrorText(error) {
  if (error instanceof PdfError && error.code === "password") {
    return [error.message, "Hãy bỏ mật khẩu rồi tải lại, hoặc thử file mẫu."];
  }
  if (error instanceof PdfError && error.code === "library") {
    return [error.message, "Kiểm tra kết nối mạng rồi chọn lại file."];
  }
  return ["Không mở được file này.", "File có thể bị hỏng. Hãy thử file khác, hoặc thử file mẫu."];
}

function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

async function loadFile(file) {
  closeDocument();
  if (!isPdf(file)) {
    showDocumentError("Chỉ nhận file PDF.", "Hãy chọn file .pdf có lớp chữ, hoặc thử file mẫu.");
    return;
  }
  if (file.size > LIMITS.fileMaxBytes) {
    showDocumentError("File lớn hơn 50 MB.", "Hãy tách phần cần ôn thành file nhỏ hơn, hoặc thử file mẫu.");
    return;
  }
  const token = docToken;
  state.doc = { ...EMPTY_DOC, status: "opening", name: file.name, size: file.size };
  render();

  let pdf;
  try {
    pdf = await openPdf(file);
  } catch (error) {
    if (token === docToken) showDocumentError(...documentErrorText(error));
    return;
  }
  if (token !== docToken) {
    closePdf(pdf);
    return;
  }
  state.doc = { ...state.doc, status: "open", pdf, pageCount: pdf.numPages };
  state.pageFrom = "1";
  state.pageTo = String(Math.min(pdf.numPages, LIMITS.maxPages));
  scheduleExtract(0);
}

async function useSample() {
  closeDocument();
  const token = docToken;
  state.doc = { ...EMPTY_DOC, status: "opening", name: SAMPLE.name };
  render();
  let blob;
  try {
    const response = await fetch(SAMPLE.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    blob = await response.blob();
  } catch {
    if (token === docToken) showDocumentError("Không tải được file mẫu.", "Kiểm tra kết nối tới máy chủ rồi thử lại.");
    return;
  }
  if (token === docToken) await loadFile(new File([blob], SAMPLE.name, { type: "application/pdf" }));
}

function removeDocument() {
  closeDocument();
  render();
  els.fileInput.focus();
}

function scheduleExtract(delay = EXTRACT_DELAY_MS) {
  cancelExtract();
  const range = selectedRange();
  if (!range) {
    state.extract = EMPTY_EXTRACT;
    render();
    return;
  }
  const key = `${range.from}-${range.to}`;
  state.extract = { ...EMPTY_EXTRACT, status: "running", key, total: range.to - range.from + 1 };
  render();
  const token = extractToken;
  extractTimer = setTimeout(() => runExtract(range, key, token), delay);
}

async function runExtract({ from, to }, key, token) {
  const { pdf } = state.doc;
  try {
    for (let page = from; page <= to; page += 1) {
      if (state.texts.has(page)) continue;
      const text = await extractPageText(pdf, page);
      if (token !== extractToken) return;
      state.texts.set(page, text);
    }
  } catch {
    if (token !== extractToken) return;
    state.extract = { ...EMPTY_EXTRACT, status: "error", key };
    render();
    return;
  }
  if (token !== extractToken) return;

  let words = 0;
  let chars = 0;
  let sample = "";
  const emptyPages = [];
  for (let page = from; page <= to; page += 1) {
    const text = state.texts.get(page);
    words += countWords(text);
    chars += text.length;
    if (!hasLetters(text)) emptyPages.push(page);
    if (sample.length < 20_000) sample += `${text}\n`;
  }
  state.extract = {
    status: "done",
    key,
    total: to - from + 1,
    words,
    chars,
    emptyPages,
    vietnamese: looksVietnamese(sample),
  };
  render();
}

// -- Bắt đầu ---------------------------------------------------------------

function focusProblem(problem) {
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  problem.section.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  if (problem.focus && !problem.focus.disabled) problem.focus.focus({ preventScroll: true });
}

function submit(event) {
  event.preventDefault();
  const problem = firstProblem();
  if (problem) {
    focusProblem(problem);
    return;
  }
  const range = selectedRange();
  onStart({
    filename: state.doc.name,
    pageCount: state.doc.pageCount,
    pageFrom: range.from,
    pageTo: range.to,
    pageTexts: new Map(state.texts),
    words: state.extract.words,
    questionCount: state.questionCount,
    durationMinutes: state.durationMinutes,
  });
}

// -- Hiển thị ---------------------------------------------------------------

function renderDocument() {
  const { doc, extract } = state;
  const hasFile = doc.status === "opening" || doc.status === "open";
  els.dropzone.hidden = hasFile;
  els.fileRow.hidden = !hasFile;

  if (hasFile) {
    els.fileName.textContent = doc.name;
    els.fileName.title = doc.name;
    const opening = doc.status === "opening";
    setContent(els.fileMeta, opening ? "opening" : `${doc.pageCount}-${doc.size}`, () => (opening
      ? [h("span", { class: "spinner" }), "Đang mở file…"]
      : [`${numberVi.format(doc.pageCount)} trang · ${formatBytes(doc.size)}`]));
  }

  let key = "none";
  let build = () => [];
  if (doc.status === "error") {
    key = `error:${doc.error.title}`;
    build = () => [notice("danger", img(ICONS.alert, 18), doc.error.title, doc.error.body)];
  } else if (doc.status === "open" && extract.status === "error") {
    key = "extract-error";
    build = () => [
      notice("danger", img(ICONS.alert, 18), "Không đọc được chữ trong tài liệu.", "Hãy chọn lại file, hoặc thử file mẫu."),
      sampleButton("Dùng file mẫu"),
    ];
  } else if (doc.status === "open" && extract.status === "running") {
    key = "running";
    build = () => [h("span", { class: "chip" }, h("span", { class: "spinner" }), "Đang đọc chữ trong các trang đã chọn…")];
  } else if (doc.status === "open" && extract.status === "done") {
    if (extract.emptyPages.length === extract.total) {
      const wholeFile = extract.total === doc.pageCount;
      key = `scan:${wholeFile}`;
      build = () => [
        notice("danger", img(ICONS.alert, 18),
          wholeFile ? "File này là bản scan nên không đọc được chữ." : "Các trang đã chọn là bản scan nên không đọc được chữ.",
          wholeFile
            ? "Hãy dùng file PDF có thể bôi đen chữ, hoặc thử file mẫu."
            : "Hãy chọn trang khác, dùng file PDF có thể bôi đen chữ, hoặc thử file mẫu."),
        sampleButton("Dùng file mẫu"),
      ];
    } else {
      key = `ok:${extract.vietnamese}`;
      build = () => [h("span", { class: "chip is-success" }, img(ICONS.check, 14),
        extract.vietnamese ? "Đọc được chữ tiếng Việt" : "Đọc được chữ")];
    }
  }
  setContent(els.docStatus, key, build);
}

function setFieldError(field, input, errorNode, message) {
  field.classList.toggle("is-invalid", Boolean(message));
  input.setAttribute("aria-invalid", String(Boolean(message)));
  errorNode.hidden = !message;
  errorNode.textContent = message;
}

function renderRange() {
  const { doc, extract } = state;
  const open = doc.status === "open";
  for (const [input, value] of [[els.pageFrom, state.pageFrom], [els.pageTo, state.pageTo]]) {
    input.disabled = !open;
    if (input.value !== value) input.value = value;
  }
  const errors = rangeErrors();
  setFieldError(els.pageFromField, els.pageFrom, els.pageFromError, errors.from);
  setFieldError(els.pageToField, els.pageTo, els.pageToError, errors.to);

  const range = selectedRange();
  els.rangeChip.hidden = !range;
  if (range) {
    const pages = range.to - range.from + 1;
    let words = "đang đếm chữ…";
    if (extract.status === "done") {
      words = extract.words ? `khoảng ${numberVi.format(roundWords(extract.words))} từ` : "không có chữ";
    }
    els.rangeChip.textContent = `${numberVi.format(pages)} trang · ${words}`;
  }

  if (open) els.coverageTotal.textContent = `File có ${numberVi.format(doc.pageCount)} trang`;
  else els.coverageTotal.textContent = doc.status === "opening" ? "Đang mở file…" : "Chưa có tài liệu";
  els.coverageRange.textContent = range ? formatRange(range) : "";
  els.coverageFill.hidden = !range;
  if (range) {
    els.coverageFill.style.setProperty("--start", `${((range.from - 1) / doc.pageCount) * 100}%`);
    els.coverageFill.style.setProperty("--size", `${((range.to - range.from + 1) / doc.pageCount) * 100}%`);
  }

  let note = null;
  if (open && extract.status === "done" && extract.chars > LIMITS.maxTotalChars) {
    note = {
      kind: "is-danger",
      text: `Các trang đã chọn có khoảng ${numberVi.format(extract.chars)} ký tự, quá giới hạn ${numberVi.format(LIMITS.maxTotalChars)}. Hãy chọn ít trang hơn.`,
    };
  } else if (open && extract.status === "done" && extract.emptyPages.length && extract.emptyPages.length < extract.total) {
    note = { kind: "", text: `Trang ${formatPageList(extract.emptyPages)} không có lớp chữ nên giám khảo sẽ bỏ qua.` };
  }
  els.rangeNote.hidden = !note;
  if (note) {
    els.rangeNote.className = `field-note ${note.kind}`.trim();
    els.rangeNote.textContent = note.text;
  }
}

function renderQuestions() {
  const value = state.questionCount;
  els.questions.value = String(value);
  els.questions.style.setProperty("--ratio", ratio(value, LIMITS.questionCount));
  els.questions.setAttribute("aria-valuetext", `${value} câu`);
  els.questionsOutput.textContent = String(value);
  for (const tick of els.questionsScale.children) tick.classList.toggle("is-current", Number(tick.dataset.value) === value);
}

function renderDuration() {
  const minutes = state.durationMinutes;
  els.duration.value = String(minutes);
  els.duration.style.setProperty("--ratio", ratio(minutes, LIMITS.durationMinutes));
  els.duration.setAttribute("aria-valuetext", `${minutes} phút`);
  els.durationOutput.textContent = `${minutes}:00`;
  for (const preset of els.presets) {
    preset.setAttribute("aria-pressed", String(Number(preset.dataset.minutes) === minutes));
  }

  // Thời lượng trung bình mỗi câu, làm tròn 10 giây.
  const perQuestion = Math.round((minutes * 60) / state.questionCount / 10) * 10;
  const hurried = perQuestion < 60;
  els.durationSummary.className = hurried ? "field-note is-warn" : "field-note";
  els.durationSummary.replaceChildren(
    "Tổng: ",
    h("strong", {}, `${state.questionCount} câu trong ${minutes} phút`),
    hurried
      ? ` · trung bình chỉ khoảng ${formatDuration(perQuestion)} mỗi câu, hơi gấp`
      : ` · trung bình khoảng ${formatDuration(perQuestion)} mỗi câu, tính cả lúc giám khảo đọc câu hỏi`,
  );
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
  return { cls: "chip", text: "Chưa kiểm tra" };
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
  els.submit.setAttribute("aria-disabled", String(Boolean(problem)));
  let note = READY_NOTE;
  if ((state.doc.status === "empty" || state.doc.status === "error") && state.mic.status !== "ready") {
    note = "Cần tải tài liệu và thử micro trước khi tiếp tục.";
  } else if (problem) note = problem.message;
  els.ctaNote.textContent = note;
}

function render() {
  renderDocument();
  renderRange();
  renderQuestions();
  renderDuration();
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
    if (file) loadFile(file);
  });
  els.dropzone.addEventListener("click", (event) => {
    if (!event.target.closest("button, label, input")) els.fileInput.click();
  });
  els.fileRemove.addEventListener("click", removeDocument);
  els.docField.addEventListener("click", (event) => {
    if (event.target.closest('[data-action="use-sample"]')) useSample();
  });

  // Thả file vào cả khu "Tài liệu", kể cả khi đã có file (để đổi file khác).
  let dragDepth = 0;
  els.docField.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    els.dropzone.classList.add("is-dragging");
  });
  els.docField.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  els.docField.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.dropzone.classList.remove("is-dragging");
  });
  els.docField.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    els.dropzone.classList.remove("is-dragging");
    const [file] = event.dataTransfer.files;
    if (file) loadFile(file);
  });
  // Thả nhầm ra ngoài thì không để trình duyệt mở file PDF thay cho trang.
  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (!els.docField.contains(event.target)) event.dataTransfer.dropEffect = "none";
  });
  window.addEventListener("drop", (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
}

function setupRangeInputs() {
  for (const [input, key] of [[els.pageFrom, "pageFrom"], [els.pageTo, "pageTo"]]) {
    input.addEventListener("input", () => {
      state[key] = input.value.replace(/\D/g, "");
          scheduleExtract();
    });
  }
}

function setupSliders() {
  const { questionCount, durationMinutes } = LIMITS;
  Object.assign(els.questions, { min: questionCount.min, max: questionCount.max });
  Object.assign(els.duration, { min: durationMinutes.min, max: durationMinutes.max });
  for (let value = questionCount.min; value <= questionCount.max; value += 1) {
    const left = (value - questionCount.min) / (questionCount.max - questionCount.min);
    els.questionsScale.append(h("span", { "data-value": value, style: `left: calc(10px + (100% - 20px) * ${left})` }, value));
  }
  els.questions.addEventListener("input", () => {
    state.questionCount = Number(els.questions.value);
      render();
  });
  els.duration.addEventListener("input", () => {
    state.durationMinutes = Number(els.duration.value);
      render();
  });
  for (const preset of els.presets) {
    preset.addEventListener("click", () => {
      state.durationMinutes = Number(preset.dataset.minutes);
          render();
    });
  }
}

/** Gắn sự kiện cho màn Thiết lập. onStartInterview nhận thiết lập khi người học bấm bắt đầu. */
export function initSetup({ onStartInterview }) {
  onStart = onStartInterview;
  els.micLevel.append(...Array.from({ length: BAR_COUNT }, () => h("span")));
  levelBars = [...els.micLevel.children];
  setupDocumentInput();
  setupRangeInputs();
  setupSliders();
  els.micStart.addEventListener("click", () => mic.start());
  els.micRetry.addEventListener("click", () => mic.start());
  els.form.addEventListener("submit", submit);
  window.addEventListener("pagehide", () => mic.stop());
  render();
}
