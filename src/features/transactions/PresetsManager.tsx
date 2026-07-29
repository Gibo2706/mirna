import { useState } from 'react';
import { Edit3, ListChecks, Plus, Trash2 } from 'lucide-react';
import type { FinanceSnapshot, QuickAddPreset } from '@/domain/types';
import { deletePreset, savePreset } from '@/db/commands';
import { createId } from '@/lib/id';
import { formatRsd, parseIntegerInput } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { SettingsLayout } from '@/components/SettingsLayout';
import { useToast } from '@/components/ToastProvider';

const newPreset = (position: number, accountId?: string): QuickAddPreset => ({
  id: createId('preset'),
  name: '',
  emoji: '⚡',
  type: 'expense',
  defaultAccountId: accountId,
  position,
  active: true,
});

export const PresetsManager = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const { success } = useToast();
  const [editing, setEditing] = useState<QuickAddPreset | null>(null);
  const [deleting, setDeleting] = useState<QuickAddPreset | null>(null);
  const [error, setError] = useState('');
  const categories = snapshot.categories.filter(
    (category) => category.kind === editing?.type && !category.archived,
  );
  const presets = [...snapshot.presets].sort((left, right) => left.position - right.position);

  return (
    <SettingsLayout
      title="Prečice za brzi unos"
      description="Podrazumevani račun, kategorija i opcioni iznos skraćuju dnevni unos na nekoliko dodira."
      action={
        <Button
          size="icon"
          onClick={() =>
            setEditing(newPreset(presets.length, snapshot.settingsRecord.defaultAccountId))
          }
          aria-label="Nova prečica za brzi unos"
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
      {presets.length ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {presets.map((preset) => (
            <Card key={preset.id} className={!preset.active ? 'opacity-55' : ''}>
              <div className="flex items-start justify-between">
                <span className="text-2xl">{preset.emoji}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setEditing(preset)}
                  aria-label={`Izmeni ${preset.name}`}
                >
                  <Edit3 size={17} />
                </Button>
              </div>
              <p className="mt-3 font-bold">{preset.name}</p>
              <p className="mt-1 text-xs text-muted">
                {preset.type === 'income' ? 'Prihod' : 'Trošak'} ·{' '}
                {preset.amount ? formatRsd(preset.amount) : 'iznos se unosi'}
              </p>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={ListChecks}
          title="Nema preseta"
          description="Napravite prečicu za najčešću transakciju."
        />
      )}
      <Sheet
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.name ? 'Izmeni preset' : 'Novi preset'}
      >
        {editing ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                setError('');
                try {
                  await savePreset(editing);
                  setEditing(null);
                  success('Preset je sačuvan.');
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : 'Preset nije sačuvan.');
                }
              })();
            }}
          >
            <div className="grid grid-cols-[5rem_1fr] gap-3">
              <Field label="Emoji">
                <Input
                  value={editing.emoji}
                  onChange={(event) => setEditing({ ...editing, emoji: event.target.value })}
                />
              </Field>
              <Field label="Naziv">
                <Input
                  value={editing.name}
                  onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                />
              </Field>
            </div>
            <Field label="Tip">
              <Select
                value={editing.type}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    type: event.target.value as QuickAddPreset['type'],
                    categoryId: undefined,
                  })
                }
              >
                <option value="expense">Trošak</option>
                <option value="income">Prihod</option>
              </Select>
            </Field>
            <Field label="Kategorija">
              <Select
                value={editing.categoryId ?? ''}
                onChange={(event) =>
                  setEditing({ ...editing, categoryId: event.target.value || undefined })
                }
              >
                <option value="">Bez unapred izabrane vrednosti</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.icon} {category.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Iznos (opciono)">
              <Input
                inputMode="numeric"
                value={editing.amount ?? ''}
                onChange={(event) => {
                  const value = parseIntegerInput(event.target.value);
                  setEditing({ ...editing, amount: value > 0 ? value : undefined });
                }}
              />
            </Field>
            <Field label="Podrazumevani račun">
              <Select
                value={editing.defaultAccountId ?? ''}
                onChange={(event) =>
                  setEditing({ ...editing, defaultAccountId: event.target.value || undefined })
                }
              >
                <option value="">Bez unapred izabrane vrednosti</option>
                {snapshot.accounts
                  .filter((account) => !account.archived)
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Pozicija">
              <Input
                type="number"
                min={0}
                value={editing.position}
                onChange={(event) =>
                  setEditing({ ...editing, position: Number(event.target.value) })
                }
              />
            </Field>
            <label className="flex min-h-12 items-center gap-3 rounded-xl border px-3">
              <input
                type="checkbox"
                checked={editing.active}
                onChange={(event) => setEditing({ ...editing, active: event.target.checked })}
              />
              <span className="text-sm font-semibold">Aktivan preset</span>
            </label>
            <Button type="submit" size="lg" disabled={!editing.name}>
              Sačuvaj preset
            </Button>
            {error ? (
              <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
            {snapshot.presets.some((value) => value.id === editing.id) ? (
              <Button
                type="button"
                variant="ghost"
                className="text-danger"
                onClick={() => {
                  setDeleting(editing);
                  setEditing(null);
                }}
              >
                <Trash2 size={17} /> Obriši preset
              </Button>
            ) : null}
          </form>
        ) : null}
      </Sheet>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Obrisati preset?"
        description="Postojeće transakcije ostaju sačuvane."
        danger
        confirmLabel="Obriši"
        onConfirm={async () => {
          if (!deleting) return;
          await deletePreset(deleting.id);
          setDeleting(null);
          success('Preset je obrisan.');
        }}
      />
    </SettingsLayout>
  );
};
