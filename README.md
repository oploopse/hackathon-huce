# Socratic Exam — kiểm tra API hello

Frontend React/Vite tối giản để kiểm tra `GET /api/hello`. Không chứa logic phỏng vấn hoặc API key.

## Chạy trên máy

```bash
npm install
npm run dev
```

Mở URL do Vite in ra, bấm **Gọi API hello**. Kết quả mong đợi là `hello world` và HTTP 200.

## Deploy Vercel

Đưa thư mục này lên repo Git, import repo vào Vercel. Chọn framework Vite; build command `npm run build`, output directory `dist`. URL ngrok hiện có là giá trị mặc định. Khi URL đổi, đặt `VITE_API_BASE_URL` trong Environment Variables của Vercel thành origin HTTPS mới (không có `/api/hello`) rồi redeploy.

Biến `VITE_*` hiển thị trong mã frontend. Không đặt API key hoặc dữ liệu bí mật ở đây.
