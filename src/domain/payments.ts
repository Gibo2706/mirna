import type { CommitmentOccurrence, LedgerTransaction } from './types';

/** Only independent ledger expenses can be associated with an unpaid plan. */
export function canLinkCommitmentExpense(transaction: LedgerTransaction): boolean {
  return (
    transaction.type === 'expense' &&
    (transaction.source === 'manual' || transaction.source === 'quick-add') &&
    !transaction.occurrenceKey &&
    !transaction.plannedIncomeId &&
    !transaction.plannedEventId &&
    !transaction.goalId &&
    !transaction.debtPaymentId
  );
}

export const commitmentFundingKey = (occurrenceKey: string): string =>
  `commitment-funding:${occurrenceKey}`;

export function findCommitmentPaymentCandidates(
  occurrence: CommitmentOccurrence,
  transactions: LedgerTransaction[],
): LedgerTransaction[] {
  const distance = (transaction: LedgerTransaction) =>
    Math.abs(Date.parse(transaction.date) - Date.parse(occurrence.date));
  return transactions
    .filter(canLinkCommitmentExpense)
    .sort(
      (left, right) =>
        Number(right.amount === occurrence.amount) - Number(left.amount === occurrence.amount) ||
        Number(right.categoryId === occurrence.categoryId) -
          Number(left.categoryId === occurrence.categoryId) ||
        distance(left) - distance(right) ||
        left.id.localeCompare(right.id),
    );
}
