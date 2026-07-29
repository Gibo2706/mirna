import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFinanceDataIntegrity } from '@/domain/integrity';
import { calculateAccountBalances } from '@/domain/calculations';
import {
  deleteAccount,
  deleteCategory,
  deleteDebt,
  deleteGoal,
  deleteTransaction,
  contributeToGoal,
  markCommitmentPaid,
  markPlannedEventPaid,
  markPlannedIncomeReceived,
  recordDebtPayment,
  saveDebt,
  saveGoal,
  savePlannedEvent,
  savePlannedIncome,
  savePreset,
  saveTransaction,
} from './commands';
import { db, financeTables } from './database';
import { readFinanceData } from './queries';
import {
  checking,
  expenseCategory,
  incomeCategory,
  monthlyCommitment,
  savings,
  settings,
} from '@/tests/factories';

describe('atomic database commands', () => {
  beforeEach(async () => {
    await db.transaction('rw', financeTables(), async () => {
      await Promise.all(financeTables().map((table) => table.clear()));
    });
    await db.accounts.add(checking);
    await db.categories.add(expenseCategory);
    await db.categories.add(incomeCategory);
  });

  it('marks the same commitment occurrence paid exactly once', async () => {
    await db.commitments.add(monthlyCommitment);
    const input = {
      occurrenceKey: 'commitment:2026-07-31',
      name: 'Rata',
      amount: 3_730,
      date: '2026-07-31',
      accountId: checking.id,
      categoryId: expenseCategory.id,
    };
    const first = await markCommitmentPaid(input);
    const second = await markCommitmentPaid(input);
    expect(second).toBe(first);
    expect(await db.transactions.where('occurrenceKey').equals(input.occurrenceKey).count()).toBe(
      1,
    );
  });

  it('creates debt payment and expense together and prevents overpayment', async () => {
    await db.debts.add({
      id: 'debt',
      creditor: 'Finansijska zadruga',
      originalAmount: 18_000,
      priority: 'medium',
      status: 'open',
      paymentOverrides: {},
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    await recordDebtPayment({
      debtId: 'debt',
      accountId: checking.id,
      categoryId: expenseCategory.id,
      amount: 10_000,
      date: '2026-07-20',
    });
    expect(await db.transactions.count()).toBe(1);
    expect(await db.debtPayments.count()).toBe(1);
    const debt = await db.debts.get('debt');
    await expect(saveDebt({ ...debt!, originalAmount: 9_000 })).rejects.toThrow(
      'manji od evidentiranih uplata',
    );
    await expect(
      recordDebtPayment({
        debtId: 'debt',
        accountId: checking.id,
        categoryId: expenseCategory.id,
        amount: 9_000,
        date: '2026-07-21',
      }),
    ).rejects.toThrow('između 1 i 8000');
    expect(await db.transactions.count()).toBe(1);
    await expect(deleteDebt('debt')).rejects.toThrow('istorijom uplata');
  });

  it('marks a planned salary occurrence received exactly once', async () => {
    await db.plannedIncomes.add({
      id: 'salary',
      name: 'Plata',
      amount: 100_000,
      categoryId: incomeCategory.id,
      accountId: checking.id,
      frequency: 'monthly',
      startDate: '2026-07-01',
      expectedDay: 5,
      active: true,
      isPrimarySalary: true,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    const input = {
      plannedIncomeId: 'salary',
      occurrenceKey: 'income:salary:2026-07',
      month: '2026-07',
      receivedDate: '2026-07-05',
    };
    const [first, second] = await Promise.all([
      markPlannedIncomeReceived(input),
      markPlannedIncomeReceived(input),
    ]);
    expect(second).toBe(first);
    expect(await db.transactions.where('occurrenceKey').equals(input.occurrenceKey).count()).toBe(
      1,
    );
  });

  it('records an external debt correction without changing ledger balances', async () => {
    await db.debts.add({
      id: 'external-debt',
      creditor: 'Poverilac A',
      originalAmount: 28_400,
      priority: 'medium',
      status: 'open',
      paymentOverrides: {},
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    await recordDebtPayment({
      debtId: 'external-debt',
      source: 'external',
      amount: 8_600,
      date: '2027-02-20',
      notes: 'Spoljna uplata',
    });
    expect(await db.transactions.count()).toBe(0);
    expect(await db.debtPayments.toArray()).toMatchObject([
      { debtId: 'external-debt', amount: 8_600, source: 'external' },
    ]);
  });

  it('does not let the generic transaction command forge system relationships', async () => {
    await expect(
      saveTransaction({
        id: 'forged-goal',
        type: 'transfer',
        amount: 1_000,
        accountId: checking.id,
        toAccountId: 'missing',
        date: '2026-07-20',
        description: 'Lažna uplata cilja',
        source: 'goal',
        goalId: 'missing',
        createdAt: '2026-07-20T00:00:00.000Z',
      }),
    ).rejects.toThrow('odgovarajući finansijski tok');
    expect(await db.transactions.count()).toBe(0);
  });

  it('protects referenced records and leaves a representative command snapshot valid', async () => {
    await db.accounts.add(savings);
    await db.settings.add(settings);
    await savePlannedIncome({
      id: 'salary',
      name: 'Plata',
      amount: 100_000,
      categoryId: incomeCategory.id,
      accountId: checking.id,
      frequency: 'monthly',
      startDate: '2026-07-01',
      expectedDay: 5,
      active: true,
      isPrimarySalary: true,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    await saveGoal({
      id: 'goal',
      name: 'Stručna radionica',
      emoji: '🧪',
      targetAmount: 33_300,
      linkedAccountId: savings.id,
      plannedMonthlyContribution: 10_000,
      contributionOverrides: {},
      goalType: 'sinking',
      archived: false,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    await savePlannedEvent({
      id: 'event',
      title: 'Stručna radionica',
      date: '2027-05-17',
      plannedAmount: 33_300,
      categoryId: expenseCategory.id,
      accountId: savings.id,
      linkedGoalId: 'goal',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    await savePreset({
      id: 'preset',
      name: 'Kafa',
      emoji: '☕',
      type: 'expense',
      amount: 200,
      categoryId: expenseCategory.id,
      defaultAccountId: checking.id,
      position: 0,
      active: true,
    });

    await expect(deleteAccount(checking.id)).rejects.toThrow('povezane podatke');
    await expect(deleteCategory(expenseCategory.id)).rejects.toThrow('se koristi');
    await expect(deleteGoal('goal')).resolves.toBe('archived');
    expect((await db.goals.get('goal'))?.archived).toBe(true);
    const snapshot = await readFinanceData();
    expect(() => assertFinanceDataIntegrity(snapshot)).not.toThrow();
  });

  it('atomically completes a sinking goal with its paid event and reopens it on undo', async () => {
    await db.accounts.add(savings);
    await saveGoal({
      id: 'goal',
      name: 'Stručna radionica',
      emoji: '🧪',
      targetAmount: 48_600,
      linkedAccountId: savings.id,
      plannedMonthlyContribution: 10_000,
      contributionOverrides: {},
      goalType: 'sinking',
      archived: false,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    await savePlannedEvent({
      id: 'event',
      title: 'Stručna radionica',
      date: '2027-03-18',
      plannedAmount: 1_000,
      categoryId: expenseCategory.id,
      accountId: savings.id,
      linkedGoalId: 'goal',
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    const transactionId = await markPlannedEventPaid({ eventId: 'event' });
    expect(await db.goals.get('goal')).toMatchObject({ usedAt: '2027-03-18' });
    await expect(
      contributeToGoal({
        goalId: 'goal',
        fromAccountId: checking.id,
        amount: 100,
        date: '2027-03-19',
      }),
    ).rejects.toThrow('Iskorišćeni namenski cilj');

    await deleteTransaction(transactionId);
    expect((await db.goals.get('goal'))?.usedAt).toBeUndefined();
    expect((await db.plannedEvents.get('event'))?.paidTransactionId).toBeUndefined();
    await expect(
      contributeToGoal({
        goalId: 'goal',
        fromAccountId: checking.id,
        amount: 100,
        date: '2027-03-19',
      }),
    ).resolves.toBeTruthy();
  });

  it('atomically tops up a short protected event, completes it once, and keeps balances non-negative', async () => {
    const trainingFund = {
      ...savings,
      id: 'training-fund',
      name: 'Fond za obuku',
      openingBalance: 43_200,
    };
    await db.accounts.add(trainingFund);
    await saveGoal({
      id: 'training-goal',
      name: 'Stručna radionica',
      emoji: '🧪',
      targetAmount: 48_600,
      linkedAccountId: trainingFund.id,
      plannedMonthlyContribution: 5_400,
      contributionOverrides: {},
      goalType: 'sinking',
      archived: false,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    await savePlannedEvent({
      id: 'training-event',
      title: 'Stručna radionica',
      date: '2027-03-18',
      plannedAmount: 48_600,
      categoryId: expenseCategory.id,
      accountId: trainingFund.id,
      linkedGoalId: 'training-goal',
      createdAt: '2027-01-01T00:00:00.000Z',
    });

    const input = {
      eventId: 'training-event',
      topUpFromAccountId: checking.id,
    };
    const first = await markPlannedEventPaid(input);
    const second = await markPlannedEventPaid(input);
    const transactions = await db.transactions.toArray();
    const balances = calculateAccountBalances(await db.accounts.toArray(), transactions);

    expect(second).toBe(first);
    expect(transactions).toHaveLength(2);
    expect(transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'transfer',
          amount: 5_400,
          accountId: checking.id,
          toAccountId: trainingFund.id,
          occurrenceKey: 'event-funding:training-event',
        }),
        expect.objectContaining({
          id: first,
          type: 'expense',
          amount: 48_600,
          accountId: trainingFund.id,
          plannedEventId: 'training-event',
        }),
      ]),
    );
    expect(balances).toMatchObject({ checking: 94_600, 'training-fund': 0 });
    expect(await db.plannedEvents.get('training-event')).toMatchObject({
      paidTransactionId: first,
    });
    expect(await db.goals.get('training-goal')).toMatchObject({
      usedAt: '2027-03-18',
    });

    await deleteTransaction(first);
    expect(await db.transactions.count()).toBe(0);
    expect((await db.plannedEvents.get('training-event'))?.paidTransactionId).toBeUndefined();
    expect((await db.goals.get('training-goal'))?.usedAt).toBeUndefined();
    expect(
      calculateAccountBalances(await db.accounts.toArray(), await db.transactions.toArray()),
    ).toMatchObject({ checking: 100_000, 'training-fund': 43_200 });
  });

  it('fully funds an empty protected event from spendable cash without a negative balance', async () => {
    const workshopFund = {
      ...savings,
      id: 'workshop-fund',
      name: 'Fond za radionicu',
      openingBalance: 0,
    };
    await db.accounts.add(workshopFund);
    await savePlannedEvent({
      id: 'workshop-event',
      title: 'Stručna radionica',
      date: '2027-05-17',
      plannedAmount: 32_400,
      categoryId: expenseCategory.id,
      accountId: workshopFund.id,
      createdAt: '2027-01-01T00:00:00.000Z',
    });

    await markPlannedEventPaid({
      eventId: 'workshop-event',
      topUpFromAccountId: checking.id,
    });
    const balances = calculateAccountBalances(
      await db.accounts.toArray(),
      await db.transactions.toArray(),
    );
    expect(balances).toMatchObject({ checking: 67_600, 'workshop-fund': 0 });
    expect(await db.transactions.count()).toBe(2);
  });

  it('rolls back the event top-up when the event expense write fails', async () => {
    const trainingFund = {
      ...savings,
      id: 'rollback-training',
      name: 'Fond za obuku',
      openingBalance: 43_200,
    };
    await db.accounts.add(trainingFund);
    await savePlannedEvent({
      id: 'rollback-event',
      title: 'Stručna radionica',
      date: '2027-03-18',
      plannedAmount: 48_600,
      categoryId: expenseCategory.id,
      accountId: trainingFund.id,
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    const idSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000000');

    await expect(
      markPlannedEventPaid({
        eventId: 'rollback-event',
        topUpFromAccountId: checking.id,
      }),
    ).rejects.toThrow();
    idSpy.mockRestore();

    expect(await db.transactions.count()).toBe(0);
    expect((await db.plannedEvents.get('rollback-event'))?.paidTransactionId).toBeUndefined();
  });

  it('rejects an event top-up from an underfunded source without changing any state', async () => {
    const lowChecking = { ...checking, id: 'low-checking', openingBalance: 3_000 };
    const trainingFund = {
      ...savings,
      id: 'underfunded-training',
      name: 'Fond za obuku',
      openingBalance: 43_200,
    };
    await db.accounts.bulkAdd([lowChecking, trainingFund]);
    await savePlannedEvent({
      id: 'underfunded-event',
      title: 'Stručna radionica',
      date: '2027-03-18',
      plannedAmount: 48_600,
      categoryId: expenseCategory.id,
      accountId: trainingFund.id,
      createdAt: '2027-01-01T00:00:00.000Z',
    });

    await expect(
      markPlannedEventPaid({
        eventId: 'underfunded-event',
        topUpFromAccountId: lowChecking.id,
      }),
    ).rejects.toThrow('Nema dovoljno sredstava');
    expect(await db.transactions.count()).toBe(0);
    expect((await db.plannedEvents.get('underfunded-event'))?.paidTransactionId).toBeUndefined();
  });

  it('blocks manual protected outflows that would create a negative actual balance', async () => {
    await db.accounts.add(savings);
    await expect(
      saveTransaction({
        id: 'negative-protected',
        type: 'expense',
        amount: 2_000,
        accountId: savings.id,
        categoryId: expenseCategory.id,
        date: '2026-07-20',
        description: 'Preveliki trošak',
        source: 'manual',
        createdAt: '2026-07-20T00:00:00.000Z',
      }),
    ).rejects.toThrow('ispod nule');
    expect(await db.transactions.count()).toBe(0);
  });

  it('records retroactive planned income on the edited date, account and note', async () => {
    await db.plannedIncomes.add({
      id: 'retro-salary',
      name: 'Plata',
      amount: 100_000,
      categoryId: incomeCategory.id,
      accountId: checking.id,
      frequency: 'monthly',
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      expectedDay: 5,
      active: true,
      isPrimarySalary: true,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    const transactionId = await markPlannedIncomeReceived({
      plannedIncomeId: 'retro-salary',
      occurrenceKey: 'income:retro-salary:2026-07',
      month: '2026-07',
      receivedDate: '2026-08-01',
      amount: 99_000,
      accountId: checking.id,
      notes: 'Leglo dan kasnije',
    });

    expect(await db.transactions.get(transactionId)).toMatchObject({
      amount: 99_000,
      date: '2026-08-01',
      accountId: checking.id,
      notes: 'Leglo dan kasnije',
      occurrenceKey: 'income:retro-salary:2026-07',
    });
  });
});
