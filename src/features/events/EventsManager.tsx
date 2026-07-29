import { useState } from 'react';
import { CalendarClock, CircleCheck, MoreVertical, Plus, Trash2 } from 'lucide-react';
import type { FinanceSnapshot, PlannedEvent } from '@/domain/types';
import { deletePlannedEvent, savePlannedEvent } from '@/db/commands';
import { createId } from '@/lib/id';
import { formatDate, todayIso } from '@/lib/dates';
import { parseIntegerInput } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { InfoRow } from '@/components/ui/InfoRow';
import { MoneyValue } from '@/components/ui/MoneyValue';
import { Sheet } from '@/components/ui/Sheet';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { SettingsLayout } from '@/components/SettingsLayout';
import { useToast } from '@/components/ToastProvider';
import { EventPaymentSheet } from './EventPaymentSheet';

const newEvent = (accountId = '', categoryId = ''): PlannedEvent => ({
  id: createId('event'),
  title: '',
  date: todayIso(),
  plannedAmount: 0,
  categoryId,
  accountId,
  createdAt: new Date().toISOString(),
});

export const EventsManager = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const { success } = useToast();
  const [editing, setEditing] = useState<PlannedEvent | null>(null);
  const [details, setDetails] = useState<PlannedEvent | null>(null);
  const [paying, setPaying] = useState<PlannedEvent | null>(null);
  const [deleting, setDeleting] = useState<PlannedEvent | null>(null);
  const [error, setError] = useState('');
  const categories = snapshot.categories.filter(
    (category) => category.kind === 'expense' && !category.archived,
  );
  const events = [...snapshot.plannedEvents].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const categoryName = (event: PlannedEvent) =>
    snapshot.categories.find((category) => category.id === event.categoryId)?.name ?? '—';
  const accountName = (event: PlannedEvent) =>
    snapshot.accounts.find((account) => account.id === event.accountId)?.name ?? '—';
  const goalName = (event: PlannedEvent) =>
    event.linkedGoalId
      ? (snapshot.goals.find((goal) => goal.id === event.linkedGoalId)?.name ?? '—')
      : 'Nije povezan';
  const status = (event: PlannedEvent) =>
    event.paidTransactionId
      ? ({ label: 'Plaćeno', tone: 'positive' } as const)
      : event.date < todayIso()
        ? ({ label: 'Kasni', tone: 'warning' } as const)
        : ({ label: 'Predstoji', tone: 'neutral' } as const);

  return (
    <SettingsLayout
      title="Planirani događaji"
      description="Jednokratni troškovi koji dolaze. Status i radnje su odvojeni da plan ostane jasan."
      action={
        <Button
          size="icon"
          onClick={() =>
            setEditing(newEvent(snapshot.settingsRecord.defaultAccountId, categories[0]?.id))
          }
          aria-label="Novi planirani događaj"
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
      {events.length ? (
        <div className="-mx-4 divide-y border-y bg-surface sm:mx-0 sm:rounded-card sm:border">
          {events.map((event) => {
            const eventStatus = status(event);
            return (
              <div
                key={event.id}
                className="grid grid-cols-[2.5rem_minmax(0,1fr)_2.75rem] items-start gap-3 px-4 py-4"
                data-testid="planned-event-row"
              >
                <span
                  className={`grid size-10 place-items-center rounded-xl ${
                    event.paidTransactionId
                      ? 'bg-accent-soft text-accent'
                      : eventStatus.label === 'Kasni'
                        ? 'bg-warning-soft text-warning'
                        : 'bg-surface-2 text-muted'
                  }`}
                >
                  {event.paidTransactionId ? (
                    <CircleCheck size={19} />
                  ) : (
                    <CalendarClock size={19} />
                  )}
                </span>
                <button
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-left"
                  onClick={() => setDetails(event)}
                  aria-label={`Detalji događaja ${event.title}`}
                >
                  <span
                    className="line-clamp-2 break-words text-sm font-bold leading-5"
                    title={event.title}
                    data-testid="planned-event-title"
                  >
                    {event.title}
                  </span>
                  <MoneyValue
                    value={event.plannedAmount}
                    className="self-start text-sm font-extrabold"
                    data-testid="planned-event-amount"
                  />
                  <span className="min-w-0 break-words text-xs leading-5 text-muted">
                    {formatDate(event.date)} · {categoryName(event)}
                  </span>
                  <StatusBadge
                    tone={eventStatus.tone}
                    className="self-start"
                    data-testid="planned-event-status"
                  >
                    {eventStatus.label}
                  </StatusBadge>
                </button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="-mt-1"
                  onClick={() => setDetails(event)}
                  aria-label={`Radnje za ${event.title}`}
                  data-testid="planned-event-action"
                >
                  <MoreVertical size={18} />
                </Button>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={CalendarClock}
          title="Nema planiranih događaja"
          description="Dodajte poklon, putovanje ili drugi jednokratni trošak."
        />
      )}
      <Sheet
        open={Boolean(details)}
        onOpenChange={(open) => !open && setDetails(null)}
        title={details?.title ?? 'Detalji događaja'}
        description="Plan, status i dostupne radnje na jednom mestu."
      >
        {details ? (
          <div>
            <MoneyValue value={details.plannedAmount} className="text-3xl font-extrabold" />
            <div className="mt-5">
              <dl>
                <InfoRow label="Datum" value={formatDate(details.date)} />
                <InfoRow label="Kategorija" value={categoryName(details)} />
                <InfoRow label="Račun" value={accountName(details)} />
                <InfoRow label="Povezani cilj" value={goalName(details)} />
                <InfoRow
                  label="Status"
                  value={
                    <StatusBadge tone={status(details).tone}>{status(details).label}</StatusBadge>
                  }
                />
                <InfoRow label="Beleška" value={details.notes || 'Nema beleške'} />
              </dl>
            </div>
            <div className="mt-6 grid gap-2">
              {!details.paidTransactionId && details.plannedAmount > 0 ? (
                <Button
                  size="lg"
                  onClick={() => {
                    setDetails(null);
                    setError('');
                    setPaying(details);
                  }}
                >
                  Označi kao plaćeno
                </Button>
              ) : null}
              <Button
                variant="secondary"
                onClick={() => {
                  setDetails(null);
                  setEditing(details);
                }}
              >
                Izmeni
              </Button>
              <Button
                variant="ghost"
                className="text-danger"
                onClick={() => {
                  setDetails(null);
                  setDeleting(details);
                }}
              >
                <Trash2 size={17} /> Obriši događaj
              </Button>
            </div>
          </div>
        ) : null}
      </Sheet>
      <Sheet
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.title ? 'Izmeni događaj' : 'Novi događaj'}
      >
        {editing ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                try {
                  await savePlannedEvent(editing);
                  setEditing(null);
                  success('Događaj je sačuvan.');
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : 'Događaj nije sačuvan.');
                }
              })();
            }}
          >
            <Field label="Naziv">
              <Input
                disabled={Boolean(editing.paidTransactionId)}
                value={editing.title}
                onChange={(event) => setEditing({ ...editing, title: event.target.value })}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Datum">
                <Input
                  disabled={Boolean(editing.paidTransactionId)}
                  type="date"
                  value={editing.date}
                  onChange={(event) => setEditing({ ...editing, date: event.target.value })}
                />
              </Field>
              <Field label="Planirani iznos">
                <Input
                  disabled={Boolean(editing.paidTransactionId)}
                  inputMode="numeric"
                  value={editing.plannedAmount || ''}
                  onChange={(event) =>
                    setEditing({ ...editing, plannedAmount: parseIntegerInput(event.target.value) })
                  }
                />
              </Field>
              <Field label="Kategorija">
                <Select
                  disabled={Boolean(editing.paidTransactionId)}
                  value={editing.categoryId}
                  onChange={(event) => setEditing({ ...editing, categoryId: event.target.value })}
                >
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Račun">
                <Select
                  disabled={Boolean(editing.paidTransactionId)}
                  value={editing.accountId}
                  onChange={(event) => setEditing({ ...editing, accountId: event.target.value })}
                >
                  {snapshot.accounts
                    .filter((account) => !account.archived)
                    .map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Povezani cilj (opciono)">
                <Select
                  disabled={Boolean(editing.paidTransactionId)}
                  value={editing.linkedGoalId ?? ''}
                  onChange={(event) =>
                    setEditing({ ...editing, linkedGoalId: event.target.value || undefined })
                  }
                >
                  <option value="">Bez cilja</option>
                  {snapshot.goals
                    .filter((goal) => !goal.archived)
                    .map((goal) => (
                      <option key={goal.id} value={goal.id}>
                        {goal.emoji} {goal.name}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <Field label="Beleška">
              <Textarea
                disabled={Boolean(editing.paidTransactionId)}
                value={editing.notes ?? ''}
                onChange={(event) => setEditing({ ...editing, notes: event.target.value })}
              />
            </Field>
            {editing.paidTransactionId ? (
              <p className="rounded-xl bg-accent-soft p-3 text-sm">
                Plaćeni događaj se menja kroz povezanu transakciju.
              </p>
            ) : (
              <Button
                type="submit"
                size="lg"
                disabled={!editing.title || !editing.accountId || !editing.categoryId}
              >
                Sačuvaj događaj
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              className="text-danger"
              onClick={() => {
                setDeleting(editing);
                setEditing(null);
              }}
            >
              <Trash2 size={17} /> Obriši događaj
            </Button>
            {error ? (
              <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
          </form>
        ) : null}
      </Sheet>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Obrisati događaj?"
        description="Za plaćeni događaj prvo obrišite povezanu stvarnu transakciju. Neplaćeni plan može se bezbedno obrisati."
        danger
        confirmLabel="Obriši"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await deletePlannedEvent(deleting.id);
          } catch (caught) {
            setDeleting(null);
            setError(caught instanceof Error ? caught.message : 'Događaj nije obrisan.');
            return;
          }
          setDeleting(null);
          success('Događaj je obrisan.');
        }}
      />
      <EventPaymentSheet
        event={paying}
        snapshot={snapshot}
        open={Boolean(paying)}
        onOpenChange={(open) => !open && setPaying(null)}
        onPaid={() => {
          setPaying(null);
          success('Događaj je označen kao plaćen.');
        }}
      />
    </SettingsLayout>
  );
};
