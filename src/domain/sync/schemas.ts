import { z } from 'zod';
import { SYNC_CRYPTO_SUITE, SYNC_PROTOCOL_VERSION, SYNC_TRANSCRIPT_TYPES } from './constants';

const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u);
export const opaqueIdSchema = base64Url.length(22);
export const sha256Schema = base64Url.length(43);
export const signatureSchema = base64Url.length(86);
export const aesGcmNonceSchema = base64Url.length(16);
export const timestampSchema = z.string().datetime();
export const protocolVersionSchema = z.literal(SYNC_PROTOCOL_VERSION);
export const cryptoSuiteSchema = z.literal(SYNC_CRYPTO_SUITE);

export const publicEcKeySchema = z.strictObject({
  format: z.literal('raw-p256'),
  value: base64Url.length(87),
});

export const devicePublicKeysSchema = z.strictObject({
  signing: publicEcKeySchema,
  agreement: publicEcKeySchema,
});

export const manifestDeviceSchema = z.strictObject({
  deviceId: opaqueIdSchema,
  publicKeys: devicePublicKeysSchema,
  authorizedAt: timestampSchema,
  authorizationExpiresAt: timestampSchema,
});

export const revokedManifestDeviceSchema = z.strictObject({
  deviceId: opaqueIdSchema,
  publicKeys: devicePublicKeysSchema,
  revokedAt: timestampSchema,
  revocationAuthority: z.enum(['device', 'recovery']),
  revokedByDeviceId: opaqueIdSchema.nullable(),
  lastAuthorizedManifestVersion: z.number().int().positive(),
});

export const manifestTransitionSchema = z.strictObject({
  transitionId: opaqueIdSchema,
  kind: z.enum([
    'create',
    'add-device',
    'renew-device',
    'revoke-device',
    'rotate-key',
    'recover-device',
    'rotate-recovery',
  ]),
  authorizationKind: z.enum(['device', 'recovery']),
  authorizingDeviceId: opaqueIdSchema.nullable(),
  affectedDeviceId: opaqueIdSchema,
  occurredAt: timestampSchema,
});

export const unsignedVaultManifestSchema = z.strictObject({
  type: z.literal(SYNC_TRANSCRIPT_TYPES.manifest),
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  vaultId: opaqueIdSchema,
  manifestVersion: z.number().int().positive(),
  keyEpoch: z.number().int().positive(),
  devices: z.array(manifestDeviceSchema).max(10),
  revokedDevices: z.array(revokedManifestDeviceSchema).max(100),
  recoveryLookupId: opaqueIdSchema,
  recoverySigningPublicKey: publicEcKeySchema,
  previousManifestHash: sha256Schema.nullable(),
  transition: manifestTransitionSchema,
});

export const vaultManifestSchema = unsignedVaultManifestSchema.extend({
  signature: signatureSchema,
});

export const encryptedKeyAadSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  vaultId: opaqueIdSchema,
  keyEpoch: z.number().int().positive(),
  objectType: z.enum(['local-vault-key', 'recovery-vault-key', 'pairing-vault-key']),
  objectId: opaqueIdSchema,
  creatingDeviceId: opaqueIdSchema,
  recoveryLookupId: opaqueIdSchema.nullable(),
  parentManifestHash: sha256Schema.nullable(),
});

export const encryptedKeyEnvelopeSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  vaultId: opaqueIdSchema,
  keyEpoch: z.number().int().positive(),
  objectId: opaqueIdSchema,
  nonce: aesGcmNonceSchema,
  aad: encryptedKeyAadSchema,
  ciphertext: base64Url.min(1),
});

export const recoveryRecordSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  vaultId: opaqueIdSchema,
  recoveryLookupId: opaqueIdSchema,
  keyEpoch: z.number().int().positive(),
  recoveryEnvelope: encryptedKeyEnvelopeSchema,
  recoverySigningPublicKey: publicEcKeySchema,
  recoveryGateKeyHash: sha256Schema,
  manifestVersion: z.number().int().positive(),
  manifestHash: sha256Schema,
  updatedAt: timestampSchema,
});

export const recoveryBundleSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  vaultId: opaqueIdSchema,
  recoveryLookupId: opaqueIdSchema,
  keyEpoch: z.number().int().positive(),
  vaultMasterKey: base64Url.length(43),
  recoverySigningPrivateKeyPkcs8: base64Url.min(100).max(512),
  recoverySigningPublicKey: publicEcKeySchema,
  pinnedManifest: vaultManifestSchema,
  pinnedManifestHash: sha256Schema,
});

export const authChallengeRequestSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  vaultId: opaqueIdSchema,
  deviceId: opaqueIdSchema,
  audience: z.enum([
    '/v1/auth/session',
    '/v1/pairings/approve',
    '/v1/pairings/cancel',
    '/v1/devices/renew',
    '/v1/devices/revoke',
    '/v1/recovery/rotate',
    '/v1/vault/delete',
  ]),
  origin: z.string().url().max(512),
});

