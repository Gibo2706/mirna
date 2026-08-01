import { SELF } from 'cloudflare:test';
import { canonicalizeJson } from '../../../src/domain/sync/canonical';
import {
  SYNC_CRYPTO_SUITE,
  SYNC_DOMAIN_LABELS,
  SYNC_PROTOCOL_VERSION,
} from '../../../src/domain/sync/constants';
import {
  createEncryptedRecoveryBundleEnvelope,
  createOpaqueId,
  deriveRecoveryKeys,
  exportPublicEcKey,
  exportRecoverySigningPrivateKey,
  generateDeviceKeyPairs,
  generateRecoverySigningKeyPair,
  randomBytes,
  sha256,
  signDomainSeparatedCanonical,
} from '../../../src/domain/sync/crypto';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  concatBytes,
  utf8,
} from '../../../src/domain/sync/encoding';
import { createInitialManifest, manifestBodyHash } from '../../../src/domain/sync/manifest';
import {
  authChallengeSchema,
  authSessionResponseSchema,
  recoveryRecordSchema,
  vaultCreateResponseSchema,
  type AuthChallengeV1,
  type DevicePublicKeysV1,
  type RecoveryRecordV1,
  type VaultManifestV1,
} from '../../../src/domain/sync/schemas';

export const TEST_ORIGIN = 'http://localhost:5173';

export interface InitialVaultFixture {
  vaultId: string;
  deviceId: string;
  deviceKeys: Awaited<ReturnType<typeof generateDeviceKeyPairs>>;
  devicePublicKeys: DevicePublicKeysV1;
  recoveryLookupId: string;
  recoveryRoot: Uint8Array;
  recoveryGateKey: Uint8Array;
  recoverySigningKeys: CryptoKeyPair;
  vaultMasterKey: Uint8Array;
  manifest: VaultManifestV1;
  recovery: RecoveryRecordV1;
}

export const canonicalRequest = (
  path: string,
  body: unknown,
  options: { accessToken?: string; origin?: string } = {},
): Request => {
  const origin = options.origin ?? TEST_ORIGIN;
  const headers = new Headers({
    'Content-Type': 'application/json',
    Origin: origin,
    'X-Mirna-Protocol-Version': String(SYNC_PROTOCOL_VERSION),
  });
  if (options.accessToken) headers.set('Authorization', `Bearer ${options.accessToken}`);
  return new Request(`https://sync.invalid${path}`, {
    method: 'POST',
    headers,
    body: canonicalizeJson(body),
  });
};

export const postCanonical = (
  path: string,
  body: unknown,
  options?: { accessToken?: string; origin?: string },
): Promise<Response> => SELF.fetch(canonicalRequest(path, body, options));

const recoveryGateHash = async (gateKey: Uint8Array): Promise<string> =>
  bytesToBase64Url(
    await sha256(concatBytes(utf8(SYNC_DOMAIN_LABELS.recoveryGateHash), Uint8Array.of(0), gateKey)),
  );

