import { useState } from 'react';
import { Edit3, Gauge, Plus, Trash2 } from 'lucide-react';
import type { FinanceSnapshot, VariableBudget } from '@/domain/types';
import { deleteVariableBudget, saveVariableBudget } from '@/db/commands';
import { createId } from '@/lib/id';
import { currentMonthKey } from '@/lib/dates';
import { formatRsd, parseIntegerInput } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { SettingsLayout } from '@/components/SettingsLayout';
import { useToast } from '@/components/ToastProvider';

const newBudget = (categoryId = ''): VariableBudget => ({
  id: createId('budget'),
  name: '',
  defaultAmount: 0,
  categoryId,
  overrides: {},
  active: true,
  createdAt: new Date().toISOString(),
});

export const BudgetsManager = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const { success } = useToast();
  const [editing, setEditing] = useState<VariableBudget | null>(null);
  const [deleting, setDeleting] = useState<VariableBudget | null>(null);
  const [overrideMonth, setOverrideMonth] = useState(currentMonthKey());
  const [overrideAmount, setOverrideAmount] = useState(0);
  const [error, setError] = useState('');
  const categories = snapshot.categories.filter(
    (category) => category.kind === 'expense' && !category.archived,
  );

  const open = (budget: VariableBudget) => {
    setEditing(budget);
    setOverrideMonth(currentMonthKey());
    setOverrideAmount(budget.overrides[currentMonthKey()] ?? 0);
    setError('');
  };

  return (
    <SettingsLayout
      title="Promenljivi budžeti"
      description="Podrazumevani mesečni plan sa opcionim izuzetkom za konkretan mesec."
      action={
        <Button
          size="icon"
          onClick={() => open(newBudget(categories[0]?.id))}
          aria-label="Novi budžet"
        >
          <Plus />
        </Button>
      }
    >
      {error && !editing ? (
        <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {snapshot.variableBudgets.length ? (
        <Card className="divide-y p-0">
          {snapshot.variableBudgets.map((budget) => (
            <div
              key={budget.id}
              className={`flex items-start gap-3 p-4 ${!budget.active ? 'opacity-55' : ''}`}
            >
              <span className="grid size-10 place-items-center rounded-xl bg-surface-2 text-muted">
                <Gauge size={19} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words font-bold">{budget.name}</p>
                <p className="text-xs text-muted">
                  {Object.keys(budget.overrides).length} mesečnih izmena
                </p>
              </div>
              <p className="money shrink-0 whitespace-nowrap text-sm font-extrabold">
                {formatRsd(budget.defaultAmount)}
              </p>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => open(budget)}
                aria-label={`Izmeni ${budget.name}`}
              >
                <Edit3 size={17} />
              </Button>
            </div>
          ))}
        </Card>
      ) : (
        <EmptyState
          icon={Gauge}
          title="Nema promenljivih budžeta"
          description="Postavite mesečne okvire za kategorije poput hrane i goriva."
        />
      )}
      <Sheet
        open={Boolean(editing)}
        onOpenChange={(openValue) => !openValue && setEditing(null)}
        title={editing?.name ? 'Izmeni budžet' : 'Novi budžet'}
      >
        {editing ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                const overrides = { ...editing.overrides };
                if (overrideAmount > 0) overrides[overrideMonth] = overrideAmount;
                else delete overrides[overrideMonth];
                setError('');
                try {
                  await saveVariableBudget({ ...editing, overrides });
                  setEditing(null);
                  success('Budžet je sačuvan.');
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : 'Budžet nije sačuvan.');
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
            <Field label="Kategorija">
              <Select
                value={editing.categoryId}
                onChange={(event) => setEditing({ ...editing, categoryId: event.target.value })}
              >
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.icon} {category.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Podrazumevani mesečni iznos">
              <Input
                inputMode="numeric"
                value={editing.defaultAmount || ''}
                onChange={(event) =>
                  setEditing({ ...editing, defaultAmount: parseIntegerInput(event.target.value) })
                }
              />
            </Field>
            <div className="rounded-2xl bg-surface-2 p-4">
              <p className="mb-3 text-sm font-bold">Izuzetak za mesec</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Mesec">
                  <Input
                    type="month"
                    value={overrideMonth}
                    onChange={(event) => {
                      setOverrideMonth(event.target.value);
                      setOverrideAmount(editing.overrides[event.target.value] ?? 0);
                    }}
                  />
                </Field>
                <Field label="Poseban iznos" hint="0 uklanja izuzetak.">
                  <Input
                    inputMode="numeric"
                    value={overrideAmount || ''}
                    onChange={(event) => setOverrideAmount(parseIntegerInput(event.target.value))}
                  />
                </Field>
              </div>
            </div>
            <label className="flex min-h-12 items-center gap-3 rounded-xl border px-3">
              <input
                type="checkbox"
                checked={editing.active}
                onChange={(event) => setEditing({ ...editing, active: event.target.checked })}
              />
              <span className="text-sm font-semibold">Aktivan budžet</span>
            </label>
            <Button type="submit" size="lg" disabled={!editing.name || !editing.categoryId}>
              Sačuvaj budžet
            </Button>
            {error ? (
              <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
            {snapshot.variableBudgets.some((value) => value.id === editing.id) ? (
              <Button
                type="button"
                variant="ghost"
                className="text-danger"
                onClick={() => {
                  setDeleting(editing);
                  setEditing(null);
                }}
              >
                <Trash2 size={17} /> Obriši budžet
              </Button>
            ) : null}
          </form>
        ) : null}
      </Sheet>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Obrisati budžet?"
        description="Transakcije i kategorija ostaju sačuvani; uklanja se samo mesečni plan."
        danger
        confirmLabel="Obriši"
        onConfirm={async () => {
          if (!deleting) return;
          await deleteVariableBudget(deleting.id);
          setDeleting(null);
          success('Budžet je obrisan.');
        }}
      />
    </SettingsLayout>
  );
};
