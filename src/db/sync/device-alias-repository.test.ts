import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { FinanceDatabase, financeTables } from '../database';
import { SyncDeviceAliasRepository } from './device-alias-repository';

const databaseNames: string[] = [];

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)));
});

describe('local sync device aliases', () => {
  it('persists friendly names locally without adding them to finance data stores', async () => {
    const name = `mirna-device-alias-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const database = new FinanceDatabase(name);
    const repository = new SyncDeviceAliasRepository(database);
    const vaultId = 'VVVVVVVVVVVVVVVVVVVVVV';
    const deviceId = 'DDDDDDDDDDDDDDDDDDDDDD';

    await repository.save({ vaultId, deviceId, label: '  Moj laptop  ', kind: 'computer' });
    database.close();

    const reopened = new FinanceDatabase(name);
    expect(await new SyncDeviceAliasRepository(reopened).list(vaultId)).toMatchObject([
      { vaultId, deviceId, label: 'Moj laptop', kind: 'computer' },
    ]);
    expect(financeTables(reopened).map((table) => table.name)).not.toContain('syncDeviceAliases');
    reopened.close();
  });

  it('uses one stable alias record per vault and device', async () => {
    const name = `mirna-device-alias-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const database = new FinanceDatabase(name);
    const repository = new SyncDeviceAliasRepository(database);
    const vaultId = 'VVVVVVVVVVVVVVVVVVVVVV';
    const deviceId = 'DDDDDDDDDDDDDDDDDDDDDD';

    await repository.save({ vaultId, deviceId, label: 'Telefon', kind: 'phone' });
    await repository.save({ vaultId, deviceId, label: 'Stari telefon', kind: 'phone' });

    expect(await repository.list(vaultId)).toMatchObject([
      { label: 'Stari telefon', kind: 'phone' },
    ]);
    database.close();
  });
});
