import { describe, expect, it } from 'vitest';
import { checking, savings, tx } from '@/tests/factories';
import { getGoalActivity } from './goalActivity';

describe('goal activity from ledger', () => {
  it('shows deposits, withdrawals and event use without showing temporary funding as a deposit', () => {
    const goal = { id: 'g', linkedAccountId: savings.id };
    const rows = getGoalActivity(
      goal,
      [checking, savings],
      [
        tx({ id: 'deposit', type: 'transfer', amount: 10_000, toAccountId: savings.id }),
        tx({
          id: 'withdraw',
          type: 'transfer',
          amount: 5_000,
          accountId: savings.id,
          toAccountId: checking.id,
        }),
        tx({
          id: 'topup',
          type: 'transfer',
          amount: 2_000,
          toAccountId: savings.id,
          occurrenceKey: 'event-funding:event',
        }),
        tx({
          id: 'event',
          type: 'expense',
          amount: 8_000,
          accountId: savings.id,
          plannedEventId: 'event',
          source: 'planned-event',
        }),
        tx({ id: 'unrelated', type: 'expense', amount: 100 }),
      ],
    );
    expect(rows.map((row) => [row.transaction.id, row.kind, row.amount]).sort()).toEqual([
      ['deposit', 'contribution', 10_000],
      ['event', 'spending', -8_000],
      ['withdraw', 'withdrawal', -5_000],
    ]);
  });
});
