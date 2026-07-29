import { addMonths, format, parseISO } from 'date-fns';
import {
  calculateBudgetProgress,
  calculateDebtProgress,
  getEffectiveGoalContribution,
  getBudgetPlan,
  getDebtActualPayment,
  getDebtPaymentPlan,
} from './calculations';
import { getGoalLifecycle, isGoalCompletionEvent } from './goals';
import { getAllCommitmentOccurrences, getAllPlannedIncomeOccurrences } from './recurrence';
import type {
  Account,
  Debt,
  DebtPayment,
  FixedCommitment,
  LedgerTransaction,
  MonthKey,
  PlannedEvent,
  PlannedIncome,
  SalaryScenario,
  SavingsGoal,
  VariableBudget,
} from './types';

export interface ForecastMonth {
  month: MonthKey;
  plannedIncome: number;
  fixedCommitments: number;
  variableBudgets: number;
  plannedEvents: number;
  savingsContributions: number;
  debtRepayments: number;
  plannedExpenses: number;
  plannedSavingsAllocation: number;
  monthlyPlanBalance: number;
  /** @deprecated Use monthlyPlanBalance. */
  projectedFreeCash: number;
  projectedSpendableBalance: number;
  projectedProtectedBalance: number;
  projectedTotalCash: number;
  /** @deprecated Use projectedSpendableBalance. */
  projectedEndBalance: number;
  projectedGoalBalances: Record<string, number>;
  projectedDebtRemaining: Record<string, number>;
  projectedGoalLifecycles: Record<string, ReturnType<typeof getGoalLifecycle>>;
  goalShortfalls: Record<string, number>;
  eventFunding: ForecastEventFunding[];
  status: 'positive' | 'tight' | 'negative';
}

export interface ForecastEventFunding {
  eventId: string;
  title: string;
  accountId: string;
  plannedAmount: number;
  fromProtected: number;
  fromSpendable: number;
  fundingGap: number;
  status: 'fully-funded' | 'partially-funded' | 'unfunded';
}

export interface ForecastInput {
  startMonth: MonthKey;
  months?: number;
  accounts: Account[];
  accountBalances: Record<string, number>;
  plannedIncomes: PlannedIncome[];
  scenario?: SalaryScenario;
  commitments: FixedCommitment[];
  variableBudgets: VariableBudget[];
  plannedEvents: PlannedEvent[];
  goals: SavingsGoal[];
  debts: Debt[];
  debtPayments: DebtPayment[];
  transactions: LedgerTransaction[];
}

const TIGHT_ABSOLUTE_BUFFER_RSD = 10_000;
const TIGHT_INCOME_RATIO = 0.1;

