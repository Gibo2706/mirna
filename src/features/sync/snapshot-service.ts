import { z } from 'zod';
import {
  createEncryptedKeyEnvelope,
  createOpaqueId,
  importSigningPublicKey,
  openEncryptedKeyEnvelope,
  randomBytes,
  signDomainSeparatedCanonical,
} from '@/domain/sync/crypto';
import { bytesToBase64Url, clearBytes } from '@/domain/sync/encoding';
import { manifestBodyHash, verifyStandaloneManifestWithPin } from '@/domain/sync/manifest';
import {
  authChallengeSchema,
  vaultManifestSchema,
  type AuthChallengeV1,
  type VaultManifestV1,
} from '@/domain/sync/schemas';
import {
  computeSyncFinanceDataHash,
  createEncryptedSnapshot,
  hashEncryptedSnapshotEnvelope,
  openEncryptedSnapshot,
  prepareFinanceDataForSnapshotApply,
  type EncryptedSnapshotArtifactV1,
  type SyncSnapshotV1,
} from '@/domain/sync/snapshot';
import {
  SYNC_CRYPTO_SUITE,
  SYNC_DOMAIN_LABELS,
  SYNC_PROTOCOL_VERSION,
} from '@/domain/sync/constants';
import type { LocalSyncSetup, SyncMetadataRecord } from '@/db/sync/records';
import {
  SyncSnapshotRepository,
  type SnapshotMetadataChanges,
} from '@/db/sync/snapshot-repository';
import { SyncApiError, type DownloadedSnapshotV1, type MirnaSyncApi } from './api';
import { collectVerifiedManifestChain, resolveSnapshotParentManifest } from './manifest-chain';

const snapshotCommitSchema = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  snapshotId: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  revision: z.number().int().positive(),
  snapshotHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  committed: z.literal(true),
});

export type SnapshotSyncResult =
  | { readonly kind: 'awaiting-upload-consent'; readonly revision: 0 }
  | { readonly kind: 'consent-declined'; readonly revision: number }
  | { readonly kind: 'uploaded'; readonly revision: number }
  | { readonly kind: 'downloaded'; readonly revision: number }
  | { readonly kind: 'up-to-date'; readonly revision: number }
  | {
      readonly kind: 'blocked';
      readonly revision: number;
      readonly reason: NonNullable<SyncMetadataRecord['syncBlockReason']>;
    };

export interface SnapshotSyncOptions {
  readonly allowInitialUpload?: boolean;
  readonly continuousOperations?: boolean;
  readonly forceCompaction?: boolean;
  readonly signal?: AbortSignal;
}

export interface SnapshotSyncApiPort {
  readonly hasActiveSession?: boolean;
  requestAuthChallenge(input: {
    protocolVersion: typeof SYNC_PROTOCOL_VERSION;
    suite: typeof SYNC_CRYPTO_SUITE;
    vaultId: string;
    deviceId: string;
    audience: '/v1/auth/session';
    origin: string;
  }): Promise<unknown>;
  createSession(input: {
    protocolVersion: typeof SYNC_PROTOCOL_VERSION;
    challenge: AuthChallengeV1;
    signature: string;
  }): Promise<unknown>;
  getCurrentManifest(): Promise<unknown>;
  getManifestChanges(afterManifestVersion: number): Promise<unknown>;
  uploadSnapshot(
    artifact: EncryptedSnapshotArtifactV1,
    idempotencyKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  downloadCurrentSnapshot(options?: { signal?: AbortSignal }): Promise<DownloadedSnapshotV1>;
  clearSession(): void;
}

export class SnapshotSyncError extends Error {
  constructor(
    readonly code:
      | 'not-enabled'
      | 'invalid-origin'
      | 'challenge-mismatch'
      | 'manifest-fork'
      | 'manifest-gap'
      | 'device-revoked'
      | 'key-epoch-changed'
      | 'snapshot-invalid'
      | 'upload-consent-required'
      | 'sync-blocked',
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotSyncError';
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
      throw new Error('invalid origin');
    }
    return value;
  } catch {
    throw new SnapshotSyncError('invalid-origin', 'Sinhronizacija zahteva tačan HTTPS origin.');
  }
};

