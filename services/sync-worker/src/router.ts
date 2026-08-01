import { authenticateRequest, handleAuthChallenge, handleAuthSession } from './auth';
import type { RequestContext } from './context';
import { HttpError } from './errors';
import { handleHealth } from './health';
import { handleAcknowledgeChanges, handleGetChanges, handleUploadOperation } from './operations';
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
  handleFetchRecoverySnapshot,
  handleRecoveryChallenge,
} from './recovery';
import { handleGetCurrentSnapshot, handleUploadSnapshot } from './snapshots';
import { handleCreateVault, handleGetCurrentManifest } from './vaults';

const PAIRING_ROUTE =
  /^\/v1\/pairings\/([A-Za-z0-9_-]{22})\/(inspect|approve|poll|cancel|finalize)$/u;
const RECOVERY_COMPLETE_ROUTE = /^\/v1\/vaults\/([A-Za-z0-9_-]{22})\/recover$/u;
const SNAPSHOT_UPLOAD_ROUTE = /^\/v1\/snapshots\/([A-Za-z0-9_-]{22})$/u;

export const isSnapshotUploadPath = (pathname: string): boolean =>
  SNAPSHOT_UPLOAD_ROUTE.test(pathname);

export const allowedMethodsForPath = (pathname: string): readonly string[] | null => {
  if (
    pathname === '/v1/health' ||
    pathname === '/v1/vault/manifest' ||
    pathname === '/v1/snapshots/current' ||
    pathname === '/v1/changes'
  ) {
    return ['GET'];
  }
  if (SNAPSHOT_UPLOAD_ROUTE.test(pathname)) return ['PUT'];
  if (
    pathname === '/v1/vaults' ||
    pathname === '/v1/auth/challenge' ||
    pathname === '/v1/auth/session' ||
    pathname === '/v1/operations' ||
    pathname === '/v1/acks' ||
    pathname === '/v1/pairings' ||
    pathname === '/v1/recovery/challenge' ||
    pathname === '/v1/recovery/bundle' ||
    pathname === '/v1/recovery/snapshot' ||
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
  if (pathname === '/v1/recovery/snapshot') return handleFetchRecoverySnapshot(context);
  if (pathname === '/v1/operations') return handleUploadOperation(context);
  if (pathname === '/v1/changes') return handleGetChanges(context);
  if (pathname === '/v1/acks') return handleAcknowledgeChanges(context);
  if (pathname === '/v1/vault/manifest') {
    return handleGetCurrentManifest(context, await authenticateRequest(context));
  }
  if (pathname === '/v1/snapshots/current') return handleGetCurrentSnapshot(context);

  const snapshot = SNAPSHOT_UPLOAD_ROUTE.exec(pathname);
  if (snapshot?.[1]) return handleUploadSnapshot(context, snapshot[1]);

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
