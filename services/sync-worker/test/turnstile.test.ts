import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../src/context';
import { requireTurnstile } from '../src/turnstile';

const stagingContext = (token?: string): RequestContext => ({
  request: new Request('https://sync.invalid/v1/vaults', {
    method: 'POST',
    headers: token
      ? {
          'X-Mirna-Turnstile-Token': token,
          'X-Mirna-Verification-Attempt-Id': crypto.randomUUID(),
          'X-Mirna-Support-Id': 'MIRNA-0123-4567-89AB-CDEF-GHJK-MNPQ-RS',
        }
      : undefined,
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
    const context = stagingContext('opaque-single-use-token');
    await expect(requireTurnstile(context, 'mirna_vault_create', fetcher)).resolves.toBeUndefined();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    expect(init?.body instanceof URLSearchParams ? init.body.get('response') : null).toBe(
      'opaque-single-use-token',
    );
    expect(init?.body instanceof URLSearchParams ? init.body.get('idempotency_key') : null).toBe(
      context.request.headers.get('X-Mirna-Verification-Attempt-Id'),
    );
    expect(init?.body instanceof URLSearchParams ? init.body.has('remoteip') : true).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    const attemptId = context.request.headers.get('X-Mirna-Verification-Attempt-Id');
    const diagnosticRows = await env.MIRNA_SYNC_DB.prepare(
      `SELECT technical_code, safe_details_json
         FROM beta_diagnostic_events
        WHERE request_id = ?1
        ORDER BY rowid ASC`,
    )
      .bind(context.requestId)
      .all<{ technical_code: string; safe_details_json: string }>();
    expect(diagnosticRows.results.map((row) => row.technical_code)).toEqual([
      'siteverify-started',
      'verified',
    ]);
    expect(diagnosticRows.results).toHaveLength(2);
    expect(diagnosticRows.results.every((row) => row.safe_details_json.includes(attemptId!))).toBe(
      true,
    );
    expect(JSON.stringify(diagnosticRows.results)).not.toContain('opaque-single-use-token');
  });

  it.each([
    {
      hostname: 'attacker.invalid',
      action: 'mirna_vault_create',
      expectedCode: 'HUMAN_VERIFICATION_CONFIGURATION',
      expectedStatus: 503,
      expectedReason: 'HOSTNAME_MISMATCH',
    },
    {
      hostname: 'mirna-finansije-beta.vercel.app',
      action: 'mirna_pairing_create',
      expectedCode: 'HUMAN_VERIFICATION_CONFIGURATION',
      expectedStatus: 503,
      expectedReason: 'ACTION_MISMATCH',
    },
    {
      hostname: 'mirna-finansije-beta.vercel.app',
      action: 'mirna_vault_create',
      success: false,
      expectedCode: 'HUMAN_VERIFICATION_REJECTED',
      expectedStatus: 403,
      expectedReason: 'CONFIGURATION_ERROR',
    },
  ])(
    'fails closed for mismatched Siteverify evidence',
    async ({ expectedCode, expectedStatus, expectedReason, ...result }) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ success: true, ...result }));
      await expect(
        requireTurnstile(stagingContext('opaque-single-use-token'), 'mirna_vault_create', fetcher),
      ).rejects.toMatchObject({
        status: expectedStatus,
        code: expectedCode,
        verificationReason: expectedReason,
      });
    },
  );

  it.each([
    ['timeout-or-duplicate', 'HUMAN_VERIFICATION_EXPIRED', 403, 'TIMEOUT_OR_DUPLICATE'],
    ['invalid-input-secret', 'HUMAN_VERIFICATION_CONFIGURATION', 503, 'CONFIGURATION_ERROR'],
    ['internal-error', 'HUMAN_VERIFICATION_UNAVAILABLE', 503, 'SITEVERIFY_UNAVAILABLE'],
    ['invalid-input-response', 'HUMAN_VERIFICATION_REJECTED', 403, 'INVALID_INPUT_RESPONSE'],
  ] as const)(
    'maps Siteverify %s to a safe stable category',
    async (code, publicCode, status, verificationReason) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ success: false, 'error-codes': [code], messages: [] }));
      await expect(
        requireTurnstile(stagingContext('opaque-single-use-token'), 'mirna_vault_create', fetcher),
      ).rejects.toMatchObject({ status, code: publicCode, verificationReason });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it('ignores harmless unknown top-level fields while validating known evidence', async () => {
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
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
