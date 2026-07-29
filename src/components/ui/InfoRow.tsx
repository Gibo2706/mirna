import type { ReactNode } from 'react';

export const InfoRow = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-4 border-b py-3 last:border-b-0">
    <dt className="text-sm text-muted">{label}</dt>
    <dd className="min-w-0 break-words text-right text-sm font-semibold">{value}</dd>
  </div>
);
