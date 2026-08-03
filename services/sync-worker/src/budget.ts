import type { StagingBudgets, MeteredUsage, UsageCeilings } from './config/staging-budgets';
import { STAGING_BUDGETS, ZERO_USAGE } from './config/staging-budgets';
import type { RequestContext } from './context';
import { recordBetaDiagnostic } from './diagnostics';
import type { Env } from './env';
import type { AccountingCategory, AccountingFailureDetails, AccountingReason } from './errors';
import { HttpError } from './errors';
import {
  API_ROUTE_REGISTRY,
  matchApiRequest,
  type ApiRouteDefinition,
  type ApiRouteId,
  type BudgetAccess,
} from './route-registry';

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

type RouteBudget = Pick<ApiRouteDefinition, 'access' | 'usage'> & {
  readonly key: ApiRouteId;
};

interface DailyUsageRow extends MeteredUsage {
  readonly scope_type: 'global' | 'vault';
  readonly scope_id: string;
  readonly utc_day: string;
}

interface ReservationRow {
  readonly reservation_id: string;
  readonly scope_type: 'global' | 'vault';
  readonly scope_id: string;
  readonly route_key: string;
  readonly created_at: number;
  readonly reserved_worker_requests: number;
  readonly reserved_d1_rows_read: number;
  readonly reserved_d1_rows_written: number;
  readonly reserved_r2_class_a: number;
  readonly reserved_r2_class_b: number;
}

const MAX_SQL_INTEGER = 9_007_199_254_740_991;

const usage = (
  d1RowsRead: number,
  d1RowsWritten: number,
  r2ClassA = 0,
  r2ClassB = 0,
): MeteredUsage => ({ workerRequests: 0, d1RowsRead, d1RowsWritten, r2ClassA, r2ClassB });

/**
 * The previous 512/32 estimate was disproved by the real Android genesis path.
 * This bound covers the five-row genesis batch, exact-retry lookup, two bounded
 * Turnstile diagnostics and a documented margin. A focused metering test keeps
 * the executable maximum below it.
 */
export const VAULT_CREATE_ROUTE_USAGE: MeteredUsage =
  API_ROUTE_REGISTRY.find(({ id }) => id === 'vault-create')?.usage ??
  Object.freeze(usage(2_048, 128));

export interface ScheduledCleanupEstimateInput {
  readonly expiredUsageBuckets: number;
  readonly inspectedRows: number;
  readonly ordinaryRows: number;
  readonly snapshotRows: number;
  readonly deletionRequests: number;
  readonly deletionRows: number;
  readonly reconcileR2: boolean;
}

/**
 * Reserves from the inspected bounded work set, not from every category's
 * maximum at once. The fixed base covers budget-window maintenance, the large
 * planning scan, optional deletion-resume lookups and R2 reconciliation cursor
 * checks; the per-item factors then cover bounded cleanup execution and the
 * remaining provider/index amplification. Settlement still records the exact
 * provider metadata and releases the margin.
 */
export const estimateScheduledCleanupUsage = (
  input: ScheduledCleanupEstimateInput,
): MeteredUsage => {
  for (const value of [
    input.expiredUsageBuckets,
    input.inspectedRows,
    input.ordinaryRows,
    input.snapshotRows,
    input.deletionRequests,
    input.deletionRows,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Scheduled cleanup estimate is invalid.');
    }
  }
  return Object.freeze(
    usage(
      1_024 +
        (input.reconcileR2 ? 2 : 0) +
        input.expiredUsageBuckets * 32 +
        input.inspectedRows * 4 +
        input.ordinaryRows * 32 +
        input.snapshotRows * 256 +
        input.deletionRequests * 512 +
        input.deletionRows * 16,
      128 +
        input.expiredUsageBuckets * 12 +
        input.ordinaryRows * 12 +
        input.snapshotRows * 64 +
        input.deletionRequests * 128 +
        input.deletionRows * 32,
      (input.reconcileR2 ? 1 : 0) + input.deletionRequests * 100,
    ),
  );
};

