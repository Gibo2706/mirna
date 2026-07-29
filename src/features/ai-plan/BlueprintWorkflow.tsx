import { useRef, useState } from 'react';
import { ArrowLeft, ClipboardCopy, FileJson, Share2, ShieldCheck, Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ToastProvider';
import { formatDate } from '@/lib/dates';
import { formatRsd, parseIntegerInput } from '@/lib/format';
import { copyText } from '@/features/export/backup';
import {
  createBlueprintPrompt,
  importPlanBlueprint,
  MAX_AI_PLAN_INPUT_BYTES,
  parsePlanBlueprint,
  setBlueprintStartingBalance,
  type PlanBlueprintPreview,
} from './blueprint';

type Step = 'instructions' | 'input' | 'preview';

export const BlueprintWorkflow = ({
  onImported,
  onBack,
}: {
  onImported: () => void;
  onBack?: () => void;
}) => {
  const { success } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('instructions');
  const [raw, setRaw] = useState('');
  const [preview, setPreview] = useState<PlanBlueprintPreview | null>(null);
  const [balanceDrafts, setBalanceDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const prompt = createBlueprintPrompt();

  const sharePrompt = async () => {
    setError('');
    if (!navigator.share) {
      await copyText(prompt);
      success('Deljenje nije podržano; prompt je kopiran.');
      return;
    }
    try {
      await navigator.share({
        title: 'Mirna Plan Blueprint v1',
        text: prompt,
      });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError('Prompt nije podeljen. Možete ga kopirati.');
    }
  };

  const validate = (value = raw) => {
    setError('');
    try {
      const nextPreview = parsePlanBlueprint(value);
      setRaw(value);
      setPreview(nextPreview);
      setBalanceDrafts({});
      setStep('preview');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Plan nije validan.');
    }
  };

  if (step === 'instructions') {
    return (
      <section className="mx-auto w-full max-w-2xl">
        {onBack ? (
          <button
            className="mb-5 flex min-h-11 items-center gap-2 text-sm font-semibold text-muted"
            onClick={onBack}
          >
            <ArrowLeft size={18} /> Nazad
          </button>
        ) : null}
        <p className="text-sm font-semibold text-accent">Mirna Plan Blueprint v1</p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight">
          Prenesite već dogovoren plan
        </h1>
        <p className="mt-3 max-w-xl leading-7 text-muted">
          Kopirajte uputstvo u razgovor u kom ste već pravili plan. Zatim vratite dobijeni JSON u
          Mirnu na lokalnu proveru.
        </p>
        <ol className="mt-7 grid gap-3">
          {[
            ['1', 'Kopirajte uputstvo'],
            ['2', 'Pošaljite ga postojećem AI razgovoru'],
            ['3', 'Vratite samo dobijeni JSON ovde'],
          ].map(([number, label]) => (
            <li key={number} className="flex min-h-14 items-center gap-3 border-b py-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-sm font-bold">
                {number}
              </span>
              <span className="font-semibold">{label}</span>
            </li>
          ))}
        </ol>
        <div className="mt-6 flex items-start gap-3 rounded-2xl bg-accent-soft p-4 text-sm">
          <ShieldCheck className="mt-0.5 shrink-0 text-accent" size={19} />
          <p>
            <strong>Mirna nema vezu sa AI servisima.</strong> Vi birate šta ćete kopirati ili
            podeliti. U ovoj fazi prompt ne sadrži vaše finansijske podatke.
          </p>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Button
            size="lg"
            onClick={() => {
              void copyText(prompt)
                .then(() => success('Blueprint prompt je kopiran.'))
                .catch(() => setError('Prompt nije kopiran. Označite ga ručno.'));
            }}
          >
            <ClipboardCopy size={18} /> Kopiraj prompt
          </Button>
          <Button size="lg" variant="secondary" onClick={() => void sharePrompt()}>
            <Share2 size={18} /> Podeli
          </Button>
        </div>
        <Button className="mt-3 w-full" variant="outline" onClick={() => setStep('input')}>
          Imam JSON
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
      <section className="mx-auto w-full max-w-2xl">
        <button
          className="mb-5 flex min-h-11 items-center gap-2 text-sm font-semibold text-muted"
          onClick={() => setStep('instructions')}
        >
          <ArrowLeft size={18} /> Uputstvo
        </button>
        <p className="text-sm font-semibold text-accent">Lokalna provera</p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight">Nalepite Blueprint JSON</h1>
        <p className="mt-2 leading-7 text-muted">
          Mirna prihvata i jedan jednostavan <code>```json</code> blok. Podaci se još ne upisuju.
        </p>
        <Field label="Mirna Plan Blueprint v1">
          <Textarea
            className="mt-5 min-h-72 font-mono text-sm"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            placeholder='{"planBlueprintVersion":1,"currency":"RSD",...}'
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
            Proveri plan
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

  if (!preview) return null;
  const blueprint = preview.blueprint;
  return (
    <section className="mx-auto w-full max-w-3xl">
      <button
        className="mb-5 flex min-h-11 items-center gap-2 text-sm font-semibold text-muted"
        onClick={() => setStep('input')}
      >
        <ArrowLeft size={18} /> Izmeni JSON
      </button>
      <p className="text-sm font-semibold text-accent">Pregled pre uvoza</p>
      <h1 className="mt-1 text-3xl font-extrabold tracking-tight">Plan je spreman za proveru</h1>
      <p className="mt-2 leading-7 text-muted">
        Mirna je proverila format i reference. Vi proveravate da li su finansijske odluke zaista
        vaše.
      </p>

      {preview.warnings.map((warning) => (
        <p key={warning} className="mt-4 rounded-xl bg-warning-soft p-3 text-sm text-warning">
          {warning}
        </p>
      ))}

      <div className="mt-6 grid gap-5 md:grid-cols-2">
        <PreviewGroup title="Računi" empty="Nema računa">
          {blueprint.accounts.map((value) => (
            <div key={value.key} className="px-4 py-3">
              <p className="break-words font-semibold">{value.name}</p>
              {value.startingBalance === null ? (
                <div className="mt-3">
                  <Field
                    label="Potrebno je trenutno stanje"
                    hint="Unesite 0 samo ako je račun zaista prazan."
                  >
                    <Input
                      aria-label={`Trenutno stanje — ${value.name}`}
                      inputMode="numeric"
                      value={balanceDrafts[value.key] ?? ''}
                      placeholder="RSD"
                      onChange={(event) =>
                        setBalanceDrafts((current) => ({
                          ...current,
                          [value.key]: event.target.value,
                        }))
                      }
                      onBlur={() => {
                        const nextValue = balanceDrafts[value.key]?.trim();
                        if (!nextValue) return;
                        setPreview(
                          setBlueprintStartingBalance(
                            preview,
                            value.key,
                            parseIntegerInput(nextValue),
                          ),
                        );
                      }}
                    />
                  </Field>
                </div>
              ) : (
                <p className="mt-1 break-words text-sm text-muted">
                  Početno stanje · {formatRsd(value.startingBalance)}
                </p>
              )}
            </div>
          ))}
        </PreviewGroup>
        <PreviewGroup title="Prihodi" empty="Nema planiranih prihoda">
          {blueprint.plannedIncomes.map((value) => (
            <PreviewRow
              key={value.key}
              title={value.name}
              detail={`${formatRsd(value.amount)} · ${value.frequency === 'monthly' ? 'mesečno' : value.frequency}`}
            />
          ))}
        </PreviewGroup>
        <PreviewGroup title="Budžeti" empty="Nema budžeta">
          {blueprint.variableBudgets.map((value) => (
            <PreviewRow
              key={value.key}
              title={value.name}
              detail={formatRsd(value.defaultAmount)}
            />
          ))}
        </PreviewGroup>
        <PreviewGroup title="Ciljevi" empty="Nema ciljeva">
          {blueprint.goals.map((value) => (
            <PreviewRow
              key={value.key}
              title={`${value.emoji} ${value.name}`}
              detail={`${formatRsd(value.targetAmount)}${value.targetDate ? ` · do ${formatDate(value.targetDate)}` : ''}`}
            />
          ))}
        </PreviewGroup>
        <PreviewGroup title="Obaveze" empty="Nema obaveza">
          {blueprint.fixedCommitments.map((value) => (
            <PreviewRow
              key={value.key}
              title={value.name}
              detail={`${formatRsd(value.amount)} · ${value.frequency === 'monthly' ? 'mesečno' : value.frequency}`}
            />
          ))}
        </PreviewGroup>
        <PreviewGroup title="Dugovi" empty="Nema dugova">
          {blueprint.debts.map((value) => (
            <PreviewRow
              key={value.key}
              title={value.creditor}
              detail={formatRsd(value.originalAmount)}
            />
          ))}
        </PreviewGroup>
        <PreviewGroup title="Događaji" empty="Nema događaja">
          {blueprint.plannedEvents.map((value) => (
            <PreviewRow
              key={value.key}
              title={value.title}
              detail={`${formatDate(value.date)} · ${formatRsd(value.plannedAmount)}`}
            />
          ))}
        </PreviewGroup>
        <PreviewGroup title="Ostalo" empty="Nema dodatnih stavki">
          {[
            ...blueprint.salaryScenarios.map((value) => ({
              key: `scenario-${value.key}`,
              title: value.name,
              detail: `Scenario · ${formatRsd(value.monthlyAmount)}`,
            })),
            ...blueprint.quickAddPresets.map((value) => ({
              key: `preset-${value.key}`,
              title: value.name,
              detail: 'Brzi unos',
            })),
          ].map((value) => (
            <PreviewRow key={value.key} title={value.title} detail={value.detail} />
          ))}
        </PreviewGroup>
      </div>

      <div className="mt-7 flex items-start gap-3 rounded-2xl bg-surface-2 p-4 text-sm">
        <FileJson className="mt-0.5 shrink-0 text-muted" size={19} />
        <p>
          Uvoz kreira planerske stavke i opciona početna stanja. Ne kreira istorijske transakcije,
          uplate ili oznake da je nešto plaćeno.
        </p>
      </div>
      {error ? (
        <p role="alert" className="mt-4 rounded-xl bg-danger-soft p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Button
          size="lg"
          disabled={saving || preview.unresolvedAccountKeys.length > 0}
          onClick={() => {
            setSaving(true);
            setError('');
            void importPlanBlueprint(preview, false)
              .then(() => {
                success('Plan je uvezen.');
                onImported();
              })
              .catch((caught) => {
                setError(caught instanceof Error ? caught.message : 'Plan nije uvezen.');
                setSaving(false);
              });
          }}
        >
          {saving ? 'Uvozim…' : 'Uvezi plan'}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={() => setStep('input')}>
          Odustani
        </Button>
      </div>
    </section>
  );
};

const PreviewGroup = ({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) => {
  const count = Array.isArray(children) ? children.length : children ? 1 : 0;
  return (
    <Card className="p-0">
      <h2 className="border-b px-4 py-3 text-sm font-bold">{title}</h2>
      <div className="divide-y">
        {count ? children : <p className="p-4 text-sm text-muted">{empty}</p>}
      </div>
    </Card>
  );
};

const PreviewRow = ({ title, detail }: { title: string; detail: string }) => (
  <div className="px-4 py-3">
    <p className="break-words font-semibold">{title}</p>
    <p className="mt-0.5 text-sm text-muted">{detail}</p>
  </div>
);
