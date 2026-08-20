import type { VercelConfig } from '@vercel/config/v1';
import { readSyncClientConfig } from './src/features/sync/config';

type VercelEnvironment = Readonly<Record<string, string | undefined>>;

export const buildContentSecurityPolicy = (environment: VercelEnvironment): string => {
  const syncConfig = readSyncClientConfig(environment);
  const syncDeployment = syncConfig.enabled;

  return [
    "default-src 'self'",
    syncDeployment ? "script-src 'self' https://challenges.cloudflare.com" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    syncDeployment
      ? `connect-src 'self' https://challenges.cloudflare.com ${syncConfig.apiOrigin}`
      : "connect-src 'self'",
    syncDeployment ? 'frame-src https://challenges.cloudflare.com' : "frame-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
};

export const buildVercelConfig = (environment: VercelEnvironment): VercelConfig => ({
  framework: 'vite',
  installCommand: 'npm ci',
  buildCommand: 'npm run build',
  outputDirectory: 'dist',
  rewrites: [{ source: '/(.*)', destination: '/index.html' }],
  headers: [
    {
      source: '/assets/(.*)',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
    },
    {
      source: '/workbox-(.*).js',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
    },
    ...['/pwa-(.*).png', '/apple-touch-icon.png', '/app-icon.svg'].map((source) => ({
      source,
      headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }],
    })),
    {
      source: '/manifest.webmanifest',
      headers: [
        { key: 'Content-Type', value: 'application/manifest+json' },
        { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
      ],
    },
    ...['/sw.js', '/index.html'].map((source) => ({
      source,
      headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
    })),
    {
      source: '/(.*)',
      headers: [
        {
          key: 'Content-Security-Policy',
          value: buildContentSecurityPolicy(environment),
        },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        {
          key: 'Permissions-Policy',
          value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        },
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=63072000; includeSubDomains; preload',
        },
      ],
    },
  ],
});

export const config: VercelConfig = buildVercelConfig(process.env);
