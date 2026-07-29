import { format, subDays } from 'date-fns';
import {
  calculateAccountBalances,
  calculateBudgetProgress,
  calculateDebtProgress,
  calculateGoalProgress,
  calculateMonthlyFinancialSummary,
  calculateSafeToSpend,
  calculateSpendableBalance,
  getDebtStateAtMonth,
  getEffectiveGoalContribution,
  reconcileCashLedger,
} from '@/domain/calculations';
import { inferLegacyGoalType, isGoalCompletionEvent } from '@/domain/goals';
import { calculateForecast } from '@/domain/forecast';
import { assertFinanceDataIntegrity } from '@/domain/integrity';
import {
  selectMajorIrregularExpenses,
  selectRecentNotableTransactions,
} from '@/domain/notableTransactions';
import {
  getAllCommitmentOccurrences,
  getAllPlannedIncomeOccurrences,
  getNextCommitmentOccurrence,
} from '@/domain/recurrence';
import {
  anyBackupEnvelopeSchema,
  backupEnvelopeSchema,
  type BackupEnvelope,
  type BackupEnvelopeV1,
  type BackupEnvelopeV2,
  type FinanceDataV2,
} from '@/domain/schemas';
import type { FinanceData, FinanceSnapshot } from '@/domain/types';
import { formatDate, formatMonth } from '@/lib/dates';
import { formatRsd, formatSignedRsd } from '@/lib/format';
import { APPLICATION_VERSION } from '@/lib/version';
import { db, financeTables } from '@/db/database';
import { readFinanceData } from '@/db/queries';

export const BACKUP_SCHEMA_VERSION = 3;

export function createBackupEnvelope(data: FinanceData, exportedAt = new Date()): BackupEnvelope {
  assertFinanceDataIntegrity(data);
  return backupEnvelopeSchema.parse({
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    application: {
      name: 'Mirna',
      version: APPLICATION_VERSION,
      currency: 'RSD',
    },
    data,
  });
}

export function migrateBackupV1(envelope: BackupEnvelopeV1): BackupEnvelope {
  const legacy = envelope.data;
  const settings = legacy.settings[0];
  const accounts = [...legacy.accounts];
  const categories = [...legacy.categories];
  const plannedIncomes: FinanceData['plannedIncomes'] = [];

  if (settings.baseMonthlyIncome > 0) {
    const account =
      accounts.find((value) => value.id === settings.defaultAccountId) ??
      accounts.find((value) => !value.archived && value.kind === 'checking' && !value.protected) ??
      accounts.find((value) => !value.archived && !value.protected) ??
      accounts.find((value) => !value.archived);
    let category =
      categories.find((value) => value.id === 'cat_salary') ??
      categories.find((value) => value.kind === 'income');
    if (account) {
      if (!category) {
        category = {
          id: 'cat_salary',
          name: 'Plata',
          kind: 'income',
          icon: '💼',
          color: '#4f7c67',
          archived: false,
        };
        categories.push(category);
      }
      plannedIncomes.push({
        id: 'income_primary_salary',
        name: 'Plata',
        amount: settings.baseMonthlyIncome,
        categoryId: category.id,
        accountId: account.id,
        frequency: 'monthly',
        startDate: `${settings.createdAt.slice(0, 7)}-01`,
        active: true,
        isPrimarySalary: true,
        createdAt: settings.createdAt,
      });
    }
  }

  const data: FinanceDataV2 = {
    ...legacy,
    categories,
    plannedIncomes,
    goals: legacy.goals.map((goal) => ({ ...goal, contributionOverrides: {} })),
    debts: legacy.debts.map((debt) => ({ ...debt, paymentOverrides: {} })),
    debtPayments: legacy.debtPayments.map((payment) => ({ ...payment, source: 'self' as const })),
  };
  return migrateBackupV2({
    ...envelope,
    schemaVersion: 2,
    data,
  });
}

