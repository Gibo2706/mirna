import { useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Database,
  FileJson,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Sparkles,
  WalletCards,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import type { FinanceSnapshot } from '@/domain/types';
import { updateSettings } from '@/db/commands';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, Input, Select } from '@/components/ui/Field';
import { parseIntegerInput } from '@/lib/format';
import { parseBackup, replaceWithBackup, type ImportPreview } from '@/features/export/backup';
import { BlueprintWorkflow } from '@/features/ai-plan/BlueprintWorkflow';
import { genericCategories, initializeGenericSetup, type GenericSetupInput } from './genericSetup';
import { ProductTour } from './ProductTour';

type Step =
  | 'welcome'
  | 'privacy'
  | 'choice'
  | 'basic'
  | 'budget'
  | 'goal'
  | 'backup'
  | 'blueprint'
  | 'tour'
  | 'finish';

interface BudgetDraft {
  id: string;
  categoryKey: GenericSetupInput['budgets'][number]['categoryKey'];
  amount: number;
}

const optionalInteger = (value: string): number | undefined =>
  value.trim() ? parseIntegerInput(value) : undefined;

export const OnboardingPage = ({ snapshot }: { snapshot?: FinanceSnapshot | null }) => {
  const navigate = useNavigate();
  const backupInputRef = useRef<HTMLInputElement>(null);
  const hasPendingSetup = Boolean(
    snapshot &&
    (snapshot.accounts.length ||
      snapshot.categories.length ||
      snapshot.plannedIncomes.length ||
      snapshot.goals.length),
  );
  const [step, setStep] = useState<Step>(hasPendingSetup ? 'tour' : 'welcome');
  const [accountName, setAccountName] = useState('Tekući račun');
  const [currentBalance, setCurrentBalance] = useState(0);
  const [cashBalance, setCashBalance] = useState<number | undefined>();
  const [monthlyIncome, setMonthlyIncome] = useState<number | undefined>();
  const [incomeDay, setIncomeDay] = useState<number | undefined>();
  const [incomeTiming, setIncomeTiming] =
    useState<NonNullable<GenericSetupInput['incomeTiming']>>('currentMonth');
  const [budgets, setBudgets] = useState<BudgetDraft[]>([]);
  const [goalEnabled, setGoalEnabled] = useState(false);
  const [goalName, setGoalName] = useState('');
  const [goalAmount, setGoalAmount] = useState(0);
  const [goalDate, setGoalDate] = useState('');
  const [goalType, setGoalType] =
    useState<NonNullable<NonNullable<GenericSetupInput['goal']>['goalType']>>('sinking');
  const [backupPreview, setBackupPreview] = useState<ImportPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const back = (target: Step) => (
    <button
      className="mb-5 flex min-h-11 items-center gap-2 text-sm font-semibold text-muted"
      onClick={() => {
        setError('');
        setStep(target);
      }}
    >
      <ArrowLeft size={18} /> Nazad
    </button>
  );

  const commitSetup = async (includeGoal = goalEnabled) => {
    if (includeGoal && (!goalName.trim() || goalAmount <= 0)) {
      setError('Unesite naziv i ciljni iznos ili isključite prvi cilj.');
      return;
    }
    const categoryKeys = budgets
      .filter((value) => value.amount > 0)
      .map((value) => value.categoryKey);
    if (new Set(categoryKeys).size !== categoryKeys.length) {
      setError('Svaka kategorija može imati samo jedan početni budžet.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await initializeGenericSetup({
        accountName: accountName.trim(),
        currentBalance,
        cashBalance,
        monthlyIncome,
        incomeDay: monthlyIncome ? incomeDay : undefined,
        incomeTiming,
        budgets: budgets
          .filter((value) => value.amount > 0)
          .map(({ categoryKey, amount }) => ({ categoryKey, amount })),
        goal: includeGoal
          ? {
              name: goalName.trim(),
              targetAmount: goalAmount,
              targetDate: goalDate || undefined,
              goalType,
            }
          : undefined,
      });
      setStep('tour');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Početni plan nije sačuvan.');
    } finally {
      setSaving(false);
    }
  };

  const finish = async (destination: '/' | '/more') => {
    setSaving(true);
    setError('');
    try {
      await updateSettings({ onboardingCompleted: true });
      void navigate(destination, { replace: true });
    } catch {
      setError('Završetak nije sačuvan. Pokušajte ponovo.');
      setSaving(false);
    }
  };

  if (step === 'welcome') {
    return (
      <OnboardingShell>
        <div className="flex min-h-[calc(100dvh-4rem)] flex-col justify-center">
          <div className="flex items-center gap-3">
            <div className="grid size-12 place-items-center rounded-2xl bg-foreground text-lg font-black text-background">
              M
            </div>
            <p className="text-sm font-extrabold tracking-[0.14em]">MIRNA</p>
          </div>
          <h1 className="mt-10 max-w-lg text-4xl font-extrabold leading-[1.08] tracking-[-0.045em] sm:text-5xl">
            Planiraj. Beleži. Znaj šta te čeka.
          </h1>
          <div className="mt-8 grid gap-5 sm:grid-cols-3">
            {[
              ['Planirano', 'šta očekuješ'],
              ['Stvarno', 'šta se zaista desilo'],
              ['Prognoza', 'šta te čeka po trenutnom planu'],
            ].map(([title, description]) => (
              <div key={title} className="border-l-2 border-accent pl-4">
                <h2 className="font-bold">{title}</h2>
                <p className="mt-1 text-sm leading-6 text-muted">{description}</p>
              </div>
            ))}
          </div>
          <Button
            className="mt-10 w-full sm:w-auto sm:self-start"
            size="lg"
            onClick={() => setStep('privacy')}
          >
            Nastavi <ArrowRight size={19} />
          </Button>
        </div>
      </OnboardingShell>
    );
  }

  if (step === 'privacy') {
    return (
      <OnboardingShell>
        {back('welcome')}
        <div className="mx-auto max-w-xl py-8 text-center">
          <span className="mx-auto grid size-16 place-items-center rounded-2xl bg-accent-soft text-accent">
            <LockKeyhole size={29} />
          </span>
          <h1 className="mt-7 text-3xl font-extrabold tracking-tight">
            Vaši finansijski podaci ostaju na ovom uređaju.
          </h1>
          <p className="mx-auto mt-3 max-w-lg leading-7 text-muted">
            Mirna je local-first aplikacija. Ne traži nalog, ne povezuje banku i nema cloud
            sinhronizaciju.
          </p>
          <div className="mt-7 grid gap-3 text-left sm:grid-cols-3">
            {['Bez naloga', 'Bez bankovne veze', 'Bez cloud sync-a'].map((label) => (
              <div
                key={label}
                className="flex items-center gap-2 rounded-xl bg-surface-2 p-3 text-sm font-semibold"
              >
                <Check size={17} className="text-accent" /> {label}
              </div>
            ))}
          </div>
          <p className="mt-7 text-sm leading-6 text-muted">
            JSON backup je način oporavka pri promeni telefona ili brisanju browser podataka.
          </p>
          <Button className="mt-8 w-full" size="lg" onClick={() => setStep('choice')}>
            Razumem, nastavi
          </Button>
        </div>
      </OnboardingShell>
    );
  }

  if (step === 'choice') {
    return (
      <OnboardingShell>
        {back('privacy')}
        <p className="text-sm font-semibold text-accent">Početak</p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight">Kako želite da krenete?</h1>
        <p className="mt-2 text-muted">Izaberite put koji odgovara onome što već imate.</p>
        <div className="mt-7 grid gap-3">
          <Choice
            icon={WalletCards}
            title="Kreni od osnova"
            description="Postavi stanje računa i osnovni mesečni prihod."
            onClick={() => setStep('basic')}
            primary
          />
          <Choice
            icon={Database}
            title="Uvezi backup"
            description="Već koristiš Mirnu ili imaš raniju kopiju podataka."
            onClick={() => setStep('backup')}
          />
          <Choice
            icon={Sparkles}
            title="Već imam finansijski plan"
            description="Prenesi plan iz razgovora sa ChatGPT-om, Claude-om, Gemini-jem ili drugim AI alatom."
            onClick={() => setStep('blueprint')}
          />
        </div>
      </OnboardingShell>
    );
  }

  if (step === 'basic') {
    return (
      <OnboardingShell>
        {back('choice')}
        <StepHeader
          current={1}
          title="Postavite stvarnu osnovu"
          description="Dovoljan je jedan račun. Sve ostalo možete dodati kasnije."
        />
        <div className="mt-7 grid gap-5">
          <Field label="Naziv glavnog računa">
            <Input value={accountName} onChange={(event) => setAccountName(event.target.value)} />
          </Field>
          <Field label="Trenutno stanje (RSD)" hint="Početno stanje nije prihod.">
            <Input
              inputMode="numeric"
              value={currentBalance}
              onChange={(event) => setCurrentBalance(parseIntegerInput(event.target.value))}
            />
          </Field>
          <Field label="Keš stanje (opciono)">
            <Input
              inputMode="numeric"
              value={cashBalance ?? ''}
              placeholder="Preskoči"
              onChange={(event) => setCashBalance(optionalInteger(event.target.value))}
            />
          </Field>
          <div className="grid gap-4 border-t pt-5 sm:grid-cols-2">
            <Field label="Mesečna plata / prihod (opciono)">
              <Input
                inputMode="numeric"
                value={monthlyIncome ?? ''}
                placeholder="Preskoči"
                onChange={(event) => setMonthlyIncome(optionalInteger(event.target.value))}
              />
            </Field>
            <Field label="Očekivani dan (opciono)">
              <Input
                type="number"
                min={1}
                max={31}
                value={incomeDay ?? ''}
                disabled={!monthlyIncome}
                onChange={(event) =>
                  setIncomeDay(event.target.value ? Number(event.target.value) : undefined)
                }
              />
            </Field>
          </div>
          {monthlyIncome ? (
            <fieldset className="grid gap-3">
              <legend className="text-sm font-semibold">
                Kada ova plata prvi put ulazi u plan?
              </legend>
              <label className="flex min-h-14 items-start gap-3 rounded-xl border bg-surface px-4 py-3">
                <input
                  className="mt-1"
                  type="radio"
                  name="income-timing"
                  value="currentMonth"
                  checked={incomeTiming === 'currentMonth'}
                  onChange={() => setIncomeTiming('currentMonth')}
                />
                <span>
                  <strong className="block">Tek treba da stigne ovog meseca</strong>
                  <span className="mt-1 block text-sm text-muted">
                    Planirani prihod počinje u tekućem mesecu.
                  </span>
                </span>
              </label>
              <label className="flex min-h-14 items-start gap-3 rounded-xl border bg-surface px-4 py-3">
                <input
                  className="mt-1"
                  type="radio"
                  name="income-timing"
                  value="nextMonth"
                  checked={incomeTiming === 'nextMonth'}
                  onChange={() => setIncomeTiming('nextMonth')}
                />
                <span>
                  <strong className="block">Već je uključena u trenutno stanje</strong>
                  <span className="mt-1 block text-sm text-muted">
                    Ne dodajemo lažni priliv; plan plate počinje sledećeg meseca.
                  </span>
                </span>
              </label>
            </fieldset>
          ) : null}
        </div>
        {error ? <ErrorMessage>{error}</ErrorMessage> : null}
        <Button
          className="mt-7 w-full"
          size="lg"
          disabled={!accountName.trim() || currentBalance < 0}
          onClick={() => {
            setError('');
            setStep('budget');
          }}
        >
          Nastavi
        </Button>
      </OnboardingShell>
    );
  }

  if (step === 'budget') {
    return (
      <OnboardingShell>
        {back('basic')}
        <StepHeader
          current={2}
          title="Prvi mesečni budžet"
          description="Opciono. Dodajte samo ono što vam je sada korisno."
        />
        <div className="mt-7 grid gap-3">
          {budgets.map((budget) => (
            <div key={budget.id} className="grid grid-cols-[minmax(0,1fr)_8.5rem] gap-3">
              <Select
                aria-label="Kategorija budžeta"
                value={budget.categoryKey}
                onChange={(event) =>
                  setBudgets((current) =>
                    current.map((value) =>
                      value.id === budget.id
                        ? {
                            ...value,
                            categoryKey: event.target.value as BudgetDraft['categoryKey'],
                          }
                        : value,
                    ),
                  )
                }
              >
                {genericCategories
                  .filter((category) => category.kind === 'expense')
                  .map((category) => (
                    <option key={category.key} value={category.key}>
                      {category.icon} {category.name}
                    </option>
                  ))}
              </Select>
              <Input
                aria-label="Iznos budžeta"
                inputMode="numeric"
                value={budget.amount || ''}
                placeholder="RSD"
                onChange={(event) =>
                  setBudgets((current) =>
                    current.map((value) =>
                      value.id === budget.id
                        ? { ...value, amount: parseIntegerInput(event.target.value) }
                        : value,
                    ),
                  )
                }
              />
            </div>
          ))}
          {budgets.length < 5 ? (
            <Button
              variant="ghost"
              className="justify-start"
              onClick={() =>
                setBudgets((current) => [
                  ...current,
                  { id: crypto.randomUUID(), categoryKey: 'food', amount: 0 },
                ])
              }
            >
              <Plus size={17} /> Dodaj budžet
            </Button>
          ) : null}
        </div>
        {budgets.length === 0 ? (
          <p className="mt-6 rounded-xl bg-surface-2 p-4 text-sm text-muted">
            Budžete možete kasnije dodati kroz Više → Promenljivi budžeti.
          </p>
        ) : null}
        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          <Button size="lg" onClick={() => setStep('goal')}>
            Nastavi
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setBudgets([]);
              setStep('goal');
            }}
          >
            Preskoči
          </Button>
        </div>
      </OnboardingShell>
    );
  }

  if (step === 'goal') {
    return (
      <OnboardingShell>
        {back('budget')}
        <StepHeader
          current={3}
          title="Želite li da dodate prvi cilj?"
          description="Opciono. Mirna će napraviti povezan namenski štedni račun."
        />
        <label className="mt-7 flex min-h-14 items-center gap-3 rounded-xl border bg-surface px-4">
          <input
            type="checkbox"
            checked={goalEnabled}
            onChange={(event) => setGoalEnabled(event.target.checked)}
          />
          <span className="font-semibold">Dodaj prvi cilj</span>
        </label>
        {goalEnabled ? (
          <div className="mt-5 grid gap-4">
            <fieldset className="grid gap-3">
              <legend className="text-sm font-semibold">Kakav je ovo cilj?</legend>
              <label className="flex min-h-14 items-start gap-3 rounded-xl border bg-surface px-4 py-3">
                <input
                  className="mt-1"
                  type="radio"
                  name="goal-type"
                  value="sinking"
                  checked={goalType === 'sinking'}
                  onChange={() => setGoalType('sinking')}
                />
                <span>
                  <strong className="block">Štedim za konkretnu stvar</strong>
                  <span className="mt-1 block text-sm text-muted">
                    Na primer putovanje, uređaj ili veća kupovina.
                  </span>
                </span>
              </label>
              <label className="flex min-h-14 items-start gap-3 rounded-xl border bg-surface px-4 py-3">
                <input
                  className="mt-1"
                  type="radio"
                  name="goal-type"
                  value="reserve"
                  checked={goalType === 'reserve'}
                  onChange={() => setGoalType('reserve')}
                />
                <span>
                  <strong className="block">Pravim rezervu za nepredviđeno</strong>
                  <span className="mt-1 block text-sm text-muted">
                    Fond ostaje aktivan i kada dostigne ciljni iznos.
                  </span>
                </span>
              </label>
            </fieldset>
            <Field label="Naziv cilja">
              <Input value={goalName} onChange={(event) => setGoalName(event.target.value)} />
            </Field>
            <Field label="Ciljni iznos (RSD)">
              <Input
                inputMode="numeric"
                value={goalAmount || ''}
                onChange={(event) => setGoalAmount(parseIntegerInput(event.target.value))}
              />
            </Field>
            <Field label="Ciljni datum (opciono)">
              <Input
                type="date"
                value={goalDate}
                onChange={(event) => setGoalDate(event.target.value)}
              />
            </Field>
          </div>
        ) : null}
        {error ? <ErrorMessage>{error}</ErrorMessage> : null}
        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          <Button size="lg" disabled={saving} onClick={() => void commitSetup()}>
            {saving ? 'Čuvam…' : 'Nastavi na vodič'}
          </Button>
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setGoalEnabled(false);
              void commitSetup(false);
            }}
          >
            Preskoči
          </Button>
        </div>
      </OnboardingShell>
    );
  }

  if (step === 'backup') {
    return (
      <OnboardingShell>
        {back('choice')}
        <p className="text-sm font-semibold text-accent">Povratak podataka</p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight">Uvezite Mirna backup</h1>
        <p className="mt-2 leading-7 text-muted">
          Backup vraća celu aplikaciju, uključujući istorijske transakcije. To nije AI Blueprint.
        </p>
        <input
          ref={backupInputRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setError('');
            void file
              .text()
              .then((content) => setBackupPreview(parseBackup(content)))
              .catch((caught) =>
                setError(caught instanceof Error ? caught.message : 'Backup nije pročitan.'),
              )
              .finally(() => {
                if (backupInputRef.current) backupInputRef.current.value = '';
              });
          }}
        />
        <Button
          className="mt-7 w-full"
          size="lg"
          variant="outline"
          onClick={() => backupInputRef.current?.click()}
        >
          <FileJson size={18} /> Izaberi JSON backup
        </Button>
        {backupPreview ? (
          <Card className="mt-5">
            <h2 className="font-bold">Backup je validan</h2>
            <p className="mt-2 text-sm text-muted">
              {backupPreview.counts.accounts} računa · {backupPreview.counts.transactions}{' '}
              transakcija · {backupPreview.counts.goals} ciljeva
            </p>
            <Button
              className="mt-5 w-full"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void replaceWithBackup(backupPreview).catch(() => {
                  setError('Backup nije vraćen. Lokalni podaci su ostali netaknuti.');
                  setSaving(false);
                });
              }}
            >
              {saving ? 'Vraćam…' : 'Vrati backup'}
            </Button>
          </Card>
        ) : null}
        {error ? <ErrorMessage>{error}</ErrorMessage> : null}
      </OnboardingShell>
    );
  }

  if (step === 'blueprint') {
    return (
      <OnboardingShell wide>
        <BlueprintWorkflow onBack={() => setStep('choice')} onImported={() => setStep('tour')} />
      </OnboardingShell>
    );
  }

  if (step === 'tour') {
    return (
      <OnboardingShell>
        <p className="text-center text-sm font-semibold text-accent">Kratak vodič</p>
        <h1 className="mt-1 text-center text-3xl font-extrabold tracking-tight">Upoznajte Mirnu</h1>
        <div className="mt-7">
          <ProductTour onComplete={() => setStep('finish')} completeLabel="Završi" />
        </div>
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell>
      <div className="mx-auto max-w-xl py-12 text-center">
        <span className="mx-auto grid size-16 place-items-center rounded-2xl bg-accent-soft text-accent">
          <ShieldCheck size={30} />
        </span>
        <h1 className="mt-7 text-4xl font-extrabold tracking-tight">Mirna je spremna.</h1>
        <p className="mt-3 leading-7 text-muted">
          Počnite sa pregledom ili dodajte još detalja svog plana kada vam odgovara.
        </p>
        {error ? <ErrorMessage>{error}</ErrorMessage> : null}
        <div className="mt-8 grid gap-3">
          <Button size="lg" disabled={saving} onClick={() => void finish('/')}>
            Idi na početnu
          </Button>
          <Button variant="secondary" disabled={saving} onClick={() => void finish('/more')}>
            Još malo podesi plan
          </Button>
        </div>
      </div>
    </OnboardingShell>
  );
};

