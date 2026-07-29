import { useMemo, useState } from 'react';
import { Archive, Edit3, Plus, Scale, Trash2, WalletCards } from 'lucide-react';
import type { Account, FinanceSnapshot } from '@/domain/types';
import { calculateAccountBalances } from '@/domain/calculations';
import { adjustAccountBalance, deleteAccount, saveAccount } from '@/db/commands';
import { createId } from '@/lib/id';
import { todayIso } from '@/lib/dates';
import { formatRsd, parseIntegerInput } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { SettingsLayout } from '@/components/SettingsLayout';
import { useToast } from '@/components/ToastProvider';

const newAccount = (): Account => ({
  id: createId('account'),
  name: '',
  kind: 'checking',
  openingBalance: 0,
  protected: false,
  color: '#2f7d64',
  archived: false,
  createdAt: new Date().toISOString(),
});

export const AccountsManager = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const { success } = useToast();
  const [editing, setEditing] = useState<Account | null>(null);
  const [adjusting, setAdjusting] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [targetBalance, setTargetBalance] = useState(0);
  const [adjustmentNote, setAdjustmentNote] = useState('');
  const [error, setError] = useState('');
  const balances = useMemo(
    () => calculateAccountBalances(snapshot.accounts, snapshot.transactions),
    [snapshot.accounts, snapshot.transactions],
  );

  const submit = async () => {
    if (!editing) return;
    try {
      await saveAccount(editing);
      success('Račun je sačuvan.');
      setEditing(null);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Račun nije sačuvan.');
    }
  };

  return (
    <SettingsLayout
      title="Računi"
      description="Stanje se izvodi iz početnog stanja i cele proverljive istorije transakcija."
      action={
        <Button size="icon" onClick={() => setEditing(newAccount())} aria-label="Novi račun">
          <Plus />
        </Button>
      }
    >
      {snapshot.accounts.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {snapshot.accounts.map((account) => (
            <Card key={account.id} className={account.archived ? 'opacity-60' : ''}>
              <div className="flex items-start gap-3">
                <span
                  className="grid size-11 place-items-center rounded-2xl text-white"
                  style={{ background: account.color }}
                >
                  <WalletCards size={20} />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="break-words font-bold">{account.name}</h2>
                  <p className="mt-0.5 text-xs text-muted">
                    {account.protected
                      ? 'Zaštićena štednja'
                      : account.kind === 'cash'
                        ? 'Keš'
                        : 'Raspoloživ račun'}
                    {account.archived ? ' · arhiviran' : ''}
                  </p>
                  <p className="money mt-3 text-2xl font-extrabold">
                    {formatRsd(balances[account.id] ?? 0)}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Početno stanje {formatRsd(account.openingBalance)}
                  </p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    setEditing(account);
                    setError('');
                  }}
                  aria-label={`Izmeni ${account.name}`}
                >
                  <Edit3 size={18} />
                </Button>
              </div>
              <div className="mt-4 flex gap-2 border-t pt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setAdjusting(account);
                    setTargetBalance(balances[account.id] ?? 0);
                    setAdjustmentNote('');
                    setError('');
                  }}
                >
                  <Scale size={16} /> Uskladi stanje
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-danger"
                  onClick={() => setDeleting(account)}
                >
                  <Trash2 size={16} /> Obriši
                </Button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={WalletCards}
          title="Još nema računa"
          description="Dodajte tekući račun, keš ili namensku štednju."
          action={
            <Button onClick={() => setEditing(newAccount())}>
              <Plus size={18} /> Novi račun
            </Button>
          }
        />
      )}

      <Sheet
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.name ? 'Izmeni račun' : 'Novi račun'}
      >
        {editing ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field label="Naziv">
              <Input
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              />
            </Field>
            <Field label="Vrsta">
              <Select
                value={editing.kind}
                onChange={(event) => {
                  const kind = event.target.value as Account['kind'];
                  setEditing({
                    ...editing,
                    kind,
                    protected: kind === 'savings' ? true : editing.protected,
                  });
                }}
              >
                <option value="checking">Tekući račun</option>
                <option value="cash">Keš</option>
                <option value="savings">Štednja</option>
              </Select>
            </Field>
            <Field
              label="Početno stanje (RSD)"
              hint={
                snapshot.accounts.some((account) => account.id === editing.id)
                  ? 'Za trenutno stanje koristite auditabilno „Uskladi stanje”.'
                  : 'Početno stanje nije prihod.'
              }
            >
              <Input
                inputMode="numeric"
                disabled={snapshot.accounts.some((account) => account.id === editing.id)}
                value={editing.openingBalance}
                onChange={(event) =>
                  setEditing({ ...editing, openingBalance: parseIntegerInput(event.target.value) })
                }
              />
            </Field>
            <Field label="Boja">
              <Input
                type="color"
                className="h-12 p-1"
                value={editing.color}
                onChange={(event) => setEditing({ ...editing, color: event.target.value })}
              />
            </Field>
            <label className="flex min-h-12 items-center gap-3 rounded-xl border bg-surface px-3">
              <input
                type="checkbox"
                checked={editing.protected}
                onChange={(event) => setEditing({ ...editing, protected: event.target.checked })}
              />
              <span>
                <span className="block text-sm font-semibold">
                  Zaštićen od „bezbedno za trošenje”
                </span>
                <span className="block text-xs text-muted">Koristite za štedne račune.</span>
              </span>
            </label>
            <label className="flex min-h-12 items-center gap-3 rounded-xl border bg-surface px-3">
              <input
                type="checkbox"
                checked={editing.archived}
                onChange={(event) => setEditing({ ...editing, archived: event.target.checked })}
              />
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Archive size={16} /> Arhiviran
              </span>
            </label>
            {error ? (
              <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <Button type="submit" size="lg" disabled={!editing.name}>
              Sačuvaj račun
            </Button>
          </form>
        ) : null}
      </Sheet>

      <Sheet
        open={Boolean(adjusting)}
        onOpenChange={(open) => !open && setAdjusting(null)}
        title={`Uskladi — ${adjusting?.name ?? ''}`}
        description="Kreira se posebna transakcija usklađivanja; istorija ostaje vidljiva."
      >
        {adjusting ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                try {
                  await adjustAccountBalance(
                    adjusting.id,
                    targetBalance,
                    todayIso(),
                    adjustmentNote,
                  );
                  setAdjusting(null);
                  success('Stanje je usklađeno auditabilnom transakcijom.');
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : 'Stanje nije usklađeno.');
                }
              })();
            }}
          >
            <Field label="Novo stvarno stanje (RSD)">
              <Input
                autoFocus
                inputMode="numeric"
                className="money h-16 text-2xl font-extrabold"
                value={targetBalance}
                onChange={(event) => setTargetBalance(parseIntegerInput(event.target.value))}
              />
            </Field>
            <Field label="Razlog / beleška">
              <Input
                value={adjustmentNote}
                onChange={(event) => setAdjustmentNote(event.target.value)}
                placeholder="npr. provereno u aplikaciji banke"
              />
            </Field>
            {error ? (
              <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <Button type="submit" size="lg">
              Sačuvaj usklađivanje
            </Button>
          </form>
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Obrisati račun?"
        description="Brisanje je dozvoljeno samo ako račun nema transakcije, ciljeve, obaveze ili događaje. U suprotnom ga arhivirajte."
        danger
        confirmLabel="Obriši"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await deleteAccount(deleting.id);
            success('Račun je obrisan.');
            setDeleting(null);
          } catch (caught) {
            setDeleting(null);
            setError(caught instanceof Error ? caught.message : 'Račun nije obrisan.');
            setEditing({ ...deleting, archived: true });
          }
        }}
      />
    </SettingsLayout>
  );
};
