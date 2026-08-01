import {
  SYNC_CRYPTO_SUITE,
  SYNC_LIMITS,
  SYNC_PROTOCOL_VERSION,
  SYNC_DOMAIN_LABELS,
} from '@/domain/sync/constants';
import {
  hashSyncOperation,
  openEncryptedOperation,
  parseOperationEnvelope,
  type AcceptedOperationEnvelopeV1,
  type OperationChangesResponseV1,
  type OperationEnvelopeV1,
} from '@/domain/sync/operation';
import { authChallengeSchema, type AuthChallengeV1 } from '@/domain/sync/schemas';
import {
  importSigningPublicKey,
  openEncryptedKeyEnvelope,
  signDomainSeparatedCanonical,
} from '@/domain/sync/crypto';
import { clearBytes } from '@/domain/sync/encoding';
import { computeSnapshotFrontierHash } from '@/domain/sync/snapshot';
import {
  SyncOperationRepository,
  type OpenedRemoteOperation,
} from '@/db/sync/operation-repository';
import { SyncSnapshotRepository } from '@/db/sync/snapshot-repository';
import type { LocalSyncSetup, SyncInboxRecord } from '@/db/sync/records';
import type { MirnaSyncApi } from './api';

const MAX_PULL_PAGES_PER_RUN = 100;

export interface OperationSyncApiPort {
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
  uploadOperation(envelope: OperationEnvelopeV1): Promise<{
    operationId: string;
    serverCursor: number;
    accepted: true;
  }>;
  getChanges(after: number, limit?: number): Promise<OperationChangesResponseV1>;
  acknowledgeChanges(input: {
    protocolVersion: typeof SYNC_PROTOCOL_VERSION;
    acknowledgedServerCursor: number;
    causalFrontierHash: string;
    acknowledgedSnapshotId: string | null;
    acknowledgedSnapshotRevision: number;
  }): Promise<unknown>;
  clearSession(): void;
}

export interface OperationSyncResult {
  readonly uploaded: number;
  readonly downloaded: number;
  readonly appliedGroups: number;
  readonly conflictedGroups: number;
  readonly pendingLocalOperations: number;
  readonly acknowledgedServerCursor: number;
}

export interface OperationSyncOptions {
  readonly acknowledge?: boolean;
}

const exactOrigin = (value: string): string => {
  const parsed = new URL(value);
  if (
    parsed.origin !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && parsed.hostname === 'localhost'))
  ) {
    throw new Error('Sinhronizacija zahteva tačan HTTPS origin.');
  }
  return value;
};

const unsignedEnvelope = (accepted: AcceptedOperationEnvelopeV1): OperationEnvelopeV1 => {
  const { serverCursor, ...envelope } = accepted;
  void serverCursor;
  return parseOperationEnvelope(envelope);
};

export class OperationSyncService {
  readonly #api: OperationSyncApiPort;
  readonly #repository: SyncOperationRepository;
  readonly #snapshotRepository: SyncSnapshotRepository;
  readonly #origin: string;
  readonly #now: () => Date;
  #queue: Promise<void> = Promise.resolve();

  constructor(input: {
    api: OperationSyncApiPort | MirnaSyncApi;
    origin: string;
    repository?: SyncOperationRepository;
    snapshotRepository?: SyncSnapshotRepository;
    now?: () => Date;
  }) {
    this.#api = input.api;
    this.#repository = input.repository ?? new SyncOperationRepository();
    this.#snapshotRepository = input.snapshotRepository ?? new SyncSnapshotRepository();
    this.#origin = exactOrigin(input.origin);
    this.#now = input.now ?? (() => new Date());
  }

