// Màn 05 · Đang chấm điểm và 06 · Kết quả.

import * as api from "./api.js";
import { ICONS, formatDuration, formatRange, h, img, maskIcon, notice, pillButton, truncate } from "./dom.js";
import { isFollowUp } from "./interview.js";

const LEVEL = {
  strong: { label: "Vững", chip: "is-success", headline: "Nắm vững phần này" },
  good: { label: "Khá", chip: "is-success", headline: "Hiểu khá, còn vài chỗ cần chắc hơn" },
  basic: { label: "Cơ bản", chip: "is-warn", headline: "Mới nắm được ý cơ bản" },
  gap: { label: "Cần ôn lại", chip: "chip-danger", headline: "Cần ôn lại trước khi thi" },
  not_assessed: { label: "Chưa đánh giá", chip: "", headline: "Chưa đủ câu trả lời để đánh giá" },
};
const UNSCORED = new Set(["clarification_request", "thinking_aloud", "off_topic", "small_talk"]);
const SVG_NS = "http://www.w3.org/2000/svg";

function tick() {
  return h("span", { class: "tick" }, img(ICONS.checkWhite12, 12));
}

/** Màn 05: gọi backend chấm và lấy dữ liệu cho màn kết quả. */
export function runGrading(root, { summary, setup, doc, onDone, onBack }) {
  let failed = null;

  function render() {
    const steps = [
      h("li", {}, tick(), `Chép lại ${summary.answered} câu trả lời (${formatDuration(summary.usedSeconds)})`),
      h("li", {}, tick(), `Đã chấm từng câu theo ${doc.concepts.length} khái niệm của tài liệu`),
      failed
        ? h("li", { class: "is-pending" }, h("span", { class: "pending-dot" }), "Viết nhận xét và kế hoạch ôn tập")
        : h("li", { class: "is-active" }, img(ICONS.stepActive, 22), "Viết nhận xét và kế hoạch ôn tập"),
    ];
    root.replaceChildren(h("section", { class: "flow-card", "aria-live": "polite" },
      failed ? h("span", { class: "status-badge is-danger" }, maskIcon(ICONS.alert, 26))
        : h("span", { class: "status-badge is-subtle" }, img(ICONS.loader26, 26, "spin")),
      h("div", {},
        h("h1", {}, failed ? "Chưa chấm xong buổi phỏng vấn" : "Đang chấm buổi phỏng vấn"),
        h("p", { class: "card-desc" }, failed
          ? "Câu trả lời của bạn vẫn được lưu. Bấm Thử lại để chấm tiếp."
          : `Giám khảo đang xem lại ${summary.answered} câu trả lời và đối chiếu với ${formatRange({ from: setup.pageFrom, to: setup.pageTo })}. Việc này thường mất 10–20 giây.`)),
      h("div", { class: "progress-track", style: "--value: 80%" }, h("span")),
      h("ul", { class: "checklist" }, steps),
      failed ? h("div", { class: "flow-actions-col" },
        notice("danger", img(ICONS.alert, 18), "Không kết nối được với giám khảo AI", failed),
        h("div", { class: "flow-actions" },
          pillButton("Thử lại", { icon: ICONS.replay, onclick: run }),
          pillButton("Về trang thiết lập", { onclick: onBack }))) : null,
      h("hr", { class: "divider" }),
      h("p", { class: "label-caps" }, "Chấm theo từng khái niệm"),
      h("div", { class: "concept-chips" }, doc.concepts.map((c) => h("span", { class: "concept-chip" }, c.name))),
    ));
  }

  async function run() {
    failed = null;
    render();
    try {
      const report = await api.finishSession(summary.session.id);
      const [insights, sessionInfo] = await Promise.all([
        api.getInsights(summary.session.id).catch(() => null),
        api.getSession(summary.session.id).catch(() => null),
      ]);
      onDone({ report, insights, sessionInfo });
    } catch (error) {
      failed = error.offline ? "Mất kết nối tới máy chủ. Kiểm tra mạng rồi bấm Thử lại." : error.message;
      render();
    }
  }

  run();
}

