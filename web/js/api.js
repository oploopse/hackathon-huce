// Adapter tới backend Python sẵn có (app/main.py).
// Khi backend làm xong POST /api/interviews theo web/API_CONTRACT.md, chỉ cần đổi file này.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }

  get offline() {
    return this.status === 0;
  }
}

function errorMessage(status, data) {
  const detail = data && data.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail) && detail.length) return detail.map((d) => d.msg).join("; ");
  return `Máy chủ báo lỗi (HTTP ${status}).`;
}

let pendingLogin = null;

// Backend bật APP_ACCESS_TOKEN thì mọi API trả 401 cho tới khi đăng nhập; cookie HttpOnly do /api/auth/login đặt
// được gửi kèm cả các request sau và WebSocket. Nhiều request cùng gặp 401 chỉ hỏi token một lần.
function login() {
  if (!pendingLogin) {
    pendingLogin = (async () => {
      const token = window.prompt("Nhập APP_ACCESS_TOKEN để đăng nhập:");
      if (!token) return false;
      try {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ token: token.trim() }),
        });
        return response.ok;
      } catch {
        return false;
      }
    })().finally(() => {
      pendingLogin = null;
    });
  }
  return pendingLogin;
}

async function request(path, options = {}, retryAuth = true) {
  const { method = "GET", json, form, timeoutMs = 120_000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(path, {
        method,
        headers: json ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
        body: json ? JSON.stringify(json) : form,
        signal: controller.signal,
      });
    } catch (error) {
      throw new ApiError(
        error.name === "AbortError" ? "Giám khảo AI phản hồi quá lâu." : "Không kết nối được máy chủ.",
        error.name === "AbortError" ? 408 : 0,
      );
    }
    if (response.status === 401 && retryAuth) {
      clearTimeout(timer);
      if (await login()) return request(path, options, false);
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) throw new ApiError(errorMessage(response.status, data), response.status);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gửi chữ đã trích trên trình duyệt để backend soạn bản đồ kiến thức.
 * Backend hiện chỉ nhận file, nên chữ được gói thành một file Markdown, mỗi trang mở đầu bằng "## Trang n".
 * Trả về { id, title, summary, truncated, concepts: [{ id, name, summary, importance }] }.
 */
export function createDocument({ filename, pageFrom, pageTo, pageTexts }) {
  const sections = [];
  for (let page = pageFrom; page <= pageTo; page += 1) {
    const text = (pageTexts.get(page) || "").trim();
    if (text) sections.push(`## Trang ${page}\n\n${text}`);
  }
  const base = filename.replace(/\.pdf$/i, "");
  const name = pageFrom === pageTo ? `${base}_tr${pageFrom}.md` : `${base}_tr${pageFrom}-${pageTo}.md`;
  const form = new FormData();
  form.append("file", new File([sections.join("\n\n")], name, { type: "text/markdown" }));
  return request("/api/documents", { method: "POST", form, timeoutMs: 180_000 });
}

/** Mở phiên phỏng vấn dạng chữ; giọng nói do trình duyệt lo. Trả về { session, message }. */
export function startSession(documentId) {
  return request("/api/sessions", { method: "POST", json: { document_id: documentId, learner_name: "bạn", mode: "text" } });
}

/** Trả về { message, finished }. */
export function sendAnswer(sessionId, text) {
  return request(`/api/sessions/${sessionId}/messages`, { method: "POST", json: { text: text.slice(0, 4000) } });
}

/** Điểm từng lượt và quyết định của giám khảo (hỏi sâu hay chuyển chủ đề). */
export function getInsights(sessionId) {
  return request(`/api/sessions/${sessionId}/insights`, { timeoutMs: 15_000 });
}

/** Kết thúc phiên và lấy báo cáo. */
export function finishSession(sessionId) {
  return request(`/api/sessions/${sessionId}/finish`, { method: "POST", timeoutMs: 180_000 });
}

/** Thông tin phiên, gồm toàn bộ lượt hỏi đáp. */
export function getSession(sessionId) {
  return request(`/api/sessions/${sessionId}`, { timeoutMs: 15_000 });
}
