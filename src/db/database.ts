import Dexie, { type EntityTable } from 'dexie';
import type {
  Account,
  AppSettings,
  Category,
  Debt,
  DebtPayment,
  FixedCommitment,
  LedgerTransaction,
  PlannedEvent,
  PlannedIncome,
  QuickAddPreset,
  SalaryScenario,
  SavingsGoal,
  VariableBudget,
} from '@/domain/types';
import { inferLegacyGoalType, isGoalCompletionEvent } from '@/domain/goals';
import type {
  SyncConflictRecord,
  SyncDeviceRecord,
  SyncFrontierRecord,
  SyncInboxRecord,
  SyncKeyRecord,
  SyncMetadataRecord,
  SyncOutboxRecord,
  SyncVaultRecord,
} from './sync/records';

export class FinanceDatabase extends Dexie {
  accounts!: EntityTable<Account, 'id'>;
  transactions!: EntityTable<LedgerTransaction, 'id'>;
  categories!: EntityTable<Category, 'id'>;
  plannedIncomes!: EntityTable<PlannedIncome, 'id'>;
  commitments!: EntityTable<FixedCommitment, 'id'>;
  variableBudgets!: EntityTable<VariableBudget, 'id'>;
  goals!: EntityTable<SavingsGoal, 'id'>;
  debts!: EntityTable<Debt, 'id'>;
  debtPayments!: EntityTable<DebtPayment, 'id'>;
  plannedEvents!: EntityTable<PlannedEvent, 'id'>;
  presets!: EntityTable<QuickAddPreset, 'id'>;
  salaryScenarios!: EntityTable<SalaryScenario, 'id'>;
  settings!: EntityTable<AppSettings, 'id'>;
  syncVault!: EntityTable<SyncVaultRecord, 'id'>;
  syncDevice!: EntityTable<SyncDeviceRecord, 'id'>;
  syncKeys!: EntityTable<SyncKeyRecord, 'id'>;
  syncOutbox!: EntityTable<SyncOutboxRecord, 'id'>;
  syncInbox!: EntityTable<SyncInboxRecord, 'id'>;
  syncConflicts!: EntityTable<SyncConflictRecord, 'id'>;
  syncFrontier!: EntityTable<SyncFrontierRecord, 'id'>;
  syncMetadata!: EntityTable<SyncMetadataRecord, 'id'>;

