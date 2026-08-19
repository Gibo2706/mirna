import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  createAccessSession,
  createInitialVaultFixture,
  registerInitialVault,
} from './protocol-fixtures';
import { checkAccountingReadiness } from '../src/health';

const request = (path: string, init?: RequestInit): Request =>
  new Request(`https://sync.invalid${path}`, init);

const SUPPORT_ID = 'MIRNA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA';
const ALLOWED_ORIGIN = 'http://localhost:5173';

const dailyBucketRow = async (day: string) =>
  env.MIRNA_SYNC_DB.prepare(
    `SELECT worker_requests, d1_rows_read, d1_rows_written, r2_class_a, r2_class_b, updated_at
       FROM usage_daily_buckets
      WHERE scope_type = 'global' AND scope_id = 'service' AND utc_day = ?1`,
  )
    .bind(day)
    .first<{
      worker_requests: number;
      d1_rows_read: number;
      d1_rows_written: number;
      r2_class_a: number;
      r2_class_b: number;
      updated_at: number;
    }>();

const rollingTotalsRow = async () =>
  env.MIRNA_SYNC_DB.prepare(
    `SELECT worker_requests, d1_rows_read, d1_rows_written, r2_class_a, r2_class_b, refreshed_at
       FROM usage_rolling_totals
      WHERE scope_type = 'global' AND scope_id = 'service'`,
  ).first<{
    worker_requests: number;
    d1_rows_read: number;
    d1_rows_written: number;
    r2_class_a: number;
    r2_class_b: number;
    refreshed_at: number;
  }>();

