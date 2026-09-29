# Socratic Exam — kiểm tra API hello

Frontend React/Vite tối giản để kiểm tra `GET /api/hello`. Trên Vercel, route này là một Function gọi ngrok từ phía server để tránh lỗi CORS của trình duyệt. Không chứa logic phỏng vấn hoặc API key.

## Deploy Vercel

Đưa thư mục này lên repo Git, import repo vào Vercel. Chọn framework Vite; build command `npm run build`, output directory `dist`. Vercel tự nhận Function trong `api/hello.js` và Function gọi API của Hùng tại `https://debatable-awning-unbridle.ngrok-free.dev/api/hello`. Địa chỉ `/api/hello` trên domain Vercel là cầu nối, không phải URL gốc của Hùng. Bạn không cần host backend cục bộ. Khi Hùng đổi URL ngrok, đặt `API_BASE_URL` trong Environment Variables của Vercel thành origin HTTPS mới (có hoặc không có `/api/hello`) rồi redeploy. API và tunnel ngrok phía Hùng cần hoạt động khi test. Sau khi deploy, mở `/api/hello` trên domain Vercel: kết quả mong đợi là `hello world` và HTTP 200.

`API_BASE_URL` được đọc ở phía server. Biến `VITE_API_BASE_URL` cũ vẫn được hỗ trợ tạm thời để không làm hỏng cấu hình đã có.
