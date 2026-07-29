import { beforeEach, describe, expect, it } from 'vitest';
import { assertFinanceDataIntegrity } from '@/domain/integrity';
import { db, financeTables } from '@/db/database';
import { readFinanceData } from '@/db/queries';
import { createGenericSetupBlueprint, initializeGenericSetup } from './genericSetup';

describe('generic production onboarding setup', () => {
  beforeEach(async () => {
    await db.transaction('rw', financeTables(), async () => {
      await Promise.all(financeTables().map((table) => table.clear()));
    });
  });

  it('creates only structural generic defaults and one neutral quick-add shortcut', () => {
    const blueprint = createGenericSetupBlueprint({
      accountName: 'Tekući račun',
      currentBalance: 10_000,
      budgets: [],
    });
    expect(blueprint.accounts).toHaveLength(1);
    expect(blueprint.plannedIncomes).toEqual([]);
    expect(blueprint.goals).toEqual([]);
    expect(blueprint.fixedCommitments).toEqual([]);
    expect(blueprint.plannedEvents).toEqual([]);
    expect(blueprint.quickAddPresets).toEqual([
      expect.objectContaining({ name: 'Drugo', defaultAccountKey: 'checking' }),
    ]);
  });

  it('atomically creates a minimal usable baseline and optional linked goal account', async () => {
    await initializeGenericSetup({
      accountName: 'Moj račun',
      currentBalance: 25_000,
      monthlyIncome: 80_000,
      incomeDay: 5,
      incomeTiming: 'currentMonth',
      budgets: [{ categoryKey: 'food', amount: 15_000 }],
      goal: {
        name: 'Rezerva',
        targetAmount: 100_000,
        goalType: 'reserve',
      },
    });
    const data = await readFinanceData();
    expect(data.accounts).toHaveLength(2);
    expect(data.accounts.find((value) => value.name === 'Moj račun')?.openingBalance).toBe(25_000);
    expect(data.plannedIncomes).toHaveLength(1);
    expect(data.variableBudgets).toHaveLength(1);
    expect(data.goals).toHaveLength(1);
    expect(data.transactions).toEqual([]);
    expect(data.settings[0].onboardingCompleted).toBe(false);
    assertFinanceDataIntegrity(data);
  });

  it.each([
    ['currentMonth', '2026-07-01'],
    ['nextMonth', '2026-08-01'],
  ] as const)(
    'starts income in the selected %s without creating ledger history',
    (timing, startDate) => {
      const blueprint = createGenericSetupBlueprint(
        {
          accountName: 'Glavni račun',
          currentBalance: 73_000,
          monthlyIncome: 112_000,
          incomeTiming: timing,
          budgets: [],
        },
        new Date('2026-07-29T12:00:00.000Z'),
      );

      expect(blueprint.plannedIncomes[0].startDate).toBe(startDate);
      expect(blueprint.accounts[0].startingBalance).toBe(73_000);
    },
  );

  it.each([
    ['sinking', 'Kurs jezika'],
    ['reserve', 'Sigurnosna rezerva'],
  ] as const)('maps the natural first-goal choice to %s', (goalType, name) => {
    const blueprint = createGenericSetupBlueprint({
      accountName: 'Glavni račun',
      currentBalance: 0,
      budgets: [],
      goal: { name, targetAmount: 240_000, goalType },
    });

    expect(blueprint.goals[0].goalType).toBe(goalType);
    expect(blueprint.accounts[1]).toMatchObject({
      kind: 'savings',
      startingBalance: 0,
      protected: true,
    });
  });
});
