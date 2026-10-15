/** @type {import('next').NextConfig} */
const nextConfig = {
  // Don't let `next dev`/`next build` append an agent-rules block to CLAUDE.md
  agentRules: false,

  // Optimize for production
  experimental: {
    // optimizeCss: true,
    // optimizePackageImports: ['lucide-react'],
  },
  images: {
    formats: ['image/webp', 'image/avif'],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    remotePatterns: [{ hostname: 'localhost' }],
  },
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production',
  },
  compress: true,

  // Enhanced headers for CORS and security
  headers: async () => [
    {
      // /api/now sets its own origin allowlist (see its route).
      source: '/api/:path((?!now$).*)',
      headers: [
        { key: 'Access-Control-Allow-Origin', value: '*' },
        { key: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
        { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
      ],
    },
  ],
  
  // Environment variables - Remove the warning about missing NEXT_PUBLIC_API_URL
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000',
  },
  
  // Ensure server listens on all interfaces in Docker
  ...(process.env.NODE_ENV === 'production' && {
    poweredByHeader: false,
  }),
}

module.exports = nextConfig