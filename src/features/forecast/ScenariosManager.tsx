import { useState } from 'react';
import { Edit3, Plus, Trash2, UserRoundCheck } from 'lucide-react';
import type { FinanceSnapshot, SalaryScenario } from '@/domain/types';
import { deleteSalaryScenario, saveSalaryScenario } from '@/db/commands';
import { createId } from '@/lib/id';
import { currentMonthKey } from '@/lib/dates';
import { formatRsd, parseIntegerInput } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { SettingsLayout } from '@/components/SettingsLayout';
import { useToast } from '@/components/ToastProvider';

const newScenario = (): SalaryScenario => ({
  id: createId('scenario'),
  name: '',
  monthlyAmount: 0,
  startMonth: currentMonthKey(),
  createdAt: new Date().toISOString(),
});

export const ScenariosManager = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const { success } = useToast();
  const [editing, setEditing] = useState<SalaryScenario | null>(null);
  const [deleting, setDeleting] = useState<SalaryScenario | null>(null);
  const [error, setError] = useState('');

  return (
    <SettingsLayout
      title="Scenariji plate"
      description="Scenariji menjaju samo buduću prognozu; stvarni podaci i mesečni plan ostaju netaknuti."
      action={
        <Button size="icon" onClick={() => setEditing(newScenario())} aria-label="Novi scenario">
          <Plus />
        </Button>
      }
    >
      {error && !editing ? (
        <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {snapshot.salaryScenarios.length ? (
        <Card className="divide-y p-0">
          {snapshot.salaryScenarios.map((scenario) => (
            <div key={scenario.id} className="flex items-start gap-3 p-4">
              <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">
                <UserRoundCheck size={19} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words font-bold">{scenario.name}</p>
                <p className="text-xs text-muted">
                  Od {scenario.startMonth}
                  {scenario.id === snapshot.settingsRecord.activeSalaryScenarioId
                    ? ' · aktivan'
                    : ''}
                </p>
              </div>
              <p className="money shrink-0 whitespace-nowrap text-sm font-extrabold">
                {formatRsd(scenario.monthlyAmount)}
              </p>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setEditing(scenario)}
                aria-label={`Izmeni ${scenario.name}`}
              >
                <Edit3 size={17} />
              </Button>
            </div>
          ))}
        </Card>
      ) : (
        <EmptyState
          icon={UserRoundCheck}
          title="Nema scenarija"
          description="Dodajte mesečnu platu i mesec od kog bi važila."
        />
      )}
      <Sheet
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.name ? 'Izmeni scenario' : 'Novi scenario'}
      >
        {editing ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                setError('');
                try {
                  await saveSalaryScenario(editing);
                  setEditing(null);
                  success('Scenario je sačuvan.');
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : 'Scenario nije sačuvan.');
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
            <Field label="Mesečni prihod">
              <Input
                inputMode="numeric"
                value={editing.monthlyAmount || ''}
                onChange={(event) =>
                  setEditing({ ...editing, monthlyAmount: parseIntegerInput(event.target.value) })
                }
              />
            </Field>
            <Field label="Počinje od meseca">
              <Input
                type="month"
                value={editing.startMonth}
                onChange={(event) => setEditing({ ...editing, startMonth: event.target.value })}
              />
            </Field>
            <Button type="submit" size="lg" disabled={!editing.name || editing.monthlyAmount <= 0}>
              Sačuvaj scenario
            </Button>
            {error ? (
              <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
            {snapshot.salaryScenarios.some((value) => value.id === editing.id) ? (
              <Button
                type="button"
                variant="ghost"
                className="text-danger"
                onClick={() => {
                  setDeleting(editing);
                  setEditing(null);
                }}
              >
                <Trash2 size={17} /> Obriši scenario
              </Button>
            ) : null}
          </form>
        ) : null}
      </Sheet>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Obrisati scenario?"
        description="Istorijski i stvarni podaci se ne menjaju. Ako je scenario aktivan, prognoza će preći na bazni plan."
        danger
        confirmLabel="Obriši"
        onConfirm={async () => {
          if (!deleting) return;
          await deleteSalaryScenario(deleting.id);
          setDeleting(null);
          success('Scenario je obrisan.');
        }}
      />
    </SettingsLayout>
  );
};