const OnboardingShell = ({
  children,
  wide = false,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) => (
  <main
    className={`mx-auto min-h-dvh w-full px-5 py-8 pb-[max(2rem,env(safe-area-inset-bottom))] ${
      wide ? 'max-w-4xl' : 'max-w-2xl'
    }`}
  >
    {children}
  </main>
);

const StepHeader = ({
  current,
  title,
  description,
}: {
  current: number;
  title: string;
  description: string;
}) => (
  <header>
    <p className="text-sm font-semibold text-accent">Osnovno podešavanje · {current}/3</p>
    <h1 className="mt-1 text-3xl font-extrabold tracking-tight">{title}</h1>
    <p className="mt-2 max-w-xl leading-7 text-muted">{description}</p>
  </header>
);

const Choice = ({
  icon: Icon,
  title,
  description,
  onClick,
  primary = false,
}: {
  icon: typeof WalletCards;
  title: string;
  description: string;
  onClick: () => void;
  primary?: boolean;
}) => (
  <button
    className={`group flex min-h-24 items-center gap-4 rounded-2xl border p-4 text-left transition active:scale-[0.99] ${
      primary ? 'bg-foreground text-background' : 'bg-surface hover:bg-surface-2'
    }`}
    onClick={onClick}
  >
    <span
      className={`grid size-11 shrink-0 place-items-center rounded-xl ${
        primary ? 'bg-accent text-white' : 'bg-surface-2 text-muted'
      }`}
    >
      <Icon size={20} />
    </span>
    <span className="min-w-0 flex-1">
      <span className="block font-bold">{title}</span>
      <span className={`mt-1 block text-sm leading-5 ${primary ? 'opacity-70' : 'text-muted'}`}>
        {description}
      </span>
    </span>
    <ArrowRight className={primary ? 'opacity-70' : 'text-muted'} size={19} />
  </button>
);

const ErrorMessage = ({ children }: { children: React.ReactNode }) => (
  <p role="alert" className="mt-4 rounded-xl bg-danger-soft p-3 text-sm text-danger">
    {children}
  </p>
);
