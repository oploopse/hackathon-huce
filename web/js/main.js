// Nối các màn: 01 Thiết lập → 03 Chuẩn bị → 04 Phỏng vấn → 05 Đang chấm → 06 Kết quả.

import { $, ICONS, formatRange, h, img, reducedMotion } from "./dom.js";
import { Interview } from "./interview.js";
import { runPrepare } from "./prepare.js";
import { renderResult, runGrading } from "./result.js";
import { initSetup } from "./setup.js";

const VIEWS = ["setup", "prepare", "interview", "grading", "result"];
const STEP_OF = { setup: 0, prepare: 1, interview: 1, grading: 2, result: 2 };
const TITLES = {
  setup: "Thiết lập",
  prepare: "Chuẩn bị phỏng vấn",
  interview: "Phỏng vấn",
  grading: "Đang chấm điểm",
  result: "Kết quả",
};

const flow = {
  setup: null,
  document: null,
  prepare: null,
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

function show(view) {
  for (const name of VIEWS) $(`#view-${name}`).hidden = name !== view;
  $("#progress-strip").hidden = view !== "interview";
  $("#app-footer").hidden = view !== "setup" && view !== "result";
  const chip = $("#header-chip");
  chip.hidden = view === "setup" || !flow.setup;
  if (!chip.hidden) {
    const title = flow.document ? flow.document.title : flow.setup.filename;
    chip.replaceChildren(img(ICONS.book, 14), h("span", {}, `${title} · ${formatRange({ from: flow.setup.pageFrom, to: flow.setup.pageTo })}`));
    chip.title = title;
  }
  renderStepper(view);
  document.title = `${TITLES[view]} · Socratic Exam`;
  window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "instant" });
}

function startPrepare() {
  show("prepare");
  if (flow.prepare) flow.prepare.stop();
  flow.prepare = runPrepare($("#view-prepare"), {
    setup: flow.setup,
    knownDocument: flow.document,
    onDocument: (doc) => {
      flow.document = doc;
      show("prepare");
    },
    onReady: ({ session, message }) => {
      show("interview");
      interview.start({ setup: flow.setup, document: flow.document, session, message });
    },
    onBack: () => show("setup"),
  });
}

function startGrading(summary) {
  show("grading");
  runGrading($("#view-grading"), {
    summary,
    setup: flow.setup,
    doc: flow.document,
    onBack: () => show("setup"),
    onDone: ({ report, insights, sessionInfo }) => {
      const attempts = flow.history.get(flow.document.id) || [];
      renderResult($("#view-result"), {
        report,
        insights,
        sessionInfo,
        summary,
        setup: flow.setup,
        doc: flow.document,
        previous: attempts.at(-1) || null,
        attempt: attempts.length + 1,
        onRetry: startPrepare,
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

initSetup({
  onStartInterview: (setup) => {
    const same = flow.setup
      && flow.setup.filename === setup.filename
      && flow.setup.pageFrom === setup.pageFrom
      && flow.setup.pageTo === setup.pageTo
      && flow.setup.pageCount === setup.pageCount
      && flow.setup.words === setup.words;
    // Cùng file và cùng phạm vi trang thì dùng lại bản đồ kiến thức đã soạn.
    if (!same) flow.document = null;
    flow.setup = setup;
    startPrepare();
  },
});
show("setup");

window.addEventListener("beforeunload", (event) => {
  if (interview.active) event.preventDefault();
});
