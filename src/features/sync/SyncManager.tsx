import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  CloudUpload,
  Copy,
  Download,
  KeyRound,
  QrCode,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  Smartphone,
  TriangleAlert,
  Trash2,
  Unplug,
} from 'lucide-react';
import { Link } from 'react-router';
import type { LocalSyncSetup } from '@/db/sync/records';
import { SettingsLayout } from '@/components/SettingsLayout';
import { useToast } from '@/components/ToastProvider';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type {
  PairingCodePresentation,
  RecoveryCodePresentation,
  RecoveryStartResult,
} from './lifecycle';
import {
  createDefaultSyncUiServices,
  type EnableLifecyclePort,
  type ExistingDevicePairingLifecyclePort,
  type NewDevicePairingLifecyclePort,
  type RecoverDeviceLifecyclePort,
  type SyncUiLocalStatus,
  type SyncUiServices,
} from './ui-services';
import { formatDateTime, safeErrorMessage, truncateOpaqueId, useLocalQr } from './ui/helpers';
import { BackToChoices, BusyIcon, InlineError, RecoveryCodeStep, SectionTitle } from './ui/shared';
import { useSnapshotSyncScheduler } from './scheduler';
import { CLOUD_VAULT_DELETE_CONFIRMATION } from './device-security-service';
import type { TurnstilePhase, TurnstileViewState } from './turnstile-client';
import type { BetaDiagnosticsSnapshot } from './diagnostics';
import { APPLICATION_VERSION } from '@/lib/version';
import { SyncApiError, type VerificationReason } from './api';

type EmptyMode = 'choose' | 'enable' | 'pair-new' | 'recover';

const TURNSTILE_STATUS: Readonly<Record<TurnstilePhase, string>> = {
  idle: 'Provera će se pokrenuti kada zatražite aktivaciju, uparivanje ili oporavak.',
  'script-loading': 'Učitavam Cloudflare bezbednosnu proveru…',
  'widget-ready': 'Bezbednosna provera je spremna.',
  waiting: 'Dovršite proveru prikazanu ispod.',
  'token-received': 'Cloudflare rezultat je primljen. Server ga sada proverava…',
  'server-verifying': 'Cloudflare rezultat je primljen. Server ga sada proverava…',
  success: 'Bezbednosna provera je prihvaćena.',
  expired: 'Provera je istekla. Pripremite novu proveru i ponovite poslednju radnju.',
  rejected: 'Provera nije prihvaćena. Pripremite novu proveru i ponovite poslednju radnju.',
  'network-error': 'Mreža je prekinula proveru. Pripremite novu proveru kada veza proradi.',
  'configuration-error':
    'Provera nije pravilno učitana ili podešena. Kopirajte dijagnostiku za podršku.',
};

const RETRYABLE_TURNSTILE_PHASES = new Set<TurnstilePhase>([
  'expired',
  'rejected',
  'network-error',
  'configuration-error',
]);

const VERIFICATION_REASON_STATUS: Readonly<Record<VerificationReason, string>> = {
  INVALID_INPUT_RESPONSE:
    'Cloudflare je odbio rezultat provere. Napravite novu proveru i pokušajte ponovo.',
  TIMEOUT_OR_DUPLICATE:
    'Provera je istekla ili je isti rezultat već iskorišćen. Potrebna je potpuno nova provera.',
  HOSTNAME_MISMATCH: 'Beta klijent i server nisu usklađeni. Kopirajte Request ID i Support ID.',
  ACTION_MISMATCH: 'Beta klijent i server nisu usklađeni. Kopirajte Request ID i Support ID.',
  SITEVERIFY_UNAVAILABLE:
    'Cloudflare provera trenutno nije dostupna. Pokušajte ponovo kada veza proradi.',
  CONFIGURATION_ERROR:
    'Beta bezbednosna provera nije pravilno podešena. Kopirajte Request ID i Support ID.',
};

const TurnstileCard = ({ services }: { services: SyncUiServices }) => {
  const turnstile = services.turnstile;
  const [state, setState] = useState<TurnstileViewState>(
    () => turnstile?.state ?? { phase: 'idle' },
  );
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      turnstile?.attach(node);
    },
    [turnstile],
  );

  useEffect(() => {
    if (!turnstile) return;
    return turnstile.subscribe(setState);
  }, [turnstile]);

  if (!turnstile) return null;
  const isError = RETRYABLE_TURNSTILE_PHASES.has(state.phase);

  return (
    <Card className="grid gap-3 border-accent/25" data-testid="sync-turnstile-card">
      <div>
        <SectionTitle>Bezbednosna provera</SectionTitle>
        <p className="mt-2 text-sm leading-6 text-muted">
          Cloudflare proverava da zahtev ne šalje automatizovani program. Provera ne dobija vaše
          finansijske podatke.
        </p>
      </div>
      <p
        role={isError ? 'alert' : 'status'}
        className={
          isError
            ? 'rounded-xl bg-danger-soft p-3 text-sm text-danger'
            : 'rounded-xl bg-surface-2 p-3 text-sm text-muted'
        }
      >
        {state.verificationReason
          ? VERIFICATION_REASON_STATUS[state.verificationReason]
          : TURNSTILE_STATUS[state.phase]}
        {state.requestId ? (
          <span className="mt-1 block font-mono text-xs">Request ID: {state.requestId}</span>
        ) : null}
      </p>
      <div
        ref={attach}
        data-testid="sync-turnstile-widget"
        aria-label="Cloudflare bezbednosna provera"
        className="min-h-[70px] min-w-0 max-w-full overflow-hidden rounded-xl bg-white p-1"
      />
    </Card>
  );
};

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
        <SectionTitle>Beta dijagnostika</SectionTitle>
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
              ? `${health.status}; D1 ${health.services.d1}; R2 ${health.services.r2}`
              : 'Nije dostupan'}
          </dd>
        </div>
      </dl>
      <div className="grid gap-1 text-xs leading-5 text-muted">
        <p>
          Poslednja greška: {latestError?.safeCode ?? latestError?.eventType ?? 'nema'}
          {latestError?.verificationReason ? ` — ${latestError.verificationReason}` : ''}
        </p>
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

