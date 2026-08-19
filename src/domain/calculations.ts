import { differenceInCalendarMonths, endOfMonth, isBefore, parseISO, startOfMonth } from 'date-fns';
import { getGoalLifecycle } from './goals';
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
  SavingsGoal,
  VariableBudget,
} from './types';

export function calculateAccountBalances(
  accounts: Account[],
  transactions: LedgerTransaction[],
): Record<string, number> {
  const balances = Object.fromEntries(
    accounts.map((account) => [account.id, account.openingBalance]),
  );

  for (const transaction of transactions) {
    if (transaction.type === 'transfer') {
      if (Object.hasOwn(balances, transaction.accountId)) {
        balances[transaction.accountId] -= transaction.amount;
      }
      if (transaction.toAccountId && Object.hasOwn(balances, transaction.toAccountId)) {
        balances[transaction.toAccountId] += transaction.amount;
      }
      continue;
    }

    if (!Object.hasOwn(balances, transaction.accountId)) continue;
    balances[transaction.accountId] +=
      transaction.type === 'expense' ? -transaction.amount : transaction.amount;
  }

  return balances;
}

export interface CashLedgerReconciliation {
  openingBalanceTotal: number;
  recordedIncome: number;
  recordedExpenses: number;
  netAdjustments: number;
  expectedCurrentTotal: number;
  actualCurrentTotal: number;
  difference: number;
  status: 'OK' | 'WARNING';
}

/**
 * Reconciles every account and ledger row, including archived accounts.
 * Transfers are intentionally absent from the equation because they cancel at
 * total-cash level; an invalid/missing transfer destination remains visible as
 * a reconciliation difference.
 */
export function reconcileCashLedger(
  accounts: Account[],
  transactions: LedgerTransaction[],
): CashLedgerReconciliation {
  const accountIds = new Set(accounts.map((account) => account.id));
  const inScopeTransactions = transactions.filter((transaction) =>
    accountIds.has(transaction.accountId),
  );
  const openingBalanceTotal = accounts.reduce((sum, account) => sum + account.openingBalance, 0);
  const recordedIncome = inScopeTransactions
    .filter((transaction) => transaction.type === 'income')
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const recordedExpenses = inScopeTransactions
    .filter((transaction) => transaction.type === 'expense')
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const netAdjustments = inScopeTransactions
    .filter((transaction) => transaction.type === 'adjustment')
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const expectedCurrentTotal =
    openingBalanceTotal + recordedIncome - recordedExpenses + netAdjustments;
  const actualCurrentTotal = Object.values(calculateAccountBalances(accounts, transactions)).reduce(
    (sum, balance) => sum + balance,
    0,
  );
  const difference = actualCurrentTotal - expectedCurrentTotal;

  return {
    openingBalanceTotal,
    recordedIncome,
    recordedExpenses,
    netAdjustments,
    expectedCurrentTotal,
    actualCurrentTotal,
    difference,
    status: difference === 0 ? 'OK' : 'WARNING',
  };
}

export interface MonthlyActuals {
  income: number;
  expenses: number;
  savingsContributions: number;
  transfers: number;
}

export function calculateMonthlyActuals(
  transactions: LedgerTransaction[],
  accounts: Account[],
  month: MonthKey,
): MonthlyActuals {
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  return transactions
    .filter((transaction) => transaction.date.startsWith(month))
    .reduce<MonthlyActuals>(
      (totals, transaction) => {
        if (transaction.type === 'income') totals.income += transaction.amount;
        if (transaction.type === 'expense') totals.expenses += transaction.amount;
        if (transaction.type === 'transfer') {
          totals.transfers += transaction.amount;
          const source = accountsById.get(transaction.accountId);
          const destination = transaction.toAccountId
            ? accountsById.get(transaction.toAccountId)
            : undefined;
          if (source && !source.protected && destination?.protected) {
            totals.savingsContributions += transaction.amount;
          }
        }
        return totals;
      },
      { income: 0, expenses: 0, savingsContributions: 0, transfers: 0 },
    );
}

export function getBudgetPlan(budget: VariableBudget, month: MonthKey): number {
  return budget.overrides[month] ?? budget.defaultAmount;
}

export function calculateBudgetActual(
  budget: VariableBudget,
  transactions: LedgerTransaction[],
  month: MonthKey,
): number {
  return transactions
    .filter(
      (transaction) =>
        transaction.type === 'expense' &&
        transaction.categoryId === budget.categoryId &&
        (transaction.source === 'manual' || transaction.source === 'quick-add') &&
        transaction.date.startsWith(month),
    )
    .reduce((sum, transaction) => sum + transaction.amount, 0);
}

