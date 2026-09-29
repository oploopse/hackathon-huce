import React, { useEffect, useState } from 'react';

const API_PATH = '/api/hello';

export default function App() {
  const [result, setResult] = useState({ status: 'idle', message: '', code: null });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    document.title = 'Socratic Exam · Kiểm tra API';
  }, []);

  async function checkApi() {
    setLoading(true);
    setResult({ status: 'loading', message: 'Đang gọi API…', code: null });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
      const response = await fetch(API_PATH, {
        method: 'GET',
        headers: { Accept: 'text/plain' },
        signal: controller.signal,
      });
      const body = await response.text();
      setResult({
        status: response.ok ? 'success' : 'error',
        message: body || '(Phản hồi rỗng)',
        code: response.status,
      });
    } catch (error) {
      setResult({
        status: 'error',
        message: error.name === 'AbortError'
          ? 'API của Hùng không phản hồi trong 20 giây. Kiểm tra URL ngrok.'
          : `Không kết nối được: ${error.message}`,
        code: null,
      });
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <section className="card">
        <p className="eyebrow">SOCRATIC EXAM / CONNECTION TEST</p>
        <h1>Kiểm tra kết nối API</h1>
        <p className="description">Bấm nút để Vercel gọi API của Hùng qua ngrok. Bạn không cần chạy backend trên máy này.</p>
        <div className="endpoint"><span>ENDPOINT</span><code>{window.location.origin}{API_PATH}</code></div>
        <button type="button" onClick={checkApi} disabled={loading}>
          {loading ? 'Đang kiểm tra…' : 'Gọi API hello'}
        </button>
        <div className={`result ${result.status}`} role="status" aria-live="polite">
          <span className="result-label">{result.status === 'success' ? 'THÀNH CÔNG' : result.status === 'error' ? 'CÓ LỖI' : 'KẾT QUẢ'}</span>
          <strong>{result.message || 'Chưa gọi API'}</strong>
          {result.code && <small>HTTP {result.code}</small>}
        </div>
        <p className="note">Nếu Hùng đổi URL ngrok, đặt biến môi trường <code>API_BASE_URL</code> trên Vercel rồi deploy lại.</p>
      </section>
    </main>
  );
}
