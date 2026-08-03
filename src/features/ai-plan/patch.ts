import { isMatch } from 'date-fns';
import { z } from 'zod';
import { calculateAccountBalances, calculateDebtProgress } from '@/domain/calculations';
import { assertFinanceDataIntegrity } from '@/domain/integrity';
import { financeDataSchema } from '@/domain/schemas';
import type { FinanceData, FinanceSnapshot } from '@/domain/types';
import { db } from '@/db/database';
import { auditFinanceDataChanges, auditedFinanceTransaction } from '@/db/sync/mutation-audit';
import { createId } from '@/lib/id';
import { formatDate } from '@/lib/dates';
import { formatRsd } from '@/lib/format';
import { extractSingleJsonDocument, MAX_AI_PLAN_INPUT_BYTES } from './blueprint';

export const PLAN_PATCH_VERSION = 1;
const MAX_PATCH_OPERATIONS = 100;
const money = z.number().int().nonnegative().max(1_000_000_000_000);
const positiveMoney = money.positive();
const shortText = z.string().trim().min(1).max(120);
const notes = z.string().trim().max(2_000).nullable().optional();
const ref = z.string().min(3).max(180);
const isoDate = z
  .string()
  .refine((value) => isMatch(value, 'yyyy-MM-dd'), 'Datum mora biti stvarni ISO datum.');
const monthKey = z
  .string()
  .refine((value) => isMatch(value, 'yyyy-MM'), 'Mesec mora biti u YYYY-MM formatu.');
const nullableDate = isoDate.nullable();
const nullableMonth = monthKey.nullable();

export type PatchEntity =
  | 'account'
  | 'plannedIncome'
  | 'fixedCommitment'
  | 'variableBudget'
  | 'goal'
  | 'debt'
  | 'plannedEvent'
  | 'salaryScenario'
  | 'quickAddPreset';

export interface StandardPlanPatchOperation {
  op: 'update' | 'create' | 'archive';
  entity: PatchEntity;
  ref?: string;
  changes?: Record<string, unknown>;
  value?: Record<string, unknown>;
}

export interface AddGoalWithProtectedAccountOperation {
  op: 'addGoalWithProtectedAccount';
  value: {
    accountName: string;
    goalName: string;
    emoji: string;
    targetAmount: number;
    targetDate?: string;
    plannedMonthlyContribution: number;
    contributionOverrides: Record<string, number>;
    contributionStartMonth?: string;
    contributionEndMonth?: string;
    goalType: 'sinking' | 'reserve';
    notes?: string;
  };
}

export type PlanPatchOperation = StandardPlanPatchOperation | AddGoalWithProtectedAccountOperation;

export interface PlanPatch {
  planPatchVersion: 1;
  operations: PlanPatchOperation[];
}

const nonEmpty = <T extends z.ZodRawShape>(shape: T) =>
  z
    .strictObject(shape)
    .partial()
    .refine((value) => Object.keys(value).length > 0, 'Navedite bar jednu izmenu.');

const updateSchemas: Record<PatchEntity, z.ZodType<Record<string, unknown>>> = {
  account: nonEmpty({
    name: shortText,
    archived: z.boolean(),
  }),
  plannedIncome: nonEmpty({
    name: shortText,
    amount: positiveMoney,
    categoryRef: ref,
    accountRef: ref,
    frequency: z.enum(['monthly', 'weekly', 'yearly']),
    startDate: isoDate,
    endDate: nullableDate,
    expectedDay: z.number().int().min(1).max(31).nullable(),
    active: z.boolean(),
    isPrimarySalary: z.boolean(),
    notes,
  }),
  fixedCommitment: nonEmpty({
    name: shortText,
    amount: positiveMoney,
    categoryRef: ref,
    accountRef: ref,
    frequency: z.enum(['monthly', 'weekly', 'yearly']),
    startDate: isoDate,
    endDate: nullableDate,
    dueDay: z.number().int().min(1).max(31),
    active: z.boolean(),
    notes,
  }),
  variableBudget: nonEmpty({
    name: shortText,
    defaultAmount: money,
    categoryRef: ref,
    overrides: z.record(monthKey, money),
    active: z.boolean(),
  }),
  goal: nonEmpty({
    name: shortText,
    emoji: z.string().trim().min(1).max(12),
    targetAmount: positiveMoney,
    targetDate: nullableDate,
    linkedAccountRef: ref,
    plannedMonthlyContribution: money,
    contributionOverrides: z.record(monthKey, money),
    contributionStartMonth: nullableMonth,
    contributionEndMonth: nullableMonth,
    goalType: z.enum(['sinking', 'reserve']),
    notes,
    archived: z.boolean(),
  }),
  debt: nonEmpty({
    creditor: shortText,
    dueDate: nullableDate,
    priority: z.enum(['low', 'medium', 'high']),
    plannedMonthlyPayment: positiveMoney.nullable(),
    paymentDay: z.number().int().min(1).max(31).nullable(),
    paymentOverrides: z.record(monthKey, money),
    notes,
  }),
  plannedEvent: nonEmpty({
    title: shortText,
    date: isoDate,
    plannedAmount: money,
    categoryRef: ref,
    accountRef: ref,
    linkedGoalRef: ref.nullable(),
    notes,
  }),
  salaryScenario: nonEmpty({
    name: shortText,
    monthlyAmount: positiveMoney,
    startMonth: monthKey,
  }),
  quickAddPreset: nonEmpty({
    name: shortText,
    emoji: z.string().trim().max(12),
    type: z.enum(['income', 'expense']),
    amount: positiveMoney.nullable(),
    categoryRef: ref.nullable(),
    defaultAccountRef: ref.nullable(),
    position: z.number().int().nonnegative().max(999),
    active: z.boolean(),
  }),
};

