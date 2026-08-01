import { z } from 'zod';
import type { Table } from 'dexie';
import { canonicalizeJson, type CanonicalJson } from '@/domain/sync/canonical';
import { createOpaqueId } from '@/domain/sync/crypto';
import {
  SYNC_FINANCIAL_ENTITY_TYPES,
  SYNC_OPERATION_COMMAND_TYPES,
  type SyncFinancialEntityType,
  type SyncOperationCommandType,
} from '@/domain/sync/operation';
import { db, type FinanceDatabase } from '../database';
import type { FinanceData } from '@/domain/types';
import { appSettingsSchema, syncedAppSettingsSchema } from '@/domain/schemas';
import {
  ACTIVE_SYNC_VAULT_RECORD_ID,
  LOCAL_SYNC_DEVICE_RECORD_ID,
  SYNC_METADATA_RECORD_ID,
} from './records';

const entityTypeSchema = z.enum(SYNC_FINANCIAL_ENTITY_TYPES);
const commandTypeSchema = z.enum(SYNC_OPERATION_COMMAND_TYPES);

export const MIRNA_SYNC_LOCAL_MUTATION_EVENT = 'mirna:sync-local-mutation';

const syncMutationIntentSchema = z.strictObject({
  type: z.literal('mirna-sync-mutation-intent-v1'),
  mutationGroupId: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  mutationGroupIndex: z.number().int().nonnegative(),
  mutationGroupSize: z.number().int().positive().max(1_000),
  entityType: entityTypeSchema,
  entityId: z.string().min(1).max(256),
  commandType: commandTypeSchema,
  previousValue: z.custom<CanonicalJson>().nullable(),
  value: z.custom<CanonicalJson>().nullable(),
});

export type SyncMutationIntentV1 = z.infer<typeof syncMutationIntentSchema>;

const synchronizedSettingsValue = (value: unknown) => {
  const parsed = appSettingsSchema.strict().parse(value);
  const {
    appearance: _appearance,
    installHintDismissed: _installHintDismissed,
    lastBackupAt: _lastBackupAt,
    ...synchronized
  } = parsed;
  void _appearance;
  void _installHintDismissed;
  void _lastBackupAt;
  return syncedAppSettingsSchema.parse(synchronized);
};

