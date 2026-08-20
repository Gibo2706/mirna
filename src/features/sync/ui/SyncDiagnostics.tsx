import { useCallback, useEffect, useState } from 'react';
import { Copy, Download, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { APPLICATION_VERSION } from '@/lib/version';
import type { BetaDiagnosticsSnapshot } from '../diagnostics';
import type { SyncUiServices } from '../ui-services';
import { formatDateTime } from './helpers';
import { SectionTitle } from './shared';

type DiagnosticHealth = Awaited<ReturnType<NonNullable<SyncUiServices['diagnostics']>['health']>>;

const copyPlainText = async (value: string): Promise<void> => {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable.');
  await navigator.clipboard.writeText(value);
};

const downloadJson = (filename: string, value: unknown): void => {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.click();
  URL.revokeObjectURL(url);
};

const compactOpaqueValue = (value: string): string =>
  value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;

const ExpandableOpaqueValue = ({ value, label }: { value: string; label: string }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      className="block min-w-0 max-w-full text-left font-mono font-bold"
      aria-label={`${label}: ${value}. ${expanded ? 'Sakrij' : 'Prikaži'} celu vrednost.`}
      aria-expanded={expanded}
      title={value}
      onClick={() => setExpanded((current) => !current)}
    >
      <span className={expanded ? 'block select-text [overflow-wrap:anywhere]' : 'block truncate'}>
        {expanded ? value : compactOpaqueValue(value)}
      </span>
    </button>
  );
};

