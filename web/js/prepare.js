// Màn 03 · Chuẩn bị phỏng vấn: gửi chữ cho giám khảo, chờ soạn câu hỏi rồi đếm ngược 3 giây.

import * as api from "./api.js";
import { ICONS, formatRange, h, img, maskIcon, notice, numberVi, pillButton, roundWords } from "./dom.js";

const COUNTDOWN_S = 3;
const RING = 2 * Math.PI * 25;

function tick() {
  return h("span", { class: "tick" }, img(ICONS.checkWhite12, 12));
}

function stepItem(status, text) {
  if (status === "done") return h("li", {}, tick(), text);
  if (status === "active") return h("li", { class: "is-active" }, img(ICONS.stepActive, 22), text);
  return h("li", { class: "is-pending" }, h("span", { class: "pending-dot" }), text);
}

/**
 * Chạy màn chuẩn bị. Nếu đã có document (thi lại) thì bỏ qua bước gửi tài liệu.
 * onReady({ document, session, message }) khi đếm ngược xong; onBack() để quay lại thiết lập.
 */
export function runPrepare(root, { setup, knownDocument = null, onDocument, onReady, onBack }) {
  const state = { document: knownDocument, session: null, message: "", error: null, countdown: null };
  let timer = 0;
  let cancelled = false;
  const range = { from: setup.pageFrom, to: setup.pageTo };
  const pages = setup.pageTo - setup.pageFrom + 1;

  function render() {
    const ready = Boolean(state.session);
    const failed = Boolean(state.error);
    const doneSteps = 1 + (state.document ? 1 : 0) + (ready ? 1 : 0);
    const steps = [
      stepItem("done", `Trích chữ từ ${numberVi.format(pages)} trang (khoảng ${numberVi.format(roundWords(setup.words))} từ)`),
      state.document
        ? stepItem("done", `Tìm được ${state.document.concepts.length} khái niệm chính`)
        : stepItem(failed ? "pending" : "active", "Đang tìm các khái niệm chính…"),
      ready
        ? stepItem("done", "Đã chọn câu hỏi đầu tiên")
        : stepItem(state.document && !failed ? "active" : "pending", "Chọn câu hỏi đầu tiên"),
    ];

    let badge;
    if (failed) badge = h("span", { class: "status-badge is-danger" }, maskIcon(ICONS.alert, 26));
    else if (ready) badge = h("span", { class: "status-badge" }, img(ICONS.checkPrimary26, 26));
    else badge = h("span", { class: "status-badge" }, img(ICONS.loader26, 26, "spin"));

    let title = "Giám khảo đang đọc tài liệu";
    let desc = `Giám khảo đang đọc ${formatRange(range)} để soạn câu hỏi. Việc này thường mất 20–40 giây.`;
    if (failed) {
      title = "Giám khảo chưa chuẩn bị được";
      desc = "Câu hỏi chưa được soạn xong. Bạn có thể thử lại, hoặc quay lại thiết lập để đổi tài liệu.";
    } else if (ready) {
      title = "Giám khảo đã sẵn sàng";
      desc = `Giám khảo đã đọc xong ${formatRange(range)} và chọn được câu hỏi đầu tiên. Tài liệu đã được ẩn.`;
    } else if (state.document) {
      title = "Giám khảo đang chọn câu hỏi đầu tiên";
      desc = `Giám khảo đã đọc ${formatRange(range)} và đang chọn câu hỏi mở đầu.`;
    }

    const concepts = state.document ? state.document.concepts : [];
    root.replaceChildren(h("section", { class: "flow-card", "aria-live": "polite" },
      badge,
      h("div", {}, h("h1", {}, title), h("p", { class: "card-desc" }, desc)),
      h("div", { class: "progress-track", style: `--value: ${(doneSteps / 3) * 100}%` }, h("span")),
      h("ul", { class: "checklist" }, steps),
      failed ? h("div", { class: "flow-actions-col" },
        notice("danger", img(ICONS.alert, 18), "Không kết nối được với giám khảo AI", state.error),
        h("div", { class: "flow-actions" },
          pillButton("Thử lại", { icon: ICONS.replay, onclick: retry }),
          pillButton("Quay lại thiết lập", { onclick: () => { stop(); onBack(); } }))) : null,
      ready ? countdownBox() : null,
      concepts.length ? h("hr", { class: "divider" }) : null,
      concepts.length ? h("p", { class: "label-caps" }, "Khái niệm chính trong tài liệu") : null,
      concepts.length ? h("div", { class: "concept-chips" }, concepts.map((c) => h("span", { class: "concept-chip" }, c.name))) : null,
      h("p", { class: "hint-row" }, img(ICONS.headphones16, 16), "Đeo tai nghe và chuẩn bị micro. Câu hỏi đầu tiên sẽ được đọc thành tiếng."),
    ));
  }

  function countdownBox() {
    const left = state.countdown ?? COUNTDOWN_S;
    const offset = RING * (1 - left / COUNTDOWN_S);
    return h("div", { class: "countdown" },
      h("div", { class: "countdown-ring", "aria-hidden": "true" },
        svgRing(offset),
        h("span", {}, left)),
      h("div", { class: "countdown-text" },
        h("strong", { role: "timer" }, `Phỏng vấn bắt đầu sau ${left} giây`),
        h("span", {}, `${setup.questionCount} câu · ${setup.durationMinutes} phút cho cả buổi. Đồng hồ tạm dừng khi giám khảo suy nghĩ.`)),
      pillButton("Bắt đầu ngay", { icon: ICONS.play, onclick: begin }));
  }

  function svgRing(offset) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "56");
    svg.setAttribute("height", "56");
    svg.setAttribute("viewBox", "0 0 56 56");
    const track = document.createElementNS(ns, "circle");
    const bar = document.createElementNS(ns, "circle");
    for (const [el, color] of [[track, "#ffffff"], [bar, "var(--primary)"]]) {
      el.setAttribute("cx", "28");
      el.setAttribute("cy", "28");
      el.setAttribute("r", "25");
      el.setAttribute("fill", "none");
      el.setAttribute("stroke-width", "4");
      el.setAttribute("stroke", color);
    }
    bar.setAttribute("stroke-linecap", "round");
    bar.setAttribute("stroke-dasharray", String(RING));
    bar.setAttribute("stroke-dashoffset", String(offset));
    svg.append(track, bar);
    return svg;
  }

  function stop() {
    cancelled = true;
    clearInterval(timer);
  }

  function begin() {
    if (cancelled) return;
    stop();
    onReady({ document: state.document, session: state.session, message: state.message });
  }

  function startCountdown() {
    state.countdown = COUNTDOWN_S;
    render();
    timer = setInterval(() => {
      state.countdown -= 1;
      if (state.countdown <= 0) begin();
      else render();
    }, 1000);
  }

  async function run() {
    state.error = null;
    render();
    try {
      if (!state.document) {
        state.document = await api.createDocument(setup);
        if (cancelled) return;
        onDocument(state.document);
        render();
      }
      const result = await api.startSession(state.document.id);
      if (cancelled) return;
      state.session = result.session;
      state.message = result.message || "";
      startCountdown();
    } catch (error) {
      if (cancelled) return;
      state.error = error.offline
        ? "Mất kết nối tới máy chủ. Kiểm tra mạng rồi bấm Thử lại."
        : `${error.message} Bấm Thử lại sau ít giây.`;
      render();
    }
  }

  function retry() {
    run();
  }

  run();
  return { stop };
}