const createSchemas: Partial<Record<PatchEntity, z.ZodType<Record<string, unknown>>>> = {
  plannedIncome: z.strictObject({
    name: shortText,
    amount: positiveMoney,
    categoryRef: ref,
    accountRef: ref,
    frequency: z.enum(['monthly', 'weekly', 'yearly']),
    startDate: isoDate,
    endDate: isoDate.optional(),
    expectedDay: z.number().int().min(1).max(31).optional(),
    active: z.boolean().default(true),
    isPrimarySalary: z.boolean().default(false),
    notes: z.string().trim().max(2_000).optional(),
  }),
  fixedCommitment: z.strictObject({
    name: shortText,
    amount: positiveMoney,
    categoryRef: ref,
    accountRef: ref,
    frequency: z.enum(['monthly', 'weekly', 'yearly']),
    startDate: isoDate,
    endDate: isoDate.optional(),
    dueDay: z.number().int().min(1).max(31),
    active: z.boolean().default(true),
    notes: z.string().trim().max(2_000).optional(),
  }),
  variableBudget: z.strictObject({
    name: shortText,
    defaultAmount: money,
    categoryRef: ref,
    overrides: z.record(monthKey, money).default({}),
    active: z.boolean().default(true),
  }),
  goal: z.strictObject({
    name: shortText,
    emoji: z.string().trim().min(1).max(12).default('🎯'),
    targetAmount: positiveMoney,
    targetDate: isoDate.optional(),
    linkedAccountRef: ref,
    plannedMonthlyContribution: money.default(0),
    contributionOverrides: z.record(monthKey, money).default({}),
    contributionStartMonth: monthKey.optional(),
    contributionEndMonth: monthKey.optional(),
    goalType: z.enum(['sinking', 'reserve']),
    notes: z.string().trim().max(2_000).optional(),
  }),
  debt: z.strictObject({
    creditor: shortText,
    originalAmount: positiveMoney,
    dueDate: isoDate.optional(),
    priority: z.enum(['low', 'medium', 'high']).default('medium'),
    plannedMonthlyPayment: positiveMoney.optional(),
    paymentDay: z.number().int().min(1).max(31).optional(),
    paymentOverrides: z.record(monthKey, money).default({}),
    notes: z.string().trim().max(2_000).optional(),
  }),
  plannedEvent: z.strictObject({
    title: shortText,
    date: isoDate,
    plannedAmount: money,
    categoryRef: ref,
    accountRef: ref,
    linkedGoalRef: ref.optional(),
    notes: z.string().trim().max(2_000).optional(),
  }),
  salaryScenario: z.strictObject({
    name: shortText,
    monthlyAmount: positiveMoney,
    startMonth: monthKey,
  }),
  quickAddPreset: z.strictObject({
    name: shortText,
    emoji: z.string().trim().max(12).default('⚡'),
    type: z.enum(['income', 'expense']),
    amount: positiveMoney.optional(),
    categoryRef: ref.optional(),
    defaultAccountRef: ref.optional(),
    position: z.number().int().nonnegative().max(999),
    active: z.boolean().default(true),
  }),
};

const addGoalWithProtectedAccountSchema = z.strictObject({
  op: z.literal('addGoalWithProtectedAccount'),
  value: z.strictObject({
    accountName: shortText,
    goalName: shortText,
    emoji: z.string().trim().min(1).max(12).default('🎯'),
    targetAmount: positiveMoney,
    targetDate: isoDate.optional(),
    plannedMonthlyContribution: money.default(0),
    contributionOverrides: z.record(monthKey, money).default({}),
    contributionStartMonth: monthKey.optional(),
    contributionEndMonth: monthKey.optional(),
    goalType: z.enum(['sinking', 'reserve']),
    notes: z.string().trim().max(2_000).optional(),
  }),
});

