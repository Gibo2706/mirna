import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  CloudUpload,
  KeyRound,
  Laptop,
  Pencil,
  QrCode,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  Smartphone,
  Tablet,
  TriangleAlert,
  Unplug,
  WifiOff,
} from 'lucide-react';
import { Link } from 'react-router';
import type { LocalSyncSetup, SyncDeviceKind } from '@/db/sync/records';
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
  type EnableLifecyclePort,
  type ExistingDevicePairingLifecyclePort,
  type NewDevicePairingLifecyclePort,
  type RecoverDeviceLifecyclePort,
  type SyncUiLocalStatus,
  type SyncUiServices,
} from './ui-services';
import {
  formatDateTime,
  formatRelativeSyncTime,
  safeErrorMessage,
  truncateOpaqueId,
  useLocalQr,
} from './ui/helpers';
import { BackToChoices, BusyIcon, InlineError, RecoveryCodeStep, SectionTitle } from './ui/shared';
import {
  SyncRuntimeProvider,
  useOptionalSyncRuntime,
  useSyncRuntime,
  type SyncActivity,
  type SyncRuntimeValue,
} from './runtime/SyncRuntimeProvider';
import { CLOUD_VAULT_DELETE_CONFIRMATION } from './device-security-service';
import { SyncApiError } from './api';
import { TurnstileCard } from './ui/TurnstileCard';
import { LazyDiagnostics } from './ui/SyncDiagnostics';

type EmptyMode = 'choose' | 'enable' | 'pair-new' | 'recover';