export interface BudgetProgress {
  plan: number;
  actual: number;
  remaining: number;
  overBudget: number;
  percentage: number;
}

export function calculateBudgetProgress(
  budget: VariableBudget,
  transactions: LedgerTransaction[],
  month: MonthKey,
): BudgetProgress {
  const plan = getBudgetPlan(budget, month);
  const actual = calculateBudgetActual(budget, transactions, month);
  return {
    plan,
    actual,
    remaining: Math.max(0, plan - actual),
    overBudget: Math.max(0, actual - plan),
    percentage: plan === 0 ? (actual > 0 ? 100 : 0) : Math.round((actual / plan) * 100),
  };
}

export function getGoalContributionPlan(goal: SavingsGoal, month: MonthKey): number {
  if (goal.archived) return 0;
  if (goal.goalType === 'sinking' && goal.usedAt && month > goal.usedAt.slice(0, 7)) {
    return 0;
  }
  if (goal.contributionStartMonth && month < goal.contributionStartMonth) return 0;
  if (goal.contributionEndMonth && month > goal.contributionEndMonth) return 0;
  return goal.contributionOverrides[month] ?? goal.plannedMonthlyContribution;
}

export function getGoalActualContribution(
  goal: SavingsGoal,
  month: MonthKey,
  transactions: LedgerTransaction[],
): number {
  return transactions
    .filter(
      (transaction) =>
        transaction.type === 'transfer' &&
        transaction.goalId === goal.id &&
        transaction.toAccountId === goal.linkedAccountId &&
        transaction.date.startsWith(month),
    )
    .reduce((sum, transaction) => sum + transaction.amount, 0);
}

export interface EffectiveGoalContribution {
  configuredPlan: number;
  actualContribution: number;
  remainingMonthlyPlan: number;
  remainingTarget: number;
  effectiveRemainingContribution: number;
}

/**
 * One target-capped rule for every place that reserves a still-unfulfilled
 * goal contribution. The configured historical plan remains visible through
 * the month in which a sinking goal was used, while no further contribution is
 * reserved after the purpose was completed.
 */
export function getEffectiveGoalContribution(input: {
  goal: SavingsGoal;
  month: MonthKey;
  transactions: LedgerTransaction[];
  currentGoalBalance: number;
}): EffectiveGoalContribution {
  const configuredPlan = getGoalContributionPlan(input.goal, input.month);
  const actualContribution = getGoalActualContribution(input.goal, input.month, input.transactions);
  const remainingMonthlyPlan = Math.max(0, configuredPlan - actualContribution);
  const remainingTarget = Math.max(
    0,
    input.goal.targetAmount - Math.max(0, input.currentGoalBalance),
  );
  const purposeAlreadyCompleted =
    input.goal.goalType === 'sinking' &&
    Boolean(input.goal.usedAt && input.month >= input.goal.usedAt.slice(0, 7));
  const effectiveRemainingContribution =
    input.goal.archived || purposeAlreadyCompleted
      ? 0
      : Math.min(remainingMonthlyPlan, remainingTarget);

  return {
    configuredPlan,
    actualContribution,
    remainingMonthlyPlan,
    remainingTarget,
    effectiveRemainingContribution,
  };
}

export interface DebtStateAtMonth {
  configuredPlan: number;
  planned: number;
  actual: number;
  actualSelf: number;
  actualExternal: number;
  remainingAtStart: number;
  remainingAtEnd: number;
  remainingPlan: number;
  payoffMonth?: MonthKey;
}

