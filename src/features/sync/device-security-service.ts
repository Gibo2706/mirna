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
  createRecoveryProof,
  deriveDeviceEnvelopeWrappingKey,
  deriveRecoveryKeys,
  hashDomainSeparatedCanonical,
  hashRecoveryGateKey,
  importAgreementPublicKey,
  importRecoverySigningPrivateKey,
  openEncryptedKeyEnvelope,
  openEncryptedRecoveryBundleEnvelope,
  parseRecoveryCode,
  randomBytes,
  signDomainSeparatedCanonical,
} from '@/domain/sync/crypto';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  clearBytes,
  timingSafeEqual,
} from '@/domain/sync/encoding';
import {
  manifestBodyHash,
  signVaultManifest,
  validateManifestTransition,
  verifyInitialManifest,
} from '@/domain/sync/manifest';
import {
  authChallengeSchema,
  deviceKeyEnvelopeResponseSchema,
  deviceKeyEnvelopeSchema,
  deviceRenewRequestSchema,
  deviceRenewResponseSchema,
  manifestChangesResponseSchema,
  recoveryBundleFetchRequestSchema,
  recoveryBundleFetchResponseSchema,
  recoveryChallengeSchema,
  recoveryRecordSchema,
  secureDeviceRevocationRequestSchema,
  secureDeviceRevocationResponseSchema,
  unsignedVaultManifestSchema,
  vaultManifestSchema,
  vaultDeletionRequestSchema,
  vaultDeletionResponseSchema,
  type AuthChallengeV1,
  type DeviceKeyEnvelopeV1,
  type RecoveryBundleV1,
  type SecureDeviceRevocationRequestV1,
  type VaultManifestV1,
} from '@/domain/sync/schemas';
import { db } from '@/db/database';
import {
  readLocalSyncSetup,
  writeAdvancedLocalSyncSetup,
  writeRotatedLocalSyncSetup,
} from '@/db/sync/repository';
import { localVaultKeyRecordId, type LocalSyncSetup } from '@/db/sync/records';
import type { MirnaSyncApi } from './api';

const MAX_RECOVERY_MANIFEST_PAGES = 100;
const MAX_FUTURE_CLOCK_SKEW_MS = 2 * 60 * 1_000;

type Parsed<T extends { parse(value: unknown): unknown }> = ReturnType<T['parse']>;

export interface DeviceSecurityApiPort {
  readonly hasActiveSession?: boolean;
  requestAuthChallenge(input: {
    protocolVersion: typeof SYNC_PROTOCOL_VERSION;
    suite: typeof SYNC_CRYPTO_SUITE;
    vaultId: string;
    deviceId: string;
    audience: AuthChallengeV1['audience'];
    origin: string;
  }): Promise<unknown>;
  createSession(input: {
    protocolVersion: typeof SYNC_PROTOCOL_VERSION;
    challenge: AuthChallengeV1;
    signature: string;
  }): Promise<unknown>;
  clearSession(): void;
  getCurrentManifest(): Promise<unknown>;
  getManifestChanges(afterManifestVersion: number): Promise<unknown>;
  renewDevice(deviceId: string, input: Parsed<typeof deviceRenewRequestSchema>): Promise<unknown>;
  requestRecoveryChallenge(input: {
    protocolVersion: typeof SYNC_PROTOCOL_VERSION;
    suite: typeof SYNC_CRYPTO_SUITE;
    recoveryLookupId: string;
    newDeviceId: string;
    newDevicePublicKeys: LocalSyncSetup['vault']['manifest']['devices'][number]['publicKeys'];
    origin: string;
  }): Promise<unknown>;
  fetchRecoveryBundle(input: Parsed<typeof recoveryBundleFetchRequestSchema>): Promise<unknown>;
  secureRevokeDevice(deviceId: string, input: SecureDeviceRevocationRequestV1): Promise<unknown>;
  deleteVault(input: Parsed<typeof vaultDeletionRequestSchema>): Promise<unknown>;
  getCurrentDeviceKeyEnvelope(): Promise<unknown>;
  getDeviceKeyEnvelope(keyEpoch: number): Promise<unknown>;
}

export interface DeviceSecurityRepositoryPort {
  read(): Promise<LocalSyncSetup | undefined>;
  write(current: LocalSyncSetup, next: LocalSyncSetup): Promise<LocalSyncSetup>;
  writeRotated(setup: LocalSyncSetup): Promise<LocalSyncSetup>;
  rotationBlockers(vaultId: string): Promise<{
    readonly pendingOperations: number;
    readonly pendingConflicts: number;
  }>;
}

const defaultRepository: DeviceSecurityRepositoryPort = {
  read: () => readLocalSyncSetup(),
  write: (current, next) => writeAdvancedLocalSyncSetup(current, next),
  writeRotated: (setup) => writeRotatedLocalSyncSetup(setup),
  rotationBlockers: async (vaultId) => {
    const [pendingOperations, pendingConflicts] = await Promise.all([
      db.syncOutbox.where('vaultId').equals(vaultId).count(),
      db.syncConflicts.where('[vaultId+resolutionState]').equals([vaultId, 'pending']).count(),
    ]);
    return { pendingOperations, pendingConflicts };
  },
};

