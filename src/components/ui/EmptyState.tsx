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
  <div className="border-y px-2 py-8 text-left">
    <div className="text-muted">
      <Icon size={23} />
    </div>
    <h3 className="mt-4 font-bold">{title}</h3>
    <p className="mt-1 max-w-sm text-sm leading-6 text-muted">{description}</p>
    {action ? <div className="mt-5">{action}</div> : null}
  </div>
);
