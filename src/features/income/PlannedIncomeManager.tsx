import { useState } from 'react';
import { BanknoteArrowDown, Edit3, Plus, Trash2 } from 'lucide-react';
import type { FinanceSnapshot, PlannedIncome } from '@/domain/types';
import { deletePlannedIncome, savePlannedIncome } from '@/db/commands';
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

const newPlannedIncome = (
  accountId: string,
  categoryId: string,
  hasPrimarySalary: boolean,
): PlannedIncome => ({
  id: createId('income'),
  name: hasPrimarySalary ? '' : 'Plata',
  amount: 0,
  categoryId,
  accountId,
  frequency: 'monthly',
  startDate: `${todayIso().slice(0, 7)}-01`,
  expectedDay: 5,
  active: true,
  isPrimarySalary: !hasPrimarySalary,
  createdAt: new Date().toISOString(),
});

export const PlannedIncomeManager = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const { success } = useToast();
  const [editing, setEditing] = useState<PlannedIncome | null>(null);
  const [deleting, setDeleting] = useState<PlannedIncome | null>(null);
  const [error, setError] = useState('');
  const incomeCategories = snapshot.categories.filter(
    (category) => category.kind === 'income' && !category.archived,
  );
  const accounts = snapshot.accounts.filter((account) => !account.archived);
  const values = [...snapshot.plannedIncomes].sort(
    (left, right) => Number(right.isPrimarySalary) - Number(left.isPrimarySalary),
  );

  const openNew = () => {
    setError('');
    setEditing(
      newPlannedIncome(
        snapshot.settingsRecord.defaultAccountId ?? accounts[0]?.id ?? '',
        incomeCategories[0]?.id ?? '',
        values.some((value) => value.isPrimarySalary),
      ),
    );
  };

  return (
    <SettingsLayout
      title="Planirani prihodi"
      description="Stvarni plan plate i drugih ponavljajućih prihoda. Scenariji plate ostaju samo pretpostavke prognoze."
      action={
        <Button size="icon" onClick={openNew} aria-label="Novi planirani prihod">
          <Plus />
        </Button>
      }
    >
      {values.length ? (
        <Card className="divide-y p-0">
          {values.map((plannedIncome) => (
            <div key={plannedIncome.id} className="flex items-center gap-3 p-4">
              <span className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent">
                <BanknoteArrowDown size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-bold">
                  {plannedIncome.name}
                  {plannedIncome.isPrimarySalary ? (
                    <span className="ml-2 rounded-full bg-surface-2 px-2 py-1 text-[0.65rem] text-muted">
                      primarna plata
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-muted">
                  {formatRsd(plannedIncome.amount)} ·{' '}
                  {plannedIncome.frequency === 'monthly'
                    ? `mesečno${plannedIncome.expectedDay ? `, očekivano ${plannedIncome.expectedDay}. dana` : ''}`
                    : plannedIncome.frequency === 'weekly'
                      ? 'nedeljno'
                      : 'godišnje'}
                  {!plannedIncome.active ? ' · pauzirano' : ''}
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  setError('');
                  setEditing(plannedIncome);
                }}
                aria-label={`Izmeni ${plannedIncome.name}`}
              >
                <Edit3 size={17} />
              </Button>
            </div>
          ))}
        </Card>
      ) : (
        <EmptyState
          icon={BanknoteArrowDown}
          title="Nema planiranih prihoda"
          description="Dodajte platu ili drugi redovan prihod da bi plan i prognoza bili tačni."
          action={<Button onClick={openNew}>Dodaj prihod</Button>}
        />
      )}

      <Sheet
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.name ? 'Izmeni planirani prihod' : 'Novi planirani prihod'}
        description="Evidentiranje primitka kasnije kreira jednu stvarnu prihodnu transakciju."
      >
        {editing ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                setError('');
                try {
                  await savePlannedIncome(editing);
                  setEditing(null);
                  success('Planirani prihod je sačuvan.');
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : 'Prihod nije sačuvan.');
                }
              })();
            }}
          >
            <Field label="Naziv">
              <Input
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              />
            </Field>
            <Field label="Planirani iznos (RSD)">
              <Input
                inputMode="numeric"
                value={editing.amount || ''}
                onChange={(event) =>
                  setEditing({ ...editing, amount: parseIntegerInput(event.target.value) })
                }
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Račun">
                <Select
                  value={editing.accountId}
                  onChange={(event) => setEditing({ ...editing, accountId: event.target.value })}
                >
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Kategorija">
                <Select
                  value={editing.categoryId}
                  onChange={(event) => setEditing({ ...editing, categoryId: event.target.value })}
                >
                  {incomeCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
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
                      frequency: event.target.value as PlannedIncome['frequency'],
                    })
                  }
                >
                  <option value="monthly">Mesečno</option>
                  <option value="weekly">Nedeljno</option>
                  <option value="yearly">Godišnje</option>
                </Select>
              </Field>
              <Field label="Očekivani dan">
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={editing.expectedDay ?? ''}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      expectedDay: event.target.value ? Number(event.target.value) : undefined,
                    })
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
            <label className="flex min-h-12 items-center gap-3 rounded-xl bg-surface-2 p-3 text-sm">
              <input
                type="checkbox"
                checked={editing.isPrimarySalary}
                onChange={(event) =>
                  setEditing({ ...editing, isPrimarySalary: event.target.checked })
                }
              />
              Primarna plata koju scenario može zameniti samo u prognozi
            </label>
            <label className="flex min-h-12 items-center gap-3 rounded-xl bg-surface-2 p-3 text-sm">
              <input
                type="checkbox"
                checked={editing.active}
                onChange={(event) => setEditing({ ...editing, active: event.target.checked })}
              />
              Aktivan plan
            </label>
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
              type="submit"
              size="lg"
              disabled={
                !editing.name || editing.amount <= 0 || !editing.accountId || !editing.categoryId
              }
            >
              Sačuvaj prihod
            </Button>
            {snapshot.plannedIncomes.some((value) => value.id === editing.id) ? (
              <Button
                type="button"
                variant="ghost"
                className="text-danger"
                onClick={() => {
                  setDeleting(editing);
                  setEditing(null);
                }}
              >
                <Trash2 size={17} /> Obriši ili pauziraj
              </Button>
            ) : null}
          </form>
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Ukloniti planirani prihod?"
        description="Ako postoji istorija primitaka, plan će biti pauziran da bi veze ostale ispravne."
        confirmLabel="Ukloni"
        danger
        onConfirm={async () => {
          if (!deleting) return;
          await deletePlannedIncome(deleting.id);
          setDeleting(null);
          success('Planirani prihod je uklonjen ili pauziran.');
        }}
      />
    </SettingsLayout>
  );
};
