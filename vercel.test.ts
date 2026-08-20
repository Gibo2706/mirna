import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, buildVercelConfig, config } from './vercel';

const stableEnvironment = {
  VITE_MIRNA_SYNC_ENABLED: 'false',
  VITE_MIRNA_SYNC_API_URL: '',
  VITE_TURNSTILE_SITE_KEY: '',
  VITE_MIRNA_APP_ENV: 'production',
} as const;

const betaEnvironment = {
  VITE_MIRNA_SYNC_ENABLED: 'true',
  VITE_MIRNA_SYNC_API_URL: 'https://mirna-sync-staging.bogdan-markovic2706.workers.dev',
  VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  VITE_MIRNA_APP_ENV: 'beta',
} as const;

const expectValidHeaderRules = (generated: ReturnType<typeof buildVercelConfig>): void => {
  expect(generated.headers).toBeDefined();
  for (const rule of generated.headers ?? []) {
    expect(rule.source).toEqual(expect.any(String));
    expect(rule.source.length).toBeGreaterThan(0);
    expect(rule.headers.length).toBeGreaterThan(0);
    for (const header of rule.headers) {
      expect(header.key).toEqual(expect.any(String));
      expect(header.key.length).toBeGreaterThan(0);
      expect(header.value).toEqual(expect.any(String));
      expect(header.value.length).toBeGreaterThan(0);
    }
  }
};

describe('Vercel deployment CSP', () => {
  it('keeps sync-disabled deployments isolated from external sync infrastructure', () => {
    const policy = buildContentSecurityPolicy(stableEnvironment);

    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).not.toContain('workers.dev');
    expect(policy).not.toContain('challenges.cloudflare.com');
  });

  it.each([
    ['production', { ...betaEnvironment, VITE_MIRNA_APP_ENV: 'production' }],
    ['beta', betaEnvironment],
  ] as const)(
    'allows only the configured Worker and challenge origins for %s sync',
    (_name, environment) => {
      const policy = buildContentSecurityPolicy(environment);

      expect(policy).toContain('https://mirna-sync-staging.bogdan-markovic2706.workers.dev');
      expect(policy).toContain('https://challenges.cloudflare.com');
      expect(policy).not.toContain('*');
    },
  );

  it('exports a named config with complete headers for Vercel schema validation', () => {
    expect(config).toBeDefined();
    expectValidHeaderRules(buildVercelConfig(stableEnvironment));
    expectValidHeaderRules(buildVercelConfig(betaEnvironment));
  });
});
