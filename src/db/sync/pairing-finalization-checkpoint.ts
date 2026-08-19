import Dexie from 'dexie';
import { canonicalizeJson } from '@/domain/sync/canonical';
import {
  decryptAesGcm,
  encryptAesGcm,
  randomBytes,
  type CryptoRuntime,
} from '@/domain/sync/crypto';
import { base64UrlToBytes, bytesToBase64Url, utf8 } from '@/domain/sync/encoding';
import { manifestBodyHash } from '@/domain/sync/manifest';
import { pairingFinalizeRequestSchema } from '@/domain/sync/schemas';
import { db, type FinanceDatabase } from '../database';
import { promotePairingFinalizationSetup, validateLocalSyncSetup } from './repository';
import {
  SYNC_PAIRING_FINALIZATION_RECORD_ID,
  type LocalSyncSetup,
  type SyncPairingFinalizationRecord,
} from './records';

export type PairingFinalizationRequest = ReturnType<typeof pairingFinalizeRequestSchema.parse>;

export interface PendingPairingFinalization {
  readonly record: SyncPairingFinalizationRecord;
  readonly request: PairingFinalizationRequest;
}

const aadFor = (record: {
  requestId: string;
  vaultId: string;
  deviceId: string;
  manifestVersion: number;
  manifestHash: string;
}) => ({
  type: 'mirna-pairing-finalization-checkpoint-v1',
  version: 1,
  requestId: record.requestId,
  vaultId: record.vaultId,
  deviceId: record.deviceId,
  manifestVersion: record.manifestVersion,
  manifestHash: record.manifestHash,
});

const assertRequestBinding = (
  setup: LocalSyncSetup,
  request: PairingFinalizationRequest,
  record: Omit<SyncPairingFinalizationRecord, 'setup' | 'nonce' | 'ciphertext' | 'createdAt'>,
): void => {
  if (
    request.transcript.pairingRequestId !== record.requestId ||
    request.transcript.vaultId !== record.vaultId ||
    request.transcript.newDeviceId !== record.deviceId ||
    request.transcript.candidateManifestHash !== record.manifestHash ||
    setup.vault.vaultId !== record.vaultId ||
    setup.device.deviceId !== record.deviceId ||
    setup.vault.manifest.manifestVersion !== record.manifestVersion ||
    setup.metadata.lastManifestHash !== record.manifestHash
  ) {
    throw new Error('Pairing finalization checkpoint binding is invalid.');
  }
};

const openRecord = async (
  input: SyncPairingFinalizationRecord,
  runtime: CryptoRuntime,
): Promise<PendingPairingFinalization> => {
  if (input.id !== SYNC_PAIRING_FINALIZATION_RECORD_ID || input.version !== 1) {
    throw new Error('Pairing finalization checkpoint version is invalid.');
  }
  const setup = await validateLocalSyncSetup(input.setup);
  const manifestHash = await manifestBodyHash(setup.vault.manifest, runtime);
  if (manifestHash !== input.manifestHash) {
    throw new Error('Pairing finalization checkpoint manifest is invalid.');
  }
  const plaintext = await decryptAesGcm(
    base64UrlToBytes(input.ciphertext),
    setup.device.localWrappingKey,
    base64UrlToBytes(input.nonce),
    aadFor(input),
    runtime,
  );
  let request: PairingFinalizationRequest;
  try {
    request = pairingFinalizeRequestSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)),
    );
  } finally {
    plaintext.fill(0);
  }
  assertRequestBinding(setup, request, input);
  return { record: { ...input, setup }, request };
};

const exactPending = (
  left: PendingPairingFinalization,
  right: PendingPairingFinalization,
): boolean =>
  left.record.requestId === right.record.requestId &&
  left.record.vaultId === right.record.vaultId &&
  left.record.deviceId === right.record.deviceId &&
  left.record.manifestHash === right.record.manifestHash &&
  canonicalizeJson(left.request) === canonicalizeJson(right.request);

export const stagePairingFinalization = async (
  setupInput: LocalSyncSetup,
  requestInput: PairingFinalizationRequest,
  database: FinanceDatabase = db,
  runtime: CryptoRuntime = globalThis.crypto,
): Promise<PendingPairingFinalization> => {
  const setup = await validateLocalSyncSetup(setupInput);
  const request = pairingFinalizeRequestSchema.parse(requestInput);
  const manifestHash = await manifestBodyHash(setup.vault.manifest, runtime);
  const binding = {
    id: SYNC_PAIRING_FINALIZATION_RECORD_ID,
    version: 1 as const,
    requestId: request.transcript.pairingRequestId,
    vaultId: request.transcript.vaultId,
    deviceId: request.transcript.newDeviceId,
    manifestVersion: setup.vault.manifest.manifestVersion,
    manifestHash,
  };
  assertRequestBinding(setup, request, binding);
  const nonce = randomBytes(12, runtime);
  const ciphertext = await encryptAesGcm(
    utf8(canonicalizeJson(request)),
    setup.device.localWrappingKey,
    nonce,
    aadFor(binding),
    runtime,
  );
  const pending: PendingPairingFinalization = {
    record: {
      ...binding,
      nonce: bytesToBase64Url(nonce),
      ciphertext: bytesToBase64Url(ciphertext),
      setup,
      createdAt: new Date().toISOString(),
    },
    request,
  };

  const existing = await readPendingPairingFinalization(database, runtime);
  if (existing) {
    if (!exactPending(existing, pending)) {
      throw new Error('A different pairing finalization is already pending.');
    }
    return existing;
  }
  try {
    await database.syncPairingFinalizations.add(pending.record);
    return pending;
  } catch (error) {
    if (!(error instanceof Dexie.ConstraintError)) throw error;
    const raced = await readPendingPairingFinalization(database, runtime);
    if (!raced || !exactPending(raced, pending)) {
      throw new Error('Pairing finalization checkpoint lost its local race.');
    }
    return raced;
  }
};

export const readPendingPairingFinalization = async (
  database: FinanceDatabase = db,
  runtime: CryptoRuntime = globalThis.crypto,
): Promise<PendingPairingFinalization | undefined> => {
  const record = await database.syncPairingFinalizations.get(SYNC_PAIRING_FINALIZATION_RECORD_ID);
  return record ? openRecord(record, runtime) : undefined;
};

export const hasPendingPairingFinalization = async (
  database: FinanceDatabase = db,
): Promise<boolean> =>
  (await database.syncPairingFinalizations.get(SYNC_PAIRING_FINALIZATION_RECORD_ID)) !== undefined;

export const completePendingPairingFinalization = (
  pending: PendingPairingFinalization,
  database: FinanceDatabase = db,
): Promise<LocalSyncSetup> => promotePairingFinalizationSetup(pending.record, database);