export function getDebtStateAtMonth(
  debt: Debt,
  month: MonthKey,
  payments: DebtPayment[],
): DebtStateAtMonth {
  const debtPayments = payments
    .filter((payment) => payment.debtId === debt.id)
    .slice()
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
  let cumulativePaid = 0;
  let payoffMonth: MonthKey | undefined;
  for (const payment of debtPayments) {
    cumulativePaid += payment.amount;
    if (!payoffMonth && cumulativePaid >= debt.originalAmount) {
      payoffMonth = payment.date.slice(0, 7);
    }
  }

  const paidBeforeMonth = debtPayments
    .filter((payment) => payment.date.slice(0, 7) < month)
    .reduce((sum, payment) => sum + payment.amount, 0);
  const monthPayments = debtPayments.filter((payment) => payment.date.startsWith(month));
  const actual = monthPayments.reduce((sum, payment) => sum + payment.amount, 0);
  const actualSelf = monthPayments
    .filter((payment) => payment.source === 'self')
    .reduce((sum, payment) => sum + payment.amount, 0);
  const actualExternal = actual - actualSelf;
  const remainingAtStart = Math.max(0, debt.originalAmount - paidBeforeMonth);
  const remainingAtEnd = Math.max(0, remainingAtStart - actual);
  const configuredPlan = debt.paymentOverrides[month] ?? debt.plannedMonthlyPayment ?? 0;
  const planned =
    remainingAtStart === 0 || (payoffMonth && month > payoffMonth)
      ? 0
      : Math.min(configuredPlan, remainingAtStart);

  return {
    configuredPlan,
    planned,
    actual,
    actualSelf,
    actualExternal,
    remainingAtStart,
    remainingAtEnd,
    remainingPlan: Math.min(remainingAtEnd, Math.max(0, planned - actual)),
    payoffMonth,
  };
}

export function getDebtPaymentPlan(
  debt: Debt,
  month: MonthKey,
  payments: DebtPayment[] = [],
): number {
  if (payments.length === 0 && debt.status === 'paid') return 0;
  return getDebtStateAtMonth(debt, month, payments).planned;
}

export function getDebtActualPayment(debt: Debt, month: MonthKey, payments: DebtPayment[]): number {
  return payments
    .filter((payment) => payment.debtId === debt.id && payment.date.startsWith(month))
    .reduce((sum, payment) => sum + payment.amount, 0);
}

export interface PlanActualRemaining {
  planned: number;
  actual: number;
  remaining: number;
}

export type ExpensePlanningBucket = 'fixed' | 'variable' | 'event' | 'debt' | 'unplanned';

export type MonthlyExpenseClassification = Record<ExpensePlanningBucket, LedgerTransaction[]>;

export function classifyMonthlyExpenseTransactions(input: {
  month: MonthKey;
  variableBudgets: VariableBudget[];
  transactions: LedgerTransaction[];
}): MonthlyExpenseClassification {
  const variableCategoryIds = new Set(
    input.variableBudgets.filter((budget) => budget.active).map((budget) => budget.categoryId),
  );
  const result: MonthlyExpenseClassification = {
    fixed: [],
    variable: [],
    event: [],
    debt: [],
    unplanned: [],
  };

  for (const transaction of input.transactions) {
    if (transaction.type !== 'expense' || !transaction.date.startsWith(input.month)) continue;

    let bucket: ExpensePlanningBucket = 'unplanned';
    if (transaction.source === 'commitment') bucket = 'fixed';
    else if (transaction.source === 'planned-event') bucket = 'event';
    else if (transaction.source === 'debt') bucket = 'debt';
    else if (
      transaction.categoryId &&
      variableCategoryIds.has(transaction.categoryId) &&
      (transaction.source === 'manual' || transaction.source === 'quick-add')
    ) {
      bucket = 'variable';
    }
    result[bucket].push(transaction);
  }

  return result;
}

export interface ExpenseReconciliation {
  recordedTotal: number;
  classifiedTotal: number;
  difference: number;
  status: 'OK' | 'WARNING';
}

export function reconcileMonthlyExpenses(input: {
  recordedTotal: number;
  fixedActual: number;
  variableActual: number;
  eventActual: number;
  debtActual: number;
  unplannedActual: number;
}): ExpenseReconciliation {
  const classifiedTotal =
    input.fixedActual +
    input.variableActual +
    input.eventActual +
    input.debtActual +
    input.unplannedActual;
  const difference = classifiedTotal - input.recordedTotal;
  return {
    recordedTotal: input.recordedTotal,
    classifiedTotal,
    difference,
    status: difference === 0 ? 'OK' : 'WARNING',
  };
}

export interface MonthlyFinancialSummary {
  month: MonthKey;
  income: PlanActualRemaining & {
    actualPlanned: number;
    actualOther: number;
  };
  fixed: PlanActualRemaining & { remainingSpendable: number };
  variable: PlanActualRemaining & { overBudget: number };
  events: PlanActualRemaining & { remainingSpendable: number };
  savings: PlanActualRemaining;
  debt: PlanActualRemaining & { actualExternal: number };
  unplanned: {
    actual: number;
    transactionIds: string[];
  };
  expenseReconciliation: ExpenseReconciliation;
  plannedExpenses: number;
  actualExpenses: number;
  plannedSavingsAllocation: number;
  plannedCashOutflow: number;
  plannedFreeCash: number;
  remainingSpendableObligations: number;
}

