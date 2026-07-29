import { useState } from 'react';
import { BookOpen, PlayCircle } from 'lucide-react';
import { SettingsLayout } from '@/components/SettingsLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Sheet } from '@/components/ui/Sheet';
import { ProductTour } from '@/features/onboarding/ProductTour';

export const HelpManager = () => {
  const [tourOpen, setTourOpen] = useState(false);
  return (
    <SettingsLayout
      eyebrow="Pomoć"
      title="Pomoć i vodič"
      description="Kratko podsećanje na razliku između plana, stvarnog stanja i prognoze."
    >
      <Card>
        <BookOpen className="text-accent" />
        <h2 className="mt-3 text-lg font-bold">Kako Mirna radi</h2>
        <dl className="mt-4 grid gap-4 text-sm">
          <div>
            <dt className="font-bold">Planirano</dt>
            <dd className="mt-1 text-muted">Ono što očekujete i nameravate da uradite.</dd>
          </div>
          <div>
            <dt className="font-bold">Stvarno</dt>
            <dd className="mt-1 text-muted">Ono što se zaista dogodilo na vašim računima.</dd>
          </div>
          <div>
            <dt className="font-bold">Prognoza</dt>
            <dd className="mt-1 text-muted">
              Deterministički pogled unapred ako nastavite po trenutnom planu.
            </dd>
          </div>
        </dl>
        <Button className="mt-6" onClick={() => setTourOpen(true)}>
          <PlayCircle size={18} /> Ponovi vodič
        </Button>
      </Card>
      <p className="mt-4 text-sm text-muted">
        Vodič je samo objašnjenje. Ne menja račune, stanja, planove ni transakcije.
      </p>
      <Sheet
        open={tourOpen}
        onOpenChange={setTourOpen}
        title="Vodič kroz Mirnu"
        description="Šest glavnih mesta, bez izmene finansijskih podataka."
      >
        <ProductTour onComplete={() => setTourOpen(false)} />
      </Sheet>
    </SettingsLayout>
  );
};
