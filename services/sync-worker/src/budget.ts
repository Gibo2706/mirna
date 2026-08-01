import type { StagingBudgets, MeteredUsage, UsageCeilings } from './config/staging-budgets';
import { STAGING_BUDGETS, ZERO_USAGE } from './config/staging-budgets';
import type { RequestContext } from './context';
import type { Env } from './env';
import { HttpError } from './errors';

export type BudgetAccess = 'read' | 'write' | 'new-vault' | 'pairing';
export type R2Operation = 'put' | 'list' | 'copy' | 'get' | 'head' | 'delete';
export type R2OperationClass = 'A' | 'B' | 'free';

export const classifyR2Operation = (operation: R2Operation): R2OperationClass => {
  switch (operation) {
    case 'put':
    case 'list':
    case 'copy':
      return 'A';
    case 'get':
    case 'head':
      return 'B';
    case 'delete':
      return 'free';
  }
};

interface RouteBudget {
  readonly key: string;
  readonly access: BudgetAccess;
  readonly usage: MeteredUsage;
}

interface DailyUsageRow extends MeteredUsage {
  readonly scope_type: 'global' | 'vault';
  readonly scope_id: string;
  readonly utc_day: string;
}

interface ReservationRow {
  readonly reservation_id: string;
  readonly scope_type: 'global' | 'vault';
  readonly scope_id: string;
  readonly created_at: number;
  readonly reserved_worker_requests: number;
  readonly reserved_d1_rows_read: number;
  readonly reserved_d1_rows_written: number;
  readonly reserved_r2_class_a: number;
  readonly reserved_r2_class_b: number;
}

const MAX_SQL_INTEGER = 9_007_199_254_740_991;
const LEDGER_OVERHEAD: MeteredUsage = Object.freeze({
  workerRequests: 1,
  d1RowsRead: 128,
  d1RowsWritten: 32,
  r2ClassA: 0,
  r2ClassB: 0,
});
const SCHEDULED_CLEANUP_USAGE: MeteredUsage = Object.freeze({
  workerRequests: 0,
  d1RowsRead: 100_000,
  d1RowsWritten: 20_000,
  r2ClassA: 7,
  r2ClassB: 0,
});

const usage = (
  d1RowsRead: number,
  d1RowsWritten: number,
  r2ClassA = 0,
  r2ClassB = 0,
): MeteredUsage => ({ workerRequests: 0, d1RowsRead, d1RowsWritten, r2ClassA, r2ClassB });

const routeBudget = (request: Request): RouteBudget => {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (method === 'OPTIONS') return { key: 'preflight', access: 'read', usage: ZERO_USAGE };
  if (path === '/v1/health') return { key: 'health', access: 'read', usage: usage(4, 0, 0, 1) };
  if (method === 'POST' && path === '/v1/vaults') {
    return { key: 'vault-create', access: 'new-vault', usage: usage(96, 24) };
  }
  if (method === 'POST' && path === '/v1/pairings') {
    return { key: 'pairing-create', access: 'pairing', usage: usage(48, 8) };
  }
  if (path.startsWith('/v1/pairings/')) {
    return { key: 'pairing-action', access: 'pairing', usage: usage(160, 36) };
  }
  if (path === '/v1/recovery/challenge') {
    return { key: 'recovery-init', access: 'write', usage: usage(64, 12) };
  }
  if (path.includes('/recover') || path.startsWith('/v1/recovery/')) {
    return { key: 'recovery-action', access: 'write', usage: usage(240, 64, 0, 1) };
  }
  if (/^\/v1\/devices\/[A-Za-z0-9_-]{22}\/(?:renew|revoke)$/u.test(path)) {
    return { key: 'device-security', access: 'write', usage: usage(4_096, 512) };
  }
  if (method === 'POST' && path === '/v1/acks') {
    // One acknowledgement may compact the full 5,000-operation vault window.
    return { key: 'sync-ack', access: 'write', usage: usage(8_192, 5_128) };
  }
  if (method === 'POST' && path === '/v1/operations') {
    // The indexed sequence/count check is bounded by the 5,000-operation cap.
    return { key: 'operation-upload', access: 'write', usage: usage(8_192, 64) };
  }
  if (method === 'PUT' && path.startsWith('/v1/snapshots/')) {
    return { key: 'snapshot-upload', access: 'write', usage: usage(192, 48, 1, 1) };
  }
  if (method === 'GET' && path === '/v1/snapshots/current') {
    return { key: 'snapshot-download', access: 'read', usage: usage(64, 4, 0, 1) };
  }
  if (method === 'DELETE' && path === '/v1/vault') {
    // A vault can contain at most 2,000 objects, so 1,000-key pages require at
    // most two Class A ListObjects calls before the free DeleteObject calls.
    return { key: 'vault-delete', access: 'write', usage: usage(1_024, 256, 2) };
  }
  if (method === 'GET') return { key: 'sync-read', access: 'read', usage: usage(96, 4) };
  if (path === '/v1/auth/challenge' || path === '/v1/auth/session') {
    return { key: 'device-auth', access: 'write', usage: usage(72, 16) };
  }
  return { key: 'sync-write', access: 'write', usage: usage(192, 48) };
};