const archivableEntities = new Set<PatchEntity>([
  'account',
  'plannedIncome',
  'fixedCommitment',
  'variableBudget',
  'goal',
  'quickAddPreset',
]);

const patchEnvelopeSchema = z.strictObject({
  planPatchVersion: z.literal(PLAN_PATCH_VERSION),
  operations: z.array(z.unknown()).max(MAX_PATCH_OPERATIONS),
});

const operationEnvelopeSchema = z.strictObject({
  op: z.enum(['update', 'create', 'archive']),
  entity: z.enum([
    'account',
    'plannedIncome',
    'fixedCommitment',
    'variableBudget',
    'goal',
    'debt',
    'plannedEvent',
    'salaryScenario',
    'quickAddPreset',
  ]),
  ref: ref.optional(),
  changes: z.unknown().optional(),
  value: z.unknown().optional(),
});

const forbiddenPatchFields = new Set([
  'id',
  'transactions',
  'transaction',
  'balanceAdjustments',
  'adjustments',
  'debtPayments',
  'debtPaymentHistory',
  'paidTransactionId',
  'transactionId',
  'occurrenceKey',
  'plannedIncomeId',
  'plannedEventId',
  'openingBalance',
  'startingBalance',
  'currentBalance',
  'usedAt',
  'lastBackupAt',
  'createdAt',
  'updatedAt',
  'schemaVersion',
  'settings',
  'status',
]);

const findForbiddenField = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenField(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenPatchFields.has(key)) return key;
    const found = findForbiddenField(nested);
    if (found) return found;
  }
  return undefined;
};

export function parsePlanPatch(raw: string): PlanPatch {
  const document = extractSingleJsonDocument(raw);
  if (document.length > MAX_AI_PLAN_INPUT_BYTES) throw new Error('Predlog izmena je prevelik.');
  let json: unknown;
  try {
    json = JSON.parse(document);
  } catch {
    throw new Error('Sadržaj nije jedan validan JSON dokument.');
  }
  const forbidden = findForbiddenField(json);
  if (forbidden) {
    throw new Error(`Predlog ne sme da menja istorijsko ili interno polje „${forbidden}”.`);
  }
  const envelope = patchEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    const issue = envelope.error.issues[0];
    throw new Error(
      `Predlog nije validan: ${issue?.path.join('.') || 'format'} — ${issue?.message ?? 'greška'}`,
    );
  }
  const operations: PlanPatchOperation[] = envelope.data.operations.map((rawOperation, index) => {
    const specialOperation = addGoalWithProtectedAccountSchema.safeParse(rawOperation);
    if (specialOperation.success) {
      const value = specialOperation.data.value;
      if (
        value.contributionStartMonth &&
        value.contributionEndMonth &&
        value.contributionEndMonth < value.contributionStartMonth
      ) {
        throw new Error(`Operacija ${index + 1}: kraj plana doprinosa ne može biti pre početka.`);
      }
      return specialOperation.data;
    }
    const parsedEnvelope = operationEnvelopeSchema.safeParse(rawOperation);
    if (!parsedEnvelope.success) {
      const issue = parsedEnvelope.error.issues[0];
      throw new Error(
        `Operacija ${index + 1} nije validna: ${issue?.path.join('.') || 'format'} — ${issue?.message ?? 'greška'}`,
      );
    }
    const operation = parsedEnvelope.data;
    if (operation.op === 'update') {
      if (!operation.ref || operation.value !== undefined || operation.changes === undefined) {
        throw new Error(`Operacija ${index + 1}: update zahteva ref i changes.`);
      }
      const changes = updateSchemas[operation.entity].safeParse(operation.changes);
      if (!changes.success) {
        const issue = changes.error.issues[0];
        throw new Error(
          `Operacija ${index + 1}: ${issue?.path.join('.') || 'changes'} — ${issue?.message ?? 'greška'}`,
        );
      }
      return { op: 'update', entity: operation.entity, ref: operation.ref, changes: changes.data };
    }
    if (operation.op === 'create') {
      const schema = createSchemas[operation.entity];
      if (
        !schema ||
        operation.ref ||
        operation.changes !== undefined ||
        operation.value === undefined
      ) {
        throw new Error(`Operacija ${index + 1}: create nije podržan za ovaj oblik ili entitet.`);
      }
      const value = schema.safeParse(operation.value);
      if (!value.success) {
        const issue = value.error.issues[0];
        throw new Error(
          `Operacija ${index + 1}: ${issue?.path.join('.') || 'value'} — ${issue?.message ?? 'greška'}`,
        );
      }
      return { op: 'create', entity: operation.entity, value: value.data };
    }
    if (
      !operation.ref ||
      operation.value !== undefined ||
      operation.changes !== undefined ||
      !archivableEntities.has(operation.entity)
    ) {
      throw new Error(`Operacija ${index + 1}: archive nije podržan za ovaj oblik ili entitet.`);
    }
    return { op: 'archive', entity: operation.entity, ref: operation.ref };
  });
  return { planPatchVersion: PLAN_PATCH_VERSION, operations };
}

