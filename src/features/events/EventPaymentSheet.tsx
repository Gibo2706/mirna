import { useEffect, useMemo, useRef, useState } from 'react';
import type { FinanceSnapshot, PlannedEvent } from '@/domain/types';
import { calculateAccountBalances } from '@/domain/calculations';
import { markPlannedEventPaid } from '@/db/commands';
import { formatDate } from '@/lib/dates';
import { formatRsd } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';

export const EventPaymentSheet = ({
  event,
  snapshot,
  open,
  onOpenChange,
  onPaid,
}: {
  event: PlannedEvent | null;
  snapshot: FinanceSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaid: () => void;
}) => {
  const balances = useMemo(
    () => calculateAccountBalances(snapshot.accounts, snapshot.transactions),
    [snapshot.accounts, snapshot.transactions],
  );
  const activeAccounts = useMemo(
    () => snapshot.accounts.filter((account) => !account.archived),
    [snapshot.accounts],
  );
  const spendableAccounts = useMemo(
    () => activeAccounts.filter((account) => !account.protected),
    [activeAccounts],
  );
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const [topUpFromAccountId, setTopUpFromAccountId] = useState('');
  const [changingAccount, setChangingAccount] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);

  useEffect(() => {
    if (!open || !event) return;
    const defaultSpendable =
      spendableAccounts.find(
        (account) => account.id === snapshot.settingsRecord.defaultAccountId,
      ) ?? spendableAccounts[0];
    setPaymentAccountId(event.accountId);
    setTopUpFromAccountId(defaultSpendable?.id ?? '');
    setChangingAccount(false);
    setSaving(false);
    setError('');
    savingRef.current = false;
  }, [event, open, snapshot.settingsRecord.defaultAccountId, spendableAccounts]);

  if (!event) return null;

  const paymentAccount = activeAccounts.find((account) => account.id === paymentAccountId);
  const available = paymentAccount ? Math.max(0, balances[paymentAccount.id] ?? 0) : 0;
  const shortfall = Math.max(0, event.plannedAmount - available);
  const needsTopUp = Boolean(paymentAccount?.protected && shortfall > 0);
  const canPay =
    Boolean(paymentAccount) && (shortfall === 0 || (needsTopUp && Boolean(topUpFromAccountId)));
  const sourceAccount = spendableAccounts.find((account) => account.id === topUpFromAccountId);

  const pay = async () => {
    if (!paymentAccount || !canPay || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      await markPlannedEventPaid({
        eventId: event.id,
        paymentAccountId: paymentAccount.id,
        topUpFromAccountId: needsTopUp ? topUpFromAccountId : undefined,
      });
      onPaid();
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Događaj nije evidentiran.');
      setSaving(false);
      savingRef.current = false;
    }
  };

  const primaryLabel = needsTopUp
    ? `Dopuni iz ${sourceAccount?.name ?? 'izabranog računa'} i plati`
    : `Plati sa ${paymentAccount?.name ?? 'izabranog računa'}`;

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!savingRef.current) onOpenChange(nextOpen);
      }}
      title={`Platiti „${event.title}”?`}
      description={`${formatDate(event.date)} · ${formatRsd(event.plannedAmount)}`}
    >
      <div className="grid gap-4">
        {changingAccount ? (
          <Field label="Račun plaćanja" hint="Promena je eksplicitna i čuva se na događaju.">
            <Select
              value={paymentAccountId}
              onChange={(changeEvent) => {
                setPaymentAccountId(changeEvent.target.value);
                setError('');
              }}
            >
              {activeAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                  {account.protected ? ' · zaštićen' : ''}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <div className={`rounded-2xl p-4 ${shortfall > 0 ? 'bg-warning-soft' : 'bg-accent-soft'}`}>
          <p className="text-sm font-bold">
            Na računu {paymentAccount?.name ?? '—'} imaš {formatRsd(available)}.
          </p>
          {shortfall > 0 ? (
            <p className="mt-2 text-sm text-warning">
              Za ovaj događaj nedostaje {formatRsd(shortfall)}.
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted">
              Račun ima dovoljno sredstava za pun iznos događaja.
            </p>
          )}
        </div>

        {needsTopUp ? (
          <Field
            label="Dopuni sa raspoloživog računa"
            hint={`Biće kreiran transfer od ${formatRsd(shortfall)}, pa puni rashod sa zaštićenog računa — atomski.`}
          >
            <Select
              value={topUpFromAccountId}
              onChange={(changeEvent) => {
                setTopUpFromAccountId(changeEvent.target.value);
                setError('');
              }}
            >
              <option value="">Izaberite račun</option>
              {spendableAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} · {formatRsd(Math.max(0, balances[account.id] ?? 0))}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {shortfall > 0 && !paymentAccount?.protected ? (
          <p className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
            Raspoloživi račun nema dovoljno sredstava. Izaberite drugi račun ili otkažite.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <Button
          size="lg"
          className="w-full"
          disabled={!canPay || saving}
          onClick={() => void pay()}
        >
          {saving ? 'Knjižim…' : primaryLabel}
        </Button>
        <Button
          variant="outline"
          className="w-full"
          disabled={saving}
          onClick={() => {
            setChangingAccount((value) => !value);
            setError('');
          }}
        >
          {changingAccount ? 'Zadrži izabrani račun' : 'Promeni račun'}
        </Button>
        <Button variant="ghost" className="w-full" onClick={() => onOpenChange(false)}>
          Otkaži
        </Button>
      </div>
    </Sheet>
  );
};
