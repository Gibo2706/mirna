import Dexie, { type Table } from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { calculateAccountBalances } from '@/domain/calculations';
import type { Account, LedgerTransaction } from '@/domain/types';
import { FinanceDatabase } from './database';

class LegacyV2Database extends Dexie {
  accounts!: Table<Account, string>;
  transactions!: Table<LedgerTransaction, string>;
  categories!: Table<Record<string, unknown>, string>;
  goals!: Table<Record<string, unknown>, string>;
  debts!: Table<Record<string, unknown>, string>;
  debtPayments!: Table<Record<string, unknown>, string>;
  settings!: Table<Record<string, unknown>, string>;

  constructor(name: string) {
    super(name);
    this.version(2).stores({
      accounts: 'id, kind, protected, archived',
      transactions:
        'id, type, date, accountId, toAccountId, categoryId, &occurrenceKey, &plannedEventId, goalId, debtPaymentId',
      categories: 'id, kind, archived',
      commitments: 'id, active, frequency, startDate, endDate, accountId, categoryId',
      variableBudgets: 'id, active, categoryId',
      goals: 'id, archived, &linkedAccountId',
      debts: 'id, status, priority',
      debtPayments: 'id, debtId, date, &transactionId',
      plannedEvents: 'id, date, categoryId, accountId, linkedGoalId',
      presets: 'id, active, position',
      salaryScenarios: 'id, startMonth',
      settings: 'id',
    });
  }
}

class LegacyV3Database extends Dexie {
  accounts!: Table<Account, string>;
  transactions!: Table<LedgerTransaction, string>;
  goals!: Table<Record<string, unknown>, string>;
  plannedEvents!: Table<Record<string, unknown>, string>;

  constructor(name: string) {
    super(name);
    this.version(3).stores({
      accounts: 'id, kind, protected, archived',
      transactions:
        'id, type, date, accountId, toAccountId, categoryId, &occurrenceKey, plannedIncomeId, &plannedEventId, goalId, debtPaymentId',
      categories: 'id, kind, archived',
      plannedIncomes: 'id, active, isPrimarySalary, accountId, categoryId, startDate, endDate',
      commitments: 'id, active, frequency, startDate, endDate, accountId, categoryId',
      variableBudgets: 'id, active, categoryId',
      goals: 'id, archived, &linkedAccountId',
      debts: 'id, status, priority',
      debtPayments: 'id, debtId, date, &transactionId',
      plannedEvents: 'id, date, categoryId, accountId, linkedGoalId',
      presets: 'id, active, position',
      salaryScenarios: 'id, startMonth',
      settings: 'id',
    });
  }
}

class LegacyV4Database extends Dexie {
  accounts!: Table<Account, string>;
  transactions!: Table<LedgerTransaction, string>;
  goals!: Table<Record<string, unknown>, string>;
  plannedEvents!: Table<Record<string, unknown>, string>;

  constructor(name: string) {
    super(name);
    this.version(4).stores({
      accounts: 'id, kind, protected, archived',
      transactions:
        'id, type, date, accountId, toAccountId, categoryId, &occurrenceKey, plannedIncomeId, &plannedEventId, goalId, debtPaymentId',
      categories: 'id, kind, archived',
      plannedIncomes: 'id, active, isPrimarySalary, accountId, categoryId, startDate, endDate',
      commitments: 'id, active, frequency, startDate, endDate, accountId, categoryId',
      variableBudgets: 'id, active, categoryId',
      goals: 'id, archived, goalType, &linkedAccountId',
      debts: 'id, status, priority',
      debtPayments: 'id, debtId, date, &transactionId',
      plannedEvents: 'id, date, categoryId, accountId, linkedGoalId',
      presets: 'id, active, position',
      salaryScenarios: 'id, startMonth',
      settings: 'id',
    });
  }
}

const databaseNames: string[] = [];

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)));
});

