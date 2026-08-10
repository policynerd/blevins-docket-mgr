/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The API is a separate service. Proxying keeps the browser same-origin, so
  // there is no CORS surface and the session cookie that will replace the
  // placeholder header has somewhere to live.
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_URL ?? 'http://127.0.0.1:3200'}/:path*`,
      },
    ];
  },
};
