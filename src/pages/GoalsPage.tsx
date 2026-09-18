import { useMemo, useRef, useState } from 'react';
import { addMonths, format, parseISO } from 'date-fns';
import { ChevronRight, Plus, Target, Trash2 } from 'lucide-react';
import type { FinanceSnapshot, SavingsGoal } from '@/domain/types';
import {
  calculateAccountBalances,
  calculateGoalProgress,
  getEffectiveGoalContribution,
} from '@/domain/calculations';
import { contributeToGoal, deleteGoal, saveGoal } from '@/db/commands';
import { createId } from '@/lib/id';
import { currentMonthKey, formatDate, formatMonth, todayIso } from '@/lib/dates';
import { formatRsd, parseIntegerInput } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Progress } from '@/components/ui/Progress';
import { Sheet } from '@/components/ui/Sheet';
import { PageHeader } from '@/components/PageHeader';
import { SavingsWithdrawalSheet } from '@/features/goals/SavingsWithdrawalSheet';
import { getGoalActivity } from '@/domain/goalActivity';
import { useToast } from '@/components/ToastProvider';

const emptyGoal = (accountId = ''): SavingsGoal => ({
  id: createId('goal'),
  name: '',
  emoji: '🎯',
  targetAmount: 0,
  linkedAccountId: accountId,
  plannedMonthlyContribution: 0,
  contributionOverrides: {},
  goalType: 'reserve',
  archived: false,
  createdAt: new Date().toISOString(),
});

