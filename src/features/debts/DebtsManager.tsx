import { useRef, useState } from 'react';
import { addMonths, format, parseISO } from 'date-fns';
import { CircleDollarSign, Edit3, Plus, Trash2 } from 'lucide-react';
import type { Debt, FinanceSnapshot } from '@/domain/types';
import { calculateDebtProgress, getDebtStateAtMonth } from '@/domain/calculations';
import { deleteDebt, recordDebtPayment, saveDebt } from '@/db/commands';
import { createId } from '@/lib/id';
import { currentMonthKey, formatMonth, todayIso } from '@/lib/dates';
import { formatRsd, parseIntegerInput } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Progress } from '@/components/ui/Progress';
import { Sheet } from '@/components/ui/Sheet';
import { SettingsLayout } from '@/components/SettingsLayout';
import { useToast } from '@/components/ToastProvider';

const newDebt = (): Debt => ({
  id: createId('debt'),
  creditor: '',
  originalAmount: 0,
  priority: 'medium',
  status: 'open',
  paymentOverrides: {},
  createdAt: new Date().toISOString(),
});

export const DebtsManager = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const { success } = useToast();
  const [editing, setEditing] = useState<Debt | null>(null);
  const [repaying, setRepaying] = useState<Debt | null>(null);
  const [deleting, setDeleting] = useState<Debt | null>(null);
  const [amount, setAmount] = useState(0);
  const [accountId, setAccountId] = useState(snapshot.settingsRecord.defaultAccountId ?? '');
  const [date, setDate] = useState(todayIso());
  const [notes, setNotes] = useState('');
  const [paymentSource, setPaymentSource] = useState<'self' | 'external'>('self');
  const [error, setError] = useState('');
  const [repaymentSaving, setRepaymentSaving] = useState(false);
  const repaymentSavingRef = useRef(false);
  const debtCategoryId =
    snapshot.categories.find((category) => category.id === 'cat_debt')?.id ??
    snapshot.categories.find((category) => category.kind === 'expense')?.id ??
    '';
  const paymentMonths = Array.from({ length: 6 }, (_, offset) =>
    format(addMonths(parseISO(`${currentMonthKey()}-01`), offset), 'yyyy-MM'),
  );

  return (
    <SettingsLayout
      title="Dugovi"
      description="Lična uplata zajedno čuva stvarni trošak i povezanu istoriju otplate."
      action={
        <Button size="icon" onClick={() => setEditing(newDebt())} aria-label="Novi dug">
          <Plus />
        </Button>
      }
    >
      {error && !editing && !repaying ? (
        <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {snapshot.debts.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {snapshot.debts.map((debt) => {
            const progress = calculateDebtProgress(debt, snapshot.debtPayments);
            const currentMonth = currentMonthKey();
            const paymentState = getDebtStateAtMonth(debt, currentMonth, snapshot.debtPayments);
            return (
              <Card key={debt.id}>
                <div className="flex items-start gap-3">
                  <span className="grid size-11 place-items-center rounded-2xl bg-danger-soft text-danger">
                    <CircleDollarSign size={20} />
                  </span>
                  <div className="flex-1">
                    <h2 className="font-bold">{debt.creditor}</h2>
                    <p className="text-xs text-muted">
                      Prioritet:{' '}
                      {debt.priority === 'high'
                        ? 'visok'
                        : debt.priority === 'low'
                          ? 'nizak'
                          : 'srednji'}{' '}
                      · {debt.status === 'paid' ? 'otplaćen' : 'aktivan'}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setEditing(debt)}
                    aria-label={`Izmeni dug prema ${debt.creditor}`}
                  >
                    <Edit3 size={17} />
                  </Button>
                </div>
                <div className="mt-4 flex items-end justify-between">
                  <div>
                    <p className="text-xs text-muted">Preostalo</p>
                    <p className="money mt-1 text-xl font-extrabold">
                      {formatRsd(progress.remaining)}
                    </p>
                  </div>
                  <p className="text-sm font-bold text-accent">{progress.percentage}% otplaćeno</p>
                </div>
                <Progress className="mt-3" value={progress.percentage} />
                <p className="mt-2 text-xs text-muted">
                  Originalno {formatRsd(debt.originalAmount)}
                </p>
                <div className="mt-3 rounded-xl bg-surface-2 p-3 text-xs">
                  Plan ovog meseca {formatRsd(paymentState.planned)} · stvarno{' '}
                  {formatRsd(paymentState.actual)} · preostalo{' '}
                  <strong>{formatRsd(paymentState.remainingPlan)}</strong>
                </div>
                {progress.remaining > 0 ? (
                  <Button
                    className="mt-4 w-full"
                    variant="secondary"
                    onClick={() => {
                      setRepaying(debt);
                      setPaymentSource('self');
                      setAmount(0);
                      setDate(todayIso());
                      setNotes('');
                      setError('');
                      setRepaymentSaving(false);
                      repaymentSavingRef.current = false;
                    }}
                  >
                    Evidentiraj otplatu
                  </Button>
                ) : null}
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={CircleDollarSign}
          title="Nema dugova"
          description="Dodajte dug prema osobi i pratite svaku otplatu."
        />
      )}

      <Sheet
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.creditor ? 'Izmeni dug' : 'Novi dug'}
      >
        {editing ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                setError('');
                try {
                  await saveDebt(editing);
                  setEditing(null);
                  success('Dug je sačuvan.');
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : 'Dug nije sačuvan.');
                }
              })();
            }}
          >
            <Field label="Kome dugujete">
              <Input
                value={editing.creditor}
                onChange={(event) => setEditing({ ...editing, creditor: event.target.value })}
              />
            </Field>
            <Field label="Originalni iznos">
              <Input
                inputMode="numeric"
                disabled={snapshot.debtPayments.some((payment) => payment.debtId === editing.id)}
                value={editing.originalAmount || ''}
                onChange={(event) =>
                  setEditing({ ...editing, originalAmount: parseIntegerInput(event.target.value) })
                }
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Rok (opciono)">
                <Input
                  type="date"
                  value={editing.dueDate ?? ''}
                  onChange={(event) =>
                    setEditing({ ...editing, dueDate: event.target.value || undefined })
                  }
                />
              </Field>
              <Field label="Prioritet">
                <Select
                  value={editing.priority}
                  onChange={(event) =>
                    setEditing({ ...editing, priority: event.target.value as Debt['priority'] })
                  }
                >
                  <option value="low">Nizak</option>
                  <option value="medium">Srednji</option>
                  <option value="high">Visok</option>
                </Select>
              </Field>
              <Field label="Planirana mesečna otplata">
                <Input
                  inputMode="numeric"
                  value={editing.plannedMonthlyPayment ?? ''}
                  onChange={(event) => {
                    const value = parseIntegerInput(event.target.value);
                    setEditing({
                      ...editing,
                      plannedMonthlyPayment: value > 0 ? value : undefined,
                    });
                  }}
                />
              </Field>
              <Field label="Dan plana">
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={editing.paymentDay ?? ''}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      paymentDay: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                />
              </Field>
            </div>
            <div className="rounded-2xl bg-surface-2 p-4">
              <p className="font-bold">Plan otplate — narednih 6 meseci</p>
              <p className="mt-1 text-xs text-muted">
                Prazno koristi podrazumevani plan. Unesite 0 da preskočite mesec.
              </p>
              <div className="mt-4 grid gap-3">
                {paymentMonths.map((month) => (
                  <Field key={month} label={formatMonth(month)}>
                    <Input
                      inputMode="numeric"
                      placeholder={String(editing.plannedMonthlyPayment ?? 0)}
                      value={editing.paymentOverrides[month] ?? ''}
                      onChange={(event) => {
                        const overrides = { ...editing.paymentOverrides };
                        if (event.target.value === '') delete overrides[month];
                        else overrides[month] = parseIntegerInput(event.target.value);
                        setEditing({ ...editing, paymentOverrides: overrides });
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
            <Button
              type="submit"
              size="lg"
              disabled={!editing.creditor || editing.originalAmount <= 0}
            >
              Sačuvaj dug
            </Button>
            {snapshot.debts.some((value) => value.id === editing.id) ? (
              <Button
                type="button"
                variant="ghost"
                className="text-danger"
                onClick={() => {
                  setDeleting(editing);
                  setEditing(null);
                }}
              >
                <Trash2 size={17} /> Obriši dug
              </Button>
            ) : null}
          </form>
        ) : null}
      </Sheet>

      <Sheet
        open={Boolean(repaying)}
        onOpenChange={(open) => !open && setRepaying(null)}
        title={`Otplata — ${repaying?.creditor ?? ''}`}
        description={
          paymentSource === 'self'
            ? 'Lična uplata je stvarni odliv sa računa i ulazi u troškove.'
            : 'Spoljna uplata smanjuje dug bez promene vaših računa i troškova.'
        }
      >
        {repaying ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                if (repaymentSavingRef.current) return;
                repaymentSavingRef.current = true;
                setRepaymentSaving(true);
                try {
                  await recordDebtPayment({
                    debtId: repaying.id,
                    source: paymentSource,
                    accountId: paymentSource === 'self' ? accountId : undefined,
                    categoryId: paymentSource === 'self' ? debtCategoryId : undefined,
                    amount,
                    date,
                    notes: notes || undefined,
                  });
                  setRepaying(null);
                  success('Otplata je evidentirana.');
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : 'Otplata nije sačuvana.');
                  repaymentSavingRef.current = false;
                  setRepaymentSaving(false);
                }
              })();
            }}
          >
            <Field label="Ko je platio">
              <Select
                value={paymentSource}
                onChange={(event) => setPaymentSource(event.target.value as 'self' | 'external')}
              >
                <option value="self">Ja — sa mog računa</option>
                <option value="external">Druga osoba — korekcija duga</option>
              </Select>
            </Field>
            <Field label="Iznos">
              <Input
                autoFocus
                inputMode="numeric"
                className="money h-16 text-2xl font-extrabold"
                value={amount || ''}
                onChange={(event) => setAmount(parseIntegerInput(event.target.value))}
              />
            </Field>
            {paymentSource === 'self' ? (
              <Field label="Račun">
                <Select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                  {snapshot.accounts
                    .filter((account) => !account.archived)
                    .map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                </Select>
              </Field>
            ) : null}
            <Field label="Datum">
              <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </Field>
            <Field label="Beleška">
              <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
            </Field>
            {error ? (
              <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <Button
              type="submit"
              size="lg"
              disabled={
                amount <= 0 ||
                repaymentSaving ||
                (paymentSource === 'self' && (!accountId || !debtCategoryId))
              }
            >
              {repaymentSaving
                ? 'Čuvam…'
                : paymentSource === 'self'
                  ? 'Sačuvaj otplatu'
                  : 'Sačuvaj korekciju duga'}
            </Button>
          </form>
        ) : null}
      </Sheet>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Obrisati dug?"
        description="Dug može biti obrisan samo ako nema istoriju uplata."
        danger
        confirmLabel="Obriši"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await deleteDebt(deleting.id);
          } catch (caught) {
            setDeleting(null);
            setError(caught instanceof Error ? caught.message : 'Dug nije obrisan.');
            return;
          }
          setDeleting(null);
          success('Dug je obrisan.');
        }}
      />
    </SettingsLayout>
  );
};