export const normalizeSyncJsonValue = (value: unknown): CanonicalJson => {
  const visit = (candidate: unknown, inArray: boolean): CanonicalJson | undefined => {
    if (candidate === undefined) {
      if (inArray) throw new Error('Sync vrednost ne sme imati undefined član niza.');
      return undefined;
    }
    if (
      candidate === null ||
      typeof candidate === 'boolean' ||
      typeof candidate === 'number' ||
      typeof candidate === 'string'
    ) {
      return candidate;
    }
    if (Array.isArray(candidate)) {
      return candidate.map((item) => {
        const normalized = visit(item, true);
        if (normalized === undefined) throw new Error('Sync niz sadrži undefined vrednost.');
        return normalized;
      });
    }
    if (typeof candidate !== 'object' || Object.getPrototypeOf(candidate) !== Object.prototype) {
      throw new Error('Sync vrednost mora biti običan JSON objekat.');
    }
    const result: Record<string, CanonicalJson> = {};
    for (const [key, nested] of Object.entries(candidate)) {
      const normalized = visit(nested, false);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  };
  const result = visit(value, false);
  if (result === undefined) throw new Error('Sync vrednost ne sme biti undefined.');
  canonicalizeJson(result);
  return result;
};

const commandFor = (
  entityType: SyncFinancialEntityType,
  action: 'upsert' | 'delete',
): SyncOperationCommandType => commandTypeSchema.parse(`${entityType}.${action}`);

interface AuditContext {
  readonly vaultId: string;
  readonly deviceId: string;
  readonly keyEpoch: number;
}

export class SyncMutationAudit {
  readonly #mutationGroupId = createOpaqueId();
  readonly #pending: Array<{
    operationId: string;
    entityType: SyncFinancialEntityType;
    entityId: string;
    command: SyncOperationCommandType;
    previousValue: CanonicalJson | null;
    value: CanonicalJson | null;
  }> = [];

  constructor(
    private readonly database: FinanceDatabase,
    private readonly context: AuditContext | null,
    private readonly now: () => Date,
  ) {}

  async upsert(
    entityTypeInput: SyncFinancialEntityType,
    previousValue: { id: string } | null | undefined,
    value: { id: string },
  ): Promise<void> {
    if (previousValue?.id && previousValue.id !== value.id) {
      throw new Error('Sync audit ne dozvoljava promenu identiteta entiteta.');
    }
    await this.#record(entityTypeInput, value.id, previousValue ?? null, value, 'upsert');
  }

  async delete(
    entityTypeInput: SyncFinancialEntityType,
    previousValue: { id: string } | null | undefined,
  ): Promise<void> {
    if (!previousValue) return;
    await this.#record(entityTypeInput, previousValue.id, previousValue, null, 'delete');
  }

  async resolve(
    entityType: SyncFinancialEntityType,
    entityId: string,
    previousValue: { id: string } | null | undefined,
    value: { id: string } | null,
  ): Promise<string> {
    if (value?.id && value.id !== entityId) {
      throw new Error('Sync rezolucija ne dozvoljava promenu identiteta entiteta.');
    }
    if (previousValue?.id && previousValue.id !== entityId) {
      throw new Error('Prethodna vrednost sync rezolucije ima pogrešan identitet.');
    }
    const operationId = await this.#record(
      entityType,
      entityId,
      previousValue ?? null,
      value,
      value === null ? 'delete' : 'upsert',
      true,
    );
    if (!operationId) throw new Error('Sync rezolucija zahteva aktivan sync outbox.');
    return operationId;
  }

  #record(
    entityTypeInput: SyncFinancialEntityType,
    entityId: string,
    previousValueInput: unknown,
    valueInput: unknown,
    action: 'upsert' | 'delete',
    force = false,
  ): Promise<string | null> {
    if (!this.context) return Promise.resolve(null);
    const entityType = entityTypeSchema.parse(entityTypeInput);
    const synchronizedPreviousValue =
      entityType === 'settings' && previousValueInput !== null
        ? synchronizedSettingsValue(previousValueInput)
        : previousValueInput;
    const synchronizedValue =
      entityType === 'settings' && valueInput !== null
        ? synchronizedSettingsValue(valueInput)
        : valueInput;
    const previousValue =
      synchronizedPreviousValue === null ? null : normalizeSyncJsonValue(synchronizedPreviousValue);
    const value = synchronizedValue === null ? null : normalizeSyncJsonValue(synchronizedValue);
    if (
      action === 'upsert' &&
      !force &&
      previousValue !== null &&
      canonicalizeJson(previousValue) === canonicalizeJson(value)
    ) {
      return Promise.resolve(null);
    }
    const command = commandFor(entityType, action);
    const operationId = createOpaqueId();
    this.#pending.push({
      operationId,
      entityType,
      entityId,
      command,
      previousValue,
      value,
    });
    return Promise.resolve(operationId);
  }

  async finalize(): Promise<boolean> {
    if (!this.context || this.#pending.length === 0) return false;
    const now = this.now().toISOString();
    const size = this.#pending.length;
    const records = this.#pending.map((pending, index) => {
      const intent = syncMutationIntentSchema.parse({
        type: 'mirna-sync-mutation-intent-v1',
        mutationGroupId: this.#mutationGroupId,
        mutationGroupIndex: index,
        mutationGroupSize: size,
        entityType: pending.entityType,
        entityId: pending.entityId,
        commandType: pending.command,
        previousValue: pending.previousValue,
        value: pending.value,
      });
      return {
        id: pending.operationId,
        vaultId: this.context!.vaultId,
        operationId: pending.operationId,
        deviceId: this.context!.deviceId,
        deviceSequence: 0,
        keyEpoch: this.context!.keyEpoch,
        mutationGroupId: this.#mutationGroupId,
        mutationGroupIndex: index,
        mutationGroupSize: size,
        state: 'intent' as const,
        entityType: pending.entityType,
        entityId: pending.entityId,
        command: pending.command,
        canonicalPayload: canonicalizeJson(intent),
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      };
    });
    await this.database.syncOutbox.bulkAdd(records);
    this.#pending.length = 0;
    return true;
  }
}

