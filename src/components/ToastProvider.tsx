import { CheckCircle2, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { createId } from '@/lib/id';

interface Toast {
  id: string;
  message: string;
}

interface ToastContextValue {
  success: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const remove = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const success = useCallback(
    (message: string) => {
      const id = createId('toast');
      setToasts((current) => [...current, { id, message }]);
      window.setTimeout(() => remove(id), 3500);
    },
    [remove],
  );
  const value = useMemo(() => ({ success }), [success]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-4 top-[max(0.75rem,env(safe-area-inset-top))] z-[80] mx-auto grid max-w-sm gap-2"
        aria-live="polite"
        aria-atomic="true"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="pointer-events-none flex items-center gap-3 rounded-2xl border bg-foreground px-4 py-3 text-sm font-semibold text-background shadow-xl"
            role="status"
          >
            <CheckCircle2 size={18} className="text-accent" />
            <span className="flex-1">{toast.message}</span>
            <button
              className="pointer-events-auto grid size-8 place-items-center rounded-full"
              onClick={() => remove(toast.id)}
              aria-label="Zatvori obaveštenje"
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useToast = (): ToastContextValue => {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast mora biti unutar ToastProvider-a.');
  return context;
};
