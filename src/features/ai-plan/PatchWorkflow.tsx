import { useRef, useState } from 'react';
import { ArrowLeft, ClipboardCopy, Share2, ShieldCheck, Upload } from 'lucide-react';
import type { FinanceSnapshot } from '@/domain/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ToastProvider';
import { copyText } from '@/features/export/backup';
import { MAX_AI_PLAN_INPUT_BYTES } from './blueprint';
import {
  applyPlanPatch,
  createPatchPrompt,
  parsePlanPatch,
  preparePlanPatch,
  type PreparedPlanPatch,
} from './patch';

type Step = 'instructions' | 'input' | 'preview';

const operationLabel = {
  create: 'NOVO',
  update: 'IZMENA',
  archive: 'ARHIVA',
  addGoalWithProtectedAccount: 'NOVI CILJ + RAČUN',
} as const;

export const PatchWorkflow = ({
  snapshot,
  onBack,
}: {
  snapshot: FinanceSnapshot;
  onBack: () => void;
}) => {
  const { success } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('instructions');
  const [raw, setRaw] = useState('');
  const [prepared, setPrepared] = useState<PreparedPlanPatch | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const prompt = createPatchPrompt(snapshot);

  const sharePrompt = async () => {
    setError('');
    if (!navigator.share) {
      await copyText(prompt);
      success('Deljenje nije podržano; uputstvo i kontekst su kopirani.');
      return;
    }
    try {
      await navigator.share({
        title: 'Mirna Plan Patch v1',
        text: prompt,
      });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError('Uputstvo nije podeljeno. Možete ga kopirati.');
    }
  };

  const validate = (value = raw) => {
    setError('');
    try {
      const patch = parsePlanPatch(value);
      const nextPrepared = preparePlanPatch(patch, snapshot);
      setRaw(value);
      setPrepared(nextPrepared);
      setStep('preview');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Predlog nije validan.');
    }
  };

  if (step === 'instructions') {
    return (
      <section>
        <button
          className="mb-5 flex min-h-11 items-center gap-2 text-sm font-semibold text-muted"
          onClick={onBack}
        >
          <ArrowLeft size={18} /> AI pomoć za plan
        </button>
        <p className="text-sm font-semibold text-accent">Mirna Plan Patch v1</p>
        <h2 className="mt-1 text-2xl font-extrabold tracking-tight">
          Predložite izmene postojećeg plana
        </h2>
        <p className="mt-3 max-w-2xl leading-7 text-muted">
          Mirna pravi mašinski čitljiv kontekst bez istorije transakcija. AI razgovor vraća samo
          predlog planerskih izmena, a vi pregledate svaku razliku.
        </p>
        <div className="mt-6 flex items-start gap-3 rounded-2xl bg-warning-soft p-4 text-sm">
          <ShieldCheck className="mt-0.5 shrink-0 text-warning" size={19} />
          <p>
            <strong>Ovaj prompt sadrži trenutni plan i high-level stanja.</strong> Mirna ga nigde ne
            šalje. Tekst napušta uređaj samo kada ga vi kopirate ili podelite.
          </p>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Button
            size="lg"
            onClick={() => {
              void copyText(prompt)
                .then(() => success('Patch uputstvo i kontekst su kopirani.'))
                .catch(() => setError('Sadržaj nije kopiran. Pokušajte ponovo.'));
            }}
          >
            <ClipboardCopy size={18} /> Kopiraj uputstvo i kontekst
          </Button>
          <Button size="lg" variant="secondary" onClick={() => void sharePrompt()}>
            <Share2 size={18} /> Podeli
          </Button>
        </div>
        <Button className="mt-3 w-full" variant="outline" onClick={() => setStep('input')}>
          Imam Patch JSON
        </Button>
        {error ? (
          <p role="alert" className="mt-3 rounded-xl bg-danger-soft p-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  if (step === 'input') {
    return (
      <section>
        <button
          className="mb-5 flex min-h-11 items-center gap-2 text-sm font-semibold text-muted"
          onClick={() => setStep('instructions')}
        >
          <ArrowLeft size={18} /> Uputstvo
        </button>
        <p className="text-sm font-semibold text-accent">Lokalna provera</p>
        <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Nalepite Plan Patch JSON</h2>
        <p className="mt-2 leading-7 text-muted">
          Provera odbija nepoznate reference i svaki pokušaj izmene istorijskih finansijskih
          podataka.
        </p>
        <Field label="Mirna Plan Patch v1">
          <Textarea
            className="mt-5 min-h-72 font-mono text-sm"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            placeholder='{"planPatchVersion":1,"operations":[...]}'
          />
        </Field>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > MAX_AI_PLAN_INPUT_BYTES) {
              setError('JSON fajl je prevelik. Maksimalna veličina je 512 KB.');
              if (fileRef.current) fileRef.current.value = '';
              return;
            }
            void file
              .text()
              .then((content) => validate(content))
              .finally(() => {
                if (fileRef.current) fileRef.current.value = '';
              });
          }}
        />
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Button variant="secondary" onClick={() => fileRef.current?.click()}>
            <Upload size={17} /> Učitaj JSON fajl
          </Button>
          <Button disabled={!raw.trim()} onClick={() => validate()}>
            Prikaži razlike
          </Button>
        </div>
        {error ? (
          <p role="alert" className="mt-3 rounded-xl bg-danger-soft p-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  if (!prepared) return null;
  return (
    <section>
      <button
        className="mb-5 flex min-h-11 items-center gap-2 text-sm font-semibold text-muted"
        onClick={() => setStep('input')}
      >
        <ArrowLeft size={18} /> Izmeni JSON
      </button>
      <p className="text-sm font-semibold text-accent">Pregled pre primene</p>
      <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Proverite svaku izmenu</h2>
      <p className="mt-2 leading-7 text-muted">
        Mirna je proverila dozvoljena polja i reference. Finansijski smisao predloga i dalje
        potvrđujete vi.
      </p>

      <div className="mt-6 grid gap-3">
        {prepared.operations.length ? (
          prepared.operations.map((operation) => (
            <Card key={operation.index} className="p-0">
              <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                <div>
                  <p
                    className={`text-[0.68rem] font-bold ${
                      operation.op === 'archive'
                        ? 'text-warning'
                        : operation.op === 'create' ||
                            operation.op === 'addGoalWithProtectedAccount'
                          ? 'text-accent'
                          : 'text-muted'
                    }`}
                  >
                    {operationLabel[operation.op]}
                  </p>
                  <h3 className="break-words font-bold">{operation.label}</h3>
                </div>
                <span className="text-xs text-muted">{operation.entity}</span>
              </div>
              <div className="divide-y">
                {operation.changes.map((change) => (
                  <div
                    key={change.field}
                    className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:items-center"
                  >
                    <p className="text-sm font-semibold">{change.label}</p>
                    <div className="min-w-0 text-sm">
                      {change.before !== undefined ? (
                        <>
                          <span className="break-words text-muted line-through">
                            {change.before}
                          </span>
                          <span className="mx-2 text-muted" aria-hidden="true">
                            →
                          </span>
                        </>
                      ) : null}
                      <strong className="break-words">{change.after}</strong>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))
        ) : (
          <p className="rounded-xl bg-surface-2 p-4 text-sm text-muted">
            Predlog ne sadrži izmene.
          </p>
        )}
      </div>
      <div className="mt-5 rounded-2xl bg-accent-soft p-4 text-sm">
        Stvarne transakcije, postojeća stanja računa, uplate dugova i plaćeni statusi ne mogu biti
        promenjeni ovim formatom. Novi namenski račun za cilj uvek počinje od 0 RSD i ne stvara
        novac.
      </div>
      {error ? (
        <p role="alert" className="mt-4 rounded-xl bg-danger-soft p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Button
          size="lg"
          disabled={saving || prepared.operations.length === 0}
          onClick={() => {
            setSaving(true);
            setError('');
            void applyPlanPatch(prepared)
              .then(() => {
                success('Pregledane izmene su primenjene.');
                onBack();
              })
              .catch((caught) => {
                setError(caught instanceof Error ? caught.message : 'Izmene nisu primenjene.');
                setSaving(false);
              });
          }}
        >
          {saving ? 'Primenjujem…' : 'Primeni izmene'}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onBack}>
          Odustani
        </Button>
      </div>
    </section>
  );
};
