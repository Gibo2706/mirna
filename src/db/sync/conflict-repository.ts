import type { Table } from 'dexie';
import { z } from 'zod';
import { SYNC_FINANCIAL_ENTITY_TYPES, type SyncFinancialEntityType } from '@/domain/sync/operation';
import { db, financeTables, type FinanceDatabase } from '../database';
import { readFinanceDataInTransaction, validateFinanceData } from '../finance-data';
import { auditedFinanceTransaction, normalizeSyncJsonValue } from './mutation-audit';
import { readLocalSyncSetup } from './repository';
import type { SyncConflictRecord } from './records';

const entityTypeSchema = z.enum(SYNC_FINANCIAL_ENTITY_TYPES);
const remoteProposalSchema = z.strictObject({
  value: z.unknown().nullable(),
  tombstone: z.unknown().nullable(),
});

type EntityValue = { id: string } & Record<string, unknown>;

const entityTable = (
  database: FinanceDatabase,
  entityType: SyncFinancialEntityType,
): Table<{ id: string }, string> => {
  const table = (() => {
    switch (entityType) {
      case 'account':
        return database.accounts;
      case 'transaction':
        return database.transactions;
      case 'category':
        return database.categories;
      case 'planned-income':
        return database.plannedIncomes;
      case 'commitment':
        return database.commitments;
      case 'variable-budget':
        return database.variableBudgets;
      case 'goal':
        return database.goals;
      case 'debt':
        return database.debts;
      case 'debt-payment':
        return database.debtPayments;
      case 'planned-event':
        return database.plannedEvents;
      case 'quick-add-preset':
        return database.presets;
      case 'salary-scenario':
        return database.salaryScenarios;
      case 'settings':
        return database.settings;
    }
  })();
  return table as unknown as Table<{ id: string }, string>;
};

const asEntityValue = (value: unknown, expectedId: string): EntityValue | null => {
  if (value === null) return null;
  const normalized = normalizeSyncJsonValue(value);
  if (
    normalized === null ||
    Array.isArray(normalized) ||
    typeof normalized !== 'object' ||
    normalized.id !== expectedId
  ) {
    throw new Error('Predlog konflikta nema očekivani identitet entiteta.');
  }
  return normalized as EntityValue;
};

const remoteValue = (conflict: SyncConflictRecord): EntityValue | null => {
  const proposal = remoteProposalSchema.parse(
    JSON.parse(conflict.remoteCanonicalProposal) as unknown,
  );
  if ((proposal.value === null) === (proposal.tombstone === null)) {
    throw new Error('Udaljeni predlog konflikta nije konzistentan.');
  }
  return asEntityValue(proposal.value, conflict.entityId);
};

export type ConflictResolutionSelection = 'local' | 'remote';

export class SyncConflictRepository {
  constructor(
    private readonly database: FinanceDatabase = db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  pending(vaultId: string): Promise<SyncConflictRecord[]> {
    return this.database.syncConflicts
      .where('[vaultId+resolutionState]')
      .equals([vaultId, 'pending'])
      .sortBy('detectedAt');
  }

  async resolveOperationGroup(
    vaultId: string,
    mutationGroupId: string,
    selection: ConflictResolutionSelection,
  ): Promise<void> {
    const setup = await readLocalSyncSetup(this.database);
    if (!setup || setup.vault.vaultId !== vaultId) {
      throw new Error('Lokalno sync podešavanje ne pripada konfliktu.');
    }
    await auditedFinanceTransaction(
      [...financeTables(this.database), this.database.syncConflicts],
      async (audit) => {
        const conflicts = (
          await this.database.syncConflicts
            .where('[vaultId+mutationGroupId]')
            .equals([vaultId, mutationGroupId])
            .toArray()
        ).sort((left, right) => (left.mutationGroupIndex ?? 0) - (right.mutationGroupIndex ?? 0));
        const expectedSize = conflicts[0]?.mutationGroupSize;
        if (
          !expectedSize ||
          conflicts.length !== expectedSize ||
          conflicts.some(
            (conflict, index) =>
              conflict.resolutionState !== 'pending' ||
              conflict.mutationGroupId !== mutationGroupId ||
              conflict.mutationGroupIndex !== index ||
              conflict.mutationGroupSize !== expectedSize ||
              conflict.entityType === 'snapshot',
          )
        ) {
          throw new Error('Konfliktna mutation grupa nije kompletna ili je već rešena.');
        }

        const resolvedAt = this.now().toISOString();
        for (const conflict of conflicts) {
          const entityType = entityTypeSchema.parse(conflict.entityType);
          const table = entityTable(this.database, entityType);
          const current = await table.get(conflict.entityId);
          let desired: EntityValue | null =
            selection === 'local' ? (current ? { ...current } : null) : remoteValue(conflict);
          if (entityType === 'settings' && desired) {
            const localSettings = await this.database.settings.get('settings');
            if (!localSettings) throw new Error('Lokalna podešavanja nedostaju.');
            desired = {
              ...desired,
              appearance: localSettings.appearance,
              installHintDismissed: localSettings.installHintDismissed,
              ...(localSettings.lastBackupAt ? { lastBackupAt: localSettings.lastBackupAt } : {}),
            };
          }
          if (desired) await table.put(desired);
          else await table.delete(conflict.entityId);
          const resolutionOperationId = await audit.resolve(
            entityType,
            conflict.entityId,
            current,
            desired,
            [conflict.localOperationId, conflict.remoteOperationId].filter((operationId) =>
              /^[A-Za-z0-9_-]{22}$/u.test(operationId),
            ),
          );
          await this.database.syncConflicts.put({
            ...conflict,
            resolutionState: selection === 'local' ? 'resolved-local' : 'resolved-remote',
            resolvedAt,
            resolutionOperationId,
          });
        }
        validateFinanceData(await readFinanceDataInTransaction(this.database));
      },
      this.database,
      this.now,
    );
  }
}