const entityCollections = {
  account: 'accounts',
  plannedIncome: 'plannedIncomes',
  fixedCommitment: 'commitments',
  variableBudget: 'variableBudgets',
  goal: 'goals',
  debt: 'debts',
  plannedEvent: 'plannedEvents',
  salaryScenario: 'salaryScenarios',
  quickAddPreset: 'presets',
} as const satisfies Record<PatchEntity, keyof FinanceData>;

const refFor = (entity: PatchEntity | 'category', id: string): string => `${entity}:${id}`;

const cloneFinanceData = (snapshot: FinanceSnapshot): FinanceData =>
  structuredClone({
    accounts: snapshot.accounts,
    transactions: snapshot.transactions,
    categories: snapshot.categories,
    plannedIncomes: snapshot.plannedIncomes,
    commitments: snapshot.commitments,
    variableBudgets: snapshot.variableBudgets,
    goals: snapshot.goals,
    debts: snapshot.debts,
    debtPayments: snapshot.debtPayments,
    plannedEvents: snapshot.plannedEvents,
    presets: snapshot.presets,
    salaryScenarios: snapshot.salaryScenarios,
    settings: snapshot.settings,
  });

const planningFingerprint = (data: FinanceData): string =>
  JSON.stringify({
    accounts: data.accounts,
    categories: data.categories,
    plannedIncomes: data.plannedIncomes,
    commitments: data.commitments,
    variableBudgets: data.variableBudgets,
    goals: data.goals,
    debts: data.debts,
    plannedEvents: data.plannedEvents,
    presets: data.presets,
    salaryScenarios: data.salaryScenarios,
    settings: data.settings.map((value) => ({
      id: value.id,
      defaultAccountId: value.defaultAccountId,
      activeSalaryScenarioId: value.activeSalaryScenarioId,
    })),
  });

const entityLabel = {
  account: 'Račun',
  plannedIncome: 'Planirani prihod',
  fixedCommitment: 'Obaveza',
  variableBudget: 'Budžet',
  goal: 'Cilj',
  debt: 'Dug',
  plannedEvent: 'Događaj',
  salaryScenario: 'Scenario plate',
  quickAddPreset: 'Brzi unos',
} satisfies Record<PatchEntity, string>;

const displayName = (entity: PatchEntity, value: Record<string, unknown>): string => {
  const candidate = value.name ?? value.title ?? value.creditor;
  return typeof candidate === 'string' ? candidate : `${entityLabel[entity]} bez naziva`;
};

const fieldLabel: Record<string, string> = {
  name: 'Naziv',
  title: 'Naziv',
  creditor: 'Poverilac',
  amount: 'Iznos',
  defaultAmount: 'Mesečni budžet',
  targetAmount: 'Ciljni iznos',
  originalAmount: 'Početni dug',
  plannedAmount: 'Planirani iznos',
  monthlyAmount: 'Mesečni iznos',
  plannedMonthlyContribution: 'Mesečni plan štednje',
  plannedMonthlyPayment: 'Mesečni plan otplate',
  targetDate: 'Ciljni datum',
  dueDate: 'Rok',
  date: 'Datum',
  startDate: 'Početak',
  endDate: 'Kraj',
  startMonth: 'Početni mesec',
  active: 'Aktivno',
  archived: 'Arhivirano',
  notes: 'Beleška',
  overrides: 'Mesečne izmene',
  contributionOverrides: 'Mesečni plan doprinosa',
  paymentOverrides: 'Mesečni plan otplate',
};

const formatPatchValue = (field: string, value: unknown): string => {
  if (value === undefined || value === null || value === '') return 'Nije postavljeno';
  if (
    [
      'amount',
      'defaultAmount',
      'targetAmount',
      'originalAmount',
      'plannedAmount',
      'monthlyAmount',
      'plannedMonthlyContribution',
      'plannedMonthlyPayment',
    ].includes(field) &&
    typeof value === 'number'
  ) {
    return formatRsd(value);
  }
  if (typeof value === 'boolean') return value ? 'Da' : 'Ne';
  if (field.toLowerCase().includes('date') && typeof value === 'string') return formatDate(value);
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return `${value}`;
  return 'Nepoznata vrednost';
};

