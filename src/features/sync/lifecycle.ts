import { canonicalizeJson } from '@/domain/sync/canonical';
import {
  SYNC_CRYPTO_SUITE,
  SYNC_DOMAIN_LABELS,
  SYNC_LIMITS,
  SYNC_PROTOCOL_VERSION,
} from '@/domain/sync/constants';
import {
  createEncryptedKeyEnvelope,
  createEncryptedRecoveryBundleEnvelope,
  createOpaqueId,
  createPairingCode,
  createPairingKeyConfirmation,
  createPairingQrPayload,
  createPairingTranscriptMac,
  createRecoveryCode,
  createRecoveryProof,
  decryptAesGcm,
  derivePairingAgreementKeys,
  derivePairingSecrets,
  deriveRecoveryKeys,
  deriveShortAuthenticationString,
  encryptAesGcm,
  exportPublicEcKey,
  exportRecoverySigningPrivateKey,
  generateDeviceKeyPairs,
  generateEphemeralAgreementKeyPair,
  generateLocalWrappingKey,
  generateRecoverySigningKeyPair,
  hashDomainSeparatedCanonical,
  hashPairingClaimToken,
  hashRecoveryGateKey,
  importAgreementPublicKey,
  importRecoverySigningPrivateKey,
  importSigningPublicKey,
  openEncryptedKeyEnvelope,
  openEncryptedRecoveryBundleEnvelope,
  parsePairingCode,
  parsePairingQrPayload,
  parseRecoveryCode,
  randomBytes,
  sha256,
  signDomainSeparatedCanonical,
  verifyDomainSeparatedCanonicalSignature,
  verifyPairingKeyConfirmation,
  verifyPairingTranscriptMac,
  type CryptoRuntime,
  type DeviceKeyPairs,
} from '@/domain/sync/crypto';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  clearBytes,
  concatBytes,
  utf8,
} from '@/domain/sync/encoding';
import {
  assertManifestAgainstPin,
  createInitialManifest,
  manifestBodyHash,
  signVaultManifest,
  validateManifestTransition,
  verifyInitialManifest,
} from '@/domain/sync/manifest';
import {
  authChallengeSchema,
  pairingApprovalSchema,
  pairingCandidateSchema,
  pairingCreateRequestSchema,
  pairingCreateResponseSchema,
  pairingFinalizeRequestSchema,
  pairingFinalizeResponseSchema,
  pairingInspectRequestSchema,
  pairingPollRequestSchema,
  pairingPollResponseSchema,
  recoveryBundleFetchRequestSchema,
  recoveryBundleFetchResponseSchema,
  recoveryChallengeRequestSchema,
  recoveryChallengeSchema,
  recoveryCompleteRequestSchema,
  recoveryCompleteResponseSchema,
  recoveryRecordSchema,
  unsignedPairingEnvelopeSchema,
  unsignedVaultManifestSchema,
  vaultCreateRequestSchema,
  vaultCreateResponseSchema,
  vaultManifestSchema,
  type AuthChallengeV1,
  type DevicePublicKeysV1,
  type ManifestDeviceV1,
  type PairingCandidateV1,
  type PairingEnvelopeV1,
  type RecoveryBundleV1,
  type RecoveryRecordV1,
  type UnsignedPairingEnvelopeV1,
  type UnsignedVaultManifestV1,
  type VaultManifestV1,
} from '@/domain/sync/schemas';
import { readLocalSyncSetup, writeLocalSyncSetup } from '@/db/sync/repository';
import {
  ACTIVE_SYNC_VAULT_RECORD_ID,
  LOCAL_SYNC_DEVICE_RECORD_ID,
  SYNC_METADATA_RECORD_ID,
  localVaultKeyRecordId,
  type LocalSyncSetup,
} from '@/db/sync/records';

type Parsed<T extends { parse(value: unknown): unknown }> = ReturnType<T['parse']>;

export type VaultCreateRequestV1 = Parsed<typeof vaultCreateRequestSchema>;
export type VaultCreateResponseV1 = Parsed<typeof vaultCreateResponseSchema>;
export type PairingCreateRequestV1 = Parsed<typeof pairingCreateRequestSchema>;
export type PairingCreateResponseV1 = Parsed<typeof pairingCreateResponseSchema>;
export type PairingPollResponseV1 = Parsed<typeof pairingPollResponseSchema>;
export type PairingApprovalRequestV1 = Parsed<typeof pairingApprovalSchema>;
export type PairingFinalizeRequestV1 = Parsed<typeof pairingFinalizeRequestSchema>;
export type PairingFinalizeResponseV1 = Parsed<typeof pairingFinalizeResponseSchema>;
export type PairingInspectRequestV1 = Parsed<typeof pairingInspectRequestSchema>;
export type PairingPollRequestV1 = Parsed<typeof pairingPollRequestSchema>;
export type RecoveryChallengeRequestV1 = Parsed<typeof recoveryChallengeRequestSchema>;
export type RecoveryBundleFetchRequestV1 = Parsed<typeof recoveryBundleFetchRequestSchema>;
export type RecoveryCompleteRequestV1 = Parsed<typeof recoveryCompleteRequestSchema>;

export interface SyncPhase1ApiPort {
  createVault(request: VaultCreateRequestV1): Promise<unknown>;
  createPairing(request: PairingCreateRequestV1): Promise<unknown>;
  inspectPairing(pairingRequestId: string, request: PairingInspectRequestV1): Promise<unknown>;
  pollPairing(pairingRequestId: string, request: PairingPollRequestV1): Promise<unknown>;
  cancelPairing(pairingRequestId: string, request: PairingPollRequestV1): Promise<unknown>;
  requestAuthChallenge(request: {
    protocolVersion: typeof SYNC_PROTOCOL_VERSION;
    suite: typeof SYNC_CRYPTO_SUITE;
    vaultId: string;
    deviceId: string;
    audience: AuthChallengeV1['audience'];
    origin: string;
  }): Promise<unknown>;
  createSession(request: {
    protocolVersion: typeof SYNC_PROTOCOL_VERSION;
    challenge: AuthChallengeV1;
    signature: string;
  }): Promise<unknown>;
  clearSession(): void;
  getCurrentManifest(): Promise<unknown>;
  approvePairing(pairingRequestId: string, request: PairingApprovalRequestV1): Promise<unknown>;
  finalizePairing(pairingRequestId: string, request: PairingFinalizeRequestV1): Promise<unknown>;
  requestRecoveryChallenge(request: RecoveryChallengeRequestV1): Promise<unknown>;
  fetchRecoveryBundle(request: RecoveryBundleFetchRequestV1): Promise<unknown>;
  completeRecovery(vaultId: string, request: RecoveryCompleteRequestV1): Promise<unknown>;
}

export interface SyncLifecycleRepositoryPort {
  read(): Promise<LocalSyncSetup | undefined>;
  write(setup: LocalSyncSetup): Promise<void>;
}

const defaultRepository: SyncLifecycleRepositoryPort = {
  read: () => readLocalSyncSetup(),
  write: (setup) => writeLocalSyncSetup(setup),
};

export type SyncLifecycleErrorCode =
  | 'invalid-state'
  | 'invalid-origin'
  | 'invalid-device-name'
  | 'recovery-confirmation-mismatch'
  | 'server-ack-mismatch'
  | 'challenge-mismatch'
  | 'manifest-mismatch'
  | 'pairing-mismatch'
  | 'sas-mismatch'
  | 'pairing-ended'
  | 'recovery-chain-invalid'
  | 'recovery-expired'
  | 'local-vault-exists';

export class SyncLifecycleError extends Error {
  readonly code: SyncLifecycleErrorCode;

  constructor(code: SyncLifecycleErrorCode, message: string) {
    super(message);
    this.name = 'SyncLifecycleError';
    this.code = code;
  }
}

export interface RecoveryConfirmationValue {
  readonly groupNumber: number;
  readonly value: string;
}

export interface RecoveryCodePresentation {
  readonly recoveryCode: string;
  readonly confirmationGroupNumbers: readonly number[];
}

export type RecoveryConfirmationSelector = (
  groupCount: number,
  runtime: CryptoRuntime,
) => readonly number[];

interface CommonDependencies {
  readonly api: SyncPhase1ApiPort;
  readonly origin: string;
  readonly repository?: SyncLifecycleRepositoryPort;
  readonly runtime?: CryptoRuntime;
  readonly now?: () => Date;
  readonly selectRecoveryConfirmationGroups?: RecoveryConfirmationSelector;
}

interface ResolvedDependencies {
  readonly api: SyncPhase1ApiPort;
  readonly origin: string;
  readonly repository: SyncLifecycleRepositoryPort;
  readonly runtime: CryptoRuntime;
  readonly now: () => Date;
  readonly selectRecoveryConfirmationGroups: RecoveryConfirmationSelector;
}

const deviceIdComparator = (left: { deviceId: string }, right: { deviceId: string }): number =>
  left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0;

const exactOrigin = (value: string): string => {
  try {
    const parsed = new URL(value);
    if (
      parsed.origin !== value ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      (parsed.protocol !== 'https:' &&
        !(parsed.protocol === 'http:' && parsed.hostname === 'localhost'))
    ) {
      throw new Error('origin');
    }
    return value;
  } catch {
    throw new SyncLifecycleError('invalid-origin', 'Sinhronizacija zahteva tačan HTTPS origin.');
  }
};

const defaultConfirmationSelector: RecoveryConfirmationSelector = (groupCount, runtime) => {
  const wanted = Math.min(3, groupCount);
  const selected = new Set<number>();
  while (selected.size < wanted) {
    selected.add((randomBytes(1, runtime)[0] % groupCount) + 1);
  }
  return [...selected].sort((left, right) => left - right);
};

const resolveDependencies = (dependencies: CommonDependencies): ResolvedDependencies => {
  const runtime = dependencies.runtime ?? globalThis.crypto;
  if (!runtime?.subtle || typeof runtime.getRandomValues !== 'function') {
    throw new Error('Ovaj pregledač ne podržava bezbednu šifrovanu sinhronizaciju.');
  }
  return {
    api: dependencies.api,
    origin: exactOrigin(dependencies.origin),
    repository: dependencies.repository ?? defaultRepository,
    runtime,
    now: dependencies.now ?? (() => new Date()),
    selectRecoveryConfirmationGroups:
      dependencies.selectRecoveryConfirmationGroups ?? defaultConfirmationSelector,
  };
};