const EmptyModeChooser = ({
  preOnboarding,
  onChoose,
}: {
  preOnboarding: boolean;
  onChoose: (mode: EmptyMode) => void;
}) => (
  <div className="grid gap-3">
    {!preOnboarding ? (
      <button
        type="button"
        onClick={() => onChoose('enable')}
        className="min-h-24 rounded-card border bg-surface p-4 text-left transition hover:bg-surface-2"
      >
        <span className="flex items-center gap-2 font-bold">
          <ShieldCheck size={19} className="text-accent" aria-hidden="true" /> Uključi na prvom
          uređaju
        </span>
        <span className="mt-1 block text-sm leading-6 text-muted">
          Napravite novi šifrovani trezor i recovery kod. Prvi prenos zahteva posebnu saglasnost.
        </span>
      </button>
    ) : null}
    <button
      type="button"
      onClick={() => onChoose('pair-new')}
      className="min-h-24 rounded-card border bg-surface p-4 text-left transition hover:bg-surface-2"
    >
      <span className="flex items-center gap-2 font-bold">
        <Smartphone size={19} className="text-accent" aria-hidden="true" /> Poveži ovaj uređaj
      </span>
      <span className="mt-1 block text-sm leading-6 text-muted">
        Napravite zahtev, pa ga odobrite na već povezanom uređaju.
      </span>
    </button>
    <button
      type="button"
      onClick={() => onChoose('recover')}
      className="min-h-24 rounded-card border bg-surface p-4 text-left transition hover:bg-surface-2"
    >
      <span className="flex items-center gap-2 font-bold">
        <KeyRound size={19} className="text-accent" aria-hidden="true" /> Izgubljeni su svi uređaji
      </span>
      <span className="mt-1 block text-sm leading-6 text-muted">
        Upotrebite recovery kod. Sva stara ovlašćenja biće opozvana i dobićete novi kod.
      </span>
    </button>
    {preOnboarding ? (
      <p className="rounded-xl bg-warning-soft p-3 text-xs leading-5 text-warning">
        Posle uparivanja Mirna preuzima samo E2EE snapshot i proverava ga pre lokalne primene.
      </p>
    ) : null}
  </div>
);

