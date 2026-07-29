import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const Sheet = ({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=open]:animate-in" />
      <Dialog.Content
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-t-[1.75rem] border bg-background p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom sm:bottom-4 sm:rounded-[1.75rem]',
          className,
        )}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-border sm:hidden" />
        <div className="mb-5 pr-11">
          <Dialog.Title className="text-xl font-bold tracking-tight">{title}</Dialog.Title>
          {description ? (
            <Dialog.Description className="mt-1 text-sm text-muted">
              {description}
            </Dialog.Description>
          ) : null}
        </div>
        <Dialog.Close
          className="absolute right-4 top-5 grid size-11 place-items-center rounded-full bg-surface-2"
          aria-label="Zatvori"
        >
          <X size={20} />
        </Dialog.Close>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);
