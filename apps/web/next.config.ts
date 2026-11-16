import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  // The browser only ever talks to this origin, so the session cookie stays first-party
  // and SameSite=Strict holds without any CORS setup.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
};

export default config;