const normalizeDeviceName = (value: string): string => {
  const normalized = value.trim().replaceAll(/\s+/gu, ' ');
  if (normalized.length === 0 || normalized.length > 80) {
    throw new SyncLifecycleError(
      'invalid-device-name',
      'Naziv uređaja mora imati između 1 i 80 znakova.',
    );
  }
  return normalized;
};

const addMilliseconds = (date: Date, milliseconds: number): string =>
  new Date(date.getTime() + milliseconds).toISOString();

const recoveryGroups = (code: string): readonly string[] => {
  const groups = code.slice('MR1-'.length).split('-');
  if (groups.some((group) => group.length === 0)) throw new Error('Recovery kod je neispravan.');
  return groups;
};

const assertConfirmationSelection = (
  groupCount: number,
  groupNumbers: readonly number[],
): readonly number[] => {
  const unique = [...new Set(groupNumbers)].sort((left, right) => left - right);
  if (
    unique.length === 0 ||
    unique.length !== groupNumbers.length ||
    unique.some((value) => !Number.isSafeInteger(value) || value < 1 || value > groupCount)
  ) {
    throw new Error('Izbor grupa za potvrdu recovery koda nije ispravan.');
  }
  return unique;
};

const verifyRecoveryConfirmation = (
  recoveryCode: string,
  expectedGroupNumbers: readonly number[],
  supplied: readonly RecoveryConfirmationValue[],
): void => {
  const groups = recoveryGroups(recoveryCode);
  const suppliedMap = new Map(
    supplied.map((entry) => [entry.groupNumber, entry.value.trim().toUpperCase()]),
  );
  const exactSelection =
    suppliedMap.size === expectedGroupNumbers.length &&
    supplied.length === expectedGroupNumbers.length &&
    expectedGroupNumbers.every(
      (groupNumber) => suppliedMap.get(groupNumber) === groups[groupNumber - 1],
    );
  if (!exactSelection) {
    throw new SyncLifecycleError(
      'recovery-confirmation-mismatch',
      'Unete grupe recovery koda se ne poklapaju.',
    );
  }
};

const publicDeviceKeys = async (
  keyPairs: DeviceKeyPairs,
  runtime: CryptoRuntime,
): Promise<DevicePublicKeysV1> => ({
  signing: await exportPublicEcKey(keyPairs.signing.publicKey, runtime),
  agreement: await exportPublicEcKey(keyPairs.agreement.publicKey, runtime),
});

const createManifestDevice = async (input: {
  deviceId: string;
  keyPairs: DeviceKeyPairs;
  authorizedAt: string;
  authorizationExpiresAt: string;
  runtime: CryptoRuntime;
}): Promise<ManifestDeviceV1> => ({
  deviceId: input.deviceId,
  publicKeys: await publicDeviceKeys(input.keyPairs, input.runtime),
  authorizedAt: input.authorizedAt,
  authorizationExpiresAt: input.authorizationExpiresAt,
});

const createLocalSetup = async (input: {
  manifest: VaultManifestV1;
  manifestHash: string;
  device: ManifestDeviceV1;
  displayName: string;
  deviceKeys: DeviceKeyPairs;
  localWrappingKey: CryptoKey;
  vaultMasterKey: Uint8Array;
  enabledAt: string;
  runtime: CryptoRuntime;
}): Promise<LocalSyncSetup> => {
  const localObjectId = createOpaqueId(input.runtime);
  const encryptedKey = await createEncryptedKeyEnvelope(
    input.vaultMasterKey,
    input.localWrappingKey,
    {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: input.manifest.vaultId,
      keyEpoch: input.manifest.keyEpoch,
      objectType: 'local-vault-key',
      objectId: localObjectId,
      creatingDeviceId: input.device.deviceId,
      recoveryLookupId: null,
      parentManifestHash: input.manifestHash,
    },
    input.runtime,
  );
  return {
    vault: {
      id: ACTIVE_SYNC_VAULT_RECORD_ID,
      vaultId: input.manifest.vaultId,
      protocolVersion: input.manifest.protocolVersion,
      cryptoSuite: input.manifest.suite,
      keyEpoch: input.manifest.keyEpoch,
      status: 'active',
      manifest: input.manifest,
      createdAt: input.enabledAt,
      updatedAt: input.enabledAt,
    },
    device: {
      id: LOCAL_SYNC_DEVICE_RECORD_ID,
      vaultId: input.manifest.vaultId,
      deviceId: input.device.deviceId,
      displayName: input.displayName,
      signingPrivateKey: input.deviceKeys.signing.privateKey,
      signingPublicKey: input.deviceKeys.signing.publicKey,
      agreementPrivateKey: input.deviceKeys.agreement.privateKey,
      agreementPublicKey: input.deviceKeys.agreement.publicKey,
      localWrappingKey: input.localWrappingKey,
      authorizationExpiresAt: input.device.authorizationExpiresAt,
      createdAt: input.enabledAt,
      updatedAt: input.enabledAt,
    },
    vaultKey: {
      id: localVaultKeyRecordId(input.manifest.vaultId, input.manifest.keyEpoch),
      vaultId: input.manifest.vaultId,
      keyEpoch: input.manifest.keyEpoch,
      purpose: 'vault-master-key',
      encryptedKey,
      createdAt: input.enabledAt,
    },
    metadata: {
      id: SYNC_METADATA_RECORD_ID,
      vaultId: input.manifest.vaultId,
      localSchemaVersion: 1,
      firstUploadConsent: 'pending',
      lastServerCursor: 0,
      enabledAt: input.enabledAt,
    },
  };
};

const sameCanonicalValue = (left: unknown, right: unknown): boolean =>
  canonicalizeJson(left) === canonicalizeJson(right);

const withoutManifestSignature = (manifest: VaultManifestV1): UnsignedVaultManifestV1 => {
  const { signature: _signature, ...unsigned } = manifest;
  void _signature;
  return unsignedVaultManifestSchema.parse(unsigned);
};

const withoutPairingAuthenticators = (envelope: PairingEnvelopeV1): UnsignedPairingEnvelopeV1 => {
  const {
    signature: _signature,
    transcriptMac: _transcriptMac,
    keyConfirmation: _keyConfirmation,
    ...unsigned
  } = envelope;
  void _signature;
  void _transcriptMac;
  void _keyConfirmation;
  return unsignedPairingEnvelopeSchema.parse(unsigned);
};

const pairingConfirmationTranscript = (
  unsignedEnvelope: UnsignedPairingEnvelopeV1,
  signature: string,
  transcriptMac: string,
) => ({
  type: 'mirna-pairing-key-confirmation-v1' as const,
  protocolVersion: SYNC_PROTOCOL_VERSION,
  unsignedEnvelope,
  signature,
  transcriptMac,
});

const hashPollingToken = async (
  pollingToken: Uint8Array,
  runtime: CryptoRuntime,
): Promise<string> =>
  bytesToBase64Url(
    await sha256(
      concatBytes(utf8(SYNC_DOMAIN_LABELS.pollingTokenHash), Uint8Array.of(0), pollingToken),
      runtime,
    ),
  );

const assertChallengeMatches = (
  challenge: AuthChallengeV1,
  expected: {
    vaultId: string;
    deviceId: string;
    audience: AuthChallengeV1['audience'];
    origin: string;
  },
  now: Date,
): void => {
  if (
    challenge.vaultId !== expected.vaultId ||
    challenge.deviceId !== expected.deviceId ||
    challenge.audience !== expected.audience ||
    challenge.origin !== expected.origin ||
    challenge.method !== 'POST' ||
    Date.parse(challenge.issuedAt) > now.getTime() ||
    Date.parse(challenge.expiresAt) <= now.getTime()
  ) {
    throw new SyncLifecycleError(
      'challenge-mismatch',
      'Server je vratio challenge koji ne pripada očekivanoj radnji.',
    );
  }
};

const requestSignedChallenge = async (
  dependencies: ResolvedDependencies,
  setup: LocalSyncSetup,
  audience: AuthChallengeV1['audience'],
): Promise<{ challenge: AuthChallengeV1; signature: string }> => {
  const request = {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    vaultId: setup.vault.vaultId,
    deviceId: setup.device.deviceId,
    audience,
    origin: dependencies.origin,
  } as const;
  const challenge = authChallengeSchema.parse(await dependencies.api.requestAuthChallenge(request));
  assertChallengeMatches(challenge, request, dependencies.now());
  return {
    challenge,
    signature: await signDomainSeparatedCanonical(
      SYNC_DOMAIN_LABELS.authChallenge,
      challenge,
      setup.device.signingPrivateKey,
      dependencies.runtime,
    ),
  };
};

const createAccessSession = async (
  dependencies: ResolvedDependencies,
  setup: LocalSyncSetup,
): Promise<void> => {
  const signed = await requestSignedChallenge(dependencies, setup, '/v1/auth/session');
  try {
    const response: unknown = await dependencies.api.createSession({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      ...signed,
    });
    if (
      typeof response !== 'object' ||
      response === null ||
      Array.isArray(response) ||
      Object.keys(response).sort().join(',') !== 'authorizationExpiresAt,expiresAt' ||
      !('expiresAt' in response) ||
      !('authorizationExpiresAt' in response) ||
      typeof response.expiresAt !== 'string' ||
      typeof response.authorizationExpiresAt !== 'string'
    ) {
      throw new SyncLifecycleError('challenge-mismatch', 'Server je vratio neispravnu sesiju.');
    }
    const now = dependencies.now().getTime();
    const sessionExpiresAt = Date.parse(response.expiresAt);
    const authorizationExpiresAt = Date.parse(response.authorizationExpiresAt);
    if (
      !Number.isFinite(sessionExpiresAt) ||
      !Number.isFinite(authorizationExpiresAt) ||
      sessionExpiresAt <= now ||
      authorizationExpiresAt <= now
    ) {
      throw new SyncLifecycleError(
        'challenge-mismatch',
        'Server je vratio već isteklu autorizaciju uređaja.',
      );
    }
  } catch (error) {
    dependencies.api.clearSession();
    throw error;
  }
};