// -- Màn 06 -----------------------------------------------------------------

function scoreRing(score) {
  const r = 62;
  const length = 2 * Math.PI * r;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "140");
  svg.setAttribute("height", "140");
  svg.setAttribute("viewBox", "0 0 140 140");
  svg.setAttribute("aria-hidden", "true");
  for (const [color, dash] of [["var(--primary-soft)", 0], ["var(--primary)", length * (1 - score / 100)]]) {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", "70");
    circle.setAttribute("cy", "70");
    circle.setAttribute("r", String(r));
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", color);
    circle.setAttribute("stroke-width", "12");
    if (dash) {
      circle.setAttribute("stroke-linecap", "round");
      circle.setAttribute("stroke-dasharray", String(length));
      circle.setAttribute("stroke-dashoffset", String(dash));
    }
    svg.append(circle);
  }
  return h("div", { class: "score-ring", role: "img", "aria-label": `${score} trên 100 điểm` },
    svg, h("div", { class: "value" }, h("strong", {}, score), h("span", {}, "/100")));
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Radar điểm từng khái niệm; previous là điểm lần trước theo concept_id (nếu có). */
function radar(concepts, previous) {
  const width = 444;
  const height = 300;
  const cx = width / 2;
  const cy = height / 2;
  const radius = 100;
  const n = concepts.length;
  const point = (i, value) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + Math.cos(angle) * radius * value, cy + Math.sin(angle) * radius * value];
  };
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, class: "radar", role: "img", "aria-label": "Bản đồ điểm theo khái niệm" });
  for (const level of [0.25, 0.5, 0.75, 1]) {
    svg.append(svgEl("polygon", {
      points: concepts.map((_, i) => point(i, level).join(",")).join(" "),
      fill: "none",
      stroke: "var(--line)",
      "stroke-width": 1,
    }));
  }
  concepts.forEach((_, i) => {
    const [x, y] = point(i, 1);
    svg.append(svgEl("line", { x1: cx, y1: cy, x2: x, y2: y, stroke: "var(--line)", "stroke-width": 1 }));
  });
  if (previous) {
    svg.append(svgEl("polygon", {
      points: concepts.map((c, i) => point(i, (previous[c.concept_id] ?? 0) / 100).join(",")).join(" "),
      fill: "none",
      stroke: "var(--faint)",
      "stroke-width": 1.5,
      "stroke-dasharray": "4 4",
    }));
  }
  svg.append(svgEl("polygon", {
    points: concepts.map((c, i) => point(i, c.score / 100).join(",")).join(" "),
    fill: "rgba(14, 124, 134, 0.14)",
    stroke: "var(--primary)",
    "stroke-width": 2,
  }));
  concepts.forEach((c, i) => {
    const weak = c.score < 50;
    const [px, py] = point(i, c.score / 100);
    svg.append(svgEl("circle", { cx: px, cy: py, r: 4, fill: weak ? "var(--danger)" : "var(--primary)" }));
    const [lx, ly] = point(i, 1.18);
    const anchor = Math.abs(lx - cx) < 8 ? "middle" : lx > cx ? "start" : "end";
    const label = svgEl("text", {
      x: lx,
      y: ly + 4,
      "text-anchor": anchor,
      "font-size": 12,
      "font-weight": 600,
      fill: weak ? "var(--danger)" : "var(--ink)",
      "font-family": "var(--font-sans)",
    });
    label.textContent = `${truncate(c.name, 22)} · ${c.score}`;
    svg.append(label);
  });
  return svg;
}

function verdict(evaluation) {
  if (UNSCORED.has(evaluation.intent)) return { text: "Không chấm", cls: "chip chip-white chip-small", weak: false };
  const ratio = (evaluation.correctness + evaluation.completeness + evaluation.reasoning) / 12;
  if (ratio >= 0.75) return { text: "Tốt", cls: "chip is-success chip-small", weak: false };
  if (ratio >= 0.45) return { text: "Một phần", cls: "chip chip-white chip-small", weak: false };
  return { text: "Chưa đạt", cls: "chip chip-danger-solid chip-small", weak: true };
}

