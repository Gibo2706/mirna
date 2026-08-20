import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import type { SyncUiServices } from '../ui-services';
import type { TurnstilePhase, TurnstileViewState } from '../turnstile-client';
import type { VerificationReason } from '../api';
import { SectionTitle } from './shared';

const STATUS: Readonly<Record<TurnstilePhase, string>> = {
  idle: 'Provera će se pokrenuti kada zatražite aktivaciju, uparivanje ili oporavak.',
  'script-loading': 'Pripremam bezbednosnu proveru…',
  'widget-ready': 'Bezbednosna provera je spremna.',
  waiting: 'Dovršite proveru prikazanu ispod.',
  'token-received': 'Rezultat je primljen. Još trenutak…',
  'server-verifying': 'Rezultat je primljen. Još trenutak…',
  success: 'Bezbednosna provera je prihvaćena.',
  expired: 'Provera je istekla. Pripremite novu proveru i ponovite poslednju radnju.',
  rejected: 'Provera nije prihvaćena. Pripremite novu proveru i ponovite poslednju radnju.',
  'network-error': 'Mreža je prekinula proveru. Pripremite novu proveru kada veza proradi.',
  'configuration-error':
    'Provera nije pravilno učitana ili podešena. Kopirajte dijagnostiku za podršku.',
};

const RETRYABLE_PHASES = new Set<TurnstilePhase>([
  'expired',
  'rejected',
  'network-error',
  'configuration-error',
]);

const VERIFICATION_STATUS: Readonly<Record<VerificationReason, string>> = {
  INVALID_INPUT_RESPONSE: 'Provera nije prihvaćena. Napravite novu proveru i pokušajte ponovo.',
  TIMEOUT_OR_DUPLICATE:
    'Provera je istekla ili je isti rezultat već iskorišćen. Potrebna je potpuno nova provera.',
  HOSTNAME_MISMATCH: 'Klijent i server nisu usklađeni. Otvorite dijagnostiku za podršku.',
  ACTION_MISMATCH: 'Klijent i server nisu usklađeni. Otvorite dijagnostiku za podršku.',
  SITEVERIFY_UNAVAILABLE:
    'Bezbednosna provera trenutno nije dostupna. Pokušajte ponovo kada veza proradi.',
  CONFIGURATION_ERROR:
    'Bezbednosna provera nije pravilno podešena. Otvorite dijagnostiku za podršku.',
};

export const TurnstileCard = ({ services }: { services: SyncUiServices }) => {
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
  const isError = RETRYABLE_PHASES.has(state.phase);

  return (
    <Card className="grid gap-3 border-accent/25" data-testid="sync-turnstile-card">
      <div>
        <SectionTitle>Kratka bezbednosna provera</SectionTitle>
        <p className="mt-2 text-sm leading-6 text-muted">
          Ova provera štiti anonimne radnje od zloupotrebe i ne dobija vaše finansijske podatke.
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
          ? VERIFICATION_STATUS[state.verificationReason]
          : STATUS[state.phase]}
      </p>
      <div
        ref={attach}
        data-testid="sync-turnstile-widget"
        aria-label="Kratka bezbednosna provera"
        className="min-h-[70px] min-w-0 max-w-full overflow-hidden rounded-xl bg-white p-1"
      />
    </Card>
  );
};
