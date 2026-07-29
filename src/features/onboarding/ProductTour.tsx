import { useState } from 'react';
import { BarChart3, CalendarRange, Home, MoreHorizontal, PlusCircle, Target } from 'lucide-react';
import { Button } from '@/components/ui/Button';

const tourSteps = [
  {
    title: 'Početna',
    description: 'Pregled ovog meseca i koliko je bezbedno potrošiti.',
    icon: Home,
  },
  {
    title: 'Brzi unos',
    description: 'Brzo zabeleži ono što se upravo desilo.',
    icon: PlusCircle,
  },
  {
    title: 'Mesec',
    description: 'Planirano i stvarno na jednom mestu.',
    icon: CalendarRange,
  },
  {
    title: 'Ciljevi',
    description: 'Odvoji novac za ono što dolazi.',
    icon: Target,
  },
  {
    title: 'Prognoza',
    description: 'Pogledaj unapred gde plan postaje tesan.',
    icon: BarChart3,
  },
  {
    title: 'Više',
    description: 'Računi, obaveze, dugovi, backup i ostala podešavanja.',
    icon: MoreHorizontal,
  },
] as const;

export const ProductTour = ({
  onComplete,
  completeLabel = 'Završi vodič',
}: {
  onComplete: () => void;
  completeLabel?: string;
}) => {
  const [index, setIndex] = useState(0);
  const step = tourSteps[index];
  const Icon = step.icon;
  const last = index === tourSteps.length - 1;

  return (
    <section aria-label="Vodič kroz Mirnu" className="mx-auto w-full max-w-lg">
      <div className="flex gap-1.5" aria-label={`Korak ${index + 1} od ${tourSteps.length}`}>
        {tourSteps.map((value, stepIndex) => (
          <span
            key={value.title}
            className={`h-1.5 flex-1 rounded-full ${
              stepIndex <= index ? 'bg-accent' : 'bg-surface-2'
            }`}
          />
        ))}
      </div>
      <div className="py-10 text-center">
        <span className="mx-auto grid size-16 place-items-center rounded-2xl bg-accent-soft text-accent">
          <Icon size={29} />
        </span>
        <p className="mt-7 text-sm font-semibold text-muted">
          {index + 1} / {tourSteps.length}
        </p>
        <h2 className="mt-1 text-3xl font-extrabold tracking-tight">{step.title}</h2>
        <p className="mx-auto mt-3 max-w-sm text-base leading-7 text-muted">{step.description}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="ghost"
          disabled={index === 0}
          onClick={() => setIndex((value) => Math.max(0, value - 1))}
        >
          Nazad
        </Button>
        <Button
          onClick={() => {
            if (last) onComplete();
            else setIndex((value) => value + 1);
          }}
        >
          {last ? completeLabel : 'Dalje'}
        </Button>
      </div>
    </section>
  );
};
