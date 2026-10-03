// Giới hạn các trường của màn Thiết lập. Backend phải dùng cùng con số (xem web/API_CONTRACT.md).
// Hiện frontend gọi API sẵn có qua web/js/api.js; API_CONTRACT.md là API đích khi backend sẵn sàng.

export const LIMITS = Object.freeze({
  fileMaxBytes: 50 * 1024 * 1024,
  maxPages: 100,
  maxTotalChars: 500_000,
  questionCount: Object.freeze({ min: 5, max: 10, default: 5 }),
  durationMinutes: Object.freeze({ min: 5, max: 15, default: 15 }),
});
