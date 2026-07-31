export const SYNC_PROTOCOL_VERSION = 1 as const;

export const SYNC_CRYPTO_SUITE = 'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1' as const;

export const SYNC_OBJECT_TYPES = [
  'local-vault-key',
  'recovery-vault-key',
  'pairing-vault-key',
  'snapshot',
  'operation',
  'device-key-envelope',
] as const;

export type SyncObjectType = (typeof SYNC_OBJECT_TYPES)[number];

export const SYNC_LIMITS = Object.freeze({
  vaultIdBytes: 16,
  objectIdBytes: 16,
  deviceIdBytes: 16,
  pairingSecretBytes: 32,
  pairingSaltBytes: 32,
  pollingTokenBytes: 32,
  accessTokenBytes: 32,
  challengeBytes: 32,
  vaultMasterKeyBytes: 32,
  recoveryRootBytes: 32,
  recoveryLookupIdBytes: 16,
  aesGcmNonceBytes: 12,
  maxDevicesPerVault: 10,
  maxActivePairingsPerVault: 3,
  pairingLifetimeMs: 5 * 60 * 1_000,
  challengeLifetimeMs: 2 * 60 * 1_000,
  accessSessionLifetimeMs: 15 * 60 * 1_000,
  deviceAuthorizationLifetimeMs: 30 * 24 * 60 * 60 * 1_000,
  authorizationWarningMs: 5 * 24 * 60 * 60 * 1_000,
  maxPairingAttempts: 5,
  maxRecoveryAttempts: 5,
  maxSnapshotBytes: 8 * 1_024 * 1_024,
  maxOperationBytes: 64 * 1_024,
  maxOperationsPerBatch: 100,
  maxRetainedSnapshots: 3,
  orphanLifetimeMs: 60 * 60 * 1_000,
});

export const SYNC_HKDF_LABELS = Object.freeze({
  snapshot: 'MIRNA-E2EE-V1/snapshot-object-key',
  operation: 'MIRNA-E2EE-V1/operation-object-key',
  recoveryWrapping: 'MIRNA-E2EE-V1/recovery-wrap-key',
  recoveryAuthentication: 'MIRNA-E2EE-V1/recovery-server-gate-key',
  pairingWrapping: 'MIRNA-E2EE-V1/pairing-vmk-envelope-key',
  pairingConfirmation: 'MIRNA-E2EE-V1/pairing-key-confirmation',
  pairingClaim: 'MIRNA-E2EE-V1/pairing-claim-token',
  pairingTranscriptMac: 'MIRNA-E2EE-V1/pairing-transcript-mac-key',
  pairingSas: 'MIRNA-E2EE-V1/pairing-sas-key',
  deviceEnvelope: 'MIRNA-E2EE-V1/device-envelope-key',
});

export const SYNC_DOMAIN_LABELS = Object.freeze({
  manifestBody: 'MIRNA-E2EE-V1/manifest-body',
  objectSalt: 'MIRNA-E2EE-V1/object-salt',
  pairingContext: 'MIRNA-E2EE-V1/pairing-context',
  pairingTranscriptMac: 'MIRNA-E2EE-V1/pairing-transcript-mac',
  pairingSas: 'MIRNA-E2EE-V1/pairing-sas',
  pairingClaimHash: 'MIRNA-E2EE-V1/pairing-claim-hash',
  pairingCode: 'MIRNA-E2EE-V1/pairing-code',
  pairingConfirmation: 'MIRNA-E2EE-V1/pairing-key-confirmation',
  authChallenge: 'MIRNA-E2EE-V1/auth-challenge',
  authChallengeHash: 'MIRNA-E2EE-V1/auth-challenge-hash',
  accessTokenHash: 'MIRNA-E2EE-V1/access-token-hash',
  pollingTokenHash: 'MIRNA-E2EE-V1/polling-token-hash',
  pairingEnvelope: 'MIRNA-E2EE-V1/pairing-envelope',
  pairingEnvelopeHash: 'MIRNA-E2EE-V1/pairing-envelope-hash',
  pairingFinalize: 'MIRNA-E2EE-V1/pairing-finalize',
  recoveryGateHash: 'MIRNA-E2EE-V1/recovery-gate-key-hash',
  recoveryChallengeHash: 'MIRNA-E2EE-V1/recovery-challenge-hash',
  recoveryRecord: 'MIRNA-E2EE-V1/recovery-record',
  recoveryTransition: 'MIRNA-E2EE-V1/recovery-transition',
  recoveryProof: 'MIRNA-E2EE-V1/recovery-proof',
  recoveryCompleteRequest: 'MIRNA-E2EE-V1/recovery-complete-request',
  recoveryIdempotencyHash: 'MIRNA-E2EE-V1/recovery-idempotency-hash',
  recoveryCode: 'MIRNA-RECOVERY-CODE-V1',
});

export const SYNC_TRANSCRIPT_TYPES = Object.freeze({
  authChallenge: 'mirna-auth-challenge-v1',
  manifest: 'mirna-vault-manifest-v1',
  pairingEnvelope: 'mirna-pairing-envelope-v1',
  pairingFinalize: 'mirna-pairing-finalize-v1',
  sensitiveRequest: 'mirna-sensitive-request-v1',
  snapshotEnvelope: 'mirna-snapshot-envelope-v1',
  operationEnvelope: 'mirna-operation-envelope-v1',
  recoveryProof: 'mirna-recovery-proof-v1',
  recoveryChallenge: 'mirna-recovery-challenge-v1',
  recoveryBundleFetch: 'mirna-recovery-bundle-fetch-v1',
});
