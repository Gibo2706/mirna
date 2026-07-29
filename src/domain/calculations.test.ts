import { describe, expect, it } from 'vitest';
import {
  calculateAccountBalances,
  calculateBudgetProgress,
  calculateDebtProgress,
  calculateGoalProgress,
  calculateMonthlyFinancialSummary,
  calculateMonthlyActuals,
  calculateSafeToSpend,
  calculateSpendableBalance,
  getDebtStateAtMonth,
  getEffectiveGoalContribution,
  getGoalContributionPlan,
  reconcileCashLedger,
} from './calculations';
import {
  checking,
  expenseCategory,
  incomeCategory,
  monthlyCommitment,
  savings,
  tx,
} from '@/tests/factories';

describe('financial calculations', () => {
  it('derives balances and moves a transfer without creating income or expense', () => {
    const transactions = [
      tx({ id: 'salary', type: 'income', amount: 100_000 }),
      tx({ id: 'expense', type: 'expense', amount: 10_000 }),
      tx({
        id: 'transfer',
        type: 'transfer',
        amount: 20_000,
        toAccountId: savings.id,
        source: 'goal',
        goalId: 'goal',
      }),
    ];

    expect(calculateAccountBalances([checking, savings], transactions)).toEqual({
      checking: 170_000,
      savings: 21_000,
    });
    expect(calculateMonthlyActuals(transactions, [checking, savings], '2026-07')).toEqual({
      income: 100_000,
      expenses: 10_000,
      savingsContributions: 20_000,
      transfers: 20_000,
    });
  });

  it('never lets over-budget remaining increase safe-to-spend', () => {
    expect(
      calculateSafeToSpend({
        spendableBalance: 50_000,
        remainingFixed: 10_000,
        remainingVariable: -5_000,
        upcomingEvents: 3_000,
        remainingSavingsPlan: 2_000,
        remainingDebtPlan: 0,
      }),
    ).toBe(35_000);
  });

  it('uses a monthly override and only expense actuals', () => {
    const budget = {
      id: 'budget',
      name: 'Hrana',
      defaultAmount: 10_000,
      categoryId: 'food',
      overrides: { '2026-07': 12_000 },
      active: true,
      createdAt: '2026-07-01T00:00:00.000Z',
    };
    const progress = calculateBudgetProgress(
      budget,
      [
        tx({ id: 'food', type: 'expense', amount: 2_500, categoryId: 'food' }),
        tx({ id: 'refund', type: 'income', amount: 1_000, categoryId: 'food' }),
      ],
      '2026-07',
    );
    expect(progress).toEqual({
      plan: 12_000,
      actual: 2_500,
      remaining: 9_500,
      overBudget: 0,
      percentage: 21,
    });
  });

  it('calculates goal recommendation and debt progress from source records', () => {
    const goal = {
      id: 'goal',
      name: 'Laboratorijska oprema',
      emoji: '🔬',
      targetAmount: 46_800,
      targetDate: '2026-09-30',
      linkedAccountId: savings.id,
      plannedMonthlyContribution: 0,
      contributionOverrides: {},
      goalType: 'sinking' as const,
      archived: false,
      createdAt: '2026-07-01T00:00:00.000Z',
    };
    expect(calculateGoalProgress(goal, 4_200, new Date(2026, 6, 1))).toMatchObject({
      current: 4_200,
      remaining: 42_600,
      percentage: 9,
      recommendedMonthlyContribution: 14_200,
    });
    expect(
      calculateGoalProgress({ ...goal, usedAt: '2026-09-30' }, 0, new Date(2026, 9, 1)),
    ).toMatchObject({
      lifecycle: 'used',
      remaining: 0,
      targetShortfall: 0,
      percentage: 100,
    });
    expect(
      calculateGoalProgress(
        { ...goal, goalType: 'reserve', usedAt: undefined },
        0,
        new Date(2026, 9, 1),
      ),
    ).toMatchObject({
      lifecycle: 'active',
      remaining: 46_800,
      targetShortfall: 46_800,
    });

    const debt = {
      id: 'debt',
      creditor: 'Finansijska zadruga',
      originalAmount: 27_300,
      priority: 'medium' as const,
      status: 'open' as const,
      paymentOverrides: {},
      createdAt: '2026-07-01T00:00:00.000Z',
    };
    expect(
      calculateDebtProgress(debt, [
        {
          id: 'payment',
          debtId: debt.id,
          amount: 7_200,
          date: '2026-07-01',
          source: 'self' as const,
          transactionId: 'tx',
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ]),
    ).toEqual({ paid: 7_200, remaining: 20_100, percentage: 26 });
  });

  it('uses only remaining current-month obligations after recorded activity', () => {
    const currentChecking = { ...checking, openingBalance: 0 };
    const currentSavings = { ...savings, openingBalance: 0 };
    const transactions = [
      tx({
        id: 'salary-received',
        type: 'income',
        amount: 132_400,
        categoryId: incomeCategory.id,
        source: 'planned-income',
        plannedIncomeId: 'salary',
        occurrenceKey: 'income:salary:2026-07',
      }),
      tx({
        id: 'phone-paid',
        type: 'expense',
        amount: 3_730,
        categoryId: 'phone',
        source: 'commitment',
        occurrenceKey: 'phone:2026-07-31',
      }),
      tx({ id: 'food-spent', type: 'expense', amount: 4_000, categoryId: 'food' }),
      tx({
        id: 'goal-transfer',
        type: 'transfer',
        amount: 10_000,
        toAccountId: currentSavings.id,
        source: 'goal',
        goalId: 'goal',
      }),
      tx({
        id: 'debt-expense',
        type: 'expense',
        amount: 2_300,
        categoryId: 'debt',
        source: 'debt',
        debtPaymentId: 'payment',
      }),
    ];
    const summary = calculateMonthlyFinancialSummary({
      month: '2026-07',
      accounts: [currentChecking, currentSavings],
      plannedIncomes: [
        {
          id: 'salary',
          name: 'Plata',
          amount: 132_400,
          categoryId: incomeCategory.id,
          accountId: currentChecking.id,
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
          ...monthlyCommitment,
          id: 'phone',
          categoryId: 'phone',
          accountId: currentChecking.id,
        },
      ],
      variableBudgets: [
        {
          id: 'food',
          name: 'Hrana',
          defaultAmount: 10_000,
          categoryId: 'food',
          overrides: {},
          active: true,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      goals: [
        {
          id: 'goal',
          name: 'Laboratorijska oprema',
          emoji: '🔬',
          targetAmount: 48_600,
          linkedAccountId: currentSavings.id,
          plannedMonthlyContribution: 30_000,
          contributionOverrides: {},
          goalType: 'sinking',
          archived: false,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      debts: [
        {
          id: 'debt',
          creditor: 'Finansijska zadruga',
          originalAmount: 24_600,
          priority: 'medium',
          status: 'open',
          plannedMonthlyPayment: 6_400,
          paymentOverrides: {},
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      debtPayments: [
        {
          id: 'payment',
          debtId: 'debt',
          amount: 2_300,
          date: '2026-07-15',
          source: 'self',
          transactionId: 'debt-expense',
          createdAt: '2026-07-15T00:00:00.000Z',
        },
      ],
      events: [
        {
          id: 'event',
          title: 'Jednokratno',
          date: '2026-07-20',
          plannedAmount: 8_000,
          categoryId: 'event',
          accountId: currentChecking.id,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      transactions,
    });
    const balances = calculateAccountBalances([currentChecking, currentSavings], transactions);
    const safe = calculateSafeToSpend({
      spendableBalance: calculateSpendableBalance([currentChecking, currentSavings], balances),
      remainingFixed: summary.fixed.remainingSpendable,
      remainingVariable: summary.variable.remaining,
      upcomingEvents: summary.events.remainingSpendable,
      remainingSavingsPlan: summary.savings.remaining,
      remainingDebtPlan: summary.debt.remaining,
    });

    expect(summary.income.remaining).toBe(0);
    expect(summary.fixed.remaining).toBe(0);
    expect(summary.variable.remaining).toBe(6_000);
    expect(summary.savings.remaining).toBe(20_000);
    expect(summary.events.remaining).toBe(8_000);
    expect(summary.debt.remaining).toBe(4_100);
    expect(safe).toBe(74_270);
  });

  it('does not reserve a funded event from protected savings twice', () => {
    const protectedAccount = { ...savings, openingBalance: 32_400 };
    const summary = calculateMonthlyFinancialSummary({
      month: '2026-11',
      accounts: [{ ...checking, openingBalance: 20_000 }, protectedAccount],
      plannedIncomes: [],
      commitments: [],
      variableBudgets: [],
      goals: [],
      debts: [],
      debtPayments: [],
      events: [
        {
          id: 'workshop',
          title: 'Stručni seminar',
          date: '2026-11-17',
          plannedAmount: 32_400,
          categoryId: expenseCategory.id,
          accountId: protectedAccount.id,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      transactions: [],
    });
    expect(summary.events.remaining).toBe(32_400);
    expect(summary.events.remainingSpendable).toBe(0);
    expect(
      calculateSafeToSpend({
        spendableBalance: 20_000,
        remainingFixed: 0,
        remainingVariable: 0,
        upcomingEvents: summary.events.remainingSpendable,
        remainingSavingsPlan: 0,
        remainingDebtPlan: 0,
      }),
    ).toBe(20_000);
  });

  it('reserves only the uncovered part of a protected event from spendable cash', () => {
    const trainingFund = { ...savings, id: 'training-gap', openingBalance: 43_200 };
    const summary = calculateMonthlyFinancialSummary({
      month: '2027-03',
      accounts: [{ ...checking, openingBalance: 100_000 }, trainingFund],
      plannedIncomes: [],
      commitments: [],
      variableBudgets: [],
      goals: [],
      debts: [],
      debtPayments: [],
      events: [
        {
          id: 'training-gap',
          title: 'Stručna radionica',
          date: '2027-03-18',
          plannedAmount: 48_600,
          categoryId: expenseCategory.id,
          accountId: trainingFund.id,
          createdAt: '2027-01-01T00:00:00.000Z',
        },
      ],
      transactions: [],
    });

    expect(summary.events.remainingSpendable).toBe(5_400);
    expect(
      calculateSafeToSpend({
        spendableBalance: 100_000,
        remainingFixed: 0,
        remainingVariable: 0,
        upcomingEvents: summary.events.remainingSpendable,
        remainingSavingsPlan: 0,
        remainingDebtPlan: 0,
      }),
    ).toBe(94_600);
  });

  it('reconciles a synthetic month with planned and unplanned expenses', () => {
    const syntheticChecking = { ...checking, openingBalance: 5_200 };
    const syntheticSavings = { ...savings, openingBalance: 2_500 };
    const fixed = [
      ['workspace', 1_700, 'software', 8],
      ['language-course', 3_600, 'education', 18],
    ].map(([id, amount, categoryId, dueDay]) => ({
      ...monthlyCommitment,
      id: String(id),
      name: String(id),
      amount: Number(amount),
      categoryId: String(categoryId),
      accountId: syntheticChecking.id,
      startDate: '2027-04-01',
      endDate: undefined,
      dueDay: Number(dueDay),
    }));
    const variableBudgets = [
      ['groceries', 14_000],
      ['transit', 6_000],
      ['recreation', 4_000],
    ].map(([categoryId, amount]) => ({
      id: `budget-${categoryId}`,
      name: String(categoryId),
      defaultAmount: Number(amount),
      categoryId: String(categoryId),
      overrides: {},
      active: true,
      createdAt: '2027-04-01T00:00:00.000Z',
    }));
    const transactions = [
      tx({
        id: 'salary',
        type: 'income',
        amount: 132_400,
        categoryId: incomeCategory.id,
        date: '2027-04-06',
        source: 'planned-income',
        plannedIncomeId: 'salary-plan',
        occurrenceKey: 'income:salary-plan:2027-04',
      }),
      ...fixed.map((commitment) =>
        tx({
          id: `paid-${commitment.id}`,
          type: 'expense',
          amount: commitment.amount,
          categoryId: commitment.categoryId,
          date: `2027-04-${String(commitment.dueDay).padStart(2, '0')}`,
          source: 'commitment',
          occurrenceKey: `${commitment.id}:2027-04-${String(commitment.dueDay).padStart(2, '0')}`,
        }),
      ),
      tx({
        id: 'groceries',
        type: 'expense',
        amount: 12_400,
        categoryId: 'groceries',
        date: '2027-04-11',
      }),
      tx({
        id: 'transit',
        type: 'expense',
        amount: 5_700,
        categoryId: 'transit',
        date: '2027-04-13',
      }),
      tx({
        id: 'recreation',
        type: 'expense',
        amount: 3_100,
        categoryId: 'recreation',
        date: '2027-04-16',
      }),
      tx({
        id: 'equipment-repair',
        type: 'expense',
        amount: 16_800,
        categoryId: 'equipment',
        date: '2027-04-20',
        description: 'Servis projektora',
        notes: 'Zamenjen ventilator',
      }),
      tx({
        id: 'pharmacy',
        type: 'expense',
        amount: 1_900,
        categoryId: 'health',
        date: '2027-04-22',
      }),
      tx({
        id: 'workshop',
        type: 'expense',
        amount: 9_600,
        categoryId: 'education',
        date: '2027-04-24',
        source: 'planned-event',
        plannedEventId: 'workshop-event',
      }),
      tx({
        id: 'debt-payment',
        type: 'expense',
        amount: 7_500,
        categoryId: 'debt',
        date: '2027-04-26',
        source: 'debt',
        debtPaymentId: 'debt-payment-record',
      }),
    ];
    const summary = calculateMonthlyFinancialSummary({
      month: '2027-04',
      accounts: [syntheticChecking, syntheticSavings],
      plannedIncomes: [
        {
          id: 'salary-plan',
          name: 'Plata',
          amount: 132_400,
          categoryId: incomeCategory.id,
          accountId: syntheticChecking.id,
          frequency: 'monthly',
          startDate: '2027-04-01',
          expectedDay: 6,
          active: true,
          isPrimarySalary: true,
          createdAt: '2027-04-01T00:00:00.000Z',
        },
      ],
      commitments: fixed,
      variableBudgets,
      goals: [],
      debts: [
        {
          id: 'synthetic-debt',
          creditor: 'Poverilac A',
          originalAmount: 30_000,
          priority: 'medium',
          status: 'open',
          plannedMonthlyPayment: 7_500,
          paymentOverrides: {},
          createdAt: '2027-01-01T00:00:00.000Z',
        },
      ],
      debtPayments: [
        {
          id: 'debt-payment-record',
          debtId: 'synthetic-debt',
          amount: 7_500,
          date: '2027-04-26',
          source: 'self',
          transactionId: 'debt-payment',
          createdAt: '2027-04-26T00:00:00.000Z',
        },
      ],
      events: [
        {
          id: 'workshop-event',
          title: 'Stručna radionica',
          date: '2027-04-24',
          plannedAmount: 9_600,
          categoryId: 'education',
          accountId: syntheticChecking.id,
          paidTransactionId: 'workshop',
          createdAt: '2027-01-01T00:00:00.000Z',
        },
      ],
      transactions,
    });

    expect(calculateAccountBalances([syntheticChecking, syntheticSavings], transactions)).toEqual({
      checking: 75_300,
      savings: 2_500,
    });
    expect(summary).toMatchObject({
      income: { planned: 132_400, actual: 132_400 },
      fixed: { planned: 5_300, actual: 5_300 },
      variable: { planned: 24_000, actual: 21_200 },
      events: { planned: 9_600, actual: 9_600 },
      debt: { planned: 7_500, actual: 7_500 },
      unplanned: { actual: 18_700 },
      actualExpenses: 62_300,
      expenseReconciliation: {
        recordedTotal: 62_300,
        classifiedTotal: 62_300,
        difference: 0,
        status: 'OK',
      },
    });
    expect(summary.unplanned.transactionIds).toEqual(['equipment-repair', 'pharmacy']);
  });

  it('reconciles an adjustment-shaped cash ledger without treating adjustments as expenses', () => {
    const current = { ...checking, name: 'Tekući račun', openingBalance: 2_400 };
    const cash = { ...savings, id: 'cash', name: 'Keš', openingBalance: 0, protected: false };
    const transactions = [
      tx({
        id: 'salary',
        type: 'income',
        amount: 72_800,
        accountId: current.id,
        categoryId: incomeCategory.id,
      }),
      tx({
        id: 'expenses',
        type: 'expense',
        amount: 48_300,
        accountId: current.id,
        categoryId: expenseCategory.id,
      }),
      tx({
        id: 'checking-adjustment',
        type: 'adjustment',
        amount: -3_200,
        accountId: current.id,
        source: 'adjustment',
      }),
      tx({
        id: 'cash-adjustment-one',
        type: 'adjustment',
        amount: 1_500,
        accountId: cash.id,
        source: 'adjustment',
      }),
      tx({
        id: 'cash-adjustment-two',
        type: 'adjustment',
        amount: 450,
        accountId: cash.id,
        source: 'adjustment',
      }),
    ];

    expect(reconcileCashLedger([current, cash], transactions)).toEqual({
      openingBalanceTotal: 2_400,
      recordedIncome: 72_800,
      recordedExpenses: 48_300,
      netAdjustments: -1_250,
      expectedCurrentTotal: 25_650,
      actualCurrentTotal: 25_650,
      difference: 0,
      status: 'OK',
    });
    expect(calculateMonthlyActuals(transactions, [current, cash], '2026-07')).toMatchObject({
      income: 72_800,
      expenses: 48_300,
    });
  });

  it('caps the remaining goal obligation to the amount still missing from the target', () => {
    const nearlyFunded = { ...savings, openingBalance: 42_800 };
    const goal = {
      id: 'goal-cap',
      name: 'Laboratorijska oprema',
      emoji: '🔬',
      targetAmount: 48_600,
      linkedAccountId: nearlyFunded.id,
      plannedMonthlyContribution: 20_000,
      contributionOverrides: {},
      goalType: 'sinking' as const,
      archived: false,
      createdAt: '2026-07-01T00:00:00.000Z',
    };
    const contribution = getEffectiveGoalContribution({
      goal,
      month: '2026-07',
      transactions: [],
      currentGoalBalance: 42_800,
    });
    const summary = calculateMonthlyFinancialSummary({
      month: '2026-07',
      accounts: [checking, nearlyFunded],
      plannedIncomes: [],
      commitments: [],
      variableBudgets: [],
      goals: [goal],
      debts: [],
      debtPayments: [],
      events: [],
      transactions: [],
    });

    expect(contribution).toMatchObject({
      configuredPlan: 20_000,
      remainingTarget: 5_800,
      effectiveRemainingContribution: 5_800,
    });
    expect(summary.savings).toMatchObject({ planned: 20_000, actual: 0, remaining: 5_800 });
    expect(
      calculateSafeToSpend({
        spendableBalance: 100_000,
        remainingFixed: 0,
        remainingVariable: 0,
        upcomingEvents: 0,
        remainingSavingsPlan: summary.savings.remaining,
        remainingDebtPlan: 0,
      }),
    ).toBe(94_200);
  });

  it('preserves sinking-goal plans through the used month and stops future plans', () => {
    const usedGoal = {
      id: 'goal-history',
      name: 'Stručna radionica',
      emoji: '🧪',
      targetAmount: 48_600,
      linkedAccountId: savings.id,
      plannedMonthlyContribution: 27_300,
      contributionOverrides: {
        '2026-09': 15_900,
        '2026-10': 5_400,
      },
      goalType: 'sinking' as const,
      usedAt: '2026-10-01',
      archived: false,
      createdAt: '2026-07-01T00:00:00.000Z',
    };

    expect(getGoalContributionPlan(usedGoal, '2026-08')).toBe(27_300);
    expect(getGoalContributionPlan(usedGoal, '2026-09')).toBe(15_900);
    expect(getGoalContributionPlan(usedGoal, '2026-10')).toBe(5_400);
    expect(getGoalContributionPlan(usedGoal, '2026-11')).toBe(0);
  });

  it('preserves historical debt plans and stops them after the derived payoff month', () => {
    const debt = {
      id: 'debt-history',
      creditor: 'Poverilac A',
      originalAmount: 27_300,
      priority: 'medium' as const,
      status: 'paid' as const,
      plannedMonthlyPayment: 7_200,
      paymentOverrides: {},
      createdAt: '2026-07-01T00:00:00.000Z',
    };
    const payments = [
      ['aug', 7_200, '2026-08-10'],
      ['sep', 7_200, '2026-09-10'],
      ['oct', 7_200, '2026-10-10'],
      ['nov', 5_700, '2026-11-10'],
    ].map(([id, amount, date]) => ({
      id: String(id),
      debtId: debt.id,
      amount: Number(amount),
      date: String(date),
      source: 'external' as const,
      createdAt: `${String(date)}T12:00:00.000Z`,
    }));

    expect(getDebtStateAtMonth(debt, '2026-08', payments)).toMatchObject({
      planned: 7_200,
      payoffMonth: '2026-11',
    });
    expect(getDebtStateAtMonth(debt, '2026-11', payments)).toMatchObject({
      planned: 5_700,
      actual: 5_700,
      remainingPlan: 0,
    });
    expect(getDebtStateAtMonth(debt, '2026-12', payments).planned).toBe(0);
  });

  it('keeps a retroactively linked income occurrence in the plan month but cash in its actual month', () => {
    const plannedIncome = {
      id: 'salary-retro',
      name: 'Plata',
      amount: 100_000,
      categoryId: incomeCategory.id,
      accountId: checking.id,
      frequency: 'monthly' as const,
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      expectedDay: 5,
      active: true,
      isPrimarySalary: true,
      createdAt: '2026-07-01T00:00:00.000Z',
    };
    const receivedInAugust = tx({
      id: 'salary-retro-actual',
      type: 'income',
      amount: 100_000,
      date: '2026-08-01',
      categoryId: incomeCategory.id,
      source: 'planned-income',
      plannedIncomeId: plannedIncome.id,
      occurrenceKey: 'income:salary-retro:2026-07',
    });
    const input = {
      accounts: [checking],
      plannedIncomes: [plannedIncome],
      commitments: [],
      variableBudgets: [],
      goals: [],
      debts: [],
      debtPayments: [],
      events: [],
      transactions: [receivedInAugust],
    };

    const july = calculateMonthlyFinancialSummary({ month: '2026-07', ...input });
    const august = calculateMonthlyFinancialSummary({ month: '2026-08', ...input });
    expect(july.income).toMatchObject({ planned: 100_000, actual: 0, remaining: 0 });
    expect(august.income).toMatchObject({ planned: 0, actual: 100_000 });
  });
});