export type DeviceSecurityErrorCode =
  | 'not-enabled'
  | 'invalid-origin'
  | 'challenge-mismatch'
  | 'manifest-fork'
  | 'manifest-gap'
  | 'device-revoked'
  | 'device-not-found'
  | 'self-revocation-not-supported'
  | 'rotation-blocked'
  | 'recovery-code-mismatch'
  | 'recovery-chain-invalid'
  | 'key-envelope-invalid'
  | 'typed-confirmation-mismatch'
  | 'deletion-pending'
  | 'server-ack-mismatch';

export const CLOUD_VAULT_DELETE_CONFIRMATION = 'OBRIŠI ŠIFROVANI CLOUD TREZOR' as const;

interface OpenedRecoveryAuthority {
  readonly challenge: Parsed<typeof recoveryChallengeSchema>;
  readonly gateKey: Uint8Array;
  readonly wrappingKey: CryptoKey;
  readonly bundle: RecoveryBundleV1;
  readonly signingPrivateKey: CryptoKey;
}

export class DeviceSecurityError extends Error {
  constructor(
    readonly code: DeviceSecurityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceSecurityError';
  }
}

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
    throw new DeviceSecurityError('invalid-origin', 'Sinhronizacija zahteva tačan HTTPS origin.');
  }
};

const same = (left: unknown, right: unknown): boolean =>
  canonicalizeJson(left) === canonicalizeJson(right);

const unsignedManifest = (manifest: VaultManifestV1) => {
  const { signature: _signature, ...unsigned } = manifest;
  void _signature;
  return unsigned;
};

const assertChallenge = (
  challenge: AuthChallengeV1,
  expected: {
    readonly vaultId: string;
    readonly deviceId: string;
    readonly audience: AuthChallengeV1['audience'];
    readonly origin: string;
  },
  now: number,
): void => {
  if (
    challenge.vaultId !== expected.vaultId ||
    challenge.deviceId !== expected.deviceId ||
    challenge.audience !== expected.audience ||
    challenge.origin !== expected.origin ||
    challenge.method !== 'POST' ||
    Date.parse(challenge.issuedAt) > now + MAX_FUTURE_CLOCK_SKEW_MS ||
    Date.parse(challenge.expiresAt) <= now
  ) {
    throw new DeviceSecurityError(
      'challenge-mismatch',
      'Server je vratio challenge koji ne pripada očekivanoj radnji.',
    );
  }
};

const activeDevice = (manifest: VaultManifestV1, deviceId: string) =>
  manifest.devices.find((device) => device.deviceId === deviceId);

const compareDeviceId = (left: { deviceId: string }, right: { deviceId: string }): number =>
  left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0;

const deviceEnvelopeContext = (
  envelope: Pick<
    DeviceKeyEnvelopeV1,
    | 'protocolVersion'
    | 'suite'
    | 'vaultId'
    | 'keyEpoch'
    | 'senderDeviceId'
    | 'recipientDeviceId'
    | 'parentManifestHash'
  >,
) => ({
  protocolVersion: envelope.protocolVersion,
  suite: envelope.suite,
  vaultId: envelope.vaultId,
  keyEpoch: envelope.keyEpoch,
  senderDeviceId: envelope.senderDeviceId,
  recipientDeviceId: envelope.recipientDeviceId,
  parentManifestHash: envelope.parentManifestHash,
});

const localKeyRecord = async (
  setup: LocalSyncSetup,
  manifest: VaultManifestV1,
  manifestHash: string,
  vaultMasterKey: Uint8Array,
  now: string,
) => ({
  id: localVaultKeyRecordId(manifest.vaultId, manifest.keyEpoch),
  vaultId: manifest.vaultId,
  keyEpoch: manifest.keyEpoch,
  purpose: 'vault-master-key' as const,
  encryptedKey: await createEncryptedKeyEnvelope(vaultMasterKey, setup.device.localWrappingKey, {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    vaultId: manifest.vaultId,
    keyEpoch: manifest.keyEpoch,
    objectType: 'local-vault-key',
    objectId: createOpaqueId(),
    creatingDeviceId: setup.device.deviceId,
    recoveryLookupId: null,
    parentManifestHash: manifestHash,
  }),
  createdAt: now,
});

const nextSetup = async (input: {
  readonly current: LocalSyncSetup;
  readonly manifest: VaultManifestV1;
  readonly manifestHash: string;
  readonly vaultMasterKey: Uint8Array;
  readonly now: string;
  readonly pendingRotationSnapshot: boolean;
}): Promise<LocalSyncSetup> => {
  const local = activeDevice(input.manifest, input.current.device.deviceId);
  if (!local) {
    throw new DeviceSecurityError(
      'device-revoked',
      'Ovaj uređaj više nije aktivan u potpisanom manifestu.',
    );
  }
  return {
    ...input.current,
    vault: {
      ...input.current.vault,
      keyEpoch: input.manifest.keyEpoch,
      manifest: input.manifest,
      updatedAt: input.now,
    },
    device: {
      ...input.current.device,
      authorizationExpiresAt: local.authorizationExpiresAt,
      updatedAt: input.now,
    },
    vaultKey: await localKeyRecord(
      input.current,
      input.manifest,
      input.manifestHash,
      input.vaultMasterKey,
      input.now,
    ),
    metadata: {
      ...input.current.metadata,
      lastManifestHash: input.manifestHash,
      pendingKeyRotationSnapshotEpoch: input.pendingRotationSnapshot
        ? input.manifest.keyEpoch
        : input.current.metadata.pendingKeyRotationSnapshotEpoch,
    },
  };
};

