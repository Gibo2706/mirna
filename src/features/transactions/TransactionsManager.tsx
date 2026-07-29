import { useEffect, useMemo, useState } from 'react';
import { Edit3, ReceiptText, Trash2 } from 'lucide-react';
import type { FinanceSnapshot, LedgerTransaction } from '@/domain/types';
import { deleteTransaction, saveTransaction } from '@/db/commands';
import { formatDate } from '@/lib/dates';
import { formatRsd, parseIntegerInput } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { SettingsLayout } from '@/components/SettingsLayout';
import { useToast } from '@/components/ToastProvider';

export const TransactionsManager = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const { success } = useToast();
  const [editing, setEditing] = useState<LedgerTransaction | null>(null);
  const [deleting, setDeleting] = useState<LedgerTransaction | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [monthFilter, setMonthFilter] = useState('');
  const [visibleCount, setVisibleCount] = useState(100);
  const accountsById = useMemo(
    () => new Map(snapshot.accounts.map((account) => [account.id, account])),
    [snapshot.accounts],
  );
  const transactions = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase('sr-Latn-RS');
    return [...snapshot.transactions]
      .filter(
        (transaction) =>
          (!monthFilter || transaction.date.startsWith(monthFilter)) &&
          (!normalizedSearch ||
            transaction.description.toLocaleLowerCase('sr-Latn-RS').includes(normalizedSearch) ||
            transaction.notes?.toLocaleLowerCase('sr-Latn-RS').includes(normalizedSearch)),
      )
      .sort(
        (left, right) =>
          right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt),
      );
  }, [monthFilter, search, snapshot.transactions]);
  const visibleTransactions = transactions.slice(0, visibleCount);
  useEffect(() => setVisibleCount(100), [monthFilter, search]);
  const canEdit = editing?.source === 'manual' || editing?.source === 'quick-add';
  const categories = snapshot.categories.filter(
    (category) => !category.archived && category.kind === editing?.type,
  );

  return (
    <SettingsLayout
      title="Transakcije"
      description="Stvarna istorija novca. Povezane stavke se uklanjaju zajedno sa svojim izvorom."
    >
      <Card className="mb-4 grid gap-3 sm:grid-cols-2">
        <Field label="Pretraga">
          <Input
            type="search"
            value={search}
            placeholder="Opis ili beleška"
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        <Field label="Mesec">
          <Input
            type="month"
            value={monthFilter}
            onChange={(event) => setMonthFilter(event.target.value)}
          />
        </Field>
      </Card>
      {transactions.length ? (
        <>
          <Card className="divide-y p-0">
            {visibleTransactions.map((transaction) => {
              const account = accountsById.get(transaction.accountId);
              const destination = transaction.toAccountId
                ? accountsById.get(transaction.toAccountId)
                : undefined;
              return (
                <div key={transaction.id} className="flex items-start gap-3 p-4">
                  <span
                    className={`grid size-10 shrink-0 place-items-center rounded-xl ${transaction.type === 'expense' ? 'bg-danger-soft text-danger' : transaction.type === 'income' ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted'}`}
                  >
                    {transaction.type === 'income'
                      ? '↙'
                      : transaction.type === 'expense'
                        ? '↗'
                        : transaction.type === 'transfer'
                          ? '↔'
                          : '≈'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 break-words text-sm font-bold">
                      {transaction.description}
                    </p>
                    <p className="mt-1 break-words text-xs leading-5 text-muted">
                      {formatDate(transaction.date)} · {account?.name}
                      {destination ? ` → ${destination.name}` : ''}
                    </p>
                  </div>
                  <p
                    className={`money shrink-0 whitespace-nowrap text-sm font-extrabold ${transaction.type === 'expense' ? 'text-danger' : transaction.type === 'income' ? 'text-accent' : ''}`}
                  >
                    {transaction.type === 'expense'
                      ? '−'
                      : transaction.type === 'income'
                        ? '+'
                        : ''}
                    {formatRsd(Math.abs(transaction.amount))}
                  </p>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                      setEditing(transaction);
                      setError('');
                    }}
                    aria-label={`Detalji ${transaction.description}`}
                  >
                    <Edit3 size={17} />
                  </Button>
                </div>
              );
            })}
          </Card>
          {visibleTransactions.length < transactions.length ? (
            <Button
              className="mt-4 w-full"
              variant="secondary"
              onClick={() => setVisibleCount((value) => value + 100)}
            >
              Učitaj još ({transactions.length - visibleTransactions.length} preostalo)
            </Button>
          ) : null}
        </>
      ) : (
        <EmptyState
          icon={ReceiptText}
          title="Još nema transakcija"
          description="Koristite plutajuće + dugme za prvi prihod, trošak ili transfer."
        />
      )}

      <Sheet
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        title={canEdit ? 'Izmeni transakciju' : 'Detalji transakcije'}
        description={
          !canEdit
            ? 'Ovu transakciju je kreirao povezani tok. Možete je obrisati, ali ne i odvojeno menjati.'
            : undefined
        }
      >
        {editing ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canEdit) return;
              void (async () => {
                try {
                  await saveTransaction(editing);
                  setEditing(null);
                  success('Transakcija je izmenjena.');
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : 'Izmena nije sačuvana.');
                }
              })();
            }}
          >
            <Field label="Tip">
              <Select
                disabled={!canEdit}
                value={editing.type}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    type: event.target.value as LedgerTransaction['type'],
                    categoryId: undefined,
                    toAccountId: undefined,
                  })
                }
              >
                <option value="expense">Trošak</option>
                <option value="income">Prihod</option>
                <option value="transfer">Transfer</option>
                <option value="adjustment">Usklađivanje</option>
              </Select>
            </Field>
            <Field label="Iznos">
              <Input
                disabled={!canEdit}
                inputMode="numeric"
                value={editing.amount}
                onChange={(event) =>
                  setEditing({ ...editing, amount: parseIntegerInput(event.target.value) })
                }
              />
            </Field>
            <Field label={editing.type === 'transfer' ? 'Sa računa' : 'Račun'}>
              <Select
                disabled={!canEdit}
                value={editing.accountId}
                onChange={(event) => setEditing({ ...editing, accountId: event.target.value })}
              >
                {snapshot.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </Select>
            </Field>
            {editing.type === 'transfer' ? (
              <Field label="Na račun">
                <Select
                  disabled={!canEdit}
                  value={editing.toAccountId ?? ''}
                  onChange={(event) => setEditing({ ...editing, toAccountId: event.target.value })}
                >
                  {snapshot.accounts
                    .filter((account) => account.id !== editing.accountId)
                    .map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                </Select>
              </Field>
            ) : editing.type !== 'adjustment' ? (
              <Field label="Kategorija">
                <Select
                  disabled={!canEdit}
                  value={editing.categoryId ?? ''}
                  onChange={(event) => setEditing({ ...editing, categoryId: event.target.value })}
                >
                  <option value="">Izaberite</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="Opis">
              <Input
                disabled={!canEdit}
                value={editing.description}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
              />
            </Field>
            <Field label="Datum">
              <Input
                disabled={!canEdit}
                type="date"
                value={editing.date}
                onChange={(event) => setEditing({ ...editing, date: event.target.value })}
              />
            </Field>
            <Field label="Beleška">
              <Textarea
                disabled={!canEdit}
                value={editing.notes ?? ''}
                onChange={(event) => setEditing({ ...editing, notes: event.target.value })}
              />
            </Field>
            {error ? (
              <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
            {canEdit ? (
              <Button type="submit" size="lg">
                Sačuvaj izmene
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              className="text-danger"
              onClick={() => {
                setDeleting(editing);
                setEditing(null);
              }}
            >
              <Trash2 size={17} /> Obriši transakciju
            </Button>
          </form>
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Obrisati transakciju?"
        description="Stanja, budžeti i povezani statusi odmah će biti ponovo izračunati. Ova radnja se ne može poništiti."
        danger
        confirmLabel="Obriši"
        onConfirm={async () => {
          if (!deleting) return;
          await deleteTransaction(deleting.id);
          setDeleting(null);
          success('Transakcija je obrisana.');
        }}
      />
    </SettingsLayout>
  );
};
