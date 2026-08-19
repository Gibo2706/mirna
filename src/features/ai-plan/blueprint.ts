import { isMatch } from 'date-fns';
import { z } from 'zod';
import { assertFinanceDataIntegrity } from '@/domain/integrity';
import { financeDataSchema } from '@/domain/schemas';
import type { FinanceData } from '@/domain/types';
import { db, financeTables } from '@/db/database';
import { readRawFinanceDataInTransaction } from '@/db/finance-data';
import { auditFinanceDataChanges, auditedFinanceTransaction } from '@/db/sync/mutation-audit';
import { readFinanceData } from '@/db/queries';
import { createId } from '@/lib/id';

export const PLAN_BLUEPRINT_VERSION = 1;
export const MAX_AI_PLAN_INPUT_BYTES = 512 * 1024;

const MAX_ENTITIES_PER_KIND = 200;
const MAX_TOTAL_ENTITIES = 600;
const money = z.number().int().nonnegative().max(1_000_000_000_000);
const positiveMoney = money.positive();
const shortText = z.string().trim().min(1).max(120);
const notes = z.string().trim().max(2_000).optional();
const localKey = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'Ključ mora početi slovom i biti kratak.');
const isoDate = z
  .string()
  .refine((value) => isMatch(value, 'yyyy-MM-dd'), 'Datum mora biti stvarni ISO datum.');
const monthKey = z
  .string()
  .refine((value) => isMatch(value, 'yyyy-MM'), 'Mesec mora biti u YYYY-MM formatu.');
const timestampNow = () => new Date().toISOString();

const accountBlueprintSchema = z.strictObject({
  key: localKey,
  name: shortText,
  kind: z.enum(['checking', 'cash', 'savings']),
  startingBalance: money.nullable(),
  protected: z.boolean(),
});

const categoryBlueprintSchema = z.strictObject({
  key: localKey,
  name: shortText,
  kind: z.enum(['income', 'expense']),
  icon: z.string().trim().max(12).default('•'),
});

const plannedIncomeBlueprintSchema = z.strictObject({
  key: localKey,
  name: shortText,
  amount: positiveMoney,
  categoryKey: localKey,
  accountKey: localKey,
  frequency: z.enum(['monthly', 'weekly', 'yearly']),
  startDate: isoDate,
  endDate: isoDate.optional(),
  expectedDay: z.number().int().min(1).max(31).optional(),
  active: z.boolean().default(true),
  isPrimarySalary: z.boolean().default(false),
  notes,
});

const fixedCommitmentBlueprintSchema = z.strictObject({
  key: localKey,
  name: shortText,
  amount: positiveMoney,
  categoryKey: localKey,
  accountKey: localKey,
  frequency: z.enum(['monthly', 'weekly', 'yearly']),
  startDate: isoDate,
  endDate: isoDate.optional(),
  dueDay: z.number().int().min(1).max(31),
  active: z.boolean().default(true),
  notes,
});

const variableBudgetBlueprintSchema = z.strictObject({
  key: localKey,
  name: shortText,
  defaultAmount: money,
  categoryKey: localKey,
  overrides: z.record(monthKey, money).default({}),
  active: z.boolean().default(true),
});

const goalBlueprintSchema = z.strictObject({
  key: localKey,
  name: shortText,
  emoji: z.string().trim().min(1).max(12).default('🎯'),
  targetAmount: positiveMoney,
  targetDate: isoDate.optional(),
  linkedAccountKey: localKey,
  plannedMonthlyContribution: money.default(0),
  contributionOverrides: z.record(monthKey, money).default({}),
  contributionStartMonth: monthKey.optional(),
  contributionEndMonth: monthKey.optional(),
  goalType: z.enum(['sinking', 'reserve']),
  notes,
});

const debtBlueprintSchema = z.strictObject({
  key: localKey,
  creditor: shortText,
  originalAmount: positiveMoney,
  dueDate: isoDate.optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  plannedMonthlyPayment: positiveMoney.optional(),
  paymentDay: z.number().int().min(1).max(31).optional(),
  paymentOverrides: z.record(monthKey, money).default({}),
  notes,
});