export function calculateForecast(input: ForecastInput): ForecastMonth[] {
  const months = input.months ?? 12;
  const activeAccounts = input.accounts.filter((account) => !account.archived);
  const accountById = new Map(activeAccounts.map((account) => [account.id, account]));
  const protectedByAccount = Object.fromEntries(
    activeAccounts
      .filter((account) => account.protected)
      .map((account) => [account.id, Math.max(0, input.accountBalances[account.id] ?? 0)]),
  );
  let runningSpendable = activeAccounts
    .filter((account) => !account.protected)
    .reduce((sum, account) => sum + (input.accountBalances[account.id] ?? 0), 0);
  const goalBalances = Object.fromEntries(
    input.goals.map((goal) => [
      goal.id,
      Math.max(0, input.accountBalances[goal.linkedAccountId] ?? 0),
    ]),
  );
  const goalUsed = Object.fromEntries(
    input.goals.map((goal) => [
      goal.id,
      goal.goalType === 'sinking' &&
        Boolean(goal.usedAt && goal.usedAt.slice(0, 7) <= input.startMonth),
    ]),
  );
  const debtRemaining = Object.fromEntries(
    input.debts.map((debt) => [debt.id, calculateDebtProgress(debt, input.debtPayments).remaining]),
  );
  const result: ForecastMonth[] = [];

  const adjustGoalBalances = (accountId: string, amount: number) => {
    for (const goal of input.goals) {
      if (goal.linkedAccountId === accountId) {
        goalBalances[goal.id] = Math.max(0, (goalBalances[goal.id] ?? 0) + amount);
      }
    }
  };

  const applyToAccount = (accountId: string, amount: number) => {
    const account = accountById.get(accountId);
    if (account?.protected) {
      if (amount >= 0) {
        protectedByAccount[accountId] = Math.max(0, (protectedByAccount[accountId] ?? 0) + amount);
        adjustGoalBalances(accountId, amount);
        return;
      }

      const requested = Math.abs(amount);
      const available = Math.max(0, protectedByAccount[accountId] ?? 0);
      const fromProtected = Math.min(requested, available);
      protectedByAccount[accountId] = available - fromProtected;
      adjustGoalBalances(accountId, -fromProtected);
      runningSpendable -= requested - fromProtected;
      return;
    }
    runningSpendable += amount;
  };

  for (let offset = 0; offset < months; offset += 1) {
    const month = format(addMonths(parseISO(`${input.startMonth}-01`), offset), 'yyyy-MM');
    const isCurrentMonth = offset === 0;
    const scenarioApplies = Boolean(input.scenario && month >= input.scenario.startMonth);

    const incomeOccurrences = getAllPlannedIncomeOccurrences(
      input.plannedIncomes,
      month,
      input.transactions,
    ).filter((occurrence) => !occurrence.receivedTransactionId);
    let plannedIncome = 0;
    for (const occurrence of incomeOccurrences) {
      const plan = input.plannedIncomes.find((value) => value.id === occurrence.plannedIncomeId);
      const amount =
        scenarioApplies && plan?.isPrimarySalary
          ? input.scenario!.monthlyAmount
          : occurrence.amount;
      plannedIncome += amount;
      applyToAccount(occurrence.accountId, amount);
    }

    const fixedOccurrences = getAllCommitmentOccurrences(
      input.commitments,
      month,
      input.transactions,
    ).filter((occurrence) => !occurrence.paidTransactionId);
    const fixedCommitments = fixedOccurrences.reduce(
      (sum, occurrence) => sum + occurrence.amount,
      0,
    );
    for (const occurrence of fixedOccurrences) {
      applyToAccount(occurrence.accountId, -occurrence.amount);
    }

    const variableBudgets = input.variableBudgets
      .filter((budget) => budget.active)
      .reduce(
        (sum, budget) =>
          sum +
          (isCurrentMonth
            ? calculateBudgetProgress(budget, input.transactions, month).remaining
            : getBudgetPlan(budget, month)),
        0,
      );
    runningSpendable -= variableBudgets;

    let savingsContributions = 0;
    for (const goal of input.goals.filter((value) => !value.archived)) {
      if (goalUsed[goal.id]) continue;
      const targetMonth = goal.targetDate?.slice(0, 7);
      if (targetMonth && month > targetMonth) continue;
      const contributionState = getEffectiveGoalContribution({
        goal,
        month,
        transactions: input.transactions,
        currentGoalBalance: Math.max(0, goalBalances[goal.id] ?? 0),
      });
      const contribution = contributionState.effectiveRemainingContribution;
      if (contribution <= 0) continue;
      savingsContributions += contribution;
      runningSpendable -= contribution;
      applyToAccount(goal.linkedAccountId, contribution);
    }

    const events = input.plannedEvents.filter(
      (event) => event.date.startsWith(month) && !event.paidTransactionId,
    );
    const plannedEvents = events.reduce((sum, event) => sum + event.plannedAmount, 0);
    const eventFunding: ForecastEventFunding[] = [];
    for (const event of events) {
      const account = accountById.get(event.accountId);
      if (account?.protected) {
        const availableProtected = Math.max(0, protectedByAccount[event.accountId] ?? 0);
        const fromProtected = Math.min(event.plannedAmount, availableProtected);
        const fundingGap = event.plannedAmount - fromProtected;
        protectedByAccount[event.accountId] = availableProtected - fromProtected;
        adjustGoalBalances(event.accountId, -fromProtected);
        runningSpendable -= fundingGap;
        eventFunding.push({
          eventId: event.id,
          title: event.title,
          accountId: event.accountId,
          plannedAmount: event.plannedAmount,
          fromProtected,
          fromSpendable: fundingGap,
          fundingGap,
          status:
            fundingGap === 0 ? 'fully-funded' : fromProtected > 0 ? 'partially-funded' : 'unfunded',
        });
      } else {
        const availableSpendable = Math.max(0, runningSpendable);
        const fromSpendable = Math.min(event.plannedAmount, availableSpendable);
        const fundingGap = event.plannedAmount - fromSpendable;
        runningSpendable -= event.plannedAmount;
        eventFunding.push({
          eventId: event.id,
          title: event.title,
          accountId: event.accountId,
          plannedAmount: event.plannedAmount,
          fromProtected: 0,
          fromSpendable,
          fundingGap,
          status:
            fundingGap === 0 ? 'fully-funded' : fromSpendable > 0 ? 'partially-funded' : 'unfunded',
        });
      }

      const linkedGoal = event.linkedGoalId
        ? input.goals.find((goal) => goal.id === event.linkedGoalId)
        : undefined;
      if (event.plannedAmount > 0 && linkedGoal && isGoalCompletionEvent(linkedGoal, event)) {
        goalUsed[linkedGoal.id] = true;
      }
    }

    let debtRepayments = 0;
    for (const debt of input.debts) {
      const remaining = Math.max(0, debtRemaining[debt.id] ?? 0);
      const scheduled = Math.max(
        0,
        getDebtPaymentPlan(debt, month, input.debtPayments) -
          (isCurrentMonth ? getDebtActualPayment(debt, month, input.debtPayments) : 0),
      );
      const payment = Math.min(scheduled, remaining);
      debtRepayments += payment;
      runningSpendable -= payment;
      debtRemaining[debt.id] = remaining - payment;
    }

    const plannedExpenses = fixedCommitments + variableBudgets + plannedEvents + debtRepayments;
    const monthlyPlanBalance = plannedIncome - plannedExpenses - savingsContributions;
    const projectedProtectedBalance = Object.values(protectedByAccount).reduce(
      (sum, balance) => sum + balance,
      0,
    );
    const goalShortfalls = Object.fromEntries(
      input.goals
        .filter(
          (goal) =>
            !goalUsed[goal.id] && Boolean(goal.targetDate && goal.targetDate.slice(0, 7) <= month),
        )
        .map((goal) => [
          goal.id,
          Math.max(0, goal.targetAmount - Math.max(0, goalBalances[goal.id] ?? 0)),
        ]),
    );
    const projectedGoalLifecycles = Object.fromEntries(
      input.goals.map((goal) => [
        goal.id,
        goalUsed[goal.id]
          ? 'used'
          : getGoalLifecycle(goal, Math.max(0, goalBalances[goal.id] ?? 0)),
      ]),
    );
    const tightThreshold = Math.max(TIGHT_ABSOLUTE_BUFFER_RSD, plannedIncome * TIGHT_INCOME_RATIO);

    result.push({
      month,
      plannedIncome,
      fixedCommitments,
      variableBudgets,
      plannedEvents,
      savingsContributions,
      debtRepayments,
      plannedExpenses,
      plannedSavingsAllocation: savingsContributions,
      monthlyPlanBalance,
      projectedFreeCash: monthlyPlanBalance,
      projectedSpendableBalance: runningSpendable,
      projectedProtectedBalance,
      projectedTotalCash: runningSpendable + projectedProtectedBalance,
      projectedEndBalance: runningSpendable,
      projectedGoalBalances: { ...goalBalances },
      projectedDebtRemaining: { ...debtRemaining },
      projectedGoalLifecycles,
      goalShortfalls,
      eventFunding,
      status:
        runningSpendable < 0
          ? 'negative'
          : runningSpendable < tightThreshold
            ? 'tight'
            : 'positive',
    });
  }

  return result;
}
