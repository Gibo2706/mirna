/**
 * Synthetic test data. Not based on any real person's financial records.
 */
import { addMonths, endOfMonth, format, parseISO, startOfMonth } from 'date-fns';
import type {
  Account,
  AppSettings,
  Category,
  Debt,
  FixedCommitment,
  PlannedEvent,
  PlannedIncome,
  QuickAddPreset,
  SalaryScenario,
  SavingsGoal,
  VariableBudget,
  FinanceData,
} from '@/domain/types';
import { db, financeTables } from '@/db/database';

export interface SyntheticFinanceFixtureInput {
  asOf?: Date;
  checkingOpeningBalance: number;
  cashOpeningBalance: number;
  salaryAmount: number;
  salaryExpectedDay?: number;
  productivityToolAmount: number;
  equipmentStartDate: string;
  equipmentEndDate: string;
  maintenanceStartDate: string;
  maintenanceEndDate: string;
  leaseStartDate: string;
  relocationDate: string;
  relocationAugustContribution: number;
  relocationSeptemberContribution: number;
  conferenceFeeAmount: number;
  certificationFeeAmount: number;
  workshopAmount: number;
  relocationTargetDate: string;
}

export const defaultSyntheticFinanceFixtureInput = (
  asOf = new Date(),
): SyntheticFinanceFixtureInput => {
  const equipmentStart = new Date(2032, 6, 1);
  return {
    asOf,
    checkingOpeningBalance: 137_000,
    cashOpeningBalance: 8_500,
    salaryAmount: 187_000,
    salaryExpectedDay: 12,
    productivityToolAmount: 3_900,
    equipmentStartDate: format(equipmentStart, 'yyyy-MM-dd'),
    equipmentEndDate: format(endOfMonth(addMonths(equipmentStart, 17)), 'yyyy-MM-dd'),
    maintenanceStartDate: '2032-07-01',
    maintenanceEndDate: '2033-02-28',
    relocationDate: '2032-10-19',
    leaseStartDate: '2032-11-01',
    relocationAugustContribution: 113_000,
    relocationSeptemberContribution: 87_000,
    conferenceFeeAmount: 17_500,
    certificationFeeAmount: 29_000,
    workshopAmount: 68_000,
    relocationTargetDate: '2032-09-30',
  };
};

const createdAt = (asOf: Date): string => asOf.toISOString();

