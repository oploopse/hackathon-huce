import { useEffect, useState } from 'react';

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ||
  'https://debatable-awning-unbridle.ngrok-free.dev'
).replace(/\/$/, '');

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
    const timer = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(`${API_BASE_URL}/api/hello`, {
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
          ? 'Hết thời gian chờ (12 giây). Kiểm tra ngrok và backend.'
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
        <p className="description">Bấm nút để React gọi endpoint <code>GET /api/hello</code> của Hùng.</p>
        <div className="endpoint"><span>ENDPOINT</span><code>{API_BASE_URL}/api/hello</code></div>
        <button type="button" onClick={checkApi} disabled={loading}>
          {loading ? 'Đang kiểm tra…' : 'Gọi API hello'}
        </button>
        <div className={`result ${result.status}`} role="status" aria-live="polite">
          <span className="result-label">{result.status === 'success' ? 'THÀNH CÔNG' : result.status === 'error' ? 'CÓ LỖI' : 'KẾT QUẢ'}</span>
          <strong>{result.message || 'Chưa gọi API'}</strong>
          {result.code && <small>HTTP {result.code}</small>}
        </div>
        <p className="note">Nếu ngrok đổi URL, đặt biến môi trường <code>VITE_API_BASE_URL</code> rồi deploy lại.</p>
      </section>
    </main>
  );
}
