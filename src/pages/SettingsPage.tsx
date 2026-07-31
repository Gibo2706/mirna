import { useParams } from 'react-router';
import type { FinanceSnapshot } from '@/domain/types';
import { AccountsManager } from '@/features/accounts/AccountsManager';
import { BudgetsManager } from '@/features/budgets/BudgetsManager';
import { CategoriesManager } from '@/features/categories/CategoriesManager';
import { CommitmentsManager } from '@/features/commitments/CommitmentsManager';
import { DebtsManager } from '@/features/debts/DebtsManager';
import { EventsManager } from '@/features/events/EventsManager';
import { DataManager } from '@/features/export/DataManager';
import { ScenariosManager } from '@/features/forecast/ScenariosManager';
import { PlannedIncomeManager } from '@/features/income/PlannedIncomeManager';
import { AboutManager } from '@/features/settings/AboutManager';
import { AppearanceManager } from '@/features/settings/AppearanceManager';
import { PresetsManager } from '@/features/transactions/PresetsManager';
import { TransactionsManager } from '@/features/transactions/TransactionsManager';
import { SettingsLayout } from '@/components/SettingsLayout';
import { AIPlanManager } from '@/features/ai-plan/AIPlanManager';
import { HelpManager } from '@/features/settings/HelpManager';
import { SyncManager } from '@/features/sync/SyncManager';

export const SettingsPage = ({
  snapshot,
  syncEnabled = false,
}: {
  snapshot: FinanceSnapshot;
  syncEnabled?: boolean;
}) => {
  const { section } = useParams();
  if (section === 'accounts') return <AccountsManager snapshot={snapshot} />;
  if (section === 'transactions') return <TransactionsManager snapshot={snapshot} />;
  if (section === 'commitments') return <CommitmentsManager snapshot={snapshot} />;
  if (section === 'budgets') return <BudgetsManager snapshot={snapshot} />;
  if (section === 'categories') return <CategoriesManager snapshot={snapshot} />;
  if (section === 'presets') return <PresetsManager snapshot={snapshot} />;
  if (section === 'debts') return <DebtsManager snapshot={snapshot} />;
  if (section === 'events') return <EventsManager snapshot={snapshot} />;
  if (section === 'scenarios') return <ScenariosManager snapshot={snapshot} />;
  if (section === 'income') return <PlannedIncomeManager snapshot={snapshot} />;
  if (section === 'data') return <DataManager snapshot={snapshot} />;
  if (section === 'ai-plan') return <AIPlanManager snapshot={snapshot} />;
  if (section === 'help') return <HelpManager />;
  if (section === 'appearance') return <AppearanceManager snapshot={snapshot} />;
  if (section === 'about') return <AboutManager />;
  if (section === 'sync' && syncEnabled) return <SyncManager />;
  return (
    <SettingsLayout title="Sekcija nije pronađena">
      <p className="text-muted">Vratite se na pregled podešavanja.</p>
    </SettingsLayout>
  );
};