export const GoalsPage = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const { success } = useToast();
  const [editing, setEditing] = useState<SavingsGoal | null>(null);
  const [contributing, setContributing] = useState<SavingsGoal | null>(null);
  const [details, setDetails] = useState<SavingsGoal | null>(null);
  const [withdrawing, setWithdrawing] = useState<SavingsGoal | null>(null);
  const [deleting, setDeleting] = useState<SavingsGoal | null>(null);
  const [fromAccountId, setFromAccountId] = useState(
    snapshot.settingsRecord.defaultAccountId ?? '',
  );
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(todayIso());
  const [error, setError] = useState('');
  const [contributionSaving, setContributionSaving] = useState(false);
  const contributionSavingRef = useRef(false);
  const balances = useMemo(
    () => calculateAccountBalances(snapshot.accounts, snapshot.transactions),
    [snapshot.accounts, snapshot.transactions],
  );
  const goals = snapshot.goals.filter((goal) => !goal.archived);
  const savingsAccounts = snapshot.accounts.filter(
    (account) => account.kind === 'savings' && !account.archived,
  );
  const spendableAccounts = snapshot.accounts.filter(
    (account) => !account.protected && !account.archived,
  );
  const totalSaved = goals.reduce(
    (sum, goal) => sum + Math.max(0, balances[goal.linkedAccountId] ?? 0),
    0,
  );
  const contributionMonths = Array.from({ length: 6 }, (_, offset) =>
    format(addMonths(parseISO(`${currentMonthKey()}-01`), offset), 'yyyy-MM'),
  );

  const openContribution = (goal: SavingsGoal) => {
    setContributing(goal);
    setAmount(0);
    setDate(todayIso());
    setFromAccountId(snapshot.settingsRecord.defaultAccountId ?? spendableAccounts[0]?.id ?? '');
    setError('');
    setContributionSaving(false);
    contributionSavingRef.current = false;
  };

  const submitContribution = async () => {
    if (!contributing || amount <= 0 || !fromAccountId || contributionSavingRef.current) return;
    contributionSavingRef.current = true;
    setContributionSaving(true);
    try {
      await contributeToGoal({
        goalId: contributing.id,
        fromAccountId,
        amount,
        date,
      });
      success('Novac je prebačen u štednju. Nije evidentiran kao trošak.');
      setContributing(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Transfer nije sačuvan.');
      contributionSavingRef.current = false;
      setContributionSaving(false);
    }
  };

  const submitGoal = async () => {
    if (!editing) return;
    setError('');
    try {
      await saveGoal(editing);
      success('Cilj je sačuvan.');
      setEditing(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Cilj nije sačuvan.');
    }
  };

  return (
    <main className="screen">
      <PageHeader
        eyebrow="Štednja"
        title="Ciljevi"
        description="Odvojite za važne stvari. Koristite kada zatreba."
        action={
          <Button
            onClick={() =>
              setEditing(
                emptyGoal(
                  savingsAccounts.find(
                    (account) => !goals.some((goal) => goal.linkedAccountId === account.id),
                  )?.id,
                ),
              )
            }
            aria-label="Novi cilj"
          >
            <Plus size={18} /> Novi cilj
          </Button>
        }
      />

      <section className="mb-7 border-b pb-6">
        <p className="text-sm text-muted">Ukupno u namenskoj štednji</p>
        <p className="money mt-1 text-4xl font-bold tracking-tight">{formatRsd(totalSaved)}</p>
        <p className="mt-2 text-sm text-muted">Odvojeno od novca za svakodnevno trošenje.</p>
      </section>
      {goals.length ? (
        <div className="grid gap-x-8 lg:grid-cols-2">
          {goals.map((goal) => {
            const progress = calculateGoalProgress(
              goal,
              balances[goal.linkedAccountId] ?? 0,
              new Date(),
            );
            const contribution = getEffectiveGoalContribution({
              goal,
              month: currentMonthKey(),
              accounts: snapshot.accounts,
              transactions: snapshot.transactions,
              currentGoalBalance: balances[goal.linkedAccountId] ?? 0,
            });
            return (
              <article key={goal.id} data-testid="goal-row" className="border-b pb-6 pt-4">
                <button
                  className="finance-row pt-0"
                  onClick={() => setDetails(goal)}
                  aria-label={`Detalji cilja ${goal.name}`}
                >
                  <Target size={22} className="shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-xl font-bold">{goal.name}</h2>
                    <p className="mt-1 text-xs text-muted">
                      {goal.goalType === 'reserve' ? 'Rezervni fond' : 'Namenski cilj'}
                    </p>
                  </div>
                  <ChevronRight size={18} className="shrink-0 text-muted" />
                </button>
                <p className="money text-2xl font-bold">
                  {formatRsd(progress.current)}{' '}
                  <span className="text-sm font-normal text-muted">
                    / {formatRsd(goal.targetAmount)}
                  </span>
                </p>
                <Progress className="my-3 h-1.5" value={progress.percentage} />
                <p className="text-sm text-muted">
                  {progress.lifecycle === 'used'
                    ? 'Iskorišćeno · namena je završena'
                    : `Preostalo ${formatRsd(progress.remaining)}`}
                </p>
                <p className="mt-2 text-xs text-muted">
                  Ovog meseca uplaćeno{' '}
                  <strong className="text-foreground">
                    {formatRsd(contribution.actualContribution)}
                  </strong>{' '}
                  · još {formatRsd(contribution.effectiveRemainingContribution)}
                </p>
                {progress.lifecycle !== 'used' ? (
                  <div className="mt-4 grid gap-2 min-[390px]:grid-cols-2">
                    <Button
                      onClick={() => openContribution(goal)}
                      disabled={progress.remaining === 0}
                    >
                      Prebaci u štednju
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setWithdrawing(goal)}
                      disabled={progress.current <= 0}
                    >
                      Iskoristi sredstva
                    </Button>
                  </div>
                ) : null}
                {progress.current <= 0 ? (
                  <p className="mt-2 text-xs text-muted">
                    Sredstva možete koristiti nakon prve uplate.
                  </p>
                ) : progress.remaining === 0 ? (
                  <p className="mt-2 text-xs text-muted">Cilj je popunjen.</p>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={Target}
          title="Napravite prvi cilj"
          description="Povežite namenski štedni račun i pratite koliko je još potrebno."
          action={
            <Button onClick={() => setEditing(emptyGoal(savingsAccounts[0]?.id))}>
              <Plus size={18} /> Novi cilj
            </Button>
          }
        />
      )}
      <Sheet
        open={Boolean(details)}
        onOpenChange={(open) => !open && setDetails(null)}
        title={details?.name ?? 'Detalji cilja'}
        description="Plan i istorija štednje"
      >
        {details ? (
          <div className="grid gap-5">
            <dl className="divide-y text-sm">
              {[
                ['Cilj', formatRsd(details.targetAmount)],
                ['Sačuvano', formatRsd(balances[details.linkedAccountId] ?? 0)],
                ['Rok', details.targetDate ? formatDate(details.targetDate) : 'Bez roka'],
                [
                  'Mesečni plan',
                  formatRsd(
                    getEffectiveGoalContribution({
                      goal: details,
                      month: currentMonthKey(),
                      accounts: snapshot.accounts,
                      transactions: snapshot.transactions,
                      currentGoalBalance: balances[details.linkedAccountId] ?? 0,
                    }).configuredPlan,
                  ),
                ],
                [
                  'Preporučena mesečna uplata',
                  formatRsd(
                    calculateGoalProgress(
                      details,
                      balances[details.linkedAccountId] ?? 0,
                      new Date(),
                    ).recommendedMonthlyContribution ?? 0,
                  ),
                ],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-wrap justify-between gap-3 py-3">
                  <dt className="text-muted">{label}</dt>
                  <dd className="money font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
            {details.targetDate &&
            details.targetDate < todayIso() &&
            (balances[details.linkedAccountId] ?? 0) < details.targetAmount ? (
              <p className="text-sm text-warning">
                Rok je prošao. Do cilja nedostaje{' '}
                {formatRsd(details.targetAmount - (balances[details.linkedAccountId] ?? 0))}.
              </p>
            ) : null}
            {details.notes ? <p className="text-sm text-muted">{details.notes}</p> : null}
            <section>
              <h3 className="font-bold">Aktivnost</h3>
              <ul className="mt-2 divide-y">
                {getGoalActivity(details, snapshot.accounts, snapshot.transactions).map(
                  ({ transaction, kind, amount }) => (
                    <li key={transaction.id} className="flex gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold">
                          {kind === 'contribution'
                            ? 'Uplata u štednju'
                            : kind === 'withdrawal'
                              ? 'Iskorišćena sredstva'
                              : transaction.description}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {formatDate(transaction.date)}
                          {transaction.notes ? ` · ${transaction.notes}` : ''}
                        </p>
                      </div>
                      <span className="money shrink-0 text-sm font-semibold">
                        {amount > 0 ? '+' : '−'}
                        {formatRsd(Math.abs(amount))}
                      </span>
                    </li>
                  ),
                )}
              </ul>
              {getGoalActivity(details, snapshot.accounts, snapshot.transactions).length === 0 ? (
                <p className="py-4 text-sm text-muted">
                  Ovde će se pojaviti uplate i korišćenje štednje.
                </p>
              ) : null}
            </section>
            <div className="sheet-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(details);
                  setDetails(null);
                  setError('');
                }}
              >
                Izmeni cilj
              </Button>
            </div>
          </div>
        ) : null}
      </Sheet>
      {withdrawing ? (
        <SavingsWithdrawalSheet
          key={withdrawing.id}
          goal={withdrawing}
          snapshot={snapshot}
          onClose={() => setWithdrawing(null)}
          onSaved={() => {
            setWithdrawing(null);
            success('Novac je prebačen na raspoloživi račun. Ciljni iznos ostaje isti.');
          }}
        />
      ) : null}

      <Sheet
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.name ? 'Izmeni cilj' : 'Novi cilj'}
        description="Jedan štedni račun može pripadati samo jednom cilju."
      >
        {editing ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitGoal();
            }}
          >
            <div className="grid grid-cols-[5rem_1fr] gap-3">
              <Field label="Emoji">
                <Input
                  value={editing.emoji}
                  onChange={(event) => setEditing({ ...editing, emoji: event.target.value })}
                />
              </Field>
              <Field label="Naziv">
                <Input
                  value={editing.name}
                  onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                />
              </Field>
            </div>
            <Field label="Ciljni iznos (RSD)">
              <Input
                inputMode="numeric"
                value={editing.targetAmount || ''}
                onChange={(event) =>
                  setEditing({ ...editing, targetAmount: parseIntegerInput(event.target.value) })
                }
              />
            </Field>
            <Field label="Namenski štedni račun">
              <Select
                value={editing.linkedAccountId}
                onChange={(event) =>
                  setEditing({ ...editing, linkedAccountId: event.target.value })
                }
              >
                <option value="">Izaberite račun</option>
                {savingsAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Vrsta cilja"
              hint="Namenski cilj se završava plaćanjem povezanog događaja; rezerva se ponovo dopunjava posle trošenja."
            >
              <Select
                value={editing.goalType}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    goalType: event.target.value as SavingsGoal['goalType'],
                    usedAt: event.target.value === 'reserve' ? undefined : editing.usedAt,
                  })
                }
              >
                <option value="sinking">Namenski cilj</option>
                <option value="reserve">Rezervni fond</option>
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Ciljni datum (opciono)">
                <Input
                  type="date"
                  value={editing.targetDate ?? ''}
                  onChange={(event) =>
                    setEditing({ ...editing, targetDate: event.target.value || undefined })
                  }
                />
              </Field>
              <Field label="Mesečni plan uplate">
                <Input
                  inputMode="numeric"
                  value={editing.plannedMonthlyContribution || ''}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      plannedMonthlyContribution: parseIntegerInput(event.target.value),
                    })
                  }
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Plan važi od meseca (opciono)">
                <Input
                  type="month"
                  value={editing.contributionStartMonth ?? ''}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      contributionStartMonth: event.target.value || undefined,
                    })
                  }
                />
              </Field>
              <Field label="Plan važi do meseca (opciono)">
                <Input
                  type="month"
                  value={editing.contributionEndMonth ?? ''}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      contributionEndMonth: event.target.value || undefined,
                    })
                  }
                />
              </Field>
            </div>
            <div className="rounded-2xl bg-surface-2 p-4">
              <p className="font-bold">Plan doprinosa — narednih 6 meseci</p>
              <p className="mt-1 text-xs text-muted">
                Prazno koristi mesečni plan. Unesite 0 da cilj preskoči konkretan mesec.
              </p>
              <div className="mt-4 grid gap-3">
                {contributionMonths.map((month) => (
                  <Field key={month} label={formatMonth(month)}>
                    <Input
                      inputMode="numeric"
                      placeholder={String(editing.plannedMonthlyContribution)}
                      value={editing.contributionOverrides[month] ?? ''}
                      onChange={(event) => {
                        const overrides = { ...editing.contributionOverrides };
                        if (event.target.value === '') delete overrides[month];
                        else overrides[month] = parseIntegerInput(event.target.value);
                        setEditing({ ...editing, contributionOverrides: overrides });
                      }}
                    />
                  </Field>
                ))}
              </div>
            </div>
            <Field label="Beleška">
              <Textarea
                value={editing.notes ?? ''}
                onChange={(event) => setEditing({ ...editing, notes: event.target.value })}
              />
            </Field>
            {error ? (
              <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <Button
              size="lg"
              type="submit"
              disabled={!editing.name || !editing.linkedAccountId || editing.targetAmount <= 0}
            >
              Sačuvaj cilj
            </Button>
            {!editing.id.startsWith('goal_') ||
            snapshot.goals.some((goal) => goal.id === editing.id) ? (
              <Button
                type="button"
                variant="ghost"
                className="text-danger"
                onClick={() => {
                  setEditing(null);
                  setDeleting(editing);
                }}
              >
                <Trash2 size={17} /> Obriši cilj
              </Button>
            ) : null}
          </form>
        ) : null}
      </Sheet>

      <Sheet
        open={Boolean(contributing)}
        onOpenChange={(open) => !open && !contributionSavingRef.current && setContributing(null)}
        title={`Prebaci za ${contributing?.name ?? 'cilj'}`}
        description="Ovo je transfer između vaših računa i ne povećava troškove."
      >
        {contributing ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitContribution();
            }}
          >
            <Field label="Sa računa">
              <Select
                value={fromAccountId}
                onChange={(event) => setFromAccountId(event.target.value)}
              >
                <option value="">Izaberite račun</option>
                {spendableAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {formatRsd(balances[account.id] ?? 0)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Iznos (RSD)">
              <Input
                autoFocus
                inputMode="numeric"
                className="money h-16 text-2xl font-extrabold"
                value={amount || ''}
                onChange={(event) => setAmount(parseIntegerInput(event.target.value))}
              />
            </Field>
            <Field label="Datum">
              <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </Field>
            {error ? (
              <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <Button
              type="submit"
              size="lg"
              disabled={amount <= 0 || !fromAccountId || contributionSaving}
            >
              {contributionSaving
                ? 'Prebacujem…'
                : `Prebaci ${amount > 0 ? formatRsd(amount) : ''}`}
            </Button>
          </form>
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Obrisati cilj?"
        description="Povezani račun i postojeći transferi neće biti obrisani. Ako cilj ima istoriju transfera, umesto brisanja biće arhiviran."
        confirmLabel="Obriši"
        danger
        onConfirm={async () => {
          if (!deleting) return;
          const result = await deleteGoal(deleting.id);
          setDeleting(null);
          success(result === 'archived' ? 'Cilj je arhiviran.' : 'Cilj je obrisan.');
        }}
      />
    </main>
  );
};