const assertExactCurrentManifest = async (
  setup: LocalSyncSetup,
  remote: VaultManifestV1,
): Promise<string> => {
  const [localHash, remoteHash] = await Promise.all([
    manifestBodyHash(setup.vault.manifest),
    manifestBodyHash(remote),
  ]);
  if (
    localHash !== setup.metadata.lastManifestHash ||
    remote.manifestVersion !== setup.vault.manifest.manifestVersion ||
    remoteHash !== localHash
  ) {
    throw new DeviceSecurityError(
      'manifest-fork',
      'Bezbednosna radnja zahteva tačno usaglašen trenutni manifest.',
    );
  }
  return localHash;
};

export class DeviceSecurityService {
  readonly #api: DeviceSecurityApiPort;
  readonly #repository: DeviceSecurityRepositoryPort;
  readonly #origin: string;
  readonly #now: () => Date;
  #queue: Promise<void> = Promise.resolve();

  constructor(input: {
    readonly api: DeviceSecurityApiPort | MirnaSyncApi;
    readonly origin: string;
    readonly repository?: DeviceSecurityRepositoryPort;
    readonly now?: () => Date;
  }) {
    this.#api = input.api;
    this.#repository = input.repository ?? defaultRepository;
    this.#origin = exactOrigin(input.origin);
    this.#now = input.now ?? (() => new Date());
  }

  reconcileKeyEpoch(): Promise<LocalSyncSetup> {
    return this.#enqueue(() => this.#reconcileKeyEpoch());
  }

  renewDevice(deviceId: string): Promise<LocalSyncSetup> {
    return this.#enqueue(() => this.#renewDevice(deviceId));
  }

  secureRevokeDevice(deviceId: string, recoveryCode: string): Promise<LocalSyncSetup> {
    return this.#enqueue(() => this.#secureRevokeDevice(deviceId, recoveryCode));
  }

  deleteCloudVault(recoveryCode: string, typedConfirmation: string): Promise<void> {
    return this.#enqueue(() => this.#deleteCloudVault(recoveryCode, typedConfirmation));
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.#queue.then(work);
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #setup(): Promise<LocalSyncSetup> {
    const setup = await this.#repository.read();
    if (!setup) {
      throw new DeviceSecurityError(
        'not-enabled',
        'Sinhronizacija nije uključena na ovom uređaju.',
      );
    }
    return setup;
  }