const assertExactVaultAck = (
  response: VaultCreateResponseV1,
  manifest: VaultManifestV1,
  manifestHash: string,
): void => {
  if (
    response.vaultId !== manifest.vaultId ||
    response.manifestVersion !== manifest.manifestVersion ||
    response.manifestHash !== manifestHash
  ) {
    throw new SyncLifecycleError(
      'server-ack-mismatch',
      'Server nije potvrdio tačan početni manifest.',
    );
  }
};

const assertNoExistingVault = async (repository: SyncLifecycleRepositoryPort): Promise<void> => {
  if ((await repository.read()) !== undefined) {
    throw new SyncLifecycleError(
      'local-vault-exists',
      'Sinhronizacija je već podešena na ovom uređaju.',
    );
  }
};

interface EnableMaterial {
  readonly displayName: string;
  readonly vaultId: string;
  readonly deviceId: string;
  readonly recoveryLookupId: string;
  readonly deviceKeys: DeviceKeyPairs;
  readonly localWrappingKey: CryptoKey;
  readonly recoverySigningKeys: CryptoKeyPair;
  readonly vaultMasterKey: Uint8Array;
  readonly recoveryRoot: Uint8Array;
  readonly enabledAt: string;
  readonly confirmationGroupNumbers: readonly number[];
}

interface PreparedRegistration {
  readonly request: VaultCreateRequestV1;
  readonly setup: LocalSyncSetup;
  readonly manifestHash: string;
}

type EnableState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'awaiting-recovery-confirmation'; readonly material: EnableMaterial }
  | { readonly kind: 'confirmed'; readonly material: EnableMaterial }
  | { readonly kind: 'registering'; readonly registration: PreparedRegistration }
  | { readonly kind: 'active'; readonly setup: LocalSyncSetup }
  | { readonly kind: 'failed' };

export class EnableSyncLifecycle {
  readonly #dependencies: ResolvedDependencies;
  #state: EnableState = { kind: 'idle' };

  constructor(dependencies: CommonDependencies) {
    this.#dependencies = resolveDependencies(dependencies);
  }

  get state(): EnableState['kind'] {
    return this.#state.kind;
  }

  async begin(displayName: string): Promise<RecoveryCodePresentation> {
    if (this.#state.kind !== 'idle') {
      throw new SyncLifecycleError('invalid-state', 'Podešavanje sinhronizacije je već započeto.');
    }
    await assertNoExistingVault(this.#dependencies.repository);
    const normalizedName = normalizeDeviceName(displayName);
    const runtime = this.#dependencies.runtime;
    const [deviceKeys, localWrappingKey, recoverySigningKeys] = await Promise.all([
      generateDeviceKeyPairs(runtime),
      generateLocalWrappingKey(runtime),
      generateRecoverySigningKeyPair(runtime),
    ]);
    const recoveryRoot = randomBytes(SYNC_LIMITS.recoveryRootBytes, runtime);
    const recoveryLookupId = bytesToBase64Url(
      randomBytes(SYNC_LIMITS.recoveryLookupIdBytes, runtime),
    );
    const recoveryCode = await createRecoveryCode(recoveryLookupId, recoveryRoot, runtime);
    const groupCount = recoveryGroups(recoveryCode).length;
    const confirmationGroupNumbers = assertConfirmationSelection(
      groupCount,
      this.#dependencies.selectRecoveryConfirmationGroups(groupCount, runtime),
    );
    this.#state = {
      kind: 'awaiting-recovery-confirmation',
      material: {
        displayName: normalizedName,
        vaultId: createOpaqueId(runtime),
        deviceId: createOpaqueId(runtime),
        recoveryLookupId,
        deviceKeys,
        localWrappingKey,
        recoverySigningKeys,
        vaultMasterKey: randomBytes(SYNC_LIMITS.vaultMasterKeyBytes, runtime),
        recoveryRoot,
        enabledAt: this.#dependencies.now().toISOString(),
        confirmationGroupNumbers,
      },
    };
    return { recoveryCode, confirmationGroupNumbers };
  }

  async confirmRecoveryCode(values: readonly RecoveryConfirmationValue[]): Promise<void> {
    if (this.#state.kind !== 'awaiting-recovery-confirmation') {
      throw new SyncLifecycleError('invalid-state', 'Recovery kod trenutno ne čeka potvrdu.');
    }
    const { material } = this.#state;
    const recoveryCode = await createRecoveryCode(
      material.recoveryLookupId,
      material.recoveryRoot,
      this.#dependencies.runtime,
    );
    verifyRecoveryConfirmation(recoveryCode, material.confirmationGroupNumbers, values);
    this.#state = { kind: 'confirmed', material };
  }

  async activate(): Promise<LocalSyncSetup> {
    if (this.#state.kind === 'confirmed') {
      const material = this.#state.material;
      try {
        const registration = await this.#prepareRegistration(material);
        clearBytes(material.vaultMasterKey, material.recoveryRoot);
        this.#state = { kind: 'registering', registration };
      } catch (error) {
        clearBytes(material.vaultMasterKey, material.recoveryRoot);
        this.#state = { kind: 'failed' };
        throw error;
      }
    }
    if (this.#state.kind !== 'registering') {
      if (this.#state.kind === 'active') return this.#state.setup;
      throw new SyncLifecycleError(
        'invalid-state',
        'Recovery kod mora biti potvrđen pre aktivacije.',
      );
    }
    const { registration } = this.#state;
    const response = vaultCreateResponseSchema.parse(
      await this.#dependencies.api.createVault(registration.request),
    );
    assertExactVaultAck(response, registration.request.manifest, registration.manifestHash);
    await this.#dependencies.repository.write(registration.setup);
    this.#state = { kind: 'active', setup: registration.setup };
    return registration.setup;
  }

  async #prepareRegistration(material: EnableMaterial): Promise<PreparedRegistration> {
    const runtime = this.#dependencies.runtime;
    const authorizedAt = material.enabledAt;
    const device = await createManifestDevice({
      deviceId: material.deviceId,
      keyPairs: material.deviceKeys,
      authorizedAt,
      authorizationExpiresAt: addMilliseconds(
        new Date(authorizedAt),
        SYNC_LIMITS.deviceAuthorizationLifetimeMs,
      ),
      runtime,
    });
    const manifest = await createInitialManifest({
      vaultId: material.vaultId,
      recoveryLookupId: material.recoveryLookupId,
      transitionId: createOpaqueId(runtime),
      device,
      recoverySigningPublicKey: material.recoverySigningKeys.publicKey,
      signingPrivateKey: material.deviceKeys.signing.privateKey,
      createdAt: authorizedAt,
      runtime,
    });
    const manifestHash = await manifestBodyHash(manifest, runtime);
    const recoveryKeys = await deriveRecoveryKeys(
      material.recoveryRoot,
      { vaultId: material.vaultId, recoveryLookupId: material.recoveryLookupId },
      runtime,
    );
    try {
      const recoveryPublicKey = await exportPublicEcKey(
        material.recoverySigningKeys.publicKey,
        runtime,
      );
      const recoveryBundle: RecoveryBundleV1 = {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        vaultId: material.vaultId,
        recoveryLookupId: material.recoveryLookupId,
        keyEpoch: manifest.keyEpoch,
        vaultMasterKey: bytesToBase64Url(material.vaultMasterKey),
        recoverySigningPrivateKeyPkcs8: await exportRecoverySigningPrivateKey(
          material.recoverySigningKeys.privateKey,
          runtime,
        ),
        recoverySigningPublicKey: recoveryPublicKey,
        pinnedManifest: manifest,
        pinnedManifestHash: manifestHash,
      };
      const recoveryEnvelope = await createEncryptedRecoveryBundleEnvelope(
        recoveryBundle,
        recoveryKeys.wrappingKey,
        {
          protocolVersion: SYNC_PROTOCOL_VERSION,
          suite: SYNC_CRYPTO_SUITE,
          vaultId: material.vaultId,
          keyEpoch: manifest.keyEpoch,
          objectType: 'recovery-vault-key',
          objectId: createOpaqueId(runtime),
          creatingDeviceId: material.deviceId,
          recoveryLookupId: material.recoveryLookupId,
          parentManifestHash: manifestHash,
        },
        runtime,
      );
      const recovery = recoveryRecordSchema.parse({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        vaultId: material.vaultId,
        recoveryLookupId: material.recoveryLookupId,
        keyEpoch: manifest.keyEpoch,
        recoveryEnvelope,
        recoverySigningPublicKey: recoveryPublicKey,
        recoveryGateKeyHash: await hashRecoveryGateKey(recoveryKeys.gateKey, runtime),
        manifestVersion: manifest.manifestVersion,
        manifestHash,
        updatedAt: authorizedAt,
      });
      const setup = await createLocalSetup({
        manifest,
        manifestHash,
        device,
        displayName: material.displayName,
        deviceKeys: material.deviceKeys,
        localWrappingKey: material.localWrappingKey,
        vaultMasterKey: material.vaultMasterKey,
        enabledAt: authorizedAt,
        runtime,
      });
      return {
        request: vaultCreateRequestSchema.parse({
          protocolVersion: SYNC_PROTOCOL_VERSION,
          suite: SYNC_CRYPTO_SUITE,
          manifest,
          recovery,
        }),
        setup,
        manifestHash,
      };
    } finally {
      clearBytes(recoveryKeys.gateKey);
    }
  }
}

interface NewPairingMaterial {
  readonly displayName: string;
  readonly requestId: string;
  readonly deviceId: string;
  readonly deviceKeys: DeviceKeyPairs;
  readonly localWrappingKey: CryptoKey;
  readonly pairingSecret: Uint8Array;
  readonly pairingSalt: Uint8Array;
  readonly pollingToken: Uint8Array;
  readonly createRequest: PairingCreateRequestV1;
  readonly pairingCode: string;
  readonly qrPayload: string;
}

interface AcceptedPairingMaterial {
  readonly displayName: string;
  readonly deviceId: string;
  readonly deviceKeys: DeviceKeyPairs;
  readonly localWrappingKey: CryptoKey;
  readonly pollingToken: Uint8Array;
  readonly envelope: PairingEnvelopeV1;
  readonly candidateManifest: VaultManifestV1;
  readonly vaultMasterKey: Uint8Array;
  readonly sas: string;
  readonly finalizedAt: string;
  finalization?: PairingFinalizeRequestV1;
}

