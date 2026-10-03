# Contract API cho backend

Dành cho Hùng (backend). Frontend (`web/`) đã làm xong phần giao diện cho các mục dưới đây. Mục nào backend chưa hỗ trợ thì giao diện vẫn hiện nhưng chưa gửi được gì. Khi backend làm xong, frontend tự dùng được mà không phải sửa thêm, trừ khi có ghi chú khác.

## 1. Gửi câu trả lời dạng chữ trong chế độ giọng nói

**Cần làm ngay.** Ở màn Phỏng vấn, chế độ Giọng nói, ô trả lời có thêm ô viết. Người học dùng ô này theo hai cách:

- Gõ câu trả lời thay vì nói (nút "Chuyển sang viết câu trả lời").
- Nói xong bấm "Trả lời": lời máy vừa nghe được chép vào ô, người học sửa chỗ nghe nhầm rồi bấm "Trả lời" lần nữa để nộp.

Hiện `_read_browser` trong `app/voice.py` chỉ nhận audio và `{"type": "end"}`. Tin nhắn chữ bị bỏ qua.

### Tin nhắn trình duyệt gửi lên

Gửi qua WebSocket sẵn có `/api/sessions/{session_id}/voice`, dạng text frame:

```json
{ "type": "text", "text": "TCP dùng bắt tay ba bước để thiết lập kết nối, còn UDP thì không cần kết nối." }
```

- `text`: đã `trim()`, dài 1–4000 ký tự (ô viết giới hạn `maxlength="4000"`).
- Frontend chỉ gửi khi trạng thái là `connected`. Mất kết nối thì chữ vẫn nằm trong ô viết.
- Frontend **tự hiện** câu này như một lượt nói của người học. Backend **không** gửi lại `transcript` cho chữ này, nếu không câu sẽ hiện hai lần.

### Backend cần xử lý

1. Trong `_read_browser`, khi nhận `{"type": "text"}`:
   - Thêm `text` vào `self.learner_buf`, để lượt này được ghi vào phiên (`record_turn`) và được bộ não chấm như lời nói.
   - Chuyển chữ cho Gemini Live như một lượt của người học, ví dụ `live.send_realtime_input(text=...)` hoặc `live.send_client_content(..., turn_complete=True)`. Cần một tham chiếu tới `live` hoặc một hàng đợi như `audio_in`.
2. Nếu người học gửi chữ khi AI đang nói, xử lý như khi bị ngắt lời: gửi `{"type": "interrupted"}` nếu Live dừng câu đang nói.
3. Nếu `text` rỗng hoặc dài quá 4000 ký tự, gửi `{"type": "warning", "message": "..."}`. Frontend sẽ hiện toast.
4. Lời đã sửa nên được ghi chú cho bộ não, ví dụ "Người học gõ lại câu trả lời:", để evaluator biết đây là bản người học tự sửa chứ không phải câu nói mới. Cách viết prompt do backend quyết định.

### Cờ báo đã hỗ trợ

Thêm vào `GET /api/health`:

```json
{ "voice_text_input": true }
```

Frontend đọc cờ này (`web/js/main.js`). Khi chưa có cờ, ô viết và nút "Trả lời" lần 1 vẫn dùng được, nhưng nút **Trả lời lần 2 (nộp) bị khoá** và có dòng nhắc "Máy chủ chưa nhận câu trả lời dạng chữ trong chế độ giọng nói".

### Nút Trả lời hai bước

Frontend đã làm, trong chế độ Giọng nói:

1. Người học nói xong thì bấm **Trả lời** lần 1. Micro tắt, ô trả lời chuyển sang ô sửa và chép sẵn lời máy vừa nghe.
2. Sửa chỗ máy nghe nhầm rồi bấm **Trả lời** lần 2 để nộp. Frontend gửi `{"type": "text"}` như trên, rồi quay lại chế độ nói cho câu sau.

Giới hạn hiện tại: Gemini Live tự nhận biết người học ngừng nói (VAD tự động) và **trả lời ngay câu gốc**. Vì vậy AI thường đã hỏi tiếp trước khi người học sửa xong, và bản sửa đến như một lượt bổ sung.

Muốn AI **chờ người học duyệt xong mới trả lời**, backend cần:

1. Tắt VAD tự động của Live cho phiên này (`realtime_input_config.automatic_activity_detection.disabled = True`) và tự đánh dấu đầu/cuối lượt bằng `activity_start` / `activity_end`.
2. Nhận thêm hai tin nhắn từ trình duyệt:
   - `{"type": "answer_draft_done"}`: người học bấm Trả lời lần 1. Backend gửi `activity_end` để Live chép lời (input transcription) nhưng **chưa** cho AI trả lời. Cách giữ AI chưa trả lời cần thử với Live API.
   - `{"type": "text", "text": "..."}` (như trên): bản đã duyệt. Đây là câu trả lời chính thức để AI trả lời và bộ não chấm.
3. Báo cờ `"voice_review_before_reply": true` trong `/api/health`.

Đây là thay đổi lớn ở `app/voice.py`. Nếu làm được, frontend sẽ gửi `answer_draft_done` khi người học bấm Trả lời lần 1. Phần này frontend chưa làm, vì cần chốt cách làm với backend trước.

## 2. Phạm vi trang, số câu hỏi, thời gian (màn Thiết lập)

**Làm sau.** Màn Thiết lập đã có ba ô này (`web/js/setup-display.js`) nhưng chưa gửi đi đâu.

- `POST /api/sessions` nhận thêm:

  ```json
  { "page_from": 2, "page_to": 5, "question_count": 5, "duration_minutes": 15 }
  ```

  Giới hạn: số câu 5–10 (mặc định 5, tính cả câu đào sâu); thời gian 5–15 phút (mặc định 15); phạm vi tối đa 100 trang liên tiếp. Bỏ trống `page_to` nghĩa là đến hết tài liệu.
- Thông tin tài liệu (`GET /api/documents`) trả thêm `page_count`, để ô trang báo được "File chỉ có N trang".

Khi backend làm xong mục này, frontend cần nối thêm: gửi giá trị từ `setup-display.js` qua `api.startSession`.
