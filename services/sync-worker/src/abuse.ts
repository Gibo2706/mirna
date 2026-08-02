import { bytesToBase64Url, utf8 } from '../../../src/domain/sync/encoding';
import type { Env } from './env';
import { HttpError } from './errors';
import { matchApiPath, matchApiRequest, type RateLimitBindingName } from './route-registry';
import { domainHashBytes } from './server-crypto';

const bindingForRequest = (request: Request): RateLimitBindingName => {
  const exactRoute = matchApiRequest(request);
  if (exactRoute) return exactRoute.definition.rateLimit;
  const registeredPath = matchApiPath(new URL(request.url).pathname)[0];
  // Invalid methods, preflights and unknown paths still consume edge capacity.
  // The health limiter is the deliberately cheap catch-all for traffic that
  // cannot be assigned to a registered method-specific route.
  return registeredPath?.definition.rateLimit ?? 'MIRNA_HEALTH_RATE_LIMITER';
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
  const bindingName = bindingForRequest(request);
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
