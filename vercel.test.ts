import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy } from './vercel';

describe('Vercel deployment CSP', () => {
  it('keeps stable feature-off deployments isolated from beta infrastructure', () => {
    const policy = buildContentSecurityPolicy({
      VITE_MIRNA_SYNC_ENABLED: 'false',
      VITE_MIRNA_BETA_ONLY: 'false',
      VITE_MIRNA_APP_ENV: 'production',
    });

    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).not.toContain('workers.dev');
    expect(policy).not.toContain('challenges.cloudflare.com');
  });

  it('allows only the exact staging and challenge origins for the beta channel', () => {
    const policy = buildContentSecurityPolicy({
      VITE_MIRNA_SYNC_ENABLED: 'true',
      VITE_MIRNA_BETA_ONLY: 'true',
      VITE_MIRNA_APP_ENV: 'beta',
    });

    expect(policy).toContain('https://mirna-sync-staging.bogdan-markovic2706.workers.dev');
    expect(policy).toContain('https://challenges.cloudflare.com');
    expect(policy).not.toContain('*');
  });
});
