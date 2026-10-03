// Màn 01 · Các ô Phạm vi trang, Số câu hỏi, Thời gian phỏng vấn (theo thiết kế gốc).
// Chỉ phần hiển thị: giá trị chưa gửi lên backend vì API hiện chưa nhận các trường này.

import { $, formatDuration, h } from "./dom.js";

const numberVi = new Intl.NumberFormat("vi-VN");

const LIMITS = {
  maxPages: 100,
  questionCount: { min: 5, max: 10, default: 5 },
  durationMinutes: { min: 5, max: 15, default: 15 },
};

const els = {
  conceptsField: $("#field-concepts"),
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
  questions: $("#questions"),
  questionsOutput: $("#questions-output"),
  questionsScale: $("#questions-scale"),
  duration: $("#duration"),
  durationOutput: $("#duration-output"),
  presets: [...document.querySelectorAll(".duration-preset")],
  durationSummary: $("#duration-summary"),
};

const state = {
  hasDoc: false,
  pageFrom: "",
  pageTo: "",
  questionCount: LIMITS.questionCount.default,
  durationMinutes: LIMITS.durationMinutes.default,
};

function ratio(value, { min, max }) {
  return String((value - min) / (max - min));
}

function parsePage(value) {
  return /^\d+$/.test(value) ? Number(value) : null;
}

// Ô trống nghĩa là từ đầu (Từ trang) hoặc đến hết tài liệu (Đến trang).
function rangeErrors() {
  const errors = { from: "", to: "" };
  if (!state.hasDoc) return errors;
  const from = state.pageFrom ? parsePage(state.pageFrom) : 1;
  const to = state.pageTo ? parsePage(state.pageTo) : null;
  if (from === null) errors.from = "Nhập số trang.";
  else if (from < 1) errors.from = "Trang đầu tiên là 1.";
  if (!state.pageTo) return errors;

  if (to === null) errors.to = "Nhập số trang.";
  else if (to < 1) errors.to = "Trang đầu tiên là 1.";
  else if (!errors.from && to < from) errors.to = `Phải từ trang ${from} trở đi.`;
  else if (!errors.from && to - from + 1 > LIMITS.maxPages) {
    errors.to = `Tối đa ${LIMITS.maxPages} trang mỗi lần, tức đến trang ${from + LIMITS.maxPages - 1}.`;
  }
  return errors;
}

function setFieldError(field, input, errorNode, message) {
  field.classList.toggle("is-invalid", Boolean(message));
  input.setAttribute("aria-invalid", String(Boolean(message)));
  errorNode.hidden = !message;
  errorNode.textContent = message;
}

function renderRange() {
  for (const [input, value] of [[els.pageFrom, state.pageFrom], [els.pageTo, state.pageTo]]) {
    input.disabled = !state.hasDoc;
    if (input.value !== value) input.value = value;
  }
  const errors = rangeErrors();
  setFieldError(els.pageFromField, els.pageFrom, els.pageFromError, errors.from);
  setFieldError(els.pageToField, els.pageTo, els.pageToError, errors.to);

  const valid = state.hasDoc && !errors.from && !errors.to;
  const whole = !state.pageTo && (!state.pageFrom || Number(state.pageFrom) === 1);
  const from = Number(state.pageFrom) || 1;
  const to = Number(state.pageTo);

  els.rangeChip.hidden = !valid || whole;
  if (valid && !whole && to) els.rangeChip.textContent = `${numberVi.format(to - from + 1)} trang`;
  else if (valid && !whole) els.rangeChip.textContent = `Từ trang ${from}`;

  els.coverageTotal.textContent = state.hasDoc ? (whole ? "Toàn bộ tài liệu" : "Một phần tài liệu") : "Chưa có tài liệu";
  let label = "";
  if (valid && !whole) label = to ? (from === to ? `tr. ${from}` : `tr. ${from}–${to}`) : `tr. ${from} đến hết`;
  els.coverageRange.textContent = label;

  // Chưa biết tổng số trang nên chỉ tô kín thanh khi chọn cả tài liệu.
  els.coverageFill.hidden = !(valid && whole);
  els.coverageFill.style.setProperty("--start", "0%");
  els.coverageFill.style.setProperty("--size", "100%");
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

function render() {
  renderRange();
  renderQuestions();
  renderDuration();
}

// Ô trang mở khi màn Thiết lập đã chọn được tài liệu (phần Các chủ đề hiện ra).
function syncDocument() {
  const hasDoc = !els.conceptsField.hidden;
  if (hasDoc === state.hasDoc) return;
  state.hasDoc = hasDoc;
  state.pageFrom = "";
  state.pageTo = "";
  render();
}

function init() {
  els.pageFrom.placeholder = "1";
  els.pageTo.placeholder = "Hết";
  for (const [input, key] of [[els.pageFrom, "pageFrom"], [els.pageTo, "pageTo"]]) {
    input.addEventListener("input", () => {
      state[key] = input.value.replace(/\D/g, "");
      render();
    });
    // Enter trong ô trang không được gửi form bắt đầu phỏng vấn.
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.preventDefault();
    });
  }

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

  new MutationObserver(syncDocument).observe(els.conceptsField, { attributes: true, attributeFilter: ["hidden"] });
  syncDocument();
  render();
}

init();
