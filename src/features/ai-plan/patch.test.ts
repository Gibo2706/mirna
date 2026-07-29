import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateAccountBalances } from '@/domain/calculations';
import { assertFinanceDataIntegrity } from '@/domain/integrity';
import type { FinanceData, FinanceSnapshot } from '@/domain/types';
import { db, financeTables } from '@/db/database';
import { readFinanceData } from '@/db/queries';
import {
  checking,
  expenseCategory,
  incomeCategory,
  savings,
  settings,
  tx,
} from '@/tests/factories';
import {
  applyPlanPatch,
  createPlanningContext,
  createPatchPrompt,
  parsePlanPatch,
  preparePlanPatch,
} from './patch';

const planData = (): FinanceData => ({
  accounts: [structuredClone(checking), structuredClone(savings)],
  transactions: [
    tx({
      id: 'history',
      type: 'expense',
      amount: 1_000,
      categoryId: expenseCategory.id,
      description: 'Istorijski sintetički trošak',
    }),
  ],
  categories: [structuredClone(expenseCategory), structuredClone(incomeCategory)],
  plannedIncomes: [
    {
      id: 'salary',
      name: 'Plata',
      amount: 100_000,
      categoryId: incomeCategory.id,
      accountId: checking.id,
      frequency: 'monthly',
      startDate: '2026-07-01',
      expectedDay: 5,
      active: true,
      isPrimarySalary: true,
      createdAt: '2026-07-01T00:00:00.000Z',
    },
  ],
  commitments: [
    {
      id: 'internet',
      name: 'Internet',
      amount: 3_000,
      categoryId: expenseCategory.id,
      accountId: checking.id,
      frequency: 'monthly',
      startDate: '2026-07-01',
      dueDay: 10,
      active: true,
      createdAt: '2026-07-01T00:00:00.000Z',
    },
  ],
  variableBudgets: [
    {
      id: 'food',
      name: 'Hrana',
      defaultAmount: 10_000,
      categoryId: expenseCategory.id,
      overrides: {},
      active: true,
      createdAt: '2026-07-01T00:00:00.000Z',
    },
  ],
  goals: [
    {
      id: 'reserve',
      name: 'Rezerva',
      emoji: '🛟',
      targetAmount: 150_000,
      linkedAccountId: savings.id,
      plannedMonthlyContribution: 5_000,
      contributionOverrides: {},
      goalType: 'reserve',
      archived: false,
      createdAt: '2026-07-01T00:00:00.000Z',
    },
  ],
  debts: [
    {
      id: 'marko',
      creditor: 'Poverilac A',
      originalAmount: 20_000,
      priority: 'medium',
      status: 'open',
      plannedMonthlyPayment: 2_000,
      paymentOverrides: {},
      createdAt: '2026-07-01T00:00:00.000Z',
    },
  ],
  debtPayments: [],
  plannedEvents: [
    {
      id: 'gift',
      title: 'Poklon',
      date: '2026-12-20',
      plannedAmount: 5_000,
      categoryId: expenseCategory.id,
      accountId: checking.id,
      createdAt: '2026-07-01T00:00:00.000Z',
    },
  ],
  presets: [
    {
      id: 'other',
      name: 'Drugo',
      emoji: '•••',
      type: 'expense',
      categoryId: expenseCategory.id,
      defaultAccountId: checking.id,
      position: 0,
      active: true,
    },
  ],
  salaryScenarios: [
    {
      id: 'scenario',
      name: 'Novi posao',
      monthlyAmount: 140_000,
      startMonth: '2027-01',
      createdAt: '2026-07-01T00:00:00.000Z',
    },
  ],
  settings: [structuredClone(settings)],
});

const snapshot = (): FinanceSnapshot => {
  const data = planData();
  return { ...data, settingsRecord: data.settings[0] };
};

const patchJson = (operations: unknown[]) => JSON.stringify({ planPatchVersion: 1, operations });

const writeData = async (data: FinanceData) => {
  await db.transaction('rw', financeTables(), async () => {
    await Promise.all(financeTables().map((table) => table.clear()));
    await db.accounts.bulkPut(data.accounts);
    await db.transactions.bulkPut(data.transactions);
    await db.categories.bulkPut(data.categories);
    await db.plannedIncomes.bulkPut(data.plannedIncomes);
    await db.commitments.bulkPut(data.commitments);
    await db.variableBudgets.bulkPut(data.variableBudgets);
    await db.goals.bulkPut(data.goals);
    await db.debts.bulkPut(data.debts);
    await db.debtPayments.bulkPut(data.debtPayments);
    await db.plannedEvents.bulkPut(data.plannedEvents);
    await db.presets.bulkPut(data.presets);
    await db.salaryScenarios.bulkPut(data.salaryScenarios);
    await db.settings.bulkPut(data.settings);
  });
};

