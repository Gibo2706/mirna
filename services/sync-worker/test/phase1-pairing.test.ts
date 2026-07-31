import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  SYNC_CRYPTO_SUITE,
  SYNC_DOMAIN_LABELS,
  SYNC_PROTOCOL_VERSION,
} from '../../../src/domain/sync/constants';
import {
  createOpaqueId,
  createPairingKeyConfirmation,
  createPairingTranscriptMac,
  decryptAesGcm,
  derivePairingAgreementKeys,
  derivePairingSecrets,
  deriveShortAuthenticationString,
  encryptAesGcm,
  exportPublicEcKey,
  generateDeviceKeyPairs,
  generateEphemeralAgreementKeyPair,
  hashDomainSeparatedCanonical,
  hashPairingClaimToken,
  importAgreementPublicKey,
  importSigningPublicKey,
  randomBytes,
  sha256,
  signDomainSeparatedCanonical,
  verifyDomainSeparatedCanonicalSignature,
  verifyPairingKeyConfirmation,
  verifyPairingTranscriptMac,
} from '../../../src/domain/sync/crypto';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  concatBytes,
  timingSafeEqual,
  utf8,
} from '../../../src/domain/sync/encoding';
import {
  manifestBodyHash,
  signVaultManifest,
  validateManifestTransition,
} from '../../../src/domain/sync/manifest';
import {
  pairingApprovalSchema,
  pairingCandidateSchema,
  pairingCreateResponseSchema,
  pairingEnvelopeSchema,
  pairingFinalizeResponseSchema,
  pairingPollResponseSchema,
  unsignedPairingEnvelopeSchema,
  unsignedVaultManifestSchema,
  vaultManifestSchema,
  type DevicePublicKeysV1,
  type PairingApprovalV1,
  type PairingEnvelopeV1,
  type PairingFinalizeTranscriptV1,
  type VaultManifestV1,
} from '../../../src/domain/sync/schemas';
import { rawP256PublicKey } from './fixtures';
import {
  createAccessSession,
  createInitialVaultFixture,
  issueChallenge,
  postCanonical,
  randomEncoded,
  registerInitialVault,
  signChallenge,
  tamperEncoded,
  TEST_ORIGIN,
  type InitialVaultFixture,
} from './protocol-fixtures';

interface PendingPairing {
  requestId: string;
  newDeviceId: string;
  newDeviceKeys: Awaited<ReturnType<typeof generateDeviceKeyPairs>>;
  newDevicePublicKeys: DevicePublicKeysV1;
  pairingRoot: Uint8Array;
  pairingSalt: Uint8Array;
  claimToken: string;
  pollingToken: string;
  transcriptMacKey: Uint8Array;
  sasKey: Uint8Array;
  expiresAt: string;
}

interface ApprovedPairing extends PendingPairing {
  currentManifest: VaultManifestV1;
  candidateManifest: VaultManifestV1;
  envelope: PairingEnvelopeV1;
  unsignedEnvelope: ReturnType<typeof unsignedPairingEnvelopeSchema.parse>;
  clientAgreement: Awaited<ReturnType<typeof derivePairingAgreementKeys>>;
  sas: string;
  accessToken: string;
  approvalBody: PairingApprovalV1;
}

const domainHash = async (label: string, value: Uint8Array): Promise<string> =>
  bytesToBase64Url(await sha256(concatBytes(utf8(label), Uint8Array.of(0), value)));

const errorCode = async (response: Response): Promise<string | undefined> =>
  (await response.json<{ error?: { code?: string } }>()).error?.code;

const createPendingPairing = async (
  options: { newDeviceId?: string } = {},
): Promise<PendingPairing> => {
  const requestId = createOpaqueId();
  const newDeviceId = options.newDeviceId ?? createOpaqueId();
  const newDeviceKeys = await generateDeviceKeyPairs();
  const newDevicePublicKeys = {
    signing: await exportPublicEcKey(newDeviceKeys.signing.publicKey),
    agreement: await exportPublicEcKey(newDeviceKeys.agreement.publicKey),
  };
  const pairingRoot = new Uint8Array(32).fill(0x50);
  const pairingSalt = randomBytes(32);
  const encodedSalt = bytesToBase64Url(pairingSalt);
  const derived = await derivePairingSecrets(pairingRoot, {
    pairingRequestId: requestId,
    pairingSalt: encodedSalt,
    origin: TEST_ORIGIN,
  });
  const pollingTokenBytes = randomBytes(32);
  const pollingToken = bytesToBase64Url(pollingTokenBytes);
  const response = await postCanonical('/v1/pairings', {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    requestId,
    deviceId: newDeviceId,
    publicKeys: newDevicePublicKeys,
    pairingSalt: encodedSalt,
    pairingClaimTokenHash: await hashPairingClaimToken(derived.claimToken),
    pollingTokenHash: await domainHash(SYNC_DOMAIN_LABELS.pollingTokenHash, pollingTokenBytes),
  });
  expect(response.status).toBe(201);
  const body = pairingCreateResponseSchema.parse(await response.json());
  return {
    requestId,
    newDeviceId,
    newDeviceKeys,
    newDevicePublicKeys,
    pairingRoot,
    pairingSalt,
    claimToken: bytesToBase64Url(derived.claimToken),
    pollingToken,
    transcriptMacKey: derived.transcriptMacKey,
    sasKey: derived.sasKey,
    expiresAt: body.expiresAt,
  };
};

