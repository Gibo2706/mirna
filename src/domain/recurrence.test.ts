import { describe, expect, it } from 'vitest';
import {
  getCommitmentOccurrences,
  getNextCommitmentOccurrence,
  getPlannedIncomeOccurrences,
} from './recurrence';
import { checking, incomeCategory, monthlyCommitment, tx } from '@/tests/factories';

describe('fixed commitment recurrence', () => {
  it('clamps due day to short months and respects inclusive start/end', () => {
    expect(getCommitmentOccurrences(monthlyCommitment, '2026-07')[0]?.date).toBe('2026-07-31');
    expect(getCommitmentOccurrences(monthlyCommitment, '2026-08')[0]?.date).toBe('2026-08-31');
    expect(getCommitmentOccurrences(monthlyCommitment, '2026-09')[0]?.date).toBe('2026-09-30');
    expect(getCommitmentOccurrences(monthlyCommitment, '2026-10')).toHaveLength(0);

    const february = { ...monthlyCommitment, startDate: '2027-01-01', endDate: undefined };
    expect(getCommitmentOccurrences(february, '2027-02')[0]?.date).toBe('2027-02-28');
  });

  it('recognizes a paid occurrence from the unique occurrence key', () => {
    const paid = tx({
      id: 'paid',
      type: 'expense',
      amount: monthlyCommitment.amount,
      source: 'commitment',
      occurrenceKey: 'commitment:2026-07-31',
    });
    expect(
      getCommitmentOccurrences(monthlyCommitment, '2026-07', [paid])[0]?.paidTransactionId,
    ).toBe('paid');
    expect(getNextCommitmentOccurrence(monthlyCommitment, '2026-07-28', [paid])?.date).toBe(
      '2026-08-31',
    );
  });

  it('supports weekly and yearly recurrence without inventing actuals', () => {
    const weekly = {
      ...monthlyCommitment,
      frequency: 'weekly' as const,
      startDate: '2026-07-03',
      endDate: '2026-07-31',
    };
    expect(getCommitmentOccurrences(weekly, '2026-07').map((value) => value.date)).toEqual([
      '2026-07-03',
      '2026-07-10',
      '2026-07-17',
      '2026-07-24',
      '2026-07-31',
    ]);
  });

  it('generates stable namespaced monthly income occurrences', () => {
    const salary = {
      id: 'salary',
      name: 'Plata',
      amount: 100_000,
      categoryId: incomeCategory.id,
      accountId: checking.id,
      frequency: 'monthly' as const,
      startDate: '2026-07-01',
      expectedDay: 31,
      active: true,
      isPrimarySalary: true,
      createdAt: '2026-07-01T00:00:00.000Z',
    };
    const february = getPlannedIncomeOccurrences(salary, '2027-02')[0];
    expect(february).toMatchObject({
      key: 'income:salary:2027-02',
      expectedDate: '2027-02-28',
      amount: 100_000,
    });
    expect(getPlannedIncomeOccurrences({ ...salary, expectedDay: 5 }, '2027-02')[0]?.key).toBe(
      february?.key,
    );
  });

  it('does not let unrelated manual income satisfy a salary plan', () => {
    const salary = {
      id: 'salary',
      name: 'Plata',
      amount: 100_000,
      categoryId: incomeCategory.id,
      accountId: checking.id,
      frequency: 'monthly' as const,
      startDate: '2026-07-01',
      active: true,
      isPrimarySalary: true,
      createdAt: '2026-07-01T00:00:00.000Z',
    };
    const manual = tx({
      id: 'gift',
      type: 'income',
      amount: 100_000,
      categoryId: incomeCategory.id,
      source: 'manual',
    });
    expect(
      getPlannedIncomeOccurrences(salary, '2026-07', [manual])[0]?.receivedTransactionId,
    ).toBeUndefined();
  });
});
