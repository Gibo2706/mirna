import { useEffect, useRef, useState } from 'react';
import { addMonths, format, parseISO } from 'date-fns';
import { BarChart3, ChevronLeft, ChevronRight, CircleCheck, ReceiptText } from 'lucide-react';
import { Link } from 'react-router';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { FinanceSnapshot, PlannedEvent, PlannedIncomeOccurrence } from '@/domain/types';
import { calculateBudgetProgress, calculateMonthlyFinancialSummary } from '@/domain/calculations';
import { getAllCommitmentOccurrences, getAllPlannedIncomeOccurrences } from '@/domain/recurrence';
import { currentMonthKey, formatDate, formatMonth, todayIso } from '@/lib/dates';
import { formatCompactRsd, formatRsd, parseIntegerInput } from '@/lib/format';
import { useCurrentDate } from '@/lib/useCurrentDate';
import { markCommitmentPaid, markPlannedIncomeReceived } from '@/db/commands';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Progress } from '@/components/ui/Progress';
import { PageHeader } from '@/components/PageHeader';
import { useToast } from '@/components/ToastProvider';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { EventPaymentSheet } from '@/features/events/EventPaymentSheet';
import { MoneyValue } from '@/components/ui/MoneyValue';
import { StatusBadge } from '@/components/ui/StatusBadge';