const routeBudget = (request: Request): RouteBudget => {
  const matched = matchApiRequest(request);
  if (!matched) throw new HttpError(404, 'ROUTE_NOT_FOUND', 'Route was not found.');
  return {
    key: matched.definition.id,
    access: matched.definition.access,
    usage: matched.definition.usage,
  };
};

export const budgetRouteKey = (request: Request): string =>
  matchApiRequest(request)?.definition.id ?? 'unmatched-route';

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
    case 'diagnostic':
      return '1 = 1';
    case 'write':
      return 'f.maintenance_mode = 0 AND f.accept_writes = 1 AND f.accounting_fault = 0';
    case 'new-vault':
      // Exact retries must reach the idempotent handler while an accounting
      // fault is active. The handler refuses a genuinely new vault afterward.
      return 'f.maintenance_mode = 0 AND f.accept_writes = 1 AND f.accept_new_vaults = 1';
    case 'pairing-retry':
      // Exact committed retries must reach the handler during reconciliation.
      // Each pairing handler asserts the flags again immediately before a new
      // business transition.
      return 'f.maintenance_mode = 0 AND f.accept_writes = 1 AND f.accept_pairings = 1';
  }
};

const safeBuild = (env: Env): string =>
  /^(?:[0-9a-f]{7,64}|local|replace-at-deploy)$/u.test(env.MIRNA_BUILD_COMMIT)
    ? env.MIRNA_BUILD_COMMIT
    : 'unknown';

const accountingDetails = (
  context: RequestContext,
  category: AccountingCategory,
  reason: AccountingReason,
  phase: AccountingFailureDetails['phase'],
  route: string,
  serviceFlagsChanged = false,
  faultContext: Partial<
    Pick<
      AccountingFailureDetails,
      'faultRole' | 'originRequestId' | 'originRoute' | 'businessWorkStarted'
    >
  > = {},
): AccountingFailureDetails => ({
  category,
  reason,
  phase,
  route,
  businessCommitted: context.businessCommit?.committed === true,
  serviceFlagsChanged,
  workerBuild: safeBuild(context.accountingEnv ?? context.env),
  faultRole: faultContext.faultRole ?? (serviceFlagsChanged ? 'origin' : 'none'),
  ...(faultContext.originRequestId ? { originRequestId: faultContext.originRequestId } : {}),
  ...(faultContext.originRoute ? { originRoute: faultContext.originRoute } : {}),
  lifecycleOperation: route,
  businessWorkStarted: faultContext.businessWorkStarted ?? phase === 'settlement',
});

const accountingError = (
  context: RequestContext,
  status: number,
  category: AccountingCategory,
  message: string,
  phase: AccountingFailureDetails['phase'],
  route: string,
  serviceFlagsChanged = false,
  reason: AccountingReason = 'RESERVATION_BATCH_FAILED',
  faultContext: Partial<
    Pick<
      AccountingFailureDetails,
      'faultRole' | 'originRequestId' | 'originRoute' | 'businessWorkStarted'
    >
  > = {},
): HttpError =>
  new HttpError(
    status,
    category,
    message,
    undefined,
    accountingDetails(context, category, reason, phase, route, serviceFlagsChanged, faultContext),
  );

const diagnosticErrorClass = (error: unknown): string => {
  if (!(error instanceof Error)) return 'UnknownError';
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name) ? error.name : 'Error';
};

const reservationFailureReason = (error: unknown): AccountingReason => {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('no such table') || message.includes('no such column')) {
    return 'SCHEMA_NOT_READY';
  }
  if (message.includes('constraint')) return 'RESERVATION_CONSTRAINT_FAILED';
  return 'RESERVATION_BATCH_FAILED';
};

const activeFaultReason = (stateReason: string): AccountingReason => {
  if (stateReason === 'USAGE_RESERVATION_UNDERESTIMATED') {
    return 'USAGE_RESERVATION_UNDERESTIMATED';
  }
  if (stateReason === 'USAGE_SETTLEMENT_FAILED') return 'USAGE_SETTLEMENT_FAILED';
  return 'ACCOUNTING_FAULT_ACTIVE';
};

