import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export const EmptyState = ({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) => (
  <div className="rounded-card border border-dashed bg-surface/60 px-6 py-10 text-center">
    <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-surface-2 text-muted">
      <Icon size={23} />
    </div>
    <h3 className="mt-4 font-bold">{title}</h3>
    <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-muted">{description}</p>
    {action ? <div className="mt-5">{action}</div> : null}
  </div>
);