const plannedEventBlueprintSchema = z.strictObject({
  key: localKey,
  title: shortText,
  date: isoDate,
  plannedAmount: money,
  categoryKey: localKey,
  accountKey: localKey,
  linkedGoalKey: localKey.optional(),
  notes,
});

const salaryScenarioBlueprintSchema = z.strictObject({
  key: localKey,
  name: shortText,
  monthlyAmount: positiveMoney,
  startMonth: monthKey,
});

const quickAddPresetBlueprintSchema = z.strictObject({
  key: localKey,
  name: shortText,
  emoji: z.string().trim().max(12).default('⚡'),
  type: z.enum(['income', 'expense']),
  amount: positiveMoney.optional(),
  categoryKey: localKey.optional(),
  defaultAccountKey: localKey.optional(),
  position: z.number().int().nonnegative().max(999),
  active: z.boolean().default(true),
});

export const planBlueprintSchema = z
  .strictObject({
    planBlueprintVersion: z.literal(PLAN_BLUEPRINT_VERSION),
    currency: z.literal('RSD'),
    accounts: z.array(accountBlueprintSchema).max(MAX_ENTITIES_PER_KIND),
    categories: z.array(categoryBlueprintSchema).max(MAX_ENTITIES_PER_KIND),
    plannedIncomes: z.array(plannedIncomeBlueprintSchema).max(MAX_ENTITIES_PER_KIND),
    fixedCommitments: z.array(fixedCommitmentBlueprintSchema).max(MAX_ENTITIES_PER_KIND),
    variableBudgets: z.array(variableBudgetBlueprintSchema).max(MAX_ENTITIES_PER_KIND),
    goals: z.array(goalBlueprintSchema).max(MAX_ENTITIES_PER_KIND),
    debts: z.array(debtBlueprintSchema).max(MAX_ENTITIES_PER_KIND),
    plannedEvents: z.array(plannedEventBlueprintSchema).max(MAX_ENTITIES_PER_KIND),
    salaryScenarios: z.array(salaryScenarioBlueprintSchema).max(MAX_ENTITIES_PER_KIND),
    quickAddPresets: z.array(quickAddPresetBlueprintSchema).max(MAX_ENTITIES_PER_KIND),
  })
  .superRefine((blueprint, context) => {
    const groups = [
      ['accounts', blueprint.accounts],
      ['categories', blueprint.categories],
      ['plannedIncomes', blueprint.plannedIncomes],
      ['fixedCommitments', blueprint.fixedCommitments],
      ['variableBudgets', blueprint.variableBudgets],
      ['goals', blueprint.goals],
      ['debts', blueprint.debts],
      ['plannedEvents', blueprint.plannedEvents],
      ['salaryScenarios', blueprint.salaryScenarios],
      ['quickAddPresets', blueprint.quickAddPresets],
    ] as const;

    const total = groups.reduce((sum, [, values]) => sum + values.length, 0);
    if (total > MAX_TOTAL_ENTITIES) {
      context.addIssue({
        code: 'custom',
        message: `Plan može imati najviše ${MAX_TOTAL_ENTITIES} stavki.`,
      });
    }
    for (const [label, values] of groups) {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value.key)) {
          context.addIssue({
            code: 'custom',
            path: [label, index, 'key'],
            message: `Ključ „${value.key}” se ponavlja.`,
          });
        }
        seen.add(value.key);
      });
    }

    const accounts = new Map(blueprint.accounts.map((value) => [value.key, value]));
    const categories = new Map(blueprint.categories.map((value) => [value.key, value]));
    const goals = new Map(blueprint.goals.map((value) => [value.key, value]));
    const checkAccount = (key: string, path: (string | number)[]) => {
      if (!accounts.has(key)) {
        context.addIssue({ code: 'custom', path, message: `Račun „${key}” ne postoji.` });
      }
    };
    const checkCategory = (key: string, kind: 'income' | 'expense', path: (string | number)[]) => {
      const category = categories.get(key);
      if (!category) {
        context.addIssue({ code: 'custom', path, message: `Kategorija „${key}” ne postoji.` });
      } else if (category.kind !== kind) {
        context.addIssue({
          code: 'custom',
          path,
          message: `Kategorija „${key}” je pogrešnog tipa.`,
        });
      }
    };

    blueprint.plannedIncomes.forEach((value, index) => {
      checkAccount(value.accountKey, ['plannedIncomes', index, 'accountKey']);
      checkCategory(value.categoryKey, 'income', ['plannedIncomes', index, 'categoryKey']);
      if (value.endDate && value.endDate < value.startDate) {
        context.addIssue({
          code: 'custom',
          path: ['plannedIncomes', index, 'endDate'],
          message: 'Kraj prihoda ne može biti pre početka.',
        });
      }
    });
    if (blueprint.plannedIncomes.filter((value) => value.isPrimarySalary).length > 1) {
      context.addIssue({ code: 'custom', message: 'Može postojati samo jedna primarna plata.' });
    }
    blueprint.fixedCommitments.forEach((value, index) => {
      checkAccount(value.accountKey, ['fixedCommitments', index, 'accountKey']);
      checkCategory(value.categoryKey, 'expense', ['fixedCommitments', index, 'categoryKey']);
      if (value.endDate && value.endDate < value.startDate) {
        context.addIssue({
          code: 'custom',
          path: ['fixedCommitments', index, 'endDate'],
          message: 'Kraj obaveze ne može biti pre početka.',
        });
      }
    });
    blueprint.variableBudgets.forEach((value, index) =>
      checkCategory(value.categoryKey, 'expense', ['variableBudgets', index, 'categoryKey']),
    );
    blueprint.goals.forEach((value, index) => {
      const account = accounts.get(value.linkedAccountKey);
      if (!account) {
        checkAccount(value.linkedAccountKey, ['goals', index, 'linkedAccountKey']);
      } else if (!account.protected || account.kind !== 'savings') {
        context.addIssue({
          code: 'custom',
          path: ['goals', index, 'linkedAccountKey'],
          message: 'Cilj mora koristiti zaštićeni štedni račun.',
        });
      }
      if (
        value.contributionStartMonth &&
        value.contributionEndMonth &&
        value.contributionEndMonth < value.contributionStartMonth
      ) {
        context.addIssue({
          code: 'custom',
          path: ['goals', index, 'contributionEndMonth'],
          message: 'Kraj plana doprinosa ne može biti pre početka.',
        });
      }
    });
    if (
      new Set(blueprint.goals.map((value) => value.linkedAccountKey)).size !==
      blueprint.goals.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Dva cilja ne mogu koristiti isti namenski račun.',
      });
    }
    blueprint.plannedEvents.forEach((value, index) => {
      checkAccount(value.accountKey, ['plannedEvents', index, 'accountKey']);
      checkCategory(value.categoryKey, 'expense', ['plannedEvents', index, 'categoryKey']);
      if (value.linkedGoalKey && !goals.has(value.linkedGoalKey)) {
        context.addIssue({
          code: 'custom',
          path: ['plannedEvents', index, 'linkedGoalKey'],
          message: `Cilj „${value.linkedGoalKey}” ne postoji.`,
        });
      }
    });
    blueprint.quickAddPresets.forEach((value, index) => {
      if (value.defaultAccountKey) {
        checkAccount(value.defaultAccountKey, ['quickAddPresets', index, 'defaultAccountKey']);
      }
      if (value.categoryKey) {
        checkCategory(value.categoryKey, value.type, ['quickAddPresets', index, 'categoryKey']);
      }
    });
  });