export interface PatchPreviewChange {
  field: string;
  label: string;
  before?: string;
  after: string;
}

export interface PatchPreviewOperation {
  index: number;
  op: PlanPatchOperation['op'];
  entity: PatchEntity;
  label: string;
  changes: PatchPreviewChange[];
}

export interface PreparedPlanPatch {
  patch: PlanPatch;
  sourceFingerprint: string;
  nextData: FinanceData;
  operations: PatchPreviewOperation[];
}

const resolveRef = <T extends { id: string }>(
  values: T[],
  expectedEntity: PatchEntity | 'category',
  reference: unknown,
): T => {
  if (typeof reference !== 'string' || !reference.startsWith(`${expectedEntity}:`)) {
    throw new Error(`Referenca „${String(reference)}” nije ${expectedEntity} referenca.`);
  }
  const id = reference.slice(expectedEntity.length + 1);
  const value = values.find((candidate) => candidate.id === id);
  if (!value) throw new Error(`Referenca „${reference}” više ne postoji.`);
  return value;
};

const mapChanges = (
  entity: PatchEntity,
  raw: Record<string, unknown>,
  data: FinanceData,
): Record<string, unknown> => {
  const changes = { ...raw };
  const replaceRef = (
    source: string,
    target: string,
    expected: PatchEntity | 'category',
    values: { id: string }[],
  ) => {
    if (!(source in changes)) return;
    const reference = changes[source];
    changes[target] = reference === null ? undefined : resolveRef(values, expected, reference).id;
    delete changes[source];
  };
  if (entity === 'plannedIncome' || entity === 'fixedCommitment') {
    replaceRef('accountRef', 'accountId', 'account', data.accounts);
    replaceRef('categoryRef', 'categoryId', 'category', data.categories);
  }
  if (entity === 'variableBudget') {
    replaceRef('categoryRef', 'categoryId', 'category', data.categories);
  }
  if (entity === 'goal') {
    replaceRef('linkedAccountRef', 'linkedAccountId', 'account', data.accounts);
  }
  if (entity === 'plannedEvent') {
    replaceRef('accountRef', 'accountId', 'account', data.accounts);
    replaceRef('categoryRef', 'categoryId', 'category', data.categories);
    replaceRef('linkedGoalRef', 'linkedGoalId', 'goal', data.goals);
  }
  if (entity === 'quickAddPreset') {
    replaceRef('defaultAccountRef', 'defaultAccountId', 'account', data.accounts);
    replaceRef('categoryRef', 'categoryId', 'category', data.categories);
  }
  for (const key of [
    'endDate',
    'expectedDay',
    'notes',
    'targetDate',
    'contributionStartMonth',
    'contributionEndMonth',
    'dueDate',
    'plannedMonthlyPayment',
    'paymentDay',
    'amount',
  ]) {
    if (changes[key] === null) changes[key] = undefined;
  }
  return changes;
};

const createEntity = (
  entity: PatchEntity,
  raw: Record<string, unknown>,
  data: FinanceData,
): Record<string, unknown> => {
  const now = new Date().toISOString();
  const value = mapChanges(entity, raw, data);
  switch (entity) {
    case 'plannedIncome':
      return { id: createId('income'), createdAt: now, ...value };
    case 'fixedCommitment':
      return { id: createId('commitment'), createdAt: now, ...value };
    case 'variableBudget':
      return { id: createId('budget'), createdAt: now, ...value };
    case 'goal':
      return { id: createId('goal'), archived: false, createdAt: now, ...value };
    case 'debt':
      return { id: createId('debt'), status: 'open', createdAt: now, ...value };
    case 'plannedEvent':
      return { id: createId('event'), createdAt: now, ...value };
    case 'salaryScenario':
      return { id: createId('scenario'), createdAt: now, ...value };
    case 'quickAddPreset':
      return { id: createId('preset'), ...value };
    case 'account':
      throw new Error('Patch ne kreira račune sa početnim stanjem.');
  }
};

