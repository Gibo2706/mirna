import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { financeTables, FinanceDatabase } from '../database';

const databaseNames: string[] = [];

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)));
});

describe('Dexie v14 sync schema', () => {
  it('adds dedicated sync stores while ordinary finance tables stay unchanged', async () => {
    const name = `mirna-v12-schema-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const database = new FinanceDatabase(name);
    await database.open();

    expect(database.tables.map((table) => table.name).sort()).toEqual(
      [
        'accounts',
        'categories',
        'commitments',
        'debtPayments',
        'debts',
        'goals',
        'plannedEvents',
        'plannedIncomes',
        'presets',
        'salaryScenarios',
        'settings',
        'syncBetaDiagnosticEvents',
        'syncBetaSupport',
        'syncConflicts',
        'syncCheckpoints',
        'syncDevice',
        'syncDeviceAliases',
        'syncEntityStates',
        'syncFrontier',
        'syncInbox',
        'syncKeys',
        'syncMetadata',
        'syncOutbox',
        'syncPairingFinalizations',
        'syncVault',
        'transactions',
        'variableBudgets',
      ].sort(),
    );
    expect(financeTables().map((table) => table.name)).toEqual([
      'transactions',
      'debtPayments',
      'accounts',
      'categories',
      'plannedIncomes',
      'commitments',
      'variableBudgets',
      'goals',
      'debts',
      'plannedEvents',
      'presets',
      'salaryScenarios',
      'settings',
    ]);
    expect(financeTables().every((table) => !table.name.startsWith('sync'))).toBe(true);

    database.close();
  });

  it('adds the alias store without clearing existing v13 sync records', async () => {
    const name = `mirna-v13-upgrade-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const legacy = new Dexie(name);
    legacy.version(13).stores({
      syncVault: 'id, &vaultId, status, keyEpoch',
      syncDevice: 'id, vaultId, &deviceId, authorizationExpiresAt',
      syncMetadata: 'id, &vaultId, lastSuccessfulSyncAt',
    });
    await legacy.table('syncVault').put({
      id: 'active-sync-vault',
      vaultId: 'VVVVVVVVVVVVVVVVVVVVVV',
      status: 'active',
      keyEpoch: 1,
    });
    legacy.close();

    const upgraded = new FinanceDatabase(name);
    await upgraded.open();

    expect(await upgraded.syncVault.get('active-sync-vault')).toMatchObject({
      vaultId: 'VVVVVVVVVVVVVVVVVVVVVV',
      keyEpoch: 1,
    });
    expect(upgraded.tables.map((table) => table.name)).toContain('syncDeviceAliases');
    expect(await upgraded.syncDeviceAliases.count()).toBe(0);
    upgraded.close();
  });
});