const loadAuditContext = async (database: FinanceDatabase): Promise<AuditContext | null> => {
  const vault = await database.syncVault.get(ACTIVE_SYNC_VAULT_RECORD_ID);
  if (!vault) return null;
  const [device, metadata] = await Promise.all([
    database.syncDevice.get(LOCAL_SYNC_DEVICE_RECORD_ID),
    database.syncMetadata.get(SYNC_METADATA_RECORD_ID),
  ]);
  if (
    vault.status !== 'active' ||
    !device ||
    !metadata ||
    device.vaultId !== vault.vaultId ||
    metadata.vaultId !== vault.vaultId
  ) {
    throw new Error('Lokalno sync stanje nije kompletno; finansijska izmena je zaustavljena.');
  }
  return { vaultId: vault.vaultId, deviceId: device.deviceId, keyEpoch: vault.keyEpoch };
};

export const syncMutationAuditTables = (database: FinanceDatabase = db): readonly Table[] => [
  database.syncVault,
  database.syncDevice,
  database.syncMetadata,
  database.syncOutbox,
];

export const auditedFinanceTransaction = async <T>(
  financeStoreTables: readonly Table[],
  operation: (audit: SyncMutationAudit) => Promise<T>,
  database: FinanceDatabase = db,
  now: () => Date = () => new Date(),
): Promise<T> => {
  const tables = new Map<string, Table>();
  for (const table of [...financeStoreTables, ...syncMutationAuditTables(database)]) {
    tables.set(table.name, table);
  }
  const { result, enqueued } = await database.transaction('rw', [...tables.values()], async () => {
    const context = await loadAuditContext(database);
    const audit = new SyncMutationAudit(database, context, now);
    const result = await operation(audit);
    return { result, enqueued: await audit.finalize() };
  });
  if (enqueued && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(MIRNA_SYNC_LOCAL_MUTATION_EVENT));
  }
  return result;
};

export const parseSyncMutationIntent = (canonicalPayload: string): SyncMutationIntentV1 => {
  const parsed = syncMutationIntentSchema.parse(JSON.parse(canonicalPayload) as unknown);
  if (canonicalizeJson(parsed) !== canonicalPayload) {
    throw new Error('Sync outbox intent nije kanonski zapisan.');
  }
  return parsed;
};

export const auditFinanceDataChanges = async (
  audit: SyncMutationAudit,
  previous: FinanceData,
  next: FinanceData,
): Promise<void> => {
  const groups: ReadonlyArray<
    readonly [SyncFinancialEntityType, readonly { id: string }[], readonly { id: string }[]]
  > = [
    ['account', previous.accounts, next.accounts],
    ['transaction', previous.transactions, next.transactions],
    ['category', previous.categories, next.categories],
    ['planned-income', previous.plannedIncomes, next.plannedIncomes],
    ['commitment', previous.commitments, next.commitments],
    ['variable-budget', previous.variableBudgets, next.variableBudgets],
    ['goal', previous.goals, next.goals],
    ['debt', previous.debts, next.debts],
    ['debt-payment', previous.debtPayments, next.debtPayments],
    ['planned-event', previous.plannedEvents, next.plannedEvents],
    ['quick-add-preset', previous.presets, next.presets],
    ['salary-scenario', previous.salaryScenarios, next.salaryScenarios],
    ['settings', previous.settings, next.settings],
  ];
  for (const [entityType, previousValues, nextValues] of groups) {
    const previousById = new Map(previousValues.map((value) => [value.id, value]));
    const nextById = new Map(nextValues.map((value) => [value.id, value]));
    for (const value of nextValues) {
      await audit.upsert(entityType, previousById.get(value.id), value);
    }
    for (const value of previousValues) {
      if (!nextById.has(value.id)) await audit.delete(entityType, value);
    }
  }
};
