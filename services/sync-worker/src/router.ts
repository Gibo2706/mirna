import { authenticateRequest, handleAuthChallenge, handleAuthSession } from './auth';
import type { RequestContext } from './context';
import { handleDeleteVault } from './deletion';
import {
  handleGetCurrentDeviceKeyEnvelope,
  handleRenewDevice,
  handleSecureRevokeDevice,
} from './devices';
import { handleBetaDiagnosticEvent } from './diagnostics';
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
import { allowedMethodsForRegisteredPath, matchApiRoute, matchApiRequest } from './route-registry';
import { handleGetCurrentSnapshot, handleUploadSnapshot } from './snapshots';
import { handleCreateVault, handleGetCurrentManifest, handleGetManifestChanges } from './vaults';

export const isSnapshotUploadPath = (pathname: string): boolean =>
  matchApiRoute('PUT', pathname)?.definition.id === 'snapshot-upload';

export const allowedMethodsForPath = allowedMethodsForRegisteredPath;

const requiredParameter = (parameters: Readonly<Record<string, string>>, name: string): string => {
  const value = parameters[name];
  if (!value) throw new HttpError(404, 'ROUTE_NOT_FOUND', 'Route was not found.');
  return value;
};

const assertUnreachable = (routeId: never): never => {
  throw new Error(`Unimplemented API route: ${String(routeId)}`);
};

export const routeRequest = async (context: RequestContext): Promise<Response> => {
  const pathname = new URL(context.request.url).pathname;
  const methods = allowedMethodsForPath(pathname);
  if (!methods) throw new HttpError(404, 'ROUTE_NOT_FOUND', 'Route was not found.');
  if (!methods.includes(context.request.method)) {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.');
  }
  const matched = matchApiRequest(context.request);
  if (!matched) throw new HttpError(404, 'ROUTE_NOT_FOUND', 'Route was not found.');
  const { id } = matched.definition;
  const parameters = matched.parameters;

  switch (id) {
    case 'health':
      return handleHealth(context.env, context.requestId, context.allowedOrigin);
    case 'beta-diagnostics':
      return handleBetaDiagnosticEvent(context);
    case 'vault-create':
      return handleCreateVault(context);
    case 'vault-delete-init':
      return handleDeleteVault(context);
    case 'auth-challenge':
      return handleAuthChallenge(context);
    case 'auth-session':
      return handleAuthSession(context);
    case 'pairing-create':
      return handleCreatePairing(context);
    case 'pairing-inspect':
      return handleInspectPairing(context, requiredParameter(parameters, 'pairingRequestId'));
    case 'pairing-approve':
      return handleApprovePairing(context, requiredParameter(parameters, 'pairingRequestId'));
    case 'pairing-poll':
      return handlePollPairing(context, requiredParameter(parameters, 'pairingRequestId'));
    case 'pairing-cancel':
      return handleCancelPairing(context, requiredParameter(parameters, 'pairingRequestId'));
    case 'pairing-finalize':
      return handleFinalizePairing(context, requiredParameter(parameters, 'pairingRequestId'));
    case 'recovery-challenge':
      return handleRecoveryChallenge(context);
    case 'recovery-bundle':
      return handleFetchRecoveryBundle(context);
    case 'recovery-snapshot':
      return handleFetchRecoverySnapshot(context);
    case 'recovery-complete':
      return handleCompleteRecovery(context, requiredParameter(parameters, 'vaultId'));
    case 'operation-upload':
      return handleUploadOperation(context);
    case 'changes-read':
      return handleGetChanges(context);
    case 'changes-ack':
      return handleAcknowledgeChanges(context);
    case 'key-envelope-current':
      return handleGetCurrentDeviceKeyEnvelope(context);
    case 'key-envelope-by-epoch':
      return handleGetCurrentDeviceKeyEnvelope(
        context,
        Number(requiredParameter(parameters, 'keyEpoch')),
      );
    case 'manifest-changes':
      return handleGetManifestChanges(context, await authenticateRequest(context));
    case 'manifest-current':
      return handleGetCurrentManifest(context, await authenticateRequest(context));
    case 'snapshot-current':
      return handleGetCurrentSnapshot(context);
    case 'snapshot-upload':
      return handleUploadSnapshot(context, requiredParameter(parameters, 'snapshotId'));
    case 'device-renew':
      return handleRenewDevice(context, requiredParameter(parameters, 'deviceId'));
    case 'device-revoke':
      return handleSecureRevokeDevice(context, requiredParameter(parameters, 'deviceId'));
    default:
      return assertUnreachable(id);
  }
};
