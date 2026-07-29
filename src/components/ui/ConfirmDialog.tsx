import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useEffect, useState } from 'react';
import { Button } from './Button';

export const ConfirmDialog = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Potvrdi',
  onConfirm,
  danger = false,
  pending = false,
  closeOnConfirm = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  danger?: boolean;
  pending?: boolean;
  closeOnConfirm?: boolean;
}) => {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const busy = pending || running;

  useEffect(() => {
    if (!open) {
      setRunning(false);
      setError('');
    }
  }, [open]);

  const confirm = async () => {
    if (busy) return;
    setRunning(true);
    setError('');
    try {
      await onConfirm();
      if (closeOnConfirm) onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Radnja nije uspela. Pokušajte ponovo.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-[2px]" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[61] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-3xl border bg-background p-5 shadow-2xl">
          <AlertDialog.Title className="text-lg font-bold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-6 text-muted">
            {description}
          </AlertDialog.Description>
          {error ? (
            <p role="alert" className="mt-3 rounded-xl bg-danger-soft p-3 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="ghost" disabled={busy}>
                Otkaži
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                variant={danger ? 'danger' : 'primary'}
                disabled={busy}
                aria-busy={busy}
                onClick={(event) => {
                  event.preventDefault();
                  void confirm();
                }}
              >
                {busy ? 'Čuvam…' : confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
};
