const DEFAULT_API_BASE_URL = 'https://debatable-awning-unbridle.ngrok-free.dev';

export default {
  async fetch(request) {
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET' },
      });
    }

    const configuredUrl = (
      process.env.API_BASE_URL ||
      process.env.VITE_API_BASE_URL ||
      DEFAULT_API_BASE_URL
    ).trim().replace(/\/+$/, '');
    const upstreamUrl = configuredUrl.endsWith('/api/hello')
      ? configuredUrl
      : `${configuredUrl}/api/hello`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      const upstream = await fetch(upstreamUrl, {
        headers: {
          Accept: 'text/plain',
          'ngrok-skip-browser-warning': 'true',
        },
        signal: controller.signal,
      });
      const body = await upstream.text();
      const contentType = upstream.headers.get('content-type') || 'text/plain; charset=utf-8';

      if (contentType.toLowerCase().includes('text/html')) {
        return new Response('Ngrok trả về trang HTML thay vì phản hồi API.', { status: 502 });
      }

      return new Response(body, {
        status: upstream.status,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      const timedOut = error.name === 'AbortError';
      return new Response(
        timedOut ? 'API của Hùng không phản hồi trong 15 giây.' : 'Không kết nối được API của Hùng qua ngrok.',
        { status: timedOut ? 504 : 502 },
      );
    } finally {
      clearTimeout(timer);
    }
  },
};