  async #signedChallenge(
    setup: LocalSyncSetup,
    audience: AuthChallengeV1['audience'],
  ): Promise<{ challenge: AuthChallengeV1; signature: string }> {
    const expected = {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: setup.vault.vaultId,
      deviceId: setup.device.deviceId,
      audience,
      origin: this.#origin,
    } as const;
    const challenge = authChallengeSchema.parse(await this.#api.requestAuthChallenge(expected));
    assertChallenge(challenge, expected, this.#now().getTime());
    return {
      challenge,
      signature: await signDomainSeparatedCanonical(
        SYNC_DOMAIN_LABELS.authChallenge,
        challenge,
        setup.device.signingPrivateKey,
      ),
    };
  }

  async #authenticate(setup: LocalSyncSetup): Promise<void> {
    if (this.#api.hasActiveSession === true) return;
    const signed = await this.#signedChallenge(setup, '/v1/auth/session');
    await this.#api.createSession({ protocolVersion: SYNC_PROTOCOL_VERSION, ...signed });
  }

  async #openRecoveryAuthority(
    setup: LocalSyncSetup,
    current: VaultManifestV1,
    currentManifestHash: string,
    recoveryCode: string,
  ): Promise<OpenedRecoveryAuthority> {
    const parsedCode = await parseRecoveryCode(recoveryCode);
    let gateKey: Uint8Array | undefined;
    try {
      if (parsedCode.recoveryLookupId !== current.recoveryLookupId) {
        throw new DeviceSecurityError(
          'recovery-code-mismatch',
          'Recovery kod ne pripada ovom trezoru.',
        );
      }
      const localManifestDevice = activeDevice(current, setup.device.deviceId);
      if (!localManifestDevice) {
        throw new DeviceSecurityError('device-revoked', 'Lokalni uređaj nije aktivan.');
      }
      const challenge = recoveryChallengeSchema.parse(
        await this.#api.requestRecoveryChallenge({
          protocolVersion: SYNC_PROTOCOL_VERSION,
          suite: SYNC_CRYPTO_SUITE,
          recoveryLookupId: current.recoveryLookupId,
          newDeviceId: setup.device.deviceId,
          newDevicePublicKeys: localManifestDevice.publicKeys,
          origin: this.#origin,
        }),
      );
      if (
        challenge.vaultId !== setup.vault.vaultId ||
        challenge.recoveryLookupId !== current.recoveryLookupId ||
        challenge.newDeviceId !== setup.device.deviceId ||
        !same(challenge.newDevicePublicKeys, localManifestDevice.publicKeys) ||
        challenge.previousManifestVersion !== current.manifestVersion ||
        challenge.previousManifestHash !== currentManifestHash ||
        challenge.origin !== this.#origin ||
        Date.parse(challenge.expiresAt) <= this.#now().getTime()
      ) {
        throw new DeviceSecurityError(
          'challenge-mismatch',
          'Recovery potvrda nije vezana za trenutni uređaj i manifest.',
        );
      }
      const recoveryKeys = await deriveRecoveryKeys(parsedCode.recoveryRoot, {
        vaultId: current.vaultId,
        recoveryLookupId: current.recoveryLookupId,
      });
      gateKey = recoveryKeys.gateKey;
      const { recoveryEnvelope, manifestChain } = await this.#collectRecoveryBundle(
        challenge,
        gateKey,
      );
      const bundle = await openEncryptedRecoveryBundleEnvelope(
        recoveryEnvelope,
        recoveryKeys.wrappingKey,
      );
      await this.#validateRecoveryChain(bundle, manifestChain, current, currentManifestHash);
      const localVaultMasterKey = await openEncryptedKeyEnvelope(
        setup.vaultKey.encryptedKey,
        setup.device.localWrappingKey,
      );
      const recoveryVaultMasterKey = base64UrlToBytes(bundle.vaultMasterKey);
      try {
        if (!timingSafeEqual(localVaultMasterKey, recoveryVaultMasterKey)) {
          throw new DeviceSecurityError(
            'recovery-chain-invalid',
            'Recovery paket i lokalni aktivni ključ se ne poklapaju.',
          );
        }
      } finally {
        clearBytes(localVaultMasterKey, recoveryVaultMasterKey);
      }
      return {
        challenge,
        gateKey,
        wrappingKey: recoveryKeys.wrappingKey,
        bundle,
        signingPrivateKey: await importRecoverySigningPrivateKey(
          bundle.recoverySigningPrivateKeyPkcs8,
        ),
      };
    } catch (error) {
      if (gateKey) clearBytes(gateKey);
      throw error;
    } finally {
      clearBytes(parsedCode.recoveryRoot);
    }
  }

  async #reconcileKeyEpoch(): Promise<LocalSyncSetup> {
    let setup = await this.#setup();
    await this.#authenticate(setup);
    const remote = vaultManifestSchema.parse(await this.#api.getCurrentManifest());
    const [localHash, remoteHash] = await Promise.all([
      manifestBodyHash(setup.vault.manifest),
      manifestBodyHash(remote),
    ]);
    if (localHash !== setup.metadata.lastManifestHash) {
      throw new DeviceSecurityError('manifest-fork', 'Lokalni manifest pin je neispravan.');
    }
    if (remote.manifestVersion === setup.vault.manifest.manifestVersion) {
      if (remoteHash !== localHash) {
        throw new DeviceSecurityError('manifest-fork', 'Otkriven je fork manifesta.');
      }
      return setup;
    }
    const chain = await this.#collectManifestChanges(setup, remote);
    for (const manifest of chain) {
      const prior = setup.vault.manifest;
      await validateManifestTransition(prior, manifest);
      if (!activeDevice(manifest, setup.device.deviceId)) {
        throw new DeviceSecurityError(
          'device-revoked',
          'Ovaj uređaj je opozvan i nema pristup novoj epohi.',
        );
      }
      const manifestHash = await manifestBodyHash(manifest);
      if (manifest.keyEpoch === setup.vault.keyEpoch) {
        setup = await this.#adoptSameEpochManifest(setup, manifest, manifestHash);
        continue;
      }
      if (manifest.keyEpoch !== setup.vault.keyEpoch + 1) {
        throw new DeviceSecurityError('manifest-gap', 'Nedostaje epoha ključa.');
      }
      setup = await this.#adoptNextKeyEpoch(setup, manifest, manifestHash);
    }
    if (!same(setup.vault.manifest, remote) || setup.metadata.lastManifestHash !== remoteHash) {
      throw new DeviceSecurityError(
        'manifest-fork',
        'Manifest lanac ne završava trenutnim server stanjem.',
      );
    }
    return setup;
  }

  async #collectManifestChanges(
    setup: LocalSyncSetup,
    remote: VaultManifestV1,
  ): Promise<VaultManifestV1[]> {
    const manifests: VaultManifestV1[] = [];
    let afterManifestVersion = setup.vault.manifest.manifestVersion;
    for (let page = 0; page < MAX_RECOVERY_MANIFEST_PAGES; page += 1) {
      const response = manifestChangesResponseSchema.parse(
        await this.#api.getManifestChanges(afterManifestVersion),
      );
      if (
        response.manifests.length === 0 ||
        response.manifests[0]?.manifestVersion !== afterManifestVersion + 1 ||
        response.manifests.some(
          (manifest, index) =>
            index > 0 &&
            manifest.manifestVersion !== response.manifests[index - 1].manifestVersion + 1,
        )
      ) {
        throw new DeviceSecurityError(
          'manifest-gap',
          'Server nije vratio neprekidan manifest lanac.',
        );
      }
      manifests.push(...response.manifests);
      const lastVersion = manifests.at(-1)?.manifestVersion;
      if (response.nextAfterManifestVersion === null) break;
      if (
        response.nextAfterManifestVersion !== lastVersion ||
        response.nextAfterManifestVersion === afterManifestVersion ||
        page === MAX_RECOVERY_MANIFEST_PAGES - 1
      ) {
        throw new DeviceSecurityError('manifest-gap', 'Manifest kursor nije validan.');
      }
      afterManifestVersion = response.nextAfterManifestVersion;
    }
    if (!same(manifests.at(-1), remote)) {
      throw new DeviceSecurityError(
        'manifest-fork',
        'Manifest lanac se ne završava trenutnim server manifestom.',
      );
    }
    return manifests;
  }

  async #adoptNextKeyEpoch(
    setup: LocalSyncSetup,
    manifest: VaultManifestV1,
    manifestHash: string,
  ): Promise<LocalSyncSetup> {
    const response = deviceKeyEnvelopeResponseSchema.parse(
      await this.#api.getDeviceKeyEnvelope(manifest.keyEpoch),
    );
    const envelope = response.envelope;
    const sender = activeDevice(setup.vault.manifest, envelope.senderDeviceId);
    if (
      !sender ||
      envelope.vaultId !== setup.vault.vaultId ||
      envelope.keyEpoch !== manifest.keyEpoch ||
      envelope.recipientDeviceId !== setup.device.deviceId ||
      envelope.parentManifestHash !== manifestHash
    ) {
      throw new DeviceSecurityError(
        'key-envelope-invalid',
        'Omot nove epohe nije vezan za ovaj uređaj i manifest.',
      );
    }
    const salt = base64UrlToBytes(envelope.ecdhSalt);
    const wrappingKey = await deriveDeviceEnvelopeWrappingKey(
      setup.device.agreementPrivateKey,
      await importAgreementPublicKey(sender.publicKeys.agreement),
      salt,
      deviceEnvelopeContext(envelope),
    );
    clearBytes(salt);
    const vaultMasterKey = await openEncryptedKeyEnvelope(envelope.encryptedKey, wrappingKey);
    try {
      if (vaultMasterKey.byteLength !== SYNC_LIMITS.vaultMasterKeyBytes) {
        throw new DeviceSecurityError(
          'key-envelope-invalid',
          'Nova epoha nema validan master ključ.',
        );
      }
      const next = await nextSetup({
        current: setup,
        manifest,
        manifestHash,
        vaultMasterKey,
        now: this.#now().toISOString(),
        pendingRotationSnapshot: envelope.senderDeviceId === setup.device.deviceId,
      });
      return await this.#repository.writeRotated(next);
    } finally {
      clearBytes(vaultMasterKey);
    }
  }

  async #adoptSameEpochManifest(
    setup: LocalSyncSetup,
    manifest: VaultManifestV1,
    manifestHash: string,
  ): Promise<LocalSyncSetup> {
    const vaultMasterKey = await openEncryptedKeyEnvelope(
      setup.vaultKey.encryptedKey,
      setup.device.localWrappingKey,
    );
    try {
      const next = await nextSetup({
        current: setup,
        manifest,
        manifestHash,
        vaultMasterKey,
        now: this.#now().toISOString(),
        pendingRotationSnapshot: false,
      });
      return await this.#repository.write(setup, next);
    } finally {
      clearBytes(vaultMasterKey);
    }
  }

  async #renewDevice(deviceId: string): Promise<LocalSyncSetup> {
    const setup = await this.#setup();
    await this.#authenticate(setup);
    const current = vaultManifestSchema.parse(await this.#api.getCurrentManifest());
    const previousHash = await assertExactCurrentManifest(setup, current);
    const renewed = activeDevice(current, deviceId);
    if (!renewed) {
      throw new DeviceSecurityError('device-not-found', 'Uređaj nije aktivan u manifestu.');
    }
    const signedChallenge = await this.#signedChallenge(setup, '/v1/devices/renew');
    const occurredAt = signedChallenge.challenge.issuedAt;
    const authorizationExpiresAt = new Date(
      Date.parse(occurredAt) + SYNC_LIMITS.deviceAuthorizationLifetimeMs,
    ).toISOString();
    const manifest = await signVaultManifest(
      unsignedVaultManifestSchema.parse({
        ...unsignedManifest(current),
        manifestVersion: current.manifestVersion + 1,
        devices: current.devices
          .map((device) =>
            device.deviceId === deviceId
              ? { ...device, authorizedAt: occurredAt, authorizationExpiresAt }
              : device,
          )
          .sort(compareDeviceId),
        previousManifestHash: previousHash,
        transition: {
          transitionId: createOpaqueId(),
          kind: 'renew-device',
          authorizationKind: 'device',
          authorizingDeviceId: setup.device.deviceId,
          affectedDeviceId: deviceId,
          occurredAt,
        },
      }),
      setup.device.signingPrivateKey,
    );
    await validateManifestTransition(current, manifest);
    const request = deviceRenewRequestSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      newManifest: manifest,
      sensitiveChallenge: signedChallenge.challenge,
      sensitiveSignature: signedChallenge.signature,
    });
    const response = deviceRenewResponseSchema.parse(
      await this.#api.renewDevice(deviceId, request),
    );
    if (
      response.vaultId !== setup.vault.vaultId ||
      response.deviceId !== deviceId ||
      response.manifestVersion !== manifest.manifestVersion ||
      response.authorizationExpiresAt !== authorizationExpiresAt
    ) {
      throw new DeviceSecurityError(
        'server-ack-mismatch',
        'Server nije potvrdio tačnu obnovu uređaja.',
      );
    }
    return this.#adoptSameEpochManifest(setup, manifest, await manifestBodyHash(manifest));
  }

  async #secureRevokeDevice(
    revokedDeviceId: string,
    recoveryCode: string,
  ): Promise<LocalSyncSetup> {
    const setup = await this.#setup();
    if (revokedDeviceId === setup.device.deviceId) {
      throw new DeviceSecurityError(
        'self-revocation-not-supported',
        'Aktivni uređaj ne može bezbedno opozvati samog sebe.',
      );
    }
    const blockers = await this.#repository.rotationBlockers(setup.vault.vaultId);
    if (
      blockers.pendingOperations > 0 ||
      blockers.pendingConflicts > 0 ||
      setup.metadata.syncBlockReason !== undefined ||
      setup.metadata.firstUploadConsent !== 'accepted' ||
      setup.metadata.pendingKeyRotationSnapshotEpoch !== undefined
    ) {
      throw new DeviceSecurityError(
        'rotation-blocked',
        'Pre rotacije završite sync, rešite konflikte i potvrdite početni cloud snimak.',
      );
    }
    await this.#authenticate(setup);
    let gateKey: Uint8Array | undefined;
    let newVaultMasterKey: Uint8Array | undefined;
    try {
      const current = vaultManifestSchema.parse(await this.#api.getCurrentManifest());
      const previousManifestHash = await assertExactCurrentManifest(setup, current);
      const revoked = activeDevice(current, revokedDeviceId);
      if (!revoked) {
        throw new DeviceSecurityError('device-not-found', 'Uređaj nije aktivan u manifestu.');
      }
      const authority = await this.#openRecoveryAuthority(
        setup,
        current,
        previousManifestHash,
        recoveryCode,
      );
      const { challenge, bundle, signingPrivateKey: recoveryPrivateKey } = authority;
      gateKey = authority.gateKey;

      newVaultMasterKey = randomBytes(SYNC_LIMITS.vaultMasterKeyBytes);
      const occurredAt = challenge.issuedAt;
      const newManifest = await signVaultManifest(
        unsignedVaultManifestSchema.parse({
          ...unsignedManifest(current),
          manifestVersion: current.manifestVersion + 1,
          keyEpoch: current.keyEpoch + 1,
          devices: current.devices
            .filter((device) => device.deviceId !== revokedDeviceId)
            .sort(compareDeviceId),
          revokedDevices: [
            ...current.revokedDevices,
            {
              deviceId: revoked.deviceId,
              publicKeys: revoked.publicKeys,
              revokedAt: occurredAt,
              revocationAuthority: 'device',
              revokedByDeviceId: setup.device.deviceId,
              lastAuthorizedManifestVersion: current.manifestVersion,
            },
          ].sort(compareDeviceId),
          previousManifestHash,
          transition: {
            transitionId: createOpaqueId(),
            kind: 'revoke-device',
            authorizationKind: 'device',
            authorizingDeviceId: setup.device.deviceId,
            affectedDeviceId: revokedDeviceId,
            occurredAt,
          },
        }),
        setup.device.signingPrivateKey,
      );
      await validateManifestTransition(current, newManifest);
      const newManifestHash = await manifestBodyHash(newManifest);
      const newRecoveryEnvelope = await createEncryptedRecoveryBundleEnvelope(
        {
          ...bundle,
          keyEpoch: newManifest.keyEpoch,
          vaultMasterKey: bytesToBase64Url(newVaultMasterKey),
          recoverySigningPrivateKeyPkcs8: bundle.recoverySigningPrivateKeyPkcs8,
          pinnedManifest: newManifest,
          pinnedManifestHash: newManifestHash,
        },
        authority.wrappingKey,
        {
          protocolVersion: SYNC_PROTOCOL_VERSION,
          suite: SYNC_CRYPTO_SUITE,
          vaultId: current.vaultId,
          keyEpoch: newManifest.keyEpoch,
          objectType: 'recovery-vault-key',
          objectId: createOpaqueId(),
          creatingDeviceId: setup.device.deviceId,
          recoveryLookupId: current.recoveryLookupId,
          parentManifestHash: newManifestHash,
        },
      );
      const newRecovery = recoveryRecordSchema.parse({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        vaultId: current.vaultId,
        recoveryLookupId: current.recoveryLookupId,
        keyEpoch: newManifest.keyEpoch,
        recoveryEnvelope: newRecoveryEnvelope,
        recoverySigningPublicKey: bundle.recoverySigningPublicKey,
        recoveryGateKeyHash: await hashRecoveryGateKey(gateKey),
        manifestVersion: newManifest.manifestVersion,
        manifestHash: newManifestHash,
        updatedAt: occurredAt,
      });
      const deviceKeyEnvelopes = await this.#createDeviceKeyEnvelopes(
        setup,
        newManifest,
        newManifestHash,
        newVaultMasterKey,
      );
      const transcript = {
        type: 'mirna-secure-device-revocation-v1' as const,
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        purpose: 'secure-device-revocation' as const,
        vaultId: current.vaultId,
        authorizingDeviceId: setup.device.deviceId,
        revokedDeviceId,
        recoveryChallenge: challenge,
        previousManifestVersion: current.manifestVersion,
        previousManifestHash,
        newManifestHash,
        newRecoveryHash: await hashDomainSeparatedCanonical(
          SYNC_DOMAIN_LABELS.recoveryRecord,
          newRecovery,
        ),
        deviceEnvelopeSetHash: await hashDomainSeparatedCanonical(
          SYNC_DOMAIN_LABELS.deviceEnvelopeSet,
          deviceKeyEnvelopes,
        ),
        idempotencyKey: newManifest.transition.transitionId,
        origin: this.#origin,
        method: 'POST' as const,
        path: `/v1/devices/${revokedDeviceId}/revoke`,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
      };
      const request = secureDeviceRevocationRequestSchema.parse({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        transcript,
        gateKey: bytesToBase64Url(gateKey),
        gateProof: await createRecoveryProof(transcript, gateKey),
        deviceSignature: await signDomainSeparatedCanonical(
          SYNC_DOMAIN_LABELS.secureRevocation,
          transcript,
          setup.device.signingPrivateKey,
        ),
        recoverySignature: await signDomainSeparatedCanonical(
          SYNC_DOMAIN_LABELS.secureRevocation,
          transcript,
          recoveryPrivateKey,
        ),
        newManifest,
        newRecovery,
        deviceKeyEnvelopes,
      });
      const response = secureDeviceRevocationResponseSchema.parse(
        await this.#api.secureRevokeDevice(revokedDeviceId, request),
      );
      if (
        response.vaultId !== current.vaultId ||
        response.revokedDeviceId !== revokedDeviceId ||
        response.manifestVersion !== newManifest.manifestVersion ||
        response.keyEpoch !== newManifest.keyEpoch
      ) {
        throw new DeviceSecurityError(
          'server-ack-mismatch',
          'Server nije potvrdio tačnu rotaciju ključa.',
        );
      }
      const next = await nextSetup({
        current: setup,
        manifest: newManifest,
        manifestHash: newManifestHash,
        vaultMasterKey: newVaultMasterKey,
        now: this.#now().toISOString(),
        pendingRotationSnapshot: true,
      });
      return await this.#repository.writeRotated(next);
    } finally {
      if (gateKey) clearBytes(gateKey);
      if (newVaultMasterKey) clearBytes(newVaultMasterKey);
      this.#api.clearSession();
    }
  }

  async #deleteCloudVault(recoveryCode: string, typedConfirmation: string): Promise<void> {
    if (typedConfirmation !== CLOUD_VAULT_DELETE_CONFIRMATION) {
      throw new DeviceSecurityError(
        'typed-confirmation-mismatch',
        'Uneta potvrda za cloud brisanje nije tačna.',
      );
    }
    const setup = await this.#setup();
    await this.#authenticate(setup);
    let gateKey: Uint8Array | undefined;
    try {
      const current = vaultManifestSchema.parse(await this.#api.getCurrentManifest());
      const currentManifestHash = await assertExactCurrentManifest(setup, current);
      const authority = await this.#openRecoveryAuthority(
        setup,
        current,
        currentManifestHash,
        recoveryCode,
      );
      gateKey = authority.gateKey;
      const transcript = {
        type: 'mirna-vault-deletion-v1' as const,
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        purpose: 'delete-encrypted-cloud-vault' as const,
        vaultId: current.vaultId,
        authorizingDeviceId: setup.device.deviceId,
        recoveryChallenge: authority.challenge,
        manifestVersion: current.manifestVersion,
        manifestHash: currentManifestHash,
        idempotencyKey: createOpaqueId(),
        typedConfirmation: 'DELETE ENCRYPTED CLOUD VAULT' as const,
        origin: this.#origin,
        method: 'DELETE' as const,
        path: '/v1/vault' as const,
        issuedAt: authority.challenge.issuedAt,
        expiresAt: authority.challenge.expiresAt,
      };
      const request = vaultDeletionRequestSchema.parse({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        transcript,
        gateKey: bytesToBase64Url(gateKey),
        gateProof: await createRecoveryProof(transcript, gateKey),
        deviceSignature: await signDomainSeparatedCanonical(
          SYNC_DOMAIN_LABELS.vaultDeletion,
          transcript,
          setup.device.signingPrivateKey,
        ),
        recoverySignature: await signDomainSeparatedCanonical(
          SYNC_DOMAIN_LABELS.vaultDeletion,
          transcript,
          authority.signingPrivateKey,
        ),
      });
      let response: Parsed<typeof vaultDeletionResponseSchema> | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        response = vaultDeletionResponseSchema.parse(await this.#api.deleteVault(request));
        if (response.deleted) break;
      }
      if (
        !response ||
        !response.deleted ||
        response.state !== 'completed' ||
        response.vaultId !== current.vaultId ||
        response.deletionRequestId !== transcript.idempotencyKey
      ) {
        throw new DeviceSecurityError(
          'deletion-pending',
          'Cloud brisanje je prihvaćeno i server će ga nastaviti bezbednim retry tokom.',
        );
      }
    } finally {
      if (gateKey) clearBytes(gateKey);
      this.#api.clearSession();
    }
  }

  async #createDeviceKeyEnvelopes(
    setup: LocalSyncSetup,
    manifest: VaultManifestV1,
    manifestHash: string,
    vaultMasterKey: Uint8Array,
  ): Promise<DeviceKeyEnvelopeV1[]> {
    const envelopes = await Promise.all(
      manifest.devices.map(async (recipient) => {
        const salt = randomBytes(SYNC_LIMITS.pairingSaltBytes);
        try {
          const context = deviceEnvelopeContext({
            protocolVersion: SYNC_PROTOCOL_VERSION,
            suite: SYNC_CRYPTO_SUITE,
            vaultId: manifest.vaultId,
            keyEpoch: manifest.keyEpoch,
            senderDeviceId: setup.device.deviceId,
            recipientDeviceId: recipient.deviceId,
            parentManifestHash: manifestHash,
          });
          const wrappingKey = await deriveDeviceEnvelopeWrappingKey(
            setup.device.agreementPrivateKey,
            await importAgreementPublicKey(recipient.publicKeys.agreement),
            salt,
            context,
          );
          return deviceKeyEnvelopeSchema.parse({
            ...context,
            ecdhSalt: bytesToBase64Url(salt),
            encryptedKey: await createEncryptedKeyEnvelope(vaultMasterKey, wrappingKey, {
              protocolVersion: SYNC_PROTOCOL_VERSION,
              suite: SYNC_CRYPTO_SUITE,
              vaultId: manifest.vaultId,
              keyEpoch: manifest.keyEpoch,
              objectType: 'device-key-envelope',
              objectId: createOpaqueId(),
              creatingDeviceId: setup.device.deviceId,
              recoveryLookupId: null,
              parentManifestHash: manifestHash,
            }),
          });
        } finally {
          clearBytes(salt);
        }
      }),
    );
    return envelopes.sort((left, right) =>
      left.recipientDeviceId < right.recipientDeviceId
        ? -1
        : left.recipientDeviceId > right.recipientDeviceId
          ? 1
          : 0,
    );
  }

  async #collectRecoveryBundle(
    challenge: Parsed<typeof recoveryChallengeSchema>,
    gateKey: Uint8Array,
  ): Promise<{
    readonly recoveryEnvelope: Parsed<typeof recoveryBundleFetchResponseSchema>['recoveryEnvelope'];
    readonly manifestChain: VaultManifestV1[];
  }> {
    let afterManifestVersion: number | null = null;
    let canonicalEnvelope: string | undefined;
    let recoveryEnvelope:
      Parsed<typeof recoveryBundleFetchResponseSchema>['recoveryEnvelope'] | undefined;
    const manifestChain: VaultManifestV1[] = [];
    for (let page = 0; page < MAX_RECOVERY_MANIFEST_PAGES; page += 1) {
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
        gateProof: await createRecoveryProof(transcript, gateKey),
      });
      const response = recoveryBundleFetchResponseSchema.parse(
        await this.#api.fetchRecoveryBundle(request),
      );
      const responseEnvelope = canonicalizeJson(response.recoveryEnvelope);
      if (canonicalEnvelope !== undefined && responseEnvelope !== canonicalEnvelope) {
        throw new DeviceSecurityError(
          'recovery-chain-invalid',
          'Server je promenio recovery omot tokom čitanja lanca.',
        );
      }
      canonicalEnvelope = responseEnvelope;
      recoveryEnvelope = response.recoveryEnvelope;
      const prior = manifestChain.at(-1)?.manifestVersion;
      if (
        (prior !== undefined && response.manifestChain[0]?.manifestVersion !== prior + 1) ||
        response.manifestChain.some(
          (manifest, index) =>
            index > 0 &&
            manifest.manifestVersion !== response.manifestChain[index - 1].manifestVersion + 1,
        )
      ) {
        throw new DeviceSecurityError(
          'recovery-chain-invalid',
          'Recovery manifest lanac nije neprekidan.',
        );
      }
      manifestChain.push(...response.manifestChain);
      if (response.nextAfterManifestVersion === null) break;
      if (
        response.nextAfterManifestVersion !== manifestChain.at(-1)?.manifestVersion ||
        response.nextAfterManifestVersion === afterManifestVersion ||
        page === MAX_RECOVERY_MANIFEST_PAGES - 1
      ) {
        throw new DeviceSecurityError(
          'recovery-chain-invalid',
          'Recovery manifest kursor nije validan.',
        );
      }
      afterManifestVersion = response.nextAfterManifestVersion;
    }
    if (!recoveryEnvelope || manifestChain.length === 0) {
      throw new DeviceSecurityError(
        'recovery-chain-invalid',
        'Server nije vratio kompletan recovery paket.',
      );
    }
    return { recoveryEnvelope, manifestChain };
  }

  async #validateRecoveryChain(
    bundle: RecoveryBundleV1,
    manifests: readonly VaultManifestV1[],
    current: VaultManifestV1,
    currentHash: string,
  ): Promise<void> {
    const first = manifests[0];
    if (
      !first ||
      !same(first, bundle.pinnedManifest) ||
      (await manifestBodyHash(first)) !== bundle.pinnedManifestHash
    ) {
      throw new DeviceSecurityError(
        'recovery-chain-invalid',
        'Recovery lanac ne počinje zakačenim manifestom.',
      );
    }
    if (first.manifestVersion === 1) await verifyInitialManifest(first);
    for (let index = 1; index < manifests.length; index += 1) {
      await validateManifestTransition(manifests[index - 1], manifests[index]);
    }
    const last = manifests.at(-1);
    if (!last || !same(last, current) || (await manifestBodyHash(last)) !== currentHash) {
      throw new DeviceSecurityError(
        'recovery-chain-invalid',
        'Recovery lanac ne završava trenutnim manifestom.',
      );
    }
  }
}