  synchronize(options: OperationSyncOptions = {}): Promise<OperationSyncResult> {
    const operation = this.#queue.then(() => this.#synchronizeOnce(options));
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  acknowledge(): Promise<number> {
    const operation = this.#queue.then(async () => {
      const setup = await this.#repository.readSetup();
      if (!setup) throw new Error('Sinhronizacija nije uključena na ovom uređaju.');
      await this.#authenticate(setup);
      try {
        return await this.#acknowledgeCurrent(setup);
      } finally {
        this.#api.clearSession();
      }
    });
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #synchronizeOnce(options: OperationSyncOptions): Promise<OperationSyncResult> {
    const setup = await this.#repository.readSetup();
    if (!setup) throw new Error('Sinhronizacija nije uključena na ovom uređaju.');
    await this.#authenticate(setup);
    const vaultMasterKey = await openEncryptedKeyEnvelope(
      setup.vaultKey.encryptedKey,
      setup.device.localWrappingKey,
    );
    let uploaded = 0;
    let downloaded = 0;
    let appliedGroups = 0;
    let conflictedGroups = 0;
    try {
      while (true) {
        const group = await this.#repository.prepareNextGroup(setup, vaultMasterKey);
        if (group.length === 0) break;
        for (const [index, record] of group.entries()) {
          const envelope = this.#repository.envelopes([record])[0];
          try {
            const accepted = await this.#api.uploadOperation(envelope);
            if (accepted.operationId !== record.operationId || !accepted.accepted) {
              throw new Error('Server potvrda operacije se ne poklapa.');
            }
            const operation = await openEncryptedOperation({
              envelope,
              vaultMasterKey,
              signingPublicKey: setup.device.signingPublicKey,
              expected: {
                vaultId: setup.vault.vaultId,
                keyEpoch: setup.vault.keyEpoch,
                deviceId: setup.device.deviceId,
              },
            });
            await this.#repository.recordAcceptedLocal(
              setup,
              record,
              accepted.serverCursor,
              await hashSyncOperation(operation),
            );
            uploaded += 1;
          } catch (error) {
            await Promise.all(
              group
                .slice(index)
                .map((pending) => this.#repository.markUploadFailed(pending.operationId)),
            );
            throw error;
          }
        }
      }

      let cursor = (await this.#repository.readMetadata())?.lastServerCursor ?? 0;
      for (let pageNumber = 0; pageNumber < MAX_PULL_PAGES_PER_RUN; pageNumber += 1) {
        const page = await this.#api.getChanges(cursor, SYNC_LIMITS.maxOperationsPerBatch);
        if (page.nextCursor < cursor) throw new Error('Server cursor pokušava rollback.');
        const opened = await Promise.all(
          page.changes.map((accepted) =>
            this.#openRemoteOperation(setup, vaultMasterKey, accepted),
          ),
        );
        await this.#repository.stageRemoteOperations(setup, opened, page.nextCursor);
        downloaded += opened.length;
        cursor = page.nextCursor;
        if (!page.hasMore) break;
        if (pageNumber === MAX_PULL_PAGES_PER_RUN - 1) {
          throw new Error('Previše sync stranica u jednom pokušaju.');
        }
      }

      while (true) {
        const groups = await this.#repository.receivedGroups(setup.vault.vaultId);
        if (groups.length === 0) break;
        let progressed = false;
        for (const records of groups) {
          const opened = await Promise.all(
            records.map((record) => this.#openInboxOperation(setup, vaultMasterKey, record)),
          );
          const result = await this.#repository.applyRemoteGroup(setup, opened);
          if (result === 'applied') appliedGroups += 1;
          else conflictedGroups += 1;
          progressed = true;
        }
        if (!progressed) break;
      }

      const acknowledgedServerCursor = await this.#repository.advanceAcknowledgedCursor(setup);
      if (options.acknowledge !== false) {
        await this.#acknowledgeCurrent(setup, acknowledgedServerCursor);
      }
      const pendingLocalOperations = await this.#repository.pendingLocalOperationCount(
        setup.vault.vaultId,
      );
      return {
        uploaded,
        downloaded,
        appliedGroups,
        conflictedGroups,
        pendingLocalOperations,
        acknowledgedServerCursor,
      };
    } finally {
      clearBytes(vaultMasterKey);
      this.#api.clearSession();
    }
  }

  async #acknowledgeCurrent(setup: LocalSyncSetup, acknowledgedCursor?: number): Promise<number> {
    const acknowledgedServerCursor =
      acknowledgedCursor ?? (await this.#repository.advanceAcknowledgedCursor(setup));
    const frontier = await this.#snapshotRepository.readCausalFrontier(setup.vault.vaultId);
    const metadata = await this.#repository.readMetadata();
    if (!metadata || metadata.vaultId !== setup.vault.vaultId) {
      throw new Error('Sync metadata nedostaje.');
    }
    await this.#api.acknowledgeChanges({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      acknowledgedServerCursor,
      causalFrontierHash: await computeSnapshotFrontierHash(frontier),
      acknowledgedSnapshotId: metadata.lastSnapshotId,
      acknowledgedSnapshotRevision: metadata.lastSnapshotRevision,
    });
    return acknowledgedServerCursor;
  }

  async #authenticate(setup: LocalSyncSetup): Promise<void> {
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
      challenge.origin !== this.#origin ||
      challenge.audience !== '/v1/auth/session' ||
      challenge.method !== 'POST' ||
      Date.parse(challenge.issuedAt) > now + 2 * 60 * 1_000 ||
      Date.parse(challenge.expiresAt) <= now
    ) {
      throw new Error('Server challenge ne pripada ovom sync zahtevu.');
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

  async #openRemoteOperation(
    setup: LocalSyncSetup,
    vaultMasterKey: Uint8Array,
    acceptedEnvelope: AcceptedOperationEnvelopeV1,
  ): Promise<OpenedRemoteOperation> {
    const envelope = unsignedEnvelope(acceptedEnvelope);
    const manifestDevice =
      setup.vault.manifest.devices.find((device) => device.deviceId === envelope.deviceId) ??
      setup.vault.manifest.revokedDevices.find((device) => device.deviceId === envelope.deviceId);
    if (!manifestDevice) throw new Error('Autor operacije nije u potpisanom manifestu.');
    const operation = await openEncryptedOperation({
      envelope,
      vaultMasterKey,
      signingPublicKey: await importSigningPublicKey(manifestDevice.publicKeys.signing),
      expected: {
        vaultId: setup.vault.vaultId,
        keyEpoch: setup.vault.keyEpoch,
        deviceId: envelope.deviceId,
      },
    });
    return { acceptedEnvelope, operation, operationHash: await hashSyncOperation(operation) };
  }

  #openInboxOperation(
    setup: LocalSyncSetup,
    vaultMasterKey: Uint8Array,
    record: SyncInboxRecord,
  ): Promise<OpenedRemoteOperation> {
    const envelope = parseOperationEnvelope(JSON.parse(record.encryptedEnvelope) as unknown);
    return this.#openRemoteOperation(setup, vaultMasterKey, {
      ...envelope,
      serverCursor: record.serverCursor,
    });
  }
}
