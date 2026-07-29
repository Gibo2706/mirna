import { describe, expect, it } from 'vitest';
import { tx } from '@/tests/factories';
import {
  selectMajorIrregularExpenses,
  selectRecentNotableTransactions,
} from './notableTransactions';

describe('notable expense selection', () => {
  it('keeps notes, large unplanned expenses, and top expenses without rewriting data', () => {
    const result = selectRecentNotableTransactions({
      asOf: new Date('2026-07-28T12:00:00.000Z'),
      variableBudgets: [
        {
          id: 'food-budget',
          name: 'Hrana',
          defaultAmount: 10_000,
          categoryId: 'food',
          overrides: {},
          active: true,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      transactions: [
        tx({
          id: 'equipment-service',
          type: 'expense',
          amount: 18_750,
          categoryId: 'equipment',
          description: 'Servis projektora',
          notes: 'Zamenjena lampa',
        }),
        tx({ id: 'food', type: 'expense', amount: 9_000, categoryId: 'food' }),
        tx({
          id: 'small-noted',
          type: 'expense',
          amount: 100,
          categoryId: 'other',
          notes: 'Sačuvaj i mali trošak sa beleškom',
        }),
        tx({ id: 'small', type: 'expense', amount: 50, categoryId: 'other' }),
      ],
      topExpenseCount: 1,
    });

    expect(
      result.map(({ transaction, planningBucket }) => ({
        id: transaction.id,
        description: transaction.description,
        notes: transaction.notes,
        planningBucket,
      })),
    ).toEqual([
      {
        id: 'equipment-service',
        description: 'Servis projektora',
        notes: 'Zamenjena lampa',
        planningBucket: 'unplanned',
      },
      {
        id: 'small-noted',
        description: 'Test',
        notes: 'Sačuvaj i mali trošak sa beleškom',
        planningBucket: 'unplanned',
      },
    ]);
  });

  it('uses a rolling 30-day window instead of resetting at the calendar-month boundary', () => {
    const result = selectRecentNotableTransactions({
      asOf: new Date('2026-08-01T12:00:00.000Z'),
      variableBudgets: [],
      transactions: [
        tx({
          id: 'july-note',
          type: 'expense',
          amount: 500,
          date: '2026-07-10',
          notes: 'Važan kontekst',
        }),
        tx({
          id: 'too-old',
          type: 'expense',
          amount: 50_000,
          date: '2026-06-30',
          notes: 'Van prozora',
        }),
      ],
    });

    expect(result.map(({ transaction }) => transaction.id)).toEqual(['july-note']);
  });

  it('keeps only major unplanned expenses in the rolling 180-day irregular window', () => {
    const result = selectMajorIrregularExpenses({
      asOf: new Date('2026-12-31T12:00:00.000Z'),
      threshold: 10_000,
      variableBudgets: [
        {
          id: 'supplies-budget',
          name: 'Materijal',
          defaultAmount: 24_000,
          categoryId: 'supplies-budgeted',
          overrides: {},
          active: true,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      transactions: [
        tx({
          id: 'major',
          type: 'expense',
          amount: 16_800,
          date: '2026-07-19',
          categoryId: 'equipment',
        }),
        tx({
          id: 'budgeted',
          type: 'expense',
          amount: 14_500,
          date: '2026-08-15',
          categoryId: 'supplies-budgeted',
        }),
        tx({
          id: 'small',
          type: 'expense',
          amount: 9_999,
          date: '2026-10-15',
          categoryId: 'other',
        }),
      ],
    });

    expect(result.map(({ transaction }) => transaction.id)).toEqual(['major']);
  });

  it('keeps a synthetic irregular equipment expense visible across the rolling window', () => {
    const result = selectRecentNotableTransactions({
      asOf: new Date('2027-02-01T12:00:00.000Z'),
      variableBudgets: [],
      transactions: [
        tx({
          id: crypto.randomUUID(),
          type: 'expense',
          amount: 18_750,
          date: '2027-01-14',
          categoryId: 'equipment',
          description: 'Servis projektora',
          notes: 'Zamenjena lampa',
        }),
      ],
    });

    expect(result[0]?.transaction).toMatchObject({
      amount: 18_750,
      description: 'Servis projektora',
      notes: 'Zamenjena lampa',
    });
  });
});
