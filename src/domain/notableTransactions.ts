import { format, subDays } from 'date-fns';
import type { ExpensePlanningBucket } from './calculations';
import type { LedgerTransaction, VariableBudget } from './types';

export interface NotableExpenseTransaction {
  transaction: LedgerTransaction;
  planningBucket: ExpensePlanningBucket;
}

const deterministicExpenseOrder = (left: LedgerTransaction, right: LedgerTransaction): number =>
  right.date.localeCompare(left.date) ||
  right.amount - left.amount ||
  left.id.localeCompare(right.id);

const planningBucketFor = (
  transaction: LedgerTransaction,
  variableBudgets: VariableBudget[],
): ExpensePlanningBucket => {
  if (transaction.source === 'commitment') return 'fixed';
  if (transaction.source === 'planned-event') return 'event';
  if (transaction.source === 'debt') return 'debt';
  if (
    transaction.categoryId &&
    variableBudgets.some(
      (budget) => budget.active && budget.categoryId === transaction.categoryId,
    ) &&
    (transaction.source === 'manual' || transaction.source === 'quick-add')
  ) {
    return 'variable';
  }
  return 'unplanned';
};

const expensesInWindow = (input: {
  asOf: Date;
  days: number;
  transactions: LedgerTransaction[];
}): LedgerTransaction[] => {
  const endDate = format(input.asOf, 'yyyy-MM-dd');
  const startDate = format(subDays(input.asOf, input.days - 1), 'yyyy-MM-dd');
  return input.transactions
    .filter(
      (transaction) =>
        transaction.type === 'expense' &&
        transaction.date >= startDate &&
        transaction.date <= endDate,
    )
    .sort(deterministicExpenseOrder);
};

export function selectRecentNotableTransactions(input: {
  asOf: Date;
  transactions: LedgerTransaction[];
  variableBudgets: VariableBudget[];
  unplannedThreshold?: number;
  topExpenseCount?: number;
  maxEntries?: number;
}): NotableExpenseTransaction[] {
  const expenses = expensesInWindow({
    asOf: input.asOf,
    days: 30,
    transactions: input.transactions,
  });
  const bucketById = new Map(
    expenses.map((transaction) => [
      transaction.id,
      planningBucketFor(transaction, input.variableBudgets),
    ]),
  );
  const selectedIds = new Set<string>();

  for (const transaction of expenses) {
    if (transaction.notes?.trim()) selectedIds.add(transaction.id);
    if (
      bucketById.get(transaction.id) === 'unplanned' &&
      transaction.amount >= (input.unplannedThreshold ?? 2_000)
    ) {
      selectedIds.add(transaction.id);
    }
  }
  for (const transaction of expenses
    .slice()
    .sort(
      (left, right) =>
        right.amount - left.amount ||
        right.date.localeCompare(left.date) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, input.topExpenseCount ?? 5)) {
    selectedIds.add(transaction.id);
  }

  return expenses
    .filter((transaction) => selectedIds.has(transaction.id))
    .slice(0, input.maxEntries ?? 15)
    .map((transaction) => ({
      transaction,
      planningBucket: bucketById.get(transaction.id) ?? 'unplanned',
    }));
}

export function selectMajorIrregularExpenses(input: {
  asOf: Date;
  transactions: LedgerTransaction[];
  variableBudgets: VariableBudget[];
  threshold?: number;
  maxEntries?: number;
}): NotableExpenseTransaction[] {
  return expensesInWindow({
    asOf: input.asOf,
    days: 180,
    transactions: input.transactions,
  })
    .filter(
      (transaction) =>
        transaction.amount >= (input.threshold ?? 10_000) &&
        planningBucketFor(transaction, input.variableBudgets) === 'unplanned',
    )
    .slice(0, input.maxEntries ?? 20)
    .map((transaction) => ({
      transaction,
      planningBucket: 'unplanned',
    }));
}
