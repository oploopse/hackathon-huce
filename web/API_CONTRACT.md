# Contract API · Màn 01 Thiết lập

Dành cho backend. Đây là API đích cho màn 01 khi backend sẵn sàng.

> Hiện tại (03/10/2026) để cả luồng chạy được ngay, frontend dùng API sẵn có của `app/main.py` qua `web/js/api.js`: chữ đã trích được gửi lên `POST /api/documents` dưới dạng file Markdown (mỗi trang mở đầu bằng `## Trang n`), phỏng vấn qua phiên nhắn tin `/api/sessions`, giọng nói chạy trên trình duyệt; số câu và thời gian do frontend tự kiểm soát. Khi backend có các endpoint dưới đây, chỉ cần đổi `web/js/api.js`. Giới hạn của từng trường nằm ở `web/js/contract.js` (`LIMITS`); nếu đổi con số nào, đổi ở cả hai phía.

## Thay đổi so với thiết kế Figma

- PDF được đọc ngay trên trình duyệt bằng pdf.js. Backend **không nhận file**, chỉ nhận chữ của từng trang trong phạm vi người học chọn.
- Bỏ "Độ khó" và "Giọng giám khảo". Không có trường nào cho hai mục này.
- "Số câu hỏi": kéo chọn 5–10 câu, mặc định 5, tính cả câu hỏi đào sâu.
- "Phạm vi trang": chọn từ 1 đến 100 trang liên tiếp trong file.
- "Thời gian phỏng vấn": tổng thời gian cho cả buổi, tối đa và mặc định 15 phút, ít nhất 5 phút. Thay cho `INTERVIEW_MINUTES` cố định.
- Kiểm tra micro chỉ chạy trên trình duyệt, không gửi gì lên backend.

## Endpoint cần làm

| Method | Path | Ai gọi, khi nào |
| --- | --- | --- |
| `POST` | `/api/interviews` | Màn 01, khi bấm "Tiếp tục: đọc tài liệu" |
| `GET` | `/api/interviews/{id}` | Màn 02–03 (làm sau), hỏi lại mỗi 2 giây khi `status` còn là `preparing` |

## POST /api/interviews

Header `Content-Type: application/json`. Ví dụ body thật do frontend gửi (đã rút gọn chữ):

```json
{
  "question_count": 5,
  "duration_minutes": 15,
  "document": {
    "filename": "Mang_may_tinh_Chuong3.pdf",
    "page_count": 9,
    "page_from": 2,
    "page_to": 5,
    "pages": [
      { "page": 2, "text": "Mạng máy tính · Chương 3\n2\nMục tiêu của chương\nSau khi học xong chương này, người học cần:\n…" },
      { "page": 3, "text": "…" },
      { "page": 4, "text": "" },
      { "page": 5, "text": "…" }
    ]
  }
}
```

| Trường | Kiểu | Ràng buộc | Ý nghĩa |
| --- | --- | --- | --- |
| `question_count` | int | 5 ≤ x ≤ 10 | Tổng số câu giám khảo hỏi, tính cả câu hỏi đào sâu |
| `duration_minutes` | int | 5 ≤ x ≤ 15 | Tổng thời gian cả buổi phỏng vấn, tính bằng phút |
| `document.filename` | string | 1–255 ký tự, đuôi `.pdf` | Tên file gốc trên máy người học |
| `document.page_count` | int | ≥ 1 | Tổng số trang của file |
| `document.page_from` | int | 1 ≤ `page_from` ≤ `page_to` | Trang đầu của phạm vi đã chọn |
| `document.page_to` | int | `page_to` ≤ `page_count`, và `page_to − page_from + 1` ≤ 100 | Trang cuối của phạm vi đã chọn |
| `document.pages` | array | Đúng một phần tử cho mỗi trang từ `page_from` đến `page_to`, tăng dần | Chữ của từng trang |
| `document.pages[].page` | int | Số trang trong file, đếm từ 1 | |
| `document.pages[].text` | string | Có thể rỗng | Chữ của trang; `""` nếu trang chỉ có ảnh |

