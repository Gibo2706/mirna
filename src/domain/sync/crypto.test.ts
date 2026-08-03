/** Synthetic cryptographic fixtures. No production or user key material. */
import { describe, expect, it } from 'vitest';
import { canonicalBytes } from './canonical';
import { SYNC_CRYPTO_SUITE, SYNC_LIMITS, SYNC_PROTOCOL_VERSION } from './constants';
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
  deriveDeviceEnvelopeWrappingKey,
  deriveObjectEncryptionKey,
  derivePairingAgreementKeys,
  derivePairingSecrets,
  derivePairingWrappingKey,
  deriveRecoveryKeys,
  deriveShortAuthenticationString,
  encryptAesGcm,
  exportPublicEcKey,
  exportRecoverySigningPrivateKey,
  generateDeviceKeyPairs,
  generateEphemeralAgreementKeyPair,
  generateLocalWrappingKey,
  generateRecoverySigningKeyPair,
  hashCanonical,
  hashPairingClaimToken,
  importAgreementPublicKey,
  importRecoverySigningPrivateKey,
  importSigningPublicKey,
  isNormalizedP256Signature,
  openEncryptedKeyEnvelope,
  openEncryptedRecoveryBundleEnvelope,
  parsePairingCode,
  parsePairingQrPayload,
  parseRecoveryCode,
  randomBytes,
  sha256,
  signCanonical,
  verifyCanonicalSignature,
  verifyPairingTranscriptMac,
  verifyPairingKeyConfirmation,
  verifyRecoveryProof,
  type CryptoRuntime,
} from './crypto';
import { base64UrlToBytes, bytesToBase64Url, clearBytes, hexToBytes, utf8 } from './encoding';
import { cryptoSuiteSchema, type EncryptedKeyAadV1 } from './schemas';
import { createInitialManifest, manifestBodyHash } from './manifest';

const runtime = globalThis.crypto as CryptoRuntime;
const fixed = (length: number, start = 0): Uint8Array =>
  Uint8Array.from({ length }, (_value, index) => (start + index) & 255);
const vaultId = bytesToBase64Url(fixed(16, 1));
const objectId = bytesToBase64Url(fixed(16, 33));
const deviceId = bytesToBase64Url(fixed(16, 65));
const manifestHash = bytesToBase64Url(fixed(32, 96));
const recoveryLookupId = bytesToBase64Url(fixed(16, 112));

const recoveryAad = (): EncryptedKeyAadV1 => ({
  protocolVersion: SYNC_PROTOCOL_VERSION,
  suite: SYNC_CRYPTO_SUITE,
  vaultId,
  keyEpoch: 1,
  objectType: 'recovery-vault-key',
  objectId,
  creatingDeviceId: deviceId,
  recoveryLookupId,
  parentManifestHash: manifestHash,
});

