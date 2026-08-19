/** Synthetic manifest fixtures. No production or user key material. */
import { describe, expect, it } from 'vitest';
import {
  exportPublicEcKey,
  generateDeviceKeyPairs,
  generateRecoverySigningKeyPair,
  type CryptoRuntime,
} from './crypto';
import { bytesToBase64Url } from './encoding';
import {
  assertManifestAgainstPin,
  assertManifestIsExactlyNextAfterPin,
  createInitialManifest,
  manifestBodyHash,
  signVaultManifest,
  validateManifestTransition,
  verifyInitialManifest,
} from './manifest';
import type { ManifestDeviceV1, UnsignedVaultManifestV1 } from './schemas';

const runtime = globalThis.crypto as CryptoRuntime;
const id = (start: number): string =>
  bytesToBase64Url(Uint8Array.from({ length: 16 }, (_value, index) => start + index));

const deviceRecord = async (
  deviceId: string,
  keys: Awaited<ReturnType<typeof generateDeviceKeyPairs>>,
  authorizedAt = '2026-07-31T10:00:00.000Z',
): Promise<ManifestDeviceV1> => ({
  deviceId,
  publicKeys: {
    signing: await exportPublicEcKey(keys.signing.publicKey, runtime),
    agreement: await exportPublicEcKey(keys.agreement.publicKey, runtime),
  },
  authorizedAt,
  authorizationExpiresAt: '2026-08-30T10:00:00.000Z',
});

