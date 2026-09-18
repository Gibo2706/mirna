import { useEffect, useRef, useState } from 'react';
import { addMonths, format, parseISO } from 'date-fns';
import { BarChart3, ChevronLeft, ChevronRight, CircleCheck, ReceiptText } from 'lucide-react';
import { Link } from 'react-router';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type {
  CommitmentOccurrence,
  FinanceSnapshot,
  PlannedEvent,
  PlannedIncomeOccurrence,
} from '@/domain/types';
import { calculateBudgetProgress, calculateMonthlyFinancialSummary } from '@/domain/calculations';
import { getAllCommitmentOccurrences, getAllPlannedIncomeOccurrences } from '@/domain/recurrence';
import { classifySavingsTransfer } from '@/domain/savingsTransfers';
import { currentMonthKey, formatDate, formatMonth, todayIso } from '@/lib/dates';
import { formatCompactRsd, formatRsd, parseIntegerInput } from '@/lib/format';
import { useCurrentDate } from '@/lib/useCurrentDate';
import { markPlannedIncomeReceived } from '@/db/commands';
import { Button } from '@/components/ui/Button';
import { Progress } from '@/components/ui/Progress';
import { PageHeader } from '@/components/PageHeader';
import { useToast } from '@/components/ToastProvider';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { CommitmentPaymentSheet } from '@/features/commitments/CommitmentPaymentSheet';
import { EventPaymentSheet } from '@/features/events/EventPaymentSheet';
import { MoneyValue } from '@/components/ui/MoneyValue';
import { StatusBadge } from '@/components/ui/StatusBadge';