describe('Mirna sync Web Crypto suite', () => {
  it('generates non-extractable private device and local wrapping keys', async () => {
    const keys = await generateDeviceKeyPairs(runtime);
    const wrappingKey = await generateLocalWrappingKey(runtime);
    expect(keys.signing.privateKey.extractable).toBe(false);
    expect(keys.agreement.privateKey.extractable).toBe(false);
    expect(keys.signing.publicKey.extractable).toBe(true);
    expect(keys.agreement.publicKey.extractable).toBe(true);
    expect(wrappingKey.extractable).toBe(false);
    expect(await exportPublicEcKey(keys.signing.publicKey, runtime)).toMatchObject({
      format: 'raw-p256',
    });
  });

  it('rejects AES-GCM keys outside the frozen 256-bit suite and required usage', async () => {
    const aes128 = await runtime.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const encryptOnly = await runtime.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
    ]);
    const nonce = fixed(12, 19);
    const aad = { protocolVersion: 1, purpose: 'negative-suite-test' };

    await expect(encryptAesGcm(utf8('test'), aes128, nonce, aad, runtime)).rejects.toThrow(
      'AES-256-GCM',
    );
    const ciphertext = await encryptAesGcm(utf8('test'), encryptOnly, nonce, aad, runtime);
    await expect(decryptAesGcm(ciphertext, encryptOnly, nonce, aad, runtime)).rejects.toThrow(
      'AES-256-GCM',
    );
  });

  it('uses fixed 64-byte low-S P1363 signatures and rejects tampering', async () => {
    const keys = await generateDeviceKeyPairs(runtime);
    const message = { type: 'vector', protocolVersion: 1, sequence: 7 };
    const signature = await signCanonical(message, keys.signing.privateKey, runtime);
    const signatureBytes = base64UrlToBytes(signature);
    expect(signatureBytes).toHaveLength(64);
    expect(isNormalizedP256Signature(signatureBytes)).toBe(true);
    expect(
      await verifyCanonicalSignature(message, signature, keys.signing.publicKey, runtime),
    ).toBe(true);
    expect(
      await verifyCanonicalSignature(
        { ...message, sequence: 8 },
        signature,
        keys.signing.publicKey,
        runtime,
      ),
    ).toBe(false);
    signatureBytes[0] ^= 1;
    expect(
      await verifyCanonicalSignature(
        message,
        bytesToBase64Url(signatureBytes),
        keys.signing.publicKey,
        runtime,
      ),
    ).toBe(false);
  });

  it('derives identical ECDH wrapping keys on both devices and binds context', async () => {
    const left = await generateEphemeralAgreementKeyPair(runtime);
    const right = await generateEphemeralAgreementKeyPair(runtime);
    const context = { vaultId, pairingRequestId: objectId, keyEpoch: 1 };
    const [leftKey, rightKey] = await Promise.all([
      derivePairingWrappingKey(left.privateKey, right.publicKey, fixed(32, 201), context, runtime),
      derivePairingWrappingKey(right.privateKey, left.publicKey, fixed(32, 201), context, runtime),
    ]);
    const nonce = fixed(12, 9);
    const ciphertext = await encryptAesGcm(
      utf8('synthetic vault key'),
      leftKey,
      nonce,
      context,
      runtime,
    );
    expect(
      bytesToBase64Url(await decryptAesGcm(ciphertext, rightKey, nonce, context, runtime)),
    ).toBe(bytesToBase64Url(utf8('synthetic vault key')));
    const wrongKey = await derivePairingWrappingKey(
      right.privateKey,
      left.publicKey,
      fixed(32, 201),
      { ...context, keyEpoch: 2 },
      runtime,
    );
    await expect(decryptAesGcm(ciphertext, wrongKey, nonce, context, runtime)).rejects.toThrow();

    const [leftAgreement, rightAgreement] = await Promise.all([
      derivePairingAgreementKeys(
        left.privateKey,
        right.publicKey,
        fixed(32, 201),
        context,
        runtime,
      ),
      derivePairingAgreementKeys(
        right.privateKey,
        left.publicKey,
        fixed(32, 201),
        context,
        runtime,
      ),
    ]);
    const confirmation = await createPairingKeyConfirmation(
      context,
      leftAgreement.confirmationKey,
      runtime,
    );
    expect(
      await verifyPairingKeyConfirmation(
        context,
        confirmation,
        rightAgreement.confirmationKey,
        runtime,
      ),
    ).toBe(true);
    expect(
      await verifyPairingKeyConfirmation(
        { ...context, keyEpoch: 2 },
        confirmation,
        rightAgreement.confirmationKey,
        runtime,
      ),
    ).toBe(false);
  });

  it('derives recipient-bound epoch envelope keys on both devices', async () => {
    const sender = await generateDeviceKeyPairs(runtime);
    const recipient = await generateDeviceKeyPairs(runtime);
    const salt = fixed(32, 77);
    const context = {
      vaultId,
      keyEpoch: 2,
      senderDeviceId: createOpaqueId(runtime),
      recipientDeviceId: createOpaqueId(runtime),
      parentManifestHash: bytesToBase64Url(fixed(32, 109)),
    };
    const [senderKey, recipientKey] = await Promise.all([
      deriveDeviceEnvelopeWrappingKey(
        sender.agreement.privateKey,
        recipient.agreement.publicKey,
        salt,
        context,
        runtime,
      ),
      deriveDeviceEnvelopeWrappingKey(
        recipient.agreement.privateKey,
        sender.agreement.publicKey,
        salt,
        context,
        runtime,
      ),
    ]);
    const nonce = fixed(12, 14);
    const ciphertext = await encryptAesGcm(
      utf8('new random VMK'),
      senderKey,
      nonce,
      context,
      runtime,
    );
    expect(
      bytesToBase64Url(await decryptAesGcm(ciphertext, recipientKey, nonce, context, runtime)),
    ).toBe(bytesToBase64Url(utf8('new random VMK')));
    const wrongRecipientKey = await deriveDeviceEnvelopeWrappingKey(
      recipient.agreement.privateKey,
      sender.agreement.publicKey,
      salt,
      { ...context, recipientDeviceId: createOpaqueId(runtime) },
      runtime,
    );
    await expect(
      decryptAesGcm(ciphertext, wrongRecipientKey, nonce, context, runtime),
    ).rejects.toThrow();
  });

  it('derives object-specific keys and authenticates every AAD field', async () => {
    const masterKey = fixed(32, 11);
    const nonce = fixed(12, 99);
    const context = {
      vaultId,
      keyEpoch: 1,
      objectType: 'snapshot',
      objectId,
      purpose: 'snapshot' as const,
    };
    const aad = { ...context, protocolVersion: 1, suite: SYNC_CRYPTO_SUITE };
    const firstKey = await deriveObjectEncryptionKey(masterKey, context, runtime);
    const secondKey = await deriveObjectEncryptionKey(
      masterKey,
      { ...context, objectId: bytesToBase64Url(fixed(16, 34)) },
      runtime,
    );
    const first = await encryptAesGcm(
      utf8('SENTINEL_SYNTHETIC_FINANCE'),
      firstKey,
      nonce,
      aad,
      runtime,
    );
    const second = await encryptAesGcm(
      utf8('SENTINEL_SYNTHETIC_FINANCE'),
      secondKey,
      nonce,
      aad,
      runtime,
    );
    expect(bytesToBase64Url(first)).toBe(
      '9sHRmPnN1Cly-UTEk_Tri8QchBKgpVr-Jkj5UIEpKqFV2kEjv8vTq7b3',
    );
    expect(first).not.toEqual(second);
    expect(bytesToBase64Url(await decryptAesGcm(first, firstKey, nonce, aad, runtime))).toBe(
      bytesToBase64Url(utf8('SENTINEL_SYNTHETIC_FINANCE')),
    );
    await expect(
      decryptAesGcm(first, firstKey, nonce, { ...aad, keyEpoch: 2 }, runtime),
    ).rejects.toThrow();
  });

  it('wraps the vault key locally and rejects envelope/AAD substitution', async () => {
    const masterKey = fixed(32, 17);
    const wrappingKey = await generateLocalWrappingKey(runtime);
    const aad: EncryptedKeyAadV1 = {
      ...recoveryAad(),
      objectType: 'local-vault-key',
      recoveryLookupId: null,
    };
    const envelope = await createEncryptedKeyEnvelope(masterKey, wrappingKey, aad, runtime);
    await expect(openEncryptedKeyEnvelope(envelope, wrappingKey, runtime)).resolves.toEqual(
      masterKey,
    );
    await expect(
      openEncryptedKeyEnvelope(
        { ...envelope, aad: { ...envelope.aad, keyEpoch: 2 } },
        wrappingKey,
        runtime,
      ),
    ).rejects.toThrow();
  });

  it('separates recovery wrapping, server authorization and recovery signing authority', async () => {
    const recoveryRoot = fixed(32, 41);
    const masterKey = fixed(32, 91);
    const recoveryKeys = await deriveRecoveryKeys(
      recoveryRoot,
      { vaultId, recoveryLookupId },
      runtime,
    );
    const recoverySigning = await generateRecoverySigningKeyPair(runtime);
    const recoverySigningPublicKey = await exportPublicEcKey(recoverySigning.publicKey, runtime);
    const privatePkcs8 = await exportRecoverySigningPrivateKey(recoverySigning.privateKey, runtime);
    const owner = await generateDeviceKeyPairs(runtime);
    const pinnedManifest = await createInitialManifest({
      vaultId,
      recoveryLookupId,
      transitionId: bytesToBase64Url(fixed(16, 129)),
      device: {
        deviceId,
        publicKeys: {
          signing: await exportPublicEcKey(owner.signing.publicKey, runtime),
          agreement: await exportPublicEcKey(owner.agreement.publicKey, runtime),
        },
        authorizedAt: '2026-07-31T10:00:00.000Z',
        authorizationExpiresAt: '2026-08-30T10:00:00.000Z',
      },
      recoverySigningPublicKey: recoverySigning.publicKey,
      signingPrivateKey: owner.signing.privateKey,
      createdAt: '2026-07-31T10:00:00.000Z',
      runtime,
    });
    const pinnedManifestHash = await manifestBodyHash(pinnedManifest, runtime);
    const bundle = {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId,
      recoveryLookupId,
      keyEpoch: 1,
      vaultMasterKey: bytesToBase64Url(masterKey),
      recoverySigningPrivateKeyPkcs8: privatePkcs8,
      recoverySigningPublicKey,
      pinnedManifest,
      pinnedManifestHash,
    };
    const recoveryEnvelopeAad = { ...recoveryAad(), parentManifestHash: pinnedManifestHash };
    const envelope = await createEncryptedRecoveryBundleEnvelope(
      bundle,
      recoveryKeys.wrappingKey,
      recoveryEnvelopeAad,
      runtime,
    );
    await expect(
      openEncryptedRecoveryBundleEnvelope(envelope, recoveryKeys.wrappingKey, runtime),
    ).resolves.toEqual(bundle);

    const transcript = { type: 'mirna-recovery-proof-v1', vaultId, challenge: objectId };
    const proof = await createRecoveryProof(transcript, recoveryKeys.gateKey, runtime);
    expect(await verifyRecoveryProof(transcript, proof, recoveryKeys.gateKey, runtime)).toBe(true);
    expect(
      await verifyRecoveryProof(
        { ...transcript, challenge: vaultId },
        proof,
        recoveryKeys.gateKey,
        runtime,
      ),
    ).toBe(false);

    const importedRecoveryPrivate = await importRecoverySigningPrivateKey(privatePkcs8, runtime);
    const recoverySignature = await signCanonical(transcript, importedRecoveryPrivate, runtime);
    expect(
      await verifyCanonicalSignature(
        transcript,
        recoverySignature,
        await importSigningPublicKey(recoverySigningPublicKey, runtime),
        runtime,
      ),
    ).toBe(true);
    clearBytes(recoveryRoot, masterKey, recoveryKeys.gateKey);
  });

  it('encodes the normative typo-resistant recovery lookup code', async () => {
    const root = fixed(32, 55);
    const code = await createRecoveryCode(recoveryLookupId, root, runtime);
    expect(code.startsWith('MR1-')).toBe(true);
    await expect(parseRecoveryCode(code, runtime)).resolves.toEqual({
      recoveryLookupId,
      recoveryRoot: root,
    });
    const replacement = code.endsWith('0') ? '1' : '0';
    await expect(parseRecoveryCode(`${code.slice(0, -1)}${replacement}`, runtime)).rejects.toThrow(
      /kontrolnu sumu|popunjavanje/u,
    );
  });

  it('matches the frozen recovery-code wire fixture', async () => {
    const lookup = hexToBytes('000102030405060708090a0b0c0d0e0f');
    const root = hexToBytes('202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f');
    await expect(createRecoveryCode(bytesToBase64Url(lookup), root, runtime)).resolves.toBe(
      'MR1-000G-40R4-0M30-E209-185G-R38E-1WG2-28H3-4GJJ-C9S8-54N2-PB1D-5RQK-0C9J-6CT3-ADHQ-70WK-MESW-7MZ3-YPBE-NGRG',
    );
  });

  it('keeps the pairing root from the server by deriving separate claim, MAC and SAS keys', async () => {
    const root = fixed(32, 77);
    const salt = fixed(32, 133);
    const pairingRequestId = objectId;
    const code = await createPairingCode(pairingRequestId, root, salt, runtime);
    await expect(parsePairingCode(code, runtime)).resolves.toEqual({
      pairingRequestId,
      pairingSecret: root,
      pairingSalt: salt,
    });
    const secrets = await derivePairingSecrets(
      root,
      {
        pairingRequestId,
        pairingSalt: bytesToBase64Url(salt),
        origin: 'https://mirna.example',
      },
      runtime,
    );
    expect(secrets.claimToken).not.toEqual(secrets.transcriptMacKey);
    expect(secrets.transcriptMacKey).not.toEqual(secrets.sasKey);
    const transcript = { pairingRequestId, vaultId, envelopeHash: manifestHash };
    const mac = await createPairingTranscriptMac(transcript, secrets.transcriptMacKey, runtime);
    expect(
      await verifyPairingTranscriptMac(transcript, mac, secrets.transcriptMacKey, runtime),
    ).toBe(true);
    expect(await deriveShortAuthenticationString(transcript, mac, secrets.sasKey, runtime)).toMatch(
      /^(?:[0-9A-F]{4}-){3}[0-9A-F]{4}$/u,
    );
    expect(await hashPairingClaimToken(secrets.claimToken, runtime)).toHaveLength(43);
  });

  it('puts pairing capability only in an expected-origin URL fragment', async () => {
    const code = await createPairingCode(objectId, fixed(32, 3), fixed(32, 35), runtime);
    const payload = createPairingQrPayload('https://mirna.example', code);
    const url = new URL(payload);
    expect(url.search).toBe('');
    expect(url.hash).toContain('pair=');
    expect(url.hash).toContain('protocol=1');
    expect(parsePairingQrPayload(payload, 'https://mirna.example')).toBe(code);
    expect(() => parsePairingQrPayload(payload, 'https://evil.example')).toThrow();
  });

  it('does not reuse generated opaque IDs in a large sample', () => {
    const ids = Array.from({ length: 2_000 }, () => createOpaqueId(runtime));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => base64UrlToBytes(id).length === 16)).toBe(true);
    expect(randomBytes(SYNC_LIMITS.aesGcmNonceBytes, runtime)).toHaveLength(12);
  });

  it('rejects unknown crypto suites instead of downgrading', () => {
    expect(() => cryptoSuiteSchema.parse('AES-CBC')).toThrow();
  });

  it('produces stable hash/key import vectors across browser-compatible runtimes', async () => {
    expect(bytesToBase64Url(await sha256(utf8('mirna-sync-vector-v1'), runtime))).toBe(
      '7lnegHJnGWWdV5KRSMEJcBsPiRmxQaq6kSY2gnjARuk',
    );
    expect(await hashCanonical({ b: 2, a: 1 }, runtime)).toHaveLength(43);

    const keys = await generateDeviceKeyPairs(runtime);
    const exported = await exportPublicEcKey(keys.agreement.publicKey, runtime);
    const imported = await importAgreementPublicKey(exported, runtime);
    expect(imported.type).toBe('public');
    expect(canonicalBytes(exported).length).toBeGreaterThan(80);
  });
});
