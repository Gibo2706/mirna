import { describe, expect, it } from 'vitest';
import { emptyFinanceData, savings, tx } from '@/tests/factories';
import { getProtectedSpendingImpacts } from './protectedSpending';

describe('protected spending preview', () => {
  it('shows a direct expense reducing saved cash', () => {
    expect(
      getProtectedSpendingImpacts(emptyFinanceData(), {
        type: 'expense',
        accountId: savings.id,
        amount: 400,
      }),
    ).toMatchObject([{ before: 1000, after: 600 }]);
  });

  it('replaces an edited expense instead of charging it twice', () => {
    const data = emptyFinanceData();
    data.transactions = [tx({ id: 'old', type: 'expense', amount: 100, accountId: savings.id })];
    expect(
      getProtectedSpendingImpacts(
        data,
        {
          type: 'expense',
          accountId: savings.id,
          amount: 200,
        },
        { replacingId: 'old' },
      ),
    ).toMatchObject([{ before: 900, after: 800 }]);
  });

  it('shows savings lost when an old incoming transfer is reduced or moved', () => {
    const data = emptyFinanceData();
    data.transactions = [tx({ id: 'old', type: 'transfer', amount: 500, toAccountId: savings.id })];
    expect(
      getProtectedSpendingImpacts(
        data,
        {
          type: 'transfer',
          accountId: 'checking',
          toAccountId: savings.id,
          amount: 100,
        },
        { replacingId: 'old' },
      ),
    ).toMatchObject([{ before: 1500, after: 1100 }]);
  });

  it('does not ask for a confirmation when only notes change', () => {
    const data = emptyFinanceData();
    const original = tx({ id: 'old', type: 'expense', amount: 100, accountId: savings.id });
    data.transactions = [original];
    expect(getProtectedSpendingImpacts(data, original, { replacingId: 'old' })).toEqual([]);
  });

  it('includes the event top-up before showing the final protected balance', () => {
    expect(
      getProtectedSpendingImpacts(
        emptyFinanceData(),
        {
          type: 'expense',
          accountId: savings.id,
          amount: 1500,
        },
        { topUpAmount: 500 },
      ),
    ).toMatchObject([{ before: 1000, after: 0 }]);
  });
});
