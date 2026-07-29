import { describe, expect, it } from 'vitest';
import { assertFinanceDataIntegrity } from './integrity';
import type { LedgerTransaction } from './types';
import {
  checking,
  emptyFinanceData,
  expenseCategory,
  incomeCategory,
  savings,
  tx,
} from '@/tests/factories';

describe('finance data integrity', () => {
  it('rejects duplicate primary IDs before bulk import can collapse them', () => {
    const data = emptyFinanceData();
    data.accounts.push({ ...data.accounts[0] });
    expect(() => assertFinanceDataIntegrity(data)).toThrow('ponovljen ID');
  });

  it('rejects a planned event linked to a missing goal', () => {
    const data = emptyFinanceData();
    data.plannedEvents.push({
      id: 'event',
      title: 'Put',
      date: '2026-11-15',
      plannedAmount: 35_000,
      categoryId: expenseCategory.id,
      accountId: data.accounts[0].id,
      linkedGoalId: 'missing',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    expect(() => assertFinanceDataIntegrity(data)).toThrow('nepoznat cilj');
  });

  it('rejects an external debt correction carrying a personal transaction', () => {
    const data = emptyFinanceData();
    data.debts.push({
      id: 'debt',
      creditor: 'Poverilac A',
      originalAmount: 28_400,
      priority: 'medium',
      status: 'open',
      paymentOverrides: {},
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    data.debtPayments.push({
      id: 'payment',
      debtId: 'debt',
      amount: 10_000,
      date: '2026-07-20',
      source: 'external',
      transactionId: 'expense',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    data.transactions.push(
      tx({
        id: 'expense',
        type: 'expense',
        amount: 10_000,
        categoryId: expenseCategory.id,
        source: 'debt',
        debtPaymentId: 'payment',
      }),
    );
    expect(() => assertFinanceDataIntegrity(data)).toThrow(
      'Spoljna uplata payment ne sme imati transakciju',
    );
  });

  it('rejects duplicate occurrence relationships', () => {
    const data = emptyFinanceData();
    data.transactions.push(
      tx({
        id: 'one',
        type: 'expense',
        amount: 100,
        categoryId: expenseCategory.id,
        occurrenceKey: 'same',
      }),
      tx({
        id: 'two',
        type: 'expense',
        amount: 100,
        categoryId: expenseCategory.id,
        occurrenceKey: 'same',
      }),
    );
    expect(() => assertFinanceDataIntegrity(data)).toThrow('Ponavlja se occurrence');
  });

  const brokenReferences: Array<[string, Partial<LedgerTransaction>, string]> = [
    ['account', { accountId: 'missing' }, 'nepoznat račun'],
    ['category', { categoryId: 'missing' }, 'nepoznatu kategoriju'],
    ['goal', { goalId: 'missing', source: 'goal' }, 'nepoznat cilj'],
    [
      'planned income',
      {
        source: 'planned-income',
        plannedIncomeId: 'missing',
        occurrenceKey: 'income:missing:2026-07',
      },
      'nepoznat planirani prihod',
    ],
  ];

  it.each(brokenReferences)(
    'rejects a transaction with a broken %s reference',
    (_label, override, message) => {
      const data = emptyFinanceData();
      data.transactions.push(
        tx({
          id: 'broken',
          type: 'expense',
          amount: 100,
          categoryId: expenseCategory.id,
          ...override,
        }),
      );
      expect(() => assertFinanceDataIntegrity(data)).toThrow(message);
    },
  );

  it('rejects a self transfer', () => {
    const data = emptyFinanceData();
    data.transactions.push(
      tx({
        id: 'self-transfer',
        type: 'transfer',
        amount: 100,
        toAccountId: checking.id,
      }),
    );
    expect(() => assertFinanceDataIntegrity(data)).toThrow('isti izvorni i ciljni račun');
  });

  it('rejects a self-funded debt payment without its ledger transaction', () => {
    const data = emptyFinanceData();
    data.debts.push({
      id: 'debt',
      creditor: 'Finansijska zadruga',
      originalAmount: 18_000,
      priority: 'medium',
      status: 'open',
      paymentOverrides: {},
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    data.debtPayments.push({
      id: 'payment',
      debtId: 'debt',
      amount: 2_000,
      date: '2026-07-20',
      source: 'self',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    expect(() => assertFinanceDataIntegrity(data)).toThrow('nema transakciju');
  });

  it('rejects two actual transactions linked to the same paid event', () => {
    const data = emptyFinanceData();
    data.plannedEvents.push({
      id: 'event',
      title: 'Put',
      date: '2026-11-15',
      plannedAmount: 35_000,
      categoryId: expenseCategory.id,
      accountId: checking.id,
      paidTransactionId: 'event-one',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    data.transactions.push(
      tx({
        id: 'event-one',
        type: 'expense',
        amount: 35_000,
        categoryId: expenseCategory.id,
        source: 'planned-event',
        plannedEventId: 'event',
      }),
      tx({
        id: 'event-two',
        type: 'expense',
        amount: 35_000,
        categoryId: expenseCategory.id,
        source: 'planned-event',
        plannedEventId: 'event',
      }),
    );
    expect(() => assertFinanceDataIntegrity(data)).toThrow('povezan sa više transakcija');
  });

  it('accepts a complete representative snapshot', () => {
    const data = emptyFinanceData();
    data.plannedIncomes.push({
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
    data.goals.push({
      id: 'goal',
      name: 'Laboratorijska oprema',
      emoji: '🔬',
      targetAmount: 46_800,
      linkedAccountId: savings.id,
      plannedMonthlyContribution: 10_000,
      contributionOverrides: {},
      goalType: 'sinking',
      archived: false,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    data.transactions.push(
      tx({
        id: 'goal-transfer',
        type: 'transfer',
        amount: 10_000,
        toAccountId: savings.id,
        source: 'goal',
        goalId: 'goal',
      }),
    );
    expect(() => assertFinanceDataIntegrity(data)).not.toThrow();
  });
});
