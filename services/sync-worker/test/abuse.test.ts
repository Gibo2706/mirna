import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { enforceEdgeRateLimit } from '../src/abuse';
import type { Env } from '../src/env';

const request = (path: string): Request =>
  new Request(`https://sync.invalid${path}`, {
    headers: {
      Origin: 'http://localhost:5173',
      'CF-Connecting-IP': '203.0.113.9',
    },
  });

const environment = (
  kind: Env['MIRNA_ENVIRONMENT'],
  bindings: Partial<
    Pick<
      Env,
      | 'MIRNA_HEALTH_RATE_LIMITER'
      | 'MIRNA_SETUP_RATE_LIMITER'
      | 'MIRNA_PAIRING_CREATE_RATE_LIMITER'
      | 'MIRNA_PAIRING_ACTION_RATE_LIMITER'
      | 'MIRNA_AUTH_CHALLENGE_RATE_LIMITER'
      | 'MIRNA_AUTH_SESSION_RATE_LIMITER'
      | 'MIRNA_RECOVERY_INIT_RATE_LIMITER'
      | 'MIRNA_RECOVERY_ACTION_RATE_LIMITER'
      | 'MIRNA_SYNC_READ_RATE_LIMITER'
    >
  > = {},
): Env => ({ ...env, MIRNA_ENVIRONMENT: kind, ...bindings });

const fakeLimiter = (implementation: RateLimit['limit']): RateLimit => ({
  limit: implementation,
});

describe('anonymous edge rate limiting', () => {
  it('uses an opaque, binding-separated key and allows a successful decision', async () => {
    const observedKeys: string[] = [];
    const limiter = fakeLimiter(({ key }) => {
      observedKeys.push(key);
      return Promise.resolve({ success: true });
    });
    const configured = environment('staging', {
      MIRNA_SETUP_RATE_LIMITER: limiter,
      MIRNA_PAIRING_CREATE_RATE_LIMITER: limiter,
    });

    await expect(enforceEdgeRateLimit(request('/v1/vaults'), configured)).resolves.toBeUndefined();
    await expect(
      enforceEdgeRateLimit(request('/v1/pairings'), configured),
    ).resolves.toBeUndefined();
    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(observedKeys[1]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(observedKeys[0]).not.toBe(observedKeys[1]);
    expect(JSON.stringify(observedKeys)).not.toContain('203.0.113.9');
  });

  it('maps a denied decision to 429 and fails closed when the binding throws', async () => {
    const denied = environment('staging', {
      MIRNA_AUTH_SESSION_RATE_LIMITER: fakeLimiter(() => Promise.resolve({ success: false })),
    });
    await expect(enforceEdgeRateLimit(request('/v1/auth/session'), denied)).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });

    const unavailable = environment('staging', {
      MIRNA_RECOVERY_INIT_RATE_LIMITER: fakeLimiter(() =>
        Promise.reject(new Error('synthetic limiter outage')),
      ),
    });
    await expect(
      enforceEdgeRateLimit(request('/v1/recovery/challenge'), unavailable),
    ).rejects.toMatchObject({ status: 503, code: 'RATE_LIMIT_UNAVAILABLE' });
  });

  it('fails closed for a missing staging binding but permits local Miniflare without one', async () => {
    await expect(
      enforceEdgeRateLimit(request('/v1/pairings'), environment('staging')),
    ).rejects.toMatchObject({ status: 503, code: 'RATE_LIMIT_UNAVAILABLE' });
    await expect(
      enforceEdgeRateLimit(request('/v1/pairings'), environment('local')),
    ).resolves.toBeUndefined();
  });

  it('protects health and does not invoke a limiter for an unknown route', async () => {
    const limit = vi.fn<RateLimit['limit']>(() => Promise.resolve({ success: true }));
    const configured = environment('staging', {
      MIRNA_HEALTH_RATE_LIMITER: fakeLimiter(limit),
    });
    await expect(enforceEdgeRateLimit(request('/v1/health'), configured)).resolves.toBeUndefined();
    expect(limit).toHaveBeenCalledOnce();
    await expect(enforceEdgeRateLimit(request('/v1/nope'), configured)).resolves.toBeUndefined();
    expect(limit).toHaveBeenCalledOnce();
  });
});