type NewPairingState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'creating'; readonly material: NewPairingMaterial }
  | { readonly kind: 'polling'; readonly material: NewPairingMaterial; readonly expiresAt: string }
  | { readonly kind: 'awaiting-sas-confirmation'; readonly material: AcceptedPairingMaterial }
  | { readonly kind: 'active'; readonly setup: LocalSyncSetup }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'ended' };

export interface PairingCodePresentation {
  readonly pairingCode: string;
  readonly qrPayload: string;
  readonly expiresAt: string;
}

export type PairingPollResult =
  | { readonly status: 'pending'; readonly expiresAt: string }
  | { readonly status: 'sas-required'; readonly sas: string; readonly expiresAt: string }
  | { readonly status: 'ended'; readonly reason: 'cancelled' | 'expired' | 'consumed' };

export class NewDevicePairingLifecycle {
  readonly #dependencies: ResolvedDependencies;
  #state: NewPairingState = { kind: 'idle' };

  constructor(dependencies: CommonDependencies) {
    this.#dependencies = resolveDependencies(dependencies);
  }

  get state(): NewPairingState['kind'] {
    return this.#state.kind;
  }

  async start(displayName: string): Promise<PairingCodePresentation> {
    if (this.#state.kind === 'idle') {
      await assertNoExistingVault(this.#dependencies.repository);
      const normalizedDisplayName = normalizeDeviceName(displayName);
      const runtime = this.#dependencies.runtime;
      const [deviceKeys, localWrappingKey] = await Promise.all([
        generateDeviceKeyPairs(runtime),
        generateLocalWrappingKey(runtime),
      ]);
      const requestId = createOpaqueId(runtime);
      const deviceId = createOpaqueId(runtime);
      const pairingSecret = randomBytes(SYNC_LIMITS.pairingSecretBytes, runtime);
      const pairingSalt = randomBytes(SYNC_LIMITS.pairingSaltBytes, runtime);
      const pollingToken = randomBytes(SYNC_LIMITS.pollingTokenBytes, runtime);
      const secrets = await derivePairingSecrets(
        pairingSecret,
        {
          pairingRequestId: requestId,
          pairingSalt: bytesToBase64Url(pairingSalt),
          origin: this.#dependencies.origin,
        },
        runtime,
      );
      const publicKeys = await publicDeviceKeys(deviceKeys, runtime);
      const pairingCode = await createPairingCode(requestId, pairingSecret, pairingSalt, runtime);
      const material: NewPairingMaterial = {
        displayName: normalizedDisplayName,
        requestId,
        deviceId,
        deviceKeys,
        localWrappingKey,
        pairingSecret,
        pairingSalt,
        pollingToken,
        createRequest: pairingCreateRequestSchema.parse({
          protocolVersion: SYNC_PROTOCOL_VERSION,
          suite: SYNC_CRYPTO_SUITE,
          requestId,
          deviceId,
          publicKeys,
          pairingSalt: bytesToBase64Url(pairingSalt),
          pairingClaimTokenHash: await hashPairingClaimToken(secrets.claimToken, runtime),
          pollingTokenHash: await hashPollingToken(pollingToken, runtime),
        }),
        pairingCode,
        qrPayload: createPairingQrPayload(this.#dependencies.origin, pairingCode),
      };
      clearBytes(secrets.claimToken, secrets.transcriptMacKey, secrets.sasKey);
      this.#state = { kind: 'creating', material };
    }
    if (this.#state.kind !== 'creating') {
      throw new SyncLifecycleError('invalid-state', 'Zahtev za uparivanje je već poslat.');
    }
    const { material } = this.#state;
    const response = pairingCreateResponseSchema.parse(
      await this.#dependencies.api.createPairing(material.createRequest),
    );
    if (
      response.requestId !== material.requestId ||
      Date.parse(response.expiresAt) <= this.#dependencies.now().getTime()
    ) {
      throw new SyncLifecycleError(
        'server-ack-mismatch',
        'Server nije potvrdio tačan zahtev za uparivanje.',
      );
    }
    this.#state = { kind: 'polling', material, expiresAt: response.expiresAt };
    return {
      pairingCode: material.pairingCode,
      qrPayload: material.qrPayload,
      expiresAt: response.expiresAt,
    };
  }

  async poll(): Promise<PairingPollResult> {
    if (this.#state.kind !== 'polling') {
      throw new SyncLifecycleError('invalid-state', 'Uparivanje trenutno ne čeka odgovor.');
    }
    const { material, expiresAt } = this.#state;
    const response = pairingPollResponseSchema.parse(
      await this.#dependencies.api.pollPairing(
        material.requestId,
        pairingPollRequestSchema.parse({
          protocolVersion: SYNC_PROTOCOL_VERSION,
          pollingToken: bytesToBase64Url(material.pollingToken),
        }),
      ),
    );
    if (response.expiresAt !== expiresAt) {
      await this.#invalidatePairing(material);
      throw new SyncLifecycleError(
        'pairing-mismatch',
        'Server je promenio rok važenja zahteva za uparivanje.',
      );
    }
    if (response.status === 'pending') {
      if (Date.parse(response.expiresAt) <= this.#dependencies.now().getTime()) {
        await this.#invalidatePairing(material);
        throw new SyncLifecycleError('pairing-ended', 'Zahtev za uparivanje je istekao.');
      }
      return { status: 'pending', expiresAt: response.expiresAt };
    }
    if (response.status !== 'approved') {
      this.#clearNewPairingMaterial(material);
      this.#state = response.status === 'cancelled' ? { kind: 'cancelled' } : { kind: 'ended' };
      return { status: 'ended', reason: response.status };
    }
    if (Date.parse(response.expiresAt) <= this.#dependencies.now().getTime()) {
      await this.#invalidatePairing(material);
      throw new SyncLifecycleError('pairing-ended', 'Zahtev za uparivanje je istekao.');
    }
    let accepted: AcceptedPairingMaterial;
    try {
      accepted = await this.#openApprovedPairing(material, response);
    } catch (error) {
      await this.#invalidatePairing(material);
      throw error;
    }
    this.#state = { kind: 'awaiting-sas-confirmation', material: accepted };
    return { status: 'sas-required', sas: accepted.sas, expiresAt: response.expiresAt };
  }

  async confirmSas(sas: string): Promise<LocalSyncSetup> {
    if (this.#state.kind !== 'awaiting-sas-confirmation') {
      if (this.#state.kind === 'active') return this.#state.setup;
      throw new SyncLifecycleError('invalid-state', 'SAS trenutno ne čeka potvrdu.');
    }
    const material = this.#state.material;
    if (sas.trim().toUpperCase() !== material.sas) {
      const mismatch = new SyncLifecycleError('sas-mismatch', 'SAS vrednosti se ne poklapaju.');
      await this.#invalidatePairing(material);
      throw mismatch;
    }
    const runtime = this.#dependencies.runtime;
    const candidateHash = await manifestBodyHash(material.candidateManifest, runtime);
    const envelopeHash = await hashDomainSeparatedCanonical(
      SYNC_DOMAIN_LABELS.pairingEnvelopeHash,
      material.envelope,
      runtime,
    );
    material.finalization ??= pairingFinalizeRequestSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      pollingToken: bytesToBase64Url(material.pollingToken),
      transcript: {
        type: 'mirna-pairing-finalize-v1',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        vaultId: material.candidateManifest.vaultId,
        pairingRequestId: material.envelope.context.pairingRequestId,
        newDeviceId: material.deviceId,
        candidateManifestHash: candidateHash,
        envelopeHash,
        keyConfirmation: material.envelope.keyConfirmation,
        sasConfirmed: true,
        confirmedAt: material.finalizedAt,
      },
      signature: await signDomainSeparatedCanonical(
        SYNC_DOMAIN_LABELS.pairingFinalize,
        {
          type: 'mirna-pairing-finalize-v1',
          protocolVersion: SYNC_PROTOCOL_VERSION,
          vaultId: material.candidateManifest.vaultId,
          pairingRequestId: material.envelope.context.pairingRequestId,
          newDeviceId: material.deviceId,
          candidateManifestHash: candidateHash,
          envelopeHash,
          keyConfirmation: material.envelope.keyConfirmation,
          sasConfirmed: true,
          confirmedAt: material.finalizedAt,
        },
        material.deviceKeys.signing.privateKey,
        runtime,
      ),
    });
    const response = pairingFinalizeResponseSchema.parse(
      await this.#dependencies.api.finalizePairing(
        material.envelope.context.pairingRequestId,
        material.finalization,
      ),
    );
    if (
      !response.finalized ||
      response.vaultId !== material.candidateManifest.vaultId ||
      response.deviceId !== material.deviceId ||
      response.manifestVersion !== material.candidateManifest.manifestVersion
    ) {
      throw new SyncLifecycleError(
        'server-ack-mismatch',
        'Server nije potvrdio tačno uparivanje uređaja.',
      );
    }
    const device = material.candidateManifest.devices.find(
      (candidate) => candidate.deviceId === material.deviceId,
    );
    if (!device) throw new SyncLifecycleError('pairing-mismatch', 'Novi uređaj nije u manifestu.');
    const setup = await createLocalSetup({
      manifest: material.candidateManifest,
      manifestHash: candidateHash,
      device,
      displayName: material.displayName,
      deviceKeys: material.deviceKeys,
      localWrappingKey: material.localWrappingKey,
      vaultMasterKey: material.vaultMasterKey,
      enabledAt: material.finalizedAt,
      runtime,
    });
    await this.#dependencies.repository.write(setup);
    clearBytes(material.pollingToken, material.vaultMasterKey);
    this.#state = { kind: 'active', setup };
    return setup;
  }

  async cancel(): Promise<void> {
    if (
      this.#state.kind !== 'creating' &&
      this.#state.kind !== 'polling' &&
      this.#state.kind !== 'awaiting-sas-confirmation'
    ) {
      throw new SyncLifecycleError('invalid-state', 'Nema aktivnog zahteva za otkazivanje.');
    }
    const material = this.#state.material;
    const requestId =
      'requestId' in material ? material.requestId : material.envelope.context.pairingRequestId;
    try {
      await this.#dependencies.api.cancelPairing(
        requestId,
        pairingPollRequestSchema.parse({
          protocolVersion: SYNC_PROTOCOL_VERSION,
          pollingToken: bytesToBase64Url(material.pollingToken),
        }),
      );
    } finally {
      if ('pairingSecret' in material) this.#clearNewPairingMaterial(material);
      else clearBytes(material.pollingToken, material.vaultMasterKey);
      this.#state = { kind: 'cancelled' };
    }
  }

  async #openApprovedPairing(
    material: NewPairingMaterial,
    response: Extract<PairingPollResponseV1, { status: 'approved' }>,
  ): Promise<AcceptedPairingMaterial> {
    const runtime = this.#dependencies.runtime;
    const envelope = response.envelope;
    const manifest = response.candidateManifest;
    const ownPublicKeys = await publicDeviceKeys(material.deviceKeys, runtime);
    const parsedSecrets = await derivePairingSecrets(
      material.pairingSecret,
      {
        pairingRequestId: material.requestId,
        pairingSalt: bytesToBase64Url(material.pairingSalt),
        origin: this.#dependencies.origin,
      },
      runtime,
    );
    let openedVaultMasterKey: Uint8Array | undefined;
    try {
      const contextHash = await hashDomainSeparatedCanonical(
        SYNC_DOMAIN_LABELS.pairingContext,
        envelope.context,
        runtime,
      );
      const candidateHash = await manifestBodyHash(manifest, runtime);
      const unsignedEnvelope = withoutPairingAuthenticators(envelope);
      const authorizer = manifest.devices.find(
        (device) => device.deviceId === envelope.context.authorizingDeviceId,
      );
      const newDevice = manifest.devices.find((device) => device.deviceId === material.deviceId);
      const ciphertext = base64UrlToBytes(envelope.ciphertext);
      if (
        envelope.context.origin !== this.#dependencies.origin ||
        envelope.context.pairingRequestId !== material.requestId ||
        envelope.context.newDeviceId !== material.deviceId ||
        !sameCanonicalValue(envelope.context.newDevicePublicKeys, ownPublicKeys) ||
        envelope.context.ecdhSalt !== bytesToBase64Url(material.pairingSalt) ||
        envelope.context.currentManifestVersion + 1 !== manifest.manifestVersion ||
        envelope.context.currentManifestHash !== manifest.previousManifestHash ||
        envelope.context.keyEpoch !== manifest.keyEpoch ||
        envelope.context.snapshotCommitId !== null ||
        envelope.context.operationFrontierHash !== null ||
        envelope.context.pairingExpiresAt !== response.expiresAt ||
        envelope.candidateManifestHash !== candidateHash ||
        envelope.aad.vaultId !== envelope.context.vaultId ||
        envelope.aad.keyEpoch !== envelope.context.keyEpoch ||
        envelope.aad.creatingDeviceId !== envelope.context.authorizingDeviceId ||
        envelope.aad.parentManifestHash !== envelope.context.currentManifestHash ||
        envelope.aad.pairingContextHash !== contextHash ||
        envelope.ciphertextLength !== ciphertext.length ||
        envelope.ciphertextHash !== bytesToBase64Url(await sha256(ciphertext, runtime)) ||
        manifest.vaultId !== envelope.context.vaultId ||
        manifest.transition.kind !== 'add-device' ||
        manifest.transition.authorizationKind !== 'device' ||
        manifest.transition.authorizingDeviceId !== envelope.context.authorizingDeviceId ||
        manifest.transition.affectedDeviceId !== material.deviceId ||
        !authorizer ||
        !newDevice ||
        newDevice.authorizedAt !== manifest.transition.occurredAt ||
        Date.parse(newDevice.authorizationExpiresAt) <= Date.parse(newDevice.authorizedAt) ||
        Date.parse(newDevice.authorizationExpiresAt) - Date.parse(newDevice.authorizedAt) >
          SYNC_LIMITS.deviceAuthorizationLifetimeMs ||
        Date.parse(authorizer.authorizationExpiresAt) <=
          Date.parse(manifest.transition.occurredAt) ||
        !sameCanonicalValue(authorizer.publicKeys, envelope.context.authorizingDevicePublicKeys) ||
        !sameCanonicalValue(newDevice.publicKeys, ownPublicKeys)
      ) {
        throw new SyncLifecycleError(
          'pairing-mismatch',
          'Primljeni omot nije vezan za očekivani uređaj i manifest.',
        );
      }
      const authorizerSigningKey = await importSigningPublicKey(
        authorizer.publicKeys.signing,
        runtime,
      );
      if (
        !(await verifyDomainSeparatedCanonicalSignature(
          SYNC_DOMAIN_LABELS.pairingEnvelope,
          unsignedEnvelope,
          envelope.signature,
          authorizerSigningKey,
          runtime,
        )) ||
        !(await verifyDomainSeparatedCanonicalSignature(
          SYNC_DOMAIN_LABELS.manifestBody,
          withoutManifestSignature(manifest),
          manifest.signature,
          authorizerSigningKey,
          runtime,
        )) ||
        !(await verifyPairingTranscriptMac(
          unsignedEnvelope,
          envelope.transcriptMac,
          parsedSecrets.transcriptMacKey,
          runtime,
        ))
      ) {
        throw new SyncLifecycleError('pairing-mismatch', 'Potpis ili MAC uparivanja nije validan.');
      }
      const ephemeralPublicKey = await importAgreementPublicKey(
        envelope.context.ephemeralAgreementPublicKey,
        runtime,
      );
      const agreementKeys = await derivePairingAgreementKeys(
        material.deviceKeys.agreement.privateKey,
        ephemeralPublicKey,
        material.pairingSalt,
        envelope.context,
        runtime,
      );
      const confirmationTranscript = pairingConfirmationTranscript(
        unsignedEnvelope,
        envelope.signature,
        envelope.transcriptMac,
      );
      if (
        !(await verifyPairingKeyConfirmation(
          confirmationTranscript,
          envelope.keyConfirmation,
          agreementKeys.confirmationKey,
          runtime,
        ))
      ) {
        throw new SyncLifecycleError(
          'pairing-mismatch',
          'ECDH potvrda ključa uparivanja nije validna.',
        );
      }
      openedVaultMasterKey = await decryptAesGcm(
        ciphertext,
        agreementKeys.wrappingKey,
        base64UrlToBytes(envelope.nonce),
        envelope.aad,
        runtime,
      );
      if (openedVaultMasterKey.length !== SYNC_LIMITS.vaultMasterKeyBytes) {
        throw new SyncLifecycleError('pairing-mismatch', 'Omot sadrži neispravan ključ trezora.');
      }
      const sas = await deriveShortAuthenticationString(
        confirmationTranscript,
        envelope.transcriptMac,
        parsedSecrets.sasKey,
        runtime,
      );
      clearBytes(material.pairingSecret, material.pairingSalt);
      const accepted: AcceptedPairingMaterial = {
        displayName: material.displayName,
        deviceId: material.deviceId,
        deviceKeys: material.deviceKeys,
        localWrappingKey: material.localWrappingKey,
        pollingToken: material.pollingToken,
        envelope,
        candidateManifest: manifest,
        vaultMasterKey: openedVaultMasterKey,
        sas,
        finalizedAt: this.#dependencies.now().toISOString(),
      };
      openedVaultMasterKey = undefined;
      return accepted;
    } finally {
      if (openedVaultMasterKey) clearBytes(openedVaultMasterKey);
      clearBytes(parsedSecrets.claimToken, parsedSecrets.transcriptMacKey, parsedSecrets.sasKey);
    }
  }

  #clearNewPairingMaterial(material: NewPairingMaterial): void {
    clearBytes(material.pairingSecret, material.pairingSalt, material.pollingToken);
  }

  async #invalidatePairing(material: NewPairingMaterial | AcceptedPairingMaterial): Promise<void> {
    const requestId =
      'requestId' in material ? material.requestId : material.envelope.context.pairingRequestId;
    try {
      await this.#dependencies.api.cancelPairing(
        requestId,
        pairingPollRequestSchema.parse({
          protocolVersion: SYNC_PROTOCOL_VERSION,
          pollingToken: bytesToBase64Url(material.pollingToken),
        }),
      );
    } catch {
      // Finalization still requires this device's signature. Local key material
      // is discarded even when the best-effort server invalidation fails.
    } finally {
      if ('pairingSecret' in material) this.#clearNewPairingMaterial(material);
      else clearBytes(material.pollingToken, material.vaultMasterKey);
      this.#state = { kind: 'cancelled' };
    }
  }
}

