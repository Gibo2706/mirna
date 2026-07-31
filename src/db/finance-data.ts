import { assertFinanceDataIntegrity } from '@/domain/integrity';
import { financeDataSchema } from '@/domain/schemas';
import type { FinanceData } from '@/domain/types';
import type { FinanceDatabase } from './database';

export const validateFinanceData = (value: unknown): FinanceData => {
  const data = financeDataSchema.parse(value);
  assertFinanceDataIntegrity(data);
  return data;
};

export const readRawFinanceDataInTransaction = async (database: FinanceDatabase) => {
  const [
    accounts,
    transactions,
    categories,
    plannedIncomes,
    commitments,
    variableBudgets,
    goals,
    debts,
    debtPayments,
    plannedEvents,
    presets,
    salaryScenarios,
    settings,
  ] = await Promise.all([
    database.accounts.toArray(),
    database.transactions.toArray(),
    database.categories.toArray(),
    database.plannedIncomes.toArray(),
    database.commitments.toArray(),
    database.variableBudgets.toArray(),
    database.goals.toArray(),
    database.debts.toArray(),
    database.debtPayments.toArray(),
    database.plannedEvents.toArray(),
    database.presets.toArray(),
    database.salaryScenarios.toArray(),
    database.settings.toArray(),
  ]);
  return {
    accounts,
    transactions,
    categories,
    plannedIncomes,
    commitments,
    variableBudgets,
    goals,
    debts,
    debtPayments,
    plannedEvents,
    presets,
    salaryScenarios,
    settings,
  };
};

export const readFinanceDataInTransaction = async (
  database: FinanceDatabase,
): Promise<FinanceData> => validateFinanceData(await readRawFinanceDataInTransaction(database));

export const replaceFinanceDataInTransaction = async (
  database: FinanceDatabase,
  data: FinanceData,
): Promise<void> => {
  await Promise.all([
    database.accounts.clear(),
    database.transactions.clear(),
    database.categories.clear(),
    database.plannedIncomes.clear(),
    database.commitments.clear(),
    database.variableBudgets.clear(),
    database.goals.clear(),
    database.debts.clear(),
    database.debtPayments.clear(),
    database.plannedEvents.clear(),
    database.presets.clear(),
    database.salaryScenarios.clear(),
    database.settings.clear(),
  ]);
  await Promise.all([
    database.accounts.bulkPut(data.accounts),
    database.transactions.bulkPut(data.transactions),
    database.categories.bulkPut(data.categories),
    database.plannedIncomes.bulkPut(data.plannedIncomes),
    database.commitments.bulkPut(data.commitments),
    database.variableBudgets.bulkPut(data.variableBudgets),
    database.goals.bulkPut(data.goals),
    database.debts.bulkPut(data.debts),
    database.debtPayments.bulkPut(data.debtPayments),
    database.plannedEvents.bulkPut(data.plannedEvents),
    database.presets.bulkPut(data.presets),
    database.salaryScenarios.bulkPut(data.salaryScenarios),
    database.settings.bulkPut(data.settings),
  ]);
};
