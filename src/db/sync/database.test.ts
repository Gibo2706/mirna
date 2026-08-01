import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { financeTables, FinanceDatabase } from '../database';

const databaseNames: string[] = [];

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)));
});

describe('Dexie v10 sync schema', () => {
  it('adds dedicated sync stores while ordinary finance tables stay unchanged', async () => {
    const name = `mirna-v10-schema-${crypto.randomUUID()}`;
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
        'syncConflicts',
        'syncCheckpoints',
        'syncDevice',
        'syncEntityStates',
        'syncFrontier',
        'syncInbox',
        'syncKeys',
        'syncMetadata',
        'syncOutbox',
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
});