const utcDay = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10);

const dailyLimit = (ceilings: UsageCeilings, key: keyof MeteredUsage): number => {
  switch (key) {
    case 'workerRequests':
      return ceilings.workerRequestsPerUtcDay ?? MAX_SQL_INTEGER;
    case 'd1RowsRead':
      return ceilings.d1RowsReadPerUtcDay ?? MAX_SQL_INTEGER;
    case 'd1RowsWritten':
      return ceilings.d1RowsWrittenPerUtcDay ?? MAX_SQL_INTEGER;
    case 'r2ClassA':
      return ceilings.r2ClassAPerUtcDay ?? MAX_SQL_INTEGER;
    case 'r2ClassB':
      return ceilings.r2ClassBPerUtcDay ?? MAX_SQL_INTEGER;
  }
};

const flagCondition = (access: BudgetAccess): string => {
  switch (access) {
    case 'read':
      return '1 = 1';
    case 'write':
      return 'f.maintenance_mode = 0 AND f.accept_writes = 1';
    case 'new-vault':
      return 'f.maintenance_mode = 0 AND f.accept_writes = 1 AND f.accept_new_vaults = 1';
    case 'pairing':
      return 'f.maintenance_mode = 0 AND f.accept_writes = 1 AND f.accept_pairings = 1';
  }
};

const classifyReservationFailure = async (
  env: Env,
  scopeType: 'global' | 'vault',
  access: BudgetAccess,
  budgets: StagingBudgets,
): Promise<HttpError> => {
  try {
    const state = await env.MIRNA_SYNC_DB.prepare(
      `SELECT accept_new_vaults, accept_pairings, accept_writes, maintenance_mode
         FROM service_flags WHERE singleton_id = 1`,
    ).first<{
      accept_new_vaults: number;
      accept_pairings: number;
      accept_writes: number;
      maintenance_mode: number;
    }>();
    const disabled =
      !state ||
      (access !== 'read' && (state.maintenance_mode !== 0 || state.accept_writes !== 1)) ||
      (access === 'new-vault' && state.accept_new_vaults !== 1) ||
      (access === 'pairing' && state.accept_pairings !== 1);
    if (disabled) {
      return new HttpError(
        503,
        'SERVICE_BUDGET_EXHAUSTED',
        'Staging synchronization is temporarily paused.',
      );
    }
    const d1Bytes = await env.MIRNA_SYNC_DB.prepare(
      'SELECT d1_storage_bytes FROM resource_totals WHERE singleton_id = 1',
    ).first<number>('d1_storage_bytes');
    if (
      access !== 'read' &&
      (d1Bytes ?? budgets.resources.d1StorageBytes) >= budgets.resources.d1StorageBytes
    ) {
      return new HttpError(
        503,
        'SERVICE_BUDGET_EXHAUSTED',
        'Staging synchronization is temporarily paused.',
      );
    }
  } catch {
    return new HttpError(
      503,
      'SERVICE_BUDGET_EXHAUSTED',
      'Staging synchronization is temporarily paused.',
    );
  }
  return scopeType === 'vault'
    ? new HttpError(429, 'VAULT_QUOTA_EXCEEDED', 'Vault staging quota is exhausted.')
    : new HttpError(
        503,
        'SERVICE_BUDGET_EXHAUSTED',
        'Staging synchronization is temporarily paused.',
      );
};