export function calculateMonthlyFinancialSummary(input: {
  month: MonthKey;
  accounts: Account[];
  plannedIncomes: PlannedIncome[];
  commitments: FixedCommitment[];
  variableBudgets: VariableBudget[];
  goals: SavingsGoal[];
  debts: Debt[];
  debtPayments: DebtPayment[];
  events: PlannedEvent[];
  transactions: LedgerTransaction[];
}): MonthlyFinancialSummary {
  const transactionsById = new Map(
    input.transactions.map((transaction) => [transaction.id, transaction]),
  );
  const accountsById = new Map(input.accounts.map((account) => [account.id, account]));
  const accountBalances = calculateAccountBalances(input.accounts, input.transactions);
  const incomeOccurrences = getAllPlannedIncomeOccurrences(
    input.plannedIncomes,
    input.month,
    input.transactions,
  );
  const commitmentOccurrences = getAllCommitmentOccurrences(
    input.commitments,
    input.month,
    input.transactions,
  );
  const monthTransactions = input.transactions.filter((transaction) =>
    transaction.date.startsWith(input.month),
  );
  const expenseClassification = classifyMonthlyExpenseTransactions({
    month: input.month,
    variableBudgets: input.variableBudgets,
    transactions: input.transactions,
  });
  const sumTransactions = (transactions: LedgerTransaction[]) =>
    transactions.reduce((sum, transaction) => sum + transaction.amount, 0);

  const plannedIncome = incomeOccurrences.reduce((sum, occurrence) => sum + occurrence.amount, 0);
  const receivedPlannedIncome = incomeOccurrences.reduce((sum, occurrence) => {
    const transaction = occurrence.receivedTransactionId
      ? transactionsById.get(occurrence.receivedTransactionId)
      : undefined;
    return sum + (transaction?.amount ?? 0);
  }, 0);
  const actualIncome = monthTransactions
    .filter((transaction) => transaction.type === 'income')
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const actualPlannedIncome = monthTransactions
    .filter((transaction) => transaction.source === 'planned-income')
    .reduce((sum, transaction) => sum + transaction.amount, 0);

  const plannedFixed = commitmentOccurrences.reduce(
    (sum, occurrence) => sum + occurrence.amount,
    0,
  );
  const actualFixed = sumTransactions(expenseClassification.fixed);
  const remainingFixed = commitmentOccurrences
    .filter((occurrence) => !occurrence.paidTransactionId)
    .reduce((sum, occurrence) => sum + occurrence.amount, 0);
  const remainingSpendableFixed = commitmentOccurrences
    .filter(
      (occurrence) =>
        !occurrence.paidTransactionId && !accountsById.get(occurrence.accountId)?.protected,
    )
    .reduce((sum, occurrence) => sum + occurrence.amount, 0);

  const budgetProgress = input.variableBudgets
    .filter((budget) => budget.active)
    .map((budget) => calculateBudgetProgress(budget, input.transactions, input.month));
  const plannedVariable = budgetProgress.reduce((sum, progress) => sum + progress.plan, 0);
  const actualVariable = sumTransactions(expenseClassification.variable);
  const remainingVariable = budgetProgress.reduce((sum, progress) => sum + progress.remaining, 0);
  const overBudget = budgetProgress.reduce((sum, progress) => sum + progress.overBudget, 0);

  const monthEvents = input.events.filter((event) => event.date.startsWith(input.month));
  const plannedEvents = monthEvents.reduce((sum, event) => sum + event.plannedAmount, 0);
  const actualEvents = sumTransactions(expenseClassification.event);
  const unpaidEvents = monthEvents.filter((event) => !event.paidTransactionId);
  const remainingEvents = unpaidEvents.reduce((sum, event) => sum + event.plannedAmount, 0);

  const goalRows = input.goals
    .filter((goal) => !goal.archived)
    .map((goal) => {
      const contribution = getEffectiveGoalContribution({
        goal,
        month: input.month,
        transactions: input.transactions,
        currentGoalBalance: accountBalances[goal.linkedAccountId] ?? 0,
      });
      return {
        linkedAccountId: goal.linkedAccountId,
        planned: contribution.configuredPlan,
        actual: contribution.actualContribution,
        remaining: contribution.effectiveRemainingContribution,
      };
    });
  const plannedSavings = goalRows.reduce((sum, row) => sum + row.planned, 0);
  const actualSavings = goalRows.reduce((sum, row) => sum + row.actual, 0);
  const remainingSavings = goalRows.reduce((sum, row) => sum + row.remaining, 0);
  const remainingContributionsByAccount = new Map<string, number>();
  for (const row of goalRows) {
    remainingContributionsByAccount.set(
      row.linkedAccountId,
      (remainingContributionsByAccount.get(row.linkedAccountId) ?? 0) + row.remaining,
    );
  }
  const protectedEventsByAccount = new Map<string, number>();
  let remainingSpendableEvents = 0;
  for (const event of unpaidEvents) {
    if (!accountsById.get(event.accountId)?.protected) {
      remainingSpendableEvents += event.plannedAmount;
      continue;
    }
    protectedEventsByAccount.set(
      event.accountId,
      (protectedEventsByAccount.get(event.accountId) ?? 0) + event.plannedAmount,
    );
  }
  for (const [accountId, amount] of protectedEventsByAccount) {
    remainingSpendableEvents += Math.max(
      0,
      amount -
        Math.max(0, accountBalances[accountId] ?? 0) -
        (remainingContributionsByAccount.get(accountId) ?? 0),
    );
  }

  const debtRows = input.debts.map((debt) => {
    const state = getDebtStateAtMonth(debt, input.month, input.debtPayments);
    return {
      planned: state.planned,
      actual: state.actualSelf,
      actualExternal: state.actualExternal,
      remaining: state.remainingPlan,
    };
  });
  const plannedDebt = debtRows.reduce((sum, row) => sum + row.planned, 0);
  const actualDebt = sumTransactions(expenseClassification.debt);
  const actualExternalDebt = debtRows.reduce((sum, row) => sum + row.actualExternal, 0);
  const remainingDebt = debtRows.reduce((sum, row) => sum + row.remaining, 0);

  const actualExpenses = monthTransactions
    .filter((transaction) => transaction.type === 'expense')
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const unplannedActual = sumTransactions(expenseClassification.unplanned);
  const expenseReconciliation = reconcileMonthlyExpenses({
    recordedTotal: actualExpenses,
    fixedActual: actualFixed,
    variableActual: actualVariable,
    eventActual: actualEvents,
    debtActual: actualDebt,
    unplannedActual,
  });
  const plannedExpenses = plannedFixed + plannedVariable + plannedEvents + plannedDebt;
  const plannedCashOutflow = plannedExpenses + plannedSavings;

  return {
    month: input.month,
    income: {
      planned: plannedIncome,
      actual: actualIncome,
      actualPlanned: actualPlannedIncome,
      actualOther: actualIncome - actualPlannedIncome,
      remaining: Math.max(0, plannedIncome - receivedPlannedIncome),
    },
    fixed: {
      planned: plannedFixed,
      actual: actualFixed,
      remaining: remainingFixed,
      remainingSpendable: remainingSpendableFixed,
    },
    variable: {
      planned: plannedVariable,
      actual: actualVariable,
      remaining: remainingVariable,
      overBudget,
    },
    events: {
      planned: plannedEvents,
      actual: actualEvents,
      remaining: remainingEvents,
      remainingSpendable: remainingSpendableEvents,
    },
    savings: {
      planned: plannedSavings,
      actual: actualSavings,
      remaining: remainingSavings,
    },
    debt: {
      planned: plannedDebt,
      actual: actualDebt,
      actualExternal: actualExternalDebt,
      remaining: remainingDebt,
    },
    unplanned: {
      actual: unplannedActual,
      transactionIds: expenseClassification.unplanned.map((transaction) => transaction.id),
    },
    expenseReconciliation,
    plannedExpenses,
    actualExpenses,
    plannedSavingsAllocation: plannedSavings,
    plannedCashOutflow,
    plannedFreeCash: plannedIncome - plannedCashOutflow,
    remainingSpendableObligations:
      remainingSpendableFixed +
      remainingVariable +
      remainingSpendableEvents +
      remainingSavings +
      remainingDebt,
  };
}