export const createInitialVaultFixture = async (
  options: { now?: number } = {},
): Promise<InitialVaultFixture> => {
  const now = options.now ?? Date.now();
  const vaultId = createOpaqueId();
  const deviceId = createOpaqueId();
  const recoveryLookupId = createOpaqueId();
  const deviceKeys = await generateDeviceKeyPairs();
  const recoverySigningKeys = await generateRecoverySigningKeyPair();
  const devicePublicKeys = {
    signing: await exportPublicEcKey(deviceKeys.signing.publicKey),
    agreement: await exportPublicEcKey(deviceKeys.agreement.publicKey),
  };
  const recoverySigningPublicKey = await exportPublicEcKey(recoverySigningKeys.publicKey);
  const createdAt = new Date(now - 1_000).toISOString();
  const manifest = await createInitialManifest({
    vaultId,
    recoveryLookupId,
    transitionId: createOpaqueId(),
    device: {
      deviceId,
      publicKeys: devicePublicKeys,
      authorizedAt: createdAt,
      authorizationExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    },
    recoverySigningPublicKey: recoverySigningKeys.publicKey,
    signingPrivateKey: deviceKeys.signing.privateKey,
    createdAt,
  });
  const manifestHash = await manifestBodyHash(manifest);
  const recoveryRoot = new Uint8Array(32).fill(0x52);
  // A recognizable synthetic value makes accidental plaintext persistence observable.
  const vaultMasterKey = utf8('SALARY-123456-RSD-PRIVATE-DATA!!');
  const recoveryKeys = await deriveRecoveryKeys(recoveryRoot, { vaultId, recoveryLookupId });
  const recoveryEnvelope = await createEncryptedRecoveryBundleEnvelope(
    {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId,
      recoveryLookupId,
      keyEpoch: 1,
      vaultMasterKey: bytesToBase64Url(vaultMasterKey),
      recoverySigningPrivateKeyPkcs8: await exportRecoverySigningPrivateKey(
        recoverySigningKeys.privateKey,
      ),
      recoverySigningPublicKey,
      pinnedManifest: manifest,
      pinnedManifestHash: manifestHash,
    },
    recoveryKeys.wrappingKey,
    {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId,
      keyEpoch: 1,
      objectType: 'recovery-vault-key',
      objectId: createOpaqueId(),
      creatingDeviceId: deviceId,
      recoveryLookupId,
      parentManifestHash: manifestHash,
    },
  );
  const recovery = recoveryRecordSchema.parse({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    vaultId,
    recoveryLookupId,
    keyEpoch: 1,
    recoveryEnvelope,
    recoverySigningPublicKey,
    recoveryGateKeyHash: await recoveryGateHash(recoveryKeys.gateKey),
    manifestVersion: 1,
    manifestHash,
    updatedAt: createdAt,
  });
  return {
    vaultId,
    deviceId,
    deviceKeys,
    devicePublicKeys,
    recoveryLookupId,
    recoveryRoot,
    recoveryGateKey: recoveryKeys.gateKey,
    recoverySigningKeys,
    vaultMasterKey,
    manifest,
    recovery,
  };
};

export const registerInitialVault = async (fixture: InitialVaultFixture): Promise<Response> => {
  const request = canonicalRequest('/v1/vaults', {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    manifest: fixture.manifest,
    recovery: fixture.recovery,
  });
  request.headers.set('Idempotency-Key', fixture.manifest.transition.transitionId);
  return SELF.fetch(request);
};

export const parseVaultCreateResponse = async (response: Response) =>
  vaultCreateResponseSchema.parse(await response.json());

export const issueChallenge = async (
  fixture: InitialVaultFixture,
  audience: AuthChallengeV1['audience'] = '/v1/auth/session',
): Promise<AuthChallengeV1> => {
  const response = await postCanonical('/v1/auth/challenge', {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    vaultId: fixture.vaultId,
    deviceId: fixture.deviceId,
    audience,
    origin: TEST_ORIGIN,
  });
  if (response.status !== 201) {
    throw new Error(`Challenge fixture failed with HTTP ${response.status}.`);
  }
  return authChallengeSchema.parse(await response.json());
};

export const signChallenge = (
  fixture: InitialVaultFixture,
  challenge: AuthChallengeV1,
): Promise<string> =>
  signDomainSeparatedCanonical(
    SYNC_DOMAIN_LABELS.authChallenge,
    challenge,
    fixture.deviceKeys.signing.privateKey,
  );

export const createAccessSession = async (
  fixture: InitialVaultFixture,
): Promise<{ accessToken: string; challenge: AuthChallengeV1 }> => {
  const challenge = await issueChallenge(fixture);
  const response = await postCanonical('/v1/auth/session', {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    challenge,
    signature: await signChallenge(fixture, challenge),
  });
  if (response.status !== 201) {
    throw new Error(`Session fixture failed with HTTP ${response.status}.`);
  }
  const session = authSessionResponseSchema.parse(await response.json());
  return { accessToken: session.accessToken, challenge };
};

export const tamperEncoded = (value: string): string => {
  const decoded = base64UrlToBytes(value);
  decoded[0] = (decoded[0] ?? 0) ^ 1;
  return bytesToBase64Url(decoded);
};

export const randomEncoded = (length = 32): string => bytesToBase64Url(randomBytes(length));
