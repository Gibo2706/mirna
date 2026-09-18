import type { Account, LedgerTransaction, SavingsGoal } from './types';
import { classifySavingsTransfer } from './savingsTransfers';

export function getGoalActivity(
  goal: Pick<SavingsGoal, 'id' | 'linkedAccountId'>,
  accounts: Account[],
  transactions: LedgerTransaction[],
): {
  transaction: LedgerTransaction;
  kind: 'contribution' | 'withdrawal' | 'spending';
  amount: number;
}[] {
  return transactions
    .flatMap<{
      transaction: LedgerTransaction;
      kind: 'contribution' | 'withdrawal' | 'spending';
      amount: number;
    }>((transaction) => {
      if (
        transaction.toAccountId === goal.linkedAccountId &&
        classifySavingsTransfer(transaction, accounts)
      ) {
        return [{ transaction, kind: 'contribution' as const, amount: transaction.amount }];
      }
      if (transaction.accountId !== goal.linkedAccountId) return [];
      if (transaction.type === 'transfer')
        return [{ transaction, kind: 'withdrawal' as const, amount: -transaction.amount }];
      if (transaction.type === 'expense')
        return [{ transaction, kind: 'spending' as const, amount: -transaction.amount }];
      return [];
    })
    .sort(
      (a, b) =>
        b.transaction.date.localeCompare(a.transaction.date) ||
        b.transaction.createdAt.localeCompare(a.transaction.createdAt) ||
        a.transaction.id.localeCompare(b.transaction.id),
    );
}
