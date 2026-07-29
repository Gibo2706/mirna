import {
  addMonths,
  addWeeks,
  endOfMonth,
  format,
  getDaysInMonth,
  isAfter,
  isBefore,
  isSameMonth,
  parseISO,
  startOfMonth,
} from 'date-fns';
import type {
  CommitmentOccurrence,
  FixedCommitment,
  LedgerTransaction,
  MonthKey,
  PlannedIncome,
  PlannedIncomeOccurrence,
} from './types';

const toIsoDate = (date: Date): string => format(date, 'yyyy-MM-dd');

const clampDay = (year: number, monthIndex: number, day: number): Date => {
  const base = new Date(year, monthIndex, 1);
  return new Date(year, monthIndex, Math.min(day, getDaysInMonth(base)));
};

const inCommitmentRange = (date: Date, commitment: FixedCommitment): boolean => {
  const start = parseISO(commitment.startDate);
  const end = commitment.endDate ? parseISO(commitment.endDate) : undefined;
  return !isBefore(date, start) && (!end || !isAfter(date, end));
};

export const occurrenceKey = (commitmentId: string, date: string): string =>
  `${commitmentId}:${date}`;

export const plannedIncomeOccurrenceKey = (
  plannedIncome: Pick<PlannedIncome, 'id' | 'frequency'>,
  month: MonthKey,
  expectedDate: string,
): string =>
  plannedIncome.frequency === 'monthly'
    ? `income:${plannedIncome.id}:${month}`
    : `income:${plannedIncome.id}:${expectedDate}`;

export function getCommitmentOccurrences(
  commitment: FixedCommitment,
  month: MonthKey,
  transactions: LedgerTransaction[] = [],
): CommitmentOccurrence[] {
  if (!commitment.active) return [];

  const monthStart = startOfMonth(parseISO(`${month}-01`));
  const monthEnd = endOfMonth(monthStart);
  let dates: Date[] = [];

  if (commitment.frequency === 'monthly') {
    dates = [clampDay(monthStart.getFullYear(), monthStart.getMonth(), commitment.dueDay)];
  }

  if (commitment.frequency === 'yearly') {
    const start = parseISO(commitment.startDate);
    if (start.getMonth() === monthStart.getMonth()) {
      dates = [clampDay(monthStart.getFullYear(), start.getMonth(), commitment.dueDay)];
    }
  }

  if (commitment.frequency === 'weekly') {
    let cursor = parseISO(commitment.startDate);
    while (isBefore(cursor, monthStart)) cursor = addWeeks(cursor, 1);
    while (!isAfter(cursor, monthEnd)) {
      dates.push(cursor);
      cursor = addWeeks(cursor, 1);
    }
  }

  return dates
    .filter((date) => isSameMonth(date, monthStart) && inCommitmentRange(date, commitment))
    .map((date) => {
      const isoDate = toIsoDate(date);
      const key = occurrenceKey(commitment.id, isoDate);
      const paid = transactions.find(
        (transaction) => transaction.source === 'commitment' && transaction.occurrenceKey === key,
      );
      return {
        key,
        commitmentId: commitment.id,
        name: commitment.name,
        amount: commitment.amount,
        date: isoDate,
        categoryId: commitment.categoryId,
        accountId: commitment.accountId,
        paidTransactionId: paid?.id,
      };
    });
}

export function getAllCommitmentOccurrences(
  commitments: FixedCommitment[],
  month: MonthKey,
  transactions: LedgerTransaction[] = [],
): CommitmentOccurrence[] {
  return commitments
    .flatMap((commitment) => getCommitmentOccurrences(commitment, month, transactions))
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function getNextCommitmentOccurrence(
  commitment: FixedCommitment,
  fromDate: string,
  transactions: LedgerTransaction[] = [],
): CommitmentOccurrence | undefined {
  if (!commitment.active) return undefined;
  const start = startOfMonth(parseISO(fromDate));

  for (let offset = 0; offset < 120; offset += 1) {
    const month = format(addMonths(start, offset), 'yyyy-MM');
    const next = getCommitmentOccurrences(commitment, month, transactions).find(
      (occurrence) => occurrence.date >= fromDate && !occurrence.paidTransactionId,
    );
    if (next) return next;
    if (commitment.endDate && `${month}-01` > commitment.endDate) return undefined;
  }
  return undefined;
}

export function getPlannedIncomeOccurrences(
  plannedIncome: PlannedIncome,
  month: MonthKey,
  transactions: LedgerTransaction[] = [],
): PlannedIncomeOccurrence[] {
  if (!plannedIncome.active) return [];

  const monthStart = startOfMonth(parseISO(`${month}-01`));
  const monthEnd = endOfMonth(monthStart);
  const planStart = parseISO(plannedIncome.startDate);
  const planEnd = plannedIncome.endDate ? parseISO(plannedIncome.endDate) : undefined;
  const expectedDay = plannedIncome.expectedDay ?? planStart.getDate();
  let dates: Date[] = [];

  if (plannedIncome.frequency === 'monthly') {
    dates = [clampDay(monthStart.getFullYear(), monthStart.getMonth(), expectedDay)];
  } else if (plannedIncome.frequency === 'yearly') {
    if (planStart.getMonth() === monthStart.getMonth()) {
      dates = [clampDay(monthStart.getFullYear(), planStart.getMonth(), expectedDay)];
    }
  } else {
    let cursor = planStart;
    while (isBefore(cursor, monthStart)) cursor = addWeeks(cursor, 1);
    while (!isAfter(cursor, monthEnd)) {
      dates.push(cursor);
      cursor = addWeeks(cursor, 1);
    }
  }

  const receivedByOccurrence = new Map(
    transactions
      .filter(
        (transaction) =>
          transaction.source === 'planned-income' &&
          transaction.plannedIncomeId === plannedIncome.id &&
          transaction.occurrenceKey,
      )
      .map((transaction) => [transaction.occurrenceKey!, transaction]),
  );

  return dates
    .filter(
      (date) =>
        isSameMonth(date, monthStart) &&
        !isBefore(date, planStart) &&
        (!planEnd || !isAfter(date, planEnd)),
    )
    .map((date) => {
      const expectedDate = toIsoDate(date);
      const key = plannedIncomeOccurrenceKey(plannedIncome, month, expectedDate);
      return {
        key,
        month,
        plannedIncomeId: plannedIncome.id,
        name: plannedIncome.name,
        amount: plannedIncome.amount,
        expectedDate,
        categoryId: plannedIncome.categoryId,
        accountId: plannedIncome.accountId,
        receivedTransactionId: receivedByOccurrence.get(key)?.id,
      };
    });
}

export function getAllPlannedIncomeOccurrences(
  plannedIncomes: PlannedIncome[],
  month: MonthKey,
  transactions: LedgerTransaction[] = [],
): PlannedIncomeOccurrence[] {
  return plannedIncomes
    .flatMap((plannedIncome) => getPlannedIncomeOccurrences(plannedIncome, month, transactions))
    .sort((left, right) => left.expectedDate.localeCompare(right.expectedDate));
}