  constructor(name = 'mirna-finance') {
    super(name);

    this.version(1).stores({
      accounts: 'id, kind, archived',
      transactions: 'id, type, date, accountId, categoryId',
      categories: 'id, kind, archived',
      commitments: 'id, active, startDate, endDate, accountId, categoryId',
      variableBudgets: 'id, active, categoryId',
      goals: 'id, archived, linkedAccountId',
      debts: 'id, status, priority',
      debtPayments: 'id, debtId, date, transactionId',
      plannedEvents: 'id, date, categoryId, accountId',
      presets: 'id, active, position',
      salaryScenarios: 'id, startMonth',
      settings: 'id',
    });

    this.version(2)
      .stores({
        accounts: 'id, kind, protected, archived',
        transactions:
          'id, type, date, accountId, toAccountId, categoryId, &occurrenceKey, &plannedEventId, goalId, debtPaymentId',
        categories: 'id, kind, archived',
        commitments: 'id, active, frequency, startDate, endDate, accountId, categoryId',
        variableBudgets: 'id, active, categoryId',
        goals: 'id, archived, &linkedAccountId',
        debts: 'id, status, priority',
        debtPayments: 'id, debtId, date, &transactionId',
        plannedEvents: 'id, date, categoryId, accountId, linkedGoalId',
        presets: 'id, active, position',
        salaryScenarios: 'id, startMonth',
        settings: 'id',
      })
      .upgrade(async (transaction) => {
        await transaction
          .table<Account>('accounts')
          .toCollection()
          .modify((account) => {
            account.protected = account.protected ?? account.kind === 'savings';
          });
      });

    this.version(3)
      .stores({
        accounts: 'id, kind, protected, archived',
        transactions:
          'id, type, date, accountId, toAccountId, categoryId, &occurrenceKey, plannedIncomeId, &plannedEventId, goalId, debtPaymentId',
        categories: 'id, kind, archived',
        plannedIncomes: 'id, active, isPrimarySalary, accountId, categoryId, startDate, endDate',
        commitments: 'id, active, frequency, startDate, endDate, accountId, categoryId',
        variableBudgets: 'id, active, categoryId',
        goals: 'id, archived, &linkedAccountId',
        debts: 'id, status, priority',
        debtPayments: 'id, debtId, date, &transactionId',
        plannedEvents: 'id, date, categoryId, accountId, linkedGoalId',
        presets: 'id, active, position',
        salaryScenarios: 'id, startMonth',
        settings: 'id',
      })
      .upgrade(async (transaction) => {
        const goals = transaction.table<SavingsGoal>('goals');
        const debts = transaction.table<Debt>('debts');
        const debtPayments = transaction.table<DebtPayment>('debtPayments');
        const settingsTable = transaction.table<AppSettings>('settings');

        await goals.toCollection().modify((goal) => {
          goal.contributionOverrides ??= {};
        });
        await debts.toCollection().modify((debt) => {
          debt.paymentOverrides ??= {};
        });
        await debtPayments.toCollection().modify((payment) => {
          payment.source ??= 'self';
        });

        const settings = await settingsTable.get('settings');
        if (!settings) return;

        const plannedIncomes = transaction.table<PlannedIncome>('plannedIncomes');
        const primarySalary = await plannedIncomes
          .filter((plannedIncome) => plannedIncome.isPrimarySalary)
          .first();
        if (!primarySalary && settings.baseMonthlyIncome > 0) {
          const accounts = await transaction.table<Account>('accounts').toArray();
          const account =
            accounts.find((value) => value.id === settings.defaultAccountId) ??
            accounts.find(
              (value) => !value.archived && value.kind === 'checking' && !value.protected,
            ) ??
            accounts.find((value) => !value.archived && !value.protected) ??
            accounts.find((value) => !value.archived);
          if (account) {
            const categories = transaction.table<Category>('categories');
            let category =
              (await categories.get('cat_salary')) ??
              (await categories.where('kind').equals('income').first());
            if (!category) {
              category = {
                id: 'cat_salary',
                name: 'Plata',
                kind: 'income',
                icon: '💼',
                color: '#4f7c67',
                archived: false,
              };
              await categories.add(category);
            }
            const createdAt = settings.createdAt || new Date(0).toISOString();
            await plannedIncomes.add({
              id: 'income_primary_salary',
              name: 'Plata',
              amount: settings.baseMonthlyIncome,
              categoryId: category.id,
              accountId: account.id,
              frequency: 'monthly',
              startDate: `${createdAt.slice(0, 7)}-01`,
              active: true,
              isPrimarySalary: true,
              createdAt,
            });
          }
        }
      });

    this.version(4)
      .stores({
        goals: 'id, archived, goalType, &linkedAccountId',
        plannedEvents: 'id, date, categoryId, accountId, linkedGoalId',
      })
      .upgrade(async (transaction) => {
        const goals = transaction.table<SavingsGoal>('goals');
        const events = await transaction.table<PlannedEvent>('plannedEvents').toArray();
        const transactions = new Map(
          (await transaction.table<LedgerTransaction>('transactions').toArray()).map((value) => [
            value.id,
            value,
          ]),
        );

        await goals.toCollection().modify((goal) => {
          goal.goalType ??= inferLegacyGoalType(goal, events);
          if (goal.goalType !== 'sinking' || goal.usedAt) return;

          const completion = events
            .filter(
              (event) => Boolean(event.paidTransactionId) && isGoalCompletionEvent(goal, event),
            )
            .sort((left, right) => {
              const leftDate = transactions.get(left.paidTransactionId ?? '')?.date ?? left.date;
              const rightDate = transactions.get(right.paidTransactionId ?? '')?.date ?? right.date;
              return leftDate.localeCompare(rightDate) || left.id.localeCompare(right.id);
            })[0];
          if (completion) {
            goal.usedAt =
              transactions.get(completion.paidTransactionId ?? '')?.date ?? completion.date;
          }
        });
      });

    this.version(5)
      .stores({
        goals: 'id, archived, goalType, &linkedAccountId',
        plannedEvents: 'id, date, categoryId, accountId, linkedGoalId',
      })
      .upgrade(async (transaction) => {
        const goals = transaction.table<SavingsGoal>('goals');
        const events = await transaction.table<PlannedEvent>('plannedEvents').toArray();
        const transactions = new Map(
          (await transaction.table<LedgerTransaction>('transactions').toArray()).map((value) => [
            value.id,
            value,
          ]),
        );

        for (const goal of await goals.toArray()) {
          if (goal.goalType !== 'sinking' || !goal.usedAt) continue;
          const legacyCompletion = events
            .filter(
              (event) =>
                Boolean(event.paidTransactionId) &&
                event.date === goal.usedAt &&
                isGoalCompletionEvent(goal, event),
            )
            .map((event) => ({
              event,
              paid: transactions.get(event.paidTransactionId ?? ''),
            }))
            .filter(
              (
                value,
              ): value is {
                event: PlannedEvent;
                paid: LedgerTransaction;
              } => Boolean(value.paid),
            )
            .sort(
              (left, right) =>
                left.paid.date.localeCompare(right.paid.date) ||
                left.event.id.localeCompare(right.event.id),
            )[0];
          if (legacyCompletion && legacyCompletion.paid.date !== goal.usedAt) {
            await goals.update(goal.id, { usedAt: legacyCompletion.paid.date });
          }
        }
      });

    this.version(6).stores({
      syncVault: 'id, &vaultId, status, keyEpoch',
      syncDevice: 'id, vaultId, &deviceId, authorizationExpiresAt',
      syncKeys: 'id, &[vaultId+keyEpoch], purpose, retiredAt',
      syncOutbox: 'id, vaultId, &operationId, [vaultId+state], [vaultId+deviceSequence], createdAt',
      syncInbox: 'id, vaultId, &operationId, [vaultId+state], [vaultId+serverCursor], receivedAt',
      syncConflicts:
        'id, vaultId, entityId, resolutionState, [vaultId+resolutionState], detectedAt',
      syncFrontier: 'id, vaultId, &deviceId, [vaultId+deviceId], acknowledgedServerCursor',
      syncMetadata: 'id, &vaultId, lastSuccessfulSyncAt',
    });
  }
}

export const db = new FinanceDatabase();

export const financeTables = () => [
  db.transactions,
  db.debtPayments,
  db.accounts,
  db.categories,
  db.plannedIncomes,
  db.commitments,
  db.variableBudgets,
  db.goals,
  db.debts,
  db.plannedEvents,
  db.presets,
  db.salaryScenarios,
  db.settings,
];