const EnablePanel = ({
  services,
  onActivated,
  onBack,
}: {
  services: SyncUiServices;
  onActivated: () => Promise<void>;
  onBack: () => void;
}) => {
  const { success } = useToast();
  const lifecycle = useRef<EnableLifecyclePort | null>(null);
  const [deviceName, setDeviceName] = useState('Moj uređaj');
  const [capability, setCapability] = useState<'idle' | 'checking' | 'supported' | 'unsupported'>(
    'idle',
  );
  const [presentation, setPresentation] = useState<RecoveryCodePresentation>();
  const [confirmationValues, setConfirmationValues] = useState<Record<number, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activationRetryAvailable, setActivationRetryAvailable] = useState(false);
  const activationInFlight = useRef(false);

  const checkCapability = async () => {
    setCapability('checking');
    setError('');
    try {
      const result = await services.probeCapability();
      setCapability(result.supported ? 'supported' : 'unsupported');
    } catch {
      setCapability('unsupported');
    }
  };

  const begin = async () => {
    if (capability !== 'supported' || busy) return;
    setBusy(true);
    setError('');
    const nextLifecycle = services.createEnableLifecycle();
    lifecycle.current = nextLifecycle;
    try {
      setPresentation(await nextLifecycle.begin(deviceName));
      setConfirmationValues({});
    } catch (caught) {
      lifecycle.current = null;
      setError(safeErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!presentation || !lifecycle.current || busy) return;
    setBusy(true);
    setError('');
    try {
      await lifecycle.current.confirmRecoveryCode(
        presentation.confirmationGroupNumbers.map((groupNumber) => ({
          groupNumber,
          value: confirmationValues[groupNumber] ?? '',
        })),
      );
      setConfirmed(true);
      success('Sačuvani recovery kod je potvrđen.');
    } catch (caught) {
      setError(safeErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    if (!confirmed || !lifecycle.current || busy || activationInFlight.current) return;
    activationInFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await lifecycle.current.activate();
      setActivationRetryAvailable(false);
      setPresentation(undefined);
      setConfirmationValues({});
      success('Šifrovana sinhronizacija je aktivirana na ovom uređaju.');
      await onActivated();
    } catch (caught) {
      setActivationRetryAvailable(
        caught instanceof SyncApiError &&
          (caught.code.startsWith('TURNSTILE_') ||
            caught.code.startsWith('HUMAN_VERIFICATION_') ||
            caught.code === 'NETWORK_FAILURE' ||
            caught.code === 'REQUEST_TIMEOUT'),
      );
      setError(safeErrorMessage(caught));
    } finally {
      activationInFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      {!presentation ? <BackToChoices onClick={onBack} /> : null}
      <Card className="grid gap-4">
        <div>
          <SectionTitle>Uključivanje na prvom uređaju</SectionTitle>
          <p className="mt-2 text-sm leading-6 text-muted">
            Mirna pravi ključeve lokalno. Server dobija samo šifrovane pakete i javne podatke
            potrebne za proveru uređaja. U ovoj fazi aktivirate bezbedni trezor; prvi prenos
            finansijskih podataka zahtevaće posebnu saglasnost u narednoj beta fazi.
          </p>
        </div>
        <div className="rounded-xl bg-surface-2 p-3 text-sm">
          {capability === 'idle' ? (
            <p className="leading-6 text-muted">
              Pre početka proverićemo da li pregledač bezbedno čuva neizvozive CryptoKey ključeve
              kroz ponovno otvaranje lokalne baze.
            </p>
          ) : null}
          {capability === 'checking' ? (
            <p role="status" className="flex items-center gap-2 font-semibold">
              <BusyIcon /> Proveravam lokalnu zaštitu ključeva…
            </p>
          ) : null}
          {capability === 'supported' ? (
            <p role="status" className="flex items-center gap-2 font-semibold text-accent">
              <CheckCircle2 size={18} aria-hidden="true" /> Pregledač je prošao lokalnu proveru.
            </p>
          ) : null}
          {capability === 'unsupported' ? (
            <p role="alert" className="flex items-start gap-2 font-semibold text-danger">
              <ShieldX size={18} className="mt-0.5 shrink-0" aria-hidden="true" /> Ovaj pregledač
              nije prošao bezbednu proveru. Sinhronizacija se ovde neće uključiti i nema slabijeg
              načina čuvanja ključeva.
            </p>
          ) : null}
        </div>
        {capability !== 'supported' ? (
          <Button
            variant="secondary"
            onClick={() => void checkCapability()}
            disabled={capability === 'checking'}
          >
            {capability === 'checking' ? (
              <BusyIcon />
            ) : (
              <ShieldCheck size={17} aria-hidden="true" />
            )}
            Proveri ovaj uređaj
          </Button>
        ) : null}
        {capability === 'supported' && !presentation ? (
          <>
            <Field
              label="Naziv ovog uređaja"
              hint="Naziv ostaje lokalni; povezani uređaji se u protokolu prepoznaju po nečitljivom ID-u."
            >
              <Input
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                maxLength={80}
                autoComplete="off"
              />
            </Field>
            <Button onClick={() => void begin()} disabled={busy || deviceName.trim().length === 0}>
              {busy ? <BusyIcon /> : <KeyRound size={17} aria-hidden="true" />}
              Napravi recovery kod
            </Button>
          </>
        ) : null}
      </Card>

      {presentation ? (
        <RecoveryCodeStep
          title="Sačuvajte svoj recovery kod"
          presentation={presentation}
          values={confirmationValues}
          onValueChange={(groupNumber, value) =>
            setConfirmationValues((current) => ({ ...current, [groupNumber]: value }))
          }
          services={services}
        />
      ) : null}

      {presentation && !confirmed ? (
        <Button onClick={() => void confirm()} disabled={busy}>
          {busy ? <BusyIcon /> : <CheckCircle2 size={17} aria-hidden="true" />}
          Potvrdi sačuvani kod
        </Button>
      ) : null}
      {presentation && confirmed ? (
        <Card className="grid gap-3 border-accent/30 bg-accent-soft/30">
          <p className="text-sm leading-6">
            Kod je potvrđen. Aktivacija sada registruje javni manifest i šifrovani recovery paket;
            finansijski podaci se ne šalju.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button onClick={() => void activate()} disabled={busy}>
              {busy ? <BusyIcon /> : <ShieldCheck size={17} aria-hidden="true" />}
              {activationRetryAvailable
                ? 'Pokušaj aktivaciju ponovo'
                : 'Aktiviraj šifrovanu sinhronizaciju'}
            </Button>
            {activationRetryAvailable ? (
              <Button variant="ghost" disabled={busy} onClick={onBack}>
                Odustani
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}
      <InlineError message={error} />
    </div>
  );
};

type NewPairingStage = 'idle' | 'pending' | 'sas' | 'ended';

const NewDevicePairingPanel = ({
  services,
  onActivated,
  onBack,
}: {
  services: SyncUiServices;
  onActivated: () => Promise<void>;
  onBack: () => void;
}) => {
  const { success } = useToast();
  const lifecycle = useRef<NewDevicePairingLifecyclePort | null>(null);
  const pollInFlight = useRef(false);
  const [deviceName, setDeviceName] = useState('Novi uređaj');
  const [presentation, setPresentation] = useState<PairingCodePresentation>();
  const [stage, setStage] = useState<NewPairingStage>('idle');
  const [sas, setSas] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const qrDataUrl = useLocalQr(presentation?.qrPayload, services);

  const poll = useCallback(async () => {
    if (stage !== 'pending' || !lifecycle.current || pollInFlight.current) return;
    pollInFlight.current = true;
    setError('');
    try {
      const result = await lifecycle.current.poll();
      if (result.status === 'sas-required') {
        setSas(result.sas);
        setStage('sas');
      } else if (result.status === 'ended') {
        setPresentation(undefined);
        setStage('ended');
        setError('Zahtev za povezivanje više nije aktivan. Napravite novi zahtev.');
      }
    } catch (caught) {
      const terminalState = lifecycle.current?.state;
      if (terminalState === 'cancelled' || terminalState === 'ended') {
        setPresentation(undefined);
        setSas('');
        setStage('ended');
      }
      setError(safeErrorMessage(caught));
    } finally {
      pollInFlight.current = false;
    }
  }, [stage]);

  useEffect(() => {
    if (stage !== 'pending') return;
    const timer = window.setInterval(() => {
      void poll();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [poll, stage]);

  useEffect(
    () => () => {
      const activeLifecycle = lifecycle.current;
      if (
        activeLifecycle &&
        activeLifecycle.state !== 'cancelled' &&
        activeLifecycle.state !== 'ended' &&
        activeLifecycle.state !== 'active'
      ) {
        void activeLifecycle.cancel().catch(() => undefined);
      }
    },
    [],
  );

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setSas('');
    const nextLifecycle = services.createNewDevicePairingLifecycle();
    lifecycle.current = nextLifecycle;
    try {
      setPresentation(await nextLifecycle.start(deviceName));
      setStage('pending');
    } catch (caught) {
      try {
        await nextLifecycle.cancel();
      } catch {
        // The lifecycle always clears local pairing material when cancellation was possible.
      }
      lifecycle.current = null;
      setError(safeErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (mismatch = false) => {
    if (!lifecycle.current || busy) return;
    setBusy(true);
    setError('');
    try {
      await lifecycle.current.cancel();
      success(mismatch ? 'Zahtev je otkazan jer se SAS ne poklapa.' : 'Zahtev je otkazan.');
    } catch {
      setError('Lokalni podaci zahteva su odbačeni. Server možda čeka da zahtev istekne.');
    } finally {
      lifecycle.current = null;
      setPresentation(undefined);
      setSas('');
      setStage('idle');
      setBusy(false);
    }
  };

  const confirmSas = async () => {
    if (!lifecycle.current || !sas || busy) return;
    setBusy(true);
    setError('');
    try {
      await lifecycle.current.confirmSas(sas);
      setPresentation(undefined);
      setSas('');
      success('Ovaj uređaj je bezbedno povezan.');
      await onActivated();
    } catch (caught) {
      const terminalState = lifecycle.current?.state;
      if (terminalState === 'cancelled' || terminalState === 'ended') {
        setPresentation(undefined);
        setSas('');
        setStage('ended');
      }
      setError(safeErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      {stage === 'idle' || stage === 'ended' ? <BackToChoices onClick={onBack} /> : null}
      <Card className="grid gap-4">
        <div>
          <SectionTitle>Povežite ovaj uređaj</SectionTitle>
          <p className="mt-2 text-sm leading-6 text-muted">
            Napravite kratkotrajan zahtev. Na već povezanom uređaju otvorite Sinhronizaciju,
            nalepite QR sadržaj ili ručni kod i uporedite SAS na oba ekrana.
          </p>
        </div>
        {stage === 'idle' || stage === 'ended' ? (
          <>
            <Field label="Naziv ovog uređaja">
              <Input
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                maxLength={80}
                autoComplete="off"
              />
            </Field>
            <Button onClick={() => void start()} disabled={busy || deviceName.trim().length === 0}>
              {busy ? <BusyIcon /> : <QrCode size={17} aria-hidden="true" />}
              Napravi zahtev za povezivanje
            </Button>
          </>
        ) : null}

        {presentation ? (
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,16rem)_1fr] sm:items-start">
              <div className="grid min-h-64 place-items-center rounded-2xl bg-white p-3">
                {qrDataUrl ? (
                  <img
                    data-testid="sync-pairing-qr"
                    src={qrDataUrl}
                    alt="QR kod zahteva za povezivanje"
                    className="size-full max-h-60 max-w-60"
                  />
                ) : (
                  <p role="status" className="text-sm text-muted">
                    Pripremam lokalni QR kod…
                  </p>
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold">Ručni kod</p>
                <code
                  data-testid="sync-pairing-code"
                  className="mt-2 block max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-surface-2 p-3 text-xs leading-6 select-all"
                >
                  {presentation.pairingCode}
                </code>
                <p className="mt-2 text-xs leading-5 text-muted">
                  Važi do {formatDateTime(presentation.expiresAt)}. Delite ga samo sa uređajem koji
                  upravo povezujete.
                </p>
              </div>
            </div>
            {stage === 'pending' ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button variant="secondary" onClick={() => void poll()} disabled={busy}>
                  <RefreshCw size={16} aria-hidden="true" /> Proveri odgovor
                </Button>
                <Button variant="ghost" onClick={() => void cancel()} disabled={busy}>
                  Otkaži zahtev
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      {stage === 'sas' && sas ? (
        <Card className="grid gap-4 border-warning/40">
          <div>
            <SectionTitle>Uporedite SAS na oba uređaja</SectionTitle>
            <p className="mt-2 text-sm leading-6 text-muted">
              Potvrdite samo ako su sve grupe potpuno iste. Ne čitajte vrednost trećoj osobi.
            </p>
          </div>
          <p
            data-testid="sync-new-device-sas"
            className="rounded-xl bg-surface-2 px-3 py-4 text-center font-mono text-xl font-black tracking-wider break-words"
          >
            {sas}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button onClick={() => void confirmSas()} disabled={busy}>
              {busy ? <BusyIcon /> : <CheckCircle2 size={17} aria-hidden="true" />}
              Poklapaju se — poveži
            </Button>
            <Button variant="danger" onClick={() => void cancel(true)} disabled={busy}>
              <ShieldX size={17} aria-hidden="true" /> Ne poklapaju se — otkaži
            </Button>
          </div>
        </Card>
      ) : null}
      <InlineError message={error} />
    </div>
  );
};

const RecoveryPanel = ({
  services,
  onActivated,
  onBack,
}: {
  services: SyncUiServices;
  onActivated: () => Promise<void>;
  onBack: () => void;
}) => {
  const { success } = useToast();
  const lifecycle = useRef<RecoverDeviceLifecyclePort | null>(null);
  const [deviceName, setDeviceName] = useState('Oporavljeni uređaj');
  const [oldRecoveryCode, setOldRecoveryCode] = useState('');
  const [showOldCode, setShowOldCode] = useState(false);
  const [presentation, setPresentation] = useState<RecoveryStartResult>();
  const [confirmationValues, setConfirmationValues] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const begin = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    const nextLifecycle = services.createRecoveryLifecycle();
    lifecycle.current = nextLifecycle;
    try {
      const result = await nextLifecycle.begin(oldRecoveryCode, deviceName);
      setOldRecoveryCode('');
      setShowOldCode(false);
      setPresentation(result);
      setConfirmationValues({});
    } catch (caught) {
      lifecycle.current = null;
      setError(safeErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!presentation || !lifecycle.current || busy) return;
    setBusy(true);
    setError('');
    try {
      await lifecycle.current.confirmNewRecoveryCode(
        presentation.confirmationGroupNumbers.map((groupNumber) => ({
          groupNumber,
          value: confirmationValues[groupNumber] ?? '',
        })),
      );
      setPresentation(undefined);
      setConfirmationValues({});
      success('Oporavak je završen. Stari uređaji više nisu ovlašćeni.');
      await onActivated();
    } catch (caught) {
      setError(safeErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      {!presentation ? <BackToChoices onClick={onBack} /> : null}
      {!presentation ? (
        <Card className="grid gap-4">
          <div>
            <SectionTitle>Oporavak posle gubitka svih uređaja</SectionTitle>
            <p className="mt-2 text-sm leading-6 text-muted">
              Recovery kod potvrđuje da ste vlasnik šifrovanog trezora. Uspešan oporavak rotira
              ključ i opoziva sva ranija ovlašćenja uređaja.
            </p>
          </div>
          <Field label="Naziv ovog uređaja">
            <Input
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              maxLength={80}
              autoComplete="off"
            />
          </Field>
          <Field label="Postojeći recovery kod">
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                type={showOldCode ? 'text' : 'password'}
                value={oldRecoveryCode}
                onChange={(event) => setOldRecoveryCode(event.target.value.trim())}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
              />
              <Button variant="secondary" onClick={() => setShowOldCode((current) => !current)}>
                {showOldCode ? 'Sakrij' : 'Prikaži'}
              </Button>
            </div>
          </Field>
          <Button
            onClick={() => void begin()}
            disabled={busy || !oldRecoveryCode || deviceName.trim().length === 0}
          >
            {busy ? <BusyIcon /> : <KeyRound size={17} aria-hidden="true" />}
            Proveri kod i pripremi oporavak
          </Button>
        </Card>
      ) : (
        <>
          <p className="rounded-xl bg-warning-soft p-3 text-sm leading-6 text-warning">
            Stari recovery kod prestaje da važi kada završite ovaj korak. Sačuvajte novi kod pre
            potvrde.
          </p>
          <RecoveryCodeStep
            title="Sačuvajte novi recovery kod"
            presentation={presentation}
            values={confirmationValues}
            onValueChange={(groupNumber, value) =>
              setConfirmationValues((current) => ({ ...current, [groupNumber]: value }))
            }
            services={services}
          />
          <Button onClick={() => void finish()} disabled={busy}>
            {busy ? <BusyIcon /> : <ShieldCheck size={17} aria-hidden="true" />}
            Potvrdi novi kod i završi oporavak
          </Button>
        </>
      )}
      <InlineError message={error} />
    </div>
  );
};

interface PreparedExistingPairing {
  readonly deviceId: string;
  readonly expiresAt: string;
  readonly sas: string;
}

const ExistingDeviceApproval = ({ services }: { services: SyncUiServices }) => {
  const { success } = useToast();
  const lifecycle = useRef<ExistingDevicePairingLifecyclePort | null>(null);
  const [code, setCode] = useState('');
  const [prepared, setPrepared] = useState<PreparedExistingPairing>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const inspect = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    const nextLifecycle = services.createExistingDevicePairingLifecycle();
    lifecycle.current = nextLifecycle;
    try {
      const result = await nextLifecycle.prepare(code.trim());
      setCode('');
      setPrepared({
        deviceId: result.candidate.deviceId,
        expiresAt: result.candidate.expiresAt,
        sas: result.sas,
      });
    } catch (caught) {
      lifecycle.current = null;
      setError(safeErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!prepared || !lifecycle.current || busy) return;
    setBusy(true);
    setError('');
    try {
      await lifecycle.current.approve(prepared.sas);
      setPrepared(undefined);
      lifecycle.current = null;
      success('Zahtev je odobren. Potvrdite isti SAS i na novom uređaju.');
    } catch (caught) {
      setError(safeErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const reject = () => {
    if (!lifecycle.current) return;
    lifecycle.current.reject();
    lifecycle.current = null;
    setPrepared(undefined);
    success('Zahtev nije odobren.');
  };

  return (
    <Card className="grid gap-4">
      <div>
        <SectionTitle>Dodajte drugi uređaj</SectionTitle>
        <p className="mt-2 text-sm leading-6 text-muted">
          Na novom uređaju napravite zahtev, zatim ovde nalepite sadržaj QR koda ili ručni kod.
        </p>
      </div>
      {!prepared ? (
        <>
          <Field label="QR sadržaj ili ručni kod">
            <Textarea
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="Nalepite kod sa novog uređaja"
            />
          </Field>
          <Button onClick={() => void inspect()} disabled={busy || code.trim().length === 0}>
            {busy ? <BusyIcon /> : <QrCode size={17} aria-hidden="true" />}
            Proveri zahtev lokalno i na serveru
          </Button>
        </>
      ) : (
        <div className="grid gap-4">
          <div className="rounded-xl bg-surface-2 p-3 text-sm leading-6">
            <p>
              Predloženi uređaj: <strong>{truncateOpaqueId(prepared.deviceId)}</strong>
            </p>
            <p className="text-muted">Zahtev važi do {formatDateTime(prepared.expiresAt)}.</p>
          </div>
          <div>
            <p className="text-sm font-bold">SAS za poređenje</p>
            <p
              data-testid="sync-existing-device-sas"
              className="mt-2 rounded-xl bg-warning-soft p-4 text-center font-mono text-xl font-black tracking-wider text-warning break-words"
            >
              {prepared.sas}
            </p>
            <p className="mt-2 text-xs leading-5 text-muted">
              Odobrite samo ako su sve grupe potpuno iste na novom uređaju.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button onClick={() => void approve()} disabled={busy}>
              {busy ? <BusyIcon /> : <CheckCircle2 size={17} aria-hidden="true" />}
              Poklapa se — odobri
            </Button>
            <Button variant="danger" onClick={reject} disabled={busy}>
              <ShieldX size={17} aria-hidden="true" /> Ne poklapa se — odbij
            </Button>
          </div>
        </div>
      )}
      <InlineError message={error} />
    </Card>
  );
};

const ActivePanel = ({
  status,
  services,
  preOnboarding,
  onDisabled,
  onChanged,
}: {
  status: SyncUiLocalStatus & { readonly setup: LocalSyncSetup };
  services: SyncUiServices;
  preOnboarding: boolean;
  onDisabled: () => Promise<void>;
  onChanged: () => Promise<void>;
}) => {
  const { success } = useToast();
  const [showDisable, setShowDisable] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflictResolution, setConflictResolution] = useState<{
    mutationGroupId: string;
    selection: 'local' | 'remote';
  }>();
  const [renewDeviceId, setRenewDeviceId] = useState<string>();
  const [revokeDeviceId, setRevokeDeviceId] = useState<string>();
  const [recoveryCode, setRecoveryCode] = useState('');
  const [revokeConfirmation, setRevokeConfirmation] = useState('');
  const [showCloudDelete, setShowCloudDelete] = useState(false);
  const [cloudRecoveryCode, setCloudRecoveryCode] = useState('');
  const [cloudDeleteConfirmation, setCloudDeleteConfirmation] = useState('');
  const { setup } = status;
  const authorizationExpired = Date.parse(setup.device.authorizationExpiresAt) <= Date.now();
  const disablePhrase = 'ISKLJUČI OVAJ UREĐAJ';
  const revokePhrase = 'OPOZOVI UREĐAJ';

  const synchronize = async (allowInitialUpload = false, forceCompaction = false) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await services.synchronize(allowInitialUpload, forceCompaction);
      if (result.kind === 'blocked') {
        setError(
          'Sinhronizacija je bezbedno zaustavljena zbog konflikta ili neočekivanog remote stanja.',
        );
      } else if (result.kind === 'awaiting-upload-consent') {
        setError('Prvi upload čeka vašu eksplicitnu saglasnost.');
      } else if (result.kind === 'consent-declined') {
        setError('Prvi upload je odbijen na ovom uređaju.');
      } else if (result.kind === 'synchronized') {
        success(
          result.conflictedGroups > 0
            ? 'Promene su prenete; jedan konflikt zahteva pregled.'
            : result.uploadedOperations + result.downloadedOperations > 0
              ? 'Šifrovane promene su sinhronizovane.'
              : 'Sinhronizovano.',
        );
      } else {
        success(
          result.kind === 'uploaded'
            ? 'Šifrovani snapshot je uspešno poslat.'
            : result.kind === 'downloaded'
              ? 'Šifrovani snapshot je proveren i primenjen.'
              : 'Podaci su već sinhronizovani.',
        );
      }
      await onChanged();
    } catch (caught) {
      setError(safeErrorMessage(caught));
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (confirmation !== disablePhrase || busy) return;
    setBusy(true);
    setError('');
    try {
      services.clearSession();
      await services.disableLocalDevice();
      setConfirmation('');
      setShowDisable(false);
      success('Lokalni sync ključevi i podešavanje su uklonjeni sa ovog uređaja.');
      await onDisabled();
    } catch {
      setError('Lokalno isključivanje nije uspelo. Podaci nisu namerno delimično uklonjeni.');
    } finally {
      setBusy(false);
    }
  };

  const operationConflictGroups = useMemo(() => {
    const groups = new Map<string, typeof status.pendingConflicts>();
    for (const conflict of status.pendingConflicts) {
      if (!conflict.mutationGroupId) continue;
      groups.set(conflict.mutationGroupId, [
        ...(groups.get(conflict.mutationGroupId) ?? []),
        conflict,
      ]);
    }
    return [...groups.entries()];
  }, [status]);
  const snapshotConflicts = status.pendingConflicts.filter(
    (conflict) => conflict.entityType === 'snapshot',
  );

  const resolveConflict = async () => {
    if (!conflictResolution) return;
    await services.resolveConflictGroup(
      setup.vault.vaultId,
      conflictResolution.mutationGroupId,
      conflictResolution.selection,
    );
    success('Rezolucija je sačuvana kao nova lokalna sync operacija.');
    await onChanged();
  };

  const renewDevice = async () => {
    if (!renewDeviceId || busy) return;
    setBusy(true);
    setError('');
    try {
      await services.renewDevice(renewDeviceId);
      success('Ovlašćenje uređaja je obnovljeno u potpisanom manifestu.');
      setRenewDeviceId(undefined);
      await onChanged();
    } catch (caught) {
      setError(safeErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const revokeDevice = async () => {
    if (
      !revokeDeviceId ||
      busy ||
      recoveryCode.length === 0 ||
      revokeConfirmation !== revokePhrase
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await services.secureRevokeDevice(revokeDeviceId, recoveryCode);
      success('Uređaj je opozvan, ključ rotiran i novi šifrovani snapshot je potvrđen.');
      setRevokeDeviceId(undefined);
      setRecoveryCode('');
      setRevokeConfirmation('');
      await onChanged();
    } catch (caught) {
      setRecoveryCode('');
      setError(safeErrorMessage(caught));
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const deleteCloudVault = async () => {
    if (
      busy ||
      cloudRecoveryCode.length === 0 ||
      cloudDeleteConfirmation !== CLOUD_VAULT_DELETE_CONFIRMATION
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await services.deleteCloudVault(cloudRecoveryCode, cloudDeleteConfirmation);
      setCloudRecoveryCode('');
      setCloudDeleteConfirmation('');
      success('Šifrovani cloud trezor je obrisan. Lokalni finansijski podaci su sačuvani.');
      await onDisabled();
    } catch (caught) {
      setCloudRecoveryCode('');
      setError(safeErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-5">
      <Card className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <SectionTitle>Ovaj uređaj je povezan</SectionTitle>
            <p className="mt-1 text-sm text-muted">{setup.device.displayName}</p>
          </div>
          <StatusBadge tone={authorizationExpired ? 'warning' : 'positive'}>
            {authorizationExpired ? 'Ovlašćenje je isteklo' : 'Aktivno'}
          </StatusBadge>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-xl bg-surface-2 p-3">
            <dt className="text-xs font-semibold text-muted">ID ovog uređaja</dt>
            <dd className="mt-1 font-mono font-bold">{truncateOpaqueId(setup.device.deviceId)}</dd>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <dt className="text-xs font-semibold text-muted">Ovlašćen do</dt>
            <dd className="mt-1 font-bold">
              {formatDateTime(setup.device.authorizationExpiresAt)}
            </dd>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <dt className="text-xs font-semibold text-muted">Poslednja sinhronizacija</dt>
            <dd className="mt-1 font-bold">
              {formatDateTime(setup.metadata.lastSuccessfulSyncAt ?? setup.metadata.lastSyncAt)}
            </dd>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <dt className="text-xs font-semibold text-muted">Nerešeni konflikti</dt>
            <dd className="mt-1 font-bold">{status.pendingConflictCount}</dd>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <dt className="text-xs font-semibold text-muted">Lokalne promene na čekanju</dt>
            <dd className="mt-1 font-bold">{status.pendingLocalOperationCount}</dd>
          </div>
        </dl>
        {navigator.onLine === false ? (
          <p role="status" className="rounded-xl bg-warning-soft p-3 text-sm text-warning">
            Nema mreže — promene ostaju na ovom uređaju.
          </p>
        ) : status.pendingLocalOperationCount > 0 ? (
          <p role="status" className="rounded-xl bg-surface-2 p-3 text-sm text-muted">
            Čekaju {status.pendingLocalOperationCount} lokalne promene.
          </p>
        ) : status.pendingConflictCount === 0 && setup.metadata.lastSuccessfulSyncAt ? (
          <p role="status" className="rounded-xl bg-accent-soft p-3 text-sm text-accent">
            Sinhronizovano.
          </p>
        ) : null}
        {setup.metadata.firstUploadConsent === 'pending' ? (
          <div className="grid gap-3 rounded-xl bg-warning-soft p-3 text-sm leading-6 text-warning">
            <p>
              Prvi upload čeka posebnu saglasnost. Mirna će lokalno napraviti snapshot, kompresovati
              ga i šifrovati pre slanja; server ne dobija čitljive finansijske podatke.
            </p>
            <Button disabled={busy} onClick={() => void synchronize(true)}>
              {busy ? <BusyIcon /> : <CloudUpload size={17} aria-hidden="true" />}
              Saglasan sam — pošalji prvi šifrovani snapshot
            </Button>
          </div>
        ) : null}
        {setup.metadata.syncBlockReason ? (
          <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm leading-6 text-danger">
            Automatska sinhronizacija je zaustavljena: {setup.metadata.syncBlockReason}. Lokalni
            podaci nisu prepisani.
          </p>
        ) : null}
        <Button
          variant="secondary"
          disabled={busy || Boolean(setup.metadata.syncBlockReason)}
          onClick={() => void synchronize(false, true)}
        >
          {busy ? <BusyIcon /> : <RefreshCw size={17} aria-hidden="true" />}
          Sinhronizuj sada
        </Button>
      </Card>

      {status.pendingConflictCount > 0 ? (
        <Card className="grid gap-4 border-warning/30">
          <div>
            <SectionTitle>Postoje promene na oba uređaja</SectionTitle>
            <p className="mt-2 text-sm leading-6 text-muted">
              Mirna nije izabrala poslednju izmenu automatski. Pregledajte predloge i eksplicitno
              izaberite ishod; rezolucija će postati nova potpisana operacija.
            </p>
          </div>
          {operationConflictGroups.map(([mutationGroupId, conflicts]) => (
            <div key={mutationGroupId} className="grid gap-3 rounded-xl bg-surface-2 p-3">
              <div>
                <p className="text-sm font-bold">
                  Konfliktna radnja ({conflicts.length}{' '}
                  {conflicts.length === 1 ? 'entitet' : 'entiteta'})
                </p>
                <ul className="mt-2 grid gap-1 text-xs text-muted">
                  {conflicts.map((conflict) => (
                    <li key={conflict.id}>
                      {conflict.entityType}: {truncateOpaqueId(conflict.entityId)}
                    </li>
                  ))}
                </ul>
              </div>
              <details className="rounded-xl border bg-surface p-3 text-xs">
                <summary className="min-h-8 cursor-pointer font-bold">Pregled predloga</summary>
                <div className="mt-3 grid gap-3">
                  {conflicts.map((conflict) => (
                    <div key={conflict.id} className="min-w-0">
                      <p className="font-bold">{conflict.entityType}</p>
                      <p className="mt-2 text-muted">Lokalni predlog</p>
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background p-2">
                        {conflict.localCanonicalProposal}
                      </pre>
                      <p className="mt-2 text-muted">Predlog drugog uređaja</p>
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background p-2">
                        {conflict.remoteCanonicalProposal}
                      </pre>
                    </div>
                  ))}
                </div>
              </details>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  variant="secondary"
                  onClick={() => setConflictResolution({ mutationGroupId, selection: 'local' })}
                >
                  Zadrži trenutno lokalno
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setConflictResolution({ mutationGroupId, selection: 'remote' })}
                >
                  Prihvati predlog drugog uređaja
                </Button>
              </div>
            </div>
          ))}
          {snapshotConflicts.length > 0 ? (
            <div className="rounded-xl bg-warning-soft p-3 text-sm leading-6 text-warning">
              <p className="font-bold">Snapshot konflikt ostaje blokiran.</p>
              <p>
                Prvo preuzmite lokalni backup, zatim otkažite ili nastavite tek posle ručnog
                pregleda. Lokalni podaci nisu prepisani.
              </p>
              <Link to="/more/data" className="mt-2 inline-flex min-h-11 items-center font-bold">
                Otvori backup i izvoz
              </Link>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card className="p-0">
        <div className="border-b p-4">
          <SectionTitle>Povezani uređaji</SectionTitle>
          <p className="mt-1 text-xs leading-5 text-muted">
            Prikazani su skraćeni, nečitljivi protokolski ID-jevi — ne nazivi uređaja.
          </p>
        </div>
        <ul className="divide-y">
          {setup.vault.manifest.devices.map((device) => {
            const isLocal = device.deviceId === setup.device.deviceId;
            const expiringSoon =
              Date.parse(device.authorizationExpiresAt) - Date.now() <= 5 * 24 * 60 * 60 * 1_000;
            return (
              <li key={device.deviceId} className="grid min-w-0 gap-3 p-4 text-sm">
                <div className="flex min-w-0 items-center gap-3">
                  <Smartphone size={18} className="shrink-0 text-muted" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono font-bold">{truncateOpaqueId(device.deviceId)}</p>
                    <p className="mt-1 text-xs text-muted">
                      Ovlašćen do {formatDateTime(device.authorizationExpiresAt)}
                    </p>
                  </div>
                  {isLocal ? <StatusBadge tone="positive">Ovaj uređaj</StatusBadge> : null}
                  {expiringSoon ? <StatusBadge tone="warning">Obnova uskoro</StatusBadge> : null}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setRenewDeviceId(device.deviceId)}
                  >
                    <RefreshCw size={16} aria-hidden="true" /> Obnovi 30 dana
                  </Button>
                  {!isLocal ? (
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        setRevokeDeviceId(device.deviceId);
                        setRecoveryCode('');
                        setRevokeConfirmation('');
                      }}
                    >
                      <ShieldX size={16} aria-hidden="true" /> Bezbedno opozovi
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {revokeDeviceId ? (
        <Card className="grid gap-4 border-danger/30">
          <div>
            <SectionTitle>Bezbedno opozivanje i rotacija ključa</SectionTitle>
            <p className="mt-2 text-sm leading-6 text-muted">
              Server će blokirati buduće sesije uređaja {truncateOpaqueId(revokeDeviceId)}. Mirna
              pravi potpuno novi nasumični master ključ, deli ga samo preostalim uređajima i odmah
              šalje novi šifrovani snapshot.
            </p>
            <p className="mt-2 text-sm leading-6 text-danger">
              Ovo ne može obrisati čitljive podatke ili stare ključeve koji su već ostali na
              izgubljenom uređaju.
            </p>
          </div>
          <Field
            label="Recovery kod"
            hint="Kod se koristi lokalno za potvrdu i nikada se ne šalje serveru."
          >
            <Input
              aria-label="Recovery kod"
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value.trim())}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label={`Za potvrdu unesite: ${revokePhrase}`}>
            <Input
              aria-label={`Za potvrdu unesite: ${revokePhrase}`}
              value={revokeConfirmation}
              onChange={(event) => setRevokeConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              variant="danger"
              disabled={busy || recoveryCode.length === 0 || revokeConfirmation !== revokePhrase}
              onClick={() => void revokeDevice()}
            >
              {busy ? <BusyIcon /> : <TriangleAlert size={17} aria-hidden="true" />}
              Opozovi i rotiraj ključ
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setRevokeDeviceId(undefined);
                setRecoveryCode('');
                setRevokeConfirmation('');
              }}
            >
              Odustani
            </Button>
          </div>
        </Card>
      ) : null}

      <ConfirmDialog
        open={Boolean(conflictResolution)}
        onOpenChange={(open) => {
          if (!open) setConflictResolution(undefined);
        }}
        title="Potvrdite rezoluciju konflikta"
        description={
          conflictResolution?.selection === 'remote'
            ? 'Trenutne lokalne vrednosti iz ove konfliktne radnje biće zamenjene pregledanim predlogom drugog uređaja. Radnja je atomska.'
            : 'Trenutne lokalne vrednosti biće zadržane i poslate kao nova potpisana rezolucija.'
        }
        confirmLabel="Potvrdi rezoluciju"
        danger={conflictResolution?.selection === 'remote'}
        onConfirm={resolveConflict}
      />

      <ConfirmDialog
        open={Boolean(renewDeviceId)}
        onOpenChange={(open) => {
          if (!open) setRenewDeviceId(undefined);
        }}
        title="Obnovite ovlašćenje uređaja"
        description="Biće upisana nova potpisana verzija manifesta i novo ovlašćenje od 30 dana. Ključevi uređaja se ne menjaju."
        confirmLabel="Obnovi ovlašćenje"
        onConfirm={renewDevice}
      />

      <ExistingDeviceApproval services={services} />

      <Card className="grid gap-4 border-danger/25">
        <div>
          <SectionTitle>Obriši šifrovani cloud trezor</SectionTitle>
          <p className="mt-2 text-sm leading-6 text-muted">
            Briše R2 snapshot objekte i D1 operacije, manifeste, sesije, zahteve za uparivanje,
            recovery omot, uređaje i operativne metapodatke. Server zadržava samo kratkotrajni
            nečitljivi tombstone za bezbedan retry.
          </p>
          <p className="mt-2 text-sm font-semibold text-danger">
            Lokalni Mirna finansijski podaci se ne brišu. Ova radnja ne može da se poništi.
          </p>
        </div>
        {!showCloudDelete ? (
          <Button variant="danger" disabled={busy} onClick={() => setShowCloudDelete(true)}>
            <TriangleAlert size={17} aria-hidden="true" /> Pripremi cloud brisanje
          </Button>
        ) : (
          <div className="grid gap-3 rounded-xl bg-danger-soft p-3">
            <Field label="Recovery kod za cloud brisanje">
              <Input
                aria-label="Recovery kod za cloud brisanje"
                value={cloudRecoveryCode}
                onChange={(event) => setCloudRecoveryCode(event.target.value.trim())}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field label={`Za potvrdu unesite: ${CLOUD_VAULT_DELETE_CONFIRMATION}`}>
              <Input
                aria-label={`Za potvrdu unesite: ${CLOUD_VAULT_DELETE_CONFIRMATION}`}
                value={cloudDeleteConfirmation}
                onChange={(event) => setCloudDeleteConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                variant="danger"
                disabled={
                  busy ||
                  cloudRecoveryCode.length === 0 ||
                  cloudDeleteConfirmation !== CLOUD_VAULT_DELETE_CONFIRMATION
                }
                onClick={() => void deleteCloudVault()}
              >
                {busy ? <BusyIcon /> : <TriangleAlert size={17} aria-hidden="true" />}
                Trajno obriši cloud trezor
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setShowCloudDelete(false);
                  setCloudRecoveryCode('');
                  setCloudDeleteConfirmation('');
                }}
              >
                Odustani
              </Button>
            </div>
          </div>
        )}
      </Card>

      {preOnboarding ? (
        <Card className="grid gap-3">
          <p className="text-sm leading-6 text-muted">
            Uređaj i ključevi su postavljeni. Sačekajte uspešno preuzimanje pre nastavka ako ovaj
            uređaj povezujete sa postojećim trezorom.
          </p>
          <Link to="/" className="inline-flex min-h-11 items-center font-bold text-accent">
            Nastavi na lokalni onboarding
          </Link>
        </Card>
      ) : null}

      <Card className="grid gap-4 border-danger/25">
        <div>
          <SectionTitle>Isključi samo ovaj uređaj</SectionTitle>
          <p className="mt-2 text-sm leading-6 text-muted">
            Briše lokalne sync ključeve i podešavanje. Ne opoziva uređaj na serveru, ne menja druge
            uređaje i ne briše cloud podatke. Lokalni finansijski podaci ostaju na ovom uređaju.
          </p>
        </div>
        {!showDisable ? (
          <Button variant="danger" onClick={() => setShowDisable(true)}>
            <Unplug size={17} aria-hidden="true" /> Pripremi lokalno isključivanje
          </Button>
        ) : (
          <div className="grid gap-3 rounded-xl bg-danger-soft p-3">
            <Field
              label={`Za potvrdu unesite: ${disablePhrase}`}
              hint="Velika slova i razmaci moraju biti isti."
            >
              <Input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                variant="danger"
                disabled={busy || confirmation !== disablePhrase}
                onClick={() => void disable()}
              >
                {busy ? <BusyIcon /> : <TriangleAlert size={17} aria-hidden="true" />}
                Isključi ovaj uređaj
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setShowDisable(false);
                  setConfirmation('');
                }}
              >
                Odustani
              </Button>
            </div>
          </div>
        )}
        <InlineError message={error} />
      </Card>
    </div>
  );
};

const SyncContent = ({
  services,
  preOnboarding,
}: {
  services: SyncUiServices;
  preOnboarding: boolean;
}) => {
  const [localStatus, setLocalStatus] = useState<SyncUiLocalStatus>();
  const [mode, setMode] = useState<EmptyMode>('choose');
  const [loadError, setLoadError] = useState('');

  const refresh = useCallback(async () => {
    setLoadError('');
    try {
      setLocalStatus(await services.loadLocalStatus());
    } catch {
      setLoadError(
        'Lokalno sync podešavanje nije moguće bezbedno pročitati. Ne pokrećemo mrežne radnje.',
      );
    }
  }, [services]);

  const synchronizeInBackground = useCallback(() => services.synchronize(false), [services]);
  useSnapshotSyncScheduler({
    enabled: Boolean(localStatus?.setup),
    vaultId: localStatus?.setup?.vault.vaultId,
    synchronize: synchronizeInBackground,
    onSettled: refresh,
  });

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const content = (() => {
    if (!localStatus && !loadError) {
      return (
        <div role="status" className="grid min-h-48 place-items-center text-sm text-muted">
          <span className="flex items-center gap-2">
            <BusyIcon /> Čitam lokalno sync podešavanje…
          </span>
        </div>
      );
    }
    if (loadError) return <InlineError message={loadError} />;
    if (!localStatus) return null;

    if (localStatus.setup) {
      return (
        <ActivePanel
          status={{ ...localStatus, setup: localStatus.setup }}
          services={services}
          preOnboarding={preOnboarding}
          onDisabled={async () => {
            setMode('choose');
            await refresh();
          }}
          onChanged={refresh}
        />
      );
    }

    if (mode === 'choose') {
      return <EmptyModeChooser preOnboarding={preOnboarding} onChoose={setMode} />;
    }
    if (mode === 'enable') {
      return (
        <EnablePanel services={services} onActivated={refresh} onBack={() => setMode('choose')} />
      );
    }
    if (mode === 'pair-new') {
      return (
        <NewDevicePairingPanel
          services={services}
          onActivated={refresh}
          onBack={() => setMode('choose')}
        />
      );
    }
    return (
      <RecoveryPanel services={services} onActivated={refresh} onBack={() => setMode('choose')} />
    );
  })();

  return (
    <div className="grid gap-4">
      {content}
      <TurnstileCard services={services} />
      <BetaDiagnosticsCard services={services} />
    </div>
  );
};

export interface SyncManagerProps {
  readonly preOnboarding?: boolean;
  readonly services?: SyncUiServices;
}

export const SyncManager = ({ preOnboarding = false, services }: SyncManagerProps) => {
  const resolvedServices = useMemo(() => services ?? createDefaultSyncUiServices(), [services]);
  useEffect(() => () => resolvedServices.dispose?.(), [resolvedServices]);
  const content = <SyncContent services={resolvedServices} preOnboarding={preOnboarding} />;

  if (preOnboarding) {
    return (
      <main className="screen mx-auto max-w-3xl">
        <Link
          to="/"
          className="mb-4 flex min-h-11 w-fit items-center gap-2 text-sm font-bold text-muted"
        >
          <ArrowLeft size={18} aria-hidden="true" /> Nazad na početak
        </Link>
        <header className="mb-6">
          <p className="text-sm font-semibold text-accent">Privatnost — Beta</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight sm:text-3xl">
            Šifrovana sinhronizacija
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted">
            Povežite ili oporavite uređaj pre lokalnog onboarding-a. Mirna nema nalog ni lozinku
            koju može da resetuje za vas.
          </p>
        </header>
        {content}
      </main>
    );
  }

  return (
    <SettingsLayout
      eyebrow="Privatnost — Beta"
      title="Šifrovana sinhronizacija"
      description="Accountless end-to-end enkripcija: server ne dobija čitljive finansijske podatke ni privatne ključeve."
    >
      <div className="mx-auto max-w-3xl">{content}</div>
    </SettingsLayout>
  );
};