describe('signed VaultManifestV1 chain', () => {
  it('verifies genesis and an authorized device-add transition', async () => {
    const owner = await generateDeviceKeyPairs(runtime);
    const newcomer = await generateDeviceKeyPairs(runtime);
    const recovery = await generateRecoverySigningKeyPair(runtime);
    const ownerDevice = await deviceRecord(id(1), owner);
    const newcomerDevice = await deviceRecord(id(33), newcomer);
    const initial = await createInitialManifest({
      vaultId: id(65),
      recoveryLookupId: id(81),
      transitionId: id(82),
      device: ownerDevice,
      recoverySigningPublicKey: recovery.publicKey,
      signingPrivateKey: owner.signing.privateKey,
      createdAt: '2026-07-31T10:00:00.000Z',
      runtime,
    });
    await expect(verifyInitialManifest(initial, runtime)).resolves.toBeUndefined();

    const unsigned: UnsignedVaultManifestV1 = {
      type: initial.type,
      protocolVersion: initial.protocolVersion,
      suite: initial.suite,
      vaultId: initial.vaultId,
      manifestVersion: 2,
      keyEpoch: 1,
      devices: [ownerDevice, newcomerDevice].sort((left, right) =>
        left.deviceId.localeCompare(right.deviceId),
      ),
      revokedDevices: [],
      recoveryLookupId: initial.recoveryLookupId,
      recoverySigningPublicKey: initial.recoverySigningPublicKey,
      previousManifestHash: await manifestBodyHash(initial, runtime),
      transition: {
        transitionId: id(83),
        kind: 'add-device',
        authorizationKind: 'device',
        authorizingDeviceId: ownerDevice.deviceId,
        affectedDeviceId: newcomerDevice.deviceId,
        occurredAt: '2026-07-31T10:05:00.000Z',
      },
    };
    const next = await signVaultManifest(unsigned, owner.signing.privateKey, runtime);
    await expect(validateManifestTransition(initial, next, runtime)).resolves.toBeUndefined();

    const pin = { manifestVersion: 1, manifestHash: await manifestBodyHash(initial, runtime) };
    expect(() => assertManifestIsExactlyNextAfterPin(next, pin)).not.toThrow();
    await expect(assertManifestAgainstPin(next, pin, runtime)).rejects.toThrow(/tačno zakačenu/u);
    expect(() => assertManifestIsExactlyNextAfterPin({ ...next, manifestVersion: 3 }, pin)).toThrow(
      /tačno sledeća/u,
    );
  });

  it('uses the pinned recovery signing key for a recovery device transition', async () => {
    const owner = await generateDeviceKeyPairs(runtime);
    const recovered = await generateDeviceKeyPairs(runtime);
    const recovery = await generateRecoverySigningKeyPair(runtime);
    const rotatedRecovery = await generateRecoverySigningKeyPair(runtime);
    const ownerDevice = await deviceRecord(id(2), owner);
    const recoveredDevice = await deviceRecord(id(70), recovered);
    const initial = await createInitialManifest({
      vaultId: id(100),
      recoveryLookupId: id(116),
      transitionId: id(117),
      device: ownerDevice,
      recoverySigningPublicKey: recovery.publicKey,
      signingPrivateKey: owner.signing.privateKey,
      createdAt: '2026-07-31T10:00:00.000Z',
      runtime,
    });
    const { signature: _initialSignature, ...initialUnsigned } = initial;
    void _initialSignature;
    const recoveredUnsigned: UnsignedVaultManifestV1 = {
      ...initialUnsigned,
      manifestVersion: 2,
      keyEpoch: 2,
      devices: [recoveredDevice],
      revokedDevices: [
        {
          deviceId: ownerDevice.deviceId,
          publicKeys: ownerDevice.publicKeys,
          revocationAuthority: 'recovery',
          revokedByDeviceId: null,
          revokedAt: '2026-07-31T10:10:00.000Z',
          lastAuthorizedManifestVersion: 1,
        },
      ],
      recoveryLookupId: id(119),
      recoverySigningPublicKey: await exportPublicEcKey(rotatedRecovery.publicKey, runtime),
      previousManifestHash: await manifestBodyHash(initial, runtime),
      transition: {
        transitionId: id(118),
        kind: 'recover-device',
        authorizationKind: 'recovery',
        authorizingDeviceId: null,
        affectedDeviceId: recoveredDevice.deviceId,
        occurredAt: '2026-07-31T10:10:00.000Z',
      },
    };
    const recoveredManifest = await signVaultManifest(
      recoveredUnsigned,
      recovery.privateKey,
      runtime,
    );
    await expect(
      validateManifestTransition(initial, recoveredManifest, runtime),
    ).resolves.toBeUndefined();
  });

  it('rejects a tampered transition and detects rollback or same-version fork', async () => {
    const owner = await generateDeviceKeyPairs(runtime);
    const recovery = await generateRecoverySigningKeyPair(runtime);
    const ownerDevice = await deviceRecord(id(3), owner);
    const initial = await createInitialManifest({
      vaultId: id(90),
      recoveryLookupId: id(106),
      transitionId: id(107),
      device: ownerDevice,
      recoverySigningPublicKey: recovery.publicKey,
      signingPrivateKey: owner.signing.privateKey,
      createdAt: '2026-07-31T10:00:00.000Z',
      runtime,
    });
    const pin = { manifestVersion: 1, manifestHash: await manifestBodyHash(initial, runtime) };
    await expect(assertManifestAgainstPin(initial, pin, runtime)).resolves.toBeUndefined();
    await expect(
      assertManifestAgainstPin(
        {
          ...initial,
          transition: { ...initial.transition, occurredAt: '2026-07-31T10:01:00.000Z' },
        },
        pin,
        runtime,
      ),
    ).rejects.toThrow(/fork/u);
    await expect(verifyInitialManifest({ ...initial, keyEpoch: 2 }, runtime)).rejects.toThrow();
  });

  it('rejects a device authorization grant longer than the protocol maximum', async () => {
    const owner = await generateDeviceKeyPairs(runtime);
    const recovery = await generateRecoverySigningKeyPair(runtime);
    const ownerDevice = await deviceRecord(id(120), owner);
    ownerDevice.authorizationExpiresAt = '2026-08-30T10:00:00.001Z';

    await expect(
      createInitialManifest({
        vaultId: id(140),
        recoveryLookupId: id(156),
        transitionId: id(157),
        device: ownerDevice,
        recoverySigningPublicKey: recovery.publicKey,
        signingPrivateKey: owner.signing.privateKey,
        createdAt: '2026-07-31T10:00:00.000Z',
        runtime,
      }),
    ).rejects.toThrow('najviše 30 dana');
  });

  it('requires a device revocation timestamp to equal the transition timestamp', async () => {
    const owner = await generateDeviceKeyPairs(runtime);
    const recovery = await generateRecoverySigningKeyPair(runtime);
    const ownerDevice = await deviceRecord(id(160), owner);
    const initial = await createInitialManifest({
      vaultId: id(176),
      recoveryLookupId: id(192),
      transitionId: id(193),
      device: ownerDevice,
      recoverySigningPublicKey: recovery.publicKey,
      signingPrivateKey: owner.signing.privateKey,
      createdAt: '2026-07-31T10:00:00.000Z',
      runtime,
    });
    const { signature: _signature, ...initialUnsigned } = initial;
    void _signature;
    const transitionTime = '2026-07-31T10:10:00.000Z';
    const invalidRevocation = await signVaultManifest(
      {
        ...initialUnsigned,
        manifestVersion: 2,
        keyEpoch: 2,
        devices: [],
        revokedDevices: [
          {
            deviceId: ownerDevice.deviceId,
            publicKeys: ownerDevice.publicKeys,
            revokedAt: '2026-07-31T10:09:59.999Z',
            revocationAuthority: 'device',
            revokedByDeviceId: ownerDevice.deviceId,
            lastAuthorizedManifestVersion: 1,
          },
        ],
        previousManifestHash: await manifestBodyHash(initial, runtime),
        transition: {
          transitionId: id(194),
          kind: 'revoke-device',
          authorizationKind: 'device',
          authorizingDeviceId: ownerDevice.deviceId,
          affectedDeviceId: ownerDevice.deviceId,
          occurredAt: transitionTime,
        },
      },
      owner.signing.privateKey,
      runtime,
    );

    await expect(validateManifestTransition(initial, invalidRevocation, runtime)).rejects.toThrow(
      /Opoziv uređaja/u,
    );
  });
});
