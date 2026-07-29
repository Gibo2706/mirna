export type Id = string;
export type ISODate = string;
export type MonthKey = string;

export type AccountKind = 'checking' | 'cash' | 'savings';

export interface Account {
  id: Id;
  name: string;
  kind: AccountKind;
  openingBalance: number;
  protected: boolean;
  color: string;
  archived: boolean;
  createdAt: string;
}

export type CategoryKind = 'income' | 'expense';

export interface Category {
  id: Id;
  name: string;
  kind: CategoryKind;
  icon: string;
  color: string;
  archived: boolean;
}

export type TransactionType = 'income' | 'expense' | 'transfer' | 'adjustment';
export type TransactionSource =
  | 'manual'
  | 'quick-add'
  | 'commitment'
  | 'planned-income'
  | 'planned-event'
  | 'goal'
  | 'debt'
  | 'adjustment';

export interface LedgerTransaction {
  id: Id;
  type: TransactionType;
  amount: number;
  accountId: Id;
  toAccountId?: Id;
  categoryId?: Id;
  date: ISODate;
  description: string;
  notes?: string;
  source: TransactionSource;
  occurrenceKey?: string;
  plannedIncomeId?: Id;
  plannedEventId?: Id;
  goalId?: Id;
  debtPaymentId?: Id;
  createdAt: string;
}

export type CommitmentFrequency = 'monthly' | 'weekly' | 'yearly';

export interface PlannedIncome {
  id: Id;
  name: string;
  amount: number;
  categoryId: Id;
  accountId: Id;
  frequency: CommitmentFrequency;
  startDate: ISODate;
  endDate?: ISODate;
  expectedDay?: number;
  active: boolean;
  isPrimarySalary: boolean;
  notes?: string;
  createdAt: string;
}

export interface PlannedIncomeOccurrence {
  key: string;
  month: MonthKey;
  plannedIncomeId: Id;
  name: string;
  amount: number;
  expectedDate: ISODate;
  categoryId: Id;
  accountId: Id;
  receivedTransactionId?: Id;
}

export interface FixedCommitment {
  id: Id;
  name: string;
  amount: number;
  categoryId: Id;
  accountId: Id;
  frequency: CommitmentFrequency;
  startDate: ISODate;
  endDate?: ISODate;
  dueDay: number;
  active: boolean;
  notes?: string;
  createdAt: string;
}

export interface CommitmentOccurrence {
  key: string;
  commitmentId: Id;
  name: string;
  amount: number;
  date: ISODate;
  categoryId: Id;
  accountId: Id;
  paidTransactionId?: Id;
}

export interface VariableBudget {
  id: Id;
  name: string;
  defaultAmount: number;
  categoryId: Id;
  overrides: Record<MonthKey, number>;
  active: boolean;
  createdAt: string;
}

export type SavingsGoalType = 'sinking' | 'reserve';
export type SavingsGoalLifecycle = 'active' | 'funded' | 'used';

export interface SavingsGoal {
  id: Id;
  name: string;
  emoji: string;
  targetAmount: number;
  targetDate?: ISODate;
  linkedAccountId: Id;
  plannedMonthlyContribution: number;
  contributionOverrides: Record<MonthKey, number>;
  contributionStartMonth?: MonthKey;
  contributionEndMonth?: MonthKey;
  goalType: SavingsGoalType;
  usedAt?: ISODate;
  notes?: string;
  archived: boolean;
  createdAt: string;
}

export type DebtPriority = 'low' | 'medium' | 'high';
export type DebtStatus = 'open' | 'paid';

export interface Debt {
  id: Id;
  creditor: string;
  originalAmount: number;
  dueDate?: ISODate;
  priority: DebtPriority;
  notes?: string;
  status: DebtStatus;
  plannedMonthlyPayment?: number;
  paymentDay?: number;
  paymentOverrides: Record<MonthKey, number>;
  createdAt: string;
}

export type DebtPaymentSource = 'self' | 'external';

export interface DebtPayment {
  id: Id;
  debtId: Id;
  amount: number;
  date: ISODate;
  source: DebtPaymentSource;
  transactionId?: Id;
  notes?: string;
  createdAt: string;
}

export interface PlannedEvent {
  id: Id;
  title: string;
  date: ISODate;
  plannedAmount: number;
  categoryId: Id;
  accountId: Id;
  linkedGoalId?: Id;
  notes?: string;
  paidTransactionId?: Id;
  createdAt: string;
}

export interface QuickAddPreset {
  id: Id;
  name: string;
  emoji: string;
  type: Extract<TransactionType, 'income' | 'expense'>;
  amount?: number;
  categoryId?: Id;
  defaultAccountId?: Id;
  position: number;
  active: boolean;
}

export interface SalaryScenario {
  id: Id;
  name: string;
  monthlyAmount: number;
  startMonth: MonthKey;
  createdAt: string;
}

export type Appearance = 'light' | 'dark' | 'system';

export interface AppSettings {
  id: 'settings';
  onboardingCompleted: boolean;
  baseMonthlyIncome: number;
  currency: 'RSD';
  locale: 'sr-Latn-RS';
  appearance: Appearance;
  defaultAccountId?: Id;
  activeSalaryScenarioId?: Id;
  lastBackupAt?: string;
  seedReviewRecommended?: boolean;
  installHintDismissed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FinanceData {
  accounts: Account[];
  transactions: LedgerTransaction[];
  categories: Category[];
  plannedIncomes: PlannedIncome[];
  commitments: FixedCommitment[];
  variableBudgets: VariableBudget[];
  goals: SavingsGoal[];
  debts: Debt[];
  debtPayments: DebtPayment[];
  plannedEvents: PlannedEvent[];
  presets: QuickAddPreset[];
  salaryScenarios: SalaryScenario[];
  settings: AppSettings[];
}

export interface FinanceSnapshot extends FinanceData {
  settingsRecord: AppSettings;
}