describe('Mirna Plan Patch v1', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.transaction('rw', financeTables(), async () => {
      await Promise.all(financeTables().map((table) => table.clear()));
    });
  });

  it('previews a valid variable-budget update', () => {
    const patch = parsePlanPatch(
      patchJson([
        {
          op: 'update',
          entity: 'variableBudget',
          ref: 'variableBudget:food',
          changes: { defaultAmount: 12_000 },
        },
      ]),
    );
    const prepared = preparePlanPatch(patch, snapshot());
    expect(prepared.nextData.variableBudgets[0].defaultAmount).toBe(12_000);
    expect(prepared.operations[0].changes[0]).toMatchObject({
      before: '10.000 RSD',
      after: '12.000 RSD',
    });
  });

  it('updates goal configuration and merges contribution overrides', () => {
    const prepared = preparePlanPatch(
      parsePlanPatch(
        patchJson([
          {
            op: 'update',
            entity: 'goal',
            ref: 'goal:reserve',
            changes: {
              targetAmount: 180_000,
              contributionOverrides: { '2026-12': 10_000 },
            },
          },
        ]),
      ),
      snapshot(),
    );
    expect(prepared.nextData.goals[0]).toMatchObject({
      targetAmount: 180_000,
      contributionOverrides: { '2026-12': 10_000 },
    });
  });

  it('updates an unpaid planned event', () => {
    const prepared = preparePlanPatch(
      parsePlanPatch(
        patchJson([
          {
            op: 'update',
            entity: 'plannedEvent',
            ref: 'plannedEvent:gift',
            changes: { date: '2026-12-22', plannedAmount: 6_000 },
          },
        ]),
      ),
      snapshot(),
    );
    expect(prepared.nextData.plannedEvents[0]).toMatchObject({
      date: '2026-12-22',
      plannedAmount: 6_000,
    });
  });

  it('creates a planned event and a commitment with only existing references', () => {
    const prepared = preparePlanPatch(
      parsePlanPatch(
        patchJson([
          {
            op: 'create',
            entity: 'plannedEvent',
            value: {
              title: 'Putovanje',
              date: '2027-05-10',
              plannedAmount: 40_000,
              categoryRef: 'category:expense',
              accountRef: 'account:checking',
            },
          },
          {
            op: 'create',
            entity: 'fixedCommitment',
            value: {
              name: 'Telefon',
              amount: 2_500,
              categoryRef: 'category:expense',
              accountRef: 'account:checking',
              frequency: 'monthly',
              startDate: '2026-09-01',
              dueDay: 8,
            },
          },
        ]),
      ),
      snapshot(),
    );
    expect(prepared.nextData.plannedEvents).toHaveLength(2);
    expect(prepared.nextData.commitments).toHaveLength(2);
    assertFinanceDataIntegrity(prepared.nextData);
  });

  it('atomically prepares a new protected zero-balance account with its linked goal', () => {
    const current = snapshot();
    const balancesBefore = calculateAccountBalances(current.accounts, current.transactions);
    const prepared = preparePlanPatch(
      parsePlanPatch(
        patchJson([
          {
            op: 'addGoalWithProtectedAccount',
            value: {
              accountName: 'Štednja — stručni kurs',
              goalName: 'Stručni kurs',
              emoji: '📚',
              targetAmount: 180_000,
              plannedMonthlyContribution: 15_000,
              contributionOverrides: {},
              goalType: 'sinking',
            },
          },
        ]),
      ),
      current,
    );

    const createdAccount = prepared.nextData.accounts.at(-1);
    const createdGoal = prepared.nextData.goals.at(-1);
    expect(createdAccount).toMatchObject({
      kind: 'savings',
      openingBalance: 0,
      protected: true,
    });
    expect(createdGoal).toMatchObject({
      linkedAccountId: createdAccount?.id,
      goalType: 'sinking',
    });
    expect(prepared.nextData.transactions).toEqual(current.transactions);
    expect(calculateAccountBalances(current.accounts, current.transactions)).toEqual(
      balancesBefore,
    );
    expect(prepared.operations[0].changes).toContainEqual(
      expect.objectContaining({ after: '0 RSD — ne dodaje se novac' }),
    );
    assertFinanceDataIntegrity(prepared.nextData);
  });

  it('rejects balance injection and keeps general account creation unsupported', () => {
    expect(() =>
      parsePlanPatch(
        patchJson([
          {
            op: 'addGoalWithProtectedAccount',
            value: {
              accountName: 'Namenska štednja',
              goalName: 'Oprema',
              targetAmount: 90_000,
              plannedMonthlyContribution: 0,
              contributionOverrides: {},
              goalType: 'sinking',
              startingBalance: 90_000,
            },
          },
        ]),
      ),
    ).toThrow('startingBalance');
    expect(() =>
      parsePlanPatch(
        patchJson([
          {
            op: 'create',
            entity: 'account',
            value: { name: 'Nedozvoljen račun' },
          },
        ]),
      ),
    ).toThrow('create nije podržan');
  });

  it('archives a supported planning entity without deleting it', () => {
    const prepared = preparePlanPatch(
      parsePlanPatch(
        patchJson([
          {
            op: 'archive',
            entity: 'fixedCommitment',
            ref: 'fixedCommitment:internet',
          },
        ]),
      ),
      snapshot(),
    );
    expect(prepared.nextData.commitments[0]).toMatchObject({ id: 'internet', active: false });
  });

  it('rejects unknown refs and unsupported entities', () => {
    const unknown = parsePlanPatch(
      patchJson([
        {
          op: 'update',
          entity: 'variableBudget',
          ref: 'variableBudget:missing',
          changes: { defaultAmount: 1 },
        },
      ]),
    );
    expect(() => preparePlanPatch(unknown, snapshot())).toThrow('ne postoji');
    expect(() =>
      parsePlanPatch(
        patchJson([
          {
            op: 'update',
            entity: 'transaction',
            ref: 'transaction:history',
            changes: { amount: 0 },
          },
        ]),
      ),
    ).toThrow('entity');
  });

  it.each([
    ['transaction operation', { op: 'create', entity: 'transaction', value: {} }],
    [
      'occurrence key',
      {
        op: 'update',
        entity: 'plannedIncome',
        ref: 'plannedIncome:salary',
        changes: { occurrenceKey: 'forged' },
      },
    ],
    [
      'opening balance',
      {
        op: 'update',
        entity: 'account',
        ref: 'account:checking',
        changes: { openingBalance: 0 },
      },
    ],
    [
      'paid event state',
      {
        op: 'update',
        entity: 'plannedEvent',
        ref: 'plannedEvent:gift',
        changes: { paidTransactionId: 'tx' },
      },
    ],
    [
      'debt payment history',
      {
        op: 'update',
        entity: 'debt',
        ref: 'debt:marko',
        changes: { debtPayments: [] },
      },
    ],
    [
      'goal used state',
      {
        op: 'update',
        entity: 'goal',
        ref: 'goal:reserve',
        changes: { usedAt: '2026-12-01' },
      },
    ],
  ])('rejects forbidden %s', (_label, operation) => {
    expect(() => parsePlanPatch(patchJson([operation]))).toThrow();
  });

  it('applies reviewed operations atomically while preserving transactions and balances', async () => {
    const before = planData();
    await writeData(before);
    const beforeBalances = calculateAccountBalances(before.accounts, before.transactions);
    const prepared = preparePlanPatch(
      parsePlanPatch(
        patchJson([
          {
            op: 'update',
            entity: 'variableBudget',
            ref: 'variableBudget:food',
            changes: { defaultAmount: 12_000 },
          },
        ]),
      ),
      { ...before, settingsRecord: before.settings[0] },
    );
    await applyPlanPatch(prepared);
    const after = await readFinanceData();
    expect(after.variableBudgets[0].defaultAmount).toBe(12_000);
    expect(after.transactions).toEqual(before.transactions);
    expect(calculateAccountBalances(after.accounts, after.transactions)).toEqual(beforeBalances);
    assertFinanceDataIntegrity(after);
  });

  it('rolls back all planning writes after a forced failure', async () => {
    const before = planData();
    await writeData(before);
    const prepared = preparePlanPatch(
      parsePlanPatch(
        patchJson([
          {
            op: 'update',
            entity: 'variableBudget',
            ref: 'variableBudget:food',
            changes: { defaultAmount: 99_000 },
          },
        ]),
      ),
      { ...before, settingsRecord: before.settings[0] },
    );
    vi.spyOn(db.salaryScenarios, 'bulkPut').mockRejectedValueOnce(new Error('forced failure'));
    await expect(applyPlanPatch(prepared)).rejects.toThrow('forced failure');
    expect(await readFinanceData()).toEqual(before);
  });

  it('exports high-level planning context without actual ledger history', () => {
    const current = snapshot();
    const context = createPlanningContext(current);
    const prompt = createPatchPrompt(current);
    expect(context.accounts[0].currentBalance).toBe(99_000);
    expect(prompt).not.toContain('Istorijski sintetički trošak');
    expect(prompt).not.toContain('"transactions"');
    expect(prompt).toContain('"currentBalance": 99000');
  });
});