const buildSyntheticFinanceFixture = (input: SyntheticFinanceFixtureInput) => {
  const asOf = input.asOf ?? new Date();
  const planYear = 2032;
  const now = createdAt(asOf);
  const startDate = format(startOfMonth(asOf), 'yyyy-MM-dd');

  const accounts: Account[] = [
    {
      id: 'acct_checking',
      name: 'Tekući račun',
      kind: 'checking',
      openingBalance: input.checkingOpeningBalance,
      protected: false,
      color: '#2f7d64',
      archived: false,
      createdAt: now,
    },
    {
      id: 'acct_reserve',
      name: 'Štednja — sigurnosna rezerva',
      kind: 'savings',
      openingBalance: 19_000,
      protected: true,
      color: '#3b82f6',
      archived: false,
      createdAt: now,
    },
    {
      id: 'acct_relocation',
      name: 'Štednja — preseljenje',
      kind: 'savings',
      openingBalance: 0,
      protected: true,
      color: '#8b5cf6',
      archived: false,
      createdAt: now,
    },
    {
      id: 'acct_training',
      name: 'Štednja — stručna radionica',
      kind: 'savings',
      openingBalance: 0,
      protected: true,
      color: '#d97706',
      archived: false,
      createdAt: now,
    },
    {
      id: 'acct_cash',
      name: 'Keš',
      kind: 'cash',
      openingBalance: input.cashOpeningBalance,
      protected: false,
      color: '#64748b',
      archived: false,
      createdAt: now,
    },
  ];

  const categories: Category[] = [
    {
      id: 'cat_salary',
      name: 'Plata',
      kind: 'income',
      icon: '💼',
      color: '#2f7d64',
      archived: false,
    },
    {
      id: 'cat_marketplace_income',
      name: 'Prihod od prodaje opreme',
      kind: 'income',
      icon: '🚗',
      color: '#2563eb',
      archived: false,
    },
    {
      id: 'cat_other_income',
      name: 'Drugi prihod',
      kind: 'income',
      icon: '↗️',
      color: '#0891b2',
      archived: false,
    },
    {
      id: 'cat_phone',
      name: 'Telefon i uređaji',
      kind: 'expense',
      icon: '📱',
      color: '#8b5cf6',
      archived: false,
    },
    {
      id: 'cat_subscriptions',
      name: 'Pretplate',
      kind: 'expense',
      icon: '🔁',
      color: '#6366f1',
      archived: false,
    },
    {
      id: 'cat_personal',
      name: 'Lično',
      kind: 'expense',
      icon: '✂️',
      color: '#ec4899',
      archived: false,
    },
    {
      id: 'cat_fuel',
      name: 'Gorivo',
      kind: 'expense',
      icon: '⛽',
      color: '#d97706',
      archived: false,
    },
    {
      id: 'cat_food',
      name: 'Hrana',
      kind: 'expense',
      icon: '🍔',
      color: '#ea580c',
      archived: false,
    },
    {
      id: 'cat_pharmacy',
      name: 'Apoteka',
      kind: 'expense',
      icon: '🧴',
      color: '#64748b',
      archived: false,
    },
    {
      id: 'cat_coffee',
      name: 'Kafe',
      kind: 'expense',
      icon: '☕',
      color: '#92400e',
      archived: false,
    },
    {
      id: 'cat_household',
      name: 'Kuća / razno',
      kind: 'expense',
      icon: '🏡',
      color: '#0f766e',
      archived: false,
    },
    {
      id: 'cat_car',
      name: 'Automobil',
      kind: 'expense',
      icon: '🚘',
      color: '#475569',
      archived: false,
    },
    {
      id: 'cat_housing',
      name: 'Stanovanje',
      kind: 'expense',
      icon: '🏠',
      color: '#7c3aed',
      archived: false,
    },
    {
      id: 'cat_gifts',
      name: 'Pokloni',
      kind: 'expense',
      icon: '🎁',
      color: '#db2777',
      archived: false,
    },
    {
      id: 'cat_education',
      name: 'Obrazovanje',
      kind: 'expense',
      icon: '🎓',
      color: '#2563eb',
      archived: false,
    },
    {
      id: 'cat_travel',
      name: 'Putovanje',
      kind: 'expense',
      icon: '🧳',
      color: '#0891b2',
      archived: false,
    },
    {
      id: 'cat_debt',
      name: 'Otplata duga',
      kind: 'expense',
      icon: '🤝',
      color: '#be123c',
      archived: false,
    },
    {
      id: 'cat_other_expense',
      name: 'Drugi trošak',
      kind: 'expense',
      icon: '•',
      color: '#64748b',
      archived: false,
    },
  ];

  const commitment = (
    id: string,
    name: string,
    amount: number,
    categoryId: string,
    dueDay: number,
    options?: { startDate?: string; endDate?: string; notes?: string },
  ): FixedCommitment => ({
    id,
    name,
    amount,
    categoryId,
    accountId: 'acct_checking',
    frequency: 'monthly',
    startDate: options?.startDate ?? startDate,
    endDate: options?.endDate,
    dueDay,
    active: true,
    notes: options?.notes,
    createdAt: now,
  });

  const commitments: FixedCommitment[] = [
    commitment('commit_mobile', 'Mobilni paket', 6_240, 'cat_phone', 6, {
      startDate: input.equipmentStartDate,
      endDate: input.equipmentEndDate,
      notes: 'Sintetički ugovor na 18 meseci.',
    }),
    commitment('commit_laptop', 'Rata za laptop', 8_750, 'cat_phone', 9, {
      startDate: input.equipmentStartDate,
      endDate: input.equipmentEndDate,
      notes: 'Sintetički ugovor na 18 meseci.',
    }),
    commitment('commit_monitor', 'Rata za monitor', 3_400, 'cat_phone', 9, {
      startDate: input.equipmentStartDate,
      endDate: input.equipmentEndDate,
      notes: 'Sintetički ugovor na 18 meseci.',
    }),
    commitment('commit_accessories', 'Rata za dodatnu opremu', 780, 'cat_phone', 9, {
      startDate: input.equipmentStartDate,
      endDate: input.equipmentEndDate,
      notes: 'Sintetički ugovor na 18 meseci.',
    }),
    commitment('commit_delivery', 'Pretplata za dostavu', 690, 'cat_subscriptions', 8),
    commitment('commit_storage', 'Cloud skladište', 1_190, 'cat_subscriptions', 10, {
      notes: 'Jedna sintetička mesečna pretplata.',
    }),
    commitment(
      'commit_productivity',
      'Alat za produktivnost',
      input.productivityToolAmount,
      'cat_subscriptions',
      20,
      {
        notes: 'Sintetički RSD plan bez automatskog FX preračunavanja.',
      },
    ),
    commitment('commit_personal_care', 'Lična nega', 2_200, 'cat_personal', 15, {
      notes: 'Približno jednom mesečno.',
    }),
    commitment('commit_maintenance', 'Preventivno održavanje vozila', 9_600, 'cat_car', 15, {
      startDate: input.maintenanceStartDate,
      endDate: input.maintenanceEndDate,
    }),
    commitment('commit_lease', 'Kirija i računi', 74_000, 'cat_housing', 1, {
      startDate: input.leaseStartDate,
      notes: 'Sintetički konzervativni planski maksimum.',
    }),
  ];

  const variableBudgets: VariableBudget[] = [
    ['budget_fuel', 'Gorivo', 16_500, 'cat_fuel'],
    ['budget_food', 'Hrana', 38_000, 'cat_food'],
    ['budget_pharmacy', 'Apoteka', 7_200, 'cat_pharmacy'],
    ['budget_coffee', 'Kafe', 6_400, 'cat_coffee'],
    ['budget_household', 'Kuća / razno', 11_500, 'cat_household'],
  ].map(([id, name, amount, categoryId]) => ({
    id: String(id),
    name: String(name),
    defaultAmount: Number(amount),
    categoryId: String(categoryId),
    overrides: {},
    active: true,
    createdAt: now,
  }));

  const goals: SavingsGoal[] = [
    {
      id: 'goal_relocation',
      name: 'Preseljenje',
      emoji: '🏠',
      targetAmount: 246_000,
      targetDate: input.relocationTargetDate,
      linkedAccountId: 'acct_relocation',
      plannedMonthlyContribution: 0,
      contributionOverrides: {
        '2032-08': input.relocationAugustContribution,
        '2032-09': input.relocationSeptemberContribution,
        '2032-10': 0,
      },
      goalType: 'sinking',
      notes: 'Sintetički depozit i prvi troškovi stanovanja.',
      archived: false,
      createdAt: now,
    },
    {
      id: 'goal_training',
      name: 'Stručna radionica',
      emoji: '📚',
      targetAmount: 96_000,
      targetDate: '2032-11-01',
      linkedAccountId: 'acct_training',
      plannedMonthlyContribution: 0,
      contributionOverrides: {},
      goalType: 'sinking',
      notes: 'Sintetički troškovi radionice, prevoza i smeštaja u RSD.',
      archived: false,
      createdAt: now,
    },
    {
      id: 'goal_reserve',
      name: 'Sigurnosna rezerva',
      emoji: '🛟',
      targetAmount: 480_000,
      linkedAccountId: 'acct_reserve',
      plannedMonthlyContribution: 0,
      contributionOverrides: {},
      goalType: 'reserve',
      notes: 'Dugoročni fond za hitne slučajeve.',
      archived: false,
      createdAt: now,
    },
  ];

  const debts: Debt[] = [
    {
      id: 'debt_course',
      creditor: 'Program stručnog kursa',
      originalAmount: 74_000,
      priority: 'medium',
      status: 'open',
      paymentOverrides: {},
      createdAt: now,
    },
    {
      id: 'debt_equipment',
      creditor: 'Prodavac kancelarijske opreme',
      originalAmount: 129_000,
      priority: 'medium',
      status: 'open',
      paymentOverrides: {},
      createdAt: now,
    },
  ];

  const event = (
    id: string,
    title: string,
    date: string,
    plannedAmount: number,
    categoryId: string,
    notes?: string,
    linkedGoalId?: string,
    accountId = 'acct_checking',
  ): PlannedEvent => ({
    id,
    title,
    date,
    plannedAmount,
    categoryId,
    accountId,
    linkedGoalId,
    notes,
    createdAt: now,
  });

  const plannedEvents: PlannedEvent[] = [
    event(
      'event_conference',
      'Kotizacija za konferenciju',
      `${planYear}-08-11`,
      input.conferenceFeeAmount,
      'cat_education',
    ),
    event(
      'event_certification',
      'Polaganje stručnog sertifikata',
      `${planYear}-08-26`,
      input.certificationFeeAmount,
      'cat_education',
    ),
    event(
      'event_workshop',
      'Višednevna stručna radionica',
      `${planYear}-09-17`,
      input.workshopAmount,
      'cat_education',
    ),
    event(
      'event_training_trip',
      'Put do stručne radionice',
      `${planYear}-11-19`,
      96_000,
      'cat_travel',
      'Sintetički RSD plan bez live FX; stvarni iznos nije deo fixture-a.',
      'goal_training',
      'acct_training',
    ),
    event(
      'event_relocation',
      'Preseljenje i depozit',
      input.relocationDate,
      246_000,
      'cat_housing',
      'Jednokratni sintetički iznos; redovna kirija počinje sledećeg meseca.',
      'goal_relocation',
      'acct_relocation',
    ),
    event(
      'event_maintenance_extra',
      'Vanredni servis vozila',
      `${planYear}-12-18`,
      21_000,
      'cat_car',
    ),
  ];

  const presets: QuickAddPreset[] = [
    {
      id: 'preset_pharmacy',
      name: 'Apoteka',
      emoji: '🧴',
      type: 'expense',
      amount: 1_350,
      categoryId: 'cat_pharmacy',
      defaultAccountId: 'acct_checking',
      position: 0,
      active: true,
    },
    {
      id: 'preset_coffee',
      name: 'Kafa',
      emoji: '☕',
      type: 'expense',
      amount: 360,
      categoryId: 'cat_coffee',
      defaultAccountId: 'acct_checking',
      position: 1,
      active: true,
    },
    {
      id: 'preset_fuel',
      name: 'Gorivo',
      emoji: '⛽',
      type: 'expense',
      categoryId: 'cat_fuel',
      defaultAccountId: 'acct_checking',
      position: 2,
      active: true,
    },
    {
      id: 'preset_food',
      name: 'Hrana',
      emoji: '🍔',
      type: 'expense',
      categoryId: 'cat_food',
      defaultAccountId: 'acct_checking',
      position: 3,
      active: true,
    },
    {
      id: 'preset_marketplace_income',
      name: 'Prodaja opreme',
      emoji: '📦',
      type: 'income',
      categoryId: 'cat_marketplace_income',
      defaultAccountId: 'acct_checking',
      position: 4,
      active: true,
    },
    {
      id: 'preset_other',
      name: 'Drugo',
      emoji: '•••',
      type: 'expense',
      defaultAccountId: 'acct_checking',
      position: 5,
      active: true,
    },
  ];

  const salaryScenarios: SalaryScenario[] = [
    {
      id: 'scenario_potential',
      name: 'Scenario promene angažmana',
      monthlyAmount: 241_000,
      startMonth: '2032-09',
      createdAt: now,
    },
  ];

  const plannedIncomes: PlannedIncome[] = [
    {
      id: 'income_primary_salary',
      name: 'Plata',
      amount: input.salaryAmount,
      categoryId: 'cat_salary',
      accountId: 'acct_checking',
      frequency: 'monthly',
      startDate: '2032-07-01',
      expectedDay: input.salaryExpectedDay,
      active: true,
      isPrimarySalary: true,
      createdAt: now,
    },
  ];

  const settings: AppSettings = {
    id: 'settings',
    onboardingCompleted: true,
    baseMonthlyIncome: input.salaryAmount,
    currency: 'RSD',
    locale: 'sr-Latn-RS',
    appearance: 'system',
    defaultAccountId: 'acct_checking',
    installHintDismissed: false,
    createdAt: now,
    updatedAt: now,
  };

  return {
    accounts,
    categories,
    plannedIncomes,
    commitments,
    variableBudgets,
    goals,
    debts,
    plannedEvents,
    presets,
    salaryScenarios,
    settings,
  };
};