function logItems(insights) {
  if (!insights || !insights.evaluations.length) {
    return [h("p", { class: "muted" }, "Chưa có câu trả lời nào được chấm.")];
  }
  const evaluations = [...insights.evaluations].reverse();
  return evaluations.map((e, i) => {
    const follow = i > 0 && isFollowUp(evaluations[i - 1].action);
    const v = verdict(e);
    return h("article", { class: `log-item${v.weak ? " is-weak" : ""}` },
      h("div", { class: "log-head" },
        h("strong", {}, `Câu ${i + 1}`),
        h("span", { class: "chip chip-white chip-small" }, follow ? "Đào sâu" : "Chủ đề mới"),
        h("span", { class: "chip chip-white chip-small" }, truncate(e.concept_name, 28)),
        h("span", { class: "spacer" }),
        h("span", { class: v.cls }, v.text)),
      h("h3", {}, truncate(e.question, 140)),
      h("p", { class: "summary" }, e.summary),
      v.weak && e.answer ? h("p", { class: "said" }, `Bạn nói: "${truncate(e.answer, 160)}"`) : null);
  });
}

function criticalGap(report) {
  const candidates = report.concepts
    .filter((c) => c.level !== "not_assessed" && (c.misconceptions.length || c.gaps.length))
    .sort((a, b) => a.score - b.score);
  const c = candidates[0];
  if (!c) return null;
  const problem = c.misconceptions[0] || c.gaps[0];
  const pages = c.review_pages.length ? ` · Trang ${c.review_pages.slice(0, 3).join(", ")}` : "";
  return h("section", { class: "gap-box" },
    h("div", { class: "gap-head" }, img(ICONS.alert, 18), h("span", { class: "label-caps" }, "Lỗ hổng chí mạng"), h("span", {}, `· ${c.name}${pages}`)),
    h("p", {}, problem),
    c.evidence[0] || c.advice ? h("div", { class: "quote-box" },
      c.evidence[0] ? h("p", {}, `Bạn nói: "${truncate(c.evidence[0], 200)}"`) : null,
      c.advice ? h("span", {}, img(ICONS.check12, 12), c.advice) : null) : null);
}

/**
 * Màn 06. previous = { score, concepts: { [concept_id]: score } } của lần thi trước với cùng tài liệu.
 */
