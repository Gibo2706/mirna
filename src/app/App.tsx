import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { AppShell } from '@/components/AppShell';
import { useFinanceSnapshot } from '@/db/queries';
import { readSyncClientConfig, type SyncClientConfig } from '@/features/sync/config';
import { SyncRuntimeProvider } from '@/features/sync/runtime/SyncRuntimeProvider';
import type { SyncUiServices } from '@/features/sync/ui-services';
import { ThemeSync } from './ThemeSync';

// Start fetching the first route while IndexedDB opens to avoid a network/DB waterfall on cold start.
const loadDashboardPage = () => import('@/pages/DashboardPage');
const dashboardPageModule =
  typeof window !== 'undefined' && window.location.pathname === '/'
    ? loadDashboardPage()
    : undefined;
const DashboardPage = lazy(() =>
  (dashboardPageModule ?? loadDashboardPage()).then((module) => ({
    default: module.DashboardPage,
  })),
);
const OnboardingPage = lazy(() =>
  import('@/features/onboarding/OnboardingPage').then((module) => ({
    default: module.OnboardingPage,
  })),
);
const MonthPage = lazy(() =>
  import('@/pages/MonthPage').then((module) => ({ default: module.MonthPage })),
);
const GoalsPage = lazy(() =>
  import('@/pages/GoalsPage').then((module) => ({ default: module.GoalsPage })),
);
const ForecastPage = lazy(() =>
  import('@/pages/ForecastPage').then((module) => ({ default: module.ForecastPage })),
);
const MorePage = lazy(() =>
  import('@/pages/MorePage').then((module) => ({ default: module.MorePage })),
);
const SettingsPage = lazy(() =>
  import('@/pages/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);
const SyncManager = lazy(() =>
  import('@/features/sync/SyncManager').then((module) => ({ default: module.SyncManager })),
);

const StartupScreen = () => (
  <div className="grid min-h-dvh place-items-center text-center" role="status">
    <div>
      <div className="mx-auto grid size-13 place-items-center rounded-2xl bg-foreground text-xl font-black text-background">
        M
      </div>
      <p className="mt-3 text-sm font-bold">Mirna</p>
      <p className="mt-1 text-xs text-muted">Učitavam lokalne podatke…</p>
    </div>
  </div>
);

const PageLoader = () => (
  <div className="screen grid min-h-[60dvh] place-items-center">
    <div
      className="size-8 animate-spin rounded-full border-4 border-surface-2 border-t-accent"
      aria-label="Učitavanje stranice"
    />
  </div>
);

const AppContent = ({ syncConfig }: { readonly syncConfig: SyncClientConfig }) => {
  const snapshot = useFinanceSnapshot();
  const location = useLocation();

  if (snapshot === undefined) return <StartupScreen />;

  if (snapshot === null || !snapshot.settingsRecord.onboardingCompleted) {
    if (syncConfig.enabled && location.pathname === '/more/sync') {
      return (
        <Suspense fallback={<StartupScreen />}>
          <Routes>
            <Route path="/more/sync" element={<SyncManager preOnboarding />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      );
    }
    return (
      <Suspense fallback={<StartupScreen />}>
        <OnboardingPage snapshot={snapshot} />
      </Suspense>
    );
  }

  return (
    <>
      <ThemeSync appearance={snapshot.settingsRecord.appearance} />
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route element={<AppShell snapshot={snapshot} />}>
            <Route index element={<DashboardPage snapshot={snapshot} />} />
            <Route path="month" element={<MonthPage snapshot={snapshot} />} />
            <Route path="goals" element={<GoalsPage snapshot={snapshot} />} />
            <Route path="forecast" element={<ForecastPage snapshot={snapshot} />} />
            <Route
              path="more"
              element={<MorePage snapshot={snapshot} syncEnabled={syncConfig.enabled} />}
            />
            <Route
              path="more/:section"
              element={<SettingsPage snapshot={snapshot} syncEnabled={syncConfig.enabled} />}
            />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
};

export const App = ({ syncServices }: { readonly syncServices?: SyncUiServices } = {}) => {
  const syncConfig = readSyncClientConfig();
  const content = <AppContent syncConfig={syncConfig} />;
  return syncConfig.enabled ? (
    <SyncRuntimeProvider services={syncServices}>{content}</SyncRuntimeProvider>
  ) : (
    content
  );
};
