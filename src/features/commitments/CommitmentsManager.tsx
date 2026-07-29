import { useState } from 'react';
import { Edit3, Plus, ReceiptText, Trash2 } from 'lucide-react';
import type { FinanceSnapshot, FixedCommitment } from '@/domain/types';
import { deleteCommitment, saveCommitment } from '@/db/commands';
import { createId } from '@/lib/id';
import { todayIso } from '@/lib/dates';
import { formatRsd, parseIntegerInput } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { SettingsLayout } from '@/components/SettingsLayout';
import { useToast } from '@/components/ToastProvider';

const newCommitment = (accountId = '', categoryId = ''): FixedCommitment => ({
  id: createId('commitment'),
  name: '',
  amount: 0,
  categoryId,
  accountId,
  frequency: 'monthly',
  startDate: todayIso(),
  dueDay: new Date().getDate(),
  active: true,
  createdAt: new Date().toISOString(),
});

export const CommitmentsManager = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const { success } = useToast();
  const [editing, setEditing] = useState<FixedCommitment | null>(null);
  const [deleting, setDeleting] = useState<FixedCommitment | null>(null);
  const [error, setError] = useState('');
  const expenseCategories = snapshot.categories.filter(
    (value) => value.kind === 'expense' && !value.archived,
  );

  const submit = async () => {
    if (!editing) return;
    try {
      await saveCommitment(editing);
      setEditing(null);
      success('Obaveza je sačuvana.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Obaveza nije sačuvana.');
    }
  };

  return (
    <SettingsLayout
      title="Fiksne obaveze"
      description="Obaveze stvaraju očekivane stavke. Stvarni trošak nastaje tek kada označite plaćanje."
      action={
        <Button
          size="icon"
          onClick={() =>
            setEditing(
              newCommitment(snapshot.settingsRecord.defaultAccountId, expenseCategories[0]?.id),
            )
          }
          aria-label="Nova fiksna obaveza"
        >
          <Plus />
        </Button>
      }
    >
      {snapshot.commitments.length ? (
        <Card className="divide-y p-0">
          {snapshot.commitments.map((commitment) => (
            <div
              key={commitment.id}
              className={`flex items-start gap-3 p-4 ${!commitment.active ? 'opacity-55' : ''}`}
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
                <ReceiptText size={19} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 break-words text-sm font-bold">{commitment.name}</p>
                <p className="mt-1 break-words text-xs leading-5 text-muted">
                  {commitment.frequency === 'monthly'
                    ? `Mesečno · dan ${commitment.dueDay}`
                    : commitment.frequency === 'weekly'
                      ? 'Nedeljno'
                      : 'Godišnje'}
                  {commitment.endDate ? ` · do ${commitment.endDate}` : ''}
                </p>
              </div>
              <p className="money shrink-0 whitespace-nowrap text-sm font-extrabold">
                {formatRsd(commitment.amount)}
              </p>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  setEditing(commitment);
                  setError('');
                }}
                aria-label={`Izmeni ${commitment.name}`}
              >
                <Edit3 size={17} />
              </Button>
            </div>
          ))}
        </Card>
      ) : (
        <EmptyState
          icon={ReceiptText}
          title="Nema fiksnih obaveza"
          description="Dodajte poznate račune i rate; nijedna stvarna transakcija neće biti kreirana unapred."
        />
      )}

      <Sheet
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.name ? 'Izmeni obavezu' : 'Nova obaveza'}
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
            <Field label="Iznos (RSD)">
              <Input
                inputMode="numeric"
                value={editing.amount || ''}
                onChange={(event) =>
                  setEditing({ ...editing, amount: parseIntegerInput(event.target.value) })
                }
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Kategorija">
                <Select
                  value={editing.categoryId}
                  onChange={(event) => setEditing({ ...editing, categoryId: event.target.value })}
                >
                  <option value="">Izaberite</option>
                  {expenseCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.icon} {category.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Račun za plaćanje">
                <Select
                  value={editing.accountId}
                  onChange={(event) => setEditing({ ...editing, accountId: event.target.value })}
                >
                  <option value="">Izaberite</option>
                  {snapshot.accounts
                    .filter((account) => !account.archived)
                    .map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Učestalost">
                <Select
                  value={editing.frequency}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      frequency: event.target.value as FixedCommitment['frequency'],
                    })
                  }
                >
                  <option value="monthly">Mesečno</option>
                  <option value="weekly">Nedeljno</option>
                  <option value="yearly">Godišnje</option>
                </Select>
              </Field>
              <Field label="Dan dospeća">
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={editing.dueDay}
                  onChange={(event) =>
                    setEditing({ ...editing, dueDay: Number(event.target.value) })
                  }
                />
              </Field>
              <Field label="Početak">
                <Input
                  type="date"
                  value={editing.startDate}
                  onChange={(event) => setEditing({ ...editing, startDate: event.target.value })}
                />
              </Field>
              <Field label="Kraj (opciono)">
                <Input
                  type="date"
                  value={editing.endDate ?? ''}
                  onChange={(event) =>
                    setEditing({ ...editing, endDate: event.target.value || undefined })
                  }
                />
              </Field>
            </div>
            <Field label="Beleške">
              <Textarea
                value={editing.notes ?? ''}
                onChange={(event) => setEditing({ ...editing, notes: event.target.value })}
              />
            </Field>
            <label className="flex min-h-12 items-center gap-3 rounded-xl border px-3">
              <input
                type="checkbox"
                checked={editing.active}
                onChange={(event) => setEditing({ ...editing, active: event.target.checked })}
              />
              <span className="text-sm font-semibold">Aktivna obaveza</span>
            </label>
            {error ? (
              <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <Button
              type="submit"
              size="lg"
              disabled={
                !editing.name || editing.amount <= 0 || !editing.categoryId || !editing.accountId
              }
            >
              Sačuvaj obavezu
            </Button>
            {snapshot.commitments.some((value) => value.id === editing.id) ? (
              <Button
                type="button"
                variant="ghost"
                className="text-danger"
                onClick={() => {
                  setDeleting(editing);
                  setEditing(null);
                }}
              >
                <Trash2 size={17} /> Obriši plan obaveze
              </Button>
            ) : null}
          </form>
        ) : null}
      </Sheet>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Obrisati plan obaveze?"
        description="Već kreirane stvarne transakcije ostaju u istoriji. Buduće očekivane stavke više neće nastajati."
        danger
        confirmLabel="Obriši"
        onConfirm={async () => {
          if (!deleting) return;
          await deleteCommitment(deleting.id);
          setDeleting(null);
          success('Plan obaveze je obrisan.');
        }}
      />
    </SettingsLayout>
  );
};
