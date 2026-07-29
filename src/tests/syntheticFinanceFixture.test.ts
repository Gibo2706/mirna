import { beforeEach, describe, expect, it } from 'vitest';
import { db, financeTables } from '@/db/database';
import {
  defaultSyntheticFinanceFixtureInput,
  loadSyntheticFinanceFixture,
} from './fixtures/syntheticFinanceFixture';

describe('synthetic finance regression fixture', () => {
  beforeEach(async () => {
    await db.transaction('rw', financeTables(), async () => {
      await Promise.all(financeTables().map((table) => table.clear()));
    });
  });

  it('keeps synthetic 2032 events and avoids relocation/lease double counting', async () => {
    await loadSyntheticFinanceFixture(
      defaultSyntheticFinanceFixtureInput(new Date('2033-03-10T12:00:00.000Z')),
    );
    const [salary, relocation, training, move, lease, mobile, workshop] = await Promise.all([
      db.plannedIncomes.get('income_primary_salary'),
      db.goals.get('goal_relocation'),
      db.plannedEvents.get('event_training_trip'),
      db.plannedEvents.get('event_relocation'),
      db.commitments.get('commit_lease'),
      db.commitments.get('commit_mobile'),
      db.plannedEvents.get('event_workshop'),
    ]);

    expect(salary).toMatchObject({
      amount: 187_000,
      expectedDay: 12,
      isPrimarySalary: true,
    });
    expect(relocation?.contributionOverrides).toEqual({
      '2032-08': 113_000,
      '2032-09': 87_000,
      '2032-10': 0,
    });
    expect(training).toMatchObject({
      date: '2032-11-19',
      plannedAmount: 96_000,
      accountId: 'acct_training',
      linkedGoalId: 'goal_training',
    });
    expect(move).toMatchObject({
      date: '2032-10-19',
      plannedAmount: 246_000,
      accountId: 'acct_relocation',
    });
    expect(lease?.startDate).toBe('2032-11-01');
    expect(mobile?.endDate).toBe('2033-12-31');
    expect(workshop?.date).toBe('2032-09-17');
  });
});
