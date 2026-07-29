import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, WifiOff } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Button } from '@/components/ui/Button';

export const PwaStatus = () => {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>();
  const [registrationError, setRegistrationError] = useState(false);
  const [formBlocked, setFormBlocked] = useState(false);
  const lastUpdateCheck = useRef(0);
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, value) {
      if (value) setRegistration(value);
    },
    onRegisterError() {
      setRegistrationError(true);
    },
  });

  useEffect(() => {
    const checkForUpdate = () => {
      if (
        document.visibilityState !== 'visible' ||
        !navigator.onLine ||
        !registration ||
        Date.now() - lastUpdateCheck.current < 60 * 60 * 1000
      ) {
        return;
      }
      lastUpdateCheck.current = Date.now();
      void registration.update().catch(() => setRegistrationError(true));
    };
    checkForUpdate();
    const interval = window.setInterval(checkForUpdate, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', checkForUpdate);
    window.addEventListener('pageshow', checkForUpdate);
    window.addEventListener('focus', checkForUpdate);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', checkForUpdate);
      window.removeEventListener('pageshow', checkForUpdate);
      window.removeEventListener('focus', checkForUpdate);
    };
  }, [registration]);

  if (!offlineReady && !needRefresh && !registrationError) return null;

  return (
    <div className="fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-[70] mx-auto flex max-w-lg items-center gap-3 rounded-2xl border bg-foreground p-3 text-background shadow-xl">
      {needRefresh ? <RefreshCw size={19} /> : <WifiOff size={19} />}
      <p className="flex-1 text-sm font-semibold">
        {registrationError
          ? 'Provera offline verzije trenutno nije uspela.'
          : formBlocked
            ? 'Završite ili zatvorite otvorenu formu pre osvežavanja.'
            : needRefresh
              ? 'Nova verzija je spremna.'
              : 'Aplikacija je spremna za rad bez interneta.'}
      </p>
      {needRefresh && !registrationError ? (
        <div className="flex gap-1">
          <Button
            size="sm"
            onClick={() => {
              if (document.querySelector('[role="dialog"] form')) {
                setFormBlocked(true);
                return;
              }
              void updateServiceWorker(true);
            }}
          >
            <Download size={15} />
            Osveži
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-background"
            onClick={() => {
              setFormBlocked(false);
              setNeedRefresh(false);
            }}
          >
            Kasnije
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setOfflineReady(false);
            setRegistrationError(false);
          }}
        >
          U redu
        </Button>
      )}
    </div>
  );
};