export type PlanBlueprint = z.infer<typeof planBlueprintSchema>;

const forbiddenBlueprintFields = new Set([
  'id',
  'transactions',
  'balanceAdjustments',
  'adjustments',
  'debtPayments',
  'paidTransactionId',
  'transactionId',
  'occurrenceKey',
  'plannedIncomeId',
  'plannedEventId',
  'usedAt',
  'lastBackupAt',
  'createdAt',
  'updatedAt',
  'schemaVersion',
  'settings',
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
    if (forbiddenBlueprintFields.has(key)) return key;
    const found = findForbiddenField(nested);
    if (found) return found;
  }
  return undefined;
};

export function extractSingleJsonDocument(raw: string): string {
  const bytes =
    typeof TextEncoder === 'undefined' ? raw.length : new TextEncoder().encode(raw).byteLength;
  if (bytes > MAX_AI_PLAN_INPUT_BYTES) {
    throw new Error('JSON je prevelik. Maksimalna veličina je 512 KB.');
  }
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Nalepite JSON plan.');
  if (!trimmed.startsWith('```')) {
    if (trimmed.includes('```')) {
      throw new Error('Pronađeno je nejasno ili nepotpuno JSON ograđivanje.');
    }
    return trimmed;
  }

  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline < 0) throw new Error('JSON code block nije zatvoren.');
  const opening = trimmed.slice(0, firstNewline).trim().toLowerCase();
  if (opening !== '```' && opening !== '```json') {
    throw new Error('Podržan je samo jedan običan JSON code block.');
  }
  const closingStart = trimmed.lastIndexOf('\n```');
  if (closingStart <= firstNewline || trimmed.slice(closingStart + 4).trim()) {
    throw new Error('Pronađeno je više ili nepotpuno JSON dokumenata.');
  }
  const document = trimmed.slice(firstNewline + 1, closingStart).trim();
  if (!document || document.includes('```')) {
    throw new Error('Pronađeno je više ili nepotpuno JSON dokumenata.');
  }
  return document;
}

