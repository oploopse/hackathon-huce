// Nối các màn theo luồng của giao diện cũ: 01 Thiết lập → 02 Phỏng vấn → Đang chấm → 03 Kết quả.

import * as api from "./api.js";
import { $, ICONS, h, img, reducedMotion, toast } from "./dom.js";
import { Interview } from "./interview.js";
import { renderResult, runGrading } from "./result.js";
import { initSetup, setHealth } from "./setup.js";

const VIEWS = ["setup", "interview", "grading", "result"];
const STEP_OF = { setup: 0, interview: 1, grading: 2, result: 2 };
const TITLES = {
  setup: "Thiết lập",
  interview: "Phỏng vấn",
  grading: "Đang chấm điểm",
  result: "Kết quả",
};

const flow = {
  health: null,
  document: null,
  options: null,
  // Điểm các lần thi trước theo tài liệu, để so sánh ở màn kết quả.
  history: new Map(),
};

const interview = new Interview({
  root: $("#view-interview"),
  strip: $("#progress-strip"),
  dialog: $("#confirm-end"),
  onFinish: startGrading,
});

function renderStepper(view) {
  const current = STEP_OF[view];
  [...$("#stepper").children].forEach((step, i) => {
    const num = step.querySelector(".step-num");
    step.classList.toggle("is-current", i === current);
    step.classList.toggle("is-done", i < current);
    if (i === current) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
    num.replaceChildren(i < current ? img(ICONS.checkWhite12, 12) : String(i + 1));
  });
}

function renderHeaderChip(view) {
  const chip = $("#header-chip");
  if (view !== "setup" && flow.document) {
    chip.hidden = false;
    chip.className = "chip header-chip";
    chip.replaceChildren(img(ICONS.book, 14), h("span", {}, flow.document.title));
    chip.title = flow.document.title;
    return;
  }
  const health = flow.health;
  chip.hidden = !health;
  if (!health) return;
  if (health.llm_configured) {
    chip.className = "chip header-chip is-success";
    chip.replaceChildren(img(ICONS.dot, 6), h("span", {}, `Gemini · ${health.models.live}`));
    chip.title = `Não: ${health.models.brain} · Nhắn tin: ${health.models.fast} · Giọng nói: ${health.models.live}`;
  } else {
    chip.className = "chip header-chip is-warn";
    chip.replaceChildren(h("span", {}, "Chưa có GEMINI_API_KEY"));
    chip.title = "Tạo file .env từ .env.example, điền key rồi khởi động lại server";
  }
}

function show(view) {
  for (const name of VIEWS) $(`#view-${name}`).hidden = name !== view;
  $("#progress-strip").hidden = view !== "interview";
  $("#app-footer").hidden = view !== "setup" && view !== "result";
  renderHeaderChip(view);
  renderStepper(view);
  document.title = `${TITLES[view]} · Socratic Exam`;
  window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "instant" });
}

/** Phải được gọi trong thao tác bấm nút để trình duyệt cho phát âm thanh của giọng nói. */
async function startInterview(options) {
  const { doc, learnerName, mode, bargeIn } = options;
  const voice = mode === "voice" ? interview.createVoice() : null;
  try {
    const result = await api.startSession({ documentId: doc.id, learnerName, mode });
    flow.document = doc;
    flow.options = options;
    show("interview");
    await interview.start({ session: result.session, message: result.message, voice, bargeIn });
  } catch (error) {
    if (voice) voice.stop();
    interview.dispose();
    const denied = error && error.name === "NotAllowedError";
    toast(denied ? "Trình duyệt chưa cho phép dùng micro. Hãy cấp quyền rồi thử lại." : error.message);
    show("setup");
  }
}

function startGrading(summary) {
  show("grading");
  runGrading($("#view-grading"), {
    summary,
    doc: flow.document,
    onBack: () => show("setup"),
    onDone: ({ report, insights, sessionInfo }) => {
      const attempts = flow.history.get(flow.document.id) || [];
      renderResult($("#view-result"), {
        report,
        insights,
        sessionInfo,
        summary,
        doc: flow.document,
        previous: attempts.at(-1) || null,
        attempt: attempts.length + 1,
        onRetry: () => startInterview(flow.options),
        onChangeSetup: () => show("setup"),
      });
      attempts.push({
        score: report.overall_score,
        concepts: Object.fromEntries(report.concepts.map((c) => [c.concept_id, c.score])),
      });
      flow.history.set(flow.document.id, attempts);
      show("result");
    },
  });
}

async function loadHealth() {
  try {
    flow.health = await api.health();
  } catch {
    flow.health = null;
    toast("Không kết nối được máy chủ.");
    return;
  }
  setHealth(flow.health);
  if (!$("#view-setup").hidden) renderHeaderChip("setup");
}

initSetup({ onStartInterview: startInterview });
show("setup");
loadHealth();

window.addEventListener("beforeunload", (event) => {
  if (interview.active) event.preventDefault();
});
window.addEventListener("pagehide", () => {
  if (interview.active) interview.dispose();
});