export interface MonthlyPlanTotals {
  income: number;
  fixed: number;
  fixedPaid: number;
  variable: number;
  events: number;
  savings: number;
  debtPayments: number;
  totalOutflow: number;
  freeCash: number;
}

export function calculateMonthlyPlanTotals(input: {
  month: MonthKey;
  baseMonthlyIncome: number;
  commitments: FixedCommitment[];
  variableBudgets: VariableBudget[];
  goals: SavingsGoal[];
  debts: Debt[];
  debtPayments?: DebtPayment[];
  events: PlannedEvent[];
  transactions: LedgerTransaction[];
}): MonthlyPlanTotals {
  const occurrences = getAllCommitmentOccurrences(
    input.commitments,
    input.month,
    input.transactions,
  );
  const fixed = occurrences.reduce((sum, occurrence) => sum + occurrence.amount, 0);
  const fixedPaid = occurrences
    .filter((occurrence) => occurrence.paidTransactionId)
    .reduce((sum, occurrence) => sum + occurrence.amount, 0);
  const variable = input.variableBudgets
    .filter((budget) => budget.active)
    .reduce((sum, budget) => sum + getBudgetPlan(budget, input.month), 0);
  const events = input.events
    .filter((event) => event.date.startsWith(input.month))
    .reduce((sum, event) => sum + event.plannedAmount, 0);
  const savings = input.goals
    .filter((goal) => !goal.archived)
    .reduce((sum, goal) => sum + getGoalContributionPlan(goal, input.month), 0);
  const debtPayments = input.debts.reduce(
    (sum, debt) => sum + getDebtPaymentPlan(debt, input.month, input.debtPayments ?? []),
    0,
  );
  const totalOutflow = fixed + variable + events + savings + debtPayments;

  return {
    income: input.baseMonthlyIncome,
    fixed,
    fixedPaid,
    variable,
    events,
    savings,
    debtPayments,
    totalOutflow,
    freeCash: input.baseMonthlyIncome - totalOutflow,
  };
}