export interface PlanBlueprintPreview {
  blueprint: PlanBlueprint;
  warnings: string[];
  unresolvedAccountKeys: string[];
  counts: {
    accounts: number;
    categories: number;
    plannedIncomes: number;
    fixedCommitments: number;
    variableBudgets: number;
    goals: number;
    debts: number;
    plannedEvents: number;
    salaryScenarios: number;
    quickAddPresets: number;
  };
}

const createPlanBlueprintPreview = (blueprint: PlanBlueprint): PlanBlueprintPreview => {
  const unresolvedAccountKeys = blueprint.accounts
    .filter((value) => value.startingBalance === null)
    .map((value) => value.key);
  return {
    blueprint,
    warnings: [
      ...(blueprint.accounts.some(
        (value) => value.startingBalance !== null && value.startingBalance > 0,
      )
        ? ['Plan sadrži početna stanja računa. Pažljivo proverite svaki iznos.']
        : []),
      ...(unresolvedAccountKeys.length
        ? ['Unesite trenutno stanje za svaki označeni račun pre uvoza.']
        : []),
      ...(blueprint.debts.length
        ? ['Dugovi predstavljaju početno preostalo/originalno stanje bez istorije uplata.']
        : []),
      ...(blueprint.plannedEvents.some(
        (value) => value.date < new Date().toISOString().slice(0, 10),
      )
        ? ['Plan sadrži događaj sa datumom u prošlosti. On će ostati neplaćen plan.']
        : []),
    ],
    unresolvedAccountKeys,
    counts: {
      accounts: blueprint.accounts.length,
      categories: blueprint.categories.length,
      plannedIncomes: blueprint.plannedIncomes.length,
      fixedCommitments: blueprint.fixedCommitments.length,
      variableBudgets: blueprint.variableBudgets.length,
      goals: blueprint.goals.length,
      debts: blueprint.debts.length,
      plannedEvents: blueprint.plannedEvents.length,
      salaryScenarios: blueprint.salaryScenarios.length,
      quickAddPresets: blueprint.quickAddPresets.length,
    },
  };
};

export function parsePlanBlueprint(raw: string): PlanBlueprintPreview {
  const document = extractSingleJsonDocument(raw);
  let json: unknown;
  try {
    json = JSON.parse(document);
  } catch {
    throw new Error('Sadržaj nije jedan validan JSON dokument.');
  }
  const forbidden = findForbiddenField(json);
  if (forbidden) {
    throw new Error(`Blueprint ne prihvata istorijsko ili interno polje „${forbidden}”.`);
  }
  const result = planBlueprintSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') || 'format';
    throw new Error(`Plan nije validan: ${path} — ${issue?.message ?? 'greška'}`);
  }
  return createPlanBlueprintPreview(result.data);
}