Ràng buộc trên toàn bộ body:

- Ít nhất một trang có chữ (sau khi bỏ khoảng trắng). Nếu không, file là bản scan và frontend đã chặn từ trước.
- Tổng số ký tự của mọi `text` ≤ 500.000, nên body tối đa khoảng 1 MB. 4 trang của file mẫu chỉ khoảng 11,5 KB.

Frontend kiểm tra hết các điều kiện trên trước khi gửi, nhưng backend vẫn phải kiểm tra lại.

### Chữ trong `text` đã được xử lý thế nào

- Lấy từ lớp chữ của PDF bằng pdf.js, nên có thể lẫn tiêu đề trang và số trang (ví dụ dòng `Mạng máy tính · Chương 3` rồi `2` ở đầu trang).
- Đã chuẩn hóa Unicode NFC, bỏ soft hyphen, nối chữ bị ngắt bằng gạch nối cuối dòng, gộp khoảng trắng thừa.
- Giữ `\n` giữa các dòng (tối đa hai `\n` liên tiếp). Gọi lại `normalize_text()` trong `app/ingest.py` vẫn an toàn: với chữ đã chuẩn hóa, nó chỉ còn đổi `\n` thành dấu cách.

### Response 201

Trả ngay sau khi nhận được. Backend có thể soạn bản đồ kiến thức trong nền (trả `preparing`) hoặc soạn xong rồi mới trả (trả `ready`). Nên chọn cách chạy nền: người học còn phải đọc tài liệu ở màn 02 nên có sẵn thời gian chờ, và frontend chỉ đợi tối đa 120 giây cho request này.

```json
{
  "id": "8f3a2c1d",
  "status": "preparing",
  "error": null,
  "question_count": 5,
  "duration_minutes": 15,
  "document": {
    "filename": "Mang_may_tinh_Chuong3.pdf",
    "page_count": 9,
    "page_from": 2,
    "page_to": 5,
    "title": null,
    "summary": null,
    "truncated": false,
    "concepts": []
  }
}
```

| Trường | Kiểu | Ghi chú |
| --- | --- | --- |
| `id` | string, không rỗng | Mã buổi phỏng vấn. **Bắt buộc**: thiếu thì frontend báo lỗi |
| `status` | `"preparing"` \| `"ready"` \| `"failed"` | `failed` thì frontend hiện `error` cho người học |
| `error` | string \| null | Câu báo lỗi tiếng Việt khi `status = "failed"` |
| `question_count`, `duration_minutes` | int | Trả lại đúng giá trị đã nhận |
| `document.filename`, `page_count`, `page_from`, `page_to` | | Trả lại đúng giá trị đã nhận |
| `document.title`, `document.summary` | string \| null | Có giá trị khi `ready`. Dùng ở màn 03 |
| `document.truncated` | bool | `true` nếu chữ quá dài và chỉ phần đầu được dùng để soạn câu hỏi |
| `document.concepts` | array | Có giá trị khi `ready`, mỗi phần tử: `{ "id": "c1", "name": "Cửa sổ tắc nghẽn cwnd", "summary": "…", "importance": 3, "pages": [15] }`. Dùng ở màn 03 (danh sách "Khái niệm giám khảo sẽ hỏi" kèm số trang) |

Hiện màn 01 chỉ đọc `id`, `status` và `error`. Các trường còn lại cần có trước khi làm màn 03.

### Lỗi

Body lỗi theo kiểu mặc định của FastAPI: `{"detail": "câu báo lỗi"}`, hoặc danh sách lỗi validate `{"detail": [{"msg": "…"}]}`. Frontend hiện nguyên văn `detail` cho người học, nên viết bằng tiếng Việt, ngắn gọn.

