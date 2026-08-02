import type { Env } from './env';
import { jsonResponse, SYNC_PROTOCOL_VERSION } from './http';
import { ROUTE_BUDGET_REGISTRY_VERSION, routeRegistryIsConformant } from './route-registry';

type Reachability = 'ok' | 'unavailable';
type ReadinessStatus = 'ok' | 'error';
type AccountingState = 'ok' | 'fault';
type WriteState = 'enabled' | 'disabled';
type RouteBudgetConformance = 'ok' | 'fault';
interface HealthCheckResult {
  d1: Reachability;
  r2: Reachability;
}

interface AccountingReadiness {
  accountingSchema: ReadinessStatus;
  accountingState: AccountingState;
  writes: WriteState;
  routeBudgetConformance: RouteBudgetConformance;
  routeBudgetRegistryVersion: string;
}

interface HealthCacheEntry {
  expiresAt: number;
  result?: HealthCheckResult;
  pending?: Promise<HealthCheckResult>;
}

const HEALTH_CHECK_TTL_MS = 30_000;
const healthChecks = new WeakMap<Env, HealthCacheEntry>();

const safeBuildCommit = (value: string): string =>
  /^(?:[0-9a-f]{7,64}|local|replace-at-deploy)$/u.test(value) ? value : 'unknown';

const checkD1 = async (database: D1Database): Promise<Reachability> => {
  try {
    const result = await database.prepare('SELECT 1 AS reachable').first<number>('reachable');
    return result === 1 ? 'ok' : 'unavailable';
  } catch {
    return 'unavailable';
  }
};

const checkR2 = async (bucket: R2Bucket): Promise<Reachability> => {
  try {
    // A missing sentinel still proves that the private binding is reachable.
    await bucket.head('__mirna_internal__/health-sentinel');
    return 'ok';
  } catch {
    return 'unavailable';
  }
};

const REQUIRED_ACCOUNTING_COLUMNS = Object.freeze({
  service_flags: [
    'singleton_id',
    'accept_new_vaults',
    'accept_pairings',
    'accept_writes',
    'maintenance_mode',
    'accounting_fault',
    'state_reason',
    'state_request_id',
    'accounting_fault_at',
  ],
  resource_totals: ['singleton_id', 'd1_storage_bytes'],
  pairing_request_totals: ['singleton_id', 'total_count', 'updated_at'],
  usage_daily_buckets: [
    'scope_type',
    'scope_id',
    'utc_day',
    'worker_requests',
    'd1_rows_read',
    'd1_rows_written',
    'r2_class_a',
    'r2_class_b',
  ],
  usage_rolling_totals: [
    'scope_type',
    'scope_id',
    'worker_requests',
    'd1_rows_read',
    'd1_rows_written',
    'r2_class_a',
    'r2_class_b',
  ],
  usage_reservations: [
    'reservation_id',
    'measurement_exact',
    'measured_worker_requests',
    'measured_d1_rows_read',
    'measured_d1_rows_written',
    'measured_r2_class_a',
    'measured_r2_class_b',
    'settlement_failure_code',
    'business_committed',
    'reconciled_at',
    'reconciliation_code',
  ],
} as const);

const hasRequiredColumns = async (
  database: D1Database,
  table: keyof typeof REQUIRED_ACCOUNTING_COLUMNS,
): Promise<boolean> => {
  const result = await database.prepare(`PRAGMA table_info('${table}')`).all<{ name: string }>();
  const actual = new Set(result.results.map(({ name }) => name));
  return REQUIRED_ACCOUNTING_COLUMNS[table].every((column) => actual.has(column));
};

