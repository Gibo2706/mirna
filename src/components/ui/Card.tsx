import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const Card = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'rounded-card border bg-surface p-4 shadow-[0_4px_20px_rgb(0_0_0/0.035)]',
      className,
    )}
    {...props}
  />
);
