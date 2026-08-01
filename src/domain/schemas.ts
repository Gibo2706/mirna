import { z } from 'zod';

const safeInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const money = safeInteger.nonnegative();
const positiveMoney = money.positive();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const monthKey = z.string().regex(/^\d{4}-\d{2}$/);
const timestamp = z.string().datetime();
const id = z.string().min(1);

export const accountSchema = z.object({
  id,
  name: z.string().min(1),
  kind: z.enum(['checking', 'cash', 'savings']),
  openingBalance: safeInteger,
  protected: z.boolean(),
  color: z.string().min(1),
  archived: z.boolean(),
  createdAt: timestamp,
});

export const categorySchema = z.object({
  id,
  name: z.string().min(1),
  kind: z.enum(['income', 'expense']),
  icon: z.string(),
  color: z.string().min(1),
  archived: z.boolean(),
});

export const transactionSchema = z
  .object({
    id,
    type: z.enum(['income', 'expense', 'transfer', 'adjustment']),
    amount: safeInteger,
    accountId: id,
    toAccountId: id.optional(),
    categoryId: id.optional(),
    date: isoDate,
    description: z.string().min(1),
    notes: z.string().optional(),
    source: z.enum([
      'manual',
      'quick-add',
      'commitment',
      'planned-income',
      'planned-event',
      'goal',
      'debt',
      'adjustment',
    ]),
    occurrenceKey: z.string().optional(),
    plannedIncomeId: id.optional(),
    plannedEventId: id.optional(),
    goalId: id.optional(),
    debtPaymentId: id.optional(),
    createdAt: timestamp,
  })
  .superRefine((transaction, context) => {
    if (transaction.type !== 'adjustment' && transaction.amount <= 0) {
      context.addIssue({ code: 'custom', message: 'Iznos mora biti veći od nule.' });
    }
    if (transaction.type === 'transfer') {
      if (!transaction.toAccountId) {
        context.addIssue({ code: 'custom', message: 'Transfer mora imati odredišni račun.' });
      }
      if (transaction.toAccountId === transaction.accountId) {
        context.addIssue({ code: 'custom', message: 'Računi transfera moraju biti različiti.' });
      }
    }
  });

export const plannedIncomeSchema = z.object({
  id,
  name: z.string().min(1),
  amount: positiveMoney,
  categoryId: id,
  accountId: id,
  frequency: z.enum(['monthly', 'weekly', 'yearly']),
  startDate: isoDate,
  endDate: isoDate.optional(),
  expectedDay: z.number().int().min(1).max(31).optional(),
  active: z.boolean(),
  isPrimarySalary: z.boolean(),
  notes: z.string().optional(),
  createdAt: timestamp,
});

export const commitmentSchema = z.object({
  id,
  name: z.string().min(1),
  amount: positiveMoney,
  categoryId: id,
  accountId: id,
  frequency: z.enum(['monthly', 'weekly', 'yearly']),
  startDate: isoDate,
  endDate: isoDate.optional(),
  dueDay: z.number().int().min(1).max(31),
  active: z.boolean(),
  notes: z.string().optional(),
  createdAt: timestamp,
});

export const variableBudgetSchema = z.object({
  id,
  name: z.string().min(1),
  defaultAmount: money,
  categoryId: id,
  overrides: z.record(monthKey, money),
  active: z.boolean(),
  createdAt: timestamp,
});

export const goalV2Schema = z.object({
  id,
  name: z.string().min(1),
  emoji: z.string().min(1),
  targetAmount: positiveMoney,
  targetDate: isoDate.optional(),
  linkedAccountId: id,
  plannedMonthlyContribution: money,
  contributionOverrides: z.record(monthKey, money),
  contributionStartMonth: monthKey.optional(),
  contributionEndMonth: monthKey.optional(),
  notes: z.string().optional(),
  archived: z.boolean(),
  createdAt: timestamp,
});

export const goalSchema = goalV2Schema
  .extend({
    goalType: z.enum(['sinking', 'reserve']),
    usedAt: isoDate.optional(),
  })
  .superRefine((goal, context) => {
    if (goal.goalType === 'reserve' && goal.usedAt) {
      context.addIssue({
        code: 'custom',
        path: ['usedAt'],
        message: 'Rezervni fond ne može imati status iskorišćenog namenskog cilja.',
      });
    }
  });

export const debtSchema = z.object({
  id,
  creditor: z.string().min(1),
  originalAmount: positiveMoney,
  dueDate: isoDate.optional(),
  priority: z.enum(['low', 'medium', 'high']),
  notes: z.string().optional(),
  status: z.enum(['open', 'paid']),
  plannedMonthlyPayment: positiveMoney.optional(),
  paymentDay: z.number().int().min(1).max(31).optional(),
  paymentOverrides: z.record(monthKey, money),
  createdAt: timestamp,
});