describe('Dexie v3 migration', () => {
  it('preserves accounts, ledger history and balances while adding normalized plan fields', async () => {
    const name = `mirna-v2-migration-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const legacy = new LegacyV2Database(name);
    await legacy.open();
    const accounts: Account[] = [
      {
        id: 'checking',
        name: 'Tekući',
        kind: 'checking',
        openingBalance: 31_700,
        protected: false,
        color: '#000',
        archived: false,
        createdAt: '2027-02-01T00:00:00.000Z',
      },
      {
        id: 'savings',
        name: 'Štednja',
        kind: 'savings',
        openingBalance: 6_200,
        protected: true,
        color: '#111',
        archived: false,
        createdAt: '2027-02-01T00:00:00.000Z',
      },
    ];
    const transactions: LedgerTransaction[] = [
      {
        id: 'income',
        type: 'income',
        amount: 24_800,
        accountId: 'checking',
        categoryId: 'income-category',
        date: '2027-02-02',
        description: 'Prihod',
        source: 'manual',
        createdAt: '2027-02-02T00:00:00.000Z',
      },
      {
        id: 'expense',
        type: 'expense',
        amount: 7_300,
        accountId: 'checking',
        categoryId: 'expense-category',
        date: '2027-02-03',
        description: 'Trošak',
        source: 'manual',
        createdAt: '2027-02-03T00:00:00.000Z',
      },
      {
        id: 'transfer',
        type: 'transfer',
        amount: 4_600,
        accountId: 'checking',
        toAccountId: 'savings',
        date: '2027-02-04',
        description: 'Štednja',
        source: 'goal',
        goalId: 'goal',
        createdAt: '2027-02-04T00:00:00.000Z',
      },
    ];
    await legacy.accounts.bulkAdd(accounts);
    await legacy.categories.bulkAdd([
      {
        id: 'income-category',
        name: 'Plata',
        kind: 'income',
        icon: '💼',
        color: '#000',
        archived: false,
      },
      {
        id: 'expense-category',
        name: 'Trošak',
        kind: 'expense',
        icon: '•',
        color: '#000',
        archived: false,
      },
    ]);
    await legacy.transactions.bulkAdd(transactions);
    await legacy.goals.add({
      id: 'goal',
      name: 'Laboratorijska oprema',
      emoji: '🔬',
      targetAmount: 46_800,
      linkedAccountId: 'savings',
      plannedMonthlyContribution: 12_700,
      archived: false,
      createdAt: '2027-02-01T00:00:00.000Z',
    });
    await legacy.debts.add({
      id: 'debt',
      creditor: 'Poverilac A',
      originalAmount: 28_400,
      priority: 'medium',
      status: 'open',
      createdAt: '2027-02-01T00:00:00.000Z',
    });
    await legacy.settings.add({
      id: 'settings',
      onboardingCompleted: true,
      baseMonthlyIncome: 123_400,
      currency: 'RSD',
      locale: 'sr-Latn-RS',
      appearance: 'system',
      defaultAccountId: 'checking',
      installHintDismissed: false,
      createdAt: '2027-02-01T00:00:00.000Z',
      updatedAt: '2027-02-01T00:00:00.000Z',
    });
    const beforeAccounts = await legacy.accounts.toArray();
    const beforeTransactions = await legacy.transactions.toArray();
    const beforeBalances = calculateAccountBalances(beforeAccounts, beforeTransactions);
    expect(beforeBalances).toEqual({ checking: 44_600, savings: 10_800 });
    legacy.close();

    const upgraded = new FinanceDatabase(name);
    await upgraded.open();
    expect(await upgraded.accounts.toArray()).toEqual(beforeAccounts);
    expect(await upgraded.transactions.toArray()).toEqual(beforeTransactions);
    const afterBalances = calculateAccountBalances(
      await upgraded.accounts.toArray(),
      await upgraded.transactions.toArray(),
    );
    expect(afterBalances).toEqual({ checking: 44_600, savings: 10_800 });
    expect(afterBalances).toEqual(beforeBalances);
    expect(await upgraded.goals.get('goal')).toMatchObject({
      plannedMonthlyContribution: 12_700,
      contributionOverrides: {},
      goalType: 'reserve',
    });
    expect(await upgraded.debts.get('debt')).toMatchObject({ paymentOverrides: {} });
    expect(await upgraded.plannedIncomes.toArray()).toMatchObject([
      {
        id: 'income_primary_salary',
        amount: 123_400,
        accountId: 'checking',
        categoryId: 'income-category',
        isPrimarySalary: true,
      },
    ]);
    upgraded.close();

    const reopened = new FinanceDatabase(name);
    await reopened.open();
    expect(await reopened.plannedIncomes.count()).toBe(1);
    reopened.close();
  });

  it('infers legacy goal types from synthetic purpose relationships without changing ledger data', async () => {
    const name = `mirna-v3-migration-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const legacy = new LegacyV3Database(name);
    await legacy.open();
    await legacy.accounts.bulkAdd([
      {
        id: 'checking',
        name: 'Tekući',
        kind: 'checking',
        openingBalance: 8_750,
        protected: false,
        color: '#000',
        archived: false,
        createdAt: '2027-01-01T00:00:00.000Z',
      },
      {
        id: 'training-fund',
        name: 'Fond za obuku',
        kind: 'savings',
        openingBalance: 0,
        protected: true,
        color: '#111',
        archived: false,
        createdAt: '2027-01-01T00:00:00.000Z',
      },
      {
        id: 'reserve-fund',
        name: 'Rezervni fond',
        kind: 'savings',
        openingBalance: 3_700,
        protected: true,
        color: '#222',
        archived: false,
        createdAt: '2027-01-01T00:00:00.000Z',
      },
    ]);
    await legacy.transactions.bulkAdd([
      {
        id: 'equipment-repair',
        type: 'expense',
        amount: 17_600,
        accountId: 'checking',
        categoryId: 'equipment',
        date: '2027-01-09',
        description: 'Servis projektora',
        notes: 'Zamenjen ventilator',
        source: 'manual',
        createdAt: '2027-01-09T00:00:00.000Z',
      },
      {
        id: 'training-payment',
        type: 'expense',
        amount: 48_600,
        accountId: 'training-fund',
        categoryId: 'education',
        date: '2027-03-19',
        description: 'Stručna radionica',
        source: 'planned-event',
        plannedEventId: 'event_training',
        createdAt: '2027-03-19T00:00:00.000Z',
      },
    ]);
    await legacy.goals.add({
      id: 'goal_training',
      name: 'Stručna radionica',
      emoji: '🧪',
      targetAmount: 48_600,
      targetDate: '2027-03-18',
      linkedAccountId: 'training-fund',
      plannedMonthlyContribution: 14_400,
      contributionOverrides: { '2027-02': 14_400 },
      archived: false,
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    await legacy.goals.add({
      id: 'goal_buffer',
      name: 'Rezervni fond',
      emoji: '🛟',
      targetAmount: 22_200,
      linkedAccountId: 'reserve-fund',
      plannedMonthlyContribution: 3_700,
      contributionOverrides: {},
      archived: false,
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    await legacy.plannedEvents.add({
      id: 'event_training',
      title: 'Stručna radionica',
      date: '2027-03-18',
      plannedAmount: 48_600,
      categoryId: 'education',
      accountId: 'training-fund',
      linkedGoalId: 'goal_training',
      paidTransactionId: 'training-payment',
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    const accountsBefore = await legacy.accounts.toArray();
    const transactionsBefore = await legacy.transactions.toArray();
    legacy.close();

    const upgraded = new FinanceDatabase(name);
    await upgraded.open();
    expect(await upgraded.accounts.toArray()).toEqual(accountsBefore);
    expect(await upgraded.transactions.toArray()).toEqual(transactionsBefore);
    expect(await upgraded.goals.get('goal_training')).toMatchObject({
      goalType: 'sinking',
      usedAt: '2027-03-19',
      plannedMonthlyContribution: 14_400,
      contributionOverrides: { '2027-02': 14_400 },
    });
    expect(await upgraded.goals.get('goal_buffer')).toMatchObject({ goalType: 'reserve' });
    expect((await upgraded.transactions.get('equipment-repair'))?.amount).toBe(17_600);
    expect((await upgraded.transactions.get('equipment-repair'))?.notes).toBe(
      'Zamenjen ventilator',
    );
    upgraded.close();
  });

  it('repairs only a clearly legacy-derived v4 usedAt and preserves ledger cash data', async () => {
    const name = `mirna-v4-migration-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const legacy = new LegacyV4Database(name);
    await legacy.open();
    const account = {
      id: 'training-fund',
      name: 'Fond za obuku',
      kind: 'savings' as const,
      openingBalance: 48_600,
      protected: true,
      color: '#111',
      archived: false,
      createdAt: '2027-01-01T00:00:00.000Z',
    };
    const paidTransaction: LedgerTransaction = {
      id: 'training-payment',
      type: 'expense',
      amount: 48_600,
      accountId: account.id,
      categoryId: 'education',
      date: '2027-03-19',
      description: 'Stručna radionica',
      source: 'planned-event',
      plannedEventId: 'training',
      createdAt: '2027-03-19T12:00:00.000Z',
    };
    await legacy.accounts.add(account);
    await legacy.transactions.add(paidTransaction);
    await legacy.goals.add({
      id: 'goal_training',
      name: 'Stručna radionica',
      emoji: '🧪',
      targetAmount: 48_600,
      linkedAccountId: account.id,
      plannedMonthlyContribution: 14_400,
      contributionOverrides: {},
      goalType: 'sinking',
      usedAt: '2027-03-18',
      archived: false,
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    await legacy.plannedEvents.add({
      id: 'training',
      title: 'Stručna radionica',
      date: '2027-03-18',
      plannedAmount: 48_600,
      categoryId: 'education',
      accountId: account.id,
      linkedGoalId: 'goal_training',
      paidTransactionId: paidTransaction.id,
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    const accountsBefore = await legacy.accounts.toArray();
    const transactionsBefore = await legacy.transactions.toArray();
    legacy.close();

    const upgraded = new FinanceDatabase(name);
    await upgraded.open();
    expect(await upgraded.goals.get('goal_training')).toMatchObject({
      usedAt: '2027-03-19',
    });
    expect(await upgraded.accounts.toArray()).toEqual(accountsBefore);
    expect(await upgraded.transactions.toArray()).toEqual(transactionsBefore);
    upgraded.close();
  });
});
