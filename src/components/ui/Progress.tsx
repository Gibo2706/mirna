import { cn } from '@/lib/cn';

export const Progress = ({
  value,
  tone = 'accent',
  className,
}: {
  value: number;
  tone?: 'accent' | 'warning' | 'danger';
  className?: string;
}) => (
  <div
    className={cn('h-2 overflow-hidden rounded-full bg-surface-2', className)}
    role="progressbar"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(Math.max(0, Math.min(100, value)))}
  >
    <div
      className={cn(
        'h-full rounded-full transition-[width]',
        tone === 'accent' && 'bg-accent',
        tone === 'warning' && 'bg-warning',
        tone === 'danger' && 'bg-danger',
      )}
      style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
    />
  </div>
);