const createCandidateManifest = async (
  vault: InitialVaultFixture,
  pairing: PendingPairing,
): Promise<VaultManifestV1> => {
  const occurredAt = new Date().toISOString();
  const newDevice = {
    deviceId: pairing.newDeviceId,
    publicKeys: pairing.newDevicePublicKeys,
    authorizedAt: occurredAt,
    authorizationExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
  };
  const unsigned = unsignedVaultManifestSchema.parse({
    type: vault.manifest.type,
    protocolVersion: vault.manifest.protocolVersion,
    suite: vault.manifest.suite,
    vaultId: vault.vaultId,
    manifestVersion: vault.manifest.manifestVersion + 1,
    keyEpoch: vault.manifest.keyEpoch,
    devices: [...vault.manifest.devices, newDevice].sort((left, right) =>
      left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0,
    ),
    revokedDevices: vault.manifest.revokedDevices,
    recoveryLookupId: vault.manifest.recoveryLookupId,
    recoverySigningPublicKey: vault.manifest.recoverySigningPublicKey,
    previousManifestHash: await manifestBodyHash(vault.manifest),
    transition: {
      transitionId: createOpaqueId(),
      kind: 'add-device',
      authorizationKind: 'device',
      authorizingDeviceId: vault.deviceId,
      affectedDeviceId: pairing.newDeviceId,
      occurredAt,
    },
  });
  return signVaultManifest(unsigned, vault.deviceKeys.signing.privateKey);
};

const buildPairingApproval = async (
  vault: InitialVaultFixture,
  pairing: PendingPairing,
): Promise<ApprovedPairing> => {
  const { accessToken } = await createAccessSession(vault);
  const candidateManifest = await createCandidateManifest(vault, pairing);
  const currentManifestHash = await manifestBodyHash(vault.manifest);
  const candidateManifestHash = await manifestBodyHash(candidateManifest);
  const ephemeral = await generateEphemeralAgreementKeyPair();
  const context = {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    origin: TEST_ORIGIN,
    vaultId: vault.vaultId,
    keyEpoch: vault.manifest.keyEpoch,
    pairingRequestId: pairing.requestId,
    pairingExpiresAt: pairing.expiresAt,
    currentManifestVersion: vault.manifest.manifestVersion,
    currentManifestHash,
    snapshotCommitId: null,
    operationFrontierHash: null,
    newDeviceId: pairing.newDeviceId,
    newDevicePublicKeys: pairing.newDevicePublicKeys,
    authorizingDeviceId: vault.deviceId,
    authorizingDevicePublicKeys: vault.devicePublicKeys,
    ephemeralAgreementPublicKey: await exportPublicEcKey(ephemeral.publicKey),
    ecdhSalt: bytesToBase64Url(pairing.pairingSalt),
  };
  const [authorizerAgreement, clientAgreement] = await Promise.all([
    derivePairingAgreementKeys(
      ephemeral.privateKey,
      pairing.newDeviceKeys.agreement.publicKey,
      pairing.pairingSalt,
      context,
    ),
    derivePairingAgreementKeys(
      pairing.newDeviceKeys.agreement.privateKey,
      ephemeral.publicKey,
      pairing.pairingSalt,
      context,
    ),
  ]);
  const aad = {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    vaultId: vault.vaultId,
    keyEpoch: vault.manifest.keyEpoch,
    objectType: 'pairing-vault-key' as const,
    objectId: createOpaqueId(),
    creatingDeviceId: vault.deviceId,
    recoveryLookupId: null,
    parentManifestHash: currentManifestHash,
    pairingContextHash: await hashDomainSeparatedCanonical(
      SYNC_DOMAIN_LABELS.pairingContext,
      context,
    ),
  };
  const nonce = randomBytes(12);
  const ciphertext = await encryptAesGcm(
    vault.vaultMasterKey,
    authorizerAgreement.wrappingKey,
    nonce,
    aad,
  );
  const unsignedEnvelope = unsignedPairingEnvelopeSchema.parse({
    type: 'mirna-pairing-envelope-v1',
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    context,
    nonce: bytesToBase64Url(nonce),
    aad,
    ciphertext: bytesToBase64Url(ciphertext),
    ciphertextHash: bytesToBase64Url(await sha256(ciphertext)),
    ciphertextLength: ciphertext.length,
    candidateManifestHash,
  });
  const envelope = pairingEnvelopeSchema.parse({
    ...unsignedEnvelope,
    signature: await signDomainSeparatedCanonical(
      SYNC_DOMAIN_LABELS.pairingEnvelope,
      unsignedEnvelope,
      vault.deviceKeys.signing.privateKey,
    ),
    transcriptMac: await createPairingTranscriptMac(unsignedEnvelope, pairing.transcriptMacKey),
    keyConfirmation: await createPairingKeyConfirmation(
      unsignedEnvelope,
      authorizerAgreement.confirmationKey,
    ),
  });
  const sensitiveChallenge = await issueChallenge(vault, '/v1/pairings/approve');
  const approvalBody = pairingApprovalSchema.parse({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    pairingRequestId: pairing.requestId,
    claimToken: pairing.claimToken,
    envelope,
    candidateManifest,
    sensitiveChallenge,
    sensitiveSignature: await signChallenge(vault, sensitiveChallenge),
    approverSasConfirmed: true,
  });
  const sas = await deriveShortAuthenticationString(
    unsignedEnvelope,
    envelope.transcriptMac,
    pairing.sasKey,
  );
  return {
    ...pairing,
    currentManifest: vault.manifest,
    candidateManifest,
    envelope,
    unsignedEnvelope,
    clientAgreement,
    sas,
    accessToken,
    approvalBody,
  };
};

