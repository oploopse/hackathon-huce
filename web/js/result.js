// Màn 05 · Đang chấm điểm và 06 · Kết quả.

import * as api from "./api.js";
import { ICONS, formatDuration, h, img, maskIcon, notice, pillButton, truncate } from "./dom.js";

const LEVEL = {
  strong: { label: "Vững", chip: "is-success", headline: "Nắm vững phần này" },
  good: { label: "Khá", chip: "is-success", headline: "Hiểu khá, còn vài chỗ cần chắc hơn" },
  basic: { label: "Cơ bản", chip: "is-warn", headline: "Mới nắm được ý cơ bản" },
  gap: { label: "Cần ôn lại", chip: "chip-danger", headline: "Cần ôn lại trước khi thi" },
  not_assessed: { label: "Chưa đánh giá", chip: "", headline: "Chưa đủ câu trả lời để đánh giá" },
};
const SVG_NS = "http://www.w3.org/2000/svg";

function tick() {
  return h("span", { class: "tick" }, img(ICONS.checkWhite12, 12));
}

/** Màn 05: gọi backend chấm và lấy dữ liệu cho màn kết quả. */
export function runGrading(root, { summary, doc, onDone, onBack }) {
  let failed = null;

  function render() {
    const steps = [
      h("li", {}, tick(), `Ghi lại ${summary.answered} lượt trả lời (${formatDuration(summary.usedSeconds)})`),
      h("li", {}, tick(), `Đã chấm từng lượt theo ${doc.concepts.length} chủ đề của tài liệu`),
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
          : `Giám khảo đang xem lại ${summary.answered} lượt trả lời và đối chiếu với "${doc.title}". Việc này thường mất 10–20 giây.`)),
      h("div", { class: "progress-track", style: "--value: 80%" }, h("span")),
      h("ul", { class: "checklist" }, steps),
      failed ? h("div", { class: "flow-actions-col" },
        notice("danger", img(ICONS.alert, 18), "Không kết nối được với giám khảo AI", failed),
        h("div", { class: "flow-actions" },
          pillButton("Thử lại", { icon: ICONS.replay, onclick: run }),
          pillButton("Về trang thiết lập", { onclick: onBack }))) : null,
      h("hr", { class: "divider" }),
      h("p", { class: "label-caps" }, "Chấm theo từng chủ đề"),
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

function levelChip(level) {
  const info = LEVEL[level] || LEVEL.not_assessed;
  return h("span", { class: `chip chip-small ${info.chip || "chip-white"}` }, info.label);
}

function bulletList(items) {
  return h("ul", { class: "bullets" }, items.map((item) => h("li", {}, item)));
}

/** Nhận xét từng chủ đề cho người học: điểm mạnh, chỗ cần cải thiện, lời khuyên, trang cần xem lại. */
function feedbackCard(report) {
  if (!report.concepts.length) return null;
  return h("section", { class: "result-card" },
    h("div", { class: "card-head" }, h("h2", {}, "Nhận xét theo chủ đề"), h("p", {}, "Điểm mạnh và chỗ cần ôn của từng chủ đề")),
    h("div", { class: "feedback-grid" }, report.concepts.map((c) =>
      h("article", { class: "feedback-item" },
        h("div", { class: "log-head" }, h("strong", {}, c.name), h("span", { class: "spacer" }), levelChip(c.level)),
        c.level !== "not_assessed" ? h("div", { class: "thin-track progress-bar", style: `--value: ${c.score}%` }, h("span")) : null,
        c.strengths.length ? h("div", {}, h("p", { class: "label-caps" }, "Điểm mạnh"), bulletList(c.strengths)) : null,
        c.gaps.length ? h("div", {}, h("p", { class: "label-caps" }, "Cần cải thiện"), bulletList(c.gaps)) : null,
        c.advice ? h("p", {}, c.advice) : null,
        c.review_pages.length ? h("p", { class: "pages" }, img(ICONS.book, 14), `Xem lại trang ${c.review_pages.join(", ")}`) : null))));
}

/**
 * Màn 06. previous = { score, concepts: { [concept_id]: score } } của lần thi trước với cùng tài liệu.
 */
export function renderResult(root, { report, insights, sessionInfo, doc, summary, previous, attempt, onRetry, onChangeSetup }) {
  const level = LEVEL[report.overall_level] || LEVEL.not_assessed;
  const assessed = report.concepts.filter((c) => c.level !== "not_assessed");
  const misconceptions = assessed.some((c) => c.misconceptions.length);
  const learnerName = sessionInfo?.learner_name || summary.session.learner_name;
  const modeLabel = summary.dictate ? "Phỏng vấn nói rồi sửa"
    : summary.session.mode === "voice" ? "Phỏng vấn giọng nói" : "Phỏng vấn nhắn tin";
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
          h("span", { class: "chip" }, img(ICONS.list14, 14), `${summary.answered} lượt trả lời`),
          h("span", { class: "chip" }, img(ICONS.clock14, 14), formatDuration(summary.usedSeconds)),
          h("span", { class: "chip" }, img(ICONS.headphones14, 14), `${learnerName} · ${modeLabel}`)))),
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
      h("p", {}, previous ? "So với lần thi trước với cùng tài liệu" : "Điểm theo từng chủ đề đã được hỏi")),
    previous ? h("div", { class: "legend" },
      h("span", {}, h("i", { class: "is-dashed" }), `Lần trước · ${previous.score} điểm`),
      h("span", { class: "is-current" }, h("i"), `Lần này · ${report.overall_score} điểm`)) : null,
    assessed.length >= 3 ? radar(assessed, previous?.concepts) : null,
    assessed.length ? tiles : h("p", { class: "muted" }, "Chưa có chủ đề nào đủ dữ liệu để chấm."),
    report.study_plan.length ? h("div", { class: "card-head" }, h("h2", {}, "Kế hoạch ôn tập")) : null,
    report.study_plan.length ? h("ol", { class: "plan" }, report.study_plan.map((step) => h("li", {}, step))) : null);

  const learnerPanel = h("div", { class: "tab-panel" }, mapCard, feedbackCard(report));

  root.replaceChildren(
    h("div", { class: "result-top" },
      h("span", { class: "chip is-success" }, img(ICONS.check, 14), `Đã hoàn thành · ${doc.title} (${doc.filename})`),
      h("span", {}, attempt > 1 ? `Lần thi thứ ${attempt} · xong lúc ${finishedAt}` : `Xong lúc ${finishedAt}`)),
    overview,
    learnerPanel,
    h("div", { class: "action-bar" },
      h("button", { type: "button", class: "btn-primary btn-big", onclick: onRetry }, img(ICONS.target, 18), h("span", {}, "Thi lại")),
      pillButton("Đổi tài liệu hoặc phạm vi", { icon: ICONS.sliders, iconSize: 18, className: "btn-pill btn-outline-big", onclick: onChangeSetup })),
  );
}