export const checkAccountingReadiness = async (
  database: D1Database,
): Promise<AccountingReadiness> => {
  try {
    const schemaReady = (
      await Promise.all(
        (
          Object.keys(REQUIRED_ACCOUNTING_COLUMNS) as (keyof typeof REQUIRED_ACCOUNTING_COLUMNS)[]
        ).map((table) => hasRequiredColumns(database, table)),
      )
    ).every(Boolean);
    if (!schemaReady) {
      return {
        accountingSchema: 'error',
        accountingState: 'fault',
        writes: 'disabled',
        routeBudgetConformance: 'fault',
        routeBudgetRegistryVersion: ROUTE_BUDGET_REGISTRY_VERSION,
      };
    }
  } catch {
    return {
      accountingSchema: 'error',
      accountingState: 'fault',
      writes: 'disabled',
      routeBudgetConformance: 'fault',
      routeBudgetRegistryVersion: ROUTE_BUDGET_REGISTRY_VERSION,
    };
  }

  try {
    const state = await database
      .prepare(
        `SELECT accept_new_vaults, accept_pairings, accept_writes,
                maintenance_mode, accounting_fault
           FROM service_flags WHERE singleton_id = 1`,
      )
      .first<{
        accept_new_vaults: number;
        accept_pairings: number;
        accept_writes: number;
        maintenance_mode: number;
        accounting_fault: number;
      }>();
    const resourceRow = await database
      .prepare('SELECT singleton_id FROM resource_totals WHERE singleton_id = 1')
      .first<number>('singleton_id');
    const rollingRow = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM usage_rolling_totals
          WHERE scope_type = 'global' AND scope_id = 'service'`,
      )
      .first<number>('count');
    const pairingTotalRow = await database
      .prepare('SELECT singleton_id FROM pairing_request_totals WHERE singleton_id = 1')
      .first<number>('singleton_id');
    const unresolvedRouteBudgetFaults = await database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM usage_reservations
          WHERE settlement_failure_code = 'USAGE_RESERVATION_UNDERESTIMATED'
            AND reconciled_at IS NULL`,
      )
      .first<number>('count');
    if (!state || resourceRow !== 1 || rollingRow !== 1 || pairingTotalRow !== 1) {
      return {
        accountingSchema: 'ok',
        accountingState: 'fault',
        writes: 'disabled',
        routeBudgetConformance: 'fault',
        routeBudgetRegistryVersion: ROUTE_BUDGET_REGISTRY_VERSION,
      };
    }
    const accountingState = state.accounting_fault === 0 ? 'ok' : 'fault';
    const writes =
      accountingState === 'ok' &&
      state.accept_new_vaults === 1 &&
      state.accept_pairings === 1 &&
      state.accept_writes === 1 &&
      state.maintenance_mode === 0
        ? 'enabled'
        : 'disabled';
    return {
      accountingSchema: 'ok',
      accountingState,
      writes,
      routeBudgetConformance:
        routeRegistryIsConformant() && unresolvedRouteBudgetFaults === 0 ? 'ok' : 'fault',
      routeBudgetRegistryVersion: ROUTE_BUDGET_REGISTRY_VERSION,
    };
  } catch {
    return {
      accountingSchema: 'ok',
      accountingState: 'fault',
      writes: 'disabled',
      routeBudgetConformance: 'fault',
      routeBudgetRegistryVersion: ROUTE_BUDGET_REGISTRY_VERSION,
    };
  }
};

const checkServices = async (env: Env): Promise<HealthCheckResult> => {
  const now = Date.now();
  const cached = healthChecks.get(env);
  if (cached?.result && cached.expiresAt > now) return cached.result;
  if (cached?.pending) return cached.pending;

  const pending = Promise.all([checkD1(env.MIRNA_SYNC_DB), checkR2(env.MIRNA_SYNC_BUCKET)])
    .then(([d1, r2]) => {
      const result = { d1, r2 } satisfies HealthCheckResult;
      healthChecks.set(env, { expiresAt: Date.now() + HEALTH_CHECK_TTL_MS, result });
      return result;
    })
    .catch(() => {
      const result = {
        d1: 'unavailable',
        r2: 'unavailable',
      } satisfies HealthCheckResult;
      healthChecks.set(env, { expiresAt: Date.now() + HEALTH_CHECK_TTL_MS, result });
      return result;
    });
  healthChecks.set(env, { expiresAt: 0, pending });
  return pending;
};

export const handleHealth = async (
  env: Env,
  requestId: string,
  allowedOrigin: string | null,
): Promise<Response> => {
  const { d1, r2 } = await checkServices(env);
  const accounting =
    d1 === 'ok'
      ? await checkAccountingReadiness(env.MIRNA_SYNC_DB)
      : ({
          accountingSchema: 'error',
          accountingState: 'fault',
          writes: 'disabled',
          routeBudgetConformance: 'fault',
          routeBudgetRegistryVersion: ROUTE_BUDGET_REGISTRY_VERSION,
        } satisfies AccountingReadiness);
  const storage = d1 === 'ok' && r2 === 'ok' ? 'ok' : 'error';
  const healthy =
    storage === 'ok' &&
    accounting.accountingSchema === 'ok' &&
    accounting.accountingState === 'ok' &&
    accounting.routeBudgetConformance === 'ok' &&
    accounting.writes === 'enabled';

  return jsonResponse(
    {
      status: healthy ? 'ok' : 'degraded',
      environment: env.MIRNA_ENVIRONMENT === 'staging' ? 'staging' : 'local',
      protocolVersion: SYNC_PROTOCOL_VERSION,
      buildCommit: safeBuildCommit(env.MIRNA_BUILD_COMMIT),
      writesEnabled: accounting.writes === 'enabled',
      services: { d1, r2 },
      readiness: { storage, ...accounting },
    },
    {
      status: healthy ? 200 : 503,
      requestId,
      allowedOrigin,
    },
  );
};
