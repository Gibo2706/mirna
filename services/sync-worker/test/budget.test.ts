import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { StagingBudgets } from '../src/config/staging-budgets';
import { STAGING_BUDGETS } from '../src/config/staging-budgets';
import type { RequestContext } from '../src/context';
import {
  classifyR2Operation,
  releaseR2Object,
  reserveR2Object,
  runBudgetWindowMaintenance,
  UsageBudgetController,
} from '../src/budget';
import { HttpError } from '../src/errors';
import { RouteUsageMeter } from '../src/metering';
import { opaqueId, SEEDED_VAULT_ID, seedVaultAndDevice } from './fixtures';

const context = (path = '/v1/health', method = 'GET'): RequestContext => ({
  request: new Request(`https://sync.invalid${path}`, { method }),
  env,
  requestId: crypto.randomUUID(),
  allowedOrigin: 'http://localhost:5173',
  budgetReservationIds: [],
});

const tinyBudgets = (
  input: {
    globalWorkerRequests?: number;
    vaultWorkerRequests?: number;
    globalObjects?: number;
    vaultObjects?: number;
  } = {},
): StagingBudgets => ({
  ...STAGING_BUDGETS,
  global: {
    ...STAGING_BUDGETS.global,
    workerRequests: input.globalWorkerRequests ?? STAGING_BUDGETS.global.workerRequests,
    workerRequestsPerUtcDay:
      input.globalWorkerRequests ?? STAGING_BUDGETS.global.workerRequestsPerUtcDay,
  },
  perVault: {
    ...STAGING_BUDGETS.perVault,
    workerRequests: input.vaultWorkerRequests ?? STAGING_BUDGETS.perVault.workerRequests,
  },
  resources: {
    ...STAGING_BUDGETS.resources,
    r2ObjectCount: input.globalObjects ?? STAGING_BUDGETS.resources.r2ObjectCount,
  },
  perVaultResources: {
    ...STAGING_BUDGETS.perVaultResources,
    r2ObjectCount: input.vaultObjects ?? STAGING_BUDGETS.perVaultResources.r2ObjectCount,
  },
});

const code = (error: unknown): string | undefined =>
  error instanceof HttpError ? error.code : undefined;

beforeAll(async () => {
  await seedVaultAndDevice(env, Date.now());
});

