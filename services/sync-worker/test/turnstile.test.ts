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
    ).rejects.toMatchObject({ status: 403, code: 'HUMAN_VERIFICATION_REJECTED' });
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
    {
      hostname: 'attacker.invalid',
      action: 'mirna_vault_create',
      expectedCode: 'HUMAN_VERIFICATION_CONFIGURATION',
      expectedStatus: 503,
    },
    {
      hostname: 'mirna-finansije-beta.vercel.app',
      action: 'mirna_pairing_create',
      expectedCode: 'HUMAN_VERIFICATION_CONFIGURATION',
      expectedStatus: 503,
    },
    {
      hostname: 'mirna-finansije-beta.vercel.app',
      action: 'mirna_vault_create',
      success: false,
      expectedCode: 'HUMAN_VERIFICATION_REJECTED',
      expectedStatus: 403,
    },
  ])(
    'fails closed for mismatched Siteverify evidence',
    async ({ expectedCode, expectedStatus, ...result }) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ success: true, ...result }));
      await expect(
        requireTurnstile(stagingContext('opaque-single-use-token'), 'mirna_vault_create', fetcher),
      ).rejects.toMatchObject({ status: expectedStatus, code: expectedCode });
    },
  );

  it.each([
    ['timeout-or-duplicate', 'HUMAN_VERIFICATION_EXPIRED', 403],
    ['invalid-input-secret', 'HUMAN_VERIFICATION_CONFIGURATION', 503],
    ['internal-error', 'HUMAN_VERIFICATION_UNAVAILABLE', 503],
    ['invalid-input-response', 'HUMAN_VERIFICATION_REJECTED', 403],
  ] as const)('maps Siteverify %s to a safe stable category', async (code, publicCode, status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ success: false, 'error-codes': [code], messages: [] }));
    await expect(
      requireTurnstile(stagingContext('opaque-single-use-token'), 'mirna_vault_create', fetcher),
    ).rejects.toMatchObject({ status, code: publicCode });
  });

  it('fails closed on an undocumented Siteverify response shape', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        success: true,
        hostname: 'mirna-finansije-beta.vercel.app',
        action: 'mirna_vault_create',
        unexpected: true,
      }),
    );
    await expect(
      requireTurnstile(stagingContext('opaque-single-use-token'), 'mirna_vault_create', fetcher),
    ).rejects.toMatchObject({ status: 403, code: 'HUMAN_VERIFICATION_REJECTED' });
  });
});
