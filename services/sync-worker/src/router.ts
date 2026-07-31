import { authenticateRequest, handleAuthChallenge, handleAuthSession } from './auth';
import type { RequestContext } from './context';
import { HttpError } from './errors';
import { handleHealth } from './health';
import {
  handleApprovePairing,
  handleCancelPairing,
  handleCreatePairing,
  handleFinalizePairing,
  handleInspectPairing,
  handlePollPairing,
} from './pairings';
import {
  handleCompleteRecovery,
  handleFetchRecoveryBundle,
  handleRecoveryChallenge,
} from './recovery';
import { handleCreateVault, handleGetCurrentManifest } from './vaults';

const PAIRING_ROUTE =
  /^\/v1\/pairings\/([A-Za-z0-9_-]{22})\/(inspect|approve|poll|cancel|finalize)$/u;
const RECOVERY_COMPLETE_ROUTE = /^\/v1\/vaults\/([A-Za-z0-9_-]{22})\/recover$/u;

export const allowedMethodsForPath = (pathname: string): readonly string[] | null => {
  if (pathname === '/v1/health' || pathname === '/v1/vault/manifest') return ['GET'];
  if (
    pathname === '/v1/vaults' ||
    pathname === '/v1/auth/challenge' ||
    pathname === '/v1/auth/session' ||
    pathname === '/v1/pairings' ||
    pathname === '/v1/recovery/challenge' ||
    pathname === '/v1/recovery/bundle' ||
    PAIRING_ROUTE.test(pathname) ||
    RECOVERY_COMPLETE_ROUTE.test(pathname)
  ) {
    return ['POST'];
  }
  return null;
};

export const routeRequest = async (context: RequestContext): Promise<Response> => {
  const pathname = new URL(context.request.url).pathname;
  const methods = allowedMethodsForPath(pathname);
  if (!methods) throw new HttpError(404, 'ROUTE_NOT_FOUND', 'Route was not found.');
  if (!methods.includes(context.request.method)) {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.');
  }

  if (pathname === '/v1/health') {
    return handleHealth(context.env, context.requestId, context.allowedOrigin);
  }
  if (pathname === '/v1/vaults') return handleCreateVault(context);
  if (pathname === '/v1/auth/challenge') return handleAuthChallenge(context);
  if (pathname === '/v1/auth/session') return handleAuthSession(context);
  if (pathname === '/v1/pairings') return handleCreatePairing(context);
  if (pathname === '/v1/recovery/challenge') return handleRecoveryChallenge(context);
  if (pathname === '/v1/recovery/bundle') return handleFetchRecoveryBundle(context);
  if (pathname === '/v1/vault/manifest') {
    return handleGetCurrentManifest(context, await authenticateRequest(context));
  }

  const pairing = PAIRING_ROUTE.exec(pathname);
  if (!pairing?.[1] || !pairing[2]) {
    const recovery = RECOVERY_COMPLETE_ROUTE.exec(pathname);
    if (recovery?.[1]) return handleCompleteRecovery(context, recovery[1]);
    throw new HttpError(404, 'ROUTE_NOT_FOUND', 'Route was not found.');
  }
  const pairingRequestId = pairing[1];
  switch (pairing[2]) {
    case 'inspect':
      return handleInspectPairing(context, pairingRequestId);
    case 'approve':
      return handleApprovePairing(context, pairingRequestId);
    case 'poll':
      return handlePollPairing(context, pairingRequestId);
    case 'cancel':
      return handleCancelPairing(context, pairingRequestId);
    case 'finalize':
      return handleFinalizePairing(context, pairingRequestId);
  }
  throw new HttpError(404, 'ROUTE_NOT_FOUND', 'Route was not found.');
};