const approvePairing = async (
  vault: InitialVaultFixture,
  pairing: PendingPairing,
): Promise<ApprovedPairing> => {
  const approval = await buildPairingApproval(vault, pairing);
  const response = await postCanonical(
    `/v1/pairings/${pairing.requestId}/approve`,
    approval.approvalBody,
    { accessToken: approval.accessToken },
  );
  expect(response.status).toBe(200);
  return approval;
};

const buildPairingFinalization = async (
  approved: ApprovedPairing,
): Promise<{
  transcript: PairingFinalizeTranscriptV1;
  signature: string;
}> => {
  const transcript: PairingFinalizeTranscriptV1 = {
    type: 'mirna-pairing-finalize-v1',
    protocolVersion: 1,
    vaultId: approved.currentManifest.vaultId,
    pairingRequestId: approved.requestId,
    newDeviceId: approved.newDeviceId,
    candidateManifestHash: await manifestBodyHash(approved.candidateManifest),
    envelopeHash: await hashDomainSeparatedCanonical(
      SYNC_DOMAIN_LABELS.pairingEnvelopeHash,
      approved.envelope,
    ),
    keyConfirmation: approved.envelope.keyConfirmation,
    sasConfirmed: true,
    confirmedAt: new Date().toISOString(),
  };
  return {
    transcript,
    signature: await signDomainSeparatedCanonical(
      SYNC_DOMAIN_LABELS.pairingFinalize,
      transcript,
      approved.newDeviceKeys.signing.privateKey,
    ),
  };
};

const finalizeApprovedPairing = async (
  approved: ApprovedPairing,
  finalization: Awaited<ReturnType<typeof buildPairingFinalization>>,
): Promise<Response> =>
  postCanonical(`/v1/pairings/${approved.requestId}/finalize`, {
    protocolVersion: 1,
    pollingToken: approved.pollingToken,
    transcript: finalization.transcript,
    signature: finalization.signature,
  });

