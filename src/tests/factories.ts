import type {
  Account,
  AppSettings,
  Category,
  FinanceData,
  FixedCommitment,
  LedgerTransaction,
} from '@/domain/types';

export const checking: Account = {
  id: 'checking',
  name: 'Tekući',
  kind: 'checking',
  openingBalance: 100_000,
  protected: false,
  color: '#000000',
  archived: false,
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const savings: Account = {
  id: 'savings',
  name: 'Štednja',
  kind: 'savings',
  openingBalance: 1_000,
  protected: true,
  color: '#000000',
  archived: false,
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const expenseCategory: Category = {
  id: 'expense',
  name: 'Trošak',
  kind: 'expense',
  icon: '•',
  color: '#000000',
  archived: false,
};

export const incomeCategory: Category = {
  id: 'income',
  name: 'Prihod',
  kind: 'income',
  icon: '•',
  color: '#000000',
  archived: false,
};

export const monthlyCommitment: FixedCommitment = {
  id: 'commitment',
  name: 'Rata',
  amount: 3_730,
  categoryId: expenseCategory.id,
  accountId: checking.id,
  frequency: 'monthly',
  startDate: '2026-07-01',
  endDate: '2026-09-30',
  dueDay: 31,
  active: true,
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const tx = (
  overrides: Partial<LedgerTransaction> & Pick<LedgerTransaction, 'id' | 'type' | 'amount'>,
): LedgerTransaction => ({
  accountId: checking.id,
  date: '2026-07-15',
  description: 'Test',
  source: 'manual',
  createdAt: '2026-07-15T12:00:00.000Z',
  ...overrides,
});

export const settings: AppSettings = {
  id: 'settings',
  onboardingCompleted: true,
  baseMonthlyIncome: 100_000,
  currency: 'RSD',
  locale: 'sr-Latn-RS',
  appearance: 'system',
  defaultAccountId: checking.id,
  installHintDismissed: false,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

export const emptyFinanceData = (): FinanceData => ({
  accounts: [checking, savings],
  transactions: [],
  categories: [expenseCategory, incomeCategory],
  plannedIncomes: [],
  commitments: [],
  variableBudgets: [],
  goals: [],
  debts: [],
  debtPayments: [],
  plannedEvents: [],
  presets: [],
  salaryScenarios: [],
  settings: [settings],
});
