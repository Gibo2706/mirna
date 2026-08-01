import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
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
    const first = context();
    const second = context();
    const attemptedOverride = env as typeof env & { MIRNA_MAX_WORKER_REQUESTS?: string };
    attemptedOverride.MIRNA_MAX_WORKER_REQUESTS = '999999999';

    const results = await Promise.allSettled([
      configured.reserveRequest(first),
      configured.reserveRequest(second),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? code(rejected.reason) : undefined).toBe(
      'SERVICE_BUDGET_EXHAUSTED',
    );
  });

  it('releases an unused failed-route reservation while retaining ledger overhead', async () => {
    const configured = new UsageBudgetController();
    const request = context('/v1/operations', 'POST');
    await configured.reserveRequest(request);
    await configured.reserveRoute(request);
    const meter = new RouteUsageMeter();
    request.usageMeter = meter;
    request.env = meter.wrapEnvironment(env);

    await configured.settle(request);

    const route = await env.MIRNA_SYNC_DB.prepare(
      `SELECT state, committed_d1_rows_read, released_d1_rows_read
         FROM usage_reservations WHERE reservation_id = ?1`,
    )
      .bind(`${request.requestId}:route`)
      .first<{
        state: string;
        committed_d1_rows_read: number;
        released_d1_rows_read: number;
      }>();
    const overhead = await env.MIRNA_SYNC_DB.prepare(
      `SELECT state, committed_worker_requests
         FROM usage_reservations WHERE reservation_id = ?1`,
    )
      .bind(`${request.requestId}:request`)
      .first<{ state: string; committed_worker_requests: number }>();
    expect(route).toMatchObject({
      state: 'released',
      committed_d1_rows_read: 0,
      released_d1_rows_read: 8_192,
    });
    expect(overhead).toEqual({ state: 'committed', committed_worker_requests: 1 });
  });

  it('keeps a crashed reservation conservative and recovers it after expiry', async () => {
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
        `SELECT state, committed_d1_rows_read
           FROM usage_reservations WHERE reservation_id = ?1`,
      )
        .bind(reservationId)
        .first<{ state: string; committed_d1_rows_read: number }>(),
    ).toEqual({ state: 'committed', committed_d1_rows_read: 8_192 });
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
      code: 'SERVICE_BUDGET_EXHAUSTED',
    });
    await env.MIRNA_SYNC_DB.prepare(
      `UPDATE service_flags SET accept_writes = 1, updated_at = ?1 WHERE singleton_id = 1`,
    )
      .bind(Date.now())
      .run();
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
