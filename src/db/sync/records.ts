import type { EncryptedKeyEnvelopeV1, VaultManifestV1 } from '@/domain/sync/schemas';
import type { SyncFinancialEntityType, SyncOperationCommandType } from '@/domain/sync/operation';
import type { FinanceData } from '@/domain/types';

export const ACTIVE_SYNC_VAULT_RECORD_ID = 'active-sync-vault' as const;
export const LOCAL_SYNC_DEVICE_RECORD_ID = 'local-sync-device' as const;
export const SYNC_METADATA_RECORD_ID = 'sync-metadata' as const;
export const SYNC_CHECKPOINT_RECORD_ID = 'sync-safety-checkpoint' as const;

export const localVaultKeyRecordId = (vaultId: string, keyEpoch: number): string =>
  `${vaultId}:epoch:${keyEpoch}:vault-master-key`;

export type SyncVaultStatus = 'pairing' | 'active' | 'suspended';

export interface SyncVaultRecord {
  id: typeof ACTIVE_SYNC_VAULT_RECORD_ID;
  vaultId: string;
  protocolVersion: number;
  cryptoSuite: string;
  keyEpoch: number;
  status: SyncVaultStatus;
  manifest: VaultManifestV1;
  createdAt: string;
  updatedAt: string;
}

/**
 * Secret keys in this record must remain non-extractable CryptoKey objects.
 * Public keys are stored as CryptoKey objects as well so setup never needs a
 * raw private-key representation.
 */
export interface SyncDeviceRecord {
  id: typeof LOCAL_SYNC_DEVICE_RECORD_ID;
  vaultId: string;
  deviceId: string;
  displayName: string;
  signingPrivateKey: CryptoKey;
  signingPublicKey: CryptoKey;
  agreementPrivateKey: CryptoKey;
  agreementPublicKey: CryptoKey;
  localWrappingKey: CryptoKey;
  authorizationExpiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SyncKeyRecord {
  id: string;
  vaultId: string;
  keyEpoch: number;
  purpose: 'vault-master-key';
  encryptedKey: EncryptedKeyEnvelopeV1;
  createdAt: string;
  retiredAt?: string;
}

export interface SyncOutboxRecord {
  id: string;
  vaultId: string;
  operationId: string;
  deviceId: string;
  deviceSequence: number;
  keyEpoch: number;
  mutationGroupId: string;
  mutationGroupIndex: number;
  mutationGroupSize: number;
  state: 'intent' | 'encrypted' | 'uploading' | 'failed';
  entityType: SyncFinancialEntityType;
  entityId: string;
  command: SyncOperationCommandType;
  canonicalPayload: string;
  encryptedEnvelope?: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SyncEntityStateRecord {
  id: string;
  vaultId: string;
  entityType: SyncFinancialEntityType;
  entityId: string;
  entityVersion: number;
  stateHash: string;
  tombstone: boolean;
  canonicalTombstone?: string;
  lastOperationId: string | null;
  lastDeviceId: string | null;
  lastDeviceSequence: number;
  lastLamportTime: number;
  updatedAt: string;
}

export interface SyncInboxRecord {
  id: string;
  vaultId: string;
  operationId: string;
  serverCursor: number;
  deviceId?: string;
  deviceSequence?: number;
  operationHash?: string;
  mutationGroupId?: string;
  mutationGroupIndex?: number;
  mutationGroupSize?: number;
  state: 'received' | 'applied' | 'conflicted' | 'rejected';
  encryptedEnvelope: string;
  receivedAt: string;
  processedAt?: string;
  rejectionCode?: string;
}

export interface SyncConflictRecord {
  id: string;
  vaultId: string;
  entityType: string;
  entityId: string;
  localOperationId: string;
  remoteOperationId: string;
  mutationGroupId?: string;
  mutationGroupIndex?: number;
  mutationGroupSize?: number;
  localCanonicalProposal: string;
  remoteCanonicalProposal: string;
  causalMetadata: string;
  resolutionState: 'pending' | 'resolved-local' | 'resolved-remote' | 'resolved-custom';
  detectedAt: string;
  resolvedAt?: string;
  resolutionOperationId?: string;
}

export interface SyncFrontierRecord {
  id: string;
  vaultId: string;
  deviceId: string;
  lastDeviceSequence: number;
  lastOperationHash: string | null;
  acknowledgedServerCursor: number;
  updatedAt: string;
}

export interface SyncMetadataRecord {
  id: typeof SYNC_METADATA_RECORD_ID;
  vaultId: string;
  localSchemaVersion: 1;
  firstUploadConsent: 'pending' | 'accepted' | 'declined';
  lastServerCursor: number;
  lastSnapshotServerCursor: number;
  lastSnapshotRevision: number;
  lastSnapshotId: string | null;
  lastSnapshotHash: string | null;
  lastSnapshotContentHash: string | null;
  lastManifestHash: string;
  lastLocalDataHash: string | null;
  enabledAt: string;
  lastSyncAt?: string;
  lastSuccessfulSyncAt?: string;
  lastErrorCode?: string;
  syncBlockReason?:
    'local-remote-conflict' | 'rollback-detected' | 'fork-detected' | 'integrity-failure';
}

export interface SyncCheckpointRecord {
  id: typeof SYNC_CHECKPOINT_RECORD_ID;
  vaultId: string;
  replacedSnapshotRevision: number;
  data: FinanceData;
  createdAt: string;
}

export interface LocalSyncSetup {
  vault: SyncVaultRecord;
  device: SyncDeviceRecord;
  vaultKey: SyncKeyRecord;
  metadata: SyncMetadataRecord;
}
