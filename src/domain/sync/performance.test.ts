/** Synthetic protocol-v1 performance characterization; never uses production data or keys. */
import { describe, expect, it } from 'vitest';
import { canonicalBytes } from './canonical';
import {
  createOpaqueId,
  derivePairingAgreementKeys,
  generateDeviceKeyPairs,
  randomBytes,
} from './crypto';
import { bytesToBase64Url, clearBytes } from './encoding';
import {
  createEncryptedSnapshot,
  createSyncSnapshot,
  type CreateSyncSnapshotInput,
} from './snapshot';
import { emptyFinanceData, tx } from '@/tests/factories';
import type { FinanceData } from '@/domain/types';

const syntheticData = (transactionCount: number): FinanceData => {
  const data = emptyFinanceData();
  data.transactions = Array.from({ length: transactionCount }, (_value, index) =>
    tx({
      id: `sync-perf-${index}`,
      type: 'expense',
      amount: 100 + (index % 20),
      accountId: 'checking',
      categoryId: 'expense',
      date: `2032-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(
        2,
        '0',
      )}`,
      description: `Sintetička performance transakcija ${index}`,
      notes: `Neosetljiva test beleška ${index % 10}`,
      createdAt: new Date(Date.UTC(2032, index % 12, (index % 28) + 1, 12)).toISOString(),
    }),
  );
  return data;
};

describe('sync performance characterization', () => {
  it('measures typical and 10,000-transaction snapshots, key generation and pairing crypto', async () => {
    const keyGenerationStarted = performance.now();
    const [leftKeys, rightKeys] = await Promise.all([
      generateDeviceKeyPairs(),
      generateDeviceKeyPairs(),
    ]);
    const mobileKeyGenerationMs = performance.now() - keyGenerationStarted;
    const vaultId = createOpaqueId();
    const deviceId = createOpaqueId();
    const pairingRequestId = createOpaqueId();
    const pairingSalt = randomBytes(32);
    const pairingStarted = performance.now();
    const [leftAgreement, rightAgreement] = await Promise.all([
      derivePairingAgreementKeys(
        leftKeys.agreement.privateKey,
        rightKeys.agreement.publicKey,
        pairingSalt,
        { vaultId, pairingRequestId, keyEpoch: 1 },
      ),
      derivePairingAgreementKeys(
        rightKeys.agreement.privateKey,
        leftKeys.agreement.publicKey,
        pairingSalt,
        { vaultId, pairingRequestId, keyEpoch: 1 },
      ),
    ]);
    const pairingCryptoMs = performance.now() - pairingStarted;
    expect(leftAgreement.wrappingKey.extractable).toBe(false);
    expect(rightAgreement.wrappingKey.extractable).toBe(false);
    expect(leftAgreement.confirmationKey.extractable).toBe(false);
    expect(rightAgreement.confirmationKey.extractable).toBe(false);

    const measureSnapshot = async (label: string, data: FinanceData) => {
      const vaultMasterKey = randomBytes(32);
      const input: CreateSyncSnapshotInput = {
        data,
        vaultId,
        snapshotId: createOpaqueId(),
        revision: 1,
        baseRevision: 0,
        keyEpoch: 1,
        creatingDeviceId: deviceId,
        createdAt: '2032-07-31T12:00:00.000Z',
        parentManifestHash: bytesToBase64Url(randomBytes(32)),
        previousSnapshotHash: null,
        causalFrontier: { serverCursor: 0, devices: [] },
      };
      const plaintextStarted = performance.now();
      const snapshot = await createSyncSnapshot(input);
      const plaintextBytes = canonicalBytes(snapshot).byteLength;
      const snapshotAssemblyMs = performance.now() - plaintextStarted;
      const cryptoStarted = performance.now();
      const artifact = await createEncryptedSnapshot({
        ...input,
        vaultMasterKey,
        signingPrivateKey: leftKeys.signing.privateKey,
        compression: 'gzip',
      });
      const cryptoCompressionMs = performance.now() - cryptoStarted;
      const measurement = {
        label,
        transactions: data.transactions.length,
        plaintextBytes,
        encryptedBytes: artifact.ciphertext.byteLength,
        compression: artifact.envelope.compression,
        snapshotAssemblyMs: Math.round(snapshotAssemblyMs * 100) / 100,
        cryptoCompressionMs: Math.round(cryptoCompressionMs * 100) / 100,
      };
      expect(measurement.encryptedBytes).toBeLessThanOrEqual(8 * 1_024 * 1_024);
      clearBytes(vaultMasterKey, artifact.ciphertext);
      return measurement;
    };

    const metrics = {
      environment: 'Node 22 Web Crypto characterization; browser E2E timings are separate',
      mobileKeyGenerationMs: Math.round(mobileKeyGenerationMs * 100) / 100,
      pairingCryptoMs: Math.round(pairingCryptoMs * 100) / 100,
      snapshots: [
        await measureSnapshot('typical', syntheticData(250)),
        await measureSnapshot('large', syntheticData(10_000)),
      ],
    };
    expect(metrics.snapshots[1].transactions).toBe(10_000);
    console.info(JSON.stringify({ syncPerformance: metrics }));
    clearBytes(pairingSalt);
  }, 60_000);
});
