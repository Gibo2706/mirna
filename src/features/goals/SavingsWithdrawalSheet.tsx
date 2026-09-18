import { useRef, useState } from 'react';
import type { FinanceSnapshot, SavingsGoal } from '@/domain/types';
import { calculateAccountBalances } from '@/domain/calculations';
import { withdrawFromGoal } from '@/db/commands';
import { todayIso } from '@/lib/dates';
import { formatRsd, parseIntegerInput } from '@/lib/format';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { AccountPicker } from '@/features/transactions/AccountPicker';
import { ProtectedSpendingPreview } from '@/features/transactions/ProtectedSpendingPreview';
import { getProtectedSpendingImpacts } from '@/features/transactions/protectedSpending';

export const SavingsWithdrawalSheet = ({
  goal,
  snapshot,
  onClose,
  onSaved,
}: {
  goal: SavingsGoal;
  snapshot: FinanceSnapshot;
  onClose: () => void;
  onSaved: () => void;
}) => {
  const accounts = snapshot.accounts.filter((a) => !a.protected && !a.archived);
  const [toAccountId, setToAccountId] = useState(
    accounts.find((a) => a.id === snapshot.settingsRecord.defaultAccountId)?.id ??
      accounts[0]?.id ??
      '',
  );
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(todayIso());
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const impacts = getProtectedSpendingImpacts(snapshot, {
    type: 'transfer',
    accountId: goal.linkedAccountId,
    toAccountId,
    amount,
  });
  const valid =
    amount > 0 &&
    Number.isSafeInteger(amount) &&
    toAccountId &&
    date &&
    !impacts.some((i) => i.after < 0);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy.current) onClose();
      }}
      title={`Iskoristi sredstva — ${goal.name}`}
      description="Prenesite novac na račun sa kog ćete platiti. Sam prenos nije trošak."
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || busy.current) return;
          busy.current = true;
          setSaving(true);
          setError('');
          void withdrawFromGoal({ goalId: goal.id, toAccountId, amount, date, notes })
            .then(onSaved)
            .catch((e: unknown) => {
              setError(e instanceof Error ? e.message : 'Prenos nije sačuvan.');
              busy.current = false;
              setSaving(false);
            });
        }}
      >
        <p className="text-sm text-muted">
          Ušteđeno{' '}
          <strong className="money text-foreground">
            {formatRsd(
              calculateAccountBalances(snapshot.accounts, snapshot.transactions)[
                goal.linkedAccountId
              ] ?? 0,
            )}
          </strong>{' '}
          · cilj {formatRsd(goal.targetAmount)}
        </p>
        <fieldset disabled={saving} className="contents">
          <Field label="Iznos za korišćenje (RSD)">
            <Input
              autoFocus
              inputMode="numeric"
              value={amount || ''}
              onChange={(e) => setAmount(parseIntegerInput(e.target.value))}
            />
          </Field>
          <Field label="Na raspoloživi račun">
            <AccountPicker
              snapshot={snapshot}
              accountIds={accounts.map((a) => a.id)}
              value={toAccountId}
              onChange={(e) => setToAccountId(e.target.value)}
            />
          </Field>
          <Field label="Datum">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Beleška (opciono)">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <ProtectedSpendingPreview impacts={impacts} />
          {amount > 0 && toAccountId ? (
            <p className="text-sm text-muted">
              Novac će biti prebačen na {accounts.find((a) => a.id === toAccountId)?.name}. Stvarno
              plaćanje beležite odvojeno.
            </p>
          ) : null}
          {!accounts.length ? (
            <p role="alert">Najpre dodajte raspoloživi račun u Više → Računi.</p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </fieldset>
        <div className="sheet-actions">
          <Button type="submit" size="lg" disabled={!valid || saving}>
            {saving
              ? 'Prebacujem…'
              : `Prebaci na račun${amount > 0 ? ` · ${formatRsd(amount)}` : ''}`}
          </Button>
        </div>
      </form>
    </Sheet>
  );
};
