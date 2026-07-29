import { addMonths, format, startOfMonth } from 'date-fns';
import { z } from 'zod';
import type { PlanBlueprint, PlanBlueprintPreview } from '@/features/ai-plan/blueprint';
import {
  importPlanBlueprint,
  PLAN_BLUEPRINT_VERSION,
  planBlueprintSchema,
} from '@/features/ai-plan/blueprint';

export const genericCategories = [
  { key: 'salary', name: 'Plata', kind: 'income', icon: '💼' },
  { key: 'other_income', name: 'Drugi prihod', kind: 'income', icon: '↗️' },
  { key: 'food', name: 'Hrana', kind: 'expense', icon: '🥗' },
  { key: 'housing', name: 'Stanovanje', kind: 'expense', icon: '🏠' },
  { key: 'transport', name: 'Prevoz', kind: 'expense', icon: '🚌' },
  { key: 'fuel', name: 'Gorivo', kind: 'expense', icon: '⛽' },
  { key: 'subscriptions', name: 'Pretplate', kind: 'expense', icon: '🔁' },
  { key: 'health', name: 'Zdravlje', kind: 'expense', icon: '🩺' },
  { key: 'personal', name: 'Lično', kind: 'expense', icon: '👤' },
  { key: 'gifts', name: 'Pokloni', kind: 'expense', icon: '🎁' },
  { key: 'travel', name: 'Putovanje', kind: 'expense', icon: '🧳' },
  { key: 'education', name: 'Obrazovanje', kind: 'expense', icon: '🎓' },
  { key: 'other_expense', name: 'Drugi trošak', kind: 'expense', icon: '•' },
] as const;

const setupSchema = z.strictObject({
  accountName: z.string().trim().min(1).max(120),
  currentBalance: z.number().int().nonnegative().max(1_000_000_000_000),
  cashBalance: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
  monthlyIncome: z.number().int().positive().max(1_000_000_000_000).optional(),
  incomeDay: z.number().int().min(1).max(31).optional(),
  incomeTiming: z.enum(['currentMonth', 'nextMonth']).optional(),
  budgets: z
    .array(
      z.strictObject({
        categoryKey: z.enum([
          'food',
          'housing',
          'transport',
          'fuel',
          'subscriptions',
          'health',
          'personal',
          'gifts',
          'travel',
          'education',
          'other_expense',
        ]),
        amount: z.number().int().positive().max(1_000_000_000_000),
      }),
    )
    .max(12),
  goal: z
    .strictObject({
      name: z.string().trim().min(1).max(120),
      targetAmount: z.number().int().positive().max(1_000_000_000_000),
      targetDate: z.string().optional(),
      goalType: z.enum(['sinking', 'reserve']).optional(),
    })
    .optional(),
});

export type GenericSetupInput = z.infer<typeof setupSchema>;

export function createGenericSetupBlueprint(
  rawInput: GenericSetupInput,
  asOf = new Date(),
): PlanBlueprint {
  const input = setupSchema.parse(rawInput);
  const incomeStartMonth =
    input.incomeTiming === 'nextMonth' ? addMonths(startOfMonth(asOf), 1) : startOfMonth(asOf);
  const startDate = format(incomeStartMonth, 'yyyy-MM-dd');
  const goalAccount = input.goal
    ? [
        {
          key: 'first_goal_savings',
          name: `Štednja — ${input.goal.name}`,
          kind: 'savings' as const,
          startingBalance: 0,
          protected: true,
        },
      ]
    : [];
  const blueprint = {
    planBlueprintVersion: PLAN_BLUEPRINT_VERSION,
    currency: 'RSD' as const,
    accounts: [
      {
        key: 'checking',
        name: input.accountName,
        kind: 'checking' as const,
        startingBalance: input.currentBalance,
        protected: false,
      },
      ...(input.cashBalance === undefined
        ? []
        : [
            {
              key: 'cash',
              name: 'Keš',
              kind: 'cash' as const,
              startingBalance: input.cashBalance,
              protected: false,
            },
          ]),
      ...goalAccount,
    ],
    categories: genericCategories.map((value) => ({ ...value })),
    plannedIncomes: input.monthlyIncome
      ? [
          {
            key: 'primary_salary',
            name: 'Plata',
            amount: input.monthlyIncome,
            categoryKey: 'salary',
            accountKey: 'checking',
            frequency: 'monthly' as const,
            startDate,
            expectedDay: input.incomeDay,
            active: true,
            isPrimarySalary: true,
          },
        ]
      : [],
    fixedCommitments: [],
    variableBudgets: input.budgets.map((value) => ({
      key: `budget_${value.categoryKey}`,
      name:
        genericCategories.find((category) => category.key === value.categoryKey)?.name ??
        value.categoryKey,
      defaultAmount: value.amount,
      categoryKey: value.categoryKey,
      overrides: {},
      active: true,
    })),
    goals: input.goal
      ? [
          {
            key: 'first_goal',
            name: input.goal.name,
            emoji: '🎯',
            targetAmount: input.goal.targetAmount,
            targetDate: input.goal.targetDate || undefined,
            linkedAccountKey: 'first_goal_savings',
            plannedMonthlyContribution: 0,
            contributionOverrides: {},
            goalType: input.goal.goalType ?? ('sinking' as const),
          },
        ]
      : [],
    debts: [],
    plannedEvents: [],
    salaryScenarios: [],
    quickAddPresets: [
      {
        key: 'other',
        name: 'Drugo',
        emoji: '•••',
        type: 'expense' as const,
        defaultAccountKey: 'checking',
        position: 0,
        active: true,
      },
    ],
  };
  return planBlueprintSchema.parse(blueprint);
}

export async function initializeGenericSetup(input: GenericSetupInput): Promise<void> {
  const blueprint = createGenericSetupBlueprint(input);
  const preview: PlanBlueprintPreview = {
    blueprint,
    warnings: [],
    unresolvedAccountKeys: [],
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
  await importPlanBlueprint(preview, false);
}
