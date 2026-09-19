/** Entirely synthetic keys, vaults and signed histories. */
import { describe, expect, it } from 'vitest';
import {
  createOpaqueId,
  exportPublicEcKey,
  generateDeviceKeyPairs,
  generateRecoverySigningKeyPair,
  importSigningPublicKey,
  randomBytes,
} from '@/domain/sync/crypto';
import { createInitialManifest, manifestBodyHash, signVaultManifest } from '@/domain/sync/manifest';
import { createEncryptedSnapshot, openEncryptedSnapshot } from '@/domain/sync/snapshot';
import type { VaultManifestV1 } from '@/domain/sync/schemas';
import { emptyFinanceData } from '@/tests/factories';
import { collectVerifiedManifestChain, resolveSnapshotParentManifest } from './manifest-chain';

const recoveryFixture = async () => {
  const owner = await generateDeviceKeyPairs();
  const successor = await generateDeviceKeyPairs();
  const recovery = await generateRecoverySigningKeyPair();
  const rotatedRecovery = await generateRecoverySigningKeyPair();
  const device = async (keys: typeof owner) => ({
    deviceId: createOpaqueId(),
    publicKeys: {
      signing: await exportPublicEcKey(keys.signing.publicKey),
      agreement: await exportPublicEcKey(keys.agreement.publicKey),
    },
    authorizedAt: '2026-07-01T00:00:00.000Z',
    authorizationExpiresAt: '2026-07-30T00:00:00.000Z',
  });
  const first = await device(owner);
  const second = await device(successor);
  const genesis = await createInitialManifest({
    vaultId: createOpaqueId(),
    recoveryLookupId: createOpaqueId(),
    transitionId: createOpaqueId(),
    device: first,
    recoverySigningPublicKey: recovery.publicKey,
    signingPrivateKey: owner.signing.privateKey,
    createdAt: first.authorizedAt,
  });
  const { signature: _signature, ...body } = genesis;
  void _signature;
  const nextBody = {
    ...body,
    manifestVersion: 2,
    keyEpoch: 2,
    devices: [second],
    revokedDevices: [
      {
        deviceId: first.deviceId,
        publicKeys: first.publicKeys,
        revocationAuthority: 'recovery' as const,
        revokedByDeviceId: null,
        revokedAt: '2026-07-02T00:00:00.000Z',
        lastAuthorizedManifestVersion: 1,
      },
    ],
    previousManifestHash: await manifestBodyHash(genesis),
    recoveryLookupId: createOpaqueId(),
    recoverySigningPublicKey: await exportPublicEcKey(rotatedRecovery.publicKey),
    transition: {
      transitionId: createOpaqueId(),
      kind: 'recover-device' as const,
      authorizationKind: 'recovery' as const,
      authorizingDeviceId: null,
      affectedDeviceId: second.deviceId,
      occurredAt: '2026-07-02T00:00:00.000Z',
    },
  };
  const current = await signVaultManifest(nextBody, recovery.privateKey);
  return { genesis, current, nextBody, owner, recovery, rotatedRecovery };
};

const page = (manifests: VaultManifestV1[], nextAfterManifestVersion: number | null = null) => ({
  protocolVersion: 1,
  manifests,
  nextAfterManifestVersion,
});

