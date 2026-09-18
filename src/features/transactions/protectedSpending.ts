import { calculateAccountBalances } from '@/domain/calculations';
import type { FinanceData, LedgerTransaction } from '@/domain/types';
import { formatRsd } from '@/lib/format';

type DraftMovement = Pick<LedgerTransaction, 'type' | 'accountId' | 'toAccountId' | 'amount'>;

export interface ProtectedSpendingImpact {
  accountId: string;
  accountName: string;
  goalName?: string;
  targetAmount?: number;
  before: number;
  after: number;
}

/** Compare the saved ledger with a replacement, including lost incoming savings. */
export function getProtectedSpendingImpacts(
  snapshot: Pick<FinanceData, 'accounts' | 'transactions' | 'goals'>,
  movement: DraftMovement,
  options: { replacingId?: string; topUpAmount?: number } = {},
): ProtectedSpendingImpact[] {
  const before = calculateAccountBalances(snapshot.accounts, snapshot.transactions);
  const draft: LedgerTransaction = {
    ...movement,
    id: 'preview',
    date: '',
    description: '',
    source: 'manual',
    createdAt: '',
  };
  const after = calculateAccountBalances(snapshot.accounts, [
    ...snapshot.transactions.filter((row) => row.id !== options.replacingId),
    draft,
  ]);
  if (options.topUpAmount) after[movement.accountId] += options.topUpAmount;
  return snapshot.accounts
    .filter(
      (account) =>
        account.protected &&
        (after[account.id] < before[account.id] ||
          (!options.replacingId &&
            account.id === movement.accountId &&
            movement.amount > 0 &&
            (movement.type === 'expense' || movement.type === 'transfer'))),
    )
    .map((account) => {
      const goal = snapshot.goals.find((item) => item.linkedAccountId === account.id);
      return {
        accountId: account.id,
        accountName: account.name,
        goalName: goal?.name,
        targetAmount: goal?.targetAmount,
        before: before[account.id],
        after: after[account.id],
      };
    });
}

export function protectedSpendingDescription(impacts: ProtectedSpendingImpact[]): string {
  return impacts
    .map(
      (impact) =>
        `Koristiš novac iz štednje „${impact.goalName ?? impact.accountName}”. Sačuvano ${formatRsd(impact.before)}. Posle ove transakcije ${formatRsd(impact.after)}.${impact.targetAmount !== undefined ? ` Cilj ostaje ${formatRsd(impact.targetAmount)}.` : ''}`,
    )
    .join(' ');
}
