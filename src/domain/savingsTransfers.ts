import type { Account, LedgerTransaction, SavingsGoal } from './types';

export interface SavingsTransfer {
  account: Account;
  goal?: SavingsGoal;
}

/**
 * A savings contribution is a user deposit from spendable cash into a protected
 * account. It is gross deposited money, never a withdrawal or a temporary top-up
 * for a system payment. The account relationship also recognizes old untagged
 * deposits; goalId is metadata rather than an accounting requirement.
 */
export function classifySavingsTransfer(
  transaction: LedgerTransaction,
  accounts: Account[],
  goals: SavingsGoal[] = [],
): SavingsTransfer | undefined {
  if (
    transaction.type !== 'transfer' ||
    !['manual', 'quick-add', 'goal'].includes(transaction.source) ||
    transaction.occurrenceKey ||
    transaction.plannedEventId ||
    transaction.plannedIncomeId ||
    transaction.debtPaymentId
  ) {
    return undefined;
  }

  const source = accounts.find((account) => account.id === transaction.accountId);
  const destination = accounts.find((account) => account.id === transaction.toAccountId);
  if (!source || source.protected || !destination?.protected) return undefined;

  // Archived goals and accounts retain their historical deposits. Integrity
  // requires one goal per account; ambiguous input cannot assign a goal twice.
  const linkedGoals = goals.filter((goal) => goal.linkedAccountId === destination.id);
  return { account: destination, goal: linkedGoals.length === 1 ? linkedGoals[0] : undefined };
}