describe('shared verified manifest chain', () => {
  it('verifies recovery through the previous recovery authority, not the new standalone key', async () => {
    const f = await recoveryFixture();
    const input = {
      getManifestChanges: async () => page([f.genesis, f.current]),
      expected: f.current,
      expectedHash: await manifestBodyHash(f.current),
    };
    await expect(collectVerifiedManifestChain(input)).resolves.toEqual([f.genesis, f.current]);
    const forged = await signVaultManifest(f.nextBody, f.rotatedRecovery.privateKey);
    await expect(
      collectVerifiedManifestChain({
        ...input,
        expected: forged,
        getManifestChanges: async () => page([f.genesis, forged]),
      }),
    ).rejects.toThrow(/Potpis/);
  });

  it('resolves the historical active creator after recovery revocation without granting an epoch downgrade', async () => {
    const f = await recoveryFixture();
    const parent = await resolveSnapshotParentManifest({
      getManifestChanges: async () => page([f.genesis, f.current]),
      trusted: f.current,
      trustedHash: await manifestBodyHash(f.current),
      parentHash: await manifestBodyHash(f.genesis),
    });
    const creator = parent.devices[0];
    expect(f.current.devices.some((device) => device.deviceId === creator.deviceId)).toBe(false);
    const key = randomBytes(32);
    const artifact = await createEncryptedSnapshot({
      data: emptyFinanceData(),
      vaultId: parent.vaultId,
      revision: 1,
      baseRevision: 0,
      keyEpoch: 1,
      creatingDeviceId: creator.deviceId,
      createdAt: '2026-07-01T01:00:00.000Z',
      parentManifestHash: await manifestBodyHash(parent),
      previousSnapshotHash: null,
      causalFrontier: { serverCursor: 0, devices: [] },
      vaultMasterKey: key,
      signingPrivateKey: f.owner.signing.privateKey,
      compression: 'none',
    });
    const input = {
      ...artifact,
      vaultMasterKey: key,
      signingPublicKey: await importSigningPublicKey(creator.publicKeys.signing),
      expected: {
        vaultId: parent.vaultId,
        keyEpoch: 1,
        currentRevision: 0,
        currentSnapshotHash: null,
        parentManifestHash: await manifestBodyHash(parent),
        creatingDeviceId: creator.deviceId,
      },
    };
    await expect(openEncryptedSnapshot(input)).resolves.toMatchObject({ revision: 1 });
    await expect(
      openEncryptedSnapshot({ ...input, expected: { ...input.expected, keyEpoch: 2 } }),
    ).rejects.toThrow();
  });

  it.each([
    'genesis-signature',
    'genesis-shape',
    'endpoint',
    'duplicate',
    'cursor',
    'empty',
    'truncated',
  ] as const)('rejects invalid %s history', async (attack) => {
    const f = await recoveryFixture();
    let manifests = structuredClone([f.genesis, f.current]);
    let cursor: number | null = null;
    if (attack === 'genesis-signature') manifests[0].signature = f.current.signature;
    if (attack === 'genesis-shape') manifests[0].transition.kind = 'renew-device';
    if (attack === 'endpoint') {
      manifests[1] = await signVaultManifest(
        { ...f.nextBody, transition: { ...f.nextBody.transition, transitionId: createOpaqueId() } },
        f.recovery.privateKey,
      );
    }
    if (attack === 'duplicate') manifests = [f.genesis, f.genesis, f.current];
    if (attack === 'cursor') cursor = 1;
    if (attack === 'empty') manifests = [];
    if (attack === 'truncated') manifests = [f.genesis];
    await expect(
      collectVerifiedManifestChain({
        getManifestChanges: async () => page(manifests, cursor),
        expected: f.current,
        expectedHash: await manifestBodyHash(f.current),
      }),
    ).rejects.toThrow();
  });
});

it('requires the exact advertised endpoint for forward traversal but can resolve an older local history anchor', async () => {
  const f = await recoveryFixture();
  const getManifestChanges = async () => page([f.genesis, f.current]);
  await expect(
    collectVerifiedManifestChain({
      getManifestChanges,
      expected: f.genesis,
      expectedHash: await manifestBodyHash(f.genesis),
    }),
  ).rejects.toMatchObject({ code: 'manifest-fork' });
  await expect(
    resolveSnapshotParentManifest({
      getManifestChanges,
      trusted: f.genesis,
      trustedHash: await manifestBodyHash(f.genesis),
      parentHash: await manifestBodyHash(f.genesis),
    }),
  ).resolves.toEqual(f.genesis);
});