export const MonthPage = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const liveCurrentMonth = currentMonthKey(useCurrentDate());
  const [month, setMonth] = useState(liveCurrentMonth);
  const previousCurrentMonth = useRef(liveCurrentMonth);
  const { success } = useToast();
  const [actionError, setActionError] = useState('');
  const [payingEvent, setPayingEvent] = useState<PlannedEvent | null>(null);
  const [receivingIncome, setReceivingIncome] = useState<PlannedIncomeOccurrence | null>(null);
  const [receivedAmount, setReceivedAmount] = useState(0);
  const [receivedDate, setReceivedDate] = useState('');
  const [receivedAccountId, setReceivedAccountId] = useState('');
  const [receivedNote, setReceivedNote] = useState('');
  const [futureIncomeConfirmed, setFutureIncomeConfirmed] = useState(false);
  const [incomeSaving, setIncomeSaving] = useState(false);
  const incomeSavingRef = useRef(false);
  useEffect(() => {
    if (month === previousCurrentMonth.current) setMonth(liveCurrentMonth);
    previousCurrentMonth.current = liveCurrentMonth;
  }, [liveCurrentMonth, month]);
  const moveMonth = (offset: number) =>
    setMonth(format(addMonths(parseISO(`${month}-01`), offset), 'yyyy-MM'));
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
  const actuals = {
    income: summary.income.actual,
    expenses: summary.actualExpenses,
    savingsContributions: summary.savings.actual,
  };
  const plan = {
    income: summary.income.planned,
    fixed: summary.fixed.planned,
    fixedPaid: summary.fixed.actual,
    variable: summary.variable.planned,
    events: summary.events.planned,
    savings: summary.savings.planned,
    debtPayments: summary.debt.planned,
    totalOutflow: summary.plannedCashOutflow,
    freeCash: summary.plannedFreeCash,
  };
  const incomeOccurrences = getAllPlannedIncomeOccurrences(
    snapshot.plannedIncomes,
    month,
    snapshot.transactions,
  );
  const occurrences = getAllCommitmentOccurrences(
    snapshot.commitments,
    month,
    snapshot.transactions,
  );
  const budgets = snapshot.variableBudgets
    .filter((budget) => budget.active)
    .map((budget) => ({
      budget,
      progress: calculateBudgetProgress(budget, snapshot.transactions, month),
    }));
  const events = snapshot.plannedEvents
    .filter((event) => event.date.startsWith(month))
    .sort((left, right) => left.date.localeCompare(right.date));
  const savingsTransfers = snapshot.transactions.filter(
    (transaction) =>
      transaction.type === 'transfer' && transaction.date.startsWith(month) && transaction.goalId,
  );
  const recent = snapshot.transactions
    .filter((transaction) => transaction.date.startsWith(month))
    .sort((left, right) => right.date.localeCompare(left.date));
  const unplannedTransactionIds = new Set(summary.unplanned.transactionIds);
  const unplannedTransactions = recent.filter((transaction) =>
    unplannedTransactionIds.has(transaction.id),
  );
  const chartData = [
    { name: 'Prihod', Plan: plan.income, Stvarno: actuals.income },
    { name: 'Fiksno', Plan: plan.fixed, Stvarno: plan.fixedPaid },
    {
      name: 'Promenljivo',
      Plan: plan.variable,
      Stvarno: budgets.reduce((sum, item) => sum + item.progress.actual, 0),
    },
    {
      name: 'Događaji',
      Plan: plan.events,
      Stvarno: summary.events.actual,
    },
    { name: 'Štednja', Plan: summary.savings.planned, Stvarno: summary.savings.actual },
    { name: 'Dug', Plan: summary.debt.planned, Stvarno: summary.debt.actual },
    { name: 'Van plana', Plan: 0, Stvarno: summary.unplanned.actual },
  ];
  const hasPlan =
    incomeOccurrences.length > 0 ||
    occurrences.length > 0 ||
    budgets.length > 0 ||
    events.length > 0 ||
    summary.savings.planned > 0 ||
    summary.debt.planned > 0;

  const payOccurrence = async (occurrence: (typeof occurrences)[number]) => {
    setActionError('');
    try {
      await markCommitmentPaid({
        occurrenceKey: occurrence.key,
        name: occurrence.name,
        amount: occurrence.amount,
        date: occurrence.date,
        accountId: occurrence.accountId,
        categoryId: occurrence.categoryId,
      });
      success('Obaveza je označena kao plaćena.');
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Obaveza nije evidentirana.');
    }
  };

  const openReceiveIncome = (occurrence: (typeof incomeOccurrences)[number]) => {
    setActionError('');
    setReceivingIncome(occurrence);
    setReceivedAmount(occurrence.amount);
    setReceivedDate(occurrence.month < liveCurrentMonth ? occurrence.expectedDate : todayIso());
    setReceivedAccountId(occurrence.accountId);
    setReceivedNote('');
    setFutureIncomeConfirmed(false);
    setIncomeSaving(false);
    incomeSavingRef.current = false;
  };

  const receiveIncome = async () => {
    if (!receivingIncome || incomeSavingRef.current) return;
    incomeSavingRef.current = true;
    setIncomeSaving(true);
    setActionError('');
    try {
      await markPlannedIncomeReceived({
        plannedIncomeId: receivingIncome.plannedIncomeId,
        occurrenceKey: receivingIncome.key,
        month: receivingIncome.month,
        receivedDate,
        amount: receivedAmount,
        accountId: receivedAccountId,
        notes: receivedNote,
      });
      setReceivingIncome(null);
      success('Prihod je evidentiran kao primljen.');
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Prihod nije evidentiran.');
      setIncomeSaving(false);
      incomeSavingRef.current = false;
    }
  };

  const payEvent = (eventId: string) => {
    setActionError('');
    const event = snapshot.plannedEvents.find((value) => value.id === eventId);
    if (!event) {
      setActionError('Planirani događaj više ne postoji.');
      return;
    }
    setPayingEvent(event);
  };

  return (
    <main className="screen">
      <PageHeader
        eyebrow="Plan i stvarno"
        title="Mesečni pregled"
        description="Svaki plan ostaje odvojen od onoga što se zaista dogodilo."
      />
      {actionError ? (
        <p role="alert" className="mb-4 rounded-xl bg-danger-soft p-3 text-sm text-danger">
          {actionError}
        </p>
      ) : null}
      {!hasPlan && recent.length === 0 ? (
        <div className="mb-5 rounded-2xl border border-dashed bg-surface/70 p-4">
          <p className="font-bold">Ovaj mesec je još prazan.</p>
          <p className="mt-1 text-sm leading-6 text-muted">
            Dodajte prihod, budžet ili obavezu kada budete spremni. Stvarne transakcije će ostati
            odvojene od plana.
          </p>
          <Link
            to="/more"
            className="mt-3 inline-flex min-h-11 items-center text-sm font-bold text-accent"
          >
            Postavi plan
          </Link>
        </div>
      ) : null}
      <div className="mb-5 flex items-center justify-between rounded-2xl border bg-surface p-1">
        <Button
          size="icon"
          variant="ghost"
          onClick={() => moveMonth(-1)}
          aria-label="Prethodni mesec"
        >
          <ChevronLeft />
        </Button>
        <label className="relative text-center font-extrabold capitalize">
          {formatMonth(month)}
          <input
            className="absolute inset-0 cursor-pointer opacity-0"
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            aria-label="Izaberi mesec"
          />
        </label>
        <Button size="icon" variant="ghost" onClick={() => moveMonth(1)} aria-label="Sledeći mesec">
          <ChevronRight />
        </Button>
      </div>

      {hasPlan || recent.length ? (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['Prihod', plan.income, actuals.income],
            ['Fiksne obaveze', plan.fixed, plan.fixedPaid],
            [
              'Promenljivo',
              plan.variable,
              budgets.reduce((sum, item) => sum + item.progress.actual, 0),
            ],
            ['Ukupni troškovi', summary.plannedExpenses, actuals.expenses],
          ].map(([label, planned, actual]) => (
            <Card key={String(label)}>
              <p className="text-xs font-bold uppercase tracking-wide text-muted">{label}</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div>
                  <p className="text-[0.68rem] text-muted">PLANIRANO</p>
                  <p className="money mt-1 font-extrabold">{formatRsd(Number(planned))}</p>
                </div>
                <div>
                  <p className="text-[0.68rem] text-muted">STVARNO</p>
                  <p className="money mt-1 font-extrabold">{formatRsd(Number(actual))}</p>
                </div>
              </div>
            </Card>
          ))}
        </section>
      ) : null}

      <div className="mt-5 grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
        <section className="section-stack">
          <Card className="p-0">
            <div className="p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-muted">
                Planirani prihod
              </p>
              <h2 className="mt-1 font-bold">
                {formatRsd(summary.income.actualPlanned)} primljeno ·{' '}
                {formatRsd(summary.income.remaining)} preostalo
              </h2>
            </div>
            <div className="divide-y border-t">
              {incomeOccurrences.map((occurrence) => (
                <div key={occurrence.key} className="flex items-center gap-3 p-4">
                  <span
                    className={`grid size-10 place-items-center rounded-xl ${
                      occurrence.receivedTransactionId
                        ? 'bg-accent-soft text-accent'
                        : 'bg-surface-2 text-muted'
                    }`}
                  >
                    {occurrence.receivedTransactionId ? (
                      <CircleCheck size={19} />
                    ) : (
                      <ReceiptText size={19} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold">{occurrence.name}</p>
                    <p className="text-xs text-muted">
                      očekivano {formatDate(occurrence.expectedDate)} ·{' '}
                      {formatRsd(occurrence.amount)}
                    </p>
                  </div>
                  {occurrence.receivedTransactionId ? (
                    <span className="text-right text-xs font-bold text-accent">
                      Primljeno
                      <span className="mt-0.5 block font-medium text-muted">
                        {formatDate(
                          snapshot.transactions.find(
                            (transaction) => transaction.id === occurrence.receivedTransactionId,
                          )?.date ?? occurrence.expectedDate,
                        )}
                      </span>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => openReceiveIncome(occurrence)}
                    >
                      Primljeno
                    </Button>
                  )}
                </div>
              ))}
              {!incomeOccurrences.length ? (
                <p className="p-6 text-center text-sm text-muted">
                  Nema planiranih prihoda za ovaj mesec.
                </p>
              ) : null}
            </div>
          </Card>

          {hasPlan || recent.length ? (
            <Card>
              <div className="mb-4 flex items-center gap-2">
                <BarChart3 className="text-accent" size={20} />
                <h2 className="font-bold">Plan naspram stvarnog</h2>
              </div>
              <div className="h-64 w-full" aria-label="Grafik plana i stvarnog">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ left: -18, right: 4 }}>
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 11, fill: 'var(--muted)' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tickFormatter={formatCompactRsd}
                      tick={{ fontSize: 10, fill: 'var(--muted)' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      formatter={(value) => formatRsd(Number(value))}
                      contentStyle={{
                        borderRadius: 14,
                        borderColor: 'var(--border)',
                        background: 'var(--surface)',
                        color: 'var(--foreground)',
                      }}
                    />
                    <Bar dataKey="Plan" fill="var(--border)" radius={[5, 5, 0, 0]} />
                    <Bar dataKey="Stvarno" fill="var(--accent)" radius={[5, 5, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          ) : null}

          <Card className="p-0">
            <div className="flex items-start justify-between gap-3 p-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-muted">
                  Neplanirani / ostali troškovi
                </p>
                <h2 className="money mt-1 text-lg font-extrabold">
                  {formatRsd(summary.unplanned.actual)}
                </h2>
                <p className="mt-1 text-xs text-muted">
                  Troškovi koji nisu fiksna obaveza, aktivni promenljivi budžet, događaj ili dug.
                </p>
              </div>
              <span
                className={`rounded-full px-2 py-1 text-[0.68rem] font-bold ${
                  summary.expenseReconciliation.status === 'OK'
                    ? 'bg-accent-soft text-accent'
                    : 'bg-warning-soft text-warning'
                }`}
              >
                OBRAČUN {summary.expenseReconciliation.status}
              </span>
            </div>
            <div className="max-h-72 divide-y overflow-y-auto border-t">
              {unplannedTransactions.map((transaction) => (
                <div key={transaction.id} className="flex items-center gap-3 p-4 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{transaction.description}</p>
                    <p className="text-xs text-muted">
                      {formatDate(transaction.date)}
                      {transaction.notes ? ` · ${transaction.notes}` : ''}
                    </p>
                  </div>
                  <p className="money font-bold text-danger">−{formatRsd(transaction.amount)}</p>
                </div>
              ))}
              {!unplannedTransactions.length ? (
                <p className="p-5 text-center text-sm text-muted">
                  Nema troškova van plana u ovom mesecu.
                </p>
              ) : null}
            </div>
          </Card>

          <Card className="p-0">
            <div className="flex items-center justify-between p-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-muted">
                  Fiksne obaveze
                </p>
                <h2 className="mt-1 font-bold">
                  {occurrences.filter((value) => value.paidTransactionId).length} /{' '}
                  {occurrences.length} plaćeno
                </h2>
              </div>
              <p className="money text-sm font-bold">
                {formatRsd(Math.max(0, plan.fixed - plan.fixedPaid))} preostalo
              </p>
            </div>
            <div className="divide-y border-t">
              {occurrences.map((occurrence) => (
                <div key={occurrence.key} className="flex items-center gap-3 p-4">
                  <span
                    className={`grid size-10 place-items-center rounded-xl ${occurrence.paidTransactionId ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted'}`}
                  >
                    {occurrence.paidTransactionId ? (
                      <CircleCheck size={19} />
                    ) : (
                      <ReceiptText size={19} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold">{occurrence.name}</p>
                    <p className="text-xs text-muted">
                      {formatDate(occurrence.date)} · {formatRsd(occurrence.amount)}
                    </p>
                  </div>
                  {!occurrence.paidTransactionId ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void payOccurrence(occurrence)}
                    >
                      Plaćeno
                    </Button>
                  ) : (
                    <span className="text-xs font-bold text-accent">Završeno</span>
                  )}
                </div>
              ))}
              {!occurrences.length ? (
                <p className="p-6 text-center text-sm text-muted">Nema obaveza za ovaj mesec.</p>
              ) : null}
            </div>
          </Card>
        </section>

        <section className="section-stack">
          <Card>
            <div className="mb-4">
              <p className="text-xs font-bold uppercase tracking-wide text-muted">
                Promenljivi budžeti
              </p>
              <h2 className="mt-1 text-lg font-bold">Plan, stvarno i preostalo</h2>
            </div>
            <div className="grid gap-5">
              {budgets.map(({ budget, progress }) => (
                <div key={budget.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-bold">
                        {
                          snapshot.categories.find((category) => category.id === budget.categoryId)
                            ?.icon
                        }{' '}
                        {budget.name}
                      </p>
                      <p className="money mt-1 text-sm text-muted">
                        {formatRsd(progress.actual)} / {formatRsd(progress.plan)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p
                        className={`text-sm font-extrabold ${
                          progress.overBudget > 0 ? 'text-danger' : 'text-accent'
                        }`}
                      >
                        {progress.percentage}%
                      </p>
                      <p className="text-xs text-muted">
                        {progress.overBudget > 0
                          ? `${formatRsd(progress.overBudget)} preko`
                          : `${formatRsd(progress.remaining)} ostalo`}
                      </p>
                    </div>
                  </div>
                  <Progress
                    className="mt-2.5"
                    value={progress.percentage}
                    tone={
                      progress.percentage > 100
                        ? 'danger'
                        : progress.percentage > 85
                          ? 'warning'
                          : 'accent'
                    }
                  />
                </div>
              ))}
              {!budgets.length ? (
                <p className="text-sm text-muted">Još nema aktivnih promenljivih budžeta.</p>
              ) : null}
            </div>
          </Card>

          <Card className="p-0">
            <div className="p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-muted">Jednokratno</p>
              <h2 className="mt-1 font-bold">Planirani događaji</h2>
            </div>
            <div className="divide-y border-t">
              {events.map((event) => {
                const overdue = !event.paidTransactionId && event.date < todayIso();
                return (
                  <div
                    key={event.id}
                    className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-start gap-3 p-4"
                    data-testid="month-planned-event-row"
                  >
                    <span
                      className={`grid size-10 place-items-center rounded-xl ${event.paidTransactionId ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted'}`}
                    >
                      {event.paidTransactionId ? <CircleCheck size={19} /> : '•'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 break-words text-sm font-bold">{event.title}</p>
                      <p className="mt-1 text-xs text-muted">{formatDate(event.date)}</p>
                      <StatusBadge
                        className="mt-2"
                        tone={
                          event.paidTransactionId ? 'positive' : overdue ? 'warning' : 'neutral'
                        }
                      >
                        {event.paidTransactionId ? 'Plaćeno' : overdue ? 'Kasni' : 'Predstoji'}
                      </StatusBadge>
                    </div>
                    <div className="grid justify-items-end gap-2">
                      <MoneyValue value={event.plannedAmount} className="text-sm" />
                      {!event.paidTransactionId ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={event.plannedAmount <= 0}
                          onClick={() => void payEvent(event.id)}
                          aria-label={`Označi kao plaćeno: ${event.title}`}
                        >
                          <CircleCheck size={18} />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {!events.length ? (
                <p className="p-6 text-center text-sm text-muted">Nema planiranih događaja.</p>
              ) : null}
            </div>
          </Card>

          <Card>
            <p className="text-xs font-bold uppercase tracking-wide text-muted">
              Štednja i slobodan novac
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-surface-2 p-3">
                <p className="text-xs text-muted">Plan doprinosa</p>
                <p className="money mt-1 font-extrabold">{formatRsd(summary.savings.planned)}</p>
                <p className="mt-1 text-[0.68rem] text-muted">istorijski plan meseca</p>
              </div>
              <div className="rounded-xl bg-accent-soft p-3">
                <p className="text-xs text-muted">Prebačeno u štednju</p>
                <p className="money mt-1 font-extrabold">
                  {formatRsd(actuals.savingsContributions)}
                </p>
                <p className="mt-1 text-[0.68rem] text-muted">
                  {savingsTransfers.length} transfera
                </p>
              </div>
              <div className="rounded-xl bg-surface-2 p-3">
                <p className="text-xs text-muted">Preostali doprinos</p>
                <p className="money mt-1 font-extrabold">{formatRsd(summary.savings.remaining)}</p>
                <p className="mt-1 text-[0.68rem] text-muted">posle target cap-a</p>
              </div>
              <div className="rounded-xl bg-surface-2 p-3">
                <p className="text-xs text-muted">Slobodan plan</p>
                <p
                  className={`money mt-1 font-extrabold ${plan.freeCash < 0 ? 'text-danger' : ''}`}
                >
                  {formatRsd(plan.freeCash)}
                </p>
                <p className="mt-1 text-[0.68rem] text-muted">prihod − svi planovi</p>
              </div>
            </div>
          </Card>

          <Card className="p-0">
            <div className="p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-muted">Aktivnost</p>
              <h2 className="mt-1 font-bold">Transakcije u mesecu</h2>
            </div>
            <div className="max-h-80 divide-y overflow-y-auto border-t">
              {recent.map((transaction) => (
                <div key={transaction.id} className="flex items-center gap-3 p-4 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{transaction.description}</p>
                    <p className="text-xs text-muted">{formatDate(transaction.date)}</p>
                  </div>
                  <p
                    className={`money font-bold ${transaction.type === 'expense' ? 'text-danger' : transaction.type === 'income' ? 'text-accent' : ''}`}
                  >
                    {transaction.type === 'expense'
                      ? '−'
                      : transaction.type === 'income'
                        ? '+'
                        : ''}
                    {formatRsd(Math.abs(transaction.amount))}
                  </p>
                </div>
              ))}
              {!recent.length ? (
                <p className="p-6 text-center text-sm text-muted">
                  Još nema transakcija u ovom mesecu.
                </p>
              ) : null}
            </div>
          </Card>
        </section>
      </div>
      <Sheet
        open={Boolean(receivingIncome)}
        onOpenChange={(open) => {
          if (!open && !incomeSavingRef.current) setReceivingIncome(null);
        }}
        title={`Primljen prihod — ${receivingIncome?.name ?? ''}`}
        description="Plan ostaje vezan za svoj mesec, a stvarni priliv pripada datumu kada je novac zaista primljen."
      >
        {receivingIncome ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void receiveIncome();
            }}
          >
            <Field label="Iznos (RSD)">
              <Input
                inputMode="numeric"
                value={receivedAmount || ''}
                onChange={(event) => setReceivedAmount(parseIntegerInput(event.target.value))}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Datum prijema">
                <Input
                  type="date"
                  value={receivedDate}
                  onChange={(event) => setReceivedDate(event.target.value)}
                />
              </Field>
              <Field label="Račun">
                <Select
                  value={receivedAccountId}
                  onChange={(event) => setReceivedAccountId(event.target.value)}
                >
                  {snapshot.accounts
                    .filter((account) => !account.archived)
                    .map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <Field label="Beleška (opciono)">
              <Textarea
                value={receivedNote}
                onChange={(event) => setReceivedNote(event.target.value)}
              />
            </Field>
            {receivingIncome.month > liveCurrentMonth ? (
              <label className="flex min-h-12 items-start gap-3 rounded-xl bg-warning-soft p-3 text-sm">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={futureIncomeConfirmed}
                  onChange={(event) => setFutureIncomeConfirmed(event.target.checked)}
                />
                Potvrđujem da je budući planirani prihod već stvarno primljen na uneti datum.
              </label>
            ) : null}
            {actionError ? (
              <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
                {actionError}
              </p>
            ) : null}
            <Button
              type="submit"
              size="lg"
              disabled={
                incomeSaving ||
                receivedAmount <= 0 ||
                !receivedDate ||
                !receivedAccountId ||
                (receivingIncome.month > liveCurrentMonth && !futureIncomeConfirmed)
              }
            >
              {incomeSaving ? 'Knjižim…' : 'Potvrdi prijem'}
            </Button>
          </form>
        ) : null}
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