export function preparePlanPatch(patch: PlanPatch, snapshot: FinanceSnapshot): PreparedPlanPatch {
  const data = cloneFinanceData(snapshot);
  const operations: PatchPreviewOperation[] = [];
  const touched = new Set<string>();

  patch.operations.forEach((operation, index) => {
    if (operation.op === 'addGoalWithProtectedAccount') {
      const now = new Date().toISOString();
      const accountId = createId('account');
      const goalId = createId('goal');
      data.accounts.push({
        id: accountId,
        name: operation.value.accountName,
        kind: 'savings',
        openingBalance: 0,
        protected: true,
        color: '#6b7280',
        archived: false,
        createdAt: now,
      });
      data.goals.push({
        id: goalId,
        name: operation.value.goalName,
        emoji: operation.value.emoji,
        targetAmount: operation.value.targetAmount,
        targetDate: operation.value.targetDate,
        linkedAccountId: accountId,
        plannedMonthlyContribution: operation.value.plannedMonthlyContribution,
        contributionOverrides: operation.value.contributionOverrides,
        contributionStartMonth: operation.value.contributionStartMonth,
        contributionEndMonth: operation.value.contributionEndMonth,
        goalType: operation.value.goalType,
        notes: operation.value.notes,
        archived: false,
        createdAt: now,
      });
      operations.push({
        index,
        op: operation.op,
        entity: 'goal',
        label: operation.value.goalName,
        changes: [
          {
            field: 'accountName',
            label: 'Novi zaštićeni štedni račun',
            after: operation.value.accountName,
          },
          {
            field: 'openingBalance',
            label: 'Početno stanje novog računa',
            after: '0 RSD — ne dodaje se novac',
          },
          {
            field: 'targetAmount',
            label: 'Ciljni iznos',
            after: formatRsd(operation.value.targetAmount),
          },
          {
            field: 'goalType',
            label: 'Vrsta cilja',
            after: operation.value.goalType,
          },
        ],
      });
      return;
    }
    const collectionName = entityCollections[operation.entity];
    const collection = data[collectionName] as unknown as Array<
      Record<string, unknown> & { id: string }
    >;
    if (operation.op === 'create') {
      const created = createEntity(operation.entity, operation.value ?? {}, data);
      collection.push(created as Record<string, unknown> & { id: string });
      operations.push({
        index,
        op: 'create',
        entity: operation.entity,
        label: displayName(operation.entity, created),
        changes: Object.entries(operation.value ?? {}).map(([field, value]) => ({
          field,
          label: fieldLabel[field] ?? field,
          after: formatPatchValue(field, value),
        })),
      });
      return;
    }

    const reference = operation.ref ?? '';
    const expectedPrefix = `${operation.entity}:`;
    if (!reference.startsWith(expectedPrefix)) {
      throw new Error(`Operacija ${index + 1} koristi referencu pogrešnog tipa.`);
    }
    const target = collection.find((value) => value.id === reference.slice(expectedPrefix.length));
    if (!target) throw new Error(`Operacija ${index + 1}: „${reference}” ne postoji.`);
    if (touched.has(reference)) {
      throw new Error(`Entitet „${reference}” je promenjen više puta u istom predlogu.`);
    }
    touched.add(reference);

    if (operation.op === 'archive') {
      const field =
        operation.entity === 'account' || operation.entity === 'goal' ? 'archived' : 'active';
      target[field] = field === 'archived';
      operations.push({
        index,
        op: 'archive',
        entity: operation.entity,
        label: displayName(operation.entity, target),
        changes: [{ field, label: 'Status', after: 'Arhivirano / neaktivno' }],
      });
      return;
    }

    if (operation.entity === 'plannedEvent' && target.paidTransactionId) {
      throw new Error('Plaćeni događaj ne može biti promenjen kroz Predlog izmena.');
    }
    const mapped = mapChanges(operation.entity, operation.changes ?? {}, data);
    const previewChanges = Object.entries(operation.changes ?? {}).map(([field, value]) => {
      const internalField =
        {
          accountRef: 'accountId',
          categoryRef: 'categoryId',
          linkedAccountRef: 'linkedAccountId',
          linkedGoalRef: 'linkedGoalId',
          defaultAccountRef: 'defaultAccountId',
        }[field] ?? field;
      return {
        field,
        label: fieldLabel[field] ?? field,
        before: formatPatchValue(field, target[internalField]),
        after: formatPatchValue(field, value),
      };
    });
    for (const [field, value] of Object.entries(mapped)) {
      if (
        ['overrides', 'contributionOverrides', 'paymentOverrides'].includes(field) &&
        value &&
        typeof value === 'object'
      ) {
        target[field] = { ...(target[field] as Record<string, number>), ...value };
      } else {
        target[field] = value;
      }
    }
    operations.push({
      index,
      op: 'update',
      entity: operation.entity,
      label: displayName(operation.entity, target),
      changes: previewChanges,
    });
  });

  const parsed = financeDataSchema.parse(data);
  assertFinanceDataIntegrity(parsed);
  return {
    patch,
    sourceFingerprint: planningFingerprint(cloneFinanceData(snapshot)),
    nextData: parsed,
    operations,
  };
}

const readInsidePatchTransaction = async (): Promise<FinanceData> => {
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
};

