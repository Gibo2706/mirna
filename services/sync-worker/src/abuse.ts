import { bytesToBase64Url, utf8 } from '../../../src/domain/sync/encoding';
import type { Env } from './env';
import { HttpError } from './errors';
import { domainHashBytes } from './server-crypto';

type RateLimitBindingName =
  | 'MIRNA_HEALTH_RATE_LIMITER'
  | 'MIRNA_SETUP_RATE_LIMITER'
  | 'MIRNA_PAIRING_CREATE_RATE_LIMITER'
  | 'MIRNA_PAIRING_ACTION_RATE_LIMITER'
  | 'MIRNA_AUTH_CHALLENGE_RATE_LIMITER'
  | 'MIRNA_AUTH_SESSION_RATE_LIMITER'
  | 'MIRNA_RECOVERY_INIT_RATE_LIMITER'
  | 'MIRNA_RECOVERY_ACTION_RATE_LIMITER'
  | 'MIRNA_SYNC_READ_RATE_LIMITER'
  | 'MIRNA_SNAPSHOT_UPLOAD_RATE_LIMITER'
  | 'MIRNA_OPERATION_WRITE_RATE_LIMITER';

const bindingForPath = (pathname: string): RateLimitBindingName | null => {
  if (pathname === '/v1/health') return 'MIRNA_HEALTH_RATE_LIMITER';
  if (pathname === '/v1/vaults') return 'MIRNA_SETUP_RATE_LIMITER';
  if (pathname === '/v1/pairings') return 'MIRNA_PAIRING_CREATE_RATE_LIMITER';
  if (pathname.startsWith('/v1/pairings/')) return 'MIRNA_PAIRING_ACTION_RATE_LIMITER';
  if (pathname === '/v1/auth/challenge') return 'MIRNA_AUTH_CHALLENGE_RATE_LIMITER';
  if (pathname === '/v1/auth/session') return 'MIRNA_AUTH_SESSION_RATE_LIMITER';
  if (pathname === '/v1/recovery/challenge') return 'MIRNA_RECOVERY_INIT_RATE_LIMITER';
  if (
    pathname === '/v1/recovery/bundle' ||
    pathname === '/v1/recovery/snapshot' ||
    /^\/v1\/vaults\/[^/]+\/recover$/u.test(pathname)
  ) {
    return 'MIRNA_RECOVERY_ACTION_RATE_LIMITER';
  }
  if (
    pathname === '/v1/vault/manifest' ||
    pathname === '/v1/snapshots/current' ||
    pathname === '/v1/changes'
  ) {
    return 'MIRNA_SYNC_READ_RATE_LIMITER';
  }
  if (/^\/v1\/snapshots\/[^/]+$/u.test(pathname)) {
    return 'MIRNA_SNAPSHOT_UPLOAD_RATE_LIMITER';
  }
  if (pathname === '/v1/operations' || pathname === '/v1/acks') {
    return 'MIRNA_OPERATION_WRITE_RATE_LIMITER';
  }
  return null;
};

const ephemeralNetworkKey = async (request: Request, bindingName: string): Promise<string> => {
  const networkSource =
    request.headers.get('CF-Connecting-IP') ?? request.headers.get('Origin') ?? 'unknown-client';
  const digest = await domainHashBytes(
    'MIRNA-E2EE-V1/anonymous-rate-limit-key',
    utf8(`${bindingName}\u0000${networkSource}`),
  );
  return bytesToBase64Url(digest);
};

/**
 * Cloudflare's edge limiter is availability/cost defense-in-depth only. D1
 * lifecycle counters and cryptographic authorization remain authoritative.
 * Missing bindings are accepted for local Miniflare; staging declares every
 * route-class binding and fails closed if one is unavailable.
 */
export const enforceEdgeRateLimit = async (request: Request, env: Env): Promise<void> => {
  const bindingName = bindingForPath(new URL(request.url).pathname);
  if (bindingName === null) return;
  const binding = env[bindingName];
  if (binding === undefined) {
    if (env.MIRNA_ENVIRONMENT === 'staging') {
      throw new HttpError(503, 'RATE_LIMIT_UNAVAILABLE', 'Request protection is unavailable.');
    }
    return;
  }
  let allowed = false;
  try {
    allowed = (await binding.limit({ key: await ephemeralNetworkKey(request, bindingName) }))
      .success;
  } catch {
    throw new HttpError(503, 'RATE_LIMIT_UNAVAILABLE', 'Request protection is unavailable.');
  }
  if (!allowed) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests.');
};