const reserve = async (
  context: RequestContext,
  input: {
    readonly suffix: string;
    readonly scopeType: 'global' | 'vault';
    readonly scopeId: string;
    readonly routeKey: string;
    readonly access: BudgetAccess;
    readonly usage: MeteredUsage;
  },
  budgets: StagingBudgets,
  now: number,
): Promise<void> => {
  const reservationId = `${context.requestId}:${input.suffix}`;
  const reservationIds = (context.budgetReservationIds ??= []);
  if (reservationIds.includes(reservationId)) return;
  const day = utcDay(now);
  const ceilings = input.scopeType === 'global' ? budgets.global : budgets.perVault;
  let results: D1Result<unknown>[];
  try {
    results = await context.env.MIRNA_SYNC_DB.batch([
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO usage_daily_buckets (scope_type, scope_id, utc_day, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (scope_type, scope_id, utc_day) DO NOTHING`,
      ).bind(input.scopeType, input.scopeId, day, now),
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO usage_rolling_totals (scope_type, scope_id, refreshed_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT (scope_type, scope_id) DO NOTHING`,
      ).bind(input.scopeType, input.scopeId, now),
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO usage_reservations (
           reservation_id, scope_type, scope_id, route_key, state,
           reserved_worker_requests, reserved_d1_rows_read, reserved_d1_rows_written,
           reserved_r2_class_a, reserved_r2_class_b, created_at, settled_at
         )
         SELECT ?1, ?2, ?3, ?4, 'reserved', ?6, ?7, ?8, ?9, ?10, ?5, NULL
           FROM usage_daily_buckets d
           JOIN usage_rolling_totals r
             ON r.scope_type = d.scope_type AND r.scope_id = d.scope_id
           JOIN service_flags f ON f.singleton_id = 1
           JOIN resource_totals resources ON resources.singleton_id = 1
          WHERE d.scope_type = ?2 AND d.scope_id = ?3 AND d.utc_day = ?11
            AND ${flagCondition(input.access)}
            AND (?23 = 'read' OR resources.d1_storage_bytes < ?22)
            AND r.worker_requests + ?6 <= ?12
            AND r.d1_rows_read + ?7 <= ?13
            AND r.d1_rows_written + ?8 <= ?14
            AND r.r2_class_a + ?9 <= ?15
            AND r.r2_class_b + ?10 <= ?16
            AND d.worker_requests + ?6 <= ?17
            AND d.d1_rows_read + ?7 <= ?18
            AND d.d1_rows_written + ?8 <= ?19
            AND d.r2_class_a + ?9 <= ?20
            AND d.r2_class_b + ?10 <= ?21`,
      ).bind(
        reservationId,
        input.scopeType,
        input.scopeId,
        input.routeKey,
        now,
        input.usage.workerRequests,
        input.usage.d1RowsRead,
        input.usage.d1RowsWritten,
        input.usage.r2ClassA,
        input.usage.r2ClassB,
        day,
        ceilings.workerRequests,
        ceilings.d1RowsRead,
        ceilings.d1RowsWritten,
        ceilings.r2ClassA,
        ceilings.r2ClassB,
        dailyLimit(ceilings, 'workerRequests'),
        dailyLimit(ceilings, 'd1RowsRead'),
        dailyLimit(ceilings, 'd1RowsWritten'),
        dailyLimit(ceilings, 'r2ClassA'),
        dailyLimit(ceilings, 'r2ClassB'),
        budgets.resources.d1StorageBytes,
        input.access,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE usage_daily_buckets
            SET worker_requests = worker_requests + ?5,
                d1_rows_read = d1_rows_read + ?6,
                d1_rows_written = d1_rows_written + ?7,
                r2_class_a = r2_class_a + ?8,
                r2_class_b = r2_class_b + ?9,
                updated_at = ?4
          WHERE scope_type = ?1 AND scope_id = ?2 AND utc_day = ?3
            AND EXISTS (SELECT 1 FROM usage_reservations WHERE reservation_id = ?10)`,
      ).bind(
        input.scopeType,
        input.scopeId,
        day,
        now,
        input.usage.workerRequests,
        input.usage.d1RowsRead,
        input.usage.d1RowsWritten,
        input.usage.r2ClassA,
        input.usage.r2ClassB,
        reservationId,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE usage_rolling_totals
            SET worker_requests = worker_requests + ?4,
                d1_rows_read = d1_rows_read + ?5,
                d1_rows_written = d1_rows_written + ?6,
                r2_class_a = r2_class_a + ?7,
                r2_class_b = r2_class_b + ?8,
                refreshed_at = ?3
          WHERE scope_type = ?1 AND scope_id = ?2
            AND EXISTS (SELECT 1 FROM usage_reservations WHERE reservation_id = ?9)`,
      ).bind(
        input.scopeType,
        input.scopeId,
        now,
        input.usage.workerRequests,
        input.usage.d1RowsRead,
        input.usage.d1RowsWritten,
        input.usage.r2ClassA,
        input.usage.r2ClassB,
        reservationId,
      ),
    ]);
  } catch {
    throw new HttpError(
      503,
      'SERVICE_BUDGET_EXHAUSTED',
      'Staging usage accounting is unavailable.',
    );
  }
  if (results[2]?.meta.changes !== 1) {
    throw await classifyReservationFailure(context.env, input.scopeType, input.access, budgets);
  }
  reservationIds.push(reservationId);
};

export class UsageBudgetController {
  constructor(
    private readonly budgets: StagingBudgets = STAGING_BUDGETS,
    private readonly now: () => number = Date.now,
  ) {}

  async reserveRequest(context: RequestContext): Promise<void> {
    await reserve(
      context,
      {
        suffix: 'request',
        scopeType: 'global',
        scopeId: 'service',
        routeKey: 'request-ledger-overhead',
        access: 'read',
        usage: LEDGER_OVERHEAD,
      },
      this.budgets,
      this.now(),
    );
  }

  async reserveRoute(context: RequestContext): Promise<void> {
    const route = routeBudget(context.request);
    if (route.usage === ZERO_USAGE) return;
    await reserve(
      context,
      {
        suffix: 'route',
        scopeType: 'global',
        scopeId: 'service',
        routeKey: route.key,
        access: route.access,
        usage: route.usage,
      },
      this.budgets,
      this.now(),
    );
  }

  async reserveScheduledCleanup(context: RequestContext): Promise<void> {
    await reserve(
      context,
      {
        suffix: 'scheduled-cleanup',
        scopeType: 'global',
        scopeId: 'service',
        routeKey: 'scheduled-cleanup',
        access: 'write',
        usage: SCHEDULED_CLEANUP_USAGE,
      },
      this.budgets,
      this.now(),
    );
  }

  async reserveVault(context: RequestContext, vaultId: string): Promise<void> {
    const route = routeBudget(context.request);
    await reserve(
      context,
      {
        suffix: `vault-${vaultId}`,
        scopeType: 'vault',
        scopeId: vaultId,
        routeKey: route.key,
        access: route.access,
        usage: { ...route.usage, workerRequests: 1 },
      },
      this.budgets,
      this.now(),
    );
  }

  async settle(context: RequestContext): Promise<void> {
    const reservationIds = context.budgetReservationIds ?? [];
    if (reservationIds.length === 0) return;
    const now = this.now();
    try {
      const observed = context.usageMeter?.snapshot();
      if (observed && observed.sizeAfter > 0) {
        await observeD1Size(context.env, observed.sizeAfter, this.budgets);
      }
      const rows = await Promise.all(
        reservationIds.map((reservationId) =>
          context.env.MIRNA_SYNC_DB.prepare(
            `SELECT reservation_id, scope_type, scope_id, created_at,
                    reserved_worker_requests, reserved_d1_rows_read,
                    reserved_d1_rows_written, reserved_r2_class_a, reserved_r2_class_b
               FROM usage_reservations
              WHERE reservation_id = ?1 AND state = 'reserved'`,
          )
            .bind(reservationId)
            .first<ReservationRow>(),
        ),
      );
      if (rows.some((row) => row === null)) throw new Error('reservation disappeared');

      const statements: D1PreparedStatement[] = [];
      for (const row of rows as ReservationRow[]) {
        const isRequestOverhead = row.reservation_id.endsWith(':request');
        const isVault = row.scope_type === 'vault';
        const actual: MeteredUsage =
          isRequestOverhead || !observed?.exact
            ? {
                workerRequests: row.reserved_worker_requests,
                d1RowsRead: row.reserved_d1_rows_read,
                d1RowsWritten: row.reserved_d1_rows_written,
                r2ClassA: row.reserved_r2_class_a,
                r2ClassB: row.reserved_r2_class_b,
              }
            : {
                ...observed.usage,
                workerRequests: isVault ? 1 : 0,
              };
        const reserved: MeteredUsage = {
          workerRequests: row.reserved_worker_requests,
          d1RowsRead: row.reserved_d1_rows_read,
          d1RowsWritten: row.reserved_d1_rows_written,
          r2ClassA: row.reserved_r2_class_a,
          r2ClassB: row.reserved_r2_class_b,
        };
        const values = Object.keys(reserved) as (keyof MeteredUsage)[];
        if (values.some((key) => actual[key] > reserved[key] || actual[key] < 0)) {
          await context.env.MIRNA_SYNC_DB.prepare(
            `UPDATE service_flags
                SET accept_new_vaults = 0, accept_pairings = 0,
                    accept_writes = 0, maintenance_mode = 1, updated_at = ?1
              WHERE singleton_id = 1`,
          )
            .bind(now)
            .run();
          throw new Error('route exceeded its conservative reservation');
        }
        const released: MeteredUsage = {
          workerRequests: reserved.workerRequests - actual.workerRequests,
          d1RowsRead: reserved.d1RowsRead - actual.d1RowsRead,
          d1RowsWritten: reserved.d1RowsWritten - actual.d1RowsWritten,
          r2ClassA: reserved.r2ClassA - actual.r2ClassA,
          r2ClassB: reserved.r2ClassB - actual.r2ClassB,
        };
        const day = utcDay(row.created_at);
        statements.push(
          context.env.MIRNA_SYNC_DB.prepare(
            `UPDATE usage_daily_buckets
                SET worker_requests = worker_requests - ?4,
                    d1_rows_read = d1_rows_read - ?5,
                    d1_rows_written = d1_rows_written - ?6,
                    r2_class_a = r2_class_a - ?7,
                    r2_class_b = r2_class_b - ?8,
                    updated_at = ?9
              WHERE scope_type = ?1 AND scope_id = ?2 AND utc_day = ?3`,
          ).bind(
            row.scope_type,
            row.scope_id,
            day,
            released.workerRequests,
            released.d1RowsRead,
            released.d1RowsWritten,
            released.r2ClassA,
            released.r2ClassB,
            now,
          ),
          context.env.MIRNA_SYNC_DB.prepare(
            `UPDATE usage_rolling_totals
                SET worker_requests = worker_requests - ?3,
                    d1_rows_read = d1_rows_read - ?4,
                    d1_rows_written = d1_rows_written - ?5,
                    r2_class_a = r2_class_a - ?6,
                    r2_class_b = r2_class_b - ?7,
                    refreshed_at = ?8
              WHERE scope_type = ?1 AND scope_id = ?2`,
          ).bind(
            row.scope_type,
            row.scope_id,
            released.workerRequests,
            released.d1RowsRead,
            released.d1RowsWritten,
            released.r2ClassA,
            released.r2ClassB,
            now,
          ),
          context.env.MIRNA_SYNC_DB.prepare(
            `UPDATE usage_reservations
                SET state = CASE
                      WHEN ?3 + ?4 + ?5 + ?6 + ?7 = 0 THEN 'released'
                      ELSE 'committed'
                    END,
                    committed_worker_requests = ?3,
                    committed_d1_rows_read = ?4,
                    committed_d1_rows_written = ?5,
                    committed_r2_class_a = ?6,
                    committed_r2_class_b = ?7,
                    released_worker_requests = ?8,
                    released_d1_rows_read = ?9,
                    released_d1_rows_written = ?10,
                    released_r2_class_a = ?11,
                    released_r2_class_b = ?12,
                    settled_at = ?2
              WHERE reservation_id = ?1 AND state = 'reserved'`,
          ).bind(
            row.reservation_id,
            now,
            actual.workerRequests,
            actual.d1RowsRead,
            actual.d1RowsWritten,
            actual.r2ClassA,
            actual.r2ClassB,
            released.workerRequests,
            released.d1RowsRead,
            released.d1RowsWritten,
            released.r2ClassA,
            released.r2ClassB,
          ),
        );
      }
      const results = await context.env.MIRNA_SYNC_DB.batch(statements);
      if (results.some((result) => result.meta.changes !== 1)) throw new Error('settlement failed');
    } catch {
      throw new HttpError(
        503,
        'SERVICE_BUDGET_EXHAUSTED',
        'Staging usage accounting is unavailable.',
      );
    }
  }
}

export const usageBudget = new UsageBudgetController();

export const reserveVaultUsage = (context: RequestContext, vaultId: string): Promise<void> =>
  usageBudget.reserveVault(context, vaultId);

export const writesEnabled = async (env: Env): Promise<boolean> => {
  try {
    const row = await env.MIRNA_SYNC_DB.prepare(
      `SELECT accept_writes, maintenance_mode FROM service_flags WHERE singleton_id = 1`,
    ).first<{ accept_writes: number; maintenance_mode: number }>();
    return row?.accept_writes === 1 && row.maintenance_mode === 0;
  } catch {
    return false;
  }
};

const observeD1Size = async (
  env: Env,
  sizeAfter: number,
  budgets: StagingBudgets = STAGING_BUDGETS,
): Promise<void> => {
  await env.MIRNA_SYNC_DB.batch([
    env.MIRNA_SYNC_DB.prepare(
      `UPDATE resource_totals
          SET d1_storage_bytes = MAX(d1_storage_bytes, ?1), updated_at = ?2
        WHERE singleton_id = 1`,
    ).bind(sizeAfter, Date.now()),
    env.MIRNA_SYNC_DB.prepare(
      `UPDATE service_flags
          SET accept_new_vaults = 0, accept_writes = 0, updated_at = ?2
        WHERE singleton_id = 1 AND ?1 >= ?3`,
    ).bind(sizeAfter, Date.now(), budgets.resources.d1StorageBytes),
  ]);
};

export const observeD1Metadata = async (
  env: Env,
  results: readonly D1Result<unknown>[],
  budgets: StagingBudgets = STAGING_BUDGETS,
): Promise<void> => {
  const sizeAfter = results.reduce((largest, result) => {
    const value = result.meta.size_after;
    return typeof value === 'number' && Number.isSafeInteger(value)
      ? Math.max(largest, value)
      : largest;
  }, 0);
  if (sizeAfter === 0) return;
  await observeD1Size(env, sizeAfter, budgets);
};

interface InventoryRow {
  readonly vault_id: string;
  readonly object_type: 'snapshot';
  readonly state: 'temporary' | 'committed' | 'deletable';
  readonly ciphertext_bytes: number;
}

const inventoryRow = (env: Env, objectKey: string): Promise<InventoryRow | null> =>
  env.MIRNA_SYNC_DB.prepare(
    `SELECT vault_id, object_type, state, ciphertext_bytes
       FROM resource_inventory WHERE object_key = ?1`,
  )
    .bind(objectKey)
    .first<InventoryRow>();

export const reserveR2Object = async (
  env: Env,
  input: {
    readonly objectKey: string;
    readonly vaultId: string;
    readonly objectType: 'snapshot';
    readonly ciphertextBytes: number;
  },
  budgets: StagingBudgets = STAGING_BUDGETS,
  now = Date.now(),
): Promise<boolean> => {
  const existing = await inventoryRow(env, input.objectKey);
  if (existing) {
    if (
      existing.vault_id === input.vaultId &&
      existing.object_type === input.objectType &&
      existing.ciphertext_bytes === input.ciphertextBytes
    ) {
      return false;
    }
    throw new HttpError(409, 'SNAPSHOT_ID_REUSED', 'Snapshot storage identity was already used.');
  }
  const accountingId = crypto.randomUUID();
  let results: D1Result<unknown>[];
  try {
    results = await env.MIRNA_SYNC_DB.batch([
      env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO vault_resource_totals (vault_id, updated_at)
         VALUES (?1, ?2)
         ON CONFLICT (vault_id) DO NOTHING`,
      ).bind(input.vaultId, now),
      env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO resource_inventory (
           object_key, vault_id, object_type, state, ciphertext_bytes,
           created_at, updated_at, accounting_reservation_id
         )
         SELECT ?1, ?2, ?3, 'temporary', ?4, ?5, ?5, ?6
           FROM resource_totals g
           JOIN vault_resource_totals v ON v.vault_id = ?2
           JOIN service_flags f ON f.singleton_id = 1
          WHERE g.singleton_id = 1
            AND f.maintenance_mode = 0 AND f.accept_writes = 1
            AND g.r2_stored_bytes + ?4 <= ?7
            AND g.r2_object_count + 1 <= ?8
            AND v.r2_stored_bytes + ?4 <= ?9
            AND v.r2_object_count + 1 <= ?10`,
      ).bind(
        input.objectKey,
        input.vaultId,
        input.objectType,
        input.ciphertextBytes,
        now,
        accountingId,
        budgets.resources.r2StoredBytes,
        budgets.resources.r2ObjectCount,
        budgets.perVaultResources.r2StoredBytes,
        budgets.perVaultResources.r2ObjectCount,
      ),
      env.MIRNA_SYNC_DB.prepare(
        `UPDATE resource_totals
            SET r2_stored_bytes = r2_stored_bytes + ?1,
                r2_object_count = r2_object_count + 1,
                updated_at = ?2
          WHERE singleton_id = 1
            AND EXISTS (
              SELECT 1 FROM resource_inventory WHERE accounting_reservation_id = ?3
            )`,
      ).bind(input.ciphertextBytes, now, accountingId),
      env.MIRNA_SYNC_DB.prepare(
        `UPDATE vault_resource_totals
            SET r2_stored_bytes = r2_stored_bytes + ?2,
                r2_object_count = r2_object_count + 1,
                updated_at = ?3
          WHERE vault_id = ?1
            AND EXISTS (
              SELECT 1 FROM resource_inventory WHERE accounting_reservation_id = ?4
            )`,
      ).bind(input.vaultId, input.ciphertextBytes, now, accountingId),
    ]);
  } catch {
    throw new HttpError(
      503,
      'SERVICE_BUDGET_EXHAUSTED',
      'Staging storage accounting is unavailable.',
    );
  }
  if (results[1]?.meta.changes === 1) return true;
  const raced = await inventoryRow(env, input.objectKey);
  if (
    raced?.vault_id === input.vaultId &&
    raced.object_type === input.objectType &&
    raced.ciphertext_bytes === input.ciphertextBytes
  ) {
    return false;
  }
  const totals = await env.MIRNA_SYNC_DB.prepare(
    `SELECT g.r2_stored_bytes AS global_bytes, g.r2_object_count AS global_objects,
            v.r2_stored_bytes AS vault_bytes, v.r2_object_count AS vault_objects
       FROM resource_totals g
       JOIN vault_resource_totals v ON v.vault_id = ?1
      WHERE g.singleton_id = 1`,
  )
    .bind(input.vaultId)
    .first<{
      global_bytes: number;
      global_objects: number;
      vault_bytes: number;
      vault_objects: number;
    }>();
  if (
    !totals ||
    totals.global_bytes + input.ciphertextBytes > budgets.resources.r2StoredBytes ||
    totals.global_objects + 1 > budgets.resources.r2ObjectCount
  ) {
    throw new HttpError(
      503,
      'SERVICE_BUDGET_EXHAUSTED',
      'Staging synchronization is temporarily paused.',
    );
  }
  throw new HttpError(429, 'VAULT_QUOTA_EXCEEDED', 'Vault staging quota is exhausted.');
};

export const commitR2Object = async (env: Env, objectKey: string): Promise<void> => {
  const result = await env.MIRNA_SYNC_DB.prepare(
    `UPDATE resource_inventory
        SET state = 'committed', updated_at = ?2
      WHERE object_key = ?1 AND state = 'temporary'`,
  )
    .bind(objectKey, Date.now())
    .run();
  if (result.meta.changes !== 1) {
    const existing = await inventoryRow(env, objectKey);
    if (existing?.state !== 'committed') {
      throw new HttpError(
        503,
        'SERVICE_BUDGET_EXHAUSTED',
        'Staging storage accounting is unavailable.',
      );
    }
  }
};

export const releaseR2Object = async (env: Env, objectKey: string): Promise<void> => {
  const existing = await inventoryRow(env, objectKey);
  if (!existing) return;
  const releaseId = crypto.randomUUID();
  const results = await env.MIRNA_SYNC_DB.batch([
    env.MIRNA_SYNC_DB.prepare(
      `UPDATE resource_inventory
          SET state = 'deletable', accounting_reservation_id = ?2, updated_at = ?3
        WHERE object_key = ?1 AND state != 'deletable'`,
    ).bind(objectKey, releaseId, Date.now()),
    env.MIRNA_SYNC_DB.prepare(
      `UPDATE resource_totals
          SET r2_stored_bytes = MAX(0, r2_stored_bytes - ?1),
              r2_object_count = MAX(0, r2_object_count - 1),
              updated_at = ?2
        WHERE singleton_id = 1
          AND EXISTS (
            SELECT 1 FROM resource_inventory WHERE accounting_reservation_id = ?3
          )`,
    ).bind(existing.ciphertext_bytes, Date.now(), releaseId),
    env.MIRNA_SYNC_DB.prepare(
      `UPDATE vault_resource_totals
          SET r2_stored_bytes = MAX(0, r2_stored_bytes - ?2),
              r2_object_count = MAX(0, r2_object_count - 1),
              updated_at = ?3
        WHERE vault_id = ?1
          AND EXISTS (
            SELECT 1 FROM resource_inventory WHERE accounting_reservation_id = ?4
          )`,
    ).bind(existing.vault_id, existing.ciphertext_bytes, Date.now(), releaseId),
    env.MIRNA_SYNC_DB.prepare(
      'DELETE FROM resource_inventory WHERE object_key = ?1 AND accounting_reservation_id = ?2',
    ).bind(objectKey, releaseId),
  ]);
  if (results[0]?.meta.changes === 1 && results.some((result) => result.meta.changes !== 1)) {
    throw new HttpError(
      503,
      'SERVICE_BUDGET_EXHAUSTED',
      'Staging storage accounting is unavailable.',
    );
  }
};

export const releaseVaultR2Inventory = async (env: Env, vaultId: string): Promise<void> => {
  const totals = await env.MIRNA_SYNC_DB.prepare(
    `SELECT r2_stored_bytes, r2_object_count
       FROM vault_resource_totals WHERE vault_id = ?1`,
  )
    .bind(vaultId)
    .first<{ r2_stored_bytes: number; r2_object_count: number }>();
  if (!totals) return;
  const releaseId = crypto.randomUUID();
  const results = await env.MIRNA_SYNC_DB.batch([
    env.MIRNA_SYNC_DB.prepare(
      `UPDATE vault_resource_totals
          SET release_reservation_id = ?2, updated_at = ?3
        WHERE vault_id = ?1 AND release_reservation_id IS NULL`,
    ).bind(vaultId, releaseId, Date.now()),
    env.MIRNA_SYNC_DB.prepare(
      `UPDATE resource_totals
          SET r2_stored_bytes = MAX(0, r2_stored_bytes - ?1),
              r2_object_count = MAX(0, r2_object_count - ?2),
              updated_at = ?3
        WHERE singleton_id = 1
          AND EXISTS (
            SELECT 1 FROM vault_resource_totals WHERE release_reservation_id = ?4
          )`,
    ).bind(totals.r2_stored_bytes, totals.r2_object_count, Date.now(), releaseId),
    env.MIRNA_SYNC_DB.prepare(
      `DELETE FROM resource_inventory
        WHERE vault_id = ?1
          AND EXISTS (
            SELECT 1 FROM vault_resource_totals WHERE release_reservation_id = ?2
          )`,
    ).bind(vaultId, releaseId),
    env.MIRNA_SYNC_DB.prepare(
      'DELETE FROM vault_resource_totals WHERE vault_id = ?1 AND release_reservation_id = ?2',
    ).bind(vaultId, releaseId),
  ]);
  if (
    results[0]?.meta.changes === 1 &&
    (results[1]?.meta.changes !== 1 || results[3]?.meta.changes !== 1)
  ) {
    throw new HttpError(
      503,
      'SERVICE_BUDGET_EXHAUSTED',
      'Staging storage accounting is unavailable.',
    );
  }
};

export const runBudgetWindowMaintenance = async (
  env: Env,
  scheduledTime: number,
  budgets: StagingBudgets = STAGING_BUDGETS,
): Promise<number> => {
  const cutoff = new Date(scheduledTime);
  cutoff.setUTCDate(cutoff.getUTCDate() - (budgets.rollingWindowDays - 1));
  const cutoffDay = utcDay(cutoff.getTime());
  const expired = await env.MIRNA_SYNC_DB.prepare(
    `SELECT scope_type, scope_id, utc_day, worker_requests AS workerRequests,
            d1_rows_read AS d1RowsRead, d1_rows_written AS d1RowsWritten,
            r2_class_a AS r2ClassA, r2_class_b AS r2ClassB
       FROM usage_daily_buckets
      WHERE utc_day < ?1
      ORDER BY utc_day, scope_type, scope_id
      LIMIT 1000`,
  )
    .bind(cutoffDay)
    .all<DailyUsageRow>();
  if (expired.results.length > 0) {
    const statements: D1PreparedStatement[] = [];
    for (const row of expired.results) {
      statements.push(
        env.MIRNA_SYNC_DB.prepare(
          `UPDATE usage_rolling_totals
              SET worker_requests = MAX(0, worker_requests - ?3),
                  d1_rows_read = MAX(0, d1_rows_read - ?4),
                  d1_rows_written = MAX(0, d1_rows_written - ?5),
                  r2_class_a = MAX(0, r2_class_a - ?6),
                  r2_class_b = MAX(0, r2_class_b - ?7),
                  refreshed_at = ?8
            WHERE scope_type = ?1 AND scope_id = ?2`,
        ).bind(
          row.scope_type,
          row.scope_id,
          row.workerRequests,
          row.d1RowsRead,
          row.d1RowsWritten,
          row.r2ClassA,
          row.r2ClassB,
          scheduledTime,
        ),
        env.MIRNA_SYNC_DB.prepare(
          `DELETE FROM usage_daily_buckets
            WHERE scope_type = ?1 AND scope_id = ?2 AND utc_day = ?3`,
        ).bind(row.scope_type, row.scope_id, row.utc_day),
      );
    }
    await env.MIRNA_SYNC_DB.batch(statements);
  }
  await env.MIRNA_SYNC_DB.batch([
    env.MIRNA_SYNC_DB.prepare(
      `UPDATE usage_reservations
          SET state = 'committed',
              committed_worker_requests = reserved_worker_requests,
              committed_d1_rows_read = reserved_d1_rows_read,
              committed_d1_rows_written = reserved_d1_rows_written,
              committed_r2_class_a = reserved_r2_class_a,
              committed_r2_class_b = reserved_r2_class_b,
              settled_at = ?1
        WHERE state = 'reserved' AND created_at < ?2`,
    ).bind(scheduledTime, scheduledTime - 60 * 60 * 1_000),
    env.MIRNA_SYNC_DB.prepare(
      `DELETE FROM usage_reservations
        WHERE state IN ('committed', 'released') AND settled_at < ?1`,
    ).bind(scheduledTime - 45 * 24 * 60 * 60 * 1_000),
  ]);
  return expired.results.length;
};
