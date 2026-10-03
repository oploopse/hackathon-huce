# Contract API giữa frontend và backend

Frontend (`web/js/`) gọi backend (`app/main.py`, `app/voice.py`) theo các endpoint dưới đây. Mục nào đổi thì sửa cả hai phía và file này.

## Màn Thiết lập

- `GET /api/health` trả `{ ok, llm_configured, models, interview_minutes, session_options: true }`.
- `GET /api/documents` trả danh sách tài liệu, mỗi tài liệu có thêm `page_count` (số trang lớn nhất có trong tài liệu, `null` với TXT/MD/DOCX không có số trang). Ô Phạm vi trang dùng giá trị này để báo "File chỉ có N trang" và tô thanh phạm vi.
- `POST /api/sessions`:

  ```json
  {
    "document_id": "…",
    "learner_name": "Lan",
    "mode": "voice",
    "page_from": 2,
    "page_to": 5,
    "question_count": 5,
    "duration_minutes": 15
  }
  ```

  - `mode`: `voice` (Gemini Live) hoặc `text` (nhắn tin). Hình thức "Nói rồi sửa" đã bỏ.
  - `page_from`, `page_to`: bỏ trống là cả tài liệu; tối đa 100 trang liên tiếp. Chỉ hỏi các chủ đề có nội dung trong phạm vi này; không có chủ đề nào thì trả `422`.
  - `question_count`: 5–10, tính cả câu hỏi đào sâu. Đủ số câu trả lời thì giám khảo kết thúc buổi.
  - `duration_minutes`: 5–15. Hết giờ thì giám khảo kết thúc ở lượt kế tiếp.
  - Trả `{ session, message }`; `session.time_limit_seconds` đã tính theo `duration_minutes`, `message` là câu mở đầu ở chế độ nhắn tin (`null` ở chế độ giọng nói).

## Màn Phỏng vấn

- Nhắn tin: `POST /api/sessions/{id}/messages` với `{ "text": "…" }`, trả `{ message, finished }`. Máy chủ chấm rồi soạn câu tiếp theo; mỗi lần gọi Gemini quá `LLM_TIMEOUT_S` giây thì tự chuyển sang model dự phòng.
- Giọng nói: WebSocket `/api/sessions/{id}/voice`.
  - Trình duyệt gửi PCM 16-bit 16 kHz (binary frame, đã lọc nhiễu trong `web/capture-worklet.js`) và `{ "type": "end" }` khi kết thúc.
  - Máy chủ gửi PCM 24 kHz (binary frame) và các sự kiện JSON: `transcript`, `interrupted`, `turn_complete`, `status` (`connected` | `reconnecting`), `warning`, `error`, `session_ended`.
  - Mất kết nối tới Gemini thì máy chủ tự nối lại (tối đa 5 lần liền, có giãn cách) và gửi `status: reconnecting`; nối lại mà Gemini không còn nhớ hội thoại thì AI xin lỗi và hỏi lại câu đang dang dở.
- Bảng giáo viên: `GET /api/sessions/{id}/insights`.

## Màn Kết quả

- `POST /api/sessions/{id}/finish` trả báo cáo; `GET /api/sessions/{id}` trả các lượt hỏi đáp.
