import type { Env } from './env';
import { jsonResponse, SYNC_PROTOCOL_VERSION } from './http';
import { writesEnabled } from './budget';

type Reachability = 'ok' | 'unavailable';
interface HealthCheckResult {
  d1: Reachability;
  r2: Reachability;
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
  const healthy = d1 === 'ok' && r2 === 'ok';
  const canWrite = d1 === 'ok' && (await writesEnabled(env));

  return jsonResponse(
    {
      status: healthy ? 'ok' : 'degraded',
      environment: env.MIRNA_ENVIRONMENT === 'staging' ? 'staging' : 'local',
      protocolVersion: SYNC_PROTOCOL_VERSION,
      buildCommit: safeBuildCommit(env.MIRNA_BUILD_COMMIT),
      writesEnabled: canWrite,
      services: { d1, r2 },
    },
    {
      status: healthy ? 200 : 503,
      requestId,
      allowedOrigin,
    },
  );
};