const metadataChanges = (
  metadata: SyncMetadataRecord,
  overrides: Partial<SnapshotMetadataChanges>,
): SnapshotMetadataChanges => ({
  bootstrapMode: metadata.bootstrapMode,
  firstUploadConsent: metadata.firstUploadConsent,
  lastServerCursor: metadata.lastServerCursor,
  lastSnapshotServerCursor: metadata.lastSnapshotServerCursor,
  lastSnapshotRevision: metadata.lastSnapshotRevision,
  lastSnapshotId: metadata.lastSnapshotId,
  lastSnapshotHash: metadata.lastSnapshotHash,
  lastSnapshotContentHash: metadata.lastSnapshotContentHash,
  lastLocalDataHash: metadata.lastLocalDataHash,
  pendingKeyRotationSnapshotEpoch: metadata.pendingKeyRotationSnapshotEpoch,
  ...overrides,
});

const isSnapshotNotFound = (error: unknown): boolean =>
  error instanceof SyncApiError && error.status === 404 && error.code === 'SNAPSHOT_NOT_FOUND';

const manifestSigningKey = async (manifest: VaultManifestV1, deviceId: string) => {
  const device = manifest.devices.find((candidate) => candidate.deviceId === deviceId);
  if (!device) throw new SnapshotSyncError('snapshot-invalid', 'Autor snimka nije u manifestu.');
  return importSigningPublicKey(device.publicKeys.signing);
};

export const canRevalidateSnapshotManifest = (metadata: SyncMetadataRecord): boolean =>
  metadata.syncBlockReason === 'fork-detected' &&
  metadata.lastErrorCode === 'SNAPSHOT_MANIFEST_PIN_MISMATCH';

class SnapshotProofError extends Error {
  constructor(
    readonly reason: NonNullable<SyncMetadataRecord['syncBlockReason']>,
    readonly code: string,
  ) {
    super(code);
  }
}

export class SnapshotSyncService {
  readonly #api: SnapshotSyncApiPort;
  readonly #repository: SyncSnapshotRepository;
  readonly #origin: string;
  readonly #now: () => Date;
  #queue: Promise<void> = Promise.resolve();

  constructor(input: {
    api: SnapshotSyncApiPort | MirnaSyncApi;
    origin: string;
    repository?: SyncSnapshotRepository;
    now?: () => Date;
  }) {
    this.#api = input.api;
    this.#repository = input.repository ?? new SyncSnapshotRepository();
    this.#origin = exactOrigin(input.origin);
    this.#now = input.now ?? (() => new Date());
  }

