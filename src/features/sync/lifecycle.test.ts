/** Synthetic protocol fixtures only. No production or user key material. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { canonicalizeJson } from '@/domain/sync/canonical';
import {
  SYNC_CRYPTO_SUITE,
  SYNC_DOMAIN_LABELS,
  SYNC_LIMITS,
  SYNC_PROTOCOL_VERSION,
} from '@/domain/sync/constants';
import {
  createOpaqueId,
  deriveRecoveryKeys,
  hashPairingClaimToken,
  hashRecoveryGateKey,
  openEncryptedRecoveryBundleEnvelope,
  parsePairingCode,
  parseRecoveryCode,
  verifyDomainSeparatedCanonicalSignature,
} from '@/domain/sync/crypto';
import { base64UrlToBytes, bytesToBase64Url, clearBytes } from '@/domain/sync/encoding';
import { manifestBodyHash, validateManifestTransition } from '@/domain/sync/manifest';
import {
  authChallengeSchema,
  pairingCandidateSchema,
  pairingPollResponseSchema,
  recoveryBundleFetchResponseSchema,
  recoveryChallengeSchema,
  type AuthChallengeV1,
  type RecoveryRecordV1,
  type VaultManifestV1,
} from '@/domain/sync/schemas';
import type { LocalSyncSetup } from '@/db/sync/records';
import type { PendingPairingFinalization } from '@/db/sync/pairing-finalization-checkpoint';
import type { MirnaSyncApi } from './api';
import {
  EnableSyncLifecycle,
  ExistingDevicePairingLifecycle,
  NewDevicePairingLifecycle,
  RecoverDeviceLifecycle,
  SyncLifecycleError,
  type PairingApprovalRequestV1,
  type PairingCreateRequestV1,
  type PairingFinalizeRequestV1,
  type PairingFinalizationCheckpointPort,
  type RecoveryBundleFetchRequestV1,
  type RecoveryChallengeRequestV1,
  type RecoveryCompleteRequestV1,
  type RecoveryConfirmationValue,
  type SyncLifecycleRepositoryPort,
  type SyncPhase1ApiPort,
  type VaultCreateRequestV1,
} from './lifecycle';

const ORIGIN = 'https://mirna.example.test';
const NOW = new Date('2026-07-31T10:00:00.000Z');
const now = (): Date => new Date(NOW);
const encodedSecret = (fill: number): string => bytesToBase64Url(new Uint8Array(32).fill(fill));
const id = (fill: number): string => bytesToBase64Url(new Uint8Array(16).fill(fill));

const confirmationValues = (
  recoveryCode: string,
  groupNumbers: readonly number[],
): RecoveryConfirmationValue[] => {
  const groups = recoveryCode.slice('MR1-'.length).split('-');
  return groupNumbers.map((groupNumber) => ({
    groupNumber,
    value: groups[groupNumber - 1],
  }));
};

class MemoryRepository implements SyncLifecycleRepositoryPort {
  setup: LocalSyncSetup | undefined;
  writes = 0;
  failNextWrite = false;

  read(): Promise<LocalSyncSetup | undefined> {
    return Promise.resolve(this.setup);
  }

  write(setup: LocalSyncSetup): Promise<void> {
    this.writes += 1;
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return Promise.reject(new Error('Synthetic local write failure.'));
    }
    this.setup = setup;
    return Promise.resolve();
  }
}

class MemoryPairingCheckpoint implements PairingFinalizationCheckpointPort {
  pending: PendingPairingFinalization | undefined;

  constructor(private readonly repository: MemoryRepository) {}

  stage(
    setup: LocalSyncSetup,
    request: PairingFinalizeRequestV1,
  ): Promise<PendingPairingFinalization> {
    this.pending ??= {
      record: {
        id: 'sync-pairing-finalization',
        version: 1,
        requestId: request.transcript.pairingRequestId,
        vaultId: request.transcript.vaultId,
        deviceId: request.transcript.newDeviceId,
        manifestVersion: setup.vault.manifest.manifestVersion,
        manifestHash: request.transcript.candidateManifestHash,
        nonce: 'A'.repeat(16),
        ciphertext: 'B'.repeat(22),
        setup,
        createdAt: NOW.toISOString(),
      },
      request,
    };
    return Promise.resolve(this.pending);
  }

  read(): Promise<PendingPairingFinalization | undefined> {
    return Promise.resolve(this.pending);
  }

  async complete(pending: PendingPairingFinalization): Promise<LocalSyncSetup> {
    if (pending !== this.pending) throw new Error('Synthetic checkpoint mismatch.');
    await this.repository.write(pending.record.setup);
    this.pending = undefined;
    return pending.record.setup;
  }
}

const checkpointByRepository = new WeakMap<MemoryRepository, MemoryPairingCheckpoint>();
const checkpointsFor = (repository: MemoryRepository): MemoryPairingCheckpoint => {
  const existing = checkpointByRepository.get(repository);
  if (existing) return existing;
  const created = new MemoryPairingCheckpoint(repository);
  checkpointByRepository.set(repository, created);
  return created;
};

interface StoredPairing {
  readonly request: PairingCreateRequestV1;
  readonly expiresAt: string;
  status: 'pending' | 'approved' | 'cancelled' | 'finalized';
  approval?: PairingApprovalRequestV1;
  finalization?: PairingFinalizeRequestV1;
}

class MemoryPhase1Api implements SyncPhase1ApiPort {
  vaultRequest: VaultCreateRequestV1 | undefined;
  vaultRequestBodies: string[] = [];
  currentManifest: VaultManifestV1 | undefined;
  recovery: RecoveryRecordV1 | undefined;
  readonly manifests: VaultManifestV1[] = [];
  readonly pairings = new Map<string, StoredPairing>();
  readonly challenges: AuthChallengeV1[] = [];
  createVaultCalls = 0;
  tamperPairingEnvelope = false;
  tamperRecoveryChain = false;
  failPairingCancellation = false;
  clearedSessions = 0;
  recoveryCompletionBody: string | undefined;
  recoveryCompletionCalls = 0;
  failFinalizeResponseOnce = false;
  finalizePairingCalls = 0;

  async createVault(request: VaultCreateRequestV1): Promise<unknown> {
    this.createVaultCalls += 1;
    this.vaultRequestBodies.push(canonicalizeJson(request));
    if (this.vaultRequest && canonicalizeJson(this.vaultRequest) !== canonicalizeJson(request)) {
      throw new Error('Vault retry was not exact.');
    }
    this.vaultRequest = request;
    this.currentManifest = request.manifest;
    this.recovery = request.recovery;
    this.manifests.splice(0, this.manifests.length, request.manifest);
    return {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      vaultId: request.manifest.vaultId,
      manifestVersion: request.manifest.manifestVersion,
      manifestHash: await manifestBodyHash(request.manifest),
      created: this.createVaultCalls === 1,
    };
  }

  createPairing(request: PairingCreateRequestV1): Promise<unknown> {
    const expiresAt = new Date(NOW.getTime() + SYNC_LIMITS.pairingLifetimeMs).toISOString();
    const existing = this.pairings.get(request.requestId);
    if (existing && canonicalizeJson(existing.request) !== canonicalizeJson(request)) {
      throw new Error('Pairing retry was not exact.');
    }
    this.pairings.set(request.requestId, existing ?? { request, expiresAt, status: 'pending' });
    return Promise.resolve({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      requestId: request.requestId,
      expiresAt,
    });
  }

  async inspectPairing(
    pairingRequestId: string,
    request: Parameters<SyncPhase1ApiPort['inspectPairing']>[1],
  ): Promise<unknown> {
    const pairing = this.requirePairing(pairingRequestId);
    expect(await hashPairingClaimToken(base64UrlToBytes(request.claimToken))).toBe(
      pairing.request.pairingClaimTokenHash,
    );
    return pairingCandidateSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      requestId: pairingRequestId,
      deviceId: pairing.request.deviceId,
      publicKeys: pairing.request.publicKeys,
      pairingSalt: pairing.request.pairingSalt,
      expiresAt: pairing.expiresAt,
    });
  }

  pollPairing(
    pairingRequestId: string,
    request: Parameters<SyncPhase1ApiPort['pollPairing']>[1],
  ): Promise<unknown> {
    void request;
    const pairing = this.requirePairing(pairingRequestId);
    if (pairing.status !== 'approved' || !pairing.approval) {
      return Promise.resolve(
        pairingPollResponseSchema.parse({
          protocolVersion: SYNC_PROTOCOL_VERSION,
          status: pairing.status === 'finalized' ? 'consumed' : pairing.status,
          expiresAt: pairing.expiresAt,
        }),
      );
    }
    const envelope = this.tamperPairingEnvelope
      ? {
          ...pairing.approval.envelope,
          ciphertext: `${pairing.approval.envelope.ciphertext.slice(0, -1)}${
            pairing.approval.envelope.ciphertext.endsWith('A') ? 'B' : 'A'
          }`,
        }
      : pairing.approval.envelope;
    return Promise.resolve(
      pairingPollResponseSchema.parse({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        status: 'approved',
        expiresAt: pairing.expiresAt,
        envelope,
        candidateManifest: pairing.approval.candidateManifest,
      }),
    );
  }

  cancelPairing(
    pairingRequestId: string,
    request: Parameters<SyncPhase1ApiPort['cancelPairing']>[1],
  ): Promise<unknown> {
    void request;
    if (this.failPairingCancellation) {
      return Promise.reject(new Error('Synthetic cancellation failure.'));
    }
    this.requirePairing(pairingRequestId).status = 'cancelled';
    return Promise.resolve({ protocolVersion: SYNC_PROTOCOL_VERSION, status: 'cancelled' });
  }

  requestAuthChallenge(
    request: Parameters<SyncPhase1ApiPort['requestAuthChallenge']>[0],
  ): Promise<unknown> {
    const challenge = authChallengeSchema.parse({
      type: 'mirna-auth-challenge-v1',
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: request.vaultId,
      deviceId: request.deviceId,
      challengeId: createOpaqueId(),
      challenge: encodedSecret(this.challenges.length + 20),
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + SYNC_LIMITS.challengeLifetimeMs).toISOString(),
      audience: request.audience,
      origin: request.origin,
      method: 'POST',
    });
    this.challenges.push(challenge);
    return Promise.resolve(challenge);
  }

  async createSession(
    request: Parameters<SyncPhase1ApiPort['createSession']>[0],
  ): Promise<unknown> {
    const device = this.currentManifest?.devices.find(
      (candidate) => candidate.deviceId === request.challenge.deviceId,
    );
    if (!device) throw new Error('Unauthorized synthetic device.');
    const rawPublicKey = new Uint8Array(base64UrlToBytes(device.publicKeys.signing.value));
    const publicKey = await crypto.subtle.importKey(
      'raw',
      rawPublicKey.buffer,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
    expect(
      await verifyDomainSeparatedCanonicalSignature(
        SYNC_DOMAIN_LABELS.authChallenge,
        request.challenge,
        request.signature,
        publicKey,
      ),
    ).toBe(true);
    return {
      expiresAt: new Date(NOW.getTime() + SYNC_LIMITS.accessSessionLifetimeMs).toISOString(),
      authorizationExpiresAt: device.authorizationExpiresAt,
    };
  }

  clearSession(): void {
    this.clearedSessions += 1;
  }

  getCurrentManifest(): Promise<unknown> {
    if (!this.currentManifest) return Promise.reject(new Error('Vault is missing.'));
    return Promise.resolve(this.currentManifest);
  }

  approvePairing(pairingRequestId: string, request: PairingApprovalRequestV1): Promise<unknown> {
    const pairing = this.requirePairing(pairingRequestId);
    pairing.approval = request;
    pairing.status = 'approved';
    return Promise.resolve({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      status: 'approved',
      expiresAt: pairing.expiresAt,
    });
  }

  finalizePairing(pairingRequestId: string, request: PairingFinalizeRequestV1): Promise<unknown> {
    this.finalizePairingCalls += 1;
    const pairing = this.requirePairing(pairingRequestId);
    if (
      pairing.finalization &&
      canonicalizeJson(pairing.finalization) !== canonicalizeJson(request)
    ) {
      return Promise.reject(new Error('Finalization retry was not exact.'));
    }
    if (!pairing.approval) return Promise.reject(new Error('Pairing was not approved.'));
    pairing.finalization = request;
    pairing.status = 'finalized';
    this.currentManifest = pairing.approval.candidateManifest;
    if (
      !this.manifests.some((item) => item.manifestVersion === this.currentManifest?.manifestVersion)
    ) {
      this.manifests.push(this.currentManifest);
    }
    if (this.failFinalizeResponseOnce) {
      this.failFinalizeResponseOnce = false;
      return Promise.reject(new Error('Synthetic response loss after finalize commit.'));
    }
    return Promise.resolve({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      vaultId: request.transcript.vaultId,
      deviceId: request.transcript.newDeviceId,
      manifestVersion: pairing.approval.candidateManifest.manifestVersion,
      finalized: true,
    });
  }

  async requestRecoveryChallenge(request: RecoveryChallengeRequestV1): Promise<unknown> {
    if (!this.recovery || !this.currentManifest) throw new Error('Recovery record is missing.');
    if (request.recoveryLookupId !== this.recovery.recoveryLookupId) {
      throw new Error('Unknown recovery lookup ID.');
    }
    return recoveryChallengeSchema.parse({
      type: 'mirna-recovery-challenge-v1',
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      recoveryLookupId: request.recoveryLookupId,
      vaultId: this.currentManifest.vaultId,
      challengeId: id(90),
      challenge: encodedSecret(91),
      newDeviceId: request.newDeviceId,
      newDevicePublicKeys: request.newDevicePublicKeys,
      previousManifestVersion: this.currentManifest.manifestVersion,
      previousManifestHash: await manifestBodyHash(this.currentManifest),
      origin: request.origin,
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + SYNC_LIMITS.challengeLifetimeMs).toISOString(),
    });
  }

  async fetchRecoveryBundle(request: RecoveryBundleFetchRequestV1): Promise<unknown> {
    if (!this.recovery || !this.currentManifest) throw new Error('Recovery record is missing.');
    expect(await hashRecoveryGateKey(base64UrlToBytes(request.gateKey))).toBe(
      this.recovery.recoveryGateKeyHash,
    );
    const after = request.transcript.afterManifestVersion;
    const startVersion = after === null ? this.recovery.manifestVersion : after + 1;
    const page = this.manifests.filter((manifest) => manifest.manifestVersion >= startVersion);
    const manifestChain = this.tamperRecoveryChain
      ? [{ ...page[0], keyEpoch: page[0].keyEpoch + 1 }]
      : page;
    return recoveryBundleFetchResponseSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      recoveryEnvelope: this.recovery.recoveryEnvelope,
      manifestChain,
      nextAfterManifestVersion: null,
    });
  }

  async completeRecovery(vaultId: string, request: RecoveryCompleteRequestV1): Promise<unknown> {
    this.recoveryCompletionCalls += 1;
    const requestBody = canonicalizeJson(request);
    if (this.recoveryCompletionBody !== undefined && this.recoveryCompletionBody !== requestBody) {
      throw new Error('Recovery retry was not exact.');
    }
    if (request.newManifest.vaultId !== vaultId || !this.currentManifest) {
      throw new Error('Recovery vault mismatch.');
    }
    if (this.recoveryCompletionBody === undefined) {
      await validateManifestTransition(this.currentManifest, request.newManifest);
      this.recoveryCompletionBody = requestBody;
      this.currentManifest = request.newManifest;
      this.recovery = request.newRecovery;
      this.manifests.push(request.newManifest);
    }
    return {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      vaultId,
      deviceId: request.transcript.newDeviceId,
      manifestVersion: request.newManifest.manifestVersion,
      recovered: true,
    };
  }

  private requirePairing(pairingRequestId: string): StoredPairing {
    const pairing = this.pairings.get(pairingRequestId);
    if (!pairing) throw new Error('Pairing is missing.');
    return pairing;
  }
}

const dependencies = (
  api: SyncPhase1Api,
  repository: MemoryRepository,
): ConstructorParameters<typeof EnableSyncLifecycle>[0] => ({
  api,
  repository,
  origin: ORIGIN,
  now,
  selectRecoveryConfirmationGroups: () => [1, 4, 7],
  pairingFinalizationCheckpoints: checkpointsFor(repository),
});

type SyncPhase1Api = MemoryPhase1Api;

const initializeVault = async (
  api: MemoryPhase1Api,
  repository: MemoryRepository,
): Promise<{ setup: LocalSyncSetup; recoveryCode: string }> => {
  const lifecycle = new EnableSyncLifecycle(dependencies(api, repository));
  const presentation = await lifecycle.begin('Telefon');
  await lifecycle.confirmRecoveryCode(
    confirmationValues(presentation.recoveryCode, presentation.confirmationGroupNumbers),
  );
  const setup = await lifecycle.activate();
  return { setup, recoveryCode: presentation.recoveryCode };
};

describe('Phase 1 sync lifecycle', () => {
  it('is structurally compatible with the session-owning transport', () => {
    expectTypeOf<MirnaSyncApi>().toMatchTypeOf<SyncPhase1ApiPort>();
  });

  it('gates genesis behind show-once recovery confirmation and retries the exact server ACK boundary', async () => {
    const api = new MemoryPhase1Api();
    const repository = new MemoryRepository();
    const lifecycle = new EnableSyncLifecycle(dependencies(api, repository));

    const presentation = await lifecycle.begin('  Moj   telefon  ');
    expect(lifecycle.state).toBe('awaiting-recovery-confirmation');
    expect(api.createVaultCalls).toBe(0);
    expect(repository.writes).toBe(0);
    await expect(
      lifecycle.confirmRecoveryCode(
        presentation.confirmationGroupNumbers.map((groupNumber) => ({
          groupNumber,
          value: 'XXXX',
        })),
      ),
    ).rejects.toMatchObject({ code: 'recovery-confirmation-mismatch' });
    expect(api.createVaultCalls).toBe(0);

    await lifecycle.confirmRecoveryCode(
      confirmationValues(presentation.recoveryCode, presentation.confirmationGroupNumbers),
    );
    repository.failNextWrite = true;
    await expect(lifecycle.activate()).rejects.toThrow('Synthetic local write failure');
    expect(lifecycle.state).toBe('registering');
    const setup = await lifecycle.activate();

    expect(api.createVaultCalls).toBe(2);
    expect(new Set(api.vaultRequestBodies).size).toBe(1);
    expect(setup.device.displayName).toBe('Moj telefon');
    expect(setup.metadata.firstUploadConsent).toBe('pending');
    expect(setup.device.signingPrivateKey.extractable).toBe(false);
    expect(setup.device.agreementPrivateKey.extractable).toBe(false);
    expect(setup.device.localWrappingKey.extractable).toBe(false);
    expect(api.vaultRequestBodies[0]).not.toContain(presentation.recoveryCode);
    const parsedCode = await parseRecoveryCode(presentation.recoveryCode);
    const recoveryKeys = await deriveRecoveryKeys(parsedCode.recoveryRoot, {
      vaultId: setup.vault.vaultId,
      recoveryLookupId: parsedCode.recoveryLookupId,
    });
    const recoveryBundle = await openEncryptedRecoveryBundleEnvelope(
      api.vaultRequest!.recovery.recoveryEnvelope,
      recoveryKeys.wrappingKey,
    );
    expect(api.vaultRequestBodies[0]).not.toContain(recoveryBundle.vaultMasterKey);
    expect(api.vaultRequestBodies[0]).not.toContain(recoveryBundle.recoverySigningPrivateKeyPkcs8);
    expect(canonicalizeJson(setup.vaultKey.encryptedKey)).not.toContain(
      recoveryBundle.vaultMasterKey,
    );
    clearBytes(parsedCode.recoveryRoot, recoveryKeys.gateKey);
  });

  it('completes QR pairing with equal keyed SAS, fresh challenges and atomic local install', async () => {
    const api = new MemoryPhase1Api();
    const existingRepository = new MemoryRepository();
    await initializeVault(api, existingRepository);
    const newRepository = new MemoryRepository();
    const newcomer = new NewDevicePairingLifecycle(dependencies(api, newRepository));
    const pairing = await newcomer.start('Laptop');
    const decodedPairing = await parsePairingCode(pairing.pairingCode);
    const createBody = canonicalizeJson([...api.pairings.values()][0].request);
    expect(createBody).not.toContain(bytesToBase64Url(decodedPairing.pairingSecret));
    clearBytes(decodedPairing.pairingSecret, decodedPairing.pairingSalt);
    const approver = new ExistingDevicePairingLifecycle(dependencies(api, existingRepository));

    const prepared = await approver.prepare(pairing.qrPayload);
    expect(api.challenges.map((challenge) => challenge.audience)).toEqual(['/v1/auth/session']);
    await approver.approve(prepared.sas);
    expect(api.challenges.map((challenge) => challenge.audience)).toEqual([
      '/v1/auth/session',
      '/v1/auth/session',
      '/v1/pairings/approve',
    ]);
    expect(api.clearedSessions).toBe(2);

    const polled = await newcomer.poll();
    expect(polled).toMatchObject({ status: 'sas-required', sas: prepared.sas });
    const setup = await newcomer.confirmSas(prepared.sas);

    expect(setup.vault.manifest.manifestVersion).toBe(2);
    expect(setup.vault.manifest.devices).toHaveLength(2);
    expect(setup.metadata.firstUploadConsent).toBe('pending');
    expect(newRepository.writes).toBe(1);
    expect(newcomer.state).toBe('active');
  });

  it.each([false, true])(
    'fails closed on a mismatched new-device SAS even when cancellation failure is %s',
    async (failCancellation) => {
      const api = new MemoryPhase1Api();
      const existingRepository = new MemoryRepository();
      await initializeVault(api, existingRepository);
      const newRepository = new MemoryRepository();
      const newcomer = new NewDevicePairingLifecycle(dependencies(api, newRepository));
      const pairing = await newcomer.start('Laptop');
      const approver = new ExistingDevicePairingLifecycle(dependencies(api, existingRepository));
      const prepared = await approver.prepare(pairing.pairingCode);
      await approver.approve(prepared.sas);
      expect((await newcomer.poll()).status).toBe('sas-required');
      api.failPairingCancellation = failCancellation;

      await expect(newcomer.confirmSas('0000-0000-0000-0000')).rejects.toMatchObject({
        code: 'sas-mismatch',
      });

      expect(newcomer.state).toBe('cancelled');
      expect(newRepository.writes).toBe(0);
      expect([...api.pairings.values()][0]?.status).toBe(
        failCancellation ? 'approved' : 'cancelled',
      );
      await expect(newcomer.confirmSas(prepared.sas)).rejects.toMatchObject({
        code: 'invalid-state',
      });
    },
  );

  it('retries the exact finalization before a local pairing install retry', async () => {
    const api = new MemoryPhase1Api();
    const existingRepository = new MemoryRepository();
    await initializeVault(api, existingRepository);
    const newRepository = new MemoryRepository();
    const newcomer = new NewDevicePairingLifecycle(dependencies(api, newRepository));
    const pairing = await newcomer.start('Laptop');
    const approver = new ExistingDevicePairingLifecycle(dependencies(api, existingRepository));
    const prepared = await approver.prepare(pairing.pairingCode);
    await approver.approve(prepared.sas);
    await newcomer.poll();
    newRepository.failNextWrite = true;

    await expect(newcomer.confirmSas(prepared.sas)).rejects.toThrow(
      'Synthetic local write failure',
    );
    expect(newcomer.state).toBe('finalizing');
    const setup = await newcomer.resumeFinalization();

    expect(newRepository.writes).toBe(2);
    expect(setup.vault.manifest.manifestVersion).toBe(2);
  });

  it('resumes the identical finalization after server commit, response loss and reload', async () => {
    const api = new MemoryPhase1Api();
    const existingRepository = new MemoryRepository();
    await initializeVault(api, existingRepository);
    const newRepository = new MemoryRepository();
    const newcomer = new NewDevicePairingLifecycle(dependencies(api, newRepository));
    const pairing = await newcomer.start('Laptop');
    const approver = new ExistingDevicePairingLifecycle(dependencies(api, existingRepository));
    const prepared = await approver.prepare(pairing.pairingCode);
    await approver.approve(prepared.sas);
    await newcomer.poll();
    api.failFinalizeResponseOnce = true;

    await expect(newcomer.confirmSas(prepared.sas)).rejects.toThrow(
      'Synthetic response loss after finalize commit',
    );
    expect(newcomer.state).toBe('finalizing');
    expect(newRepository.writes).toBe(0);

    const reloaded = new NewDevicePairingLifecycle(dependencies(api, newRepository));
    const setup = await reloaded.resumeFinalization();
    expect(api.finalizePairingCalls).toBe(2);
    expect(newRepository.writes).toBe(1);
    expect(setup.device.deviceId).toBe(prepared.candidate.deviceId);
    expect(reloaded.state).toBe('active');
  });

  it('clears the existing-device approval capability on an approver SAS mismatch', async () => {
    const api = new MemoryPhase1Api();
    const existingRepository = new MemoryRepository();
    await initializeVault(api, existingRepository);
    const newcomer = new NewDevicePairingLifecycle(dependencies(api, new MemoryRepository()));
    const pairing = await newcomer.start('Laptop');
    const approver = new ExistingDevicePairingLifecycle(dependencies(api, existingRepository));
    await approver.prepare(pairing.pairingCode);

    await expect(approver.approve('0000-0000-0000-0000')).rejects.toMatchObject({
      code: 'sas-mismatch',
    });
    expect(approver.state).toBe('rejected');
    expect([...api.pairings.values()][0]?.status).toBe('pending');
    await expect(approver.approve('0000-0000-0000-0000')).rejects.toMatchObject({
      code: 'invalid-state',
    });
  });

  it('supports the manual pairing code and rejects ciphertext tampering before local install', async () => {
    const api = new MemoryPhase1Api();
    const existingRepository = new MemoryRepository();
    await initializeVault(api, existingRepository);
    const newRepository = new MemoryRepository();
    const newcomer = new NewDevicePairingLifecycle(dependencies(api, newRepository));
    const pairing = await newcomer.start('Tablet');
    const approver = new ExistingDevicePairingLifecycle(dependencies(api, existingRepository));
    const prepared = await approver.prepare(pairing.pairingCode);
    await approver.approve(prepared.sas);
    api.tamperPairingEnvelope = true;

    await expect(newcomer.poll()).rejects.toBeInstanceOf(SyncLifecycleError);
    expect(newRepository.writes).toBe(0);
    expect(newcomer.state).toBe('cancelled');
    expect([...api.pairings.values()][0]?.status).toBe('cancelled');
  });

  it('cancels an unaccepted request with the independent polling token', async () => {
    const api = new MemoryPhase1Api();
    const repository = new MemoryRepository();
    const newcomer = new NewDevicePairingLifecycle(dependencies(api, repository));
    await newcomer.start('Tablet');

    await newcomer.cancel();

    expect(newcomer.state).toBe('cancelled');
    expect([...api.pairings.values()][0]?.status).toBe('cancelled');
    expect(repository.writes).toBe(0);
  });

  it('recovers through the pinned manifest chain, rotates epoch/recovery and installs a sole device', async () => {
    const api = new MemoryPhase1Api();
    const originalRepository = new MemoryRepository();
    const { recoveryCode } = await initializeVault(api, originalRepository);
    const recoveredRepository = new MemoryRepository();
    const recovery = new RecoverDeviceLifecycle(dependencies(api, recoveredRepository));

    const presentation = await recovery.begin(recoveryCode, 'Novi telefon');
    expect(recovery.state).toBe('awaiting-new-recovery-confirmation');
    await expect(
      recovery.confirmNewRecoveryCode(
        presentation.confirmationGroupNumbers.map((groupNumber) => ({
          groupNumber,
          value: 'XXXX',
        })),
      ),
    ).rejects.toMatchObject({ code: 'recovery-confirmation-mismatch' });
    const setup = await recovery.confirmNewRecoveryCode(
      confirmationValues(presentation.recoveryCode, presentation.confirmationGroupNumbers),
    );

    expect(setup.vault.keyEpoch).toBe(2);
    expect(setup.vault.manifest.devices).toHaveLength(1);
    expect(setup.vault.manifest.revokedDevices).toHaveLength(1);
    expect(setup.vault.manifest.transition.kind).toBe('recover-device');
    expect(setup.vault.manifest.recoveryLookupId).not.toBe(
      api.vaultRequest?.manifest.recoveryLookupId,
    );
    expect(setup.metadata.firstUploadConsent).toBe('pending');
    expect(recoveredRepository.writes).toBe(1);
  });

  it('retries the exact recovery completion before a local install retry', async () => {
    const api = new MemoryPhase1Api();
    const originalRepository = new MemoryRepository();
    const { recoveryCode } = await initializeVault(api, originalRepository);
    const recoveredRepository = new MemoryRepository();
    const recovery = new RecoverDeviceLifecycle(dependencies(api, recoveredRepository));
    const presentation = await recovery.begin(recoveryCode, 'Novi telefon');
    const confirmation = confirmationValues(
      presentation.recoveryCode,
      presentation.confirmationGroupNumbers,
    );
    recoveredRepository.failNextWrite = true;

    await expect(recovery.confirmNewRecoveryCode(confirmation)).rejects.toThrow(
      'Synthetic local write failure',
    );
    expect(recovery.state).toBe('recovering');
    const setup = await recovery.confirmNewRecoveryCode(confirmation);

    expect(api.recoveryCompletionCalls).toBe(2);
    expect(recoveredRepository.writes).toBe(2);
    expect(setup.vault.manifest.transition.kind).toBe('recover-device');
  });

  it('rejects a forked recovery chain before constructing or installing replacement state', async () => {
    const api = new MemoryPhase1Api();
    const originalRepository = new MemoryRepository();
    const { recoveryCode } = await initializeVault(api, originalRepository);
    const recoveredRepository = new MemoryRepository();
    api.tamperRecoveryChain = true;
    const recovery = new RecoverDeviceLifecycle(dependencies(api, recoveredRepository));

    await expect(recovery.begin(recoveryCode, 'Novi telefon')).rejects.toBeInstanceOf(
      SyncLifecycleError,
    );
    expect(recovery.state).toBe('failed');
    expect(recoveredRepository.writes).toBe(0);
  });

  it('never accepts an imprecise genesis acknowledgement', async () => {
    const api = new MemoryPhase1Api();
    api.createVault = (request) =>
      Promise.resolve({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        vaultId: request.manifest.vaultId,
        manifestVersion: request.manifest.manifestVersion,
        manifestHash: bytesToBase64Url(new Uint8Array(32).fill(255)),
        created: true,
      });
    const repository = new MemoryRepository();
    const lifecycle = new EnableSyncLifecycle(dependencies(api, repository));
    const presentation = await lifecycle.begin('Telefon');
    await lifecycle.confirmRecoveryCode(
      confirmationValues(presentation.recoveryCode, presentation.confirmationGroupNumbers),
    );

    await expect(lifecycle.activate()).rejects.toMatchObject({ code: 'server-ack-mismatch' });
    expect(repository.writes).toBe(0);
  });
});