export const MonthPage = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const liveCurrentMonth = currentMonthKey(useCurrentDate());
  const [month, setMonth] = useState(liveCurrentMonth);
  const previousCurrentMonth = useRef(liveCurrentMonth);
  const { success } = useToast();
  const [actionError, setActionError] = useState('');
  const [payingCommitment, setPayingCommitment] = useState<CommitmentOccurrence | null>(null);
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
      transaction.date.startsWith(month) &&
      classifySavingsTransfer(transaction, snapshot.accounts, snapshot.goals),
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

  const payOccurrence = (occurrence: CommitmentOccurrence) => setPayingCommitment(occurrence);

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
        <section aria-label="Plan i stvarno stanje" className="border-y py-4">
          <div className="grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,1fr))] gap-2 border-b pb-3 text-right text-xs font-semibold text-muted">
            <span className="text-left">Ovaj mesec</span>
            <span>Plan</span>
            <span>Stvarno</span>
            <span>Preostalo</span>
          </div>
          {[
            ['Prihod', summary.income.planned, summary.income.actual, summary.income.remaining],
            ['Fiksno', summary.fixed.planned, summary.fixed.actual, summary.fixed.remaining],
            [
              'Promenljivo',
              summary.variable.planned,
              summary.variable.actual,
              summary.variable.remaining,
            ],
            ['Događaji', summary.events.planned, summary.events.actual, summary.events.remaining],
            ['Štednja', summary.savings.planned, summary.savings.actual, summary.savings.remaining],
            ['Dugovi', summary.debt.planned, summary.debt.actual, summary.debt.remaining],
            ['Van plana', 0, summary.unplanned.actual, 0],
          ].map(([label, planned, actual, remaining]) => (
            <div
              key={String(label)}
              className="grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,1fr))] items-center gap-2 border-b py-3 text-right text-xs last:border-0 sm:text-sm"
            >
              <span className="text-left font-semibold">{label}</span>
              {[planned, actual, remaining].map((value, index) => (
                <span key={index} className="money break-words">
                  {Number(value).toLocaleString('sr-RS')}
                </span>
              ))}
            </div>
          ))}
          <p className="mt-2 text-xs text-muted">
            Svi iznosi su u RSD. Štednja je prenos između vaših računa.
          </p>
        </section>
      ) : null}

      <div className="mt-5 grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
        <section className="section-stack">
          <section className="finance-section">
            <div className="p-4">
              <p className="text-sm font-semibold text-muted">Planirani prihod</p>
              <h2 className="mt-1 font-bold">
                {formatRsd(summary.income.actualPlanned)} primljeno ·{' '}
                {formatRsd(summary.income.remaining)} preostalo
              </h2>
            </div>
            <div className="divide-y border-t">
              {incomeOccurrences.map((occurrence) => (
                <div key={occurrence.key} className="flex items-center gap-3 p-4">
                  <span
                    className={`grid w-5 shrink-0 place-items-center ${
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
          </section>

          {hasPlan || recent.length ? (
            <details className="finance-section">
              <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold">
                <BarChart3 className="text-accent" size={20} />
                Plan naspram stvarnog · grafik
              </summary>
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
            </details>
          ) : null}

          <section className="finance-section">
            <div className="flex items-start justify-between gap-3 p-4">
              <div>
                <p className="text-sm font-semibold text-muted">Neplanirani / ostali troškovi</p>
                <h2 className="money mt-1 text-lg font-extrabold">
                  {formatRsd(summary.unplanned.actual)}
                </h2>
                <p className="mt-1 text-xs text-muted">
                  Troškovi koji nisu fiksna obaveza, aktivni promenljivi budžet, događaj ili dug.
                </p>
              </div>
              {summary.expenseReconciliation.status !== 'OK' ? (
                <p role="alert" className="text-sm font-semibold text-warning">
                  Zbir troškova se ne poklapa. Proverite transakcije.
                </p>
              ) : null}
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
          </section>

          <section className="finance-section">
            <div className="flex items-center justify-between p-4">
              <div>
                <p className="text-sm font-semibold text-muted">Fiksne obaveze</p>
                <h2 className="mt-1 font-bold">
                  {occurrences.filter((value) => value.paidTransactionId).length} /{' '}
                  {occurrences.length} plaćeno
                </h2>
              </div>
              <p className="money text-sm font-bold">
                {formatRsd(summary.fixed.remaining)} preostalo
              </p>
            </div>
            <div className="divide-y border-t">
              {occurrences.map((occurrence) => (
                <div key={occurrence.key} className="flex items-center gap-3 p-4">
                  <span
                    className={`grid w-5 shrink-0 place-items-center ${occurrence.paidTransactionId ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted'}`}
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
          </section>
        </section>

        <section className="section-stack">
          <section className="finance-section">
            <div className="mb-4">
              <p className="text-sm font-semibold text-muted">Promenljivi budžeti</p>
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
          </section>

          <section className="finance-section">
            <div className="p-4">
              <h2 className="mt-1 font-bold">Planirani događaji</h2>
            </div>
            <div className="divide-y border-t">
              {events.map((event) => {
                const overdue = !event.paidTransactionId && event.date < todayIso();
                return (
                  <div
                    key={event.id}
                    className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-3 p-4"
                    data-testid="month-planned-event-row"
                  >
                    <span
                      className={`grid w-5 shrink-0 place-items-center ${event.paidTransactionId ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted'}`}
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
          </section>

          <section className="finance-section">
            <p className="text-sm font-semibold text-muted">Štednja i slobodan novac</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="border-b py-3">
                <p className="text-xs text-muted">Plan doprinosa</p>
                <p className="money mt-1 font-extrabold">{formatRsd(summary.savings.planned)}</p>
                <p className="mt-1 text-xs text-muted">istorijski plan meseca</p>
              </div>
              <div className="border-b py-3">
                <p className="text-xs text-muted">Prebačeno u štednju</p>
                <p className="money mt-1 font-extrabold">
                  {formatRsd(actuals.savingsContributions)}
                </p>
                <p className="mt-1 text-xs text-muted">{savingsTransfers.length} transfera</p>
              </div>
              <div className="border-b py-3">
                <p className="text-xs text-muted">Preostali doprinos</p>
                <p className="money mt-1 font-extrabold">{formatRsd(summary.savings.remaining)}</p>
                <p className="mt-1 text-xs text-muted">do mesečnog plana i ciljnog iznosa</p>
              </div>
              <div className="border-b py-3">
                <p className="text-xs text-muted">Slobodan plan</p>
                <p
                  className={`money mt-1 font-extrabold ${plan.freeCash < 0 ? 'text-danger' : ''}`}
                >
                  {formatRsd(plan.freeCash)}
                </p>
                <p className="mt-1 text-xs text-muted">prihod − svi planovi</p>
              </div>
            </div>
          </section>

          <section className="finance-section">
            <div className="p-4">
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
          </section>
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
      <CommitmentPaymentSheet
        occurrence={payingCommitment}
        snapshot={snapshot}
        open={Boolean(payingCommitment)}
        onOpenChange={(open) => !open && setPayingCommitment(null)}
        onPaid={() => success('Označeno kao plaćeno.')}
      />
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
