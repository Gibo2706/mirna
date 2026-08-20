import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '../../../src/domain/sync/canonical';
import type { RequestContext } from '../src/context';
import { handleBetaDiagnosticEvent, recordBetaDiagnostic } from '../src/diagnostics';

const SUPPORT_ID = 'MIRNA-0123-4567-89AB-CDEF-GHJK-MNPQ-RS';

const diagnosticContext = (
  body: unknown = {},
  environment: 'local' | 'staging' = 'staging',
): RequestContext => ({
  request: new Request('https://sync.invalid/v1/diagnostics/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://mirna-finansije-beta.vercel.app',
      'X-Mirna-Protocol-Version': '1',
      'X-Mirna-Support-Id': SUPPORT_ID,
    },
    body: canonicalizeJson(body),
  }),
  env: {
    ...env,
    MIRNA_ENVIRONMENT: environment,
    MIRNA_BUILD_COMMIT: 'abcdef0',
  },
  requestId: crypto.randomUUID(),
  allowedOrigin: 'https://mirna-finansije-beta.vercel.app',
});

describe('privacy-safe beta diagnostics', () => {
  it('accepts only the tiny anonymous Turnstile allowlist and stores hashed support references', async () => {
    const context = diagnosticContext({
      action: 'mirna_vault_create',
      build: '2.4.1',
      eventType: 'turnstile_rejected',
      occurredAt: '2026-08-01T16:00:00.000Z',
      online: true,
      safeCode: 'HUMAN_VERIFICATION_REJECTED',
      severity: 'error',
    });
    const response = await handleBetaDiagnosticEvent(context);
    expect(response.status).toBe(202);

    const stored = await env.MIRNA_SYNC_DB.prepare(
      `SELECT event_type, severity, request_id, technical_code, route_action,
              worker_build, safe_details_json, hex(support_ref) AS support_ref
         FROM beta_diagnostic_events
        WHERE request_id = ?1`,
    )
      .bind(context.requestId)
      .first<Record<string, string>>();
    expect(stored).toMatchObject({
      event_type: 'turnstile_client_phase',
      severity: 'error',
      technical_code: 'turnstile_rejected',
      route_action: 'mirna_vault_create',
      worker_build: 'abcdef0',
    });
    expect(stored?.support_ref).toMatch(/^[0-9A-F]{64}$/u);
    expect(JSON.stringify(stored)).not.toContain(SUPPORT_ID);
    expect(stored?.safe_details_json).toBe(
      '{"appBuild":"2.4.1","online":true,"safeCode":"HUMAN_VERIFICATION_REJECTED","verificationAttemptId":"NONE","verificationReason":"NONE"}',
    );
  });

  it('rejects broader anonymous client events without device authentication', async () => {
    const context = diagnosticContext({
      build: '2.4.1',
      eventType: 'sync_request_error',
      occurredAt: '2026-08-01T16:00:00.000Z',
      online: true,
      safeCode: 'NETWORK_FAILURE',
      severity: 'error',
    });
    await expect(handleBetaDiagnosticEvent(context)).rejects.toMatchObject({
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
    });
  });

  it('stores only the allowlisted Worker Siteverify category, never request material', async () => {
    const context = diagnosticContext();
    await recordBetaDiagnostic(context, {
      eventType: 'turnstile_siteverify_result',
      severity: 'error',
      category: 'siteverify-invalid-input-response',
      action: 'mirna_vault_create',
      requestId: context.requestId,
    });
    const stored = await env.MIRNA_SYNC_DB.prepare(
      `SELECT technical_code, safe_details_json
         FROM beta_diagnostic_events
        WHERE request_id = ?1`,
    )
      .bind(context.requestId)
      .first<{ technical_code: string; safe_details_json: string }>();
    expect(stored).toEqual({
      technical_code: 'siteverify-invalid-input-response',
      safe_details_json: '{}',
    });
  });

  it('validates local test events without writing beta telemetry', async () => {
    const context = diagnosticContext(
      {
        build: '2.4.1',
        eventType: 'turnstile_success',
        occurredAt: '2026-08-01T16:00:00.000Z',
        online: true,
        severity: 'info',
      },
      'local',
    );
    const response = await handleBetaDiagnosticEvent(context);
    expect(response.status).toBe(202);
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        'SELECT COUNT(*) AS count FROM beta_diagnostic_events WHERE request_id = ?1',
      )
        .bind(context.requestId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });
});