const suggestedDeviceName = (): string =>
  /Android|iPhone|Mobile/u.test(navigator.userAgent) ? 'Moj telefon' : 'Moj računar';

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
          Uključite sinhronizaciju i sačuvajte kod za oporavak. Prvi prenos zahteva posebnu
          saglasnost.
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
        Posle povezivanja Mirna bezbedno preuzima i proverava podatke pre nego što ih prikaže.
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
  const [deviceName, setDeviceName] = useState(suggestedDeviceName);
  const [capability, setCapability] = useState<'idle' | 'checking' | 'supported' | 'unsupported'>(
    'idle',
  );
  const [presentation, setPresentation] = useState<RecoveryCodePresentation>();
  const [confirmationValues, setConfirmationValues] = useState<Record<number, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activationError, setActivationError] = useState<SyncApiError>();
  const [activationRetryAvailable, setActivationRetryAvailable] = useState(false);
  const activationInFlight = useRef(false);

  const checkCapability = useCallback(async () => {
    setCapability('checking');
    setError('');
    try {
      const result = await services.probeCapability();
      setCapability(result.supported ? 'supported' : 'unsupported');
    } catch {
      setCapability('unsupported');
    }
  }, [services]);

  useEffect(() => {
    void checkCapability();
  }, [checkCapability]);

  const begin = async () => {
    if (capability !== 'supported' || busy) return;
    setBusy(true);
    setError('');
    setActivationError(undefined);
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
    setActivationError(undefined);
    try {
      await lifecycle.current.activate();
      void services.diagnostics?.record?.({
        eventType: 'sync_activation_succeeded',
        severity: 'info',
        action: 'mirna_vault_create',
      });
      setActivationRetryAvailable(false);
      setActivationError(undefined);
      setPresentation(undefined);
      setConfirmationValues({});
      success('Sinhronizacija je spremna na ovom uređaju.');
      await onActivated();
    } catch (caught) {
      setActivationError(caught instanceof SyncApiError ? caught : undefined);
      setActivationRetryAvailable(
        caught instanceof SyncApiError &&
          (caught.code.startsWith('TURNSTILE_') ||
            caught.code.startsWith('HUMAN_VERIFICATION_') ||
            caught.code === 'NETWORK_FAILURE' ||
            caught.code === 'REQUEST_TIMEOUT' ||
            caught.code === 'USAGE_ACCOUNTING_UNAVAILABLE' ||
            caught.code === 'USAGE_RESERVATION_UNDERESTIMATED' ||
            caught.code === 'USAGE_SETTLEMENT_FAILED' ||
            caught.code === 'SERVICE_MAINTENANCE'),
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
            Mirna šifruje podatke na ovom uređaju pre slanja. Prvi prenos finansijskih podataka
            zahtevaće vašu posebnu saglasnost.
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
        {capability === 'unsupported' ? (
          <Button variant="secondary" onClick={() => void checkCapability()}>
            <ShieldCheck size={17} aria-hidden="true" /> Pokušaj proveru ponovo
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
        <>
          <TurnstileCard services={services} />
          <Card className="grid gap-3 border-accent/30 bg-accent-soft/30">
            <p className="text-sm leading-6">
              Kod je potvrđen. Mirna sada može da pripremi bezbednu sinhronizaciju; finansijski
              podaci se još ne šalju.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button onClick={() => void activate()} disabled={busy}>
                {busy ? <BusyIcon /> : <ShieldCheck size={17} aria-hidden="true" />}
                {activationRetryAvailable ? 'Pokušaj ponovo' : 'Pripremi sinhronizaciju'}
              </Button>
              {activationRetryAvailable ? (
                <Button variant="ghost" disabled={busy} onClick={onBack}>
                  Odustani
                </Button>
              ) : null}
            </div>
          </Card>
        </>
      ) : null}
      <InlineError message={error} />
      {activationError?.accounting ? (
        <dl
          className="grid gap-1 rounded-xl border border-danger/20 bg-danger-soft p-3 text-xs text-danger"
          data-testid="sync-activation-accounting-error"
        >
          <div>Kod: {activationError.code}</div>
          <div>Accounting razlog: {activationError.accounting.reason ?? 'nije zabeležen'}</div>
          <div>Faza: {activationError.accounting.phase}</div>
          <div>Ruta: {activationError.accounting.route}</div>
          {activationError.requestId ? <div>Request ID: {activationError.requestId}</div> : null}
        </dl>
      ) : null}
    </div>
  );
};

type NewPairingStage = 'idle' | 'resume' | 'pending' | 'sas' | 'ended';

const NewDevicePairingPanel = ({
  services,
  onActivated,
  onBack,
  resumeAvailable = false,
}: {
  services: SyncUiServices;
  onActivated: () => Promise<void>;
  onBack: () => void;
  resumeAvailable?: boolean;
}) => {
  const { success } = useToast();
  const lifecycle = useRef<NewDevicePairingLifecyclePort | null>(null);
  const pollInFlight = useRef(false);
  const [deviceName, setDeviceName] = useState(suggestedDeviceName);
  const [presentation, setPresentation] = useState<PairingCodePresentation>();
  const [stage, setStage] = useState<NewPairingStage>(resumeAvailable ? 'resume' : 'idle');
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
        activeLifecycle.state !== 'active' &&
        activeLifecycle.state !== 'finalizing'
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

  const resumeFinalization = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    const activeLifecycle = lifecycle.current ?? services.createNewDevicePairingLifecycle();
    lifecycle.current = activeLifecycle;
    try {
      await activeLifecycle.resumeFinalization();
      success('Započeto povezivanje je bezbedno dovršeno.');
      await onActivated();
    } catch (caught) {
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
      success(
        mismatch ? 'Zahtev je otkazan jer se bezbednosni kod ne poklapa.' : 'Zahtev je otkazan.',
      );
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
        {stage === 'resume' ? (
          <div className="grid gap-3 rounded-xl border border-warning/40 bg-warning/5 p-3">
            <p className="text-sm leading-6">
              Ovaj uređaj ima šifrovani checkpoint potvrđenog povezivanja. Dovršite isti zahtev;
              novi ključevi se neće praviti.
            </p>
            <Button onClick={() => void resumeFinalization()} disabled={busy}>
              {busy ? <BusyIcon /> : <ShieldCheck size={17} aria-hidden="true" />}
              Dovrši započeto povezivanje
            </Button>
          </div>
        ) : null}
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
            <TurnstileCard services={services} />
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
            <SectionTitle>Uporedite bezbednosni kod</SectionTitle>
            <p className="mt-2 text-sm leading-6 text-muted">
              Potvrdite samo ako su sve grupe potpuno iste na oba uređaja. Ne čitajte kod trećoj
              osobi.
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
          <TurnstileCard services={services} />
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

const DeviceIcon = ({ kind }: { kind?: SyncDeviceKind }) => {
  if (kind === 'computer') return <Laptop size={20} aria-hidden="true" />;
  if (kind === 'tablet') return <Tablet size={20} aria-hidden="true" />;
  return <Smartphone size={20} aria-hidden="true" />;
};

const ExistingDeviceApproval = ({
  services,
  vaultId,
  onChanged,
}: {
  services: SyncUiServices;
  vaultId: string;
  onChanged: () => Promise<void>;
}) => {
  const { success } = useToast();
  const lifecycle = useRef<ExistingDevicePairingLifecyclePort | null>(null);
  const [code, setCode] = useState('');
  const [prepared, setPrepared] = useState<PreparedExistingPairing>();
  const [alias, setAlias] = useState('Drugi uređaj');
  const [kind, setKind] = useState<SyncDeviceKind>('other');
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
      try {
        await services.saveDeviceAlias(vaultId, prepared.deviceId, alias, kind);
      } catch {
        setError('Uređaj je povezan, ali lokalni naziv nije sačuvan. Možete ga dodati kasnije.');
      }
      setPrepared(undefined);
      lifecycle.current = null;
      success('Zahtev je odobren. Isti bezbednosni kod sada će se pojaviti na novom uređaju.');
      await onChanged();
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
            <p className="text-sm font-bold">Bezbednosni kod</p>
            <p
              data-testid="sync-existing-device-sas"
              className="mt-2 rounded-xl bg-warning-soft p-4 text-center font-mono text-xl font-black tracking-wider text-warning break-words"
            >
              {prepared.sas}
            </p>
            <p className="mt-2 text-xs leading-5 text-muted">
              U sledećem koraku isti kod će se pojaviti i na novom uređaju. Tada ih uporedite pre
              konačne potvrde na tom uređaju.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Naziv na ovom uređaju">
              <Input
                value={alias}
                onChange={(event) => setAlias(event.target.value)}
                maxLength={80}
                autoComplete="off"
              />
            </Field>
            <Field label="Vrsta uređaja">
              <select
                className="min-h-11 w-full rounded-xl border bg-surface px-3 text-sm"
                value={kind}
                onChange={(event) => setKind(event.target.value as SyncDeviceKind)}
              >
                <option value="phone">Telefon</option>
                <option value="computer">Računar</option>
                <option value="tablet">Tablet</option>
                <option value="other">Drugi uređaj</option>
              </select>
            </Field>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button onClick={() => void approve()} disabled={busy || alias.trim().length === 0}>
              {busy ? <BusyIcon /> : <CheckCircle2 size={17} aria-hidden="true" />}
              Nastavi povezivanje
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
  activity,
  synchronizeRuntime,
  preOnboarding,
  onDisabled,
  onChanged,
}: {
  status: SyncUiLocalStatus & { readonly setup: LocalSyncSetup };
  services: SyncUiServices;
  activity: SyncActivity;
  synchronizeRuntime: SyncRuntimeValue['synchronize'];
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
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [renameDeviceId, setRenameDeviceId] = useState<string>();
  const [aliasLabel, setAliasLabel] = useState('');
  const [aliasKind, setAliasKind] = useState<SyncDeviceKind>('other');
  const [cloudRecoveryCode, setCloudRecoveryCode] = useState('');
  const [cloudDeleteConfirmation, setCloudDeleteConfirmation] = useState('');
  const { setup } = status;
  const disablePhrase = 'ISKLJUČI OVAJ UREĐAJ';
  const revokePhrase = 'OPOZOVI UREĐAJ';
  const pairedBootstrapPending =
    setup.metadata.bootstrapMode === 'paired-download' && setup.metadata.lastSnapshotRevision === 0;
  const aliasesByDeviceId = useMemo(
    () => new Map(status.deviceAliases.map((alias) => [alias.deviceId, alias])),
    [status.deviceAliases],
  );

  const beginRename = (deviceId: string) => {
    const current = aliasesByDeviceId.get(deviceId);
    setRenameDeviceId(deviceId);
    setAliasLabel(current?.label ?? 'Drugi uređaj');
    setAliasKind(current?.kind ?? 'other');
  };

  const saveAlias = async () => {
    if (!renameDeviceId || aliasLabel.trim().length === 0 || busy) return;
    setBusy(true);
    setError('');
    try {
      await services.saveDeviceAlias(setup.vault.vaultId, renameDeviceId, aliasLabel, aliasKind);
      setRenameDeviceId(undefined);
      success('Naziv uređaja je sačuvan samo na ovom uređaju.');
      await onChanged();
    } catch (caught) {
      setError(safeErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const overview = (() => {
    if (navigator.onLine === false) {
      return {
        title: 'Nema interneta',
        description: 'Promene ostaju bezbedno na ovom uređaju i poslaće se kada se veza vrati.',
        tone: 'warning' as const,
        icon: <WifiOff size={22} aria-hidden="true" />,
      };
    }
    if (activity.kind === 'syncing') {
      return {
        title: pairedBootstrapPending ? 'Preuzimam vaše podatke…' : 'Sinhronizujem…',
        description: 'Mirna bezbedno obrađuje promene u pozadini.',
        tone: 'neutral' as const,
        icon: <BusyIcon />,
      };
    }
    if (activity.kind === 'paused') {
      return {
        title: 'Sinhronizacija je privremeno pauzirana',
        description: 'Testni servis je dostigao ograničenje. Lokalne promene ostaju sačuvane.',
        tone: 'warning' as const,
        icon: <TriangleAlert size={22} aria-hidden="true" />,
      };
    }
    if (activity.kind === 'attention' || setup.metadata.syncBlockReason) {
      return {
        title: pairedBootstrapPending ? 'Preuzimanje čeka' : 'Potrebna je pažnja',
        description: pairedBootstrapPending
          ? 'Povezivanje je završeno, ali početni podaci još nisu preuzeti.'
          : 'Lokalni podaci nisu prepisani. Pogledajte upozorenje ispod ili pokušajte ponovo.',
        tone: 'warning' as const,
        icon: <TriangleAlert size={22} aria-hidden="true" />,
      };
    }
    if (pairedBootstrapPending) {
      return {
        title: 'Povezano — preuzimanje počinje automatski',
        description: 'Ostanite na mreži dok Mirna priprema podatke na ovom uređaju.',
        tone: 'neutral' as const,
        icon: <RefreshCw size={22} aria-hidden="true" />,
      };
    }
    if (status.pendingLocalOperationCount > 0) {
      return {
        title: `${status.pendingLocalOperationCount} promene čekaju slanje`,
        description: 'Mirna će ih poslati automatski dok je aplikacija otvorena.',
        tone: 'neutral' as const,
        icon: <CloudUpload size={22} aria-hidden="true" />,
      };
    }
    if (setup.metadata.lastSuccessfulSyncAt) {
      return {
        title: 'Sve je sinhronizovano',
        description: `Poslednji put ${formatRelativeSyncTime(setup.metadata.lastSuccessfulSyncAt)}`,
        tone: 'positive' as const,
        icon: <CheckCircle2 size={22} aria-hidden="true" />,
      };
    }
    return {
      title: 'Sinhronizacija je uključena',
      description: 'Prva bezbedna provera će se pokrenuti automatski.',
      tone: 'neutral' as const,
      icon: <ShieldCheck size={22} aria-hidden="true" />,
    };
  })();

  const synchronize = async (allowInitialUpload = false) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await synchronizeRuntime({
        allowInitialUpload,
        reason: allowInitialUpload ? 'first-upload' : 'manual',
      });
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
      success(
        'Brisanje šifrovanog cloud trezora je pokrenuto. Lokalni finansijski podaci su sačuvani.',
      );
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
        <div className="flex min-w-0 items-start gap-3" role="status">
          <span
            className={
              overview.tone === 'positive'
                ? 'grid size-11 shrink-0 place-items-center rounded-full bg-accent-soft text-accent'
                : overview.tone === 'warning'
                  ? 'grid size-11 shrink-0 place-items-center rounded-full bg-warning-soft text-warning'
                  : 'grid size-11 shrink-0 place-items-center rounded-full bg-surface-2 text-muted'
            }
          >
            {overview.icon}
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold">{overview.title}</h2>
            <p className="mt-1 text-sm leading-6 text-muted">{overview.description}</p>
          </div>
        </div>
        <div className="grid gap-2 min-[390px]:grid-cols-2">
          <Button variant="secondary" onClick={() => setShowAddDevice((current) => !current)}>
            <Smartphone size={17} aria-hidden="true" /> Dodaj uređaj
          </Button>
          <Button
            variant="secondary"
            disabled={busy || Boolean(setup.metadata.syncBlockReason)}
            onClick={() => void synchronize(false)}
          >
            {busy ? <BusyIcon /> : <RefreshCw size={17} aria-hidden="true" />}
            Sinhronizuj sada
          </Button>
        </div>
        {setup.metadata.bootstrapMode === 'creator-upload' &&
        setup.metadata.firstUploadConsent === 'pending' ? (
          <div className="grid gap-3 rounded-xl bg-warning-soft p-3 text-sm leading-6 text-warning">
            <p>
              Prvi prenos čeka vašu posebnu saglasnost. Mirna će podatke šifrovati na ovom uređaju
              pre slanja; servis ne dobija čitljive finansijske podatke.
            </p>
            <Button disabled={busy} onClick={() => void synchronize(true)}>
              {busy ? <BusyIcon /> : <CloudUpload size={17} aria-hidden="true" />}
              Saglasan sam — pošalji prve šifrovane podatke
            </Button>
          </div>
        ) : null}
        {pairedBootstrapPending && activity.kind === 'attention' ? (
          <Button disabled={busy} onClick={() => void synchronize(false)}>
            {busy ? <BusyIcon /> : <RefreshCw size={17} aria-hidden="true" />}
            Pokušaj preuzimanje ponovo
          </Button>
        ) : null}
        {setup.metadata.syncBlockReason ? (
          <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm leading-6 text-danger">
            Automatska sinhronizacija je zaustavljena: {setup.metadata.syncBlockReason}. Lokalni
            podaci nisu prepisani.
          </p>
        ) : null}
        <details className="rounded-xl border bg-surface-2 p-3 text-sm">
          <summary className="min-h-8 cursor-pointer font-bold">Tehnički detalji</summary>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted">ID ovog uređaja</dt>
              <dd className="mt-1 break-all font-mono">{setup.device.deviceId}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Ovlašćen do</dt>
              <dd className="mt-1">{formatDateTime(setup.device.authorizationExpiresAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Poslednja sinhronizacija</dt>
              <dd className="mt-1">
                {formatDateTime(setup.metadata.lastSuccessfulSyncAt ?? setup.metadata.lastSyncAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Promene / konflikti</dt>
              <dd className="mt-1">
                {status.pendingLocalOperationCount} / {status.pendingConflictCount}
              </dd>
            </div>
          </dl>
        </details>
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
            Nazivi su sačuvani samo lokalno i ne šalju se Mirna servisu.
          </p>
        </div>
        <ul className="divide-y">
          {setup.vault.manifest.devices.map((device) => {
            const isLocal = device.deviceId === setup.device.deviceId;
            const alias = aliasesByDeviceId.get(device.deviceId);
            const deviceLabel = isLocal
              ? setup.device.displayName
              : (alias?.label ?? 'Drugi uređaj');
            const expiringSoon =
              Date.parse(device.authorizationExpiresAt) - Date.now() <= 5 * 24 * 60 * 60 * 1_000;
            return (
              <li key={device.deviceId} className="grid min-w-0 gap-3 p-4 text-sm">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2 text-muted">
                    <DeviceIcon kind={alias?.kind} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold">{deviceLabel}</p>
                    <p className="mt-1 text-xs text-muted">{isLocal ? 'Ovaj uređaj' : 'Aktivan'}</p>
                  </div>
                  {expiringSoon ? <StatusBadge tone="warning">Obnova uskoro</StatusBadge> : null}
                </div>
                <div className="grid gap-2 min-[390px]:grid-cols-2">
                  {!isLocal ? (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => beginRename(device.deviceId)}
                    >
                      <Pencil size={16} aria-hidden="true" /> Promeni naziv
                    </Button>
                  ) : null}
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
                {renameDeviceId === device.deviceId ? (
                  <div className="grid gap-3 rounded-xl bg-surface-2 p-3">
                    <Field label="Naziv uređaja">
                      <Input
                        value={aliasLabel}
                        onChange={(event) => setAliasLabel(event.target.value)}
                        maxLength={80}
                        autoComplete="off"
                      />
                    </Field>
                    <Field label="Vrsta uređaja">
                      <select
                        className="min-h-11 w-full rounded-xl border bg-surface px-3 text-sm"
                        value={aliasKind}
                        onChange={(event) => setAliasKind(event.target.value as SyncDeviceKind)}
                      >
                        <option value="phone">Telefon</option>
                        <option value="computer">Računar</option>
                        <option value="tablet">Tablet</option>
                        <option value="other">Drugi uređaj</option>
                      </select>
                    </Field>
                    <div className="grid gap-2 min-[390px]:grid-cols-2">
                      <Button
                        disabled={busy || aliasLabel.trim().length === 0}
                        onClick={() => void saveAlias()}
                      >
                        Sačuvaj naziv
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setRenameDeviceId(undefined)}
                      >
                        Odustani
                      </Button>
                    </div>
                  </div>
                ) : null}
                <details className="rounded-xl bg-surface-2 p-3 text-xs">
                  <summary className="min-h-7 cursor-pointer font-semibold">
                    Tehnički detalji
                  </summary>
                  <p className="mt-2 break-all font-mono">{device.deviceId}</p>
                  <p className="mt-1 text-muted">
                    Ovlašćen do {formatDateTime(device.authorizationExpiresAt)}
                  </p>
                </details>
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
          <TurnstileCard services={services} />
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

      {showAddDevice ? (
        <ExistingDeviceApproval
          services={services}
          vaultId={setup.vault.vaultId}
          onChanged={onChanged}
        />
      ) : null}

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

      <div className="border-t border-danger/20 pt-5">
        <h2 className="text-lg font-extrabold text-danger">Opasna zona</h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          Ove radnje menjaju pristup uređaja ili trajno uklanjaju udaljene podatke i uvek traže
          dodatnu potvrdu.
        </p>
      </div>

      <Card className="grid gap-4 border-danger/25">
        <div>
          <SectionTitle>Obriši šifrovani cloud trezor</SectionTitle>
          <p className="mt-2 text-sm leading-6 text-muted">
            Briše šifrovane podatke, povezane uređaje i pristup sa Mirna sync servisa. Servis
            zadržava samo kratkotrajnu nečitljivu oznaku potrebnu za bezbedno ponavljanje zahteva.
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
            <TurnstileCard services={services} />
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

const SyncContent = ({ preOnboarding }: { preOnboarding: boolean }) => {
  const { services, localStatus, loadError, activity, refresh, synchronize } = useSyncRuntime();
  const [mode, setMode] = useState<EmptyMode>('choose');

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
          activity={activity}
          synchronizeRuntime={synchronize}
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
      if (localStatus.pendingPairingFinalization) {
        return (
          <NewDevicePairingPanel
            services={services}
            resumeAvailable
            onActivated={refresh}
            onBack={() => setMode('choose')}
          />
        );
      }
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
      <LazyDiagnostics services={services} />
    </div>
  );
};

export interface SyncManagerProps {
  readonly preOnboarding?: boolean;
  readonly services?: SyncUiServices;
}

export const SyncManager = ({ preOnboarding = false, services }: SyncManagerProps) => {
  const parentRuntime = useOptionalSyncRuntime();
  if (services && !parentRuntime) {
    return (
      <SyncRuntimeProvider services={services}>
        <SyncManager preOnboarding={preOnboarding} />
      </SyncRuntimeProvider>
    );
  }
  if (!parentRuntime) throw new Error('SyncManager requires the app-level sync runtime.');
  const content = <SyncContent preOnboarding={preOnboarding} />;

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
            Sinhronizacija
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted">
            Podaci se šifruju na ovom uređaju pre slanja. Mirna nema nalog ni lozinku koju može da
            resetuje za vas.
          </p>
        </header>
        {content}
      </main>
    );
  }

  return (
    <SettingsLayout
      eyebrow="Privatnost — Beta"
      title="Sinhronizacija"
      description="Koristite iste podatke na više uređaja. Sve se šifruje na ovom uređaju pre slanja."
    >
      <div className="mx-auto max-w-3xl">{content}</div>
    </SettingsLayout>
  );
};
