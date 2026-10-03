// Tiện ích DOM và định dạng dùng chung cho các màn.

export const $ = (selector, root = document) => root.querySelector(selector);

export const ICONS = {
  alert: "/assets/icons/alert.svg",
  book: "/assets/icons/book.svg",
  check: "/assets/icons/check-success.svg",
  check12: "/assets/icons/check-12-success.svg",
  checkWhite12: "/assets/icons/check-12-white.svg",
  checkWhite16: "/assets/icons/check-16-white.svg",
  checkPrimary26: "/assets/icons/check-26.svg",
  chevDown: "/assets/icons/chev-down.svg",
  clock14: "/assets/icons/clock-14.svg",
  clock16: "/assets/icons/clock-16.svg",
  dot: "/assets/icons/dot-live.svg",
  dotDanger: "/assets/icons/dot-danger.svg",
  file: "/assets/icons/file.svg",
  filePrimary: "/assets/icons/file-primary.svg",
  headphones14: "/assets/icons/headphones-14.svg",
  headphones16: "/assets/icons/headphones-16.svg",
  list14: "/assets/icons/list-14.svg",
  list16: "/assets/icons/list-16.svg",
  loader14: "/assets/icons/loader-14.svg",
  loader26: "/assets/icons/loader-26.svg",
  lock: "/assets/icons/lock.svg",
  mic: "/assets/icons/mic.svg",
  micOff14: "/assets/icons/mic-off-14.svg",
  micOff20: "/assets/icons/mic-off-20.svg",
  micOff28: "/assets/icons/mic-off-28.svg",
  micOn64: "/assets/icons/mic-on-64.svg",
  mute: "/assets/icons/mute.svg",
  pause: "/assets/icons/pause.svg",
  play: "/assets/icons/play.svg",
  replay: "/assets/icons/replay.svg",
  skip: "/assets/icons/skip.svg",
  sliders: "/assets/icons/sliders.svg",
  stepActive: "/assets/icons/step-active-22.svg",
  target: "/assets/icons/target.svg",
  wifiOff: "/assets/icons/wifi-off.svg",
  x: "/assets/icons/x.svg",
};

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function img(src, size, className = null) {
  return h("img", { src, width: size, height: size, alt: "", class: className });
}

/** Icon tô theo màu chữ: dùng file SVG của Figma làm mask. */
export function maskIcon(src, size, className = "") {
  return h("span", { class: `icon ${className}`.trim(), style: `--icon: url('${src}'); --size: ${size}px` });
}

/** Chỉ thay nội dung khi khác lần trước, để vùng aria-live không đọc lại cùng một câu. */
export function setContent(element, key, build) {
  if (element.dataset.key === key) return;
  element.dataset.key = key;
  element.replaceChildren(...build().filter((child) => child !== null && child !== undefined && child !== false));
}

export function notice(kind, iconNode, title, body) {
  return h("div", { class: `notice is-${kind}`, role: kind === "success" ? "status" : "alert" },
    iconNode,
    h("div", { class: "notice-text" }, h("p", { class: "notice-title" }, title), body ? h("p", { class: "notice-body" }, body) : null));
}

export function pillButton(label, { icon = null, iconSize = 14, onclick, className = "btn-pill", disabled = false } = {}) {
  return h("button", { type: "button", class: className, onclick, disabled }, icon ? img(icon, iconSize) : null, h("span", {}, label));
}

/** 75 → "1:15"; với pad = true → "01:15". */
export function formatClock(totalSeconds, pad = false) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return `${pad ? String(minutes).padStart(2, "0") : minutes}:${rest}`;
}

/** 298 → "4 phút 58 giây". */
export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes && rest) return `${minutes} phút ${rest} giây`;
  return minutes ? `${minutes} phút` : `${rest} giây`;
}

export function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

let toastTimer = 0;

/** Thông báo ngắn ở cuối màn hình; kind = "error" hoặc "warn". */
export function toast(message, kind = "error") {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast${kind === "warn" ? " is-warn" : ""}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 6000);
}

export function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
