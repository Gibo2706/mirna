import { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  AlertTriangle,
  ChevronRight,
  CircleCheck,
  Download,
  Info,
  ReceiptText,
  ShieldCheck,
  Target,
  Wallet,
} from 'lucide-react';
import { Link } from 'react-router';
import type { FinanceSnapshot, PlannedEvent } from '@/domain/types';
import {
  calculateAccountBalances,
  calculateBudgetProgress,
  calculateGoalProgress,
  calculateMonthlyFinancialSummary,
  calculateSafeToSpend,
  calculateSpendableBalance,
} from '@/domain/calculations';
import { getAllCommitmentOccurrences } from '@/domain/recurrence';
import { currentMonthKey, formatDate, formatMonth, todayIso } from '@/lib/dates';
import { formatRsd } from '@/lib/format';
import { useCurrentDate } from '@/lib/useCurrentDate';
import { markCommitmentPaid, updateSettings } from '@/db/commands';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Progress } from '@/components/ui/Progress';
import { Sheet } from '@/components/ui/Sheet';
import { PageHeader } from '@/components/PageHeader';
import { useToast } from '@/components/ToastProvider';
import { EventPaymentSheet } from '@/features/events/EventPaymentSheet';
import { MoneyValue } from '@/components/ui/MoneyValue';
import { StatusBadge } from '@/components/ui/StatusBadge';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const DashboardPage = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const month = currentMonthKey(useCurrentDate());
  const { success } = useToast();
  const [safeInfoOpen, setSafeInfoOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [actionError, setActionError] = useState('');
  const [payingEvent, setPayingEvent] = useState<PlannedEvent | null>(null);
  const balances = useMemo(
    () => calculateAccountBalances(snapshot.accounts, snapshot.transactions),
    [snapshot.accounts, snapshot.transactions],
  );
  const summary = calculateMonthlyFinancialSummary({
    month,
    accounts: snapshot.accounts,
    plannedIncomes: snapshot.plannedIncomes,
    commitments: snapshot.commitments,
    variableBudgets: snapshot.variableBudgets,
    goals: snapshot.goals,
    debts: snapshot.debts,
    debtPayments: snapshot.debtPayments,
    events: snapshot.plannedEvents,
    transactions: snapshot.transactions,
  });
  const occurrences = getAllCommitmentOccurrences(
    snapshot.commitments,
    month,
    snapshot.transactions,
  );
  const remainingFixed = summary.fixed.remainingSpendable;
  const budgetProgress = snapshot.variableBudgets
    .filter((budget) => budget.active)
    .map((budget) => ({
      budget,
      progress: calculateBudgetProgress(budget, snapshot.transactions, month),
    }));
  const remainingVariable = summary.variable.remaining;
  const events = snapshot.plannedEvents
    .filter((event) => event.date.startsWith(month) && !event.paidTransactionId)
    .sort((left, right) => left.date.localeCompare(right.date));
  const upcomingEvents = summary.events.remainingSpendable;
  const remainingSavingsPlan = summary.savings.remaining;
  const spendableBalance = calculateSpendableBalance(snapshot.accounts, balances);
  const safeToSpend = calculateSafeToSpend({
    spendableBalance,
    remainingFixed,
    remainingVariable,
    upcomingEvents,
    remainingSavingsPlan,
    remainingDebtPlan: summary.debt.remaining,
  });
  const variablePlan = budgetProgress.reduce((sum, row) => sum + row.progress.plan, 0);
  const variableActual = budgetProgress.reduce((sum, row) => sum + row.progress.actual, 0);
  const budgetPercentage = variablePlan > 0 ? Math.round((variableActual / variablePlan) * 100) : 0;
  const upcoming = [
    ...occurrences
      .filter((occurrence) => !occurrence.paidTransactionId)
      .map((occurrence) => ({ kind: 'commitment' as const, ...occurrence })),
    ...events.map((event) => ({
      kind: 'event' as const,
      key: event.id,
      name: event.title,
      amount: event.plannedAmount,
      date: event.date,
      eventId: event.id,
    })),
  ]
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(0, 4);
  const recentTransactions = [...snapshot.transactions]
    .sort(
      (left, right) =>
        right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt),
    )
    .slice(0, 5);
  const hasPlan =
    snapshot.plannedIncomes.some((value) => value.active) ||
    snapshot.commitments.some((value) => value.active) ||
    snapshot.variableBudgets.some((value) => value.active) ||
    snapshot.goals.some((value) => !value.archived) ||
    snapshot.debts.some((value) => value.status === 'open') ||
    snapshot.plannedEvents.some((value) => !value.paidTransactionId);
  const hasFinancialActivity = hasPlan || snapshot.transactions.length > 0;

  useEffect(() => {
    const displayMode = window.matchMedia('(display-mode: standalone)');
    const syncStandalone = () =>
      setStandalone(
        displayMode.matches ||
          Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
      );
    syncStandalone();
    const listener = (event: Event) => {
      if (displayMode.matches) return;
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const installed = () => {
      setStandalone(true);
      setInstallPrompt(null);
    };
    displayMode.addEventListener('change', syncStandalone);
    window.addEventListener('beforeinstallprompt', listener);
    window.addEventListener('appinstalled', installed);
    return () => {
      displayMode.removeEventListener('change', syncStandalone);
      window.removeEventListener('beforeinstallprompt', listener);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') success('Mirna se instalira na uređaj.');
    setInstallPrompt(null);
    await updateSettings({
      installHintDismissed: true,
    });
  };

  const markPaid = async (item: (typeof upcoming)[number]) => {
    setActionError('');
    try {
      if (item.kind === 'commitment') {
        await markCommitmentPaid({
          occurrenceKey: item.key,
          name: item.name,
          amount: item.amount,
          date: item.date,
          accountId: item.accountId,
          categoryId: item.categoryId,
        });
      } else {
        const event = snapshot.plannedEvents.find((value) => value.id === item.eventId);
        if (!event) throw new Error('Planirani događaj više ne postoji.');
        setPayingEvent(event);
        return;
      }
      success('Označeno kao plaćeno.');
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Stavka nije evidentirana.');
    }
  };

  return (
    <main className="screen">
      <PageHeader
        eyebrow="Pregled"
        title={formatMonth(month)}
        description="Plan i stvarno stanje, bez mešanja štednje sa troškovima."
      />
      {actionError ? (
        <p role="alert" className="mb-4 rounded-xl bg-danger-soft p-3 text-sm text-danger">
          {actionError}
        </p>
      ) : null}

      {snapshot.settingsRecord.seedReviewRecommended ? (
        <Card className="mb-5 flex items-start gap-3 border-warning bg-warning-soft">
          <AlertTriangle className="mt-0.5 shrink-0 text-warning" size={20} />
          <div className="flex-1">
            <p className="font-bold">Pregledajte podatke iz ranije verzije</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Stariji plan može sadržati stavke koje nova verzija može preciznije modelovati. Vaše
              vrednosti nisu automatski menjane.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                to="/more/events"
                className="inline-flex min-h-11 items-center rounded-lg bg-surface-2 px-3 text-xs font-semibold"
              >
                Pregledaj događaje
              </Link>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void updateSettings({ seedReviewRecommended: false })}
              >
                Pregledano
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {!hasPlan ? (
        <Card className="mb-5 border-dashed bg-surface/70">
          <p className="font-bold">Osnova je spremna. Plan može da raste postepeno.</p>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            Dodajte prihod i nekoliko troškova kada ih znate. Prognoza će tada pokazati gde plan
            postaje tesan.
          </p>
          <Link
            to="/more"
            className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-surface-2 px-4 text-sm font-semibold"
          >
            Postavi plan
          </Link>
        </Card>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="section-stack">
          <Card
            className={`relative overflow-hidden rounded-hero border-0 p-5 text-white sm:p-6 ${safeToSpend < 0 ? 'bg-[#833d3d]' : 'bg-[#17251f]'}`}
          >
            <div className="absolute -right-14 -top-16 size-52 rounded-full bg-accent/30 blur-2xl" />
            <button
              className="relative flex min-h-11 items-center gap-2 text-sm font-semibold text-white/72"
              onClick={() => setSafeInfoOpen(true)}
            >
              <ShieldCheck size={18} />
              Bezbedno za trošenje
              <Info size={15} />
            </button>
            <p className="money relative mt-2 text-4xl font-extrabold tracking-[-0.05em] sm:text-5xl">
              {formatRsd(safeToSpend)}
            </p>
            <p className="relative mt-2 text-sm text-white/65">
              do kraja meseca, posle svih preostalih planova
            </p>
            <div className="relative mt-6 grid grid-cols-2 gap-3 border-t border-white/12 pt-4 sm:grid-cols-4">
              {[
                ['Raspoloživo', spendableBalance],
                ['Obaveze', remainingFixed],
                ['Budžeti', remainingVariable],
                ['Događaji sa tekućih', upcomingEvents],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <p className="text-[0.68rem] font-semibold uppercase tracking-wide text-white/50">
                    {label}
                  </p>
                  <p className="money mt-1 text-sm font-bold">{formatRsd(Number(value))}</p>
                </div>
              ))}
            </div>
          </Card>

          {hasFinancialActivity ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                [
                  'Stvarni prihod',
                  summary.income.actual,
                  'od plana ' + formatRsd(summary.income.planned),
                ],
                ['Potrošeno', summary.actualExpenses, 'ovog meseca'],
                ['Štednja', summary.savings.actual, 'transferi, ne trošak'],
                ['Slobodan plan', summary.plannedFreeCash, 'pre stvarnih unosa'],
              ].map(([label, value, hint]) => (
                <Card key={String(label)} className="min-h-28 p-4">
                  <p className="text-xs font-semibold text-muted">{label}</p>
                  <p className="money mt-2 text-lg font-extrabold">{formatRsd(Number(value))}</p>
                  <p className="mt-1 text-[0.68rem] text-muted">{hint}</p>
                </Card>
              ))}
            </div>
          ) : null}

          {budgetProgress.length ? (
            <Card>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">
                    Promenljivi budžet
                  </p>
                  <h2 className="mt-1 text-lg font-bold">Ovaj mesec</h2>
                </div>
                <Link
                  className="flex min-h-11 items-center gap-1 text-sm font-bold text-accent"
                  to="/month"
                >
                  Prikaži sve <ChevronRight size={17} />
                </Link>
              </div>
              <div className="mt-4 flex items-end justify-between gap-4">
                <p className="money text-xl font-extrabold">{formatRsd(variableActual)}</p>
                <p
                  className={
                    budgetPercentage > 100
                      ? 'text-sm font-bold text-danger'
                      : 'text-sm font-bold text-muted'
                  }
                >
                  {budgetPercentage}%
                </p>
              </div>
              <Progress
                className="mt-2.5 h-2.5"
                value={budgetPercentage}
                tone={
                  budgetPercentage > 100 ? 'danger' : budgetPercentage > 85 ? 'warning' : 'accent'
                }
              />
              <p className="mt-2 text-xs text-muted">Planirano {formatRsd(variablePlan)}</p>
              <div className="mt-5 grid gap-3">
                {budgetProgress.slice(0, 3).map(({ budget, progress }) => (
                  <div key={budget.id} className="flex items-center gap-3">
                    <span className="grid size-9 place-items-center rounded-xl bg-surface-2">
                      {snapshot.categories.find((category) => category.id === budget.categoryId)
                        ?.icon ?? '•'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between gap-2 text-sm">
                        <span className="truncate font-semibold">{budget.name}</span>
                        <span className="money text-muted">
                          {formatRsd(progress.actual)} / {formatRsd(progress.plan)}
                        </span>
                      </div>
                      <Progress
                        className="mt-1.5 h-1.5"
                        value={progress.percentage}
                        tone={progress.percentage > 100 ? 'danger' : 'accent'}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </section>

        <section className="section-stack">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-bold">
                <CalendarClock size={20} className="text-accent" /> Predstojeće
              </h2>
              <Link to="/month" className="text-sm font-bold text-accent">
                Mesec
              </Link>
            </div>
            <Card className="divide-y p-0">
              {upcoming.length ? (
                upcoming.map((item) => {
                  const overdue = item.date < todayIso();
                  return (
                    <div
                      key={`${item.kind}-${item.key}`}
                      className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-start gap-3 p-4"
                    >
                      <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
                        {item.kind === 'commitment' ? (
                          <ReceiptText size={19} />
                        ) : (
                          <CalendarClock size={19} />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 break-words text-sm font-bold">{item.name}</p>
                        <p className="mt-1 text-xs text-muted">{formatDate(item.date)}</p>
                        <StatusBadge tone={overdue ? 'warning' : 'neutral'} className="mt-2">
                          {overdue ? 'Kasni' : 'Predstoji'}
                        </StatusBadge>
                      </div>
                      <div className="grid justify-items-end gap-2">
                        <MoneyValue value={item.amount} className="text-sm" />
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => void markPaid(item)}
                          aria-label={`Označi kao plaćeno: ${item.name}`}
                        >
                          <CircleCheck size={18} />
                        </Button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="p-6 text-center">
                  <CircleCheck className="mx-auto text-accent" />
                  <p className="mt-2 text-sm font-bold">Nema neplaćenih stavki ovog meseca</p>
                </div>
              )}
            </Card>
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-bold">
                <Target size={20} className="text-accent" /> Ciljevi
              </h2>
              <Link to="/goals" className="text-sm font-bold text-accent">
                Svi ciljevi
              </Link>
            </div>
            {snapshot.goals.some((goal) => !goal.archived) ? (
              <div className="-mx-4 flex w-full min-w-0 snap-x gap-3 overflow-x-auto px-4 pb-1 scrollbar-none lg:mx-0 lg:grid lg:px-0">
                {snapshot.goals
                  .filter((goal) => !goal.archived)
                  .map((goal) => {
                    const progress = calculateGoalProgress(
                      goal,
                      balances[goal.linkedAccountId] ?? 0,
                      new Date(),
                    );
                    return (
                      <Link
                        key={goal.id}
                        to="/goals"
                        className="min-w-[78vw] snap-center rounded-card border bg-surface p-4 sm:min-w-72 lg:min-w-0"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-2xl">{goal.emoji}</span>
                          <span className="text-sm font-extrabold text-accent">
                            {progress.percentage}%
                          </span>
                        </div>
                        <p className="mt-3 font-bold">{goal.name}</p>
                        <p className="money mt-1 text-sm text-muted">
                          {formatRsd(progress.current)} / {formatRsd(goal.targetAmount)}
                        </p>
                        <Progress className="mt-3" value={progress.percentage} />
                      </Link>
                    );
                  })}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed p-5">
                <p className="text-sm font-bold">Još nemaš cilj štednje.</p>
                <p className="mt-1 text-xs leading-5 text-muted">
                  Odvoji novac za nešto što znaš da dolazi.
                </p>
                <Link
                  className="mt-3 inline-flex min-h-11 items-center text-sm font-bold text-accent"
                  to="/goals"
                >
                  Dodaj cilj
                </Link>
              </div>
            )}
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-bold">
                <Wallet size={20} className="text-accent" /> Poslednje transakcije
              </h2>
              <Link to="/more/transactions" className="text-sm font-bold text-accent">
                Sve
              </Link>
            </div>
            <Card className="divide-y p-0">
              {recentTransactions.length ? (
                recentTransactions.map((transaction) => (
                  <div key={transaction.id} className="flex items-center gap-3 p-4">
                    <span
                      className={`grid size-9 place-items-center rounded-xl ${transaction.type === 'expense' ? 'bg-danger-soft text-danger' : transaction.type === 'income' ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted'}`}
                    >
                      {transaction.type === 'transfer'
                        ? '↔'
                        : transaction.type === 'income'
                          ? '↙'
                          : transaction.type === 'adjustment'
                            ? '≈'
                            : '↗'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{transaction.description}</p>
                      <p className="text-xs text-muted">{formatDate(transaction.date)}</p>
                    </div>
                    <p
                      className={`money text-sm font-bold ${transaction.type === 'expense' ? 'text-danger' : transaction.type === 'income' ? 'text-accent' : ''}`}
                    >
                      {transaction.type === 'expense'
                        ? '−'
                        : transaction.type === 'income'
                          ? '+'
                          : ''}
                      {formatRsd(Math.abs(transaction.amount))}
                    </p>
                  </div>
                ))
              ) : (
                <div className="p-6 text-center text-sm text-muted">
                  Još nema transakcija. Dodajte prvu preko + dugmeta.
                </div>
              )}
            </Card>
          </div>
        </section>
      </div>

      {installPrompt && !standalone && !snapshot.settingsRecord.installHintDismissed ? (
        <Card className="mt-5 flex items-center gap-3 bg-accent-soft">
          <Download className="shrink-0 text-accent" />
          <div className="flex-1">
            <p className="text-sm font-bold">Dodajte Mirnu na početni ekran</p>
            <p className="text-xs text-muted">Brže otvaranje i pouzdan offline rad.</p>
          </div>
          <Button size="sm" onClick={() => void install()}>
            Instaliraj
          </Button>
        </Card>
      ) : null}

      <Sheet
        open={safeInfoOpen}
        onOpenChange={setSafeInfoOpen}
        title="Kako računamo bezbedno za trošenje"
        description="Zaštićena štednja se nikada ne predstavlja kao slobodan novac."
      >
        <div className="grid gap-3">
          {[
            ['Raspoloživo na tekućim računima i u kešu', spendableBalance, false],
            ['Preostale fiksne obaveze', remainingFixed, true],
            ['Preostali promenljivi budžeti', remainingVariable, true],
            ['Neplaćeni događaji sa raspoloživih računa', upcomingEvents, true],
            ['Preostali plan štednje', remainingSavingsPlan, true],
            ['Preostali plan otplate dugova', summary.debt.remaining, true],
          ].map(([label, value, negative]) => (
            <div
              key={String(label)}
              className="flex items-center justify-between gap-4 rounded-xl bg-surface p-3"
            >
              <span className="text-sm text-muted">{label}</span>
              <span className="money text-sm font-bold">
                {negative ? '− ' : ''}
                {formatRsd(Number(value))}
              </span>
            </div>
          ))}
          <div className="mt-1 flex items-center justify-between border-t pt-4">
            <span className="font-bold">Bezbedno za trošenje</span>
            <span className="money text-lg font-extrabold">{formatRsd(safeToSpend)}</span>
          </div>
          <p className="text-xs leading-5 text-muted">
            Već plaćene stavke se ne oduzimaju ponovo: njihova stvarna transakcija je već smanjila
            stanje računa.
          </p>
        </div>
      </Sheet>
      <EventPaymentSheet
        event={payingEvent}
        snapshot={snapshot}
        open={Boolean(payingEvent)}
        onOpenChange={(open) => !open && setPayingEvent(null)}
        onPaid={() => {
          setPayingEvent(null);
          success('Događaj je označen kao plaćen.');
        }}
      />
    </main>
  );
};
