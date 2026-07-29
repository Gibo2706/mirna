import { useState } from 'react';
import { Edit3, Plus, Tags, Trash2 } from 'lucide-react';
import type { Category, FinanceSnapshot } from '@/domain/types';
import { deleteCategory, saveCategory } from '@/db/commands';
import { createId } from '@/lib/id';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { SettingsLayout } from '@/components/SettingsLayout';
import { useToast } from '@/components/ToastProvider';

const newCategory = (): Category => ({
  id: createId('category'),
  name: '',
  kind: 'expense',
  icon: '•',
  color: '#64748b',
  archived: false,
});

export const CategoriesManager = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const { success } = useToast();
  const [editing, setEditing] = useState<Category | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const [error, setError] = useState('');

  return (
    <SettingsLayout
      title="Kategorije"
      description="Kategorije povezuju transakcije, budžete, obaveze i događaje."
      action={
        <Button size="icon" onClick={() => setEditing(newCategory())} aria-label="Nova kategorija">
          <Plus />
        </Button>
      }
    >
      {snapshot.categories.length ? (
        <Card className="divide-y p-0">
          {snapshot.categories.map((category) => (
            <div
              key={category.id}
              className={`flex items-center gap-3 p-4 ${category.archived ? 'opacity-55' : ''}`}
            >
              <span className="grid size-10 place-items-center rounded-xl bg-surface-2 text-xl">
                {category.icon}
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words font-bold">{category.name}</p>
                <p className="text-xs text-muted">
                  {category.kind === 'income' ? 'Prihod' : 'Trošak'}
                  {category.archived ? ' · arhivirana' : ''}
                </p>
              </div>
              <span className="size-3 rounded-full" style={{ background: category.color }} />
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  setEditing(category);
                  setError('');
                }}
                aria-label={`Izmeni ${category.name}`}
              >
                <Edit3 size={17} />
              </Button>
            </div>
          ))}
        </Card>
      ) : (
        <EmptyState
          icon={Tags}
          title="Nema kategorija"
          description="Dodajte kategoriju prihoda ili troška."
        />
      )}
      <Sheet
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.name ? 'Izmeni kategoriju' : 'Nova kategorija'}
      >
        {editing ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                try {
                  await saveCategory(editing);
                  setEditing(null);
                  success('Kategorija je sačuvana.');
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : 'Kategorija nije sačuvana.');
                }
              })();
            }}
          >
            <div className="grid grid-cols-[5rem_1fr] gap-3">
              <Field label="Ikona">
                <Input
                  value={editing.icon}
                  onChange={(event) => setEditing({ ...editing, icon: event.target.value })}
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
                value={editing.kind}
                onChange={(event) =>
                  setEditing({ ...editing, kind: event.target.value as Category['kind'] })
                }
              >
                <option value="expense">Trošak</option>
                <option value="income">Prihod</option>
              </Select>
            </Field>
            <Field label="Boja">
              <Input
                type="color"
                className="h-12 p-1"
                value={editing.color}
                onChange={(event) => setEditing({ ...editing, color: event.target.value })}
              />
            </Field>
            <label className="flex min-h-12 items-center gap-3 rounded-xl border px-3">
              <input
                type="checkbox"
                checked={editing.archived}
                onChange={(event) => setEditing({ ...editing, archived: event.target.checked })}
              />
              <span className="text-sm font-semibold">Arhivirana</span>
            </label>
            {error ? (
              <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <Button type="submit" size="lg" disabled={!editing.name}>
              Sačuvaj kategoriju
            </Button>
            {snapshot.categories.some((value) => value.id === editing.id) ? (
              <Button
                type="button"
                variant="ghost"
                className="text-danger"
                onClick={() => {
                  setDeleting(editing);
                  setEditing(null);
                }}
              >
                <Trash2 size={17} /> Obriši kategoriju
              </Button>
            ) : null}
          </form>
        ) : null}
      </Sheet>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Obrisati kategoriju?"
        description="Brisanje je moguće samo kada je kategorija potpuno nekorišćena. Inače je arhivirajte."
        danger
        confirmLabel="Obriši"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await deleteCategory(deleting.id);
            setDeleting(null);
            success('Kategorija je obrisana.');
          } catch (caught) {
            setDeleting(null);
            setEditing({ ...deleting, archived: true });
            setError(caught instanceof Error ? caught.message : 'Kategorija nije obrisana.');
          }
        }}
      />
    </SettingsLayout>
  );
};