export function migrateBackupV2(envelope: BackupEnvelopeV2): BackupEnvelope {
  const transactionsById = new Map(
    envelope.data.transactions.map((transaction) => [transaction.id, transaction]),
  );
  const goals: FinanceData['goals'] = envelope.data.goals.map((legacyGoal) => {
    const goalType = inferLegacyGoalType(legacyGoal, envelope.data.plannedEvents);
    const goal = { ...legacyGoal, goalType };
    const completion =
      goalType === 'sinking'
        ? envelope.data.plannedEvents
            .filter(
              (event) => Boolean(event.paidTransactionId) && isGoalCompletionEvent(goal, event),
            )
            .sort((left, right) => left.date.localeCompare(right.date))[0]
        : undefined;
    return {
      ...goal,
      usedAt: completion
        ? (transactionsById.get(completion.paidTransactionId ?? '')?.date ?? completion.date)
        : undefined,
    };
  });
  const data: FinanceData = { ...envelope.data, goals };
  assertFinanceDataIntegrity(data);
  return backupEnvelopeSchema.parse({
    ...envelope,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    application: { ...envelope.application, version: APPLICATION_VERSION },
    data,
  });
}

export interface ImportPreview {
  envelope: BackupEnvelope;
  counts: Record<keyof FinanceData, number>;
  sourceSchemaVersion: 1 | 2 | 3;
}

export function describeImportSchemaVersion(version: ImportPreview['sourceSchemaVersion']): string {
  switch (version) {
    case 1:
      return 'stari v1 format — biće bezbedno migriran';
    case 2:
      return 'v2 format — biće bezbedno migriran';
    case 3:
      return 'aktuelni v3 format';
  }
}

export function parseBackup(raw: string): ImportPreview {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('Fajl nije validan JSON.');
  }
  const result = anyBackupEnvelopeSchema.safeParse(json);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(
      `Backup nije validan: ${first?.path.join('.') || 'format'} — ${first?.message ?? 'greška'}`,
    );
  }
  const sourceSchemaVersion = result.data.schemaVersion;
  const envelope =
    result.data.schemaVersion === 1
      ? migrateBackupV1(result.data)
      : result.data.schemaVersion === 2
        ? migrateBackupV2(result.data)
        : result.data;
  assertFinanceDataIntegrity(envelope.data);
  const data = envelope.data;
  return {
    envelope,
    sourceSchemaVersion,
    counts: {
      accounts: data.accounts.length,
      transactions: data.transactions.length,
      categories: data.categories.length,
      plannedIncomes: data.plannedIncomes.length,
      commitments: data.commitments.length,
      variableBudgets: data.variableBudgets.length,
      goals: data.goals.length,
      debts: data.debts.length,
      debtPayments: data.debtPayments.length,
      plannedEvents: data.plannedEvents.length,
      presets: data.presets.length,
      salaryScenarios: data.salaryScenarios.length,
      settings: data.settings.length,
    },
  };
}

export async function replaceWithBackup(preview: ImportPreview): Promise<void> {
  const { data } = preview.envelope;
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
}

export async function exportFullBackup(): Promise<{ filename: string; content: string }> {
  const data = await readFinanceData();
  const now = new Date();
  return {
    filename: `finance-backup-${format(now, 'yyyy-MM-dd')}.json`,
    content: JSON.stringify(createBackupEnvelope(data, now), null, 2),
  };
}

const csvCell = (value: string | number): string =>
  `"${String(value).replaceAll('"', '""').replaceAll(/\r?\n/g, ' ')}"`;

const markdownText = (value: string): string =>
  value.replaceAll(/\r?\n/g, ' ').replaceAll('|', '\\|').trim();

const planningBucketLabels = {
  fixed: 'fixed',
  variable: 'variable',
  event: 'event',
  debt: 'debt',
  unplanned: 'unplanned/ad-hoc',
} as const;

