import { useState } from 'react';
import { BarChart3, CalendarRange, Home, MoreHorizontal, Plus, Target } from 'lucide-react';
import { matchPath, NavLink, Outlet, useLocation } from 'react-router';
import type { FinanceSnapshot } from '@/domain/types';
import { cn } from '@/lib/cn';
import { QuickAddSheet } from '@/features/transactions/QuickAddSheet';

const nav = [
  { to: '/', label: 'Početna', icon: Home, end: true },
  { to: '/month', label: 'Mesec', icon: CalendarRange },
  { to: '/goals', label: 'Ciljevi', icon: Target },
  { to: '/forecast', label: 'Prognoza', icon: BarChart3 },
  { to: '/more', label: 'Više', icon: MoreHorizontal },
];

const quickAddRoutes = ['/', '/month'] as const;

export const AppShell = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const location = useLocation();
  const [quickAddLocationKey, setQuickAddLocationKey] = useState<string | null>(null);
  const showQuickAdd = quickAddRoutes.some((path) =>
    matchPath({ path, end: true }, location.pathname),
  );
  const quickAddOpen = showQuickAdd && quickAddLocationKey === location.key;

  return (
    <>
      <nav
        aria-label="Glavna navigacija"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/94 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:inset-y-0 md:left-0 md:right-auto md:w-24 md:border-r md:border-t-0 md:pt-6"
      >
        <div className="mx-auto flex h-[4.65rem] max-w-lg items-center justify-around px-2 md:h-full md:flex-col md:justify-start md:gap-3 md:px-3">
          <div className="mb-5 hidden size-12 place-items-center rounded-2xl bg-foreground text-lg font-black text-background md:grid">
            M
          </div>
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex min-h-14 min-w-14 flex-col items-center justify-center gap-1 rounded-2xl px-2 text-[0.68rem] font-semibold text-muted transition md:w-full',
                  isActive && 'bg-accent-soft text-accent',
                )
              }
            >
              <Icon size={21} strokeWidth={2.2} />
              {label}
            </NavLink>
          ))}
        </div>
      </nav>
      {showQuickAdd ? (
        <button
          className="fixed right-4 z-40 grid size-14 place-items-center rounded-2xl bg-accent text-white shadow-[0_10px_32px_rgb(47_125_100/0.38)] transition active:scale-95 md:right-7"
          style={{ bottom: 'calc(5.6rem + env(safe-area-inset-bottom))' }}
          onClick={() => setQuickAddLocationKey(location.key)}
          aria-label="Dodaj transakciju"
        >
          <Plus size={27} strokeWidth={2.5} />
        </button>
      ) : null}
      <div className={showQuickAdd ? 'has-quick-add-fab' : undefined}>
        <Outlet />
      </div>
      <QuickAddSheet
        open={quickAddOpen}
        onOpenChange={(open) => setQuickAddLocationKey(open ? location.key : null)}
        snapshot={snapshot}
      />
    </>
  );
};