const classifyReservationFailure = async (
  context: RequestContext,
  scopeType: 'global' | 'vault',
  access: BudgetAccess,
  budgets: StagingBudgets,
  phase: AccountingFailureDetails['phase'],
  route: string,
): Promise<HttpError> => {
  const env = context.accountingEnv ?? context.env;
  let state: {
    accept_new_vaults: number;
    accept_pairings: number;
    accept_writes: number;
    maintenance_mode: number;
    accounting_fault: number;
    state_reason: string;
    state_request_id: string | null;
  } | null;
  try {
    state = await env.MIRNA_SYNC_DB.prepare(
      `SELECT accept_new_vaults, accept_pairings, accept_writes, maintenance_mode,
              accounting_fault, state_reason, state_request_id
         FROM service_flags WHERE singleton_id = 1`,
    ).first();
  } catch {
    return accountingError(
      context,
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Staging usage accounting is unavailable.',
      phase,
      route,
      false,
      'FLAGS_READ_FAILED',
    );
  }
  if (!state) {
    return accountingError(
      context,
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Staging usage accounting is unavailable.',
      phase,
      route,
      false,
      'REQUIRED_ACCOUNTING_ROW_MISSING',
    );
  }
  if (state.state_reason === 'D1_STORAGE_LIMIT_REACHED') {
    return accountingError(
      context,
      503,
      'D1_STORAGE_LIMIT_REACHED',
      'Staging database storage limit is reached.',
      phase,
      route,
      false,
      'D1_STORAGE_LIMIT_REACHED',
    );
  }
  if (
    state.accounting_fault === 1 &&
    !['read', 'diagnostic', 'new-vault', 'pairing-retry'].includes(access)
  ) {
    const originRequestId = state.state_request_id ?? undefined;
    let originRoute: string | undefined;
    if (originRequestId) {
      try {
        originRoute =
          (await env.MIRNA_SYNC_DB.prepare(
            `SELECT route_key
               FROM usage_reservations
              WHERE reservation_id = ?1
              LIMIT 1`,
          )
            .bind(`${originRequestId}:route`)
            .first<string>('route_key')) ?? undefined;
      } catch {
        originRoute = undefined;
      }
    }
    return accountingError(
      context,
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Staging usage accounting requires reconciliation.',
      phase,
      route,
      false,
      activeFaultReason(state.state_reason),
      {
        faultRole: 'blocked',
        ...(originRequestId ? { originRequestId } : {}),
        ...(originRoute ? { originRoute } : {}),
        businessWorkStarted: false,
      },
    );
  }
  const disabled =
    (!['read', 'diagnostic'].includes(access) &&
      (state.maintenance_mode !== 0 || state.accept_writes !== 1)) ||
    (access === 'new-vault' && state.accept_new_vaults !== 1) ||
    (access === 'pairing-retry' && state.accept_pairings !== 1);
  if (disabled) {
    return accountingError(
      context,
      503,
      'SERVICE_MAINTENANCE',
      'Staging synchronization is in maintenance mode.',
      phase,
      route,
      false,
      'SERVICE_FLAGS_DISABLED',
    );
  }
  let d1Bytes: number | null;
  try {
    d1Bytes = await env.MIRNA_SYNC_DB.prepare(
      'SELECT d1_storage_bytes FROM resource_totals WHERE singleton_id = 1',
    ).first<number>('d1_storage_bytes');
  } catch {
    return accountingError(
      context,
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Staging usage accounting is unavailable.',
      phase,
      route,
      false,
      'RESOURCE_TOTALS_READ_FAILED',
    );
  }
  if (d1Bytes === null) {
    return accountingError(
      context,
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Staging usage accounting is unavailable.',
      phase,
      route,
      false,
      'REQUIRED_ACCOUNTING_ROW_MISSING',
    );
  }
  if (access !== 'read' && d1Bytes >= budgets.resources.d1StorageBytes) {
    return accountingError(
      context,
      503,
      'D1_STORAGE_LIMIT_REACHED',
      'Staging database storage limit is reached.',
      phase,
      route,
      false,
      'D1_STORAGE_LIMIT_REACHED',
    );
  }
  return scopeType === 'vault'
    ? accountingError(
        context,
        429,
        'VAULT_QUOTA_EXCEEDED',
        'Vault staging quota is exhausted.',
        phase,
        route,
        false,
        'HARD_LIMIT_REACHED',
      )
    : accountingError(
        context,
        503,
        'SERVICE_QUOTA_EXHAUSTED',
        'Staging service quota is exhausted.',
        phase,
        route,
        false,
        'HARD_LIMIT_REACHED',
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
  const phase = input.suffix === 'request' ? 'request-reservation' : 'route-reservation';
  const reservationIds = (context.budgetReservationIds ??= []);
  if (reservationIds.includes(reservationId)) return;
  const accountingEnv = context.accountingEnv ?? context.env;
  const day = utcDay(now);
  const ceilings = input.scopeType === 'global' ? budgets.global : budgets.perVault;
  let results: D1Result<unknown>[];
  try {
    results = await accountingEnv.MIRNA_SYNC_DB.batch([
      accountingEnv.MIRNA_SYNC_DB.prepare(
        `INSERT INTO usage_daily_buckets (scope_type, scope_id, utc_day, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (scope_type, scope_id, utc_day) DO NOTHING`,
      ).bind(input.scopeType, input.scopeId, day, now),
      accountingEnv.MIRNA_SYNC_DB.prepare(
        `INSERT INTO usage_rolling_totals (scope_type, scope_id, refreshed_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT (scope_type, scope_id) DO NOTHING`,
      ).bind(input.scopeType, input.scopeId, now),
      accountingEnv.MIRNA_SYNC_DB.prepare(
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
            AND (?23 IN ('read', 'diagnostic') OR resources.d1_storage_bytes < ?22)
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
      accountingEnv.MIRNA_SYNC_DB.prepare(
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
      accountingEnv.MIRNA_SYNC_DB.prepare(
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
  } catch (error) {
    const reason = reservationFailureReason(error);
    await recordBetaDiagnostic(
      { ...context, env: accountingEnv },
      {
        eventType: 'request_error',
        severity: 'error',
        category: 'budget_reservation_failed',
        requestId: context.requestId,
        details: {
          accountingCategory: 'USAGE_ACCOUNTING_UNAVAILABLE',
          accountingReason: reason,
          databaseErrorClass: diagnosticErrorClass(error),
          businessCommitted: context.businessCommit?.committed === true,
          route: input.routeKey,
          serviceFlagsChanged: false,
        },
      },
    );
    throw accountingError(
      context,
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Staging usage accounting is unavailable.',
      phase,
      input.routeKey,
      false,
      reason,
    );
  }
  if (!results[2]) {
    throw accountingError(
      context,
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Staging usage accounting is unavailable.',
      phase,
      input.routeKey,
      false,
      'RESERVATION_RESULT_EMPTY',
    );
  }
  if (typeof results[2].meta?.changes !== 'number') {
    throw accountingError(
      context,
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Staging usage accounting is unavailable.',
      phase,
      input.routeKey,
      false,
      'RESERVATION_METADATA_INVALID',
    );
  }
  if (results[2].meta.changes !== 1) {
    throw await classifyReservationFailure(
      context,
      input.scopeType,
      input.access,
      budgets,
      phase,
      input.routeKey,
    );
  }
  reservationIds.push(reservationId);
};

const markAccountingFault = async (
  context: RequestContext,
  category: 'USAGE_RESERVATION_UNDERESTIMATED' | 'USAGE_SETTLEMENT_FAILED',
  now: number,
): Promise<boolean> => {
  try {
    const result = await (context.accountingEnv ?? context.env).MIRNA_SYNC_DB.prepare(
      `UPDATE service_flags
          SET accounting_fault = 1, state_reason = ?1, state_request_id = ?2,
              accounting_fault_at = ?3, updated_at = ?3
        WHERE singleton_id = 1 AND accounting_fault = 0`,
    )
      .bind(category, context.requestId, now)
      .run();
    return result.meta.changes === 1;
  } catch {
    return false;
  }
};

export class UsageBudgetController {
  constructor(
    private readonly budgets: StagingBudgets = STAGING_BUDGETS,
    private readonly now: () => number = Date.now,
    private readonly routeUsageOverrides: Readonly<Partial<Record<string, MeteredUsage>>> = {},
  ) {}

  async reserveRoute(context: RequestContext): Promise<void> {
    const route = routeBudget(context.request);
    if (route.usage === ZERO_USAGE) return;
    const estimatedUsage = this.routeUsageOverrides[route.key] ?? route.usage;
    await reserve(
      context,
      {
        suffix: 'route',
        scopeType: 'global',
        scopeId: 'service',
        routeKey: route.key,
        access: route.access,
        usage: {
          ...estimatedUsage,
          workerRequests: 1,
        },
      },
      this.budgets,
      this.now(),
    );
  }

  async reserveScheduledCleanup(
    context: RequestContext,
    estimatedUsage: MeteredUsage,
  ): Promise<void> {
    await reserve(
      context,
      {
        suffix: 'scheduled-cleanup',
        scopeType: 'global',
        scopeId: 'service',
        routeKey: 'scheduled-cleanup',
        access: 'write',
        usage: {
          ...estimatedUsage,
          workerRequests: 1,
        },
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
    const accountingEnv = context.accountingEnv ?? context.env;
    let activeRoute = budgetRouteKey(context.request);
    try {
      const observed = context.usageMeter?.snapshot();
      if (observed && observed.sizeAfter > 0) {
        await observeD1Size(accountingEnv, observed.sizeAfter, this.budgets);
      }
      const rows = await Promise.all(
        reservationIds.map((reservationId) =>
          accountingEnv.MIRNA_SYNC_DB.prepare(
            `SELECT reservation_id, scope_type, scope_id, route_key, created_at,
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
      let underestimated = false;
      for (const row of rows as ReservationRow[]) {
        activeRoute = row.route_key;
        const isRequestOverhead = row.reservation_id.endsWith(':request');
        const measurementExact = !isRequestOverhead && observed?.exact === true;
        const actual: MeteredUsage = !measurementExact
          ? {
              workerRequests: row.reserved_worker_requests,
              d1RowsRead: row.reserved_d1_rows_read,
              d1RowsWritten: row.reserved_d1_rows_written,
              r2ClassA: row.reserved_r2_class_a,
              r2ClassB: row.reserved_r2_class_b,
            }
          : {
              ...observed.usage,
              workerRequests: 1,
            };
        const reserved: MeteredUsage = {
          workerRequests: row.reserved_worker_requests,
          d1RowsRead: row.reserved_d1_rows_read,
          d1RowsWritten: row.reserved_d1_rows_written,
          r2ClassA: row.reserved_r2_class_a,
          r2ClassB: row.reserved_r2_class_b,
        };
        const values = Object.keys(reserved) as (keyof MeteredUsage)[];
        const rowUnderestimated =
          measurementExact && values.some((key) => actual[key] > reserved[key] || actual[key] < 0);
        underestimated ||= rowUnderestimated;
        const released: MeteredUsage = {
          workerRequests: Math.max(0, reserved.workerRequests - actual.workerRequests),
          d1RowsRead: Math.max(0, reserved.d1RowsRead - actual.d1RowsRead),
          d1RowsWritten: Math.max(0, reserved.d1RowsWritten - actual.d1RowsWritten),
          r2ClassA: Math.max(0, reserved.r2ClassA - actual.r2ClassA),
          r2ClassB: Math.max(0, reserved.r2ClassB - actual.r2ClassB),
        };
        const adjustment: MeteredUsage = {
          workerRequests: actual.workerRequests - reserved.workerRequests,
          d1RowsRead: actual.d1RowsRead - reserved.d1RowsRead,
          d1RowsWritten: actual.d1RowsWritten - reserved.d1RowsWritten,
          r2ClassA: actual.r2ClassA - reserved.r2ClassA,
          r2ClassB: actual.r2ClassB - reserved.r2ClassB,
        };
        const day = utcDay(row.created_at);
        statements.push(
          accountingEnv.MIRNA_SYNC_DB.prepare(
            `UPDATE usage_daily_buckets
                SET worker_requests = worker_requests + ?4,
                    d1_rows_read = d1_rows_read + ?5,
                    d1_rows_written = d1_rows_written + ?6,
                    r2_class_a = r2_class_a + ?7,
                    r2_class_b = r2_class_b + ?8,
                    updated_at = ?9
              WHERE scope_type = ?1 AND scope_id = ?2 AND utc_day = ?3`,
          ).bind(
            row.scope_type,
            row.scope_id,
            day,
            adjustment.workerRequests,
            adjustment.d1RowsRead,
            adjustment.d1RowsWritten,
            adjustment.r2ClassA,
            adjustment.r2ClassB,
            now,
          ),
          accountingEnv.MIRNA_SYNC_DB.prepare(
            `UPDATE usage_rolling_totals
                SET worker_requests = worker_requests + ?3,
                    d1_rows_read = d1_rows_read + ?4,
                    d1_rows_written = d1_rows_written + ?5,
                    r2_class_a = r2_class_a + ?6,
                    r2_class_b = r2_class_b + ?7,
                    refreshed_at = ?8
              WHERE scope_type = ?1 AND scope_id = ?2`,
          ).bind(
            row.scope_type,
            row.scope_id,
            adjustment.workerRequests,
            adjustment.d1RowsRead,
            adjustment.d1RowsWritten,
            adjustment.r2ClassA,
            adjustment.r2ClassB,
            now,
          ),
          accountingEnv.MIRNA_SYNC_DB.prepare(
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
                    measurement_exact = ?13,
                    measured_worker_requests = ?3,
                    measured_d1_rows_read = ?4,
                    measured_d1_rows_written = ?5,
                    measured_r2_class_a = ?6,
                    measured_r2_class_b = ?7,
                    settlement_failure_code = ?14,
                    business_committed = ?15,
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
            measurementExact ? 1 : 0,
            rowUnderestimated ? 'USAGE_RESERVATION_UNDERESTIMATED' : null,
            context.businessCommit?.committed === true ? 1 : 0,
          ),
        );
      }
      if (underestimated) {
        statements.push(
          accountingEnv.MIRNA_SYNC_DB.prepare(
            `UPDATE service_flags
                SET accounting_fault = 1,
                    state_reason = 'USAGE_RESERVATION_UNDERESTIMATED',
                    state_request_id = ?1,
                    accounting_fault_at = ?2,
                    updated_at = ?2
              WHERE singleton_id = 1 AND accounting_fault = 0`,
          ).bind(context.requestId, now),
        );
      }
      const results = await accountingEnv.MIRNA_SYNC_DB.batch(statements);
      const settlementResultCount = (rows as ReservationRow[]).length * 3;
      if (results.slice(0, settlementResultCount).some((result) => result.meta.changes !== 1)) {
        throw new Error('settlement failed');
      }
      if (underestimated) {
        const serviceFlagsChanged = results[settlementResultCount]?.meta.changes === 1;
        await recordBetaDiagnostic(
          { ...context, env: accountingEnv },
          {
            eventType: 'request_error',
            severity: 'error',
            category: 'budget_underestimation_detected',
            requestId: context.requestId,
            details: {
              accountingCategory: 'USAGE_RESERVATION_UNDERESTIMATED',
              accountingReason: 'USAGE_RESERVATION_UNDERESTIMATED',
              businessCommitted: context.businessCommit?.committed === true,
              route: activeRoute,
              serviceFlagsChanged,
            },
          },
        );
        throw accountingError(
          context,
          503,
          'USAGE_RESERVATION_UNDERESTIMATED',
          'Staging usage reservation was underestimated.',
          'settlement',
          activeRoute,
          serviceFlagsChanged,
          'USAGE_RESERVATION_UNDERESTIMATED',
          {
            faultRole: serviceFlagsChanged ? 'origin' : 'none',
            ...(serviceFlagsChanged ? { originRequestId: context.requestId } : {}),
            originRoute: activeRoute,
            businessWorkStarted: true,
          },
        );
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const flagsChanged = await markAccountingFault(context, 'USAGE_SETTLEMENT_FAILED', now);
      await recordBetaDiagnostic(
        { ...context, env: accountingEnv },
        {
          eventType: 'request_error',
          severity: 'error',
          category: 'budget_settlement_failed',
          requestId: context.requestId,
          details: {
            accountingCategory: 'USAGE_SETTLEMENT_FAILED',
            accountingReason: 'USAGE_SETTLEMENT_FAILED',
            businessCommitted: context.businessCommit?.committed === true,
            route: activeRoute,
            serviceFlagsChanged: flagsChanged,
          },
        },
      );
      throw accountingError(
        context,
        503,
        'USAGE_SETTLEMENT_FAILED',
        'Staging usage accounting is unavailable.',
        'settlement',
        activeRoute,
        flagsChanged,
        'USAGE_SETTLEMENT_FAILED',
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
      `SELECT accept_writes, maintenance_mode, accounting_fault
         FROM service_flags WHERE singleton_id = 1`,
    ).first<{ accept_writes: number; maintenance_mode: number; accounting_fault: number }>();
    return row?.accept_writes === 1 && row.maintenance_mode === 0 && row.accounting_fault === 0;
  } catch {
    return false;
  }
};

/** Allows an exact already-committed retry, while refusing new side effects. */
export const assertNewVaultCreationAllowed = async (context: RequestContext): Promise<void> => {
  const env = context.accountingEnv ?? context.env;
  let state: {
    accept_new_vaults: number;
    accept_writes: number;
    maintenance_mode: number;
    accounting_fault: number;
    state_reason: string;
  } | null;
  try {
    state = await env.MIRNA_SYNC_DB.prepare(
      `SELECT accept_new_vaults, accept_writes, maintenance_mode,
              accounting_fault, state_reason
         FROM service_flags WHERE singleton_id = 1`,
    ).first();
  } catch {
    throw accountingError(
      context,
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Staging usage accounting is unavailable.',
      'route-reservation',
      'vault-create',
      false,
      'FLAGS_READ_FAILED',
    );
  }
  if (!state) {
    throw accountingError(
      context,
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Staging usage accounting is unavailable.',
      'route-reservation',
      'vault-create',
      false,
      'REQUIRED_ACCOUNTING_ROW_MISSING',
    );
  }
  if (state.state_reason === 'D1_STORAGE_LIMIT_REACHED') {
    throw accountingError(
      context,
      503,
      'D1_STORAGE_LIMIT_REACHED',
      'Staging database storage limit is reached.',
      'route-reservation',
      'vault-create',
      false,
      'D1_STORAGE_LIMIT_REACHED',
    );
  }
  if (state.accounting_fault === 1) {
    throw accountingError(
      context,
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Staging usage accounting requires reconciliation.',
      'route-reservation',
      'vault-create',
      false,
      activeFaultReason(state.state_reason),
    );
  }
  if (state.maintenance_mode !== 0 || state.accept_writes !== 1 || state.accept_new_vaults !== 1) {
    throw accountingError(
      context,
      503,
      'SERVICE_MAINTENANCE',
      'Staging synchronization is in maintenance mode.',
      'route-reservation',
      'vault-create',
      false,
      'SERVICE_FLAGS_DISABLED',
    );
  }
};

/**
 * Pairing route reservations allow exact committed retries through an active
 * accounting fault. Every handler must call this guard immediately before a
 * new pairing mutation, after it has exhausted its exact-retry branch.
 */
export const assertNewPairingMutationAllowed = async (
  context: RequestContext,
  route: Extract<
    ApiRouteId,
    'pairing-create' | 'pairing-inspect' | 'pairing-approve' | 'pairing-cancel' | 'pairing-finalize'
  >,
): Promise<void> => {
  const env = context.accountingEnv ?? context.env;
  let state: {
    accept_pairings: number;
    accept_writes: number;
    maintenance_mode: number;
    accounting_fault: number;
    state_reason: string;
    state_request_id: string | null;
  } | null;
  try {
    state = await env.MIRNA_SYNC_DB.prepare(
      `SELECT accept_pairings, accept_writes, maintenance_mode,
              accounting_fault, state_reason, state_request_id
         FROM service_flags WHERE singleton_id = 1`,
    ).first();
  } catch {
    throw accountingError(
      context,
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Staging usage accounting is unavailable.',
      'route-reservation',
      route,
      false,
      'FLAGS_READ_FAILED',
    );
  }
  if (!state) {
    throw accountingError(
      context,
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Staging usage accounting is unavailable.',
      'route-reservation',
      route,
      false,
      'REQUIRED_ACCOUNTING_ROW_MISSING',
    );
  }
  if (state.accounting_fault === 1) {
    const originRequestId = state.state_request_id ?? undefined;
    let originRoute: string | undefined;
    if (originRequestId) {
      try {
        originRoute =
          (await env.MIRNA_SYNC_DB.prepare(
            'SELECT route_key FROM usage_reservations WHERE reservation_id = ?1 LIMIT 1',
          )
            .bind(`${originRequestId}:route`)
            .first<string>('route_key')) ?? undefined;
      } catch {
        originRoute = undefined;
      }
    }
    throw accountingError(
      context,
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Staging usage accounting requires reconciliation.',
      'route-reservation',
      route,
      false,
      activeFaultReason(state.state_reason),
      {
        faultRole: 'blocked',
        ...(originRequestId ? { originRequestId } : {}),
        ...(originRoute ? { originRoute } : {}),
        businessWorkStarted: false,
      },
    );
  }
  if (state.maintenance_mode !== 0 || state.accept_writes !== 1 || state.accept_pairings !== 1) {
    throw accountingError(
      context,
      503,
      'SERVICE_MAINTENANCE',
      'Staging synchronization is in maintenance mode.',
      'route-reservation',
      route,
      false,
      'SERVICE_FLAGS_DISABLED',
    );
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
          SET accept_new_vaults = 0, accept_writes = 0,
              state_reason = 'D1_STORAGE_LIMIT_REACHED', state_request_id = NULL,
              updated_at = ?2
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
            AND f.maintenance_mode = 0 AND f.accept_writes = 1 AND f.accounting_fault = 0
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
      'USAGE_ACCOUNTING_UNAVAILABLE',
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
    throw new HttpError(503, 'SERVICE_QUOTA_EXHAUSTED', 'Staging service quota is exhausted.');
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
        'USAGE_SETTLEMENT_FAILED',
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
      'USAGE_SETTLEMENT_FAILED',
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
      'USAGE_SETTLEMENT_FAILED',
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
          SET settlement_failure_code = COALESCE(
                settlement_failure_code,
                'STALE_RESERVATION_REQUIRES_RECONCILIATION'
              )
        WHERE state = 'reserved' AND created_at < ?2`,
    ).bind(scheduledTime, scheduledTime - 60 * 60 * 1_000),
    env.MIRNA_SYNC_DB.prepare(
      `UPDATE service_flags
          SET accounting_fault = 1,
              state_reason = 'STALE_RESERVATION_REQUIRES_RECONCILIATION',
              state_request_id = NULL,
              accounting_fault_at = COALESCE(accounting_fault_at, ?1),
              updated_at = ?1
        WHERE singleton_id = 1
          AND EXISTS (
            SELECT 1 FROM usage_reservations
             WHERE state = 'reserved' AND created_at < ?2
          )`,
    ).bind(scheduledTime, scheduledTime - 60 * 60 * 1_000),
    env.MIRNA_SYNC_DB.prepare(
      `DELETE FROM usage_reservations
        WHERE state IN ('committed', 'released') AND settled_at < ?1`,
    ).bind(scheduledTime - 45 * 24 * 60 * 60 * 1_000),
  ]);
  return expired.results.length;
};