| Mã | Khi nào |
| --- | --- |
| 422 | Body sai contract (validate của Pydantic hoặc kiểm tra thêm) |
| 413 | Body quá lớn, nếu backend có đặt giới hạn |
| 502, 503 | Lỗi gọi Gemini (đã có handler `LLMError`, `LLMNotConfigured` trong `app/main.py`) |

Khi chưa có endpoint, FastAPI trả 405 (do `StaticFiles` đang mount ở `/`), frontend hiện "Máy chủ chưa hỗ trợ tạo buổi phỏng vấn theo thiết lập mới (HTTP 405)".

## GET /api/interviews/{id}

Trả cùng object như response 201, với `status` mới nhất. 404 kèm `{"detail": "Không tìm thấy buổi phỏng vấn"}` nếu sai `id`. Màn 02–03 sẽ dùng endpoint này; màn 01 chưa gọi.

## Gợi ý triển khai bằng code sẵn có

- Bỏ qua bước parse file: mỗi trang có chữ thành `Block(page=p.page, text=normalize_text(p.text))`, rồi `chunk_blocks(blocks)` và `build_knowledge_map(filename, chunks)` như luồng upload hiện tại. Luồng này không cần pymupdf.
- `pages` của mỗi concept lấy từ `source_chunks` → `Chunk.page`.
- Khi mở phiên phỏng vấn: `time_limit_seconds = duration_minutes * 60` thay cho `settings.interview_minutes * 60`; dừng khi đã hỏi đủ `question_count` câu (tính cả câu đào sâu) hoặc hết giờ, tùy điều kiện nào đến trước.

Model Pydantic tương ứng với request, để dán vào `app/main.py` nếu tiện:

```python
from pydantic import BaseModel, Field, model_validator

MAX_PAGES = 100
MAX_TOTAL_CHARS = 500_000


class PageText(BaseModel):
    page: int = Field(ge=1)
    text: str


class DocumentPages(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    page_count: int = Field(ge=1)
    page_from: int = Field(ge=1)
    page_to: int = Field(ge=1)
    pages: list[PageText] = Field(min_length=1, max_length=MAX_PAGES)

    @model_validator(mode="after")
    def check_pages(self) -> "DocumentPages":
        if not self.page_from <= self.page_to <= self.page_count:
            raise ValueError("Khoảng trang không hợp lệ")
        if self.page_to - self.page_from + 1 > MAX_PAGES:
            raise ValueError(f"Chỉ chọn tối đa {MAX_PAGES} trang mỗi lần")
        if [p.page for p in self.pages] != list(range(self.page_from, self.page_to + 1)):
            raise ValueError("Cần đúng một phần tử cho mỗi trang trong khoảng, theo thứ tự tăng dần")
        if sum(len(p.text) for p in self.pages) > MAX_TOTAL_CHARS:
            raise ValueError("Các trang đã chọn có quá nhiều chữ")
        if not any(p.text.strip() for p in self.pages):
            raise ValueError("Các trang đã chọn không có chữ, có thể là bản scan")
        return self


class InterviewCreate(BaseModel):
    question_count: int = Field(ge=5, le=10)
    duration_minutes: int = Field(ge=5, le=15)
    document: DocumentPages
```

## Thử nhanh

Cách dễ nhất: chạy server như README, mở http://127.0.0.1:8000, bấm "Dùng file mẫu", thử micro rồi bấm "Tiếp tục: đọc tài liệu". Ô kết quả dưới nút sẽ hiện mã buổi hoặc câu báo lỗi.

Gọi trực tiếp bằng PowerShell:

```powershell
$body = @{
  question_count = 5
  duration_minutes = 15
  document = @{
    filename = "demo.pdf"; page_count = 2; page_from = 1; page_to = 2
    pages = @(
      @{ page = 1; text = "TCP dùng bắt tay ba bước để thiết lập kết nối." },
      @{ page = 2; text = "" }
    )
  }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/interviews `
  -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body))
```
