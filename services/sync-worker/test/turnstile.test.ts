import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../src/context';
import { requireTurnstile } from '../src/turnstile';

const stagingContext = (token?: string): RequestContext => ({
  request: new Request('https://sync.invalid/v1/vaults', {
    method: 'POST',
    headers: token ? { 'X-Mirna-Turnstile-Token': token } : undefined,
  }),
  env: {
    ...env,
    MIRNA_ENVIRONMENT: 'staging',
    TURNSTILE_SECRET_KEY: 'test-secret-not-a-production-secret',
  },
  requestId: crypto.randomUUID(),
  allowedOrigin: 'https://mirna-finansije-beta.vercel.app',
});

describe('Turnstile staging validation', () => {
  it('rejects a missing token without contacting Siteverify', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      requireTurnstile(stagingContext(), 'mirna_vault_create', fetcher),
    ).rejects.toMatchObject({ status: 403, code: 'HUMAN_VERIFICATION_REQUIRED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts only the expected beta hostname and route action', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        success: true,
        hostname: 'mirna-finansije-beta.vercel.app',
        action: 'mirna_vault_create',
      }),
    );
    await expect(
      requireTurnstile(stagingContext('opaque-single-use-token'), 'mirna_vault_create', fetcher),
    ).resolves.toBeUndefined();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    expect(init?.body instanceof URLSearchParams ? init.body.get('response') : null).toBe(
      'opaque-single-use-token',
    );
  });

  it.each([
    { hostname: 'attacker.invalid', action: 'mirna_vault_create' },
    { hostname: 'mirna-finansije-beta.vercel.app', action: 'mirna_pairing_create' },
    { hostname: 'mirna-finansije-beta.vercel.app', action: 'mirna_vault_create', success: false },
  ])('fails closed for mismatched Siteverify evidence', async (result) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ success: true, ...result }));
    await expect(
      requireTurnstile(stagingContext('opaque-single-use-token'), 'mirna_vault_create', fetcher),
    ).rejects.toMatchObject({ status: 403, code: 'HUMAN_VERIFICATION_REQUIRED' });
  });
});