export const debtPaymentSchema = z
  .object({
    id,
    debtId: id,
    amount: positiveMoney,
    date: isoDate,
    source: z.enum(['self', 'external']),
    transactionId: id.optional(),
    notes: z.string().optional(),
    createdAt: timestamp,
  })
  .superRefine((payment, context) => {
    if (payment.source === 'self' && !payment.transactionId) {
      context.addIssue({
        code: 'custom',
        path: ['transactionId'],
        message: 'Lična otplata mora imati povezanu transakciju.',
      });
    }
    if (payment.source === 'external' && payment.transactionId) {
      context.addIssue({
        code: 'custom',
        path: ['transactionId'],
        message: 'Spoljna otplata ne sme menjati lične račune.',
      });
    }
  });

export const plannedEventSchema = z.object({
  id,
  title: z.string().min(1),
  date: isoDate,
  plannedAmount: money,
  categoryId: id,
  accountId: id,
  linkedGoalId: id.optional(),
  notes: z.string().optional(),
  paidTransactionId: id.optional(),
  createdAt: timestamp,
});

export const presetSchema = z.object({
  id,
  name: z.string().min(1),
  emoji: z.string(),
  type: z.enum(['income', 'expense']),
  amount: positiveMoney.optional(),
  categoryId: id.optional(),
  defaultAccountId: id.optional(),
  position: z.number().int().nonnegative(),
  active: z.boolean(),
});

export const salaryScenarioSchema = z.object({
  id,
  name: z.string().min(1),
  monthlyAmount: positiveMoney,
  startMonth: monthKey,
  createdAt: timestamp,
});

export const appSettingsSchema = z.object({
  id: z.literal('settings'),
  onboardingCompleted: z.boolean(),
  baseMonthlyIncome: money,
  currency: z.literal('RSD'),
  locale: z.literal('sr-Latn-RS'),
  appearance: z.enum(['light', 'dark', 'system']),
  defaultAccountId: id.optional(),
  activeSalaryScenarioId: id.optional(),
  lastBackupAt: timestamp.optional(),
  seedReviewRecommended: z.boolean().optional(),
  installHintDismissed: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const syncedAppSettingsSchema = appSettingsSchema
  .omit({
    appearance: true,
    lastBackupAt: true,
    installHintDismissed: true,
  })
  .strict();

export const financeDataSchema = z.object({
  accounts: z.array(accountSchema),
  transactions: z.array(transactionSchema),
  categories: z.array(categorySchema),
  plannedIncomes: z.array(plannedIncomeSchema),
  commitments: z.array(commitmentSchema),
  variableBudgets: z.array(variableBudgetSchema),
  goals: z.array(goalSchema),
  debts: z.array(debtSchema),
  debtPayments: z.array(debtPaymentSchema),
  plannedEvents: z.array(plannedEventSchema),
  presets: z.array(presetSchema),
  salaryScenarios: z.array(salaryScenarioSchema),
  settings: z.array(appSettingsSchema).length(1),
});

const legacyTransactionSchema = transactionSchema;
const legacyGoalSchema = goalV2Schema.omit({
  contributionOverrides: true,
  contributionStartMonth: true,
  contributionEndMonth: true,
});
const legacyDebtSchema = debtSchema.omit({ paymentOverrides: true });
const legacyDebtPaymentSchema = z.object({
  id,
  debtId: id,
  amount: positiveMoney,
  date: isoDate,
  transactionId: id,
  notes: z.string().optional(),
  createdAt: timestamp,
});

export const financeDataV1Schema = financeDataSchema
  .omit({ plannedIncomes: true, transactions: true, goals: true, debts: true, debtPayments: true })
  .extend({
    transactions: z.array(legacyTransactionSchema),
    goals: z.array(legacyGoalSchema),
    debts: z.array(legacyDebtSchema),
    debtPayments: z.array(legacyDebtPaymentSchema),
  });

export const financeDataV2Schema = financeDataSchema.omit({ goals: true }).extend({
  goals: z.array(goalV2Schema),
});

const backupApplicationSchema = z.object({
  name: z.literal('Mirna'),
  version: z.string(),
  currency: z.literal('RSD'),
});

export const backupEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: timestamp,
  application: backupApplicationSchema,
  data: financeDataV1Schema,
});

export const backupEnvelopeV2Schema = z.object({
  schemaVersion: z.literal(2),
  exportedAt: timestamp,
  application: backupApplicationSchema,
  data: financeDataV2Schema,
});

export const backupEnvelopeSchema = z.object({
  schemaVersion: z.literal(3),
  exportedAt: timestamp,
  application: backupApplicationSchema,
  data: financeDataSchema,
});

export const anyBackupEnvelopeSchema = z.discriminatedUnion('schemaVersion', [
  backupEnvelopeV1Schema,
  backupEnvelopeV2Schema,
  backupEnvelopeSchema,
]);

export type BackupEnvelope = z.infer<typeof backupEnvelopeSchema>;
export type BackupEnvelopeV1 = z.infer<typeof backupEnvelopeV1Schema>;
export type BackupEnvelopeV2 = z.infer<typeof backupEnvelopeV2Schema>;
export type FinanceDataV2 = z.infer<typeof financeDataV2Schema>;