interface PreparedExistingApproval {
  readonly pairingRequestId: string;
  readonly claimToken: Uint8Array;
  readonly envelope: PairingEnvelopeV1;
  readonly candidateManifest: VaultManifestV1;
  readonly sas: string;
}

type ExistingPairingState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'prepared'; readonly approval: PreparedExistingApproval }
  | { readonly kind: 'approved' }
  | { readonly kind: 'rejected' };

export interface ExistingPairingPreparation {
  readonly candidate: PairingCandidateV1;
  readonly sas: string;
}

export class ExistingDevicePairingLifecycle {
  readonly #dependencies: ResolvedDependencies;
  #state: ExistingPairingState = { kind: 'idle' };

  constructor(dependencies: CommonDependencies) {
    this.#dependencies = resolveDependencies(dependencies);
  }

  get state(): ExistingPairingState['kind'] {
    return this.#state.kind;
  }

  async prepare(pairingCodeOrQrPayload: string): Promise<ExistingPairingPreparation> {
    if (this.#state.kind !== 'idle') {
      throw new SyncLifecycleError('invalid-state', 'Odobravanje uparivanja je već započeto.');
    }
    const setup = await this.#dependencies.repository.read();
    if (!setup) {
      throw new SyncLifecycleError('invalid-state', 'Ovaj uređaj nema aktivnu sinhronizaciju.');
    }
    const manualCode = pairingCodeOrQrPayload.includes('://')
      ? parsePairingQrPayload(pairingCodeOrQrPayload, this.#dependencies.origin)
      : pairingCodeOrQrPayload;
    const parsed = await parsePairingCode(manualCode, this.#dependencies.runtime);
    const pairingSalt = bytesToBase64Url(parsed.pairingSalt);
    const secrets = await derivePairingSecrets(
      parsed.pairingSecret,
      {
        pairingRequestId: parsed.pairingRequestId,
        pairingSalt,
        origin: this.#dependencies.origin,
      },
      this.#dependencies.runtime,
    );
    clearBytes(parsed.pairingSecret);
    try {
      const candidate = pairingCandidateSchema.parse(
        await this.#dependencies.api.inspectPairing(
          parsed.pairingRequestId,
          pairingInspectRequestSchema.parse({
            protocolVersion: SYNC_PROTOCOL_VERSION,
            claimToken: bytesToBase64Url(secrets.claimToken),
          }),
        ),
      );
      if (
        candidate.requestId !== parsed.pairingRequestId ||
        candidate.pairingSalt !== pairingSalt ||
        Date.parse(candidate.expiresAt) <= this.#dependencies.now().getTime()
      ) {
        throw new SyncLifecycleError(
          'pairing-mismatch',
          'Zahtev za uparivanje ne odgovara unetom kodu.',
        );
      }
      await createAccessSession(this.#dependencies, setup);
      let serverManifest: VaultManifestV1;
      try {
        serverManifest = vaultManifestSchema.parse(
          await this.#dependencies.api.getCurrentManifest(),
        );
      } finally {
        this.#dependencies.api.clearSession();
      }
      const localHash = await manifestBodyHash(setup.vault.manifest, this.#dependencies.runtime);
      await assertManifestAgainstPin(
        serverManifest,
        { manifestVersion: setup.vault.manifest.manifestVersion, manifestHash: localHash },
        this.#dependencies.runtime,
      );
      const serverHash = await manifestBodyHash(serverManifest, this.#dependencies.runtime);
      if (
        serverManifest.manifestVersion !== setup.vault.manifest.manifestVersion ||
        serverHash !== localHash
      ) {
        throw new SyncLifecycleError(
          'manifest-mismatch',
          'Lokalni manifest mora biti osvežen pre dodavanja uređaja.',
        );
      }
      const approval = await this.#createApproval(
        setup,
        candidate,
        parsed.pairingSalt,
        secrets.claimToken,
        secrets.transcriptMacKey,
        secrets.sasKey,
        serverManifest,
        serverHash,
      );
      clearBytes(secrets.transcriptMacKey, secrets.sasKey, parsed.pairingSalt);
      this.#state = { kind: 'prepared', approval };
      return { candidate, sas: approval.sas };
    } catch (error) {
      clearBytes(secrets.claimToken, secrets.transcriptMacKey, secrets.sasKey, parsed.pairingSalt);
      throw error;
    }
  }

  async approve(confirmedSas: string): Promise<void> {
    if (this.#state.kind !== 'prepared') {
      throw new SyncLifecycleError('invalid-state', 'Nema pripremljenog zahteva za odobravanje.');
    }
    const { approval } = this.#state;
    if (confirmedSas.trim().toUpperCase() !== approval.sas) {
      clearBytes(approval.claimToken);
      this.#state = { kind: 'rejected' };
      throw new SyncLifecycleError('sas-mismatch', 'SAS vrednosti se ne poklapaju.');
    }
    const setup = await this.#dependencies.repository.read();
    if (!setup) throw new SyncLifecycleError('invalid-state', 'Lokalni sync podaci nedostaju.');
    await createAccessSession(this.#dependencies, setup);
    try {
      const sensitive = await requestSignedChallenge(
        this.#dependencies,
        setup,
        '/v1/pairings/approve',
      );
      const request = pairingApprovalSchema.parse({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        pairingRequestId: approval.pairingRequestId,
        claimToken: bytesToBase64Url(approval.claimToken),
        envelope: approval.envelope,
        candidateManifest: approval.candidateManifest,
        sensitiveChallenge: sensitive.challenge,
        sensitiveSignature: sensitive.signature,
        approverSasConfirmed: true,
      });
      await this.#dependencies.api.approvePairing(approval.pairingRequestId, request);
    } finally {
      this.#dependencies.api.clearSession();
    }
    clearBytes(approval.claimToken);
    this.#state = { kind: 'approved' };
  }

  reject(): void {
    if (this.#state.kind !== 'prepared') {
      throw new SyncLifecycleError('invalid-state', 'Nema pripremljenog zahteva za odbijanje.');
    }
    clearBytes(this.#state.approval.claimToken);
    this.#state = { kind: 'rejected' };
  }

  async #createApproval(
    setup: LocalSyncSetup,
    candidate: PairingCandidateV1,
    pairingSalt: Uint8Array,
    claimToken: Uint8Array,
    transcriptMacKey: Uint8Array,
    sasKey: Uint8Array,
    currentManifest: VaultManifestV1,
    currentManifestHash: string,
  ): Promise<PreparedExistingApproval> {
    const runtime = this.#dependencies.runtime;
    const authorizer = currentManifest.devices.find(
      (device) => device.deviceId === setup.device.deviceId,
    );
    if (
      !authorizer ||
      Date.parse(authorizer.authorizationExpiresAt) <= this.#dependencies.now().getTime()
    ) {
      throw new SyncLifecycleError(
        'manifest-mismatch',
        'Ovaj uređaj nema važeće ovlašćenje u trenutnom manifestu.',
      );
    }
    const occurredAt = this.#dependencies.now();
    const newDevice: ManifestDeviceV1 = {
      deviceId: candidate.deviceId,
      publicKeys: candidate.publicKeys,
      authorizedAt: occurredAt.toISOString(),
      authorizationExpiresAt: addMilliseconds(
        occurredAt,
        SYNC_LIMITS.deviceAuthorizationLifetimeMs,
      ),
    };
    const unsignedCandidate: UnsignedVaultManifestV1 = {
      ...withoutManifestSignature(currentManifest),
      manifestVersion: currentManifest.manifestVersion + 1,
      devices: [...currentManifest.devices, newDevice].sort(deviceIdComparator),
      previousManifestHash: currentManifestHash,
      transition: {
        transitionId: createOpaqueId(runtime),
        kind: 'add-device',
        authorizationKind: 'device',
        authorizingDeviceId: setup.device.deviceId,
        affectedDeviceId: candidate.deviceId,
        occurredAt: occurredAt.toISOString(),
      },
    };
    const candidateManifest = await signVaultManifest(
      unsignedCandidate,
      setup.device.signingPrivateKey,
      runtime,
    );
    await validateManifestTransition(currentManifest, candidateManifest, runtime);
    const candidateManifestHash = await manifestBodyHash(candidateManifest, runtime);
    const ephemeral = await generateEphemeralAgreementKeyPair(runtime);
    const ephemeralPublicKey = await exportPublicEcKey(ephemeral.publicKey, runtime);
    const context = {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      origin: this.#dependencies.origin,
      vaultId: currentManifest.vaultId,
      keyEpoch: currentManifest.keyEpoch,
      pairingRequestId: candidate.requestId,
      pairingExpiresAt: candidate.expiresAt,
      currentManifestVersion: currentManifest.manifestVersion,
      currentManifestHash,
      snapshotCommitId: null,
      operationFrontierHash: null,
      newDeviceId: candidate.deviceId,
      newDevicePublicKeys: candidate.publicKeys,
      authorizingDeviceId: setup.device.deviceId,
      authorizingDevicePublicKeys: authorizer.publicKeys,
      ephemeralAgreementPublicKey: ephemeralPublicKey,
      ecdhSalt: candidate.pairingSalt,
    } as const;
    const contextHash = await hashDomainSeparatedCanonical(
      SYNC_DOMAIN_LABELS.pairingContext,
      context,
      runtime,
    );
    const agreementPublicKey = await importAgreementPublicKey(
      candidate.publicKeys.agreement,
      runtime,
    );
    const agreementKeys = await derivePairingAgreementKeys(
      ephemeral.privateKey,
      agreementPublicKey,
      pairingSalt,
      context,
      runtime,
    );
    const vaultMasterKey = await openEncryptedKeyEnvelope(
      setup.vaultKey.encryptedKey,
      setup.device.localWrappingKey,
      runtime,
    );
    try {
      const aad = {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        vaultId: currentManifest.vaultId,
        keyEpoch: currentManifest.keyEpoch,
        objectType: 'pairing-vault-key' as const,
        objectId: createOpaqueId(runtime),
        creatingDeviceId: setup.device.deviceId,
        recoveryLookupId: null,
        parentManifestHash: currentManifestHash,
        pairingContextHash: contextHash,
      };
      const nonce = randomBytes(SYNC_LIMITS.aesGcmNonceBytes, runtime);
      const ciphertext = await encryptAesGcm(
        vaultMasterKey,
        agreementKeys.wrappingKey,
        nonce,
        aad,
        runtime,
      );
      const unsignedEnvelope = unsignedPairingEnvelopeSchema.parse({
        type: 'mirna-pairing-envelope-v1',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        context,
        nonce: bytesToBase64Url(nonce),
        aad,
        ciphertext: bytesToBase64Url(ciphertext),
        ciphertextHash: bytesToBase64Url(await sha256(ciphertext, runtime)),
        ciphertextLength: ciphertext.length,
        candidateManifestHash,
      });
      const signature = await signDomainSeparatedCanonical(
        SYNC_DOMAIN_LABELS.pairingEnvelope,
        unsignedEnvelope,
        setup.device.signingPrivateKey,
        runtime,
      );
      const transcriptMac = await createPairingTranscriptMac(
        unsignedEnvelope,
        transcriptMacKey,
        runtime,
      );
      const confirmationTranscript = pairingConfirmationTranscript(
        unsignedEnvelope,
        signature,
        transcriptMac,
      );
      const keyConfirmation = await createPairingKeyConfirmation(
        confirmationTranscript,
        agreementKeys.confirmationKey,
        runtime,
      );
      const envelope = {
        ...unsignedEnvelope,
        signature,
        transcriptMac,
        keyConfirmation,
      } satisfies PairingEnvelopeV1;
      return {
        pairingRequestId: candidate.requestId,
        claimToken,
        envelope,
        candidateManifest,
        sas: await deriveShortAuthenticationString(
          confirmationTranscript,
          transcriptMac,
          sasKey,
          runtime,
        ),
      };
    } finally {
      clearBytes(vaultMasterKey);
    }
  }
}

interface PreparedRecovery {
  readonly challenge: Parsed<typeof recoveryChallengeSchema>;
  readonly oldGateKey: Uint8Array;
  readonly newRecoveryRoot: Uint8Array;
  readonly confirmationGroupNumbers: readonly number[];
  readonly request: RecoveryCompleteRequestV1;
  readonly setup: LocalSyncSetup;
  completionAttempted: boolean;
}

type RecoveryState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'awaiting-new-recovery-confirmation'; readonly recovery: PreparedRecovery }
  | { readonly kind: 'recovering'; readonly recovery: PreparedRecovery }
  | { readonly kind: 'active'; readonly setup: LocalSyncSetup }
  | { readonly kind: 'failed' };

export interface RecoveryStartResult extends RecoveryCodePresentation {
  readonly vaultId: string;
  readonly previousManifestVersion: number;
}

export class RecoverDeviceLifecycle {
  readonly #dependencies: ResolvedDependencies;
  readonly #maxManifestPages: number;
  #state: RecoveryState = { kind: 'idle' };

  constructor(dependencies: CommonDependencies & { readonly maxManifestPages?: number }) {
    this.#dependencies = resolveDependencies(dependencies);
    this.#maxManifestPages = dependencies.maxManifestPages ?? 100;
    if (!Number.isSafeInteger(this.#maxManifestPages) || this.#maxManifestPages < 1) {
      throw new Error('Broj recovery stranica mora biti pozitivan ceo broj.');
    }
  }

  get state(): RecoveryState['kind'] {
    return this.#state.kind;
  }

  async begin(recoveryCode: string, displayName: string): Promise<RecoveryStartResult> {
    if (this.#state.kind !== 'idle') {
      throw new SyncLifecycleError('invalid-state', 'Recovery je već započet.');
    }
    await assertNoExistingVault(this.#dependencies.repository);
    const normalizedDisplayName = normalizeDeviceName(displayName);
    const runtime = this.#dependencies.runtime;
    const parsedCode = await parseRecoveryCode(recoveryCode, runtime);
    const [deviceKeys, localWrappingKey] = await Promise.all([
      generateDeviceKeyPairs(runtime),
      generateLocalWrappingKey(runtime),
    ]);
    const deviceId = createOpaqueId(runtime);
    const newDevicePublicKeys = await publicDeviceKeys(deviceKeys, runtime);
    const challengeRequest = recoveryChallengeRequestSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      recoveryLookupId: parsedCode.recoveryLookupId,
      newDeviceId: deviceId,
      newDevicePublicKeys,
      origin: this.#dependencies.origin,
    });
    let challenge: Parsed<typeof recoveryChallengeSchema>;
    try {
      challenge = recoveryChallengeSchema.parse(
        await this.#dependencies.api.requestRecoveryChallenge(challengeRequest),
      );
      if (
        challenge.recoveryLookupId !== parsedCode.recoveryLookupId ||
        challenge.newDeviceId !== deviceId ||
        !sameCanonicalValue(challenge.newDevicePublicKeys, newDevicePublicKeys) ||
        challenge.origin !== this.#dependencies.origin ||
        Date.parse(challenge.expiresAt) <= this.#dependencies.now().getTime()
      ) {
        throw new SyncLifecycleError(
          'challenge-mismatch',
          'Recovery challenge nije vezan za ovaj uređaj i kod.',
        );
      }
    } catch (error) {
      clearBytes(parsedCode.recoveryRoot);
      throw error;
    }
    let recoveryKeys: Awaited<ReturnType<typeof deriveRecoveryKeys>>;
    try {
      recoveryKeys = await deriveRecoveryKeys(
        parsedCode.recoveryRoot,
        { vaultId: challenge.vaultId, recoveryLookupId: parsedCode.recoveryLookupId },
        runtime,
      );
    } finally {
      clearBytes(parsedCode.recoveryRoot);
    }
    try {
      const { recoveryEnvelope, manifestChain } = await this.#collectRecoveryBundle(
        challenge,
        recoveryKeys.gateKey,
      );
      const bundle = await openEncryptedRecoveryBundleEnvelope(
        recoveryEnvelope,
        recoveryKeys.wrappingKey,
        runtime,
      );
      const currentManifest = await this.#validateRecoveryChain(bundle, manifestChain, challenge);
      const recovery = await this.#prepareRecovery({
        displayName: normalizedDisplayName,
        challenge,
        oldGateKey: recoveryKeys.gateKey,
        oldBundle: bundle,
        currentManifest,
        deviceId,
        deviceKeys,
        localWrappingKey,
      });
      const newCode = await createRecoveryCode(
        recovery.request.newRecovery.recoveryLookupId,
        recovery.newRecoveryRoot,
        runtime,
      );
      this.#state = { kind: 'awaiting-new-recovery-confirmation', recovery };
      return {
        recoveryCode: newCode,
        confirmationGroupNumbers: recovery.confirmationGroupNumbers,
        vaultId: challenge.vaultId,
        previousManifestVersion: currentManifest.manifestVersion,
      };
    } catch (error) {
      clearBytes(recoveryKeys.gateKey);
      this.#state = { kind: 'failed' };
      throw error;
    }
  }

