import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { formatRsd } from '@/lib/format';

export const MoneyValue = ({
  value,
  className,
  ...props
}: { value: number } & Omit<HTMLAttributes<HTMLSpanElement>, 'children'>) => (
  <span className={cn('money whitespace-nowrap font-bold', className)} {...props}>
    {formatRsd(value)}
  </span>
);
