import { describe, expect, it } from 'vitest';
import {
  calculateAccountBalances,
  calculateMonthlyActuals,
  calculateMonthlyFinancialSummary,
  calculateSafeToSpend,
  calculateSpendableBalance,
  getEffectiveGoalContribution,
} from './calculations';
import { calculateForecast } from './forecast';
import type { Account, LedgerTransaction, SavingsGoal } from './types';
import { createChatGptMarkdown } from '@/features/export/backup';
import { checking, emptyFinanceData, savings, settings, tx } from '@/tests/factories';

const goal: SavingsGoal = {
  id: 'goal',
  name: 'Rezerva',
  emoji: '🎯',
  targetAmount: 50_000,
  linkedAccountId: savings.id,
  plannedMonthlyContribution: 12_000,
  contributionOverrides: {},
  goalType: 'reserve',
  archived: false,
  createdAt: '2026-07-01T00:00:00.000Z',
};
const accounts = [checking, savings];
const deposit = (overrides: Partial<LedgerTransaction> = {}) =>
  tx({ id: 'deposit', type: 'transfer', amount: 5_000, toAccountId: savings.id, ...overrides });
const contribution = (transactions: LedgerTransaction[], allAccounts: Account[] = accounts) =>
  getEffectiveGoalContribution({
    goal,
    month: '2026-07',
    transactions,
    accounts: allAccounts,
    currentGoalBalance: calculateAccountBalances(allAccounts, transactions)[savings.id] ?? 0,
  });
const summary = (
  transactions: LedgerTransaction[],
  goals: SavingsGoal[] = [goal],
  allAccounts: Account[] = accounts,
) =>
  calculateMonthlyFinancialSummary({
    month: '2026-07',
    accounts: allAccounts,
    plannedIncomes: [],
    commitments: [],
    variableBudgets: [],
    goals,
    debts: [],
    debtPayments: [],
    events: [],
    transactions,
  });