describe('staging usage budgets', () => {
  it('classifies every generated R2 operation using the provider billing class', () => {
    expect(classifyR2Operation('put')).toBe('A');
    expect(classifyR2Operation('list')).toBe('A');
    expect(classifyR2Operation('copy')).toBe('A');
    expect(classifyR2Operation('get')).toBe('B');
    expect(classifyR2Operation('head')).toBe('B');
    expect(classifyR2Operation('delete')).toBe('free');
  });

  it('uses an atomic global reservation under concurrency and ignores environment overrides', async () => {
    const configured = new UsageBudgetController(tinyBudgets({ globalWorkerRequests: 1 }), () =>
      Date.parse('2026-08-01T10:00:00.000Z'),
    );

    const first = context('/v1/auth/challenge', 'POST');
    const second = context('/v1/auth/challenge', 'POST');

    const attemptedOverride = env as typeof env & {
      MIRNA_MAX_WORKER_REQUESTS?: string;
    };

    attemptedOverride.MIRNA_MAX_WORKER_REQUESTS = '999999999';

    const results = await Promise.allSettled([
      configured.reserveRoute(first),
      configured.reserveRoute(second),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    const rejected = results.find((result) => result.status === 'rejected');

    expect(rejected?.status === 'rejected' ? code(rejected.reason) : undefined).toBe(
      'SERVICE_QUOTA_EXHAUSTED',
    );

    const fulfilledIndex = results.findIndex((result) => result.status === 'fulfilled');

    await configured.settle(fulfilledIndex === 0 ? first : second);
  });

  it('releases unused route capacity while retaining the request count', async () => {
    const configured = new UsageBudgetController();
    const request = context('/v1/operations', 'POST');

    await configured.reserveRoute(request);

    const meter = new RouteUsageMeter();
    request.usageMeter = meter;
    request.env = meter.wrapEnvironment(env);

    await configured.settle(request);

    const route = await env.MIRNA_SYNC_DB.prepare(
      `SELECT
        state,
        committed_worker_requests,
        committed_d1_rows_read,
        released_d1_rows_read
      FROM usage_reservations
      WHERE reservation_id = ?1`,
    )
      .bind(`${request.requestId}:route`)
      .first<{
        state: string;
        committed_worker_requests: number;
        committed_d1_rows_read: number;
        released_d1_rows_read: number;
      }>();

    expect(route).toMatchObject({
      state: 'committed',
      committed_worker_requests: 1,
      committed_d1_rows_read: 0,
      released_d1_rows_read: 8_192,
    });

    const requestReservationCount = await env.MIRNA_SYNC_DB.prepare(
      `SELECT COUNT(*)
        FROM usage_reservations
        WHERE reservation_id = ?1`,
    )
      .bind(`${request.requestId}:request`)
      .first<number>('COUNT(*)');

    expect(requestReservationCount).toBe(0);
  });

  it('retains the conservative reservation when exact provider metadata is unavailable', async () => {
    const configured = new UsageBudgetController();
    const request = context('/v1/operations', 'POST');
    await configured.reserveRoute(request);
    const meter = new RouteUsageMeter();
    request.usageMeter = meter;
    request.env = meter.wrapEnvironment(env);
    await request.env.MIRNA_SYNC_DB.prepare('SELECT vault_id FROM vaults LIMIT 1').raw();

    await configured.settle(request);

    expect(
      await env.MIRNA_SYNC_DB.prepare(
        `SELECT measurement_exact, committed_d1_rows_read, reserved_d1_rows_read,
                settlement_failure_code
           FROM usage_reservations WHERE reservation_id = ?1`,
      )
        .bind(`${request.requestId}:route`)
        .first(),
    ).toEqual({
      measurement_exact: 0,
      committed_d1_rows_read: 8_192,
      reserved_d1_rows_read: 8_192,
      settlement_failure_code: null,
    });
  });

  it('keeps a crashed reservation conservative and requires explicit reconciliation', async () => {
    const start = Date.parse('2026-08-01T10:00:00.000Z');
    const configured = new UsageBudgetController(STAGING_BUDGETS, () => start);
    const request = context('/v1/operations', 'POST');
    await configured.reserveRoute(request);
    const reservationId = `${request.requestId}:route`;
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        'SELECT state FROM usage_reservations WHERE reservation_id = ?1',
      )
        .bind(reservationId)
        .first<string>('state'),
    ).toBe('reserved');

    await runBudgetWindowMaintenance(env, start + 60 * 60 * 1_000 + 1);
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        `SELECT state, committed_d1_rows_read, settlement_failure_code
           FROM usage_reservations WHERE reservation_id = ?1`,
      )
        .bind(reservationId)
        .first<{
          state: string;
          committed_d1_rows_read: number;
          settlement_failure_code: string;
        }>(),
    ).toEqual({
      state: 'reserved',
      committed_d1_rows_read: 0,
      settlement_failure_code: 'STALE_RESERVATION_REQUIRES_RECONCILIATION',
    });
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        'SELECT accounting_fault FROM service_flags WHERE singleton_id = 1',
      ).first<number>('accounting_fault'),
    ).toBe(1);
    await env.MIRNA_SYNC_DB.batch([
      env.MIRNA_SYNC_DB.prepare(
        `UPDATE usage_reservations
            SET state = 'committed', committed_d1_rows_read = reserved_d1_rows_read,
                committed_d1_rows_written = reserved_d1_rows_written, settled_at = ?2
          WHERE reservation_id = ?1`,
      ).bind(reservationId, start + 60 * 60 * 1_000 + 2),
      env.MIRNA_SYNC_DB.prepare(
        `UPDATE service_flags
            SET accounting_fault = 0, state_reason = 'NONE', state_request_id = NULL,
                accounting_fault_at = NULL
          WHERE singleton_id = 1`,
      ),
    ]);
  });

  it('expires only buckets outside the maintained rolling window after delayed cleanup', async () => {
    const scheduled = Date.parse('2026-08-01T12:00:00.000Z');
    const scopeId = opaqueId(91);
    await env.MIRNA_SYNC_DB.batch([
      env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO usage_daily_buckets (
           scope_type, scope_id, utc_day, worker_requests, updated_at
         ) VALUES ('vault', ?1, '2026-07-02', 7, ?2)`,
      ).bind(scopeId, scheduled),
      env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO usage_rolling_totals (
           scope_type, scope_id, worker_requests, refreshed_at
         ) VALUES ('vault', ?1, 7, ?2)`,
      ).bind(scopeId, scheduled),
    ]);

    await runBudgetWindowMaintenance(env, scheduled);
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        `SELECT worker_requests FROM usage_rolling_totals
          WHERE scope_type = 'vault' AND scope_id = ?1`,
      )
        .bind(scopeId)
        .first<number>('worker_requests'),
    ).toBe(0);
  });

  it('rejects negative and overflowing persisted counters', async () => {
    const scopeId = opaqueId(92);
    await expect(
      env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO usage_rolling_totals (
           scope_type, scope_id, worker_requests, refreshed_at
         ) VALUES ('vault', ?1, -1, 1)`,
      )
        .bind(scopeId)
        .run(),
    ).rejects.toThrow();
    expect(Number.isSafeInteger(STAGING_BUDGETS.global.d1RowsRead)).toBe(true);
    expect(STAGING_BUDGETS.global.d1RowsRead).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('enforces a per-vault rolling request quota independently of the global service', async () => {
    const configured = new UsageBudgetController(tinyBudgets({ vaultWorkerRequests: 1 }));
    const first = context('/v1/vault/manifest');
    await configured.reserveVault(first, SEEDED_VAULT_ID);
    await configured.settle(first);

    const second = context('/v1/vault/manifest');
    await expect(configured.reserveVault(second, SEEDED_VAULT_ID)).rejects.toMatchObject({
      status: 429,
      code: 'VAULT_QUOTA_EXCEEDED',
    });
  });

  it('fails writes closed when an operator kill switch is active', async () => {
    await env.MIRNA_SYNC_DB.prepare(
      `UPDATE service_flags SET accept_writes = 0, updated_at = ?1 WHERE singleton_id = 1`,
    )
      .bind(Date.now())
      .run();
    const configured = new UsageBudgetController();
    await expect(configured.reserveRoute(context('/v1/operations', 'POST'))).rejects.toMatchObject({
      status: 503,
      code: 'SERVICE_MAINTENANCE',
    });
    await env.MIRNA_SYNC_DB.prepare(
      `UPDATE service_flags SET accept_writes = 1, updated_at = ?1 WHERE singleton_id = 1`,
    )
      .bind(Date.now())
      .run();
  });

  it('maps a D1 reservation constraint without exposing SQL values', async () => {
    const database = {
      prepare: vi.fn(() => ({ bind: vi.fn().mockReturnThis() })),
      batch: vi.fn().mockRejectedValue(new Error('D1_ERROR: CHECK constraint failed')),
    } as unknown as D1Database;
    const accountingEnv = Object.create(env) as typeof env;
    Object.defineProperty(accountingEnv, 'MIRNA_SYNC_DB', { value: database });
    const request = context('/v1/vaults', 'POST');
    request.accountingEnv = accountingEnv;

    await expect(new UsageBudgetController().reserveRoute(request)).rejects.toMatchObject({
      code: 'USAGE_ACCOUNTING_UNAVAILABLE',
      accounting: { reason: 'RESERVATION_CONSTRAINT_FAILED', businessCommitted: false },
    });
  });

  it.each([
    ['RESERVATION_RESULT_EMPTY', []],
    [
      'RESERVATION_METADATA_INVALID',
      [{ meta: { changes: 0 } }, { meta: { changes: 0 } }, { meta: {} }],
    ],
  ])('fails closed with %s for malformed D1 batch results', async (reason, results) => {
    const database = {
      prepare: vi.fn(() => ({ bind: vi.fn().mockReturnThis() })),
      batch: vi.fn().mockResolvedValue(results),
    } as unknown as D1Database;
    const accountingEnv = Object.create(env) as typeof env;
    Object.defineProperty(accountingEnv, 'MIRNA_SYNC_DB', { value: database });
    const request = context('/v1/vaults', 'POST');
    request.accountingEnv = accountingEnv;

    await expect(new UsageBudgetController().reserveRoute(request)).rejects.toMatchObject({
      code: 'USAGE_ACCOUNTING_UNAVAILABLE',
      accounting: { reason },
    });
  });

  it('reports missing required accounting singleton rows and restores deterministic seeds', async () => {
    const configured = new UsageBudgetController();
    try {
      await env.MIRNA_SYNC_DB.prepare('DELETE FROM service_flags WHERE singleton_id = 1').run();
      await expect(
        configured.reserveRoute(context('/v1/operations', 'POST')),
      ).rejects.toMatchObject({
        accounting: { reason: 'REQUIRED_ACCOUNTING_ROW_MISSING' },
      });
    } finally {
      await env.MIRNA_SYNC_DB.prepare(
        `INSERT OR IGNORE INTO service_flags (
           singleton_id, accept_new_vaults, accept_pairings, accept_writes,
           maintenance_mode, updated_at
         ) VALUES (1, 1, 1, 1, 0, ?1)`,
      )
        .bind(Date.now())
        .run();
    }

    try {
      await env.MIRNA_SYNC_DB.prepare('DELETE FROM resource_totals WHERE singleton_id = 1').run();
      await expect(
        configured.reserveRoute(context('/v1/operations', 'POST')),
      ).rejects.toMatchObject({
        accounting: { reason: 'REQUIRED_ACCOUNTING_ROW_MISSING' },
      });
    } finally {
      await env.MIRNA_SYNC_DB.prepare(
        `INSERT OR IGNORE INTO resource_totals (
           singleton_id, r2_stored_bytes, r2_object_count, d1_storage_bytes, updated_at
         ) VALUES (1, 0, 0, 0, ?1)`,
      )
        .bind(Date.now())
        .run();
    }
  });

  it('initializes missing current daily and global rolling rows before reserving', async () => {
    const now = Date.parse('2026-08-02T12:00:00.000Z');
    await env.MIRNA_SYNC_DB.batch([
      env.MIRNA_SYNC_DB.prepare(
        `DELETE FROM usage_daily_buckets
          WHERE scope_type = 'global' AND scope_id = 'service' AND utc_day = '2026-08-02'`,
      ),
      env.MIRNA_SYNC_DB.prepare(
        `DELETE FROM usage_rolling_totals
          WHERE scope_type = 'global' AND scope_id = 'service'`,
      ),
    ]);
    const request = context('/v1/auth/challenge', 'POST');
    const configured = new UsageBudgetController(STAGING_BUDGETS, () => now);

    await configured.reserveRoute(request);
    await configured.settle(request);
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM usage_daily_buckets
             WHERE scope_type = 'global' AND scope_id = 'service' AND utc_day = '2026-08-02') AS daily,
           (SELECT COUNT(*) FROM usage_rolling_totals
             WHERE scope_type = 'global' AND scope_id = 'service') AS rolling`,
      ).first(),
    ).toEqual({ daily: 1, rolling: 1 });
  });

  it('persists exact underestimation evidence without pretending the provider quota is exhausted', async () => {
    const now = Date.parse('2026-08-01T15:00:00.000Z');
    const configured = new UsageBudgetController(STAGING_BUDGETS, () => now, {
      'vault-create': {
        workerRequests: 0,
        d1RowsRead: 0,
        d1RowsWritten: 0,
        r2ClassA: 0,
        r2ClassB: 0,
      },
    });
    const request = context('/v1/vaults', 'POST');
    await configured.reserveRoute(request);
    const meter = new RouteUsageMeter();
    request.usageMeter = meter;
    request.env = meter.wrapEnvironment(env);
    request.businessCommit = { kind: 'vault-create', committed: true, reconciled: false };
    await request.env.MIRNA_SYNC_DB.prepare('SELECT vault_id FROM vaults LIMIT 1').all();

    await expect(configured.settle(request)).rejects.toMatchObject({
      code: 'USAGE_RESERVATION_UNDERESTIMATED',
      accounting: {
        businessCommitted: true,
        serviceFlagsChanged: true,
      },
    });
    const reservation = await env.MIRNA_SYNC_DB.prepare(
      `SELECT state, measurement_exact, measured_d1_rows_read,
              settlement_failure_code, business_committed
         FROM usage_reservations WHERE reservation_id = ?1`,
    )
      .bind(`${request.requestId}:route`)
      .first<Record<string, number | string>>();
    expect(reservation).toMatchObject({
      state: 'committed',
      measurement_exact: 1,
      settlement_failure_code: 'USAGE_RESERVATION_UNDERESTIMATED',
      business_committed: 1,
    });
    expect(Number(reservation?.measured_d1_rows_read)).toBeGreaterThan(0);
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        `SELECT accounting_fault, maintenance_mode, accept_writes, state_request_id
           FROM service_flags WHERE singleton_id = 1`,
      ).first<Record<string, number | string>>(),
    ).toEqual({
      accounting_fault: 1,
      maintenance_mode: 0,
      accept_writes: 1,
      state_request_id: request.requestId,
    });

    const laterController = new UsageBudgetController(STAGING_BUDGETS, () => now + 1, {
      'pairing-create': {
        workerRequests: 0,
        d1RowsRead: 0,
        d1RowsWritten: 0,
        r2ClassA: 0,
        r2ClassB: 0,
      },
    });
    const later = context('/v1/pairings', 'POST');
    await laterController.reserveRoute(later);
    const laterMeter = new RouteUsageMeter();
    later.usageMeter = laterMeter;
    later.env = laterMeter.wrapEnvironment(env);
    later.businessCommit = { kind: 'pairing-create', committed: true, reconciled: false };
    await later.env.MIRNA_SYNC_DB.prepare('SELECT vault_id FROM vaults LIMIT 1').all();
    await expect(laterController.settle(later)).rejects.toMatchObject({
      accounting: { serviceFlagsChanged: false },
    });
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        'SELECT state_request_id FROM service_flags WHERE singleton_id = 1',
      ).first<string>('state_request_id'),
    ).toBe(request.requestId);
    await env.MIRNA_SYNC_DB.prepare(
      `UPDATE service_flags
          SET accounting_fault = 0, state_reason = 'NONE', state_request_id = NULL,
              accounting_fault_at = NULL
        WHERE singleton_id = 1`,
    ).run();
  });

  it('reserves temporary R2 bytes once, rejects the next vault object, and releases exactly once', async () => {
    const budgets = tinyBudgets({ globalObjects: 100, vaultObjects: 1 });
    const firstKey = `v1/${SEEDED_VAULT_ID}/snapshots/one/hash`;
    const secondKey = `v1/${SEEDED_VAULT_ID}/snapshots/two/hash`;
    expect(
      await reserveR2Object(
        env,
        {
          objectKey: firstKey,
          vaultId: SEEDED_VAULT_ID,
          objectType: 'snapshot',
          ciphertextBytes: 8,
        },
        budgets,
      ),
    ).toBe(true);
    expect(
      await reserveR2Object(
        env,
        {
          objectKey: firstKey,
          vaultId: SEEDED_VAULT_ID,
          objectType: 'snapshot',
          ciphertextBytes: 8,
        },
        budgets,
      ),
    ).toBe(false);
    await expect(
      reserveR2Object(
        env,
        {
          objectKey: secondKey,
          vaultId: SEEDED_VAULT_ID,
          objectType: 'snapshot',
          ciphertextBytes: 8,
        },
        budgets,
      ),
    ).rejects.toMatchObject({ status: 429, code: 'VAULT_QUOTA_EXCEEDED' });

    await releaseR2Object(env, firstKey);
    await releaseR2Object(env, firstKey);
    await expect(
      reserveR2Object(
        env,
        {
          objectKey: secondKey,
          vaultId: SEEDED_VAULT_ID,
          objectType: 'snapshot',
          ciphertextBytes: 8,
        },
        budgets,
      ),
    ).resolves.toBe(true);
  });
});
