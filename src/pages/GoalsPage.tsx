import { useMemo, useRef, useState } from 'react';
import { addMonths, format, parseISO } from 'date-fns';
import { Edit3, Plus, Target, Trash2, TrendingUp } from 'lucide-react';
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
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Progress } from '@/components/ui/Progress';
import { Sheet } from '@/components/ui/Sheet';
import { PageHeader } from '@/components/PageHeader';
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
        description="Svaka uplata je transfer na namenski račun, nikada prikriveni trošak."
        action={
          <Button
            size="icon"
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
            <Plus />
          </Button>
        }
      />

      <Card className="mb-5 overflow-hidden rounded-hero border-0 bg-[#17251f] p-5 text-white">
        <p className="text-sm font-semibold text-white/65">Ukupno u namenskoj štednji</p>
        <p className="money mt-2 text-4xl font-extrabold tracking-[-0.05em]">
          {formatRsd(totalSaved)}
        </p>
        <p className="mt-2 text-sm text-white/60">
          {goals.length} cilja · zaštićeno od bezbednog trošenja
        </p>
      </Card>

      {goals.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {goals.map((goal) => {
            const progress = calculateGoalProgress(
              goal,
              balances[goal.linkedAccountId] ?? 0,
              new Date(),
            );
            const account = snapshot.accounts.find((value) => value.id === goal.linkedAccountId);
            const currentMonth = currentMonthKey();
            const contribution = getEffectiveGoalContribution({
              goal,
              month: currentMonth,
              transactions: snapshot.transactions,
              currentGoalBalance: balances[goal.linkedAccountId] ?? 0,
            });
            return (
              <Card key={goal.id} className="relative p-5">
                <div className="flex items-start gap-3">
                  <span className="grid size-12 place-items-center rounded-2xl bg-accent-soft text-2xl">
                    {goal.emoji}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-extrabold">{goal.name}</h2>
                    <p className="truncate text-xs text-muted">
                      {account?.name ?? 'Nepovezan račun'} ·{' '}
                      {goal.goalType === 'sinking' ? 'namenski cilj' : 'rezervni fond'}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setEditing(goal)}
                    aria-label={`Izmeni ${goal.name}`}
                  >
                    <Edit3 size={18} />
                  </Button>
                </div>
                {progress.lifecycle === 'used' ? (
                  <div className="mt-5 rounded-xl bg-accent-soft p-4">
                    <p className="text-lg font-extrabold text-accent">Iskorišćeno</p>
                    <p className="mt-1 text-xs text-muted">
                      Namena je završena. Istorijski cilj: {formatRsd(goal.targetAmount)}
                      {goal.usedAt ? ` · ${formatDate(goal.usedAt)}` : ''}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="mt-5 flex items-end justify-between">
                      <div>
                        <p className="money text-xl font-extrabold">
                          {formatRsd(progress.current)}
                        </p>
                        <p className="mt-1 text-xs text-muted">od {formatRsd(goal.targetAmount)}</p>
                      </div>
                      <p className="text-lg font-extrabold text-accent">{progress.percentage}%</p>
                    </div>
                    <Progress className="mt-3 h-2.5" value={progress.percentage} />
                  </>
                )}
                <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-xl bg-surface-2 p-3">
                    <p className="text-xs text-muted">
                      {progress.lifecycle === 'used' ? 'Status' : 'Preostalo'}
                    </p>
                    <p className="money mt-1 font-bold">
                      {progress.lifecycle === 'used'
                        ? 'Iskorišćeno'
                        : formatRsd(progress.remaining)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-surface-2 p-3">
                    <p className="text-xs text-muted">Rok</p>
                    <p className="mt-1 font-bold">
                      {goal.targetDate ? formatDate(goal.targetDate) : 'Bez roka'}
                    </p>
                  </div>
                </div>
                {progress.lifecycle !== 'used' ? (
                  <div className="mt-3 rounded-xl bg-surface-2 p-3 text-sm">
                    <p className="text-xs text-muted">Plan doprinosa ovog meseca</p>
                    <div className="mt-1 flex flex-wrap justify-between gap-2">
                      <span>Plan {formatRsd(contribution.configuredPlan)}</span>
                      <span>Stvarno {formatRsd(contribution.actualContribution)}</span>
                      <strong>
                        Preostalo {formatRsd(contribution.effectiveRemainingContribution)}
                      </strong>
                    </div>
                  </div>
                ) : null}
                {progress.recommendedMonthlyContribution ? (
                  <div className="mt-3 flex items-start gap-2 rounded-xl bg-accent-soft p-3 text-sm">
                    <TrendingUp size={17} className="mt-0.5 shrink-0 text-accent" />
                    <p>
                      Potrebno još približno{' '}
                      <strong>{formatRsd(progress.recommendedMonthlyContribution)} mesečno</strong>{' '}
                      da bi cilj bio dostignut na vreme.
                    </p>
                  </div>
                ) : null}
                {goal.targetDate && goal.targetDate < todayIso() && progress.targetShortfall > 0 ? (
                  <p className="mt-3 rounded-xl bg-warning-soft p-3 text-sm text-warning">
                    Rok je prošao. Manjak cilja je {formatRsd(progress.targetShortfall)}; plan nije
                    automatski povećan.
                  </p>
                ) : null}
                {progress.lifecycle !== 'used' ? (
                  <Button className="mt-4 w-full" onClick={() => openContribution(goal)}>
                    Prebaci u štednju
                  </Button>
                ) : null}
              </Card>
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
        onOpenChange={(open) => !open && setContributing(null)}
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