  synchronize(options: SnapshotSyncOptions = {}): Promise<SnapshotSyncResult> {
    const operation = this.#queue.then(() => this.#synchronizeOnce(options));
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #synchronizeOnce(options: SnapshotSyncOptions): Promise<SnapshotSyncResult> {
    let setup = await this.#repository.readSetup();
    if (!setup) {
      throw new SnapshotSyncError('not-enabled', 'Sinhronizacija nije uključena na ovom uređaju.');
    }
    const pairedBootstrapPending =
      setup.metadata.bootstrapMode === 'paired-download' &&
      setup.metadata.lastSnapshotRevision === 0 &&
      setup.metadata.lastSnapshotHash === null &&
      setup.metadata.lastSnapshotId !== null;

    if (pairedBootstrapPending && setup.metadata.syncBlockReason === 'local-remote-conflict') {
      setup = await this.#repository.preparePairedDeviceBootstrap(setup, this.#now().toISOString());
    }
    const revalidating = canRevalidateSnapshotManifest(setup.metadata);
    if (setup.metadata.syncBlockReason && !revalidating) {
      return {
        kind: 'blocked',
        revision: setup.metadata.lastSnapshotRevision,
        reason: setup.metadata.syncBlockReason,
      };
    }

    let revalidationRemote: DownloadedSnapshotV1 | undefined;
    let revalidatedSnapshot: SyncSnapshotV1 | undefined;
    try {
      await this.#authenticate(setup);
      const remoteManifest = vaultManifestSchema.parse(await this.#api.getCurrentManifest());
      if (revalidating) {
        revalidationRemote = await this.#api.downloadCurrentSnapshot({ signal: options.signal });
      }
      setup = await this.#reconcileManifest(
        setup,
        remoteManifest,
        revalidating
          ? async (candidate) => {
              const key = await openEncryptedKeyEnvelope(
                candidate.vaultKey.encryptedKey,
                candidate.device.localWrappingKey,
              );
              try {
                revalidatedSnapshot = await this.#verifySnapshot(
                  candidate,
                  key,
                  revalidationRemote!,
                  true,
                );
                const data = await this.#repository.readFinanceDataForRemoteBootstrap();
                if (!data)
                  throw new SnapshotProofError('integrity-failure', 'LOCAL_FINANCE_STATE_MISSING');
              } finally {
                clearBytes(key);
              }
            }
          : undefined,
      );
      if (revalidating) {
        setup = await this.#repository.clearRevalidatedManifestBlock(setup);
        if (
          options.continuousOperations &&
          revalidationRemote!.envelope.revision > setup.metadata.lastSnapshotRevision
        ) {
          // Operation catch-up must precede acceptance of a newer compaction frontier.
          clearBytes(revalidationRemote!.ciphertext);
          return { kind: 'up-to-date', revision: setup.metadata.lastSnapshotRevision };
        }
      }
    } catch (error) {
      if (!revalidating) throw error;
      if (revalidationRemote) clearBytes(revalidationRemote.ciphertext);
      return {
        kind: 'blocked',
        revision: setup.metadata.lastSnapshotRevision,
        reason: 'fork-detected',
      };
    }
    const vaultMasterKey = await openEncryptedKeyEnvelope(
      setup.vaultKey.encryptedKey,
      setup.device.localWrappingKey,
    );
    try {
      let remote: DownloadedSnapshotV1 | undefined = revalidationRemote;
      try {
        remote ??= await this.#api.downloadCurrentSnapshot({ signal: options.signal });
      } catch (error) {
        if (!isSnapshotNotFound(error)) throw error;
      }

      if (!remote) {
        if (setup.metadata.bootstrapMode === 'paired-download') {
          throw new SnapshotSyncError(
            'snapshot-invalid',
            'Povezani uređaj još nema dostupan početni snapshot. Pokrenite prvi upload na postojećem uređaju.',
          );
        }
        if (setup.metadata.lastSnapshotRevision > 0) {
          return this.#block(setup, 'rollback-detected', 'REMOTE_SNAPSHOT_MISSING');
        }
        if (
          setup.metadata.firstUploadConsent === 'pending' &&
          options.allowInitialUpload !== true
        ) {
          return { kind: 'awaiting-upload-consent', revision: 0 };
        }
        if (setup.metadata.firstUploadConsent === 'declined') {
          return { kind: 'consent-declined', revision: 0 };
        }
        return await this.#upload(setup, vaultMasterKey, options, true);
      }
      return await this.#acceptOrAdvance(
        setup,
        vaultMasterKey,
        remote,
        options,
        revalidatedSnapshot,
      );
    } finally {
      clearBytes(vaultMasterKey);
      if (revalidationRemote) clearBytes(revalidationRemote.ciphertext);
    }
  }

  async #authenticate(setup: LocalSyncSetup): Promise<void> {
    if (this.#api.hasActiveSession === true) return;
    const challenge = authChallengeSchema.parse(
      await this.#api.requestAuthChallenge({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        vaultId: setup.vault.vaultId,
        deviceId: setup.device.deviceId,
        audience: '/v1/auth/session',
        origin: this.#origin,
      }),
    );
    const now = this.#now().getTime();
    if (
      challenge.vaultId !== setup.vault.vaultId ||
      challenge.deviceId !== setup.device.deviceId ||
      challenge.audience !== '/v1/auth/session' ||
      challenge.origin !== this.#origin ||
      challenge.method !== 'POST' ||
      Date.parse(challenge.issuedAt) > now + 2 * 60 * 1_000 ||
      Date.parse(challenge.expiresAt) <= now
    ) {
      throw new SnapshotSyncError(
        'challenge-mismatch',
        'Server je vratio challenge koji ne pripada ovom sync zahtevu.',
      );
    }
    await this.#api.createSession({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      challenge,
      signature: await signDomainSeparatedCanonical(
        SYNC_DOMAIN_LABELS.authChallenge,
        challenge,
        setup.device.signingPrivateKey,
      ),
    });
  }

  async #reconcileManifest(
    setup: LocalSyncSetup,
    remoteManifest: VaultManifestV1,
    beforeAdvance?: (candidate: LocalSyncSetup) => Promise<void>,
  ): Promise<LocalSyncSetup> {
    const localHash = await manifestBodyHash(setup.vault.manifest);
    const remoteHash = await manifestBodyHash(remoteManifest);
    if (localHash !== setup.metadata.lastManifestHash) {
      throw new SnapshotSyncError('manifest-fork', 'Lokalni manifest pin nije usaglašen.');
    }
    if (remoteManifest.manifestVersion === setup.vault.manifest.manifestVersion) {
      if (remoteHash !== localHash) {
        throw new SnapshotSyncError('manifest-fork', 'Otkriven je fork iste verzije manifesta.');
      }
      await verifyStandaloneManifestWithPin(remoteManifest, {
        manifestVersion: remoteManifest.manifestVersion,
        manifestHash: remoteHash,
      });
      await beforeAdvance?.(setup);
      return setup;
    }
    if (remoteManifest.manifestVersion < setup.vault.manifest.manifestVersion) {
      throw new SnapshotSyncError('manifest-gap', 'Nedostaje tranzicija manifesta.');
    }
    const chain = await collectVerifiedManifestChain({
      getManifestChanges: (after) => this.#api.getManifestChanges(after),
      previous: setup.vault.manifest,
      expected: remoteManifest,
      expectedHash: remoteHash,
    });
    // Validate the full chain and snapshot proof before any durable pin advancement.
    const steps: LocalSyncSetup[] = [];
    let candidate = setup;
    for (const manifest of chain) {
      candidate = await this.#prepareManifestAdvance(candidate, manifest);
      steps.push(candidate);
    }
    await beforeAdvance?.(candidate);
    for (const next of steps) setup = await this.#repository.advanceSetup(setup, next);
    return setup;
  }

  async #prepareManifestAdvance(
    setup: LocalSyncSetup,
    remoteManifest: VaultManifestV1,
  ): Promise<LocalSyncSetup> {
    const remoteHash = await manifestBodyHash(remoteManifest);
    const localDevice = remoteManifest.devices.find(
      (device) => device.deviceId === setup.device.deviceId,
    );
    if (!localDevice) {
      throw new SnapshotSyncError('device-revoked', 'Ovaj uređaj više nije aktivan u manifestu.');
    }
    if (remoteManifest.keyEpoch !== setup.vault.keyEpoch) {
      throw new SnapshotSyncError(
        'key-epoch-changed',
        'Nova epoha ključa zahteva eksplicitnu rotaciju ključa na ovom uređaju.',
      );
    }
    const vaultMasterKey = await openEncryptedKeyEnvelope(
      setup.vaultKey.encryptedKey,
      setup.device.localWrappingKey,
    );
    try {
      const encryptedKey = await createEncryptedKeyEnvelope(
        vaultMasterKey,
        setup.device.localWrappingKey,
        {
          ...setup.vaultKey.encryptedKey.aad,
          objectId: createOpaqueId(),
          parentManifestHash: remoteHash,
        },
      );
      const next: LocalSyncSetup = {
        ...setup,
        vault: {
          ...setup.vault,
          manifest: remoteManifest,
          updatedAt: this.#now().toISOString(),
        },
        device: {
          ...setup.device,
          authorizationExpiresAt: localDevice.authorizationExpiresAt,
          updatedAt: this.#now().toISOString(),
        },
        vaultKey: { ...setup.vaultKey, encryptedKey },
        metadata: { ...setup.metadata, lastManifestHash: remoteHash },
      };
      return next;
    } finally {
      clearBytes(vaultMasterKey);
    }
  }

  async #verifySnapshot(
    setup: LocalSyncSetup,
    vaultMasterKey: Uint8Array,
    remote: DownloadedSnapshotV1,
    requireFullHistory = false,
  ) {
    const { envelope } = remote;
    const remoteHash = await hashEncryptedSnapshotEnvelope(envelope);
    if (envelope.vaultId !== setup.vault.vaultId) {
      throw new SnapshotProofError('fork-detected', 'SNAPSHOT_VAULT_MISMATCH');
    }
    if (envelope.revision < setup.metadata.lastSnapshotRevision) {
      throw new SnapshotProofError('rollback-detected', 'SNAPSHOT_ROLLBACK_DETECTED');
    }
    const sameRevision = envelope.revision === setup.metadata.lastSnapshotRevision;
    if (sameRevision && remoteHash !== setup.metadata.lastSnapshotHash) {
      throw new SnapshotProofError('fork-detected', 'SNAPSHOT_FORK_DETECTED');
    }
    const pairingPin =
      setup.metadata.lastSnapshotRevision === 0 &&
      setup.metadata.lastSnapshotHash === null &&
      setup.metadata.lastSnapshotId === envelope.snapshotId;
    if (
      !sameRevision &&
      !pairingPin &&
      (envelope.baseRevision !== setup.metadata.lastSnapshotRevision ||
        envelope.previousSnapshotHash !== setup.metadata.lastSnapshotHash)
    ) {
      throw new SnapshotProofError('fork-detected', 'SNAPSHOT_CHAIN_GAP');
    }
    let parent = setup.vault.manifest;
    if (requireFullHistory || envelope.parentManifestHash !== setup.metadata.lastManifestHash) {
      try {
        parent = await resolveSnapshotParentManifest({
          getManifestChanges: (after) => this.#api.getManifestChanges(after),
          trusted: setup.vault.manifest,
          trustedHash: setup.metadata.lastManifestHash,
          parentHash: envelope.parentManifestHash,
        });
      } catch {
        throw new SnapshotProofError('fork-detected', 'SNAPSHOT_MANIFEST_PIN_MISMATCH');
      }
    }
    try {
      if (parent.keyEpoch !== envelope.keyEpoch) throw new Error('Snapshot parent epoch mismatch.');
      return await openEncryptedSnapshot({
        envelope,
        ciphertext: remote.ciphertext,
        vaultMasterKey,
        signingPublicKey: await manifestSigningKey(parent, envelope.creatingDeviceId),
        expected: {
          vaultId: setup.vault.vaultId,
          keyEpoch: setup.vault.keyEpoch,
          currentRevision:
            sameRevision || pairingPin
              ? envelope.baseRevision
              : setup.metadata.lastSnapshotRevision,
          currentSnapshotHash:
            sameRevision || pairingPin
              ? envelope.previousSnapshotHash
              : setup.metadata.lastSnapshotHash,
          parentManifestHash: envelope.parentManifestHash,
          creatingDeviceId: envelope.creatingDeviceId,
        },
      });
    } catch {
      throw new SnapshotProofError('integrity-failure', 'SNAPSHOT_INTEGRITY_FAILURE');
    }
  }

  async #acceptOrAdvance(
    setup: LocalSyncSetup,
    vaultMasterKey: Uint8Array,
    remote: DownloadedSnapshotV1,
    options: SnapshotSyncOptions,
    revalidatedSnapshot?: SyncSnapshotV1,
  ): Promise<SnapshotSyncResult> {
    const { envelope } = remote;
    let verifiedSnapshot = revalidatedSnapshot;
    if (
      envelope.revision !== setup.metadata.lastSnapshotRevision ||
      canRevalidateSnapshotManifest(setup.metadata)
    ) {
      try {
        verifiedSnapshot ??= await this.#verifySnapshot(setup, vaultMasterKey, remote);
      } catch (error) {
        if (error instanceof SnapshotProofError)
          return this.#block(setup, error.reason, error.code);
        throw error;
      } finally {
        clearBytes(remote.ciphertext);
      }
    }
    const remoteHash = await hashEncryptedSnapshotEnvelope(envelope);
    if (envelope.vaultId !== setup.vault.vaultId) {
      return this.#block(setup, 'fork-detected', 'SNAPSHOT_VAULT_MISMATCH');
    }
    if (envelope.revision < setup.metadata.lastSnapshotRevision) {
      return this.#block(setup, 'rollback-detected', 'SNAPSHOT_ROLLBACK_DETECTED');
    }
    if (envelope.revision === setup.metadata.lastSnapshotRevision) {
      if (remoteHash !== setup.metadata.lastSnapshotHash) {
        return this.#block(setup, 'fork-detected', 'SNAPSHOT_FORK_DETECTED');
      }
      const data = await this.#repository.readFinanceData();
      const localDataHash = await computeSyncFinanceDataHash(data);
      if (options.forceCompaction) {
        if (setup.metadata.firstUploadConsent !== 'accepted') {
          throw new SnapshotSyncError(
            'upload-consent-required',
            'Prvi upload zahteva eksplicitnu saglasnost.',
          );
        }
        return this.#upload(setup, vaultMasterKey, options, false);
      }
      if (
        setup.metadata.lastLocalDataHash !== null &&
        localDataHash !== setup.metadata.lastLocalDataHash
      ) {
        if (options.continuousOperations && !options.forceCompaction) {
          const syncedAt = this.#now().toISOString();
          await this.#repository.updateMetadata(
            setup.vault.vaultId,
            setup.metadata.lastSnapshotRevision,
            setup.metadata.lastManifestHash,
            metadataChanges(setup.metadata, {
              lastSyncAt: syncedAt,
              lastErrorCode: undefined,
            }),
            setup.metadata,
          );
          return { kind: 'up-to-date', revision: envelope.revision };
        }
        if (setup.metadata.firstUploadConsent !== 'accepted') {
          throw new SnapshotSyncError(
            'upload-consent-required',
            'Prvi upload zahteva eksplicitnu saglasnost.',
          );
        }
        return this.#upload(setup, vaultMasterKey, options, false);
      }
      const syncedAt = this.#now().toISOString();
      await this.#repository.updateMetadata(
        setup.vault.vaultId,
        setup.metadata.lastSnapshotRevision,
        setup.metadata.lastManifestHash,
        metadataChanges(setup.metadata, {
          lastSyncAt: syncedAt,
          ...(options.continuousOperations ? {} : { lastSuccessfulSyncAt: syncedAt }),
          lastErrorCode: undefined,
          syncBlockReason: undefined,
        }),
        setup.metadata,
      );
      return { kind: 'up-to-date', revision: envelope.revision };
    }

    const bootstrapFromPairingPin =
      setup.metadata.lastSnapshotRevision === 0 &&
      setup.metadata.lastSnapshotHash === null &&
      setup.metadata.lastSnapshotId === envelope.snapshotId;
    if (
      !bootstrapFromPairingPin &&
      (envelope.baseRevision !== setup.metadata.lastSnapshotRevision ||
        envelope.previousSnapshotHash !== setup.metadata.lastSnapshotHash)
    ) {
      return this.#block(setup, 'fork-detected', 'SNAPSHOT_CHAIN_GAP');
    }
    const localData = await this.#repository.readFinanceDataForRemoteBootstrap();
    if (!localData && !bootstrapFromPairingPin) {
      return this.#block(setup, 'integrity-failure', 'LOCAL_FINANCE_STATE_MISSING');
    }
    const localDataHash = localData ? await computeSyncFinanceDataHash(localData) : null;
    if (!localDataHash && setup.metadata.lastLocalDataHash !== null) {
      return this.#block(setup, 'integrity-failure', 'LOCAL_FINANCE_STATE_MISSING');
    }
    const localIsDirty =
      setup.metadata.lastLocalDataHash !== null &&
      localDataHash !== setup.metadata.lastLocalDataHash;
    if (localIsDirty && !options.continuousOperations) {
      if (!localDataHash) {
        return this.#block(setup, 'integrity-failure', 'LOCAL_FINANCE_STATE_MISSING');
      }
      await this.#repository.recordSnapshotConflict({
        setup,
        remoteSnapshotId: envelope.snapshotId,
        remoteRevision: envelope.revision,
        remoteHash,
        localDataHash,
        detectedAt: this.#now().toISOString(),
      });
      return {
        kind: 'blocked',
        revision: setup.metadata.lastSnapshotRevision,
        reason: 'local-remote-conflict',
      };
    }

    const snapshot = verifiedSnapshot!;
    const localSettings = localData?.settings[0];
    const ready = await prepareFinanceDataForSnapshotApply(snapshot, {
      appearance: localSettings?.appearance ?? 'system',
      installHintDismissed: localSettings?.installHintDismissed ?? false,
      lastBackupAt: localSettings?.lastBackupAt,
    });
    const acceptedDataHash = await computeSyncFinanceDataHash(ready);
    const syncedAt = this.#now().toISOString();
    if (bootstrapFromPairingPin && setup.metadata.bootstrapMode === 'paired-download') {
      await this.#repository.applyRemoteSnapshot(
        setup,
        ready,
        metadataChanges(setup.metadata, {
          bootstrapMode: 'complete',
          firstUploadConsent: 'accepted',
          lastServerCursor: snapshot.causalFrontier.serverCursor,
          lastSnapshotServerCursor: snapshot.causalFrontier.serverCursor,
          lastSnapshotRevision: envelope.revision,
          lastSnapshotId: envelope.snapshotId,
          lastSnapshotHash: remoteHash,
          lastSnapshotContentHash: snapshot.contentIntegrityHash,
          lastLocalDataHash: acceptedDataHash,
          pendingKeyRotationSnapshotEpoch: undefined,
          lastSyncAt: syncedAt,
          ...(options.continuousOperations ? {} : { lastSuccessfulSyncAt: syncedAt }),
          lastErrorCode: undefined,
          syncBlockReason: undefined,
        }),
        snapshot.entityStates,
      );

      return {
        kind: 'downloaded',
        revision: envelope.revision,
      };
    }
    if (options.continuousOperations && localData) {
      const accepted = await this.#repository.acceptCompactionSnapshot(
        setup,
        metadataChanges(setup.metadata, {
          firstUploadConsent: 'accepted',
          lastServerCursor: Math.max(
            setup.metadata.lastServerCursor,
            snapshot.causalFrontier.serverCursor,
          ),
          lastSnapshotServerCursor: snapshot.causalFrontier.serverCursor,
          lastSnapshotRevision: envelope.revision,
          lastSnapshotId: envelope.snapshotId,
          lastSnapshotHash: remoteHash,
          lastSnapshotContentHash: snapshot.contentIntegrityHash,
          lastLocalDataHash: localDataHash,
          pendingKeyRotationSnapshotEpoch: undefined,
          lastSyncAt: syncedAt,
          ...(options.continuousOperations ? {} : { lastSuccessfulSyncAt: syncedAt }),
          lastErrorCode: undefined,
          syncBlockReason: undefined,
        }),
        snapshot.causalFrontier,
        snapshot.entityStates,
      );
      if (accepted) return { kind: 'downloaded', revision: envelope.revision };
      if (localDataHash) {
        await this.#repository.recordSnapshotConflict({
          setup,
          remoteSnapshotId: envelope.snapshotId,
          remoteRevision: envelope.revision,
          remoteHash,
          localDataHash,
          detectedAt: syncedAt,
        });
      }
      return {
        kind: 'blocked',
        revision: setup.metadata.lastSnapshotRevision,
        reason: 'local-remote-conflict',
      };
    }
    if (localData) await this.#repository.writeSafetyCheckpoint(setup, localData, syncedAt);
    await this.#repository.applyRemoteSnapshot(
      setup,
      ready,
      metadataChanges(setup.metadata, {
        firstUploadConsent: 'accepted',
        lastServerCursor: snapshot.causalFrontier.serverCursor,
        lastSnapshotServerCursor: snapshot.causalFrontier.serverCursor,
        lastSnapshotRevision: envelope.revision,
        lastSnapshotId: envelope.snapshotId,
        lastSnapshotHash: remoteHash,
        lastSnapshotContentHash: snapshot.contentIntegrityHash,
        lastLocalDataHash: acceptedDataHash,
        pendingKeyRotationSnapshotEpoch: undefined,
        lastSyncAt: syncedAt,
        ...(options.continuousOperations ? {} : { lastSuccessfulSyncAt: syncedAt }),
        lastErrorCode: undefined,
        syncBlockReason: undefined,
      }),
      snapshot.entityStates,
    );
    return { kind: 'downloaded', revision: envelope.revision };
  }

  async #upload(
    setup: LocalSyncSetup,
    vaultMasterKey: Uint8Array,
    options: SnapshotSyncOptions,
    initialUpload: boolean,
  ): Promise<SnapshotSyncResult> {
    if (
      initialUpload &&
      setup.metadata.firstUploadConsent !== 'accepted' &&
      options.allowInitialUpload !== true
    ) {
      throw new SnapshotSyncError(
        'upload-consent-required',
        'Prvi upload zahteva eksplicitnu saglasnost.',
      );
    }
    const [data, causalFrontier] = await Promise.all([
      this.#repository.readFinanceData(),
      this.#repository.readCausalFrontier(setup.vault.vaultId),
    ]);
    const entityStates = await this.#repository.readEntityStatesForSnapshot(
      setup.vault.vaultId,
      data,
    );
    const dataHash = await computeSyncFinanceDataHash(data);
    const createdAt = this.#now().toISOString();
    const artifact = await createEncryptedSnapshot({
      data,
      entityStates,
      vaultId: setup.vault.vaultId,
      revision: setup.metadata.lastSnapshotRevision + 1,
      baseRevision: setup.metadata.lastSnapshotRevision,
      keyEpoch: setup.vault.keyEpoch,
      creatingDeviceId: setup.device.deviceId,
      createdAt,
      parentManifestHash: setup.metadata.lastManifestHash,
      previousSnapshotHash: setup.metadata.lastSnapshotHash,
      causalFrontier,
      vaultMasterKey,
      signingPrivateKey: setup.device.signingPrivateKey,
      compression: 'gzip',
    });
    const snapshotHash = await hashEncryptedSnapshotEnvelope(artifact.envelope);
    try {
      const committed = snapshotCommitSchema.parse(
        await this.#api.uploadSnapshot(artifact, bytesToBase64Url(randomBytes(32)), {
          signal: options.signal,
        }),
      );
      if (
        committed.snapshotId !== artifact.envelope.snapshotId ||
        committed.revision !== artifact.envelope.revision ||
        committed.snapshotHash !== snapshotHash
      ) {
        throw new SnapshotSyncError(
          'snapshot-invalid',
          'Server nije potvrdio tačno poslati snimak.',
        );
      }
      const syncedAt = this.#now().toISOString();
      await this.#repository.commitLocalSnapshot(
        setup,
        metadataChanges(setup.metadata, {
          bootstrapMode: 'complete',
          firstUploadConsent: 'accepted',
          lastServerCursor: causalFrontier.serverCursor,
          lastSnapshotServerCursor: causalFrontier.serverCursor,
          lastSnapshotRevision: artifact.envelope.revision,
          lastSnapshotId: artifact.envelope.snapshotId,
          lastSnapshotHash: snapshotHash,
          lastSnapshotContentHash: artifact.snapshotContentHash,
          lastLocalDataHash: dataHash,
          pendingKeyRotationSnapshotEpoch: undefined,
          lastSyncAt: syncedAt,
          ...(options.continuousOperations ? {} : { lastSuccessfulSyncAt: syncedAt }),
          lastErrorCode: undefined,
          syncBlockReason: undefined,
        }),
        entityStates,
      );
      return { kind: 'uploaded', revision: artifact.envelope.revision };
    } catch (error) {
      if (
        !initialUpload &&
        error instanceof SyncApiError &&
        error.status === 409 &&
        error.code === 'SNAPSHOT_ACK_PENDING'
      ) {
        const syncedAt = this.#now().toISOString();
        await this.#repository.updateMetadata(
          setup.vault.vaultId,
          setup.metadata.lastSnapshotRevision,
          setup.metadata.lastManifestHash,
          metadataChanges(setup.metadata, {
            lastSyncAt: syncedAt,
            ...(options.continuousOperations ? {} : { lastSuccessfulSyncAt: syncedAt }),
            lastErrorCode: undefined,
          }),
          setup.metadata,
        );
        return { kind: 'up-to-date', revision: setup.metadata.lastSnapshotRevision };
      }
      throw error;
    } finally {
      clearBytes(artifact.ciphertext);
    }
  }

  async #block(
    setup: LocalSyncSetup,
    reason: NonNullable<SyncMetadataRecord['syncBlockReason']>,
    errorCode: string,
  ): Promise<SnapshotSyncResult> {
    if (canRevalidateSnapshotManifest(setup.metadata)) {
      return {
        kind: 'blocked',
        revision: setup.metadata.lastSnapshotRevision,
        reason: 'fork-detected',
      };
    }
    await this.#repository.updateMetadata(
      setup.vault.vaultId,
      setup.metadata.lastSnapshotRevision,
      setup.metadata.lastManifestHash,
      metadataChanges(setup.metadata, {
        lastSyncAt: this.#now().toISOString(),
        lastErrorCode: errorCode,
        syncBlockReason: reason,
      }),
      setup.metadata,
    );
    return { kind: 'blocked', revision: setup.metadata.lastSnapshotRevision, reason };
  }
}
