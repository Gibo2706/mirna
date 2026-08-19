import { describe, expect, it } from 'vitest';
import { calculateForecast } from './forecast';
import {
  checking,
  expenseCategory,
  incomeCategory,
  monthlyCommitment,
  savings,
  tx,
} from '@/tests/factories';

const salary = {
  id: 'salary',
  name: 'Plata',
  amount: 100_000,
  categoryId: incomeCategory.id,
  accountId: checking.id,
  frequency: 'monthly' as const,
  startDate: '2026-07-01',
  expectedDay: 5,
  active: true,
  isPrimarySalary: true,
  createdAt: '2026-07-01T00:00:00.000Z',
};

const baseInput = {
  accounts: [checking, savings],
  accountBalances: { [checking.id]: 0, [savings.id]: 0 },
  plannedIncomes: [salary],
  debtPayments: [],
  transactions: [],
};

describe('forecast engine', () => {
  it('applies a salary scenario from the selected month without touching prior months', () => {
    const result = calculateForecast({
      startMonth: '2026-07',
      months: 4,
      ...baseInput,
      scenario: {
        id: 'new-job',
        name: 'Novi posao',
        monthlyAmount: 140_000,
        startMonth: '2026-09',
        createdAt: '2026-07-01T00:00:00.000Z',
      },
      commitments: [],
      variableBudgets: [],
      plannedEvents: [],
      goals: [],
      debts: [],
    });
    expect(result.map((value) => value.plannedIncome)).toEqual([
      100_000, 100_000, 140_000, 140_000,
    ]);
    expect(result.map((value) => value.actualIncome)).toEqual([0, 0, 0, 0]);
    expect(result.map((value) => value.totalMonthIncome)).toEqual([
      100_000, 100_000, 140_000, 140_000,
    ]);
  });

  it('represents the December registration double payment as recurrence plus a normal event', () => {
    const registration = {
      ...monthlyCommitment,
      id: 'registration',
      amount: 5_000,
      startDate: '2026-07-01',
      endDate: '2026-12-31',
      dueDay: 15,
    };
    const [december] = calculateForecast({
      startMonth: '2026-12',
      months: 1,
      ...baseInput,
      accountBalances: { [checking.id]: checking.openingBalance, [savings.id]: 0 },
      commitments: [registration],
      variableBudgets: [],
      plannedEvents: [
        {
          id: 'extra',
          title: 'Dodatna provera',
          date: '2026-12-15',
          plannedAmount: 5_000,
          categoryId: expenseCategory.id,
          accountId: checking.id,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      goals: [],
      debts: [],
    });
    expect(december?.fixedCommitments).toBe(5_000);
    expect(december?.plannedEvents).toBe(5_000);
    expect(december?.projectedFreeCash).toBe(90_000);
  });

  it('subtracts planned savings from spendable cash without labelling it as expense', () => {
    const [month] = calculateForecast({
      startMonth: '2026-07',
      months: 1,
      ...baseInput,
      commitments: [],
      variableBudgets: [],
      plannedEvents: [],
      goals: [
        {
          id: 'goal',
          name: 'Laboratorijska oprema',
          emoji: '🔬',
          targetAmount: 48_600,
          linkedAccountId: savings.id,
          plannedMonthlyContribution: 10_000,
          contributionOverrides: {},
          goalType: 'sinking',
          archived: false,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      debts: [],
    });
    expect(month?.savingsContributions).toBe(10_000);
    expect(month?.monthlyPlanBalance).toBe(90_000);
    expect(month?.projectedFreeCash).toBe(90_000);
    expect(month?.fixedCommitments + month?.variableBudgets + month?.plannedEvents).toBe(0);
  });

  it('keeps monthly plan balance distinct from the projected ending spendable balance', () => {
    const [month] = calculateForecast({
      ...baseInput,
      startMonth: '2026-07',
      months: 1,
      plannedIncomes: [],
      accountBalances: { [checking.id]: 4_750, [savings.id]: 0 },
      commitments: [],
      variableBudgets: [
        {
          id: 'remaining-budget',
          name: 'Preostali budžet',
          defaultAmount: 4_750,
          categoryId: expenseCategory.id,
          overrides: {},
          active: true,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      plannedEvents: [],
      goals: [],
      debts: [],
    });

    expect(month).toMatchObject({
      monthlyPlanBalance: -4_750,
      projectedFreeCash: -4_750,
      projectedSpendableBalance: 0,
    });
  });

  it('carries projected cash forward without inventing category-budget rollover', () => {
    const result = calculateForecast({
      ...baseInput,
      startMonth: '2026-07',
      months: 2,
      plannedIncomes: [],
      accountBalances: { [checking.id]: 20_000, [savings.id]: 0 },
      commitments: [],
      variableBudgets: [
        {
          id: 'current-buffer',
          name: 'Tekući budžet',
          defaultAmount: 0,
          categoryId: expenseCategory.id,
          overrides: { '2026-07': 3_000 },
          active: true,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      plannedEvents: [],
      goals: [],
      debts: [],
    });

    expect(result.map((month) => month.variableBudgets)).toEqual([3_000, 0]);
    expect(result.map((month) => month.projectedSpendableBalance)).toEqual([17_000, 17_000]);
  });

  it('simulates only the unfulfilled part of the current month', () => {
    const receivedSalary = tx({
      id: 'salary-received',
      type: 'income',
      amount: 100_000,
      categoryId: incomeCategory.id,
      source: 'planned-income',
      plannedIncomeId: salary.id,
      occurrenceKey: 'income:salary:2026-07',
    });
    const paidPhone = tx({
      id: 'phone-paid',
      type: 'expense',
      amount: 3_730,
      categoryId: 'phone',
      source: 'commitment',
      occurrenceKey: 'phone:2026-07-31',
    });
    const food = tx({
      id: 'food',
      type: 'expense',
      amount: 4_000,
      categoryId: 'food',
    });
    const goalTransfer = tx({
      id: 'goal-transfer',
      type: 'transfer',
      amount: 10_000,
      toAccountId: savings.id,
      source: 'goal',
      goalId: 'goal',
    });
    const debtExpense = tx({
      id: 'debt-expense',
      type: 'expense',
      amount: 2_300,
      categoryId: 'debt',
      source: 'debt',
      debtPaymentId: 'payment',
    });
    const [month] = calculateForecast({
      ...baseInput,
      startMonth: '2026-07',
      months: 1,
      accountBalances: { [checking.id]: 76_450, [savings.id]: 10_000 },
      transactions: [receivedSalary, paidPhone, food, goalTransfer, debtExpense],
      commitments: [
        {
          ...monthlyCommitment,
          id: 'phone',
          categoryId: 'phone',
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
      plannedEvents: [
        {
          id: 'event',
          title: 'Jednokratno',
          date: '2026-07-20',
          plannedAmount: 8_000,
          categoryId: expenseCategory.id,
          accountId: checking.id,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      goals: [
        {
          id: 'goal',
          name: 'Laboratorijska oprema',
          emoji: '🔬',
          targetAmount: 48_600,
          linkedAccountId: savings.id,
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
          transactionId: debtExpense.id,
          createdAt: '2026-07-15T00:00:00.000Z',
        },
      ],
    });

    expect(month).toMatchObject({
      plannedIncome: 0,
      actualIncome: 100_000,
      totalMonthIncome: 100_000,
      fixedCommitments: 0,
      variableBudgets: 6_000,
      plannedEvents: 8_000,
      savingsContributions: 20_000,
      debtRepayments: 4_100,
      projectedSpendableBalance: 38_350,
    });
  });

  it('shows received and additional income without adding either to projected cash again', () => {
    const receivedSalary = tx({
      id: 'salary-received',
      type: 'income',
      amount: 100_000,
      categoryId: incomeCategory.id,
      source: 'planned-income',
      plannedIncomeId: salary.id,
      occurrenceKey: 'income:salary:2026-07',
    });
    const additionalIncome = tx({
      id: 'additional-income',
      type: 'income',
      amount: 12_000,
      categoryId: incomeCategory.id,
    });
    const result = calculateForecast({
      ...baseInput,
      startMonth: '2026-07',
      months: 2,
      accountBalances: { [checking.id]: 112_000, [savings.id]: 0 },
      transactions: [receivedSalary, additionalIncome],
      scenario: {
        id: 'new-salary',
        name: 'Nova plata',
        monthlyAmount: 140_000,
        startMonth: '2026-07',
        createdAt: '2026-07-01T00:00:00.000Z',
      },
      commitments: [],
      variableBudgets: [],
      plannedEvents: [],
      goals: [],
      debts: [],
    });

    expect(result[0]).toMatchObject({
      plannedIncome: 0,
      actualIncome: 112_000,
      totalMonthIncome: 112_000,
      monthlyPlanBalance: 0,
      projectedSpendableBalance: 112_000,
    });
    expect(result[1]).toMatchObject({
      plannedIncome: 140_000,
      actualIncome: 0,
      totalMonthIncome: 140_000,
      monthlyPlanBalance: 140_000,
      projectedSpendableBalance: 252_000,
    });
  });

  it('caps goal funding and debt repayment statefully across future months', () => {
    const result = calculateForecast({
      ...baseInput,
      startMonth: '2026-07',
      months: 5,
      accountBalances: { [checking.id]: 0, [savings.id]: 42_800 },
      commitments: [],
      variableBudgets: [],
      plannedEvents: [],
      goals: [
        {
          id: 'goal',
          name: 'Laboratorijska oprema',
          emoji: '🔬',
          targetAmount: 48_600,
          linkedAccountId: savings.id,
          plannedMonthlyContribution: 20_000,
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
          originalAmount: 27_300,
          priority: 'medium',
          status: 'open',
          plannedMonthlyPayment: 7_200,
          paymentOverrides: {},
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
    });

    expect(result.map((month) => month.savingsContributions)).toEqual([5_800, 0, 0, 0, 0]);
    expect(result.map((month) => month.debtRepayments)).toEqual([7_200, 7_200, 7_200, 5_700, 0]);
  });

  it('spends a protected event without reducing spendable cash again', () => {
    const [month] = calculateForecast({
      ...baseInput,
      startMonth: '2027-05',
      months: 1,
      plannedIncomes: [],
      accountBalances: { [checking.id]: 20_000, [savings.id]: 32_400 },
      commitments: [],
      variableBudgets: [],
      goals: [],
      debts: [],
      plannedEvents: [
        {
          id: 'workshop',
          title: 'Stručni seminar',
          date: '2027-05-17',
          plannedAmount: 32_400,
          categoryId: expenseCategory.id,
          accountId: savings.id,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
    });
    expect(month?.projectedSpendableBalance).toBe(20_000);
    expect(month?.projectedProtectedBalance).toBe(0);
    expect(month?.eventFunding[0]).toMatchObject({
      fromProtected: 32_400,
      fromSpendable: 0,
      fundingGap: 0,
      status: 'fully-funded',
    });
  });

  it('uses protected cash first, exposes the gap, and never makes protected cash negative', () => {
    const trainingFund = {
      ...savings,
      id: 'training-fund',
      name: 'Fond za obuku',
      openingBalance: 43_200,
    };
    const emergency = { ...savings, id: 'emergency', name: 'Emergency', openingBalance: 1_000 };
    const [month] = calculateForecast({
      ...baseInput,
      startMonth: '2027-03',
      months: 1,
      accounts: [checking, trainingFund, emergency],
      accountBalances: {
        [checking.id]: 40_000,
        [trainingFund.id]: 43_200,
        emergency: 1_000,
      },
      plannedIncomes: [],
      commitments: [],
      variableBudgets: [],
      goals: [],
      debts: [],
      plannedEvents: [
        {
          id: 'training',
          title: 'Stručna radionica',
          date: '2027-03-18',
          plannedAmount: 48_600,
          categoryId: expenseCategory.id,
          accountId: trainingFund.id,
          createdAt: '2027-01-01T00:00:00.000Z',
        },
      ],
    });

    expect(month).toMatchObject({
      projectedSpendableBalance: 34_600,
      projectedProtectedBalance: 1_000,
      projectedTotalCash: 35_600,
    });
    expect(month?.eventFunding[0]).toMatchObject({
      fromProtected: 43_200,
      fromSpendable: 5_400,
      fundingGap: 5_400,
      status: 'partially-funded',
    });
    expect(month?.projectedProtectedBalance).toBeGreaterThanOrEqual(0);
  });

  it('reports an unfunded protected event without a negative protected balance', () => {
    const emptyFund = { ...savings, id: 'empty-fund', openingBalance: 0 };
    const [month] = calculateForecast({
      ...baseInput,
      startMonth: '2026-10',
      months: 1,
      accounts: [checking, emptyFund],
      accountBalances: { [checking.id]: 10_000, [emptyFund.id]: 0 },
      plannedIncomes: [],
      commitments: [],
      variableBudgets: [],
      plannedEvents: [
        {
          id: 'event',
          title: 'Događaj',
          date: '2026-10-15',
          plannedAmount: 20_000,
          categoryId: expenseCategory.id,
          accountId: emptyFund.id,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      goals: [],
      debts: [],
    });

    expect(month?.projectedProtectedBalance).toBe(0);
    expect(month?.eventFunding[0]).toMatchObject({
      fromProtected: 0,
      fundingGap: 20_000,
      status: 'unfunded',
    });
  });

  it('marks a projected sinking goal used after its purpose event and never reopens shortfall', () => {
    const trainingFund = {
      ...savings,
      id: 'training-fund',
      name: 'Fond za obuku',
      openingBalance: 48_600,
    };
    const result = calculateForecast({
      ...baseInput,
      startMonth: '2027-03',
      months: 2,
      accounts: [checking, trainingFund],
      accountBalances: { [checking.id]: 40_000, [trainingFund.id]: 48_600 },
      plannedIncomes: [],
      commitments: [],
      variableBudgets: [],
      goals: [
        {
          id: 'goal-training',
          name: 'Stručna radionica',
          emoji: '🧪',
          targetAmount: 48_600,
          targetDate: '2027-03-18',
          linkedAccountId: trainingFund.id,
          plannedMonthlyContribution: 14_400,
          contributionOverrides: {},
          goalType: 'sinking',
          archived: false,
          createdAt: '2027-01-01T00:00:00.000Z',
        },
      ],
      debts: [],
      plannedEvents: [
        {
          id: 'training',
          title: 'Stručna radionica',
          date: '2027-03-18',
          plannedAmount: 48_600,
          categoryId: expenseCategory.id,
          accountId: trainingFund.id,
          linkedGoalId: 'goal-training',
          createdAt: '2027-01-01T00:00:00.000Z',
        },
      ],
    });

    expect(result.map((month) => month.projectedGoalLifecycles['goal-training'])).toEqual([
      'used',
      'used',
    ]);
    expect(result.map((month) => month.savingsContributions)).toEqual([0, 0]);
    expect(result.map((month) => month.goalShortfalls['goal-training'] ?? 0)).toEqual([0, 0]);
  });

  it('keeps a reserve active and restores its shortfall after spending', () => {
    const reserve = { ...savings, id: 'reserve', name: 'Emergency', openingBalance: 48_600 };
    const [month] = calculateForecast({
      ...baseInput,
      startMonth: '2026-10',
      months: 1,
      accounts: [checking, reserve],
      accountBalances: { [checking.id]: 40_000, reserve: 48_600 },
      plannedIncomes: [],
      commitments: [],
      variableBudgets: [],
      goals: [
        {
          id: 'goal-reserve',
          name: 'Emergency',
          emoji: '🛟',
          targetAmount: 48_600,
          targetDate: '2026-10-15',
          linkedAccountId: reserve.id,
          plannedMonthlyContribution: 0,
          contributionOverrides: {},
          goalType: 'reserve',
          archived: false,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      debts: [],
      plannedEvents: [
        {
          id: 'emergency',
          title: 'Hitni trošak',
          date: '2026-10-15',
          plannedAmount: 48_600,
          categoryId: expenseCategory.id,
          accountId: reserve.id,
          linkedGoalId: 'goal-reserve',
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
    });

    expect(month?.projectedGoalLifecycles['goal-reserve']).toBe('active');
    expect(month?.goalShortfalls['goal-reserve']).toBe(48_600);
  });

  it('funds a linked same-month purpose event after applying the goal contribution', () => {
    const workshopFund = { ...savings, id: 'workshop-fund', openingBalance: 12_900 };
    const [month] = calculateForecast({
      ...baseInput,
      startMonth: '2027-05',
      months: 1,
      accounts: [checking, workshopFund],
      accountBalances: { [checking.id]: 100_000, [workshopFund.id]: 12_900 },
      plannedIncomes: [],
      commitments: [],
      variableBudgets: [],
      goals: [
        {
          id: 'goal-workshop',
          name: 'Stručna radionica',
          emoji: '🧪',
          targetAmount: 33_300,
          linkedAccountId: workshopFund.id,
          plannedMonthlyContribution: 20_400,
          contributionOverrides: {},
          goalType: 'sinking',
          archived: false,
          createdAt: '2027-01-01T00:00:00.000Z',
        },
      ],
      debts: [],
      plannedEvents: [
        {
          id: 'workshop',
          title: 'Stručna radionica',
          date: '2027-05-17',
          plannedAmount: 33_300,
          categoryId: expenseCategory.id,
          accountId: workshopFund.id,
          linkedGoalId: 'goal-workshop',
          createdAt: '2027-01-01T00:00:00.000Z',
        },
      ],
    });

    expect(month?.savingsContributions).toBe(20_400);
    expect(month?.eventFunding[0]).toMatchObject({
      fromProtected: 33_300,
      fromSpendable: 0,
      fundingGap: 0,
      status: 'fully-funded',
    });
    expect(month?.projectedProtectedBalance).toBe(0);
    expect(month?.projectedGoalLifecycles['goal-workshop']).toBe('used');
  });

  it('forecasts only the unfulfilled part of the current goal plan', () => {
    const goalTransfer = tx({
      id: 'partial-goal-transfer',
      type: 'transfer',
      amount: 5_000,
      toAccountId: savings.id,
      source: 'goal',
      goalId: 'goal',
    });
    const [month] = calculateForecast({
      ...baseInput,
      startMonth: '2026-07',
      months: 1,
      accountBalances: { [checking.id]: 95_000, [savings.id]: 5_000 },
      transactions: [goalTransfer],
      commitments: [],
      variableBudgets: [],
      plannedEvents: [],
      goals: [
        {
          id: 'goal',
          name: 'Put',
          emoji: '🧳',
          targetAmount: 35_000,
          linkedAccountId: savings.id,
          plannedMonthlyContribution: 15_000,
          contributionOverrides: {},
          goalType: 'sinking',
          archived: false,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      debts: [],
    });

    expect(month?.savingsContributions).toBe(10_000);
    expect(month?.projectedGoalBalances.goal).toBe(15_000);
  });

  it('keeps a synthetic workshop goal used after its final funding month', () => {
    const trainingFund = { ...savings, id: 'training-release', openingBalance: 0 };
    const result = calculateForecast({
      ...baseInput,
      startMonth: '2027-01',
      months: 4,
      accounts: [checking, trainingFund],
      accountBalances: { [checking.id]: 100_000, [trainingFund.id]: 0 },
      plannedIncomes: [],
      commitments: [],
      variableBudgets: [],
      goals: [
        {
          id: 'training-goal',
          name: 'Stručna radionica',
          emoji: '🧪',
          targetAmount: 48_600,
          targetDate: '2027-03-18',
          linkedAccountId: trainingFund.id,
          plannedMonthlyContribution: 0,
          contributionOverrides: {
            '2027-01': 27_300,
            '2027-02': 15_900,
            '2027-03': 0,
          },
          goalType: 'sinking',
          archived: false,
          createdAt: '2027-01-01T00:00:00.000Z',
        },
      ],
      debts: [],
      plannedEvents: [
        {
          id: 'training',
          title: 'Stručna radionica',
          date: '2027-03-18',
          plannedAmount: 48_600,
          categoryId: expenseCategory.id,
          accountId: trainingFund.id,
          linkedGoalId: 'training-goal',
          createdAt: '2027-01-01T00:00:00.000Z',
        },
      ],
    });

    expect(result.map((month) => month.savingsContributions)).toEqual([27_300, 15_900, 0, 0]);
    expect(result[2]?.eventFunding[0]).toMatchObject({
      fromProtected: 43_200,
      fromSpendable: 5_400,
      fundingGap: 5_400,
      status: 'partially-funded',
    });
    expect(result[2]?.projectedProtectedBalance).toBe(0);
    expect(result[3]?.projectedGoalLifecycles['training-goal']).toBe('used');
    expect(result[3]?.goalShortfalls['training-goal'] ?? 0).toBe(0);
  });
});
