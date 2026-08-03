import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import type { Account } from '@/domain/types';
import { FinanceDatabase } from '../database';
import {
  ACTIVE_SYNC_VAULT_RECORD_ID,
  LOCAL_SYNC_DEVICE_RECORD_ID,
  SYNC_METADATA_RECORD_ID,
  type SyncDeviceRecord,
  type SyncMetadataRecord,
  type SyncVaultRecord,
} from './records';
import { auditedFinanceTransaction, parseSyncMutationIntent } from './mutation-audit';

const databaseNames: string[] = [];
const vaultId = 'V'.repeat(22);
const deviceId = 'D'.repeat(22);
const timestamp = '2026-07-31T10:00:00.000Z';

const account = (name: string): Account => ({
  id: 'account-1',
  name,
  kind: 'checking',
  openingBalance: 10_000,
  protected: false,
  color: '#123456',
  archived: false,
  createdAt: timestamp,
});

const createDatabase = (): FinanceDatabase => {
  const name = `mirna-sync-audit-${crypto.randomUUID()}`;
  databaseNames.push(name);
  return new FinanceDatabase(name);
};

const enableMinimalSyncContext = async (database: FinanceDatabase): Promise<void> => {
  await database.syncVault.put({
    id: ACTIVE_SYNC_VAULT_RECORD_ID,
    vaultId,
    status: 'active',
    keyEpoch: 1,
  } as SyncVaultRecord);
  await database.syncDevice.put({
    id: LOCAL_SYNC_DEVICE_RECORD_ID,
    vaultId,
    deviceId,
  } as SyncDeviceRecord);
  await database.syncMetadata.put({
    id: SYNC_METADATA_RECORD_ID,
    vaultId,
    bootstrapMode: 'complete',
    firstUploadConsent: 'accepted',
  } as SyncMetadataRecord);
};

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)));
});

describe('atomic financial mutation audit', () => {
  it('does not create sync metadata when sync was never enabled', async () => {
    const database = createDatabase();
    const value = account('Lokalni račun');
    await auditedFinanceTransaction(
      [database.accounts],
      async (audit) => {
        await database.accounts.put(value);
        await audit.upsert('account', null, value);
      },
      database,
    );

    expect(await database.accounts.get(value.id)).toEqual(value);
    expect(await database.syncOutbox.count()).toBe(0);
    database.close();
  });

  it('writes the exact local mutation and canonical intent in one transaction', async () => {
    const database = createDatabase();
    await enableMinimalSyncContext(database);
    const value = account('Sinhronizovani račun');
    await auditedFinanceTransaction(
      [database.accounts],
      async (audit) => {
        await database.accounts.put(value);
        await audit.upsert('account', null, value);
      },
      database,
      () => new Date(timestamp),
    );

    expect(await database.accounts.get(value.id)).toEqual(value);
    const outbox = await database.syncOutbox.toArray();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      vaultId,
      deviceId,
      deviceSequence: 0,
      state: 'intent',
      entityType: 'account',
      entityId: value.id,
      command: 'account.upsert',
    });
    const intent = parseSyncMutationIntent(outbox[0].canonicalPayload);
    expect(intent.mutationGroupId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(intent).toEqual({
      type: 'mirna-sync-mutation-intent-v1',
      mutationGroupId: intent.mutationGroupId,
      mutationGroupIndex: 0,
      mutationGroupSize: 1,
      entityType: 'account',
      entityId: value.id,
      commandType: 'account.upsert',
      previousValue: null,
      value,
    });
    database.close();
  });

  it('rolls back the financial write when the outbox write fails', async () => {
    const database = createDatabase();
    await enableMinimalSyncContext(database);
    database.syncOutbox.hook('creating', () => {
      throw new Error('synthetic outbox failure');
    });
    const value = account('Ne sme ostati');

    await expect(
      auditedFinanceTransaction(
        [database.accounts],
        async (audit) => {
          await database.accounts.put(value);
          await audit.upsert('account', null, value);
        },
        database,
      ),
    ).rejects.toThrow('synthetic outbox failure');
    expect(await database.accounts.get(value.id)).toBeUndefined();
    expect(await database.syncOutbox.count()).toBe(0);
    database.close();
  });
});