export async function applyPlanPatch(prepared: PreparedPlanPatch): Promise<void> {
  await auditedFinanceTransaction(
    [
      db.accounts,
      db.transactions,
      db.categories,
      db.plannedIncomes,
      db.commitments,
      db.variableBudgets,
      db.goals,
      db.debts,
      db.debtPayments,
      db.plannedEvents,
      db.presets,
      db.salaryScenarios,
      db.settings,
    ],
    async (audit) => {
      const current = await readInsidePatchTransaction();
      if (planningFingerprint(current) !== prepared.sourceFingerprint) {
        throw new Error('Plan se promenio od pregleda. Ponovo učitajte Predlog izmena.');
      }
      const next: FinanceData = {
        ...prepared.nextData,
        transactions: current.transactions,
        debtPayments: current.debtPayments,
        categories: current.categories,
        settings: current.settings,
      };
      const parsed = financeDataSchema.parse(next);
      assertFinanceDataIntegrity(parsed);
      await db.accounts.bulkPut(parsed.accounts);
      await db.plannedIncomes.bulkPut(parsed.plannedIncomes);
      await db.commitments.bulkPut(parsed.commitments);
      await db.variableBudgets.bulkPut(parsed.variableBudgets);
      await db.goals.bulkPut(parsed.goals);
      await db.debts.bulkPut(parsed.debts);
      await db.plannedEvents.bulkPut(parsed.plannedEvents);
      await db.presets.bulkPut(parsed.presets);
      await db.salaryScenarios.bulkPut(parsed.salaryScenarios);
      await auditFinanceDataChanges(audit, current, parsed);
    },
  );
}

export interface PlanningContext {
  currentPlanningContextVersion: 1;
  currency: 'RSD';
  accounts: Array<{
    ref: string;
    name: string;
    kind: string;
    protected: boolean;
    archived: boolean;
    currentBalance: number;
  }>;
  categories: Array<{ ref: string; name: string; kind: string }>;
  plannedIncomes: Array<Record<string, unknown>>;
  fixedCommitments: Array<Record<string, unknown>>;
  variableBudgets: Array<Record<string, unknown>>;
  goals: Array<Record<string, unknown>>;
  debts: Array<Record<string, unknown>>;
  plannedEvents: Array<Record<string, unknown>>;
  salaryScenarios: Array<Record<string, unknown>>;
  quickAddPresets: Array<Record<string, unknown>>;
}

export function createPlanningContext(snapshot: FinanceSnapshot): PlanningContext {
  const balances = calculateAccountBalances(snapshot.accounts, snapshot.transactions);
  return {
    currentPlanningContextVersion: 1,
    currency: 'RSD',
    accounts: snapshot.accounts.map((value) => ({
      ref: refFor('account', value.id),
      name: value.name,
      kind: value.kind,
      protected: value.protected,
      archived: value.archived,
      currentBalance: balances[value.id] ?? 0,
    })),
    categories: snapshot.categories.map((value) => ({
      ref: refFor('category', value.id),
      name: value.name,
      kind: value.kind,
    })),
    plannedIncomes: snapshot.plannedIncomes.map((value) => ({
      ref: refFor('plannedIncome', value.id),
      name: value.name,
      amount: value.amount,
      frequency: value.frequency,
      startDate: value.startDate,
      endDate: value.endDate,
      expectedDay: value.expectedDay,
      active: value.active,
      isPrimarySalary: value.isPrimarySalary,
      notes: value.notes,
      categoryRef: refFor('category', value.categoryId),
      accountRef: refFor('account', value.accountId),
    })),
    fixedCommitments: snapshot.commitments.map((value) => ({
      ref: refFor('fixedCommitment', value.id),
      name: value.name,
      amount: value.amount,
      frequency: value.frequency,
      startDate: value.startDate,
      endDate: value.endDate,
      dueDay: value.dueDay,
      active: value.active,
      notes: value.notes,
      categoryRef: refFor('category', value.categoryId),
      accountRef: refFor('account', value.accountId),
    })),
    variableBudgets: snapshot.variableBudgets.map((value) => ({
      ref: refFor('variableBudget', value.id),
      name: value.name,
      defaultAmount: value.defaultAmount,
      overrides: value.overrides,
      active: value.active,
      categoryRef: refFor('category', value.categoryId),
    })),
    goals: snapshot.goals.map((value) => ({
      ref: refFor('goal', value.id),
      name: value.name,
      emoji: value.emoji,
      targetAmount: value.targetAmount,
      targetDate: value.targetDate,
      plannedMonthlyContribution: value.plannedMonthlyContribution,
      contributionOverrides: value.contributionOverrides,
      contributionStartMonth: value.contributionStartMonth,
      contributionEndMonth: value.contributionEndMonth,
      goalType: value.goalType,
      notes: value.notes,
      archived: value.archived,
      linkedAccountRef: refFor('account', value.linkedAccountId),
      currentBalance: balances[value.linkedAccountId] ?? 0,
    })),
    debts: snapshot.debts.map((value) => ({
      ref: refFor('debt', value.id),
      creditor: value.creditor,
      dueDate: value.dueDate,
      priority: value.priority,
      notes: value.notes,
      plannedMonthlyPayment: value.plannedMonthlyPayment,
      paymentDay: value.paymentDay,
      paymentOverrides: value.paymentOverrides,
      currentRemaining: calculateDebtProgress(value, snapshot.debtPayments).remaining,
    })),
    plannedEvents: snapshot.plannedEvents
      .filter((value) => !value.paidTransactionId)
      .map((value) => ({
        ref: refFor('plannedEvent', value.id),
        title: value.title,
        date: value.date,
        plannedAmount: value.plannedAmount,
        notes: value.notes,
        categoryRef: refFor('category', value.categoryId),
        accountRef: refFor('account', value.accountId),
        linkedGoalRef: value.linkedGoalId ? refFor('goal', value.linkedGoalId) : undefined,
      })),
    salaryScenarios: snapshot.salaryScenarios.map((value) => ({
      ref: refFor('salaryScenario', value.id),
      name: value.name,
      monthlyAmount: value.monthlyAmount,
      startMonth: value.startMonth,
    })),
    quickAddPresets: snapshot.presets.map((value) => ({
      ref: refFor('quickAddPreset', value.id),
      name: value.name,
      emoji: value.emoji,
      type: value.type,
      amount: value.amount,
      position: value.position,
      active: value.active,
      categoryRef: value.categoryId ? refFor('category', value.categoryId) : undefined,
      defaultAccountRef: value.defaultAccountId
        ? refFor('account', value.defaultAccountId)
        : undefined,
    })),
  };
}