export function setBlueprintStartingBalance(
  preview: PlanBlueprintPreview,
  accountKey: string,
  startingBalance: number | null,
): PlanBlueprintPreview {
  if (!preview.blueprint.accounts.some((value) => value.key === accountKey)) {
    throw new Error(`Račun „${accountKey}” ne postoji.`);
  }
  const blueprint = planBlueprintSchema.parse({
    ...preview.blueprint,
    accounts: preview.blueprint.accounts.map((value) =>
      value.key === accountKey ? { ...value, startingBalance } : value,
    ),
  });
  return createPlanBlueprintPreview(blueprint);
}

const accountColor = {
  checking: '#2f7d64',
  cash: '#64748b',
  savings: '#6b7280',
} as const;

const categoryColor = {
  income: '#2f7d64',
  expense: '#64748b',
} as const;

export function normalizePlanBlueprint(
  blueprint: PlanBlueprint,
  onboardingCompleted = false,
): FinanceData {
  const now = timestampNow();
  const accountIds = new Map(blueprint.accounts.map((value) => [value.key, createId('account')]));
  const categoryIds = new Map(
    blueprint.categories.map((value) => [value.key, createId('category')]),
  );
  const goalIds = new Map(blueprint.goals.map((value) => [value.key, createId('goal')]));
  const requireRef = (map: Map<string, string>, key: string): string => {
    const value = map.get(key);
    if (!value) throw new Error(`Referenca „${key}” nije pronađena.`);
    return value;
  };
  const accounts = blueprint.accounts.map((value) => {
    if (value.startingBalance === null) {
      throw new Error(`Unesite trenutno stanje za račun „${value.name}”.`);
    }
    return {
      id: requireRef(accountIds, value.key),
      name: value.name,
      kind: value.kind,
      openingBalance: value.startingBalance,
      protected: value.protected,
      color: accountColor[value.kind],
      archived: false,
      createdAt: now,
    };
  });
  const categories = blueprint.categories.map((value) => ({
    id: requireRef(categoryIds, value.key),
    name: value.name,
    kind: value.kind,
    icon: value.icon,
    color: categoryColor[value.kind],
    archived: false,
  }));
  const plannedIncomes = blueprint.plannedIncomes.map((value) => ({
    id: createId('income'),
    name: value.name,
    amount: value.amount,
    categoryId: requireRef(categoryIds, value.categoryKey),
    accountId: requireRef(accountIds, value.accountKey),
    frequency: value.frequency,
    startDate: value.startDate,
    endDate: value.endDate,
    expectedDay: value.expectedDay,
    active: value.active,
    isPrimarySalary: value.isPrimarySalary,
    notes: value.notes,
    createdAt: now,
  }));
  const data: FinanceData = {
    accounts,
    transactions: [],
    categories,
    plannedIncomes,
    commitments: blueprint.fixedCommitments.map((value) => ({
      id: createId('commitment'),
      name: value.name,
      amount: value.amount,
      categoryId: requireRef(categoryIds, value.categoryKey),
      accountId: requireRef(accountIds, value.accountKey),
      frequency: value.frequency,
      startDate: value.startDate,
      endDate: value.endDate,
      dueDay: value.dueDay,
      active: value.active,
      notes: value.notes,
      createdAt: now,
    })),
    variableBudgets: blueprint.variableBudgets.map((value) => ({
      id: createId('budget'),
      name: value.name,
      defaultAmount: value.defaultAmount,
      categoryId: requireRef(categoryIds, value.categoryKey),
      overrides: value.overrides,
      active: value.active,
      createdAt: now,
    })),
    goals: blueprint.goals.map((value) => ({
      id: requireRef(goalIds, value.key),
      name: value.name,
      emoji: value.emoji,
      targetAmount: value.targetAmount,
      targetDate: value.targetDate,
      linkedAccountId: requireRef(accountIds, value.linkedAccountKey),
      plannedMonthlyContribution: value.plannedMonthlyContribution,
      contributionOverrides: value.contributionOverrides,
      contributionStartMonth: value.contributionStartMonth,
      contributionEndMonth: value.contributionEndMonth,
      goalType: value.goalType,
      notes: value.notes,
      archived: false,
      createdAt: now,
    })),
    debts: blueprint.debts.map((value) => ({
      id: createId('debt'),
      creditor: value.creditor,
      originalAmount: value.originalAmount,
      dueDate: value.dueDate,
      priority: value.priority,
      notes: value.notes,
      status: 'open' as const,
      plannedMonthlyPayment: value.plannedMonthlyPayment,
      paymentDay: value.paymentDay,
      paymentOverrides: value.paymentOverrides,
      createdAt: now,
    })),
    debtPayments: [],
    plannedEvents: blueprint.plannedEvents.map((value) => ({
      id: createId('event'),
      title: value.title,
      date: value.date,
      plannedAmount: value.plannedAmount,
      categoryId: requireRef(categoryIds, value.categoryKey),
      accountId: requireRef(accountIds, value.accountKey),
      linkedGoalId: value.linkedGoalKey ? requireRef(goalIds, value.linkedGoalKey) : undefined,
      notes: value.notes,
      createdAt: now,
    })),
    presets: blueprint.quickAddPresets.map((value) => ({
      id: createId('preset'),
      name: value.name,
      emoji: value.emoji,
      type: value.type,
      amount: value.amount,
      categoryId: value.categoryKey ? requireRef(categoryIds, value.categoryKey) : undefined,
      defaultAccountId: value.defaultAccountKey
        ? requireRef(accountIds, value.defaultAccountKey)
        : undefined,
      position: value.position,
      active: value.active,
    })),
    salaryScenarios: blueprint.salaryScenarios.map((value) => ({
      id: createId('scenario'),
      name: value.name,
      monthlyAmount: value.monthlyAmount,
      startMonth: value.startMonth,
      createdAt: now,
    })),
    settings: [
      {
        id: 'settings',
        onboardingCompleted,
        baseMonthlyIncome: plannedIncomes.find((value) => value.isPrimarySalary)?.amount ?? 0,
        currency: 'RSD',
        locale: 'sr-Latn-RS',
        appearance: 'system',
        defaultAccountId:
          accounts.find((value) => !value.protected && value.kind === 'checking')?.id ??
          accounts.find((value) => !value.protected)?.id ??
          accounts[0]?.id,
        installHintDismissed: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  const parsed = financeDataSchema.parse(data);
  assertFinanceDataIntegrity(parsed);
  return parsed;
}

const hasFinancialData = (data: FinanceData): boolean =>
  [
    data.accounts,
    data.transactions,
    data.categories,
    data.plannedIncomes,
    data.commitments,
    data.variableBudgets,
    data.goals,
    data.debts,
    data.debtPayments,
    data.plannedEvents,
    data.presets,
    data.salaryScenarios,
  ].some((values) => values.length > 0);

export async function importPlanBlueprint(
  preview: PlanBlueprintPreview,
  onboardingCompleted = false,
): Promise<void> {
  if (preview.unresolvedAccountKeys.length) {
    throw new Error('Unesite sva trenutna stanja računa pre uvoza.');
  }
  const current = await readFinanceData();
  if (hasFinancialData(current)) {
    throw new Error(
      'Blueprint je namenjen praznoj Mirni. Za postojeći plan koristite Predlog izmena.',
    );
  }
  const data = normalizePlanBlueprint(preview.blueprint, onboardingCompleted);
  await auditedFinanceTransaction(financeTables(), async (audit) => {
    const previous = await readRawFinanceDataInTransaction(db);
    if (hasFinancialData(previous)) {
      throw new Error(
        'Blueprint je namenjen praznoj Mirni. Za postojeći plan koristite Predlog izmena.',
      );
    }
    await Promise.all(financeTables().map((table) => table.clear()));
    await db.accounts.bulkAdd(data.accounts);
    await db.categories.bulkAdd(data.categories);
    await db.plannedIncomes.bulkAdd(data.plannedIncomes);
    await db.commitments.bulkAdd(data.commitments);
    await db.variableBudgets.bulkAdd(data.variableBudgets);
    await db.goals.bulkAdd(data.goals);
    await db.debts.bulkAdd(data.debts);
    await db.plannedEvents.bulkAdd(data.plannedEvents);
    await db.presets.bulkAdd(data.presets);
    await db.salaryScenarios.bulkAdd(data.salaryScenarios);
    await db.settings.bulkAdd(data.settings);
    await auditFinanceDataChanges(audit, previous, data);
  });
}

export const createBlueprintPrompt =
  (): string => `Pretvori SAMO finansijski plan koji smo već dogovorili u ovom razgovoru u Mirna Plan Blueprint v1.

VAŽNO:
- Koristi isključivo činjenice koje je korisnik već izričito naveo ili potvrdio.
- Ne izmišljaj stanje računa, platu, prihod, dug, trošak, datum ili budući događaj.
- Ako podatak nije poznat, izostavi tu stavku. Pretpostavka sme biti samo jasno označena u notes polju, nikada kao izmišljena finansijska činjenica.
- Svi novčani iznosi su celi RSD brojevi bez decimala.
- Vrati tačno jedan JSON dokument, bez Markdown objašnjenja.
- Ne vraćaj istorijske transakcije, korekcije stanja, uplate dugova, occurrence ključeve, paidTransactionId, interne ID-jeve, createdAt niti backup metadata.
- Ovo nije savetovanje niti Mirna backup. Ovo je samo konfiguracija budućeg plana i opciona početna stanja.

Obavezna struktura:
{
  "planBlueprintVersion": 1,
  "currency": "RSD",
  "accounts": [],
  "categories": [],
  "plannedIncomes": [],
  "fixedCommitments": [],
  "variableBudgets": [],
  "goals": [],
  "debts": [],
  "plannedEvents": [],
  "salaryScenarios": [],
  "quickAddPresets": []
}

Koristi kratke lokalne ključeve, na primer "checking", "food" i "trip_goal". Reference koriste te ključeve, ne Mirna ID-jeve.

Polja:
- accounts: { key, name, kind: "checking"|"cash"|"savings", startingBalance: integer|null, protected }
- categories: { key, name, kind: "income"|"expense", icon }
- plannedIncomes: { key, name, amount, categoryKey, accountKey, frequency: "monthly"|"weekly"|"yearly", startDate: "YYYY-MM-DD", endDate?, expectedDay?, active, isPrimarySalary, notes? }
- fixedCommitments: { key, name, amount, categoryKey, accountKey, frequency, startDate, endDate?, dueDay, active, notes? }
- variableBudgets: { key, name, defaultAmount, categoryKey, overrides: { "YYYY-MM": amount }, active }
- goals: { key, name, emoji, targetAmount, targetDate?, linkedAccountKey, plannedMonthlyContribution, contributionOverrides, contributionStartMonth?, contributionEndMonth?, goalType: "sinking"|"reserve", notes? }
- debts: { key, creditor, originalAmount, dueDate?, priority: "low"|"medium"|"high", plannedMonthlyPayment?, paymentDay?, paymentOverrides, notes? }
- plannedEvents: { key, title, date, plannedAmount, categoryKey, accountKey, linkedGoalKey?, notes? }
- salaryScenarios: { key, name, monthlyAmount, startMonth: "YYYY-MM" }
- quickAddPresets: { key, name, emoji, type: "income"|"expense", amount?, categoryKey?, defaultAccountKey?, position, active }

Sinking cilj je namenska štednja za poznatu svrhu; reserve je fond koji ostaje aktivan. Svaki cilj mora referencirati poseban zaštićeni savings račun. Ne izmišljaj početno stanje: koristi 0 samo kada je korisnik izričito potvrdio nulu; kada stanje računa nije poznato koristi null. Mirna će tražiti da korisnik unese trenutno stanje pre uvoza.

Pre konačnog JSON-a interno proveri: jedinstvene ključeve, sve reference, tip kategorije, stvarne ISO datume, cele RSD iznose i najviše jednu isPrimarySalary stavku.`;