const clearInsideTransaction = async (): Promise<void> => {
  await Promise.all(financeTables().map((table) => table.clear()));
};

export const createSyntheticFinanceFixtureData = (
  input: SyntheticFinanceFixtureInput,
): FinanceData => {
  const fixture = buildSyntheticFinanceFixture(input);
  return {
    accounts: fixture.accounts,
    transactions: [],
    categories: fixture.categories,
    plannedIncomes: fixture.plannedIncomes,
    commitments: fixture.commitments,
    variableBudgets: fixture.variableBudgets,
    goals: fixture.goals,
    debts: fixture.debts,
    debtPayments: [],
    plannedEvents: fixture.plannedEvents,
    presets: fixture.presets,
    salaryScenarios: fixture.salaryScenarios,
    settings: [fixture.settings],
  };
};

/**
 * Regression-only synthetic dataset for exercising cross-feature financial invariants.
 *
 * Never call this from production onboarding. Values are intentionally artificial
 * and cover recurring plans, protected savings, debts, events and quick entry.
 */
export async function loadSyntheticFinanceFixture(
  input: SyntheticFinanceFixtureInput,
): Promise<void> {
  if (input.conferenceFeeAmount + input.certificationFeeAmount > 60_000) {
    throw new Error('Sintetički zbir kotizacija ne može biti veći od 60.000 RSD.');
  }
  if (input.productivityToolAmount <= 0) {
    throw new Error('Unesite sintetički mesečni RSD iznos alata za produktivnost.');
  }
  if (input.salaryAmount <= 0) {
    throw new Error('Unesite planirani iznos primarne plate.');
  }
  if (
    input.salaryExpectedDay !== undefined &&
    (input.salaryExpectedDay < 1 || input.salaryExpectedDay > 31)
  ) {
    throw new Error('Očekivani dan plate mora biti između 1 i 31.');
  }
  if (parseISO(input.equipmentEndDate) < parseISO(input.equipmentStartDate)) {
    throw new Error('Kraj rata opreme mora biti posle početka.');
  }
  if (parseISO(input.leaseStartDate) <= parseISO(input.relocationDate)) {
    throw new Error('Redovna kirija mora početi posle jednokratnog preseljenja.');
  }

  const seed = createSyntheticFinanceFixtureData(input);
  await db.transaction('rw', financeTables(), async () => {
    await clearInsideTransaction();
    await db.accounts.bulkAdd(seed.accounts);
    await db.categories.bulkAdd(seed.categories);
    await db.plannedIncomes.bulkAdd(seed.plannedIncomes);
    await db.commitments.bulkAdd(seed.commitments);
    await db.variableBudgets.bulkAdd(seed.variableBudgets);
    await db.goals.bulkAdd(seed.goals);
    await db.debts.bulkAdd(seed.debts);
    await db.plannedEvents.bulkAdd(seed.plannedEvents);
    await db.presets.bulkAdd(seed.presets);
    await db.salaryScenarios.bulkAdd(seed.salaryScenarios);
    await db.settings.bulkAdd(seed.settings);
  });
}