export const authChallengeSchema = z.strictObject({
  type: z.literal(SYNC_TRANSCRIPT_TYPES.authChallenge),
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  vaultId: opaqueIdSchema,
  deviceId: opaqueIdSchema,
  challengeId: opaqueIdSchema,
  challenge: base64Url.length(43),
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  audience: authChallengeRequestSchema.shape.audience,
  origin: authChallengeRequestSchema.shape.origin,
  method: z.literal('POST'),
});

export const authSessionRequestSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  challenge: authChallengeSchema,
  signature: signatureSchema,
});

export const authSessionResponseSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  accessToken: base64Url.length(43),
  expiresAt: timestampSchema,
  authorizationExpiresAt: timestampSchema,
});

export const pairingCreateRequestSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  requestId: opaqueIdSchema,
  deviceId: opaqueIdSchema,
  publicKeys: devicePublicKeysSchema,
  pairingSalt: base64Url.length(43),
  pairingClaimTokenHash: sha256Schema,
  pollingTokenHash: sha256Schema,
});

export const pairingCreateResponseSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  requestId: opaqueIdSchema,
  expiresAt: timestampSchema,
});

export const pairingInspectRequestSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  claimToken: base64Url.length(43),
});

export const pairingCandidateSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  requestId: opaqueIdSchema,
  deviceId: opaqueIdSchema,
  publicKeys: devicePublicKeysSchema,
  pairingSalt: base64Url.length(43),
  expiresAt: timestampSchema,
});

export const pairingContextSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  origin: z.string().url().max(512),
  vaultId: opaqueIdSchema,
  keyEpoch: z.number().int().positive(),
  pairingRequestId: opaqueIdSchema,
  pairingExpiresAt: timestampSchema,
  currentManifestVersion: z.number().int().positive(),
  currentManifestHash: sha256Schema,
  snapshotCommitId: opaqueIdSchema.nullable(),
  operationFrontierHash: sha256Schema.nullable(),
  newDeviceId: opaqueIdSchema,
  newDevicePublicKeys: devicePublicKeysSchema,
  authorizingDeviceId: opaqueIdSchema,
  authorizingDevicePublicKeys: devicePublicKeysSchema,
  ephemeralAgreementPublicKey: publicEcKeySchema,
  ecdhSalt: base64Url.length(43),
});

export const pairingEnvelopeAadSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  vaultId: opaqueIdSchema,
  keyEpoch: z.number().int().positive(),
  objectType: z.literal('pairing-vault-key'),
  objectId: opaqueIdSchema,
  creatingDeviceId: opaqueIdSchema,
  recoveryLookupId: z.null(),
  parentManifestHash: sha256Schema,
  pairingContextHash: sha256Schema,
});

export const unsignedPairingEnvelopeSchema = z.strictObject({
  type: z.literal(SYNC_TRANSCRIPT_TYPES.pairingEnvelope),
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  context: pairingContextSchema,
  nonce: aesGcmNonceSchema,
  aad: pairingEnvelopeAadSchema,
  ciphertext: base64Url.min(1),
  ciphertextHash: sha256Schema,
  ciphertextLength: z.number().int().min(16).max(65_536),
  candidateManifestHash: sha256Schema,
});

export const pairingEnvelopeSchema = unsignedPairingEnvelopeSchema.extend({
  signature: signatureSchema,
  transcriptMac: sha256Schema,
  keyConfirmation: sha256Schema,
});

export const pairingApprovalSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  pairingRequestId: opaqueIdSchema,
  claimToken: base64Url.length(43),
  envelope: pairingEnvelopeSchema,
  candidateManifest: vaultManifestSchema,
  sensitiveChallenge: authChallengeSchema,
  sensitiveSignature: signatureSchema,
  approverSasConfirmed: z.literal(true),
});

export const pairingPollRequestSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  pollingToken: base64Url.length(43),
});

export const pairingCancelRequestSchema = pairingPollRequestSchema;

export const pairingPollResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    protocolVersion: protocolVersionSchema,
    status: z.literal('pending'),
    expiresAt: timestampSchema,
  }),
  z.strictObject({
    protocolVersion: protocolVersionSchema,
    status: z.literal('approved'),
    expiresAt: timestampSchema,
    envelope: pairingEnvelopeSchema,
    candidateManifest: vaultManifestSchema,
  }),
  z.strictObject({
    protocolVersion: protocolVersionSchema,
    status: z.enum(['cancelled', 'expired', 'consumed']),
    expiresAt: timestampSchema,
  }),
]);

export const pairingFinalizeTranscriptSchema = z.strictObject({
  type: z.literal(SYNC_TRANSCRIPT_TYPES.pairingFinalize),
  protocolVersion: protocolVersionSchema,
  vaultId: opaqueIdSchema,
  pairingRequestId: opaqueIdSchema,
  newDeviceId: opaqueIdSchema,
  candidateManifestHash: sha256Schema,
  envelopeHash: sha256Schema,
  keyConfirmation: sha256Schema,
  sasConfirmed: z.literal(true),
  confirmedAt: timestampSchema,
});

export const pairingFinalizeRequestSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  pollingToken: base64Url.length(43),
  transcript: pairingFinalizeTranscriptSchema,
  signature: signatureSchema,
});