describe('Worker HTTP foundation', () => {
  it('reports D1 and R2 reachability without exposing binding identifiers', async () => {
    const response = await SELF.fetch(request('/v1/health'));
    const body = await response.json<{
      status: string;
      protocolVersion: number;
      environment: string;
      writesEnabled: boolean;
      services: { d1: string; r2: string };
      readiness: {
        storage: string;
        accountingSchema: string;
        accountingState: string;
        routeBudgetConformance: string;
        routeBudgetRegistryVersion: string;
        writes: string;
      };
    }>();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({
      status: 'ok',
      protocolVersion: 1,
      environment: 'local',
      buildCommit: 'local',
      writesEnabled: true,
      services: { d1: 'ok', r2: 'ok' },
      readiness: {
        storage: 'ok',
        accountingSchema: 'ok',
        accountingState: 'ok',
        routeBudgetConformance: 'ok',
        routeBudgetRegistryVersion: '2026-08-02.1',
        writes: 'enabled',
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /database[_-]?id|bucket[_-]?name|account[_-]?(?:id|tag)|LOCAL_MINIFLARE/u,
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Mirna-Protocol-Version')).toBe('1');
    expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('keeps reachability distinct from accounting schema and state readiness', async () => {
    const missingSchema = {
      prepare: () => ({ all: () => Promise.reject(new Error('no such table')) }),
    } as unknown as D1Database;
    await expect(checkAccountingReadiness(missingSchema)).resolves.toEqual({
      accountingSchema: 'error',
      accountingState: 'fault',
      routeBudgetConformance: 'fault',
      routeBudgetRegistryVersion: '2026-08-02.1',
      writes: 'disabled',
    });

    try {
      await env.MIRNA_SYNC_DB.prepare(
        `UPDATE service_flags
            SET accounting_fault = 1,
                state_reason = 'USAGE_RESERVATION_UNDERESTIMATED',
                state_request_id = ?1,
                accounting_fault_at = ?2,
                updated_at = ?2
          WHERE singleton_id = 1`,
      )
        .bind(crypto.randomUUID(), Date.now())
        .run();
      const response = await SELF.fetch(request('/v1/health'));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        status: 'degraded',
        services: { d1: 'ok', r2: 'ok' },
        readiness: {
          storage: 'ok',
          accountingSchema: 'ok',
          accountingState: 'fault',
          writes: 'disabled',
        },
      });
    } finally {
      await env.MIRNA_SYNC_DB.prepare(
        `UPDATE service_flags
            SET accounting_fault = 0, state_reason = 'NONE', state_request_id = NULL,
                accounting_fault_at = NULL, updated_at = ?1
          WHERE singleton_id = 1`,
      )
        .bind(Date.now())
        .run();
    }
  });

  it('allows only the exact configured CORS origin', async () => {
    const allowed = await SELF.fetch(
      request('/v1/health', { headers: { Origin: 'http://localhost:5173' } }),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');

    const loopback = await SELF.fetch(
      request('/v1/health', { headers: { Origin: 'http://127.0.0.1:5173' } }),
    );
    expect(loopback.status).toBe(200);
    expect(loopback.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:5173');

    const rejected = await SELF.fetch(
      request('/v1/health', { headers: { Origin: 'https://attacker.invalid' } }),
    );
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(await rejected.json()).toMatchObject({
      error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed.' },
      protocolVersion: 1,
    });
  });

  it('answers strict preflight requests without reflecting arbitrary headers', async () => {
    const response = await SELF.fetch(
      request('/v1/health', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'X-Mirna-Protocol-Version',
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('handles valid preflight before accounting, rejects invalid preflights, and blocks exhausted writes', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const now = Date.now();
    const dailyBefore = await dailyBucketRow(day);
    const rollingBefore = await rollingTotalsRow();

    try {
      await env.MIRNA_SYNC_DB.batch([
        env.MIRNA_SYNC_DB.prepare(
          `INSERT INTO usage_daily_buckets (
             scope_type, scope_id, utc_day, worker_requests, d1_rows_read,
             d1_rows_written, r2_class_a, r2_class_b, updated_at
           ) VALUES ('global', 'service', ?1, 0, 0, 80000, 0, 0, ?2)
           ON CONFLICT(scope_type, scope_id, utc_day) DO UPDATE SET
             worker_requests = excluded.worker_requests,
             d1_rows_read = excluded.d1_rows_read,
             d1_rows_written = excluded.d1_rows_written,
             r2_class_a = excluded.r2_class_a,
             r2_class_b = excluded.r2_class_b,
             updated_at = excluded.updated_at`,
        ).bind(day, now),
        env.MIRNA_SYNC_DB.prepare(
          `INSERT INTO usage_rolling_totals (
             scope_type, scope_id, worker_requests, d1_rows_read,
             d1_rows_written, r2_class_a, r2_class_b, refreshed_at
           ) VALUES ('global', 'service', 0, 0, 80000, 0, 0, ?1)
           ON CONFLICT(scope_type, scope_id) DO UPDATE SET
             worker_requests = excluded.worker_requests,
             d1_rows_read = excluded.d1_rows_read,
             d1_rows_written = excluded.d1_rows_written,
             r2_class_a = excluded.r2_class_a,
             r2_class_b = excluded.r2_class_b,
             refreshed_at = excluded.refreshed_at`,
        ).bind(now),
      ]);

      const valid = await SELF.fetch(
        request('/v1/health', {
          method: 'OPTIONS',
          headers: {
            Origin: ALLOWED_ORIGIN,
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'x-mirna-protocol-version,x-mirna-support-id',
          },
        }),
      );
      const validRequestId = valid.headers.get('X-Request-Id');
      expect(valid.status).toBe(204);
      expect(valid.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
      expect(valid.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
      expect(valid.headers.get('Access-Control-Allow-Headers')).toContain(
        'x-mirna-protocol-version',
      );
      expect(valid.headers.get('Access-Control-Allow-Headers')).toContain('x-mirna-support-id');
      expect(validRequestId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(
        await env.MIRNA_SYNC_DB.prepare(
          `SELECT COUNT(*) AS count FROM usage_reservations WHERE reservation_id LIKE ?1`,
        )
          .bind(`${validRequestId}:%`)
          .first<{ count: number }>(),
      ).toEqual({ count: 0 });
      expect(
        await env.MIRNA_SYNC_DB.prepare(
          `SELECT COUNT(*) AS count FROM beta_diagnostic_events WHERE request_id = ?1`,
        )
          .bind(validRequestId)
          .first<{ count: number }>(),
      ).toEqual({ count: 0 });

      const invalidOrigin = await SELF.fetch(
        request('/v1/health', {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://attacker.invalid',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'x-mirna-protocol-version',
          },
        }),
      );
      expect(invalidOrigin.status).toBe(403);

      const invalidMethod = await SELF.fetch(
        request('/v1/health', {
          method: 'OPTIONS',
          headers: {
            Origin: ALLOWED_ORIGIN,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'x-mirna-protocol-version',
          },
        }),
      );
      expect(invalidMethod.status).toBe(403);

      const invalidHeader = await SELF.fetch(
        request('/v1/health', {
          method: 'OPTIONS',
          headers: {
            Origin: ALLOWED_ORIGIN,
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'x-not-allowed',
          },
        }),
      );
      expect(invalidHeader.status).toBe(403);

      const exhaustedWrite = await SELF.fetch(
        request('/v1/operations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: ALLOWED_ORIGIN,
            'X-Mirna-Protocol-Version': '1',
          },
          body: '{}',
        }),
      );
      expect(exhaustedWrite.status).toBe(503);
      expect(await exhaustedWrite.json()).toMatchObject({
        error: {
          code: 'SERVICE_QUOTA_EXHAUSTED',
          message: 'Staging service quota is exhausted.',
        },
      });
    } finally {
      if (dailyBefore === null) {
        await env.MIRNA_SYNC_DB.prepare(
          `DELETE FROM usage_daily_buckets
            WHERE scope_type = 'global' AND scope_id = 'service' AND utc_day = ?1`,
        )
          .bind(day)
          .run();
      } else {
        await env.MIRNA_SYNC_DB.prepare(
          `UPDATE usage_daily_buckets
              SET worker_requests = ?2,
                  d1_rows_read = ?3,
                  d1_rows_written = ?4,
                  r2_class_a = ?5,
                  r2_class_b = ?6,
                  updated_at = ?7
            WHERE scope_type = 'global' AND scope_id = 'service' AND utc_day = ?1`,
        )
          .bind(
            day,
            dailyBefore.worker_requests,
            dailyBefore.d1_rows_read,
            dailyBefore.d1_rows_written,
            dailyBefore.r2_class_a,
            dailyBefore.r2_class_b,
            dailyBefore.updated_at,
          )
          .run();
      }

      if (rollingBefore === null) {
        await env.MIRNA_SYNC_DB.prepare(
          `DELETE FROM usage_rolling_totals
            WHERE scope_type = 'global' AND scope_id = 'service'`,
        ).run();
      } else {
        await env.MIRNA_SYNC_DB.prepare(
          `UPDATE usage_rolling_totals
              SET worker_requests = ?1,
                  d1_rows_read = ?2,
                  d1_rows_written = ?3,
                  r2_class_a = ?4,
                  r2_class_b = ?5,
                  refreshed_at = ?6
            WHERE scope_type = 'global' AND scope_id = 'service'`,
        )
          .bind(
            rollingBefore.worker_requests,
            rollingBefore.d1_rows_read,
            rollingBefore.d1_rows_written,
            rollingBefore.r2_class_a,
            rollingBefore.r2_class_b,
            rollingBefore.refreshed_at,
          )
          .run();
      }
    }
  });

  it('keeps routine successful requests out of persistent beta diagnostics while still settling budget', async () => {
    const fixture = await createInitialVaultFixture();
    expect((await registerInitialVault(fixture)).status).toBe(201);
    const { accessToken } = await createAccessSession(fixture);
    const response = await SELF.fetch(
      request('/v1/vault/manifest', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Origin: ALLOWED_ORIGIN,
          'X-Mirna-Protocol-Version': '1',
          'X-Mirna-Support-Id': SUPPORT_ID,
        },
      }),
    );
    const requestId = response.headers.get('X-Request-Id');
    expect(response.status).toBe(200);
    expect(requestId).not.toBeNull();
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        `SELECT COUNT(*) AS count FROM beta_diagnostic_events WHERE request_id = ?1`,
      )
        .bind(requestId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        `SELECT state, settled_at FROM usage_reservations WHERE reservation_id = ?1`,
      )
        .bind(`${requestId!}:route`)
        .first<{ state: string; settled_at: number }>(),
    ).toMatchObject({ state: 'committed' });
  });

  it('rejects unsupported methods, content types and routes with safe JSON', async () => {
    const wrongMethod = await SELF.fetch(
      request('/v1/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('Allow')).toBe('GET, OPTIONS');

    const wrongDeletionMethod = await SELF.fetch(
      request('/v1/vault', {
        headers: {
          Origin: 'http://localhost:5173',
          'X-Mirna-Protocol-Version': '1',
        },
      }),
    );
    expect(wrongDeletionMethod.status).toBe(405);
    expect(wrongDeletionMethod.headers.get('Allow')).toBe('DELETE, OPTIONS');

    const wrongContentType = await SELF.fetch(
      request('/v1/not-implemented', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Origin: 'http://localhost:5173',
          'X-Mirna-Protocol-Version': '1',
        },
        body: 'plaintext is not accepted',
      }),
    );
    expect(wrongContentType.status).toBe(404);
    expect(await wrongContentType.json()).toMatchObject({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'Route was not found.',
      },
    });

    const unknownRoute = await SELF.fetch(
      request('/v1/not-implemented', {
        headers: {
          Origin: 'http://localhost:5173',
          'X-Mirna-Protocol-Version': '1',
        },
      }),
    );
    const unknownBody = await unknownRoute.text();
    expect(unknownRoute.status).toBe(404);
    expect(unknownBody).not.toMatch(/stack|Error:|services\/sync-worker/u);
  });

  it('rejects an explicitly incompatible protocol version', async () => {
    const response = await SELF.fetch(
      request('/v1/health', { headers: { 'X-Mirna-Protocol-Version': '2' } }),
    );

    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'PROTOCOL_UPGRADE_REQUIRED',
        message: 'Sync protocol version is not supported.',
      },
      protocolVersion: 1,
    });
  });
});