describe('savings transfer accounting', () => {
  it.each([
    { source: 'goal' as const, goalId: goal.id },
    { source: 'manual' as const },
    { source: 'quick-add' as const },
    { source: 'manual' as const, goalId: goal.id },
  ])('counts a $source deposit once regardless of goalId tagging', (linkage) => {
    const transactions = [deposit(linkage)];
    expect(contribution(transactions)).toMatchObject({
      configuredPlan: 12_000,
      actualContribution: 5_000,
      remainingMonthlyPlan: 7_000,
      effectiveRemainingContribution: 7_000,
    });
    expect(calculateMonthlyActuals(transactions, accounts, '2026-07')).toEqual({
      income: 0,
      expenses: 0,
      savingsContributions: 5_000,
      transfers: 5_000,
    });
    const monthly = summary(transactions);
    expect(monthly.savings).toEqual({ planned: 12_000, actual: 5_000, remaining: 7_000 });
    expect(monthly.expenseReconciliation).toMatchObject({ recordedTotal: 0, status: 'OK' });
    const balances = calculateAccountBalances(accounts, transactions);
    expect(
      calculateSafeToSpend({
        spendableBalance: calculateSpendableBalance(accounts, balances),
        remainingFixed: monthly.fixed.remainingSpendable,
        remainingVariable: monthly.variable.remaining,
        upcomingEvents: monthly.events.remainingSpendable,
        remainingSavingsPlan: monthly.savings.remaining,
        remainingDebtPlan: monthly.debt.remaining,
      }),
    ).toBe(88_000);
  });

  it('recognizes historical manual deposits in their original month without rewriting them', () => {
    const historical = deposit({ date: '2026-06-15', createdAt: '2026-06-15T12:00:00.000Z' });
    const before = structuredClone(historical);
    expect(
      getEffectiveGoalContribution({
        goal,
        month: '2026-06',
        transactions: [historical],
        accounts,
        currentGoalBalance: 6_000,
      }).actualContribution,
    ).toBe(5_000);
    expect(contribution([historical]).actualContribution).toBe(0);
    expect(historical).toEqual(before);
  });

  it('reports gross deposits when savings are later withdrawn', () => {
    const transactions = [
      deposit(),
      deposit({ id: 'withdrawal', accountId: savings.id, toAccountId: checking.id, amount: 2_000 }),
    ];
    expect(contribution(transactions).actualContribution).toBe(5_000);
    expect(summary(transactions).savings).toEqual({
      planned: 12_000,
      actual: 5_000,
      remaining: 7_000,
    });
    expect(calculateMonthlyActuals(transactions, accounts, '2026-07')).toMatchObject({
      expenses: 0,
      income: 0,
      savingsContributions: 5_000,
    });
  });

  it('does not treat checking transfers, protected transfers, income or adjustments as savings', () => {
    const cash = { ...checking, id: 'cash' };
    const otherSavings = { ...savings, id: 'other-savings' };
    const allAccounts = [...accounts, cash, otherSavings];
    const transactions = [
      deposit({ id: 'to-cash', toAccountId: cash.id, goalId: goal.id }),
      deposit({ id: 'protected-to-protected', accountId: otherSavings.id, goalId: goal.id }),
      deposit({
        id: 'withdrawal',
        accountId: savings.id,
        toAccountId: checking.id,
        goalId: goal.id,
      }),
      deposit({ id: 'income', type: 'income', accountId: savings.id }),
      deposit({ id: 'adjustment', type: 'adjustment', accountId: savings.id }),
    ];
    expect(contribution(transactions, allAccounts).actualContribution).toBe(0);
    expect(calculateMonthlyActuals(transactions, allAccounts, '2026-07').savingsContributions).toBe(
      0,
    );
  });

  it('counts an unlinked protected deposit overall without assigning it to another goal', () => {
    const unlinked = { ...savings, id: 'unlinked' };
    const allAccounts = [...accounts, unlinked];
    const transactions = [deposit({ toAccountId: unlinked.id, goalId: goal.id })];
    expect(contribution(transactions, allAccounts).actualContribution).toBe(0);
    expect(summary(transactions, [goal], allAccounts).savings).toEqual({
      planned: 12_000,
      actual: 5_000,
      remaining: 12_000,
    });
  });

  it.each([
    { occurrenceKey: 'event-funding:event' },
    { occurrenceKey: 'commitment-funding:commitment:2026-07-15' },
    { occurrenceKey: 'another-system-operation' },
    { plannedEventId: 'event' },
    { plannedIncomeId: 'income' },
    { debtPaymentId: 'payment' },
    { source: 'planned-event' as const },
    { source: 'commitment' as const },
    { source: 'debt' as const },
  ])('excludes a system-linked transfer %j even if goalId is present', (linkage) => {
    const transactions = [deposit({ goalId: goal.id, ...linkage })];
    expect(contribution(transactions).actualContribution).toBe(0);
    expect(summary(transactions).savings.actual).toBe(0);
    expect(calculateMonthlyActuals(transactions, accounts, '2026-07').savingsContributions).toBe(0);
  });

  it('preserves actual savings after a goal is archived or removed', () => {
    const transactions = [deposit({ source: 'goal', goalId: goal.id })];
    expect(summary(transactions, [{ ...goal, archived: true }]).savings).toEqual({
      planned: 0,
      actual: 5_000,
      remaining: 0,
    });
    expect(summary(transactions, []).savings.actual).toBe(5_000);
  });

  it('projects only the remaining contribution after a manual deposit', () => {
    const transactions = [deposit()];
    const [month] = calculateForecast({
      startMonth: '2026-07',
      months: 1,
      accounts,
      accountBalances: calculateAccountBalances(accounts, transactions),
      plannedIncomes: [],
      commitments: [],
      variableBudgets: [],
      plannedEvents: [],
      goals: [goal],
      debts: [],
      debtPayments: [],
      transactions,
    });
    expect(month).toMatchObject({ savingsContributions: 7_000, projectedSpendableBalance: 88_000 });
  });

  it('exports the same manual contribution actual and remaining plan as the screens', () => {
    const markdown = createChatGptMarkdown(
      { ...emptyFinanceData(), goals: [goal], transactions: [deposit()], settingsRecord: settings },
      new Date(2026, 6, 20),
    );
    expect(markdown).toContain('| Savings allocations | 12000 | 5000 | 7000 |');
    expect(markdown).toMatch(/actual contribution 5[.\s]000/);
    expect(markdown).toMatch(/effective remaining contribution 7[.\s]000/);
  });
});
