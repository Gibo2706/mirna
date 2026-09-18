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
          'fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92dvh] flex-col w-full max-w-2xl overflow-hidden rounded-t-2xl bg-background shadow-2xl data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom sm:bottom-4 sm:rounded-2xl',
          className,
        )}
      >
        <div className="shrink-0 px-4 pt-4 sm:px-6 sm:pt-6">
          <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-border sm:hidden" />
          <div className="mb-5 pr-11">
            <Dialog.Title className="text-xl font-bold tracking-tight">{title}</Dialog.Title>
            <Dialog.Description className={description ? 'mt-1 text-sm text-muted' : 'sr-only'}>
              {description ?? title}
            </Dialog.Description>
          </div>
          <Dialog.Close
            className="absolute right-4 top-5 grid size-11 place-items-center rounded-full bg-surface-2"
            aria-label="Zatvori"
          >
            <X size={20} />
          </Dialog.Close>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-6">
          {children}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);