  async confirmNewRecoveryCode(
    values: readonly RecoveryConfirmationValue[],
  ): Promise<LocalSyncSetup> {
    if (this.#state.kind === 'awaiting-new-recovery-confirmation') {
      const recovery = this.#state.recovery;
      const code = await createRecoveryCode(
        recovery.request.newRecovery.recoveryLookupId,
        recovery.newRecoveryRoot,
        this.#dependencies.runtime,
      );
      verifyRecoveryConfirmation(code, recovery.confirmationGroupNumbers, values);
      this.#state = { kind: 'recovering', recovery };
    }
    if (this.#state.kind !== 'recovering') {
      if (this.#state.kind === 'active') return this.#state.setup;
      throw new SyncLifecycleError(
        'invalid-state',
        'Novi recovery kod mora biti potvrđen pre završetka.',
      );
    }
    const { recovery } = this.#state;
    if (
      !recovery.completionAttempted &&
      Date.parse(recovery.challenge.expiresAt) <= this.#dependencies.now().getTime()
    ) {
      clearBytes(recovery.oldGateKey, recovery.newRecoveryRoot);
      this.#state = { kind: 'failed' };
      throw new SyncLifecycleError('recovery-expired', 'Recovery challenge je istekao.');
    }
    recovery.completionAttempted = true;
    const response = recoveryCompleteResponseSchema.parse(
      await this.#dependencies.api.completeRecovery(
        recovery.request.newManifest.vaultId,
        recovery.request,
      ),
    );
    if (
      !response.recovered ||
      response.vaultId !== recovery.request.newManifest.vaultId ||
      response.deviceId !== recovery.setup.device.deviceId ||
      response.manifestVersion !== recovery.request.newManifest.manifestVersion
    ) {
      throw new SyncLifecycleError(
        'server-ack-mismatch',
        'Server nije potvrdio tačan recovery manifest.',
      );
    }
    await this.#dependencies.repository.write(recovery.setup);
    clearBytes(recovery.oldGateKey, recovery.newRecoveryRoot);
    this.#state = { kind: 'active', setup: recovery.setup };
    return recovery.setup;
  }