describe('Phase 1 pairing request lifecycle', () => {
  it('creates and inspects only with the claim token while keeping polling authority separate', async () => {
    const pairing = await createPendingPairing();
    const inspected = await postCanonical(`/v1/pairings/${pairing.requestId}/inspect`, {
      protocolVersion: 1,
      claimToken: pairing.claimToken,
    });
    expect(inspected.status).toBe(200);
    expect(pairingCandidateSchema.parse(await inspected.json())).toMatchObject({
      requestId: pairing.requestId,
      deviceId: pairing.newDeviceId,
      pairingSalt: bytesToBase64Url(pairing.pairingSalt),
    });

    const claimCannotPoll = await postCanonical(`/v1/pairings/${pairing.requestId}/poll`, {
      protocolVersion: 1,
      pollingToken: pairing.claimToken,
    });
    expect(claimCannotPoll.status).toBe(404);
    const polled = await postCanonical(`/v1/pairings/${pairing.requestId}/poll`, {
      protocolVersion: 1,
      pollingToken: pairing.pollingToken,
    });
    expect(polled.status).toBe(200);
    expect(pairingPollResponseSchema.parse(await polled.json()).status).toBe('pending');

    const stored = await env.MIRNA_SYNC_DB.prepare(
      `SELECT hex(pairing_claim_token_hash) AS claim_hash,
              hex(polling_token_hash) AS polling_hash
         FROM pairing_requests WHERE pairing_request_id = ?1`,
    )
      .bind(pairing.requestId)
      .first<Record<string, string>>();
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(bytesToHex(pairing.pairingRoot).toUpperCase());
    expect(serialized).not.toContain(
      bytesToHex(base64UrlToBytes(pairing.pollingToken)).toUpperCase(),
    );
    expect((await env.MIRNA_SYNC_BUCKET.list()).objects).toEqual([]);
  });

  it('rejects off-curve P-256 keys before creating a pairing request', async () => {
    const validKeys = await generateDeviceKeyPairs();
    const validPublicKeys: DevicePublicKeysV1 = {
      signing: await exportPublicEcKey(validKeys.signing.publicKey),
      agreement: await exportPublicEcKey(validKeys.agreement.publicKey),
    };
    const invalidPublicKey = {
      format: 'raw-p256' as const,
      value: rawP256PublicKey(0),
    };
    await expect(importSigningPublicKey(invalidPublicKey)).rejects.toBeDefined();
    await expect(importAgreementPublicKey(invalidPublicKey)).rejects.toBeDefined();
    const countBefore = await env.MIRNA_SYNC_DB.prepare(
      'SELECT COUNT(*) AS count FROM pairing_requests',
    ).first<number>('count');

    const submit = async (publicKeys: DevicePublicKeysV1): Promise<Response> => {
      const requestId = createOpaqueId();
      const pairingSalt = randomBytes(32);
      const secrets = await derivePairingSecrets(randomBytes(32), {
        pairingRequestId: requestId,
        pairingSalt: bytesToBase64Url(pairingSalt),
        origin: TEST_ORIGIN,
      });
      const pollingToken = randomBytes(32);
      return postCanonical('/v1/pairings', {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        requestId,
        deviceId: createOpaqueId(),
        publicKeys,
        pairingSalt: bytesToBase64Url(pairingSalt),
        pairingClaimTokenHash: await hashPairingClaimToken(secrets.claimToken),
        pollingTokenHash: await domainHash(SYNC_DOMAIN_LABELS.pollingTokenHash, pollingToken),
      });
    };

    for (const publicKeys of [
      { ...validPublicKeys, signing: invalidPublicKey },
      { ...validPublicKeys, agreement: invalidPublicKey },
    ]) {
      const response = await submit(publicKeys);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('INVALID_PUBLIC_KEY');
    }
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        'SELECT COUNT(*) AS count FROM pairing_requests',
      ).first<number>('count'),
    ).toBe(countBefore);
  });

  it('rejects non-identical request-id reuse and limits active requests per device', async () => {
    const pairing = await createPendingPairing();
    const row = await env.MIRNA_SYNC_DB.prepare(
      `SELECT new_signing_public_key_raw, new_agreement_public_key_raw, pairing_salt
         FROM pairing_requests WHERE pairing_request_id = ?1`,
    )
      .bind(pairing.requestId)
      .first<{
        new_signing_public_key_raw: string;
        new_agreement_public_key_raw: string;
        pairing_salt: ArrayBuffer;
      }>();
    expect(row).not.toBeNull();
    const duplicateTamper = await postCanonical('/v1/pairings', {
      protocolVersion: 1,
      suite: SYNC_CRYPTO_SUITE,
      requestId: pairing.requestId,
      deviceId: pairing.newDeviceId,
      publicKeys: pairing.newDevicePublicKeys,
      pairingSalt: bytesToBase64Url(pairing.pairingSalt),
      pairingClaimTokenHash: randomEncoded(),
      pollingTokenHash: randomEncoded(),
    });
    expect(duplicateTamper.status).toBe(409);
    expect(await errorCode(duplicateTamper)).toBe('PAIRING_ID_REUSED');

    await createPendingPairing({ newDeviceId: pairing.newDeviceId });
    await createPendingPairing({ newDeviceId: pairing.newDeviceId });
    const fourthKeys = await generateDeviceKeyPairs();
    const fourthSalt = randomBytes(32);
    const fourthRoot = randomBytes(32);
    const fourthRequestId = createOpaqueId();
    const fourthSecrets = await derivePairingSecrets(fourthRoot, {
      pairingRequestId: fourthRequestId,
      pairingSalt: bytesToBase64Url(fourthSalt),
      origin: TEST_ORIGIN,
    });
    const fourthPoll = randomBytes(32);
    const fourth = await postCanonical('/v1/pairings', {
      protocolVersion: 1,
      suite: SYNC_CRYPTO_SUITE,
      requestId: fourthRequestId,
      deviceId: pairing.newDeviceId,
      publicKeys: {
        signing: await exportPublicEcKey(fourthKeys.signing.publicKey),
        agreement: await exportPublicEcKey(fourthKeys.agreement.publicKey),
      },
      pairingSalt: bytesToBase64Url(fourthSalt),
      pairingClaimTokenHash: await hashPairingClaimToken(fourthSecrets.claimToken),
      pollingTokenHash: await domainHash(SYNC_DOMAIN_LABELS.pollingTokenHash, fourthPoll),
    });
    expect(fourth.status).toBe(429);
    expect(await errorCode(fourth)).toBe('PAIRING_LIMIT_REACHED');
  });

  it('cancels after five wrong claim attempts and never reveals whether a claim was close', async () => {
    const pairing = await createPendingPairing();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await postCanonical(`/v1/pairings/${pairing.requestId}/inspect`, {
        protocolVersion: 1,
        claimToken: randomEncoded(),
      });
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe('RESOURCE_NOT_FOUND');
    }
    const row = await env.MIRNA_SYNC_DB.prepare(
      `SELECT failed_attempts, max_attempts, status
         FROM pairing_requests WHERE pairing_request_id = ?1`,
    )
      .bind(pairing.requestId)
      .first<{ failed_attempts: number; max_attempts: number; status: string }>();
    expect(row).toEqual({ failed_attempts: 5, max_attempts: 5, status: 'cancelled' });

    const correctAfterLockout = await postCanonical(`/v1/pairings/${pairing.requestId}/inspect`, {
      protocolVersion: 1,
      claimToken: pairing.claimToken,
    });
    expect(correctAfterLockout.status).toBe(404);
  });

  it('reports expiry to the poller and allows only the polling token to cancel', async () => {
    const cancellable = await createPendingPairing();
    const wrongCancel = await postCanonical(`/v1/pairings/${cancellable.requestId}/cancel`, {
      protocolVersion: 1,
      pollingToken: cancellable.claimToken,
    });
    expect(wrongCancel.status).toBe(404);
    const cancelled = await postCanonical(`/v1/pairings/${cancellable.requestId}/cancel`, {
      protocolVersion: 1,
      pollingToken: cancellable.pollingToken,
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled' });

    const expired = await createPendingPairing();
    const expiredAt = Date.now() - 1;
    await env.MIRNA_SYNC_DB.prepare(
      `UPDATE pairing_requests SET created_at = ?2, expires_at = ?3 WHERE pairing_request_id = ?1`,
    )
      .bind(expired.requestId, expiredAt - 1_000, expiredAt)
      .run();
    const inspectExpired = await postCanonical(`/v1/pairings/${expired.requestId}/inspect`, {
      protocolVersion: 1,
      claimToken: expired.claimToken,
    });
    expect(inspectExpired.status).toBe(404);
    const pollExpired = await postCanonical(`/v1/pairings/${expired.requestId}/poll`, {
      protocolVersion: 1,
      pollingToken: expired.pollingToken,
    });
    expect(pollExpired.status).toBe(200);
    expect(pairingPollResponseSchema.parse(await pollExpired.json()).status).toBe('expired');
  });
});