const BetaDiagnosticsCard = ({ services }: { services: SyncUiServices }) => {
  const diagnostics = services.diagnostics;
  const [snapshot, setSnapshot] = useState<BetaDiagnosticsSnapshot>();
  const [health, setHealth] = useState<DiagnosticHealth>();
  const [message, setMessage] = useState('');

  const refreshSnapshot = useCallback(async () => {
    if (!diagnostics) return;
    const nextSnapshot = await diagnostics.snapshot();
    setSnapshot(nextSnapshot);
  }, [diagnostics]);

  const refreshHealth = useCallback(async () => {
    if (!diagnostics) return;
    const nextHealth = await diagnostics.health();
    setHealth(nextHealth);
  }, [diagnostics]);

  const refresh = useCallback(async () => {
    await Promise.allSettled([refreshSnapshot(), refreshHealth()]);
  }, [refreshHealth, refreshSnapshot]);

  useEffect(() => {
    void refresh();
    if (!diagnostics) return;
    const unsubscribe = diagnostics.subscribe(() => {
      void refreshSnapshot().catch(() => undefined);
    });
    const timer = window.setInterval(() => void refreshHealth().catch(() => undefined), 60_000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [diagnostics, refresh, refreshHealth, refreshSnapshot]);

  if (!diagnostics) return null;
  const latestRequestId = snapshot?.events.find((event) => event.requestId)?.requestId;
  const latestError = snapshot?.events.find((event) => event.severity === 'error');
  const latestTurnstile = snapshot?.events.find((event) =>
    event.eventType.startsWith('turnstile_'),
  );
  const latestSuccess = snapshot?.events.find(
    (event) => event.eventType === 'turnstile_success' || event.eventType === 'health_result',
  );
  const exportValue = snapshot
    ? {
        schema: 'mirna-beta-diagnostics-v1',
        generatedAt: new Date().toISOString(),
        supportId: snapshot.supportId,
        applicationVersion: APPLICATION_VERSION,
        worker: health
          ? {
              buildCommit: health.buildCommit,
              status: health.status,
              environment: health.environment,
              services: health.services,
              readiness: health.readiness,
            }
          : null,
        events: snapshot.events,
      }
    : null;

  const copy = async (value: string, successMessage: string) => {
    setMessage('');
    try {
      await copyPlainText(value);
      setMessage(successMessage);
    } catch {
      setMessage('Kopiranje nije dostupno u ovom pregledaču.');
    }
  };

  return (
    <Card className="grid min-w-0 gap-4 overflow-hidden" data-testid="sync-beta-diagnostics">
      <div>
        <SectionTitle>Dijagnostika sinhronizacije</SectionTitle>
        <p className="mt-2 text-sm leading-6 text-muted">
          Čuva samo tehničke događaje, bez iznosa, opisa, recovery koda, ključeva, tokena ili IP
          adrese. Lokalna istorija je ograničena na 200 događaja.
        </p>
      </div>
      <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
        <div className="min-w-0 rounded-xl bg-surface-2 p-3">
          <dt className="text-xs font-semibold text-muted">Support ID</dt>
          <dd className="mt-1 min-w-0">
            {snapshot?.supportId ? (
              <ExpandableOpaqueValue value={snapshot.supportId} label="Support ID" />
            ) : (
              'Učitavam…'
            )}
          </dd>
        </div>
        <div className="min-w-0 rounded-xl bg-surface-2 p-3">
          <dt className="text-xs font-semibold text-muted">Poslednji Request ID</dt>
          <dd className="mt-1 min-w-0">
            {latestRequestId ? (
              <ExpandableOpaqueValue value={latestRequestId} label="Request ID" />
            ) : (
              'Nije zabeležen'
            )}
          </dd>
        </div>
        <div className="min-w-0 rounded-xl bg-surface-2 p-3">
          <dt className="text-xs font-semibold text-muted">Build</dt>
          <dd className="mt-1 min-w-0 font-bold">
            <span className="block">aplikacija {APPLICATION_VERSION}</span>
            {health?.buildCommit ? (
              <span className="mt-1 block min-w-0">
                Worker <ExpandableOpaqueValue value={health.buildCommit} label="Worker build" />
              </span>
            ) : (
              <span className="block">Worker nije dostupan</span>
            )}
          </dd>
        </div>
        <div className="rounded-xl bg-surface-2 p-3">
          <dt className="text-xs font-semibold text-muted">Health</dt>
          <dd className="mt-1 font-bold">
            {health
              ? `${health.status}; D1 ${health.services.d1}; R2 ${health.services.r2}; schema ${health.readiness?.accountingSchema ?? 'nije dostupna'}; accounting ${health.readiness?.accountingState ?? 'nije dostupan'}; route budgets ${health.readiness?.routeBudgetConformance ?? 'nije dostupno'}; writes ${health.readiness?.writes ?? (health.writesEnabled ? 'enabled' : 'disabled')}`
              : 'Nije dostupan'}
          </dd>
        </div>
      </dl>
      <div className="grid gap-1 text-xs leading-5 text-muted">
        <p>
          Poslednja greška: {latestError?.safeCode ?? latestError?.eventType ?? 'nema'}
          {latestError?.verificationReason ? ` — ${latestError.verificationReason}` : ''}
        </p>
        {latestError?.accountingCategory ? (
          <p>
            Accounting: {latestError.accountingCategory}; razlog{' '}
            {latestError.accountingReason ?? 'nije zabeležen'}; faza{' '}
            {latestError.reservationPhase ?? 'nije zabeležena'}; ruta{' '}
            {latestError.route ?? 'nije zabeležena'}
          </p>
        ) : null}
        {latestError?.accountingCategory ? (
          <p>
            Poslovni upis: {latestError.businessCommitted ? 'commitovan' : 'nije commitovan'};
            business rad:{' '}
            {latestError.businessWorkStarted === false ? 'nije započet' : 'započet ili nepoznat'};
            fault uloga: {latestError.faultRole ?? 'nije zabeležena'}; service flags:{' '}
            {latestError.serviceFlagsChanged ? 'promenjeni' : 'nisu promenjeni'}
          </p>
        ) : null}
        {latestError?.originRequestId ? (
          <p className="min-w-0">
            Origin fault:{' '}
            <ExpandableOpaqueValue
              value={latestError.originRequestId}
              label="Origin fault Request ID"
            />{' '}
            ({latestError.originRoute ?? 'ruta nije zabeležena'})
          </p>
        ) : null}
        <p>Klijentska faza: {latestTurnstile?.eventType ?? 'nije zabeležena'}</p>
        <p>Vreme: {formatDateTime(latestTurnstile?.createdAt)}</p>
        <p>Klijentski build: {latestTurnstile?.build ?? APPLICATION_VERSION}</p>
        <p>
          Poslednji uspeh:{' '}
          {latestSuccess ? `${latestSuccess.eventType} — ${latestSuccess.createdAt}` : 'nema'}
        </p>
      </div>
      <details className="min-w-0 rounded-xl border bg-surface-2 p-3">
        <summary className="cursor-pointer font-bold">Poslednji tehnički događaji</summary>
        <div className="mt-3 grid min-w-0 gap-2">
          {(snapshot?.events ?? []).slice(0, 10).map((event) => (
            <details key={event.id} className="min-w-0 rounded-lg bg-surface p-3 text-xs">
              <summary className="cursor-pointer">
                <span className={event.severity === 'error' ? 'text-danger' : 'text-accent'}>
                  {event.severity === 'error' ? 'Greška' : 'Uspeh'}
                </span>{' '}
                · {event.eventType} · {formatDateTime(event.createdAt)}
              </summary>
              <dl className="mt-2 grid min-w-0 gap-1 text-muted">
                {event.safeCode ? <div>Kod: {event.safeCode}</div> : null}
                {event.verificationReason ? <div>Razlog: {event.verificationReason}</div> : null}
                {event.accountingCategory ? (
                  <div>Accounting kategorija: {event.accountingCategory}</div>
                ) : null}
                {event.accountingReason ? (
                  <div>Accounting razlog: {event.accountingReason}</div>
                ) : null}
                {event.reservationPhase ? <div>Faza: {event.reservationPhase}</div> : null}
                {event.route ? <div>Ruta: {event.route}</div> : null}
                {event.lifecycleOperation ? (
                  <div>Lifecycle operacija: {event.lifecycleOperation}</div>
                ) : null}
                {event.faultRole ? <div>Fault uloga: {event.faultRole}</div> : null}
                {event.originRequestId ? (
                  <div className="min-w-0">
                    Origin Request ID:{' '}
                    <ExpandableOpaqueValue
                      value={event.originRequestId}
                      label="Origin fault Request ID događaja"
                    />
                    {event.originRoute ? ` (${event.originRoute})` : ''}
                  </div>
                ) : null}
                {event.accountingCategory ? (
                  <div>
                    Poslovni upis: {event.businessCommitted ? 'commitovan' : 'nije commitovan'};
                    business rad:{' '}
                    {event.businessWorkStarted === false ? 'nije započet' : 'započet ili nepoznat'};
                    flagovi: {event.serviceFlagsChanged ? 'promenjeni' : 'nisu promenjeni'}
                  </div>
                ) : null}
                {event.workerBuild ? <div>Worker build: {event.workerBuild}</div> : null}
                {event.requestId ? (
                  <div className="min-w-0">
                    Request ID:{' '}
                    <ExpandableOpaqueValue value={event.requestId} label="Request ID događaja" />
                  </div>
                ) : null}
                {event.verificationAttemptId ? (
                  <div className="min-w-0">
                    Attempt ID:{' '}
                    <ExpandableOpaqueValue
                      value={event.verificationAttemptId}
                      label="Verification Attempt ID"
                    />
                  </div>
                ) : null}
              </dl>
            </details>
          ))}
          {snapshot?.events.length === 0 ? <p>Nema zabeleženih događaja.</p> : null}
        </div>
      </details>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <Button className="w-full" variant="secondary" onClick={() => void refresh()}>
          <RefreshCw size={17} aria-hidden="true" /> Osveži dijagnostiku
        </Button>
        <Button
          className="w-full"
          variant="secondary"
          disabled={!snapshot}
          onClick={() => snapshot && void copy(snapshot.supportId, 'Support ID je kopiran.')}
        >
          <Copy size={17} aria-hidden="true" /> Kopiraj Support ID
        </Button>
        <Button
          className="w-full"
          variant="secondary"
          disabled={!latestRequestId}
          onClick={() => latestRequestId && void copy(latestRequestId, 'Request ID je kopiran.')}
        >
          <Copy size={17} aria-hidden="true" /> Kopiraj Request ID
        </Button>
        <Button
          className="w-full"
          variant="secondary"
          disabled={!exportValue}
          onClick={() =>
            exportValue &&
            void copy(JSON.stringify(exportValue, null, 2), 'Dijagnostika je kopirana.')
          }
        >
          <Copy size={17} aria-hidden="true" /> Kopiraj dijagnostiku
        </Button>
        <Button
          className="w-full"
          variant="secondary"
          disabled={!exportValue}
          onClick={() => exportValue && downloadJson('mirna-beta-dijagnostika.json', exportValue)}
        >
          <Download size={17} aria-hidden="true" /> Preuzmi dijagnostiku
        </Button>
        <Button
          className="w-full"
          variant="ghost"
          disabled={!snapshot || snapshot.events.length === 0}
          onClick={() => {
            void diagnostics.clear().then(async () => {
              setMessage('Lokalna istorija dijagnostike je obrisana; Support ID je sačuvan.');
              await refresh();
            });
          }}
        >
          <Trash2 size={17} aria-hidden="true" /> Obriši istoriju
        </Button>
      </div>
      <p className="rounded-xl bg-warning-soft p-3 text-xs leading-5 text-warning">
        Pre slanja podršci pregledajte fajl. Mirna dijagnostika nikada ne treba da sadrži
        finansijske podatke ili tajne.
      </p>
      {message ? (
        <p role="status" className="text-sm text-muted">
          {message}
        </p>
      ) : null}
    </Card>
  );
};

export const LazyDiagnostics = ({ services }: { services: SyncUiServices }) => {
  const [open, setOpen] = useState(false);
  if (!services.diagnostics) return null;
  return (
    <details
      className="min-w-0 rounded-card border bg-surface p-4"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="min-h-8 cursor-pointer font-bold">Pomoć i dijagnostika</summary>
      <p className="mt-2 text-xs leading-5 text-muted">
        Tehnički podaci za podršku učitavaju se tek kada otvorite ovaj odeljak.
      </p>
      {open ? (
        <div className="mt-4">
          <BetaDiagnosticsCard services={services} />
        </div>
      ) : null}
    </details>
  );
};
