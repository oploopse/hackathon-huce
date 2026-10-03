// Đọc PDF ngay trên trình duyệt bằng pdf.js: backend chỉ nhận chữ của các trang đã chọn, không nhận file.

const PDFJS_BASE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289";

const VIETNAMESE_LETTERS = /[ăắằẳẵặđơớờởỡợưứừửữựạảấầẩẫậẹẻẽếềểễệỉịọỏốồổỗộụủỳỵỷỹ]/giu;

export class PdfError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PdfError";
    this.code = code;
  }
}

let pdfjsPromise = null;

// Chỉ tải pdf.js (khoảng 450 KB) khi người dùng chọn file đầu tiên.
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(`${PDFJS_BASE}/build/pdf.min.mjs`).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.min.mjs`;
      return pdfjs;
    });
    pdfjsPromise.catch(() => {
      pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}

/** Mở file PDF, trả về PDFDocumentProxy của pdf.js. */
export async function openPdf(file) {
  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch {
    throw new PdfError("library", "Không tải được bộ đọc PDF.");
  }
  const data = new Uint8Array(await file.arrayBuffer());
  try {
    return await pdfjs.getDocument({
      data,
      cMapUrl: `${PDFJS_BASE}/cmaps/`,
      standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
      wasmUrl: `${PDFJS_BASE}/wasm/`,
      isEvalSupported: false,
      enableXfa: false,
    }).promise;
  } catch (error) {
    if (error && error.name === "PasswordException") throw new PdfError("password", "File PDF đang đặt mật khẩu.");
    throw new PdfError("invalid", "Không mở được file này.");
  }
}

/** Giải phóng file đã mở (pdf.js 6 không còn PDFDocumentProxy.destroy). */
export function closePdf(pdf) {
  pdf.loadingTask.destroy();
}

/** Chuẩn hóa giống backend (app/ingest.py) nhưng giữ xuống dòng giữa các dòng chữ. */
export function normalizeText(raw) {
  return raw
    .normalize("NFC")
    .replace(/­/g, "")
    .replace(/-\n(?=[\p{L}\p{N}])/gu, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Chữ của một trang (đếm từ 1). Trang chỉ có ảnh trả về "". */
export async function extractPageText(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  try {
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      text += item.str;
      if (item.hasEOL) text += "\n";
    }
    return normalizeText(text);
  } finally {
    page.cleanup();
  }
}

export function countWords(text) {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu);
  return words ? words.length : 0;
}

export function hasLetters(text) {
  return /\p{L}/u.test(text);
}

/** Có đủ chữ cái riêng của tiếng Việt (ă, ơ, ư, đ, dấu nặng…) để coi là văn bản tiếng Việt. */
export function looksVietnamese(text) {
  const matches = text.match(VIETNAMESE_LETTERS);
  return Boolean(matches && matches.length >= 3);
}
