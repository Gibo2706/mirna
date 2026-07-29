import { Laptop, Moon, Sun } from 'lucide-react';
import type { Appearance, FinanceSnapshot } from '@/domain/types';
import { updateSettings } from '@/db/commands';
import { Card } from '@/components/ui/Card';
import { SettingsLayout } from '@/components/SettingsLayout';

const options: Array<{ value: Appearance; label: string; detail: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Svetli', detail: 'Uvek svetla tema', icon: Sun },
  { value: 'dark', label: 'Tamni', detail: 'Uvek tamna tema', icon: Moon },
  { value: 'system', label: 'Sistemski', detail: 'Prati Android / računar', icon: Laptop },
];

export const AppearanceManager = ({ snapshot }: { snapshot: FinanceSnapshot }) => (
  <SettingsLayout
    title="Izgled"
    description="Tema se čuva lokalno i nema uticaja na finansijske podatke."
  >
    <Card className="divide-y p-0">
      {options.map(({ value, label, detail, icon: Icon }) => {
        const active = snapshot.settingsRecord.appearance === value;
        return (
          <button
            key={value}
            className="flex min-h-20 w-full items-center gap-3 p-4 text-left"
            onClick={() => void updateSettings({ appearance: value })}
          >
            <span
              className={`grid size-11 place-items-center rounded-2xl ${active ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted'}`}
            >
              <Icon size={20} />
            </span>
            <span className="flex-1">
              <span className="block font-bold">{label}</span>
              <span className="block text-xs text-muted">{detail}</span>
            </span>
            <span
              className={`size-5 rounded-full border-2 p-1 ${active ? 'border-accent' : 'border-border'}`}
            >
              {active ? <span className="block size-full rounded-full bg-accent" /> : null}
            </span>
          </button>
        );
      })}
    </Card>
  </SettingsLayout>
);