export interface SafeToSpendInput {
  spendableBalance: number;
  remainingFixed: number;
  remainingVariable: number;
  upcomingEvents: number;
  remainingSavingsPlan: number;
  remainingDebtPlan: number;
}

/**
 * Safe-to-spend reserves only future/unfulfilled plan amounts. Paid actuals are
 * already reflected in account balances, so subtracting their original plan
 * again would double count them.
 */
export function calculateSafeToSpend(input: SafeToSpendInput): number {
  return (
    input.spendableBalance -
    Math.max(0, input.remainingFixed) -
    Math.max(0, input.remainingVariable) -
    Math.max(0, input.upcomingEvents) -
    Math.max(0, input.remainingSavingsPlan) -
    Math.max(0, input.remainingDebtPlan)
  );
}

export function calculateGoalProgress(
  goal: SavingsGoal,
  linkedBalance: number,
  asOf: Date,
): {
  current: number;
  remaining: number;
  percentage: number;
  recommendedMonthlyContribution?: number;
  targetShortfall: number;
  lifecycle: ReturnType<typeof getGoalLifecycle>;
} {
  const current = Math.max(0, linkedBalance);
  const lifecycle = getGoalLifecycle(goal, current);
  const remaining = lifecycle === 'used' ? 0 : Math.max(0, goal.targetAmount - current);
  let recommendedMonthlyContribution: number | undefined;

  if (
    goal.targetDate &&
    remaining > 0 &&
    !isBefore(parseISO(goal.targetDate), startOfMonth(asOf))
  ) {
    const currentMonth = startOfMonth(asOf);
    const targetMonth = endOfMonth(parseISO(goal.targetDate));
    const months = Math.max(1, differenceInCalendarMonths(targetMonth, currentMonth) + 1);
    recommendedMonthlyContribution = Math.ceil(remaining / months);
  }

  return {
    current,
    remaining,
    percentage:
      lifecycle === 'used' || goal.targetAmount === 0
        ? 100
        : Math.min(100, Math.round((current / goal.targetAmount) * 100)),
    recommendedMonthlyContribution,
    targetShortfall: remaining,
    lifecycle,
  };
}

export function calculateDebtProgress(
  debt: Debt,
  payments: DebtPayment[],
): { paid: number; remaining: number; percentage: number } {
  const paid = payments
    .filter((payment) => payment.debtId === debt.id)
    .reduce((sum, payment) => sum + payment.amount, 0);
  const remaining = Math.max(0, debt.originalAmount - paid);
  return {
    paid,
    remaining,
    percentage:
      debt.originalAmount === 0
        ? 100
        : Math.min(100, Math.round((paid / debt.originalAmount) * 100)),
  };
}

export function calculateSpendableBalance(
  accounts: Account[],
  balances: Record<string, number>,
): number {
  return accounts
    .filter((account) => !account.protected && !account.archived)
    .reduce((sum, account) => sum + (balances[account.id] ?? 0), 0);
}