export function createTransactionsCsv(snapshot: FinanceSnapshot): string {
  const categories = new Map(snapshot.categories.map((value) => [value.id, value.name]));
  const accounts = new Map(snapshot.accounts.map((value) => [value.id, value.name]));
  const header = [
    'date',
    'type',
    'amount',
    'category',
    'account',
    'to_account',
    'description',
    'notes',
  ];
  const rows = snapshot.transactions
    .slice()
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((transaction) => [
      transaction.date,
      transaction.type,
      transaction.amount,
      transaction.categoryId ? (categories.get(transaction.categoryId) ?? '') : '',
      accounts.get(transaction.accountId) ?? '',
      transaction.toAccountId ? (accounts.get(transaction.toAccountId) ?? '') : '',
      transaction.description,
      transaction.notes ?? '',
    ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

export function createChatGptMarkdown(snapshot: FinanceSnapshot, asOf = new Date()): string {
  const month = format(asOf, 'yyyy-MM');
  const balances = calculateAccountBalances(snapshot.accounts, snapshot.transactions);
  const summary = calculateMonthlyFinancialSummary({
    month,
    accounts: snapshot.accounts,
    plannedIncomes: snapshot.plannedIncomes,
    commitments: snapshot.commitments,
    variableBudgets: snapshot.variableBudgets,
    goals: snapshot.goals,
    debts: snapshot.debts,
    debtPayments: snapshot.debtPayments,
    events: snapshot.plannedEvents,
    transactions: snapshot.transactions,
  });
  const spendableBalance = calculateSpendableBalance(snapshot.accounts, balances);
  const budgetRows = snapshot.variableBudgets.map((budget) => ({
    budget,
    progress: calculateBudgetProgress(budget, snapshot.transactions, month),
  }));
  const safeToSpend = calculateSafeToSpend({
    spendableBalance,
    remainingFixed: summary.fixed.remainingSpendable,
    remainingVariable: summary.variable.remaining,
    upcomingEvents: summary.events.remainingSpendable,
    remainingSavingsPlan: summary.savings.remaining,
    remainingDebtPlan: summary.debt.remaining,
  });
  const activeScenario = snapshot.salaryScenarios.find(
    (scenario) => scenario.id === snapshot.settingsRecord.activeSalaryScenarioId,
  );
  const forecast = calculateForecast({
    startMonth: month,
    months: 6,
    accounts: snapshot.accounts,
    accountBalances: balances,
    plannedIncomes: snapshot.plannedIncomes,
    scenario: activeScenario,
    commitments: snapshot.commitments,
    variableBudgets: snapshot.variableBudgets,
    plannedEvents: snapshot.plannedEvents,
    goals: snapshot.goals,
    debts: snapshot.debts,
    debtPayments: snapshot.debtPayments,
    transactions: snapshot.transactions,
  });
  const recentStart = new Date(asOf);
  recentStart.setDate(recentStart.getDate() - 30);
  const recentByCategory = new Map<string, number>();
  snapshot.transactions
    .filter(
      (transaction) =>
        transaction.type === 'expense' && transaction.date >= format(recentStart, 'yyyy-MM-dd'),
    )
    .forEach((transaction) => {
      const name =
        snapshot.categories.find((category) => category.id === transaction.categoryId)?.name ??
        'Nekategorisano';
      recentByCategory.set(name, (recentByCategory.get(name) ?? 0) + transaction.amount);
    });
  const incomeOccurrences = getAllPlannedIncomeOccurrences(
    snapshot.plannedIncomes,
    month,
    snapshot.transactions,
  );
  const commitmentOccurrences = getAllCommitmentOccurrences(
    snapshot.commitments,
    month,
    snapshot.transactions,
  );
  const notableTransactions = selectRecentNotableTransactions({
    asOf,
    transactions: snapshot.transactions,
    variableBudgets: snapshot.variableBudgets,
  });
  const majorIrregularExpenses = selectMajorIrregularExpenses({
    asOf,
    transactions: snapshot.transactions,
    variableBudgets: snapshot.variableBudgets,
  });
  const adjustmentStart = format(subDays(asOf, 179), 'yyyy-MM-dd');
  const adjustmentEnd = format(asOf, 'yyyy-MM-dd');
  const balanceAdjustments = snapshot.transactions
    .filter(
      (transaction) =>
        transaction.type === 'adjustment' &&
        transaction.amount !== 0 &&
        transaction.date >= adjustmentStart &&
        transaction.date <= adjustmentEnd,
    )
    .sort(
      (left, right) =>
        right.date.localeCompare(left.date) ||
        Math.abs(right.amount) - Math.abs(left.amount) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, 20);
  const cashReconciliation = reconcileCashLedger(snapshot.accounts, snapshot.transactions);
  const upcoming = [
    ...incomeOccurrences
      .filter((occurrence) => !occurrence.receivedTransactionId)
      .map((occurrence) => ({
        date: occurrence.expectedDate,
        text: `očekivan prihod ${occurrence.name}: ${formatRsd(occurrence.amount)}`,
      })),
    ...commitmentOccurrences
      .filter((occurrence) => !occurrence.paidTransactionId)
      .map((occurrence) => ({
        date: occurrence.date,
        text: `${occurrence.name}: ${formatRsd(occurrence.amount)}`,
      })),
    ...snapshot.plannedEvents
      .filter((event) => !event.paidTransactionId && event.date >= format(asOf, 'yyyy-MM-dd'))
      .map((event) => ({
        date: event.date,
        text: `${event.title}: ${formatRsd(event.plannedAmount)}`,
      })),
  ]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((item) => `- ${formatDate(item.date)} — ${item.text}`);

  const lines: string[] = [
    '# Mirna Financial Snapshot',
    '',
    `- generatedAt: ${asOf.toISOString()}`,
    `- appVersion: ${APPLICATION_VERSION}`,
    `- backupSchemaVersion: ${BACKUP_SCHEMA_VERSION}`,
    '- currency: RSD',
    '',
    '## Current actual balances',
    '',
    ...snapshot.accounts
      .filter((account) => !account.archived)
      .map(
        (account) =>
          `- ${account.name}: ${formatRsd(balances[account.id] ?? 0)}${account.protected ? ' (protected savings)' : ''}`,
      ),
    '',
    `- Spendable actual cash: ${formatRsd(spendableBalance)}`,
    `- Protected actual cash: ${formatRsd(
      snapshot.accounts
        .filter((account) => account.protected && !account.archived)
        .reduce((sum, account) => sum + (balances[account.id] ?? 0), 0),
    )}`,
    `- Total actual cash: ${formatRsd(
      snapshot.accounts
        .filter((account) => !account.archived)
        .reduce((sum, account) => sum + (balances[account.id] ?? 0), 0),
    )}`,
    '',
    '## Balance adjustments',
    '',
    ...balanceAdjustments.flatMap((transaction) => {
      const account =
        snapshot.accounts.find((value) => value.id === transaction.accountId)?.name ??
        transaction.accountId;
      return [
        `- ${formatDate(transaction.date)} — ${markdownText(account)} — ${formatSignedRsd(transaction.amount)}`,
        `  - ${markdownText(transaction.description)}`,
        ...(transaction.notes ? [`  - note: ${markdownText(transaction.notes)}`] : []),
      ];
    }),
    ...(balanceAdjustments.length
      ? []
      : ['- No non-zero balance adjustments in the last 180 days.']),
    '',
    '## Cash ledger reconciliation',
    '',
    '- Scope: all accounts, including archived accounts, and the complete ledger. Transfers cancel at total-cash level.',
    `- Opening balances: ${formatRsd(cashReconciliation.openingBalanceTotal)}`,
    `- Recorded income: ${formatRsd(cashReconciliation.recordedIncome)}`,
    `- Recorded expenses: ${formatRsd(cashReconciliation.recordedExpenses)}`,
    `- Net balance adjustments: ${formatSignedRsd(cashReconciliation.netAdjustments)}`,
    `- Expected current total: ${formatRsd(cashReconciliation.expectedCurrentTotal)}`,
    `- Actual current total: ${formatRsd(cashReconciliation.actualCurrentTotal)}`,
    `- Difference: ${formatRsd(cashReconciliation.difference)}`,
    `- Status: ${cashReconciliation.status}`,
    '',
    '## Planned income',
    '',
    ...snapshot.plannedIncomes
      .filter((plannedIncome) => plannedIncome.active)
      .map(
        (plannedIncome) =>
          `- ${plannedIncome.name}: ${formatRsd(plannedIncome.amount)}, ${plannedIncome.frequency}, account ${snapshot.accounts.find((account) => account.id === plannedIncome.accountId)?.name ?? plannedIncome.accountId}${plannedIncome.isPrimarySalary ? ', primary salary' : ''}${plannedIncome.endDate ? `, ends ${formatDate(plannedIncome.endDate)}` : ''}`,
      ),
    '',
    `## Current month — ${formatMonth(month)}`,
    '',
    '| Bucket | Plan | Actual | Remaining |',
    '|---|---:|---:|---:|',
    `| Income | ${summary.income.planned} | ${summary.income.actual} | ${summary.income.remaining} |`,
    `| Fixed commitments | ${summary.fixed.planned} | ${summary.fixed.actual} | ${summary.fixed.remaining} |`,
    `| Variable budgets | ${summary.variable.planned} | ${summary.variable.actual} | ${summary.variable.remaining} |`,
    `| Planned events | ${summary.events.planned} | ${summary.events.actual} | ${summary.events.remaining} |`,
    `| Savings allocations | ${summary.savings.planned} | ${summary.savings.actual} | ${summary.savings.remaining} |`,
    `| Debt repayments | ${summary.debt.planned} | ${summary.debt.actual} | ${summary.debt.remaining} |`,
    `| Unplanned / other expenses | 0 | ${summary.unplanned.actual} | 0 |`,
    '',
    `- Planned expenses: ${formatRsd(summary.plannedExpenses)}`,
    `- Planned savings allocation: ${formatRsd(summary.plannedSavingsAllocation)}`,
    `- Actual expenses: ${formatRsd(summary.actualExpenses)}`,
    `- Unplanned / other actual expenses: ${formatRsd(summary.unplanned.actual)}`,
    `- Safe to spend: ${formatRsd(safeToSpend)}`,
    '',
    '### Expense reconciliation',
    '',
    `- Fixed ${summary.fixed.actual} + variable ${summary.variable.actual} + events ${summary.events.actual} + debt ${summary.debt.actual} + unplanned ${summary.unplanned.actual} = ${summary.expenseReconciliation.classifiedTotal} RSD`,
    `- Recorded expense total: ${summary.expenseReconciliation.recordedTotal} RSD`,
    `- Difference: ${summary.expenseReconciliation.difference} RSD`,
    `- Status: ${summary.expenseReconciliation.status}`,
    '',
    '## Fixed commitments',
    '',
    `- Current month total: planned ${formatRsd(summary.fixed.planned)}, paid ${formatRsd(summary.fixed.actual)}, remaining ${formatRsd(summary.fixed.remaining)}.`,
    ...snapshot.commitments.map((value) => {
      const currentOccurrences = commitmentOccurrences.filter(
        (occurrence) => occurrence.commitmentId === value.id,
      );
      const paidCount = currentOccurrences.filter((occurrence) =>
        Boolean(occurrence.paidTransactionId),
      ).length;
      const nextDue = getNextCommitmentOccurrence(
        value,
        format(asOf, 'yyyy-MM-dd'),
        snapshot.transactions,
      );
      return `- ${value.name}: ${formatRsd(value.amount)}, start ${formatDate(value.startDate)}, end ${value.endDate ? formatDate(value.endDate) : 'open'}, due day ${value.dueDay}, active in exported month ${currentOccurrences.length > 0 ? 'yes' : 'no'}, current-month state ${currentOccurrences.length ? `${paidCount}/${currentOccurrences.length} paid` : 'not scheduled'}, next due ${nextDue ? `${formatDate(nextDue.date)} (${formatRsd(nextDue.amount)})` : 'none'}`;
    }),
    '',
    '## Variable budgets',
    '',
    ...budgetRows.map(
      ({ budget, progress }) =>
        `- ${budget.name}: planned ${formatRsd(progress.plan)}, actual ${formatRsd(progress.actual)}, remaining ${formatRsd(progress.remaining)}, over budget ${formatRsd(progress.overBudget)}`,
    ),
    '',
    '## Goals',
    '',
    ...snapshot.goals
      .filter((goal) => !goal.archived)
      .map((goal) => {
        const current = balances[goal.linkedAccountId] ?? 0;
        const progress = calculateGoalProgress(goal, current, asOf);
        const contribution = getEffectiveGoalContribution({
          goal,
          month,
          transactions: snapshot.transactions,
          currentGoalBalance: current,
        });
        const projectedShortfall = forecast.find((item) => (item.goalShortfalls[goal.id] ?? 0) > 0)
          ?.goalShortfalls[goal.id];
        const storedOverrides = Object.entries(goal.contributionOverrides)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([overrideMonth, amount]) => `${overrideMonth}=${amount}`)
          .join(', ');
        return `- ${goal.emoji} ${goal.name}: type ${goal.goalType}, lifecycle ${progress.lifecycle}, balance ${formatRsd(current)}, historical target ${formatRsd(goal.targetAmount)}, target remaining ${formatRsd(progress.remaining)}, stored monthly contribution ${formatRsd(goal.plannedMonthlyContribution)}, stored overrides ${storedOverrides || 'none'}, current month configured plan ${formatRsd(contribution.configuredPlan)}, actual contribution ${formatRsd(contribution.actualContribution)}, effective remaining contribution ${formatRsd(contribution.effectiveRemainingContribution)}${goal.targetDate ? `, target ${formatDate(goal.targetDate)}` : ''}${goal.usedAt ? `, used ${formatDate(goal.usedAt)}` : ''}${projectedShortfall ? `, projected target shortfall ${formatRsd(projectedShortfall)}` : ''}`;
      }),
    '',
    '## Debts',
    '',
    ...snapshot.debts.map((debt) => {
      const progress = calculateDebtProgress(debt, snapshot.debtPayments);
      const state = getDebtStateAtMonth(debt, month, snapshot.debtPayments);
      const selfPaid = snapshot.debtPayments
        .filter((payment) => payment.debtId === debt.id && payment.source === 'self')
        .reduce((sum, payment) => sum + payment.amount, 0);
      const externalPaid = snapshot.debtPayments
        .filter((payment) => payment.debtId === debt.id && payment.source === 'external')
        .reduce((sum, payment) => sum + payment.amount, 0);
      const overrides = Object.entries(debt.paymentOverrides)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([overrideMonth, value]) => `${overrideMonth}=${value}`)
        .join(', ');
      return `- ${debt.creditor}: original ${formatRsd(debt.originalAmount)}, paid by user ${formatRsd(selfPaid)}, paid externally ${formatRsd(externalPaid)}, remaining ${formatRsd(progress.remaining)}, current month plan ${formatRsd(state.planned)}, actual ${formatRsd(state.actual)}, remaining plan ${formatRsd(state.remainingPlan)}, payoff month ${state.payoffMonth ?? 'not paid'}, future payment plan default ${formatRsd(debt.plannedMonthlyPayment ?? 0)}${overrides ? `, overrides ${overrides}` : ''}`;
    }),
    '',
    '## Planned events',
    '',
    ...snapshot.plannedEvents
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((event) => {
        const linkedGoal = event.linkedGoalId
          ? snapshot.goals.find((goal) => goal.id === event.linkedGoalId)?.name
          : undefined;
        const projectedMonth = forecast.find((item) => item.month === event.date.slice(0, 7));
        const funding = projectedMonth?.eventFunding.find((item) => item.eventId === event.id);
        return `- ${formatDate(event.date)} — ${event.title}: plan ${formatRsd(event.plannedAmount)}, ${event.paidTransactionId ? 'paid' : 'unpaid'}, funding account ${snapshot.accounts.find((account) => account.id === event.accountId)?.name ?? event.accountId}, linked goal ${linkedGoal ?? 'none'}, projected funding ${funding ? funding.status : event.paidTransactionId ? 'settled' : 'outside forecast'}, projected funded ${funding ? formatRsd(funding.plannedAmount - funding.fundingGap) : 'n/a'}, funding gap ${funding ? formatRsd(funding.fundingGap) : 'n/a'}`;
      }),
    '',
    '## Upcoming',
    '',
    ...upcoming,
    '',
    '## Recent notable transactions',
    '',
    ...notableTransactions.map(({ transaction, planningBucket }) => {
      const category =
        snapshot.categories.find((value) => value.id === transaction.categoryId)?.name ??
        'Nekategorisano';
      return `- ${formatDate(transaction.date)} — ${formatRsd(transaction.amount)} — ${markdownText(category)} — ${markdownText(transaction.description)}${transaction.notes ? ` — note: ${markdownText(transaction.notes)}` : ''} — classification: ${planningBucketLabels[planningBucket]}`;
    }),
    ...(notableTransactions.length ? [] : ['- No notable expenses in the rolling 30-day window.']),
    '',
    '## Major irregular expenses — last 180 days',
    '',
    ...majorIrregularExpenses.map(({ transaction, planningBucket }) => {
      const category =
        snapshot.categories.find((value) => value.id === transaction.categoryId)?.name ??
        'Nekategorisano';
      return `- ${formatDate(transaction.date)} — ${formatRsd(transaction.amount)} — ${markdownText(category)} — ${markdownText(transaction.description)}${transaction.notes ? ` — note: ${markdownText(transaction.notes)}` : ''} — classification: ${planningBucketLabels[planningBucket]}`;
    }),
    ...(majorIrregularExpenses.length
      ? []
      : ['- No unplanned/ad-hoc expense at or above 10,000 RSD in this window.']),
    '',
    '## Last 30 days',
    '',
    ...[...recentByCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => `- ${name}: ${formatRsd(value)}`),
    '',
    '## Forecast',
    '',
    '| Month | Income | Expenses | Savings | Debt | Monthly plan balance | Ending spendable | Ending protected | Ending total | Warnings |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ...forecast.map((item) => {
      const shortfall = Object.values(item.goalShortfalls).reduce((sum, value) => sum + value, 0);
      const warning = [
        item.status === 'negative'
          ? 'negative spendable cash'
          : item.status === 'tight'
            ? 'tight buffer'
            : '',
        shortfall > 0 ? `goal shortfall ${shortfall} RSD` : '',
        ...item.eventFunding
          .filter((funding) => funding.fundingGap > 0)
          .map(
            (funding) =>
              `${funding.title} funding gap ${funding.fundingGap} RSD (${funding.status})`,
          ),
      ]
        .filter(Boolean)
        .join('; ');
      return `| ${item.month} | ${item.plannedIncome} | ${item.plannedExpenses} | ${item.savingsContributions} | ${item.debtRepayments} | ${item.monthlyPlanBalance} | ${item.projectedSpendableBalance} | ${item.projectedProtectedBalance} | ${item.projectedTotalCash} | ${warning || 'none'} |`;
    }),
    '',
    '## Assumptions',
    '',
    `- Active forecast scenario: ${activeScenario ? `${activeScenario.name} — ${formatRsd(activeScenario.monthlyAmount)} from ${activeScenario.startMonth}` : 'none'}. It overrides only primary salary in forecast.`,
    '- Currency is RSD in integer dinars; no live FX conversion.',
    '- Transfers between accounts are not income or expense.',
    '- Transfers to protected savings reduce spendable cash but are not expenses.',
    '- Monthly plan balance is planned income minus expenses, debt payments and savings allocations; it is not the ending account balance.',
    '- Current-month forecast starts from actual balances and simulates only remaining plan.',
    '- Unscheduled debt repayments are not assumed.',
    '- This snapshot is a deterministic planning aid, not professional financial advice.',
  ];
  return lines.join('\n');
}

export function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export type ShareResult = 'shared' | 'cancelled' | 'unsupported';

export async function shareTextFile(input: {
  filename: string;
  content: string;
  type: string;
  title: string;
  text?: string;
}): Promise<ShareResult> {
  if (!navigator.share || !navigator.canShare) return 'unsupported';
  const file = new File([input.content], input.filename, { type: input.type });
  if (!navigator.canShare({ files: [file] })) return 'unsupported';
  try {
    await navigator.share({
      files: [file],
      title: input.title,
      text: input.text,
    });
    return 'shared';
  } catch (caught) {
    if (caught instanceof DOMException && caught.name === 'AbortError') return 'cancelled';
    throw caught;
  }
}

export async function copyText(content: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error('Kopiranje nije podržano u ovom pregledaču.');
  }
  await navigator.clipboard.writeText(content);
}
