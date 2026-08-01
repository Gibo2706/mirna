import { authenticateRequest, handleAuthChallenge, handleAuthSession } from './auth';
import type { RequestContext } from './context';
import { HttpError } from './errors';
import { handleHealth } from './health';
import { handleDeleteVault } from './deletion';
import {
  handleGetCurrentDeviceKeyEnvelope,
  handleRenewDevice,
  handleSecureRevokeDevice,
} from './devices';
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
import { handleCreateVault, handleGetCurrentManifest, handleGetManifestChanges } from './vaults';
import { handleBetaDiagnosticEvent } from './diagnostics';

const PAIRING_ROUTE =
  /^\/v1\/pairings\/([A-Za-z0-9_-]{22})\/(inspect|approve|poll|cancel|finalize)$/u;
const RECOVERY_COMPLETE_ROUTE = /^\/v1\/vaults\/([A-Za-z0-9_-]{22})\/recover$/u;
const SNAPSHOT_UPLOAD_ROUTE = /^\/v1\/snapshots\/([A-Za-z0-9_-]{22})$/u;
const DEVICE_SECURITY_ROUTE = /^\/v1\/devices\/([A-Za-z0-9_-]{22})\/(renew|revoke)$/u;
const KEY_EPOCH_ROUTE = /^\/v1\/key-epochs\/([1-9][0-9]*)$/u;

export const isSnapshotUploadPath = (pathname: string): boolean =>
  SNAPSHOT_UPLOAD_ROUTE.test(pathname);

export const allowedMethodsForPath = (pathname: string): readonly string[] | null => {
  if (
    pathname === '/v1/health' ||
    pathname === '/v1/vault/manifest' ||
    pathname === '/v1/snapshots/current' ||
    pathname === '/v1/changes' ||
    pathname === '/v1/manifests' ||
    pathname === '/v1/key-epochs/current'
  ) {
    return ['GET'];
  }
  if (KEY_EPOCH_ROUTE.test(pathname)) return ['GET'];
  if (pathname === '/v1/vault') return ['DELETE'];
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
    pathname === '/v1/diagnostics/events' ||
    PAIRING_ROUTE.test(pathname) ||
    RECOVERY_COMPLETE_ROUTE.test(pathname) ||
    DEVICE_SECURITY_ROUTE.test(pathname)
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
  if (pathname === '/v1/diagnostics/events') return handleBetaDiagnosticEvent(context);
  if (pathname === '/v1/vaults') return handleCreateVault(context);
  if (pathname === '/v1/vault') return handleDeleteVault(context);
  if (pathname === '/v1/auth/challenge') return handleAuthChallenge(context);
  if (pathname === '/v1/auth/session') return handleAuthSession(context);
  if (pathname === '/v1/pairings') return handleCreatePairing(context);
  if (pathname === '/v1/recovery/challenge') return handleRecoveryChallenge(context);
  if (pathname === '/v1/recovery/bundle') return handleFetchRecoveryBundle(context);
  if (pathname === '/v1/recovery/snapshot') return handleFetchRecoverySnapshot(context);
  if (pathname === '/v1/operations') return handleUploadOperation(context);
  if (pathname === '/v1/changes') return handleGetChanges(context);
  if (pathname === '/v1/acks') return handleAcknowledgeChanges(context);
  if (pathname === '/v1/key-epochs/current') return handleGetCurrentDeviceKeyEnvelope(context);
  if (pathname === '/v1/manifests') {
    return handleGetManifestChanges(context, await authenticateRequest(context));
  }
  if (pathname === '/v1/vault/manifest') {
    return handleGetCurrentManifest(context, await authenticateRequest(context));
  }
  if (pathname === '/v1/snapshots/current') return handleGetCurrentSnapshot(context);

  const snapshot = SNAPSHOT_UPLOAD_ROUTE.exec(pathname);
  if (snapshot?.[1]) return handleUploadSnapshot(context, snapshot[1]);
  const keyEpoch = KEY_EPOCH_ROUTE.exec(pathname)?.[1];
  if (keyEpoch) return handleGetCurrentDeviceKeyEnvelope(context, Number(keyEpoch));

  const pairing = PAIRING_ROUTE.exec(pathname);
  const deviceSecurity = DEVICE_SECURITY_ROUTE.exec(pathname);
  if (deviceSecurity?.[1] && deviceSecurity[2] === 'renew') {
    return handleRenewDevice(context, deviceSecurity[1]);
  }
  if (deviceSecurity?.[1] && deviceSecurity[2] === 'revoke') {
    return handleSecureRevokeDevice(context, deviceSecurity[1]);
  }
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
