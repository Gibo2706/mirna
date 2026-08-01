import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  CloudCog,
  CloudUpload,
  KeyRound,
  QrCode,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  Smartphone,
  TriangleAlert,
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

type EmptyMode = 'choose' | 'enable' | 'pair-new' | 'recover';

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
    if (!confirmed || !lifecycle.current || busy) return;
    setBusy(true);
    setError('');
    try {
      await lifecycle.current.activate();
      setPresentation(undefined);
      setConfirmationValues({});
      success('Šifrovana sinhronizacija je aktivirana na ovom uređaju.');
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
          <Button onClick={() => void activate()} disabled={busy}>
            {busy ? <BusyIcon /> : <ShieldCheck size={17} aria-hidden="true" />}
            Aktiviraj šifrovanu sinhronizaciju
          </Button>
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
                  className="mt-2 block max-h-48 overflow-auto rounded-xl bg-surface-2 p-3 text-xs leading-6 break-normal select-all"
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

const UnavailableBetaStep = ({ title, description }: { title: string; description: string }) => (
  <div className="flex items-start gap-3 p-4 opacity-70" aria-disabled="true">
    <CloudCog size={19} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
    <div className="min-w-0">
      <p className="font-bold">{title}</p>
      <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
      <StatusBadge className="mt-2">Nije dostupno u ovoj beta fazi</StatusBadge>
    </div>
  </div>
);

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
  const { setup } = status;
  const authorizationExpired = Date.parse(setup.device.authorizationExpiresAt) <= Date.now();
  const disablePhrase = 'ISKLJUČI OVAJ UREĐAJ';

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
          {setup.vault.manifest.devices.map((device) => (
            <li key={device.deviceId} className="flex min-w-0 items-center gap-3 p-4 text-sm">
              <Smartphone size={18} className="shrink-0 text-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1 font-mono font-bold">
                {truncateOpaqueId(device.deviceId)}
              </span>
              {device.deviceId === setup.device.deviceId ? (
                <StatusBadge tone="positive">Ovaj uređaj</StatusBadge>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

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

      <ExistingDeviceApproval services={services} />

      <Card className="divide-y p-0">
        <UnavailableBetaStep
          title="Obnovi ili opozovi udaljeni uređaj"
          description="Manifest radnje postoje u protokolu, ali ovaj Phase 1 ekran ih još ne izvršava."
        />
        <UnavailableBetaStep
          title="Obriši šifrovane podatke iz cloud-a"
          description="Cloud brisanje nije implementirano; lokalno isključivanje ispod nije isto što i cloud brisanje."
        />
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
};

export interface SyncManagerProps {
  readonly preOnboarding?: boolean;
  readonly services?: SyncUiServices;
}

export const SyncManager = ({ preOnboarding = false, services }: SyncManagerProps) => {
  const resolvedServices = useMemo(() => services ?? createDefaultSyncUiServices(), [services]);
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
