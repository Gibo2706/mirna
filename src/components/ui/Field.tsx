import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/cn';

export const Field = ({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) => (
  <label className="grid gap-1.5 text-sm font-medium">
    <span>{label}</span>
    {children}
    {error ? (
      <span className="text-xs font-normal text-danger">{error}</span>
    ) : hint ? (
      <span className="text-xs font-normal text-muted">{hint}</span>
    ) : null}
  </label>
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'min-h-12 w-full rounded-xl border bg-surface px-3.5 text-base text-foreground placeholder:text-muted/70',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn('min-h-12 w-full rounded-xl border bg-surface px-3.5 text-base', className)}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'min-h-24 w-full resize-y rounded-xl border bg-surface px-3.5 py-3 text-base placeholder:text-muted/70',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';
