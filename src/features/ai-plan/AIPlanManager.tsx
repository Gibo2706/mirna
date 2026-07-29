import { useState } from 'react';
import { ArrowRight, FileJson, ShieldCheck, Sparkles } from 'lucide-react';
import type { FinanceSnapshot } from '@/domain/types';
import { SettingsLayout } from '@/components/SettingsLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PatchWorkflow } from './PatchWorkflow';

type Mode = 'overview' | 'patch' | 'blueprint';

export const AIPlanManager = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const [mode, setMode] = useState<Mode>('overview');

  if (mode === 'patch') {
    return (
      <SettingsLayout eyebrow="Podaci i alati" title="Predlog izmena plana">
        <PatchWorkflow snapshot={snapshot} onBack={() => setMode('overview')} />
      </SettingsLayout>
    );
  }

  if (mode === 'blueprint') {
    return (
      <SettingsLayout eyebrow="Podaci i alati" title="Uvoz novog plana">
        <Card className="border-warning bg-warning-soft">
          <FileJson className="text-warning" />
          <h2 className="mt-3 text-lg font-bold">Blueprint je namenjen praznoj Mirni</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            Ovaj uređaj već ima plan. Potpuni Blueprint bi mogao da napravi duplikate, zato V2.3 ne
            spaja Blueprint sa postojećim podacima. Koristite Predlog izmena, koji radi sa stabilnim
            referencama i ne može da menja istorijske transakcije.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button onClick={() => setMode('patch')}>Otvori Predlog izmena</Button>
            <Button variant="ghost" onClick={() => setMode('overview')}>
              Nazad
            </Button>
          </div>
        </Card>
      </SettingsLayout>
    );
  }

  return (
    <SettingsLayout
      eyebrow="Podaci i alati"
      title="AI pomoć za plan"
      description="Prenesite odluke iz postojećeg AI razgovora bez povezivanja Mirne sa AI servisom."
    >
      <div className="mb-5 flex items-start gap-3 rounded-2xl bg-accent-soft p-4 text-sm">
        <ShieldCheck className="mt-0.5 shrink-0 text-accent" size={19} />
        <p>
          <strong>Mirna nema vezu sa AI servisima.</strong> Vi birate šta ćete kopirati ili
          podeliti. Parsiranje, provera, pregled i primena rade lokalno.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <button className="text-left" onClick={() => setMode('patch')}>
          <Card className="h-full transition hover:border-accent">
            <span className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent">
              <Sparkles size={20} />
            </span>
            <h2 className="mt-4 text-lg font-bold">Predloži izmene postojećeg plana</h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              Napravite ograničen planerski kontekst, donesite Patch JSON i pregledajte razlike.
            </p>
            <span className="mt-5 flex items-center gap-1 text-sm font-bold text-accent">
              Otvori bezbedni tok <ArrowRight size={16} />
            </span>
          </Card>
        </button>
        <button className="text-left" onClick={() => setMode('blueprint')}>
          <Card className="h-full transition hover:border-accent">
            <span className="grid size-11 place-items-center rounded-xl bg-surface-2 text-muted">
              <FileJson size={20} />
            </span>
            <h2 className="mt-4 text-lg font-bold">Uvezi kompletan novi plan</h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              Blueprint v1 je namenjen novoj ili praznoj instalaciji, ne spajanju sa živim planom.
            </p>
            <span className="mt-5 flex items-center gap-1 text-sm font-bold text-muted">
              Saznaj više <ArrowRight size={16} />
            </span>
          </Card>
        </button>
      </div>
      <p className="mt-5 text-sm leading-6 text-muted">
        AI može pomoći da postojeći razgovor pretvorite u Mirna format. Pre uvoza uvek pregledate
        sve promene; Mirna ne može da garantuje da je spoljni finansijski savet razuman.
      </p>
    </SettingsLayout>
  );
};
