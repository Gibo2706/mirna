import type { ReactNode } from 'react';

export const PageHeader = ({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) => (
  <header className="mobile-safe-top mb-6 flex items-start justify-between gap-4">
    <div>
      {eyebrow ? <p className="mb-1 text-sm font-semibold text-accent">{eyebrow}</p> : null}
      <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{title}</h1>
      {description ? (
        <p className="mt-1 max-w-xl text-sm leading-6 text-muted">{description}</p>
      ) : null}
    </div>
    {action}
  </header>
);
