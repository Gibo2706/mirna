import { useMemo, useRef, useState } from 'react';
import type { CommitmentOccurrence, FinanceSnapshot } from '@/domain/types';
import { calculateAccountBalances } from '@/domain/calculations';
import { findCommitmentPaymentCandidates } from '@/domain/payments';
import { linkTransactionToCommitment, markCommitmentPaid } from '@/db/commands';
import { formatDate, todayIso } from '@/lib/dates';
import { formatRsd, parseIntegerInput } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { AccountPicker } from '@/features/transactions/AccountPicker';
import { ProtectedSpendingPreview } from '@/features/transactions/ProtectedSpendingPreview';
import { getProtectedSpendingImpacts } from '@/features/transactions/protectedSpending';

const PaymentForm = ({
  occurrence,
  snapshot,
  onPaid,
  onBusy,
}: {
  occurrence: CommitmentOccurrence;
  snapshot: FinanceSnapshot;
  onPaid: () => void;
  onBusy: (value: boolean) => void;
}) => {
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [amount, setAmount] = useState(occurrence.amount);
  const [date, setDate] = useState(todayIso());
  const [accountId, setAccountId] = useState(occurrence.accountId);
  const [funding, setFunding] = useState(false);
  const [fundingAccountId, setFundingAccountId] = useState('');
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [transactionId, setTransactionId] = useState('');
  const [confirmMismatch, setConfirmMismatch] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const balances = useMemo(
    () => calculateAccountBalances(snapshot.accounts, snapshot.transactions),
    [snapshot.accounts, snapshot.transactions],
  );
  const candidates = findCommitmentPaymentCandidates(occurrence, snapshot.transactions).filter(
    (t) =>
      !search ||
      `${t.description} ${t.notes ?? ''} ${t.amount}`
        .toLocaleLowerCase('sr')
        .includes(search.toLocaleLowerCase('sr')),
  );
  const selected = candidates.find((t) => t.id === transactionId);
  const mismatch = Boolean(selected && selected.amount !== occurrence.amount);
  const protectedAccounts = snapshot.accounts.filter((a) => a.protected && !a.archived);
  const paymentAccounts = snapshot.accounts.filter(
    (a) => !a.archived && (!funding || !a.protected),
  );
  const impacts = getProtectedSpendingImpacts(
    snapshot,
    funding
      ? { type: 'transfer', accountId: fundingAccountId, toAccountId: accountId, amount }
      : { type: 'expense', accountId, amount },
  );
  const insufficient = funding
    ? (balances[fundingAccountId] ?? 0) < amount
    : (balances[accountId] ?? 0) < amount;
  const valid =
    mode === 'existing'
      ? selected && (!mismatch || confirmMismatch)
      : amount > 0 &&
        Number.isSafeInteger(amount) &&
        date &&
        accountId &&
        (!funding || fundingAccountId) &&
        !insufficient;
  const submit = async () => {
    if (!valid || busy.current) return;
    busy.current = true;
    onBusy(true);
    setSaving(true);
    setError('');
    try {
      if (mode === 'existing')
        await linkTransactionToCommitment({
          occurrenceKey: occurrence.key,
          transactionId,
          confirmAmountMismatch: confirmMismatch,
        });
      else
        await markCommitmentPaid({
          occurrenceKey: occurrence.key,
          name: occurrence.name,
          amount: occurrence.amount,
          date: occurrence.date,
          accountId: occurrence.accountId,
          categoryId: occurrence.categoryId,
          actualAmount: amount,
          paymentDate: date,
          paymentAccountId: accountId,
          fundingAccountId: funding ? fundingAccountId : undefined,
          notes,
        });
      onPaid();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Plaćanje nije sačuvano.');
    } finally {
      busy.current = false;
      onBusy(false);
      setSaving(false);
    }
  };
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={saving} className="contents">
        <dl className="flex flex-wrap justify-between gap-3 border-b pb-4 text-sm">
          <div>
            <dt className="text-muted">Planirano</dt>
            <dd className="money mt-1 font-bold">{formatRsd(occurrence.amount)}</dd>
          </div>
          <div>
            <dt className="text-muted">Dospeće</dt>
            <dd className="mt-1 font-semibold">{formatDate(occurrence.date)}</dd>
          </div>
        </dl>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Način evidentiranja">
          <Button
            variant={mode === 'new' ? 'primary' : 'outline'}
            aria-pressed={mode === 'new'}
            onClick={() => setMode('new')}
            disabled={saving}
          >
            Novo plaćanje
          </Button>
          <Button
            variant={mode === 'existing' ? 'primary' : 'outline'}
            aria-pressed={mode === 'existing'}
            onClick={() => setMode('existing')}
            disabled={saving}
          >
            Već sam ovo platio
          </Button>
        </div>
        {mode === 'new' ? (
          <>
            <Field label="Stvarni iznos (RSD)">
              <Input
                inputMode="numeric"
                value={amount || ''}
                onChange={(e) => setAmount(parseIntegerInput(e.target.value))}
              />
            </Field>
            <Field label="Datum plaćanja">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Račun plaćanja">
              <AccountPicker
                snapshot={snapshot}
                accountIds={paymentAccounts.map((a) => a.id)}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              />
            </Field>
            {protectedAccounts.length ? (
              <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={funding}
                  onChange={(e) => {
                    setFunding(e.target.checked);
                    if (
                      e.target.checked &&
                      snapshot.accounts.find((a) => a.id === accountId)?.protected
                    )
                      setAccountId(
                        snapshot.accounts.find((a) => !a.protected && !a.archived)?.id ?? '',
                      );
                  }}
                />
                Koristi štednju
              </label>
            ) : null}
            {funding ? (
              <>
                <Field label="Iz štednje">
                  <AccountPicker
                    snapshot={snapshot}
                    accountIds={protectedAccounts.map((a) => a.id)}
                    value={fundingAccountId}
                    onChange={(e) => setFundingAccountId(e.target.value)}
                  />
                </Field>
                <p className="text-sm text-muted">
                  Prebacićemo {formatRsd(amount)} na račun plaćanja i evidentirati jedan trošak. Sve
                  se čuva zajedno.
                </p>
              </>
            ) : null}
            <ProtectedSpendingPreview impacts={impacts} />
            {insufficient && (!funding || fundingAccountId) ? (
              <p role="status" className="text-sm text-danger">
                Nema dovoljno sredstava. Izaberite drugi račun ili manji iznos.
              </p>
            ) : null}
            <Field label="Beleška (opciono)">
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <p className="text-sm text-muted">
              Povežite postojeći trošak. Iznos i stanje računa ostaju isti.
            </p>
            <Field label="Pronađi plaćanje">
              <Input
                type="search"
                placeholder="Opis, beleška ili iznos"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setTransactionId('');
                  setConfirmMismatch(false);
                }}
              />
            </Field>
            <div
              className="max-h-64 divide-y overflow-y-auto"
              role="group"
              aria-label="Postojeći troškovi"
            >
              {candidates.slice(0, 50).map((t) => (
                <label
                  key={t.id}
                  className="flex min-h-14 cursor-pointer items-start gap-3 py-3 text-sm"
                >
                  <input
                    type="radio"
                    name="existing-payment"
                    value={t.id}
                    checked={transactionId === t.id}
                    onChange={() => {
                      setTransactionId(t.id);
                      setConfirmMismatch(false);
                    }}
                    className="mt-1"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{t.description}</span>
                    <span className="block text-xs text-muted">
                      {formatDate(t.date)} ·{' '}
                      {snapshot.accounts.find((a) => a.id === t.accountId)?.name}
                    </span>
                  </span>
                  <span className="money shrink-0 font-semibold">{formatRsd(t.amount)}</span>
                </label>
              ))}
            </div>
            {!candidates.length ? (
              <p role="status" className="text-sm text-muted">
                Nema nepovezanih troškova za ovu pretragu.
              </p>
            ) : null}
            {mismatch ? (
              <label className="flex min-h-11 items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={confirmMismatch}
                  onChange={(e) => setConfirmMismatch(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  Potvrđujem razliku: planirano {formatRsd(occurrence.amount)}, plaćeno{' '}
                  {formatRsd(selected!.amount)}. Plan ostaje isti.
                </span>
              </label>
            ) : null}
          </>
        )}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </fieldset>
      <div className="sheet-actions">
        <Button type="submit" size="lg" disabled={!valid || saving}>
          {saving ? 'Čuvam…' : mode === 'existing' ? 'Poveži plaćanje' : 'Potvrdi plaćanje'}
        </Button>
      </div>
    </form>
  );
};

export const CommitmentPaymentSheet = ({
  occurrence,
  snapshot,
  open,
  onOpenChange,
  onPaid,
}: {
  occurrence: CommitmentOccurrence | null;
  snapshot: FinanceSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaid: () => void;
}) => {
  const busy = useRef(false);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!busy.current) onOpenChange(next);
      }}
      title={`Plaćanje — ${occurrence?.name ?? 'obaveza'}`}
      description="Zabeležite stvarno plaćanje ili povežite već unet trošak."
    >
      {occurrence && open ? (
        <PaymentForm
          key={occurrence.key}
          occurrence={occurrence}
          snapshot={snapshot}
          onBusy={(value) => {
            busy.current = value;
          }}
          onPaid={() => {
            onPaid();
            onOpenChange(false);
          }}
        />
      ) : null}
    </Sheet>
  );
};
