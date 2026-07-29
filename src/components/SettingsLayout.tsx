import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

export const SettingsLayout = ({
  eyebrow = 'Podešavanja',
  title,
  description,
  action,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <main className="screen">
    <Link
      to="/more"
      className="mb-4 flex min-h-11 w-fit items-center gap-2 text-sm font-bold text-muted"
    >
      <ArrowLeft size={18} /> Više
    </Link>
    <header className="mb-6 flex items-start justify-between gap-3">
      <div>
        <p className="text-sm font-semibold text-accent">{eyebrow}</p>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight sm:text-3xl">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </header>
    {children}
  </main>
);