export const pairingFinalizeResponseSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  vaultId: opaqueIdSchema,
  deviceId: opaqueIdSchema,
  manifestVersion: z.number().int().positive(),
  finalized: z.boolean(),
});

export const vaultCreateRequestSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  manifest: vaultManifestSchema,
  recovery: recoveryRecordSchema,
});

export const vaultCreateResponseSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  vaultId: opaqueIdSchema,
  manifestVersion: z.number().int().positive(),
  manifestHash: sha256Schema,
  created: z.boolean(),
});

export const recoveryProofTranscriptSchema = z.strictObject({
  type: z.literal(SYNC_TRANSCRIPT_TYPES.recoveryProof),
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  purpose: z.literal('recovery-manifest-transition'),
  vaultId: opaqueIdSchema,
  recoveryLookupId: opaqueIdSchema,
  challengeId: opaqueIdSchema,
  challenge: base64Url.length(43),
  newDeviceId: opaqueIdSchema,
  newDevicePublicKeys: devicePublicKeysSchema,
  previousManifestVersion: z.number().int().positive(),
  previousManifestHash: sha256Schema,
  transitionBodyHash: sha256Schema,
  newRecoveryBundleHash: sha256Schema,
  newRecoveryLookupId: opaqueIdSchema,
  idempotencyKey: opaqueIdSchema,
  origin: z.string().url().max(512),
  method: z.literal('POST'),
  path: z.string().regex(/^\/v1\/vaults\/[A-Za-z0-9_-]{22}\/recover$/u),
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
});

export const recoveryChallengeRequestSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  recoveryLookupId: opaqueIdSchema,
  newDeviceId: opaqueIdSchema,
  newDevicePublicKeys: devicePublicKeysSchema,
  origin: z.string().url().max(512),
});

export const recoveryChallengeSchema = z.strictObject({
  type: z.literal(SYNC_TRANSCRIPT_TYPES.recoveryChallenge),
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  recoveryLookupId: opaqueIdSchema,
  vaultId: opaqueIdSchema,
  challengeId: opaqueIdSchema,
  challenge: base64Url.length(43),
  newDeviceId: opaqueIdSchema,
  newDevicePublicKeys: devicePublicKeysSchema,
  previousManifestVersion: z.number().int().positive(),
  previousManifestHash: sha256Schema,
  origin: z.string().url().max(512),
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
});

export const recoveryBundleFetchTranscriptSchema = z.strictObject({
  type: z.literal(SYNC_TRANSCRIPT_TYPES.recoveryBundleFetch),
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  challenge: recoveryChallengeSchema,
  afterManifestVersion: z.number().int().positive().nullable(),
});

export const recoveryBundleFetchRequestSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  gateKey: base64Url.length(43),
  transcript: recoveryBundleFetchTranscriptSchema,
  gateProof: sha256Schema,
});

export const recoveryBundleFetchResponseSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  recoveryEnvelope: encryptedKeyEnvelopeSchema,
  manifestChain: z.array(vaultManifestSchema).min(1).max(25),
  nextAfterManifestVersion: z.number().int().positive().nullable(),
});

export const recoveryCompleteRequestSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  gateKey: base64Url.length(43),
  transcript: recoveryProofTranscriptSchema,
  gateProof: sha256Schema,
  recoveryAuthorizationSignature: signatureSchema,
  newManifest: vaultManifestSchema,
  newRecovery: recoveryRecordSchema,
});

export const recoveryCompleteResponseSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  vaultId: opaqueIdSchema,
  deviceId: opaqueIdSchema,
  manifestVersion: z.number().int().positive(),
  recovered: z.boolean(),
});

export type PublicEcKeyV1 = z.infer<typeof publicEcKeySchema>;
export type DevicePublicKeysV1 = z.infer<typeof devicePublicKeysSchema>;
export type ManifestDeviceV1 = z.infer<typeof manifestDeviceSchema>;
export type UnsignedVaultManifestV1 = z.infer<typeof unsignedVaultManifestSchema>;
export type VaultManifestV1 = z.infer<typeof vaultManifestSchema>;
export type EncryptedKeyAadV1 = z.infer<typeof encryptedKeyAadSchema>;
export type EncryptedKeyEnvelopeV1 = z.infer<typeof encryptedKeyEnvelopeSchema>;
export type RecoveryRecordV1 = z.infer<typeof recoveryRecordSchema>;
export type RecoveryBundleV1 = z.infer<typeof recoveryBundleSchema>;
export type AuthChallengeV1 = z.infer<typeof authChallengeSchema>;
export type PairingCandidateV1 = z.infer<typeof pairingCandidateSchema>;
export type PairingContextV1 = z.infer<typeof pairingContextSchema>;
export type UnsignedPairingEnvelopeV1 = z.infer<typeof unsignedPairingEnvelopeSchema>;
export type PairingEnvelopeV1 = z.infer<typeof pairingEnvelopeSchema>;
export type PairingApprovalV1 = z.infer<typeof pairingApprovalSchema>;
export type PairingFinalizeTranscriptV1 = z.infer<typeof pairingFinalizeTranscriptSchema>;
