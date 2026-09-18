import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { PageHeader } from './PageHeader';

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
    <PageHeader eyebrow={eyebrow} title={title} description={description} action={action} />
    {children}
  </main>
);
