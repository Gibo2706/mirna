import { useState, type ReactNode } from 'react';
import { ArrowLeft, ClipboardCopy, Download, KeyRound, LoaderCircle, Printer } from 'lucide-react';
import { useToast } from '@/components/ToastProvider';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/Field';
import type { RecoveryCodePresentation } from '../lifecycle';
import type { SyncUiServices } from '../ui-services';

export const BusyIcon = () => (
  <LoaderCircle className="animate-spin" size={17} aria-hidden="true" />
);

export const InlineError = ({ message }: { message: string }) =>
  message ? (
    <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm leading-6 text-danger">
      {message}
    </p>
  ) : null;

export const SectionTitle = ({ children }: { children: ReactNode }) => (
  <h2 className="text-base font-extrabold tracking-tight">{children}</h2>
);

const SecretActions = ({
  secret,
  services,
  filename,
}: {
  secret: string;
  services: SyncUiServices;
  filename: string;
}) => {
  const { success } = useToast();
  const [error, setError] = useState('');

  const copy = async () => {
    setError('');
    try {
      await services.copySecret(secret);
      success('Recovery kod je kopiran na vaš zahtev.');
    } catch {
      setError('Kopiranje nije uspelo. Kod možete prepisati ili preuzeti kao fajl.');
    }
  };

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <Button variant="secondary" onClick={() => void copy()}>
        <ClipboardCopy size={16} aria-hidden="true" /> Kopiraj recovery kod
      </Button>
      <Button
        variant="secondary"
        onClick={() => {
          services.downloadSecret(filename, secret);
          success('Recovery kod je preuzet kao tekstualni fajl.');
        }}
      >
        <Download size={16} aria-hidden="true" /> Preuzmi recovery kod
      </Button>
      <Button variant="secondary" onClick={services.printSecret}>
        <Printer size={16} aria-hidden="true" /> Odštampaj recovery kod
      </Button>
      {error ? (
        <div className="sm:col-span-3">
          <InlineError message={error} />
        </div>
      ) : null}
    </div>
  );
};

export const RecoveryCodeStep = ({
  title,
  presentation,
  values,
  onValueChange,
  services,
}: {
  title: string;
  presentation: RecoveryCodePresentation;
  values: Readonly<Record<number, string>>;
  onValueChange: (groupNumber: number, value: string) => void;
  services: SyncUiServices;
}) => (
  <Card className="grid gap-4 border-accent/30">
    <div>
      <div className="flex items-center gap-2">
        <KeyRound size={19} className="text-accent" aria-hidden="true" />
        <SectionTitle>{title}</SectionTitle>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted">
        Ovo je jedini način za oporavak ako izgubite sve povezane uređaje. Prikazuje se samo tokom
        ovog koraka. Sačuvajte ga van ovog uređaja.
      </p>
    </div>
    <code
      data-testid="sync-recovery-code"
      className="block whitespace-pre-wrap break-all rounded-xl bg-surface-2 p-3 text-sm font-bold leading-7 select-all"
    >
      {presentation.recoveryCode}
    </code>
    <SecretActions
      secret={presentation.recoveryCode}
      services={services}
      filename="mirna-recovery-kod.txt"
    />
    <div className="grid gap-3 rounded-xl border p-3">
      <p className="text-sm font-bold">Potvrdite nasumično izabrane grupe</p>
      <p className="text-xs leading-5 text-muted">
        Prepišite tražene grupe iz kopije koju ste upravo sačuvali.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {presentation.confirmationGroupNumbers.map((groupNumber) => (
          <Field key={groupNumber} label={`Grupa ${groupNumber}`}>
            <Input
              data-testid={`sync-recovery-confirmation-${groupNumber}`}
              value={values[groupNumber] ?? ''}
              onChange={(event) => onValueChange(groupNumber, event.target.value.toUpperCase())}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={16}
              inputMode="text"
            />
          </Field>
        ))}
      </div>
    </div>
  </Card>
);

export const BackToChoices = ({ onClick }: { onClick: () => void }) => (
  <Button variant="ghost" className="w-fit px-2" onClick={onClick}>
    <ArrowLeft size={17} aria-hidden="true" /> Izaberi drugi način
  </Button>
);