export const createPatchPrompt = (
  snapshot: FinanceSnapshot,
): string => `Predloži SAMO izmene postojećeg Mirna finansijskog plana koje smo izričito dogovorili u ovom razgovoru.

PRAVILA:
- Koristi samo odluke koje je korisnik već potvrdio. Ne menjaj ništa samo zato što misliš da bi bilo bolje.
- Ne izmišljaj iznose, datume, prihode, dugove ili događaje. Nepoznate i nedogovorene izmene izostavi.
- Vrati tačno jedan JSON dokument bez Markdown objašnjenja.
- Svi iznosi su celi RSD brojevi.
- Ne vraćaj transakcije, korekcije stanja, istoriju uplata duga, openingBalance, currentBalance, occurrenceKey, paidTransactionId, usedAt, status, interne ID-jeve, createdAt ili backup metadata.
- Postojeće entitete uvek identifikuj dostavljenim ref poljem, nikada samo nazivom.
- Izmene će korisnik pregledati pre primene. Mirna proverava strukturu i reference, ali ne garantuje kvalitet finansijskog saveta.

Format:
{
  "planPatchVersion": 1,
  "operations": [
    {
      "op": "update",
      "entity": "variableBudget",
      "ref": "variableBudget:...",
      "changes": { "defaultAmount": 12000 }
    }
  ]
}

Podržani update entiteti: account metadata bez početnog stanja, plannedIncome, fixedCommitment, variableBudget, goal bez usedAt, debt plan bez istorije/originalnog iznosa/statusa, neplaćeni plannedEvent, salaryScenario i quickAddPreset.
Podržani create entiteti: plannedIncome, fixedCommitment, variableBudget, goal sa postojećim zaštićenim account ref-om, debt, plannedEvent, salaryScenario i quickAddPreset. Create koristi "value" umesto "ref"/"changes".
Za novi cilj koji nema postojeći namenski račun koristi isključivo posebnu operaciju:
{ "op": "addGoalWithProtectedAccount", "value": { "accountName": "...", "goalName": "...", "emoji": "🎯", "targetAmount": 100000, "plannedMonthlyContribution": 0, "contributionOverrides": {}, "goalType": "sinking" } }
Ta operacija lokalno i atomski pravi zaštićeni savings račun sa stanjem 0 RSD i povezani cilj. Ne smeš dodati polje stanja niti tvrditi da je novac dodat.
Podržani archive entiteti: account, plannedIncome, fixedCommitment, variableBudget, goal i quickAddPreset. Archive koristi samo op, entity i ref.
Za reference u poljima koristi accountRef, categoryRef, linkedAccountRef, linkedGoalRef i defaultAccountRef iz konteksta.

TRENUTNI PLANERSKI KONTEKST
Trenutna stanja su eksplicitno označena samo kao high-level currentBalance/currentRemaining kontekst. Istorijske transakcije nisu uključene i ne smeju se vratiti u patch.

${JSON.stringify(createPlanningContext(snapshot), null, 2)}`;
