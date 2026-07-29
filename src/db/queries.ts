import { useLiveQuery } from 'dexie-react-hooks';
import type { FinanceData, FinanceSnapshot } from '@/domain/types';
import { db, financeTables } from './database';

export async function readFinanceData(): Promise<FinanceData> {
  return db.transaction('r', financeTables(), async () => {
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
      db.accounts.toArray(),
      db.transactions.toArray(),
      db.categories.toArray(),
      db.plannedIncomes.toArray(),
      db.commitments.toArray(),
      db.variableBudgets.toArray(),
      db.goals.toArray(),
      db.debts.toArray(),
      db.debtPayments.toArray(),
      db.plannedEvents.toArray(),
      db.presets.toArray(),
      db.salaryScenarios.toArray(),
      db.settings.toArray(),
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
  });
}

export function useFinanceSnapshot(): FinanceSnapshot | null | undefined {
  return useLiveQuery<FinanceSnapshot | null>(async () => {
    const data = await readFinanceData();
    const settingsRecord = data.settings[0];
    return settingsRecord ? { ...data, settingsRecord } : null;
  }, []);
}