  async #collectRecoveryBundle(
    challenge: Parsed<typeof recoveryChallengeSchema>,
    gateKey: Uint8Array,
  ): Promise<{
    recoveryEnvelope: Parsed<typeof recoveryBundleFetchResponseSchema>['recoveryEnvelope'];
    manifestChain: VaultManifestV1[];
  }> {
    let afterManifestVersion: number | null = null;
    let canonicalEnvelope: string | undefined;
    let recoveryEnvelope:
      Parsed<typeof recoveryBundleFetchResponseSchema>['recoveryEnvelope'] | undefined;
    const manifestChain: VaultManifestV1[] = [];
    for (let pageNumber = 0; pageNumber < this.#maxManifestPages; pageNumber += 1) {
      const transcript = {
        type: 'mirna-recovery-bundle-fetch-v1' as const,
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        challenge,
        afterManifestVersion,
      };
      const request = recoveryBundleFetchRequestSchema.parse({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        gateKey: bytesToBase64Url(gateKey),
        transcript,
        gateProof: await createRecoveryProof(transcript, gateKey, this.#dependencies.runtime),
      });
      const response = recoveryBundleFetchResponseSchema.parse(
        await this.#dependencies.api.fetchRecoveryBundle(request),
      );
      const responseEnvelope = canonicalizeJson(response.recoveryEnvelope);
      if (canonicalEnvelope !== undefined && canonicalEnvelope !== responseEnvelope) {
        throw new SyncLifecycleError(
          'recovery-chain-invalid',
          'Server je promenio recovery omot između stranica.',
        );
      }
      canonicalEnvelope = responseEnvelope;
      recoveryEnvelope = response.recoveryEnvelope;
      const previousVersion = manifestChain.at(-1)?.manifestVersion ?? null;
      if (
        (previousVersion !== null &&
          response.manifestChain[0]?.manifestVersion !== previousVersion + 1) ||
        response.manifestChain.some(
          (manifest, index) =>
            index > 0 &&
            manifest.manifestVersion !== response.manifestChain[index - 1].manifestVersion + 1,
        )
      ) {
        throw new SyncLifecycleError(
          'recovery-chain-invalid',
          'Recovery manifesti nisu neprekidno poređani.',
        );
      }
      manifestChain.push(...response.manifestChain);
      if (response.nextAfterManifestVersion === null) break;
      const lastVersion = manifestChain.at(-1)?.manifestVersion;
      if (
        lastVersion === undefined ||
        response.nextAfterManifestVersion !== lastVersion ||
        response.nextAfterManifestVersion === afterManifestVersion
      ) {
        throw new SyncLifecycleError(
          'recovery-chain-invalid',
          'Server je vratio neispravan recovery kursor.',
        );
      }
      afterManifestVersion = response.nextAfterManifestVersion;
      if (pageNumber === this.#maxManifestPages - 1) {
        throw new SyncLifecycleError(
          'recovery-chain-invalid',
          'Recovery manifest lanac je prekoračio bezbedno ograničenje.',
        );
      }
    }
    if (!recoveryEnvelope || manifestChain.length === 0) {
      throw new SyncLifecycleError('recovery-chain-invalid', 'Server nije vratio recovery paket.');
    }
    return { recoveryEnvelope, manifestChain };
  }

  async #validateRecoveryChain(
    bundle: RecoveryBundleV1,
    manifests: readonly VaultManifestV1[],
    challenge: Parsed<typeof recoveryChallengeSchema>,
  ): Promise<VaultManifestV1> {
    const first = manifests[0];
    if (
      !first ||
      !sameCanonicalValue(first, bundle.pinnedManifest) ||
      (await manifestBodyHash(first, this.#dependencies.runtime)) !== bundle.pinnedManifestHash
    ) {
      throw new SyncLifecycleError(
        'recovery-chain-invalid',
        'Recovery lanac ne počinje zakačenim manifestom.',
      );
    }
    if (first.manifestVersion === 1) {
      await verifyInitialManifest(first, this.#dependencies.runtime);
    }
    for (let index = 1; index < manifests.length; index += 1) {
      await validateManifestTransition(
        manifests[index - 1],
        manifests[index],
        this.#dependencies.runtime,
      );
    }
    const current = manifests.at(-1);
    if (
      !current ||
      current.vaultId !== challenge.vaultId ||
      current.manifestVersion !== challenge.previousManifestVersion ||
      (await manifestBodyHash(current, this.#dependencies.runtime)) !==
        challenge.previousManifestHash
    ) {
      throw new SyncLifecycleError(
        'recovery-chain-invalid',
        'Recovery lanac ne završava trenutnim server manifestom.',
      );
    }
    return current;
  }

  async #prepareRecovery(input: {
    displayName: string;
    challenge: Parsed<typeof recoveryChallengeSchema>;
    oldGateKey: Uint8Array;
    oldBundle: RecoveryBundleV1;
    currentManifest: VaultManifestV1;
    deviceId: string;
    deviceKeys: DeviceKeyPairs;
    localWrappingKey: CryptoKey;
  }): Promise<PreparedRecovery> {
    const runtime = this.#dependencies.runtime;
    const oldVaultMasterKey = base64UrlToBytes(input.oldBundle.vaultMasterKey);
    if (oldVaultMasterKey.length !== SYNC_LIMITS.vaultMasterKeyBytes) {
      clearBytes(oldVaultMasterKey);
      throw new SyncLifecycleError(
        'recovery-chain-invalid',
        'Recovery paket sadrži neispravan ključ trezora.',
      );
    }
    let generatedVaultMasterKey: Uint8Array | undefined;
    let generatedRecoveryRoot: Uint8Array | undefined;
    try {
      const oldRecoveryPrivateKey = await importRecoverySigningPrivateKey(
        input.oldBundle.recoverySigningPrivateKeyPkcs8,
        runtime,
      );
      const [newRecoverySigningKeys] = await Promise.all([generateRecoverySigningKeyPair(runtime)]);
      const newVaultMasterKey = randomBytes(SYNC_LIMITS.vaultMasterKeyBytes, runtime);
      generatedVaultMasterKey = newVaultMasterKey;
      const newRecoveryRoot = randomBytes(SYNC_LIMITS.recoveryRootBytes, runtime);
      generatedRecoveryRoot = newRecoveryRoot;
      const newRecoveryLookupId = bytesToBase64Url(
        randomBytes(SYNC_LIMITS.recoveryLookupIdBytes, runtime),
      );
      const occurredAt = this.#dependencies.now();
      const newDevice = await createManifestDevice({
        deviceId: input.deviceId,
        keyPairs: input.deviceKeys,
        authorizedAt: occurredAt.toISOString(),
        authorizationExpiresAt: addMilliseconds(
          occurredAt,
          SYNC_LIMITS.deviceAuthorizationLifetimeMs,
        ),
        runtime,
      });
      const newRecoveryPublicKey = await exportPublicEcKey(
        newRecoverySigningKeys.publicKey,
        runtime,
      );
      const unsignedManifest = unsignedVaultManifestSchema.parse({
        ...withoutManifestSignature(input.currentManifest),
        manifestVersion: input.currentManifest.manifestVersion + 1,
        keyEpoch: input.currentManifest.keyEpoch + 1,
        devices: [newDevice],
        revokedDevices: [
          ...input.currentManifest.revokedDevices,
          ...input.currentManifest.devices.map((device) => ({
            deviceId: device.deviceId,
            publicKeys: device.publicKeys,
            revokedAt: occurredAt.toISOString(),
            revocationAuthority: 'recovery' as const,
            revokedByDeviceId: null,
            lastAuthorizedManifestVersion: input.currentManifest.manifestVersion,
          })),
        ].sort(deviceIdComparator),
        recoveryLookupId: newRecoveryLookupId,
        recoverySigningPublicKey: newRecoveryPublicKey,
        previousManifestHash: await manifestBodyHash(input.currentManifest, runtime),
        transition: {
          transitionId: createOpaqueId(runtime),
          kind: 'recover-device',
          authorizationKind: 'recovery',
          authorizingDeviceId: null,
          affectedDeviceId: input.deviceId,
          occurredAt: occurredAt.toISOString(),
        },
      });
      const newManifest = await signVaultManifest(unsignedManifest, oldRecoveryPrivateKey, runtime);
      await validateManifestTransition(input.currentManifest, newManifest, runtime);
      const newManifestHash = await manifestBodyHash(newManifest, runtime);
      const newRecoveryKeys = await deriveRecoveryKeys(
        newRecoveryRoot,
        { vaultId: newManifest.vaultId, recoveryLookupId: newRecoveryLookupId },
        runtime,
      );
      try {
        const newBundle: RecoveryBundleV1 = {
          protocolVersion: SYNC_PROTOCOL_VERSION,
          suite: SYNC_CRYPTO_SUITE,
          vaultId: newManifest.vaultId,
          recoveryLookupId: newRecoveryLookupId,
          keyEpoch: newManifest.keyEpoch,
          vaultMasterKey: bytesToBase64Url(newVaultMasterKey),
          recoverySigningPrivateKeyPkcs8: await exportRecoverySigningPrivateKey(
            newRecoverySigningKeys.privateKey,
            runtime,
          ),
          recoverySigningPublicKey: newRecoveryPublicKey,
          pinnedManifest: newManifest,
          pinnedManifestHash: newManifestHash,
        };
        const newRecoveryEnvelope = await createEncryptedRecoveryBundleEnvelope(
          newBundle,
          newRecoveryKeys.wrappingKey,
          {
            protocolVersion: SYNC_PROTOCOL_VERSION,
            suite: SYNC_CRYPTO_SUITE,
            vaultId: newManifest.vaultId,
            keyEpoch: newManifest.keyEpoch,
            objectType: 'recovery-vault-key',
            objectId: createOpaqueId(runtime),
            creatingDeviceId: input.deviceId,
            recoveryLookupId: newRecoveryLookupId,
            parentManifestHash: newManifestHash,
          },
          runtime,
        );
        const newRecovery: RecoveryRecordV1 = recoveryRecordSchema.parse({
          protocolVersion: SYNC_PROTOCOL_VERSION,
          suite: SYNC_CRYPTO_SUITE,
          vaultId: newManifest.vaultId,
          recoveryLookupId: newRecoveryLookupId,
          keyEpoch: newManifest.keyEpoch,
          recoveryEnvelope: newRecoveryEnvelope,
          recoverySigningPublicKey: newRecoveryPublicKey,
          recoveryGateKeyHash: await hashRecoveryGateKey(newRecoveryKeys.gateKey, runtime),
          manifestVersion: newManifest.manifestVersion,
          manifestHash: newManifestHash,
          updatedAt: occurredAt.toISOString(),
        });
        const newRecoveryHash = await hashDomainSeparatedCanonical(
          SYNC_DOMAIN_LABELS.recoveryRecord,
          newRecovery,
          runtime,
        );
        const transcript = {
          type: 'mirna-recovery-proof-v1' as const,
          protocolVersion: SYNC_PROTOCOL_VERSION,
          suite: SYNC_CRYPTO_SUITE,
          purpose: 'recovery-manifest-transition' as const,
          vaultId: newManifest.vaultId,
          recoveryLookupId: input.challenge.recoveryLookupId,
          challengeId: input.challenge.challengeId,
          challenge: input.challenge.challenge,
          newDeviceId: input.deviceId,
          newDevicePublicKeys: newDevice.publicKeys,
          previousManifestVersion: input.currentManifest.manifestVersion,
          previousManifestHash: await manifestBodyHash(input.currentManifest, runtime),
          transitionBodyHash: newManifestHash,
          newRecoveryBundleHash: newRecoveryHash,
          newRecoveryLookupId,
          idempotencyKey: createOpaqueId(runtime),
          origin: this.#dependencies.origin,
          method: 'POST' as const,
          path: `/v1/vaults/${newManifest.vaultId}/recover`,
          issuedAt: input.challenge.issuedAt,
          expiresAt: input.challenge.expiresAt,
        };
        const request = recoveryCompleteRequestSchema.parse({
          protocolVersion: SYNC_PROTOCOL_VERSION,
          gateKey: bytesToBase64Url(input.oldGateKey),
          transcript,
          gateProof: await createRecoveryProof(transcript, input.oldGateKey, runtime),
          recoveryAuthorizationSignature: await signDomainSeparatedCanonical(
            SYNC_DOMAIN_LABELS.recoveryTransition,
            transcript,
            oldRecoveryPrivateKey,
            runtime,
          ),
          newManifest,
          newRecovery,
        });
        const setup = await createLocalSetup({
          manifest: newManifest,
          manifestHash: newManifestHash,
          device: newDevice,
          displayName: input.displayName,
          deviceKeys: input.deviceKeys,
          localWrappingKey: input.localWrappingKey,
          vaultMasterKey: newVaultMasterKey,
          enabledAt: occurredAt.toISOString(),
          runtime,
        });
        const newCode = await createRecoveryCode(newRecoveryLookupId, newRecoveryRoot, runtime);
        const groupCount = recoveryGroups(newCode).length;
        const confirmationGroupNumbers = assertConfirmationSelection(
          groupCount,
          this.#dependencies.selectRecoveryConfirmationGroups(groupCount, runtime),
        );
        return {
          challenge: input.challenge,
          oldGateKey: input.oldGateKey,
          newRecoveryRoot,
          confirmationGroupNumbers,
          request,
          setup,
          completionAttempted: false,
        };
      } catch (error) {
        clearBytes(newRecoveryRoot);
        throw error;
      } finally {
        clearBytes(oldVaultMasterKey, newVaultMasterKey, newRecoveryKeys.gateKey);
      }
    } catch (error) {
      if (generatedVaultMasterKey) clearBytes(generatedVaultMasterKey);
      if (generatedRecoveryRoot) clearBytes(generatedRecoveryRoot);
      clearBytes(oldVaultMasterKey);
      throw error;
    }
  }
}