export function renderResult(root, { report, insights, sessionInfo, setup, doc, summary, previous, attempt, onRetry, onChangeSetup }) {
  const level = LEVEL[report.overall_level] || LEVEL.not_assessed;
  const assessed = report.concepts.filter((c) => c.level !== "not_assessed");
  const misconceptions = assessed.some((c) => c.misconceptions.length);
  const range = formatRange({ from: setup.pageFrom, to: setup.pageTo });
  const diff = previous && report.overall_level !== "not_assessed" ? report.overall_score - previous.score : null;
  const finishedAt = new Date(report.generated_at).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });

  const overview = h("section", { class: "overview" },
    h("div", { class: "overview-row" },
      scoreRing(report.overall_score),
      h("div", { class: "overview-text" },
        h("div", { class: "chip-row" },
          h("span", { class: `chip ${level.chip}` }, level.label),
          misconceptions ? h("span", { class: "chip chip-danger" }, img(ICONS.dotDanger, 6), "Có hiểu lầm cần sửa") : null,
          diff !== null ? h("span", { class: `chip ${diff >= 0 ? "is-success" : "chip-danger"}` },
            `${diff >= 0 ? "+" : ""}${diff} điểm so với lần trước`) : null),
        h("h1", {}, level.headline),
        h("p", {}, report.summary_for_learner),
        h("div", { class: "chip-row" },
          h("span", { class: "chip" }, img(ICONS.list14, 14), `${summary.answered} câu`),
          h("span", { class: "chip" }, img(ICONS.clock14, 14), formatDuration(summary.usedSeconds)),
          h("span", { class: "chip" }, img(ICONS.book, 14), range)))),
    criticalGap(report));

  const tiles = h("div", { class: "axis-tiles" }, assessed.map((c) => {
    const prev = previous?.concepts[c.concept_id];
    const change = prev === undefined ? null : c.score - prev;
    return h("div", { class: `axis-tile${c.score < 50 ? " is-weak" : ""}` },
      h("p", {}, c.name),
      h("strong", {}, c.score),
      change !== null ? h("span", { class: `chip chip-white chip-small`, style: `color: var(${change >= 0 ? "--success" : "--danger"})` },
        `${change >= 0 ? "+" : ""}${change}`) : null);
  }));
  const mapCard = h("section", { class: "result-card" },
    h("div", { class: "card-head" },
      h("h2", {}, "Bản đồ năng lực"),
      h("p", {}, previous ? "So với lần thi trước, cùng phạm vi trang" : "Điểm theo từng khái niệm đã được hỏi")),
    previous ? h("div", { class: "legend" },
      h("span", {}, h("i", { class: "is-dashed" }), `Lần trước · ${previous.score} điểm`),
      h("span", { class: "is-current" }, h("i"), `Lần này · ${report.overall_score} điểm`)) : null,
    assessed.length >= 3 ? radar(assessed, previous?.concepts) : null,
    assessed.length ? tiles : h("p", { class: "muted" }, "Chưa có khái niệm nào đủ dữ liệu để chấm."),
    report.study_plan.length ? h("div", { class: "card-head" }, h("h2", {}, "Kế hoạch ôn tập")) : null,
    report.study_plan.length ? h("ol", { class: "plan" }, report.study_plan.map((step) => h("li", {}, step))) : null);

  const logCard = h("section", { class: "result-card" },
    h("div", { class: "card-head" },
      h("h2", {}, "Nhật ký phỏng vấn"),
      h("p", {}, `${summary.answered} câu · nhận xét của giám khảo cho từng câu`)),
    logItems(insights));

  const transcript = h("section", { class: "transcript-card", hidden: true },
    h("h2", {}, "Toàn bộ bản ghi"),
    (sessionInfo?.turns || []).map((t) => h("div", { class: `turn${t.role === "learner" ? " is-learner" : ""}` },
      h("span", {}, t.role === "learner" ? "Bạn" : "Giám khảo AI"), t.text)));
  const transcriptButton = pillButton("Xem toàn bộ bản ghi", {
    icon: ICONS.list16,
    iconSize: 16,
    className: "btn-pill btn-lg",
    onclick: () => {
      transcript.hidden = !transcript.hidden;
      transcriptButton.querySelector("span").textContent = transcript.hidden ? "Xem toàn bộ bản ghi" : "Ẩn bản ghi";
      if (!transcript.hidden) transcript.scrollIntoView({ behavior: "smooth", block: "start" });
    },
  });

  root.replaceChildren(
    h("div", { class: "result-top" },
      h("span", { class: "chip is-success" }, img(ICONS.check, 14), `Đã hoàn thành · ${doc.title} (${range})`),
      h("span", {}, attempt > 1 ? `Lần thi thứ ${attempt} · xong lúc ${finishedAt}` : `Xong lúc ${finishedAt}`)),
    overview,
    h("div", { class: "result-columns" }, mapCard, logCard),
    h("div", { class: "action-bar" },
      h("button", { type: "button", class: "btn-primary btn-big", onclick: onRetry }, img(ICONS.target, 18), h("span", {}, "Thi lại")),
      pillButton("Đổi tài liệu hoặc phạm vi", { icon: ICONS.sliders, iconSize: 18, className: "btn-pill btn-outline-big", onclick: onChangeSetup }),
      h("span", { class: "spacer" }),
      transcriptButton),
    transcript,
  );
}

