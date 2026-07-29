import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type StatusTone = 'neutral' | 'positive' | 'warning' | 'danger';

const toneClasses: Record<StatusTone, string> = {
  neutral: 'bg-surface-2 text-muted',
  positive: 'bg-accent-soft text-accent',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

export const StatusBadge = ({
  tone = 'neutral',
  className,
  ...props
}: { tone?: StatusTone } & HTMLAttributes<HTMLSpanElement>) => (
  <span
    className={cn(
      'inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-semibold',
      toneClasses[tone],
      className,
    )}
    {...props}
  />
);
