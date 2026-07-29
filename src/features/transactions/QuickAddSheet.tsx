import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowRightLeft, ArrowUpRight, Check, WalletCards } from 'lucide-react';
import type { FinanceSnapshot, QuickAddPreset, TransactionType } from '@/domain/types';
import { saveTransaction } from '@/db/commands';
import { createId } from '@/lib/id';
import { formatDate, todayIso } from '@/lib/dates';
import { formatRsd, parseIntegerInput } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { useToast } from '@/components/ToastProvider';

type EntryType = Extract<TransactionType, 'income' | 'expense' | 'transfer'>;

export const QuickAddSheet = ({
  open,
  onOpenChange,
  snapshot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: FinanceSnapshot;
}) => {
  const { success } = useToast();
  const [preset, setPreset] = useState<QuickAddPreset | null>(null);
  const [type, setType] = useState<EntryType>('expense');
  const [amount, setAmount] = useState(0);
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);

  const accounts = snapshot.accounts.filter((account) => !account.archived);
  const categories = snapshot.categories.filter(
    (category) => !category.archived && category.kind === type,
  );
  const presets = [...snapshot.presets]
    .filter((item) => item.active)
    .sort((left, right) => left.position - right.position);

  const reset = () => {
    setPreset(null);
    setType('expense');
    setAmount(0);
    setAccountId(snapshot.settingsRecord.defaultAccountId ?? accounts[0]?.id ?? '');
    setToAccountId('');
    setCategoryId('');
    setDate(todayIso());
    setDescription('');
    setNotes('');
    setSaving(false);
    setConfirmOpen(false);
    setError('');
    savingRef.current = false;
  };

  useEffect(() => {
    if (open) reset();
    // Reset must run only as the sheet opens; snapshot reactivity must not erase form input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choosePreset = (item: QuickAddPreset) => {
    setPreset(item);
    setType(item.type);
    setAmount(item.amount ?? 0);
    setAccountId(
      item.defaultAccountId ?? snapshot.settingsRecord.defaultAccountId ?? accounts[0]?.id ?? '',
    );
    setCategoryId(item.categoryId ?? '');
    setDescription(item.name === 'Drugo' ? '' : item.name);
    setError('');
  };

  const valid = useMemo(() => {
    if (amount <= 0 || !Number.isSafeInteger(amount) || !accountId || !date || !description.trim())
      return false;
    if (type === 'transfer') return Boolean(toAccountId && toAccountId !== accountId);
    return Boolean(categoryId);
  }, [accountId, amount, categoryId, date, description, toAccountId, type]);

  const requestConfirmation = () => {
    if (!valid) {
      setError('Popunite iznos, račun, opis i odgovarajuću kategoriju.');
      return;
    }
    setError('');
    setConfirmOpen(true);
  };

  const saveConfirmedTransaction = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      await saveTransaction({
        id: createId('tx'),
        type,
        amount,
        accountId,
        toAccountId: type === 'transfer' ? toAccountId : undefined,
        categoryId: type === 'transfer' ? undefined : categoryId,
        date,
        description: description.trim(),
        notes: notes.trim() || undefined,
        source: preset ? 'quick-add' : 'manual',
        createdAt: new Date().toISOString(),
      });
      success(type === 'transfer' ? 'Transfer je sačuvan.' : 'Transakcija je sačuvana.');
      setConfirmOpen(false);
      onOpenChange(false);
      reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Transakcija nije sačuvana.');
      setConfirmOpen(false);
      setSaving(false);
      savingRef.current = false;
    }
  };

  const accountName =
    accounts.find((account) => account.id === accountId)?.name ?? 'izabrani račun';
  const destinationName =
    accounts.find((account) => account.id === toAccountId)?.name ?? 'izabrani račun';
  const transactionLabel =
    type === 'expense' ? 'trošak' : type === 'income' ? 'prihod' : 'transfer';
  const confirmationDate = date ? formatDate(date) : 'izabrani datum';
  const confirmationDescription =
    type === 'transfer'
      ? `Prebaciti ${formatRsd(amount)} sa računa „${accountName}” na „${destinationName}” dana ${confirmationDate}?`
      : `Sačuvati ${transactionLabel} „${description.trim()}” od ${formatRsd(amount)} na računu „${accountName}” dana ${confirmationDate}?`;

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(nextOpen) => {
          if (!savingRef.current) onOpenChange(nextOpen);
        }}
        title={preset ? preset.name : 'Brzi unos'}
        description={
          preset
            ? 'Proverite detalje i sačuvajte.'
            : 'Izaberite preset, proverite podatke i potvrdite unos.'
        }
      >
        {!preset ? (
          <>
            {accounts.length === 0 ? (
              <div className="rounded-2xl bg-warning-soft p-4 text-sm text-warning">
                Najpre dodajte račun u sekciji Više → Računi.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {presets.map((item) => (
                  <button
                    key={item.id}
                    className="min-h-28 rounded-2xl border bg-surface p-4 text-left transition hover:border-accent active:scale-[0.98]"
                    onClick={() => choosePreset(item)}
                  >
                    <span className="text-2xl">{item.emoji}</span>
                    <span className="mt-3 block text-sm font-bold">{item.name}</span>
                    <span className="mt-0.5 block text-xs text-muted">
                      {item.amount ? formatRsd(item.amount) : 'Unesite iznos'}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <Button
              variant="outline"
              className="mt-4 w-full"
              onClick={() =>
                setPreset({
                  id: 'manual',
                  name: 'Druga transakcija',
                  emoji: '•',
                  type: 'expense',
                  position: 99,
                  active: true,
                })
              }
            >
              Druga transakcija
            </Button>
          </>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              requestConfirmation();
            }}
          >
            <div className="grid grid-cols-3 gap-2 rounded-2xl bg-surface-2 p-1">
              {(
                [
                  ['expense', 'Trošak', ArrowUpRight],
                  ['income', 'Prihod', ArrowDownLeft],
                  ['transfer', 'Transfer', ArrowRightLeft],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl text-xs font-bold transition ${type === value ? 'bg-surface shadow-sm' : 'text-muted'}`}
                  onClick={() => {
                    setType(value);
                    setCategoryId('');
                  }}
                >
                  <Icon size={16} /> {label}
                </button>
              ))}
            </div>
            <Field label="Iznos (ceo broj RSD)">
              <Input
                autoFocus={!preset.amount}
                className="money h-16 text-2xl font-extrabold"
                inputMode="numeric"
                value={amount || ''}
                onChange={(event) => setAmount(parseIntegerInput(event.target.value))}
                placeholder="0"
              />
            </Field>
            <Field label={type === 'transfer' ? 'Sa računa' : 'Račun'}>
              <Select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                <option value="">Izaberite račun</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </Select>
            </Field>
            {type === 'transfer' ? (
              <>
                <Field label="Na račun" hint="Transfer se ne računa kao prihod ili trošak.">
                  <Select
                    value={toAccountId}
                    onChange={(event) => setToAccountId(event.target.value)}
                  >
                    <option value="">Izaberite ciljni račun</option>
                    {accounts
                      .filter((account) => account.id !== accountId)
                      .map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                  </Select>
                </Field>
              </>
            ) : (
              <Field label="Kategorija">
                <Select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                  <option value="">Izaberite kategoriju</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.icon} {category.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Opis">
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Na šta se odnosi?"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Datum">
                <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </Field>
              <Field label="Beleška (opciono)">
                <Textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Dodatni kontekst"
                />
              </Field>
            </div>
            {error ? (
              <p
                role="alert"
                className="rounded-xl bg-danger-soft p-3 text-sm font-medium text-danger"
              >
                {error}
              </p>
            ) : null}
            <Button type="submit" size="lg" className="mt-1 w-full" disabled={!valid || saving}>
              {saving ? (
                'Čuvam…'
              ) : (
                <>
                  <Check size={19} /> Sačuvaj {amount > 0 ? formatRsd(amount) : ''}
                </>
              )}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPreset(null)}>
              <WalletCards size={18} /> Nazad na presete
            </Button>
          </form>
        )}
      </Sheet>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(nextOpen) => {
          if (!savingRef.current) setConfirmOpen(nextOpen);
        }}
        title={`Potvrditi ${transactionLabel}?`}
        description={confirmationDescription}
        confirmLabel="Potvrdi i sačuvaj"
        onConfirm={saveConfirmedTransaction}
        pending={saving}
        closeOnConfirm={false}
      />
    </>
  );
};
