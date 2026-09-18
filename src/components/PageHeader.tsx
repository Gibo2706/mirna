import type { ReactNode } from 'react';

export const PageHeader = ({
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) => (
  <header
    className="mobile-safe-top mb-7 flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"
    data-testid="page-header"
  >
    <div className="min-w-0">
      <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{title}</h1>
      {description ? (
        <p className="mt-1 max-w-xl text-sm leading-6 text-muted">{description}</p>
      ) : null}
    </div>
    {action ? (
      <div
        className="w-full shrink-0 sm:w-auto [&>button]:w-full sm:[&>button]:w-auto"
        data-testid="page-action"
      >
        {action}
      </div>
    ) : null}
  </header>
);