describe('Phase 1 pairing approval and finalization', () => {
  it.each([
    ['signing', 'new_signing_public_key_raw', 'signing'],
    ['agreement', 'new_agreement_public_key_raw', 'agreement'],
  ] as const)(
    'rejects approval when the frozen %s key differs from the coherent candidate and envelope',
    async (_label, column, keyKind) => {
      const vault = await createInitialVaultFixture();
      expect((await registerInitialVault(vault)).status).toBe(201);
      const pairing = await createPendingPairing();
      const approval = await buildPairingApproval(vault, pairing);
      const foreignKeys = await generateDeviceKeyPairs();
      const foreignPublicKeys: DevicePublicKeysV1 = {
        signing: await exportPublicEcKey(foreignKeys.signing.publicKey),
        agreement: await exportPublicEcKey(foreignKeys.agreement.publicKey),
      };
      await env.MIRNA_SYNC_DB.prepare(
        `UPDATE pairing_requests SET ${column} = ?1 WHERE pairing_request_id = ?2`,
      )
        .bind(foreignPublicKeys[keyKind].value, pairing.requestId)
        .run();

      const response = await postCanonical(
        `/v1/pairings/${pairing.requestId}/approve`,
        approval.approvalBody,
        { accessToken: approval.accessToken },
      );
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('PAIRING_TRANSCRIPT_MISMATCH');
      expect(
        await env.MIRNA_SYNC_DB.prepare(
          'SELECT COUNT(*) AS count FROM pairing_envelopes WHERE pairing_request_id = ?1',
        )
          .bind(pairing.requestId)
          .first<number>('count'),
      ).toBe(0);
      expect(
        await env.MIRNA_SYNC_DB.prepare(
          'SELECT status FROM pairing_requests WHERE pairing_request_id = ?1',
        )
          .bind(pairing.requestId)
          .first<string>('status'),
      ).toBe('pending');
    },
  );

  it.each([
    ['signing', 'new_signing_public_key_raw', 'signing'],
    ['agreement', 'new_agreement_public_key_raw', 'agreement'],
  ] as const)(
    'rejects finalization when the frozen %s key no longer matches the approved candidate',
    async (_label, column, keyKind) => {
      const vault = await createInitialVaultFixture();
      expect((await registerInitialVault(vault)).status).toBe(201);
      const approved = await approvePairing(vault, await createPendingPairing());
      const foreignKeys = await generateDeviceKeyPairs();
      const foreignPublicKeys: DevicePublicKeysV1 = {
        signing: await exportPublicEcKey(foreignKeys.signing.publicKey),
        agreement: await exportPublicEcKey(foreignKeys.agreement.publicKey),
      };
      await env.MIRNA_SYNC_DB.prepare(
        `UPDATE pairing_requests SET ${column} = ?1 WHERE pairing_request_id = ?2`,
      )
        .bind(foreignPublicKeys[keyKind].value, approved.requestId)
        .run();

      const response = await finalizeApprovedPairing(
        approved,
        await buildPairingFinalization(approved),
      );
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('PAIRING_FINALIZATION_MISMATCH');
      const state = await env.MIRNA_SYNC_DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM devices
             WHERE vault_id = ?1 AND device_id = ?2) AS device_count,
           (SELECT current_manifest_version FROM vaults
             WHERE vault_id = ?1) AS manifest_version,
           (SELECT status FROM pairing_requests
             WHERE pairing_request_id = ?3) AS pairing_status`,
      )
        .bind(vault.vaultId, approved.newDeviceId, approved.requestId)
        .first<{ device_count: number; manifest_version: number; pairing_status: string }>();
      expect(state).toEqual({ device_count: 0, manifest_version: 1, pairing_status: 'approved' });
    },
  );

  it('rejects signature, AAD and explicit SAS-confirmation tampering before persistence', async () => {
    const vault = await createInitialVaultFixture();
    expect((await registerInitialVault(vault)).status).toBe(201);
    const pairing = await createPendingPairing();
    const { accessToken } = await createAccessSession(vault);
    const candidateManifest = await createCandidateManifest(vault, pairing);
    const currentManifestHash = await manifestBodyHash(vault.manifest);
    const ephemeral = await generateEphemeralAgreementKeyPair();
    const context = {
      protocolVersion: 1 as const,
      suite: SYNC_CRYPTO_SUITE,
      origin: TEST_ORIGIN,
      vaultId: vault.vaultId,
      keyEpoch: 1,
      pairingRequestId: pairing.requestId,
      pairingExpiresAt: pairing.expiresAt,
      currentManifestVersion: 1,
      currentManifestHash,
      snapshotCommitId: null,
      operationFrontierHash: null,
      newDeviceId: pairing.newDeviceId,
      newDevicePublicKeys: pairing.newDevicePublicKeys,
      authorizingDeviceId: vault.deviceId,
      authorizingDevicePublicKeys: vault.devicePublicKeys,
      ephemeralAgreementPublicKey: await exportPublicEcKey(ephemeral.publicKey),
      ecdhSalt: bytesToBase64Url(pairing.pairingSalt),
    };
    const agreement = await derivePairingAgreementKeys(
      ephemeral.privateKey,
      pairing.newDeviceKeys.agreement.publicKey,
      pairing.pairingSalt,
      context,
    );
    const aad = {
      protocolVersion: 1 as const,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: vault.vaultId,
      keyEpoch: 1,
      objectType: 'pairing-vault-key' as const,
      objectId: createOpaqueId(),
      creatingDeviceId: vault.deviceId,
      recoveryLookupId: null,
      parentManifestHash: currentManifestHash,
      pairingContextHash: await hashDomainSeparatedCanonical(
        SYNC_DOMAIN_LABELS.pairingContext,
        context,
      ),
    };
    const nonce = randomBytes(12);
    const ciphertext = await encryptAesGcm(vault.vaultMasterKey, agreement.wrappingKey, nonce, aad);
    const unsigned = unsignedPairingEnvelopeSchema.parse({
      type: 'mirna-pairing-envelope-v1',
      protocolVersion: 1,
      suite: SYNC_CRYPTO_SUITE,
      context,
      nonce: bytesToBase64Url(nonce),
      aad,
      ciphertext: bytesToBase64Url(ciphertext),
      ciphertextHash: bytesToBase64Url(await sha256(ciphertext)),
      ciphertextLength: ciphertext.length,
      candidateManifestHash: await manifestBodyHash(candidateManifest),
    });
    const validEnvelope = pairingEnvelopeSchema.parse({
      ...unsigned,
      signature: await signDomainSeparatedCanonical(
        SYNC_DOMAIN_LABELS.pairingEnvelope,
        unsigned,
        vault.deviceKeys.signing.privateKey,
      ),
      transcriptMac: await createPairingTranscriptMac(unsigned, pairing.transcriptMacKey),
      keyConfirmation: await createPairingKeyConfirmation(unsigned, agreement.confirmationKey),
    });

    const approvalBody = async (envelope: PairingEnvelopeV1, sasConfirmed: boolean) => {
      const challenge = await issueChallenge(vault, '/v1/pairings/approve');
      return {
        protocolVersion: 1,
        pairingRequestId: pairing.requestId,
        claimToken: pairing.claimToken,
        envelope,
        candidateManifest,
        sensitiveChallenge: challenge,
        sensitiveSignature: await signChallenge(vault, challenge),
        approverSasConfirmed: sasConfirmed,
      };
    };

    const signatureTamper = await postCanonical(
      `/v1/pairings/${pairing.requestId}/approve`,
      await approvalBody(
        pairingEnvelopeSchema.parse({
          ...validEnvelope,
          signature: await signDomainSeparatedCanonical(
            SYNC_DOMAIN_LABELS.pairingEnvelope,
            unsigned,
            pairing.newDeviceKeys.signing.privateKey,
          ),
        }),
        true,
      ),
      { accessToken },
    );
    expect(signatureTamper.status).toBe(403);
    expect(await errorCode(signatureTamper)).toBe('PAIRING_SIGNATURE_INVALID');

    const changedCiphertextBytes = base64UrlToBytes(validEnvelope.ciphertext);
    changedCiphertextBytes[0] = (changedCiphertextBytes[0] ?? 0) ^ 1;
    const ciphertextTamper = await postCanonical(
      `/v1/pairings/${pairing.requestId}/approve`,
      await approvalBody(
        pairingEnvelopeSchema.parse({
          ...validEnvelope,
          ciphertext: bytesToBase64Url(changedCiphertextBytes),
        }),
        true,
      ),
      { accessToken },
    );
    expect(ciphertextTamper.status).toBe(403);
    expect(await errorCode(ciphertextTamper)).toBe('PAIRING_TRANSCRIPT_MISMATCH');

    const aadTamper = await postCanonical(
      `/v1/pairings/${pairing.requestId}/approve`,
      await approvalBody(
        pairingEnvelopeSchema.parse({
          ...validEnvelope,
          aad: { ...validEnvelope.aad, pairingContextHash: randomEncoded() },
        }),
        true,
      ),
      { accessToken },
    );
    expect(aadTamper.status).toBe(403);
    expect(await errorCode(aadTamper)).toBe('PAIRING_TRANSCRIPT_MISMATCH');

    const unconfirmed = await postCanonical(
      `/v1/pairings/${pairing.requestId}/approve`,
      await approvalBody(validEnvelope, false),
      { accessToken },
    );
    expect(unconfirmed.status).toBe(400);
    expect(await errorCode(unconfirmed)).toBe('INVALID_REQUEST');
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        'SELECT COUNT(*) AS count FROM pairing_envelopes WHERE pairing_request_id = ?1',
      )
        .bind(pairing.requestId)
        .first<number>('count'),
    ).toBe(0);
  });

  it('completes an end-to-end approval, client trust checks and idempotent finalization', async () => {
    const vault = await createInitialVaultFixture();
    expect((await registerInitialVault(vault)).status).toBe(201);
    const approved = await approvePairing(vault, await createPendingPairing());

    const poll = await postCanonical(`/v1/pairings/${approved.requestId}/poll`, {
      protocolVersion: 1,
      pollingToken: approved.pollingToken,
    });
    expect(poll.status).toBe(200);
    const polled = pairingPollResponseSchema.parse(await poll.json());
    expect(polled.status).toBe('approved');
    if (polled.status !== 'approved') throw new Error('Expected an approved pairing fixture.');
    expect(polled.envelope).toEqual(approved.envelope);
    const polledUnsigned = approved.unsignedEnvelope;
    expect(
      await verifyPairingTranscriptMac(
        polledUnsigned,
        polled.envelope.transcriptMac,
        approved.transcriptMacKey,
      ),
    ).toBe(true);
    expect(
      await verifyPairingKeyConfirmation(
        polledUnsigned,
        polled.envelope.keyConfirmation,
        approved.clientAgreement.confirmationKey,
      ),
    ).toBe(true);
    expect(
      await verifyDomainSeparatedCanonicalSignature(
        SYNC_DOMAIN_LABELS.pairingEnvelope,
        polledUnsigned,
        polled.envelope.signature,
        vault.deviceKeys.signing.publicKey,
      ),
    ).toBe(true);
    await expect(
      validateManifestTransition(vault.manifest, polled.candidateManifest),
    ).resolves.toBe(undefined);
    const openedVaultKey = await decryptAesGcm(
      base64UrlToBytes(polled.envelope.ciphertext),
      approved.clientAgreement.wrappingKey,
      base64UrlToBytes(polled.envelope.nonce),
      polled.envelope.aad,
    );
    expect(timingSafeEqual(openedVaultKey, vault.vaultMasterKey)).toBe(true);
    expect(
      await deriveShortAuthenticationString(
        polledUnsigned,
        polled.envelope.transcriptMac,
        approved.sasKey,
      ),
    ).toBe(approved.sas);
    expect(
      await verifyPairingTranscriptMac(
        polledUnsigned,
        tamperEncoded(polled.envelope.transcriptMac),
        approved.transcriptMacKey,
      ),
    ).toBe(false);
    expect(
      await verifyPairingKeyConfirmation(
        polledUnsigned,
        tamperEncoded(polled.envelope.keyConfirmation),
        approved.clientAgreement.confirmationKey,
      ),
    ).toBe(false);
    const tamperedSas = await deriveShortAuthenticationString(
      { ...polledUnsigned, ciphertextHash: randomEncoded() },
      polled.envelope.transcriptMac,
      approved.sasKey,
    );
    expect(tamperedSas).not.toBe(approved.sas);

    const candidateManifestHash = await manifestBodyHash(approved.candidateManifest);
    const envelopeHash = await hashDomainSeparatedCanonical(
      SYNC_DOMAIN_LABELS.pairingEnvelopeHash,
      approved.envelope,
    );
    const transcript: PairingFinalizeTranscriptV1 = {
      type: 'mirna-pairing-finalize-v1',
      protocolVersion: 1,
      vaultId: vault.vaultId,
      pairingRequestId: approved.requestId,
      newDeviceId: approved.newDeviceId,
      candidateManifestHash,
      envelopeHash,
      keyConfirmation: approved.envelope.keyConfirmation,
      sasConfirmed: true,
      confirmedAt: new Date().toISOString(),
    };
    const finalize = (input: PairingFinalizeTranscriptV1, signature: string) =>
      postCanonical(`/v1/pairings/${approved.requestId}/finalize`, {
        protocolVersion: 1,
        pollingToken: approved.pollingToken,
        transcript: input,
        signature,
      });

    const wrongConfirmation = { ...transcript, keyConfirmation: randomEncoded() };
    const wrongConfirmationResponse = await finalize(
      wrongConfirmation,
      await signDomainSeparatedCanonical(
        SYNC_DOMAIN_LABELS.pairingFinalize,
        wrongConfirmation,
        approved.newDeviceKeys.signing.privateKey,
      ),
    );
    expect(wrongConfirmationResponse.status).toBe(403);
    expect(await errorCode(wrongConfirmationResponse)).toBe('PAIRING_FINALIZATION_MISMATCH');

    const validSignature = await signDomainSeparatedCanonical(
      SYNC_DOMAIN_LABELS.pairingFinalize,
      transcript,
      approved.newDeviceKeys.signing.privateKey,
    );
    const badSignature = await finalize(transcript, tamperEncoded(validSignature));
    expect(badSignature.status).toBe(403);
    expect(await errorCode(badSignature)).toBe('PAIRING_FINALIZATION_SIGNATURE_INVALID');

    const concurrentFinalizations = await Promise.all([
      finalize(transcript, validSignature),
      finalize(transcript, validSignature),
    ]);
    expect(concurrentFinalizations.map((response) => response.status).sort()).toEqual([200, 201]);
    for (const finalized of concurrentFinalizations) {
      expect(pairingFinalizeResponseSchema.parse(await finalized.json())).toMatchObject({
        vaultId: vault.vaultId,
        deviceId: approved.newDeviceId,
        manifestVersion: 2,
        finalized: true,
      });
    }
    const duplicate = await finalize(transcript, validSignature);
    expect(duplicate.status).toBe(200);
    expect(pairingFinalizeResponseSchema.parse(await duplicate.json()).finalized).toBe(true);

    const state = await env.MIRNA_SYNC_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM devices WHERE vault_id = ?1 AND status = 'active') AS devices,
         (SELECT current_manifest_version FROM vaults WHERE vault_id = ?1) AS manifest_version,
         (SELECT COUNT(*) FROM pairing_envelopes
           WHERE vault_id = ?1 AND consumed_at IS NOT NULL) AS consumed`,
    )
      .bind(vault.vaultId)
      .first<Record<string, number>>();
    expect(state).toEqual({ devices: 2, manifest_version: 2, consumed: 1 });

    const serializedState = JSON.stringify(
      await env.MIRNA_SYNC_DB.prepare(
        `SELECT canonical_envelope, candidate_manifest, hex(envelope_hash) AS envelope_hash
           FROM pairing_envelopes WHERE pairing_request_id = ?1`,
      )
        .bind(approved.requestId)
        .first(),
    );
    expect(serializedState).not.toContain('SALARY-123456-RSD-PRIVATE-DATA!!');
    expect(serializedState).not.toContain(bytesToHex(approved.pairingRoot).toUpperCase());
    expect((await env.MIRNA_SYNC_BUCKET.list()).objects).toEqual([]);
  });

  it('returns the exact approval after a lost response, including after finalization', async () => {
    const vault = await createInitialVaultFixture();
    expect((await registerInitialVault(vault)).status).toBe(201);
    const pairing = await createPendingPairing();
    const approval = await approvePairing(vault, pairing);
    const finalization = await buildPairingFinalization(approval);
    expect((await finalizeApprovedPairing(approval, finalization)).status).toBe(201);

    const { accessToken } = await createAccessSession(vault);
    const sensitiveChallenge = await issueChallenge(vault, '/v1/pairings/approve');
    const retryBody = pairingApprovalSchema.parse({
      ...approval.approvalBody,
      sensitiveChallenge,
      sensitiveSignature: await signChallenge(vault, sensitiveChallenge),
    });
    const retry = await postCanonical(`/v1/pairings/${pairing.requestId}/approve`, retryBody, {
      accessToken,
    });

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      protocolVersion: 1,
      status: 'approved',
      expiresAt: pairing.expiresAt,
    });
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        'SELECT COUNT(*) AS count FROM pairing_envelopes WHERE pairing_request_id = ?1',
      )
        .bind(pairing.requestId)
        .first<number>('count'),
    ).toBe(1);
  });

  it('keeps the losing stale-manifest pairing out of every session-capable table', async () => {
    const vault = await createInitialVaultFixture();
    expect((await registerInitialVault(vault)).status).toBe(201);

    const first = await approvePairing(vault, await createPendingPairing());
    const second = await approvePairing(vault, await createPendingPairing());
    expect(first.candidateManifest.manifestVersion).toBe(2);
    expect(second.candidateManifest.manifestVersion).toBe(2);
    expect(first.candidateManifest.previousManifestHash).toBe(
      second.candidateManifest.previousManifestHash,
    );

    const firstFinalization = await buildPairingFinalization(first);
    const secondFinalization = await buildPairingFinalization(second);
    const firstResponse = await finalizeApprovedPairing(first, firstFinalization);
    expect(firstResponse.status).toBe(201);

    const losingResponse = await finalizeApprovedPairing(second, secondFinalization);
    expect(losingResponse.status).toBe(409);
    expect(await errorCode(losingResponse)).toBe('MANIFEST_STATE_CHANGED');

    const state = await env.MIRNA_SYNC_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM devices
           WHERE vault_id = ?1 AND device_id = ?2) AS winning_device,
         (SELECT COUNT(*) FROM devices
           WHERE vault_id = ?1 AND device_id = ?3) AS losing_device,
         (SELECT COUNT(*) FROM device_grants
           WHERE vault_id = ?1 AND device_id = ?2) AS winning_grant,
         (SELECT COUNT(*) FROM device_grants
           WHERE vault_id = ?1 AND device_id = ?3) AS losing_grant,
         (SELECT COUNT(*) FROM access_sessions
           WHERE vault_id = ?1 AND device_id = ?3) AS losing_sessions,
         (SELECT COUNT(*) FROM auth_challenges
           WHERE vault_id = ?1 AND device_id = ?3) AS losing_challenges,
         (SELECT status FROM pairing_requests
           WHERE pairing_request_id = ?4) AS losing_pairing_status,
         (SELECT current_manifest_version FROM vaults
           WHERE vault_id = ?1) AS manifest_version`,
    )
      .bind(vault.vaultId, first.newDeviceId, second.newDeviceId, second.requestId)
      .first<{
        winning_device: number;
        losing_device: number;
        winning_grant: number;
        losing_grant: number;
        losing_sessions: number;
        losing_challenges: number;
        losing_pairing_status: string;
        manifest_version: number;
      }>();
    expect(state).toEqual({
      winning_device: 1,
      losing_device: 0,
      winning_grant: 1,
      losing_grant: 0,
      losing_sessions: 0,
      losing_challenges: 0,
      losing_pairing_status: 'approved',
      manifest_version: 2,
    });

    const currentManifest = await env.MIRNA_SYNC_DB.prepare(
      `SELECT canonical_manifest
         FROM vault_manifests
        WHERE vault_id = ?1 AND manifest_version = 2`,
    )
      .bind(vault.vaultId)
      .first<{ canonical_manifest: string }>();
    expect(currentManifest).not.toBeNull();
    const currentDevices = vaultManifestSchema
      .parse(JSON.parse(currentManifest?.canonical_manifest ?? '{}'))
      .devices.map((device) => device.deviceId);
    expect(currentDevices).toContain(first.newDeviceId);
    expect(currentDevices).not.toContain(second.newDeviceId);

    const unauthorizedChallenge = await postCanonical('/v1/auth/challenge', {
      protocolVersion: 1,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: vault.vaultId,
      deviceId: second.newDeviceId,
      audience: '/v1/auth/session',
      origin: TEST_ORIGIN,
    });
    expect(unauthorizedChallenge.status).toBe(403);
    expect(await errorCode(unauthorizedChallenge)).toBe('DEVICE_AUTHORIZATION_REQUIRED');
  });
});
