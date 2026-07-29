import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClipboardCopy,
  Download,
  ArrowRight,
  FileJson,
  FileSpreadsheet,
  MessageSquareText,
  RotateCcw,
  Share2,
  ShieldCheck,
  Upload,
  WandSparkles,
} from 'lucide-react';
import { Link } from 'react-router';
import type { FinanceSnapshot } from '@/domain/types';
import { resetAllFinanceData, updateSettings } from '@/db/commands';
import {
  copyText,
  createChatGptMarkdown,
  createTransactionsCsv,
  describeImportSchemaVersion,
  downloadText,
  exportFullBackup,
  parseBackup,
  replaceWithBackup,
  shareTextFile,
  type ImportPreview,
} from './backup';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SettingsLayout } from '@/components/SettingsLayout';
import { useToast } from '@/components/ToastProvider';
import { formatBackupAgeMessage, formatByteSize } from '@/lib/format';

const ExportRow = ({
  icon: Icon,
  title,
  description,
  action,
  actionLabel = 'Izvezi',
}: {
  icon: typeof Download;
  title: string;
  description: string;
  action: () => void | Promise<void>;
  actionLabel?: string;
}) => (
  <div className="flex items-center gap-3 p-4">
    <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-surface-2 text-muted">
      <Icon size={20} />
    </span>
    <div className="min-w-0 flex-1">
      <p className="font-bold">{title}</p>
      <p className="mt-0.5 text-xs leading-5 text-muted">{description}</p>
    </div>
    <Button
      size="sm"
      variant="secondary"
      onClick={() => void action()}
      aria-label={`${actionLabel}: ${title}`}
    >
      <Download size={15} /> {actionLabel}
    </Button>
  </div>
);

export const DataManager = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const { success } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importError, setImportError] = useState('');
  const [confirmImport, setConfirmImport] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [actionError, setActionError] = useState('');
  const [storage, setStorage] = useState<{
    status: 'loading' | 'persistent' | 'best-effort' | 'unsupported';
    usage?: number;
    quota?: number;
  }>({ status: 'loading' });

  const refreshStorage = useCallback(async () => {
    if (!navigator.storage?.persisted) {
      setStorage({ status: 'unsupported' });
      return;
    }
    try {
      const [persistent, estimate] = await Promise.all([
        navigator.storage.persisted(),
        navigator.storage.estimate?.(),
      ]);
      setStorage({
        status: persistent ? 'persistent' : 'best-effort',
        usage: estimate?.usage,
        quota: estimate?.quota,
      });
    } catch {
      setStorage({ status: 'unsupported' });
    }
  }, []);

  useEffect(() => {
    void refreshStorage();
  }, [refreshStorage]);

  const fullBackup = async () => {
    setActionError('');
    try {
      const backup = await exportFullBackup();
      downloadText(backup.filename, backup.content, 'application/json;charset=utf-8');
      success('JSON backup je preuzet.');
      try {
        await updateSettings({
          lastBackupAt: new Date().toISOString(),
        });
      } catch {
        setActionError('Backup je preuzet, ali datum poslednjeg backup-a nije sačuvan.');
      }
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'JSON backup nije napravljen.');
    }
  };
  const markdownFilename = `mirna-chatgpt-${new Date().toISOString().slice(0, 10)}.md`;
  const markdown = () => createChatGptMarkdown(snapshot);
  const shareMarkdown = async () => {
    setActionError('');
    try {
      const content = markdown();
      const result = await shareTextFile({
        filename: markdownFilename,
        content,
        type: 'text/markdown;charset=utf-8',
        title: 'Mirna Financial Snapshot',
        text: 'Sažetak ličnih finansija iz aplikacije Mirna.',
      });
      if (result === 'unsupported') {
        downloadText(markdownFilename, content, 'text/markdown;charset=utf-8');
        success('Deljenje fajla nije podržano; Markdown je preuzet.');
      } else if (result === 'shared') {
        success('Sažetak je prosleđen izabranoj aplikaciji.');
      }
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Sažetak nije podeljen.');
    }
  };

  const copyMarkdown = async () => {
    setActionError('');
    try {
      await copyText(markdown());
      success('Sažetak je kopiran.');
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Sažetak nije kopiran.');
    }
  };

  const requestPersistentStorage = async () => {
    setActionError('');
    if (!navigator.storage?.persist) {
      setStorage({ status: 'unsupported' });
      return;
    }
    try {
      const granted = await navigator.storage.persist();
      await refreshStorage();
      success(
        granted
          ? 'Pregledač je odobrio trajniju zaštitu lokalnih podataka.'
          : 'Pregledač je zadržao standardnu zaštitu. JSON backup ostaje važan.',
      );
    } catch {
      setActionError('Zahtev za zaštitu skladišta nije uspeo.');
    }
  };

  const backupAgeDays = snapshot.settingsRecord.lastBackupAt
    ? Math.max(
        0,
        Math.floor(
          (Date.now() - new Date(snapshot.settingsRecord.lastBackupAt).getTime()) / 86_400_000,
        ),
      )
    : undefined;
  const storageTitle = {
    loading: 'Proveravam zaštitu…',
    persistent: 'Trajna zaštita uključena',
    'best-effort': 'Standardna zaštita',
    unsupported: 'Status zaštite nije dostupan',
  }[storage.status];
  const storageExplanation = {
    loading: 'Čitam status lokalnog skladišta iz pregledača.',
    persistent:
      'Pregledač je odobrio trajniju zaštitu lokalnih podataka. JSON backup je i dalje preporučen.',
    'best-effort':
      'Pregledač trenutno može osloboditi lokalne podatke ako mu zatreba prostor. JSON backup ostaje najsigurnija kopija.',
    unsupported:
      'Ovaj pregledač ne izlaže status trajnije zaštite. JSON backup ostaje najsigurnija kopija.',
  }[storage.status];
  const storageValue = (value?: number) => (value === undefined ? '—' : formatByteSize(value));

  const readImport = async (file?: File) => {
    if (!file) return;
    setImportError('');
    setPreview(null);
    try {
      const raw = await file.text();
      setPreview(parseBackup(raw));
    } catch (caught) {
      setImportError(caught instanceof Error ? caught.message : 'Backup nije pročitan.');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <SettingsLayout
      title="Podaci, backup i izvoz"
      description="Finansijski podaci su lokalni. Redovan JSON backup je vaša zaštita pri promeni ili gubitku uređaja."
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <section>
          <h2 className="mb-2 text-sm font-bold text-muted">Backup i izvoz</h2>
          <Card className="divide-y p-0">
            <ExportRow
              icon={FileJson}
              title="Kompletan JSON backup"
              description="Sve tabele, veze i podešavanja za potpuno vraćanje."
              action={fullBackup}
            />
            <ExportRow
              icon={FileSpreadsheet}
              title="Transakcije kao CSV"
              description="Excel / Google Sheets format sa datumom, tipom, kategorijom i računom."
              action={() => {
                downloadText(
                  `finance-transactions-${new Date().toISOString().slice(0, 10)}.csv`,
                  createTransactionsCsv(snapshot),
                  'text/csv;charset=utf-8',
                );
                success('CSV je preuzet.');
              }}
            />
            <ExportRow
              icon={MessageSquareText}
              title="Sažetak za ChatGPT"
              description="Čitljiv Markdown sa računima, planom, ciljevima, dugovima i prognozom."
              action={() => {
                downloadText(markdownFilename, markdown(), 'text/markdown;charset=utf-8');
                success('Markdown sažetak je preuzet.');
              }}
              actionLabel="Preuzmi"
            />
          </Card>
          <Card className="mt-3">
            <p className="font-bold">Pošaljite sažetak u ChatGPT ili drugu aplikaciju</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Web Share se koristi kada telefon podržava deljenje fajla. U suprotnom se Markdown
              automatski preuzima. Sve radi i bez interneta.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Button onClick={() => void shareMarkdown()}>
                <Share2 size={17} /> Podeli u drugu aplikaciju
              </Button>
              <Button variant="secondary" onClick={() => void copyMarkdown()}>
                <ClipboardCopy size={17} /> Kopiraj sažetak
              </Button>
            </div>
          </Card>
          <p
            className={`mt-2 rounded-xl p-3 text-xs ${
              backupAgeDays === undefined
                ? 'bg-warning-soft text-warning'
                : backupAgeDays <= 7
                  ? 'bg-accent-soft text-accent'
                  : 'bg-surface-2 text-muted'
            }`}
          >
            {backupAgeDays === undefined
              ? 'Još nema JSON backup-a. Napravite ga pre promene ili gubitka uređaja.'
              : formatBackupAgeMessage(backupAgeDays)}
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold text-muted">Vrati backup</h2>
          <Card>
            <div className="flex items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
                <Upload size={20} />
              </span>
              <div>
                <h3 className="font-bold">Učitaj JSON backup</h3>
                <p className="mt-1 text-xs leading-5 text-muted">
                  Fajl se prvo parsira, validira i proverava referencijalno. Postojeći podaci se ne
                  diraju dok ne potvrdite pregled.
                </p>
              </div>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(event) => void readImport(event.target.files?.[0])}
            />
            <Button
              className="mt-4 w-full"
              variant="outline"
              onClick={() => inputRef.current?.click()}
            >
              <Upload size={17} /> Izaberi backup fajl
            </Button>
            {importError ? (
              <p role="alert" className="mt-3 rounded-xl bg-danger-soft p-3 text-sm text-danger">
                {importError}
              </p>
            ) : null}
            {preview ? (
              <div className="mt-4 rounded-2xl bg-surface-2 p-4">
                <p className="font-bold">Backup je validan</p>
                <p className="mt-1 text-xs text-muted">
                  Izvezen {new Date(preview.envelope.exportedAt).toLocaleString('sr-Latn-RS')}
                  {' · '}
                  {describeImportSchemaVersion(preview.sourceSchemaVersion)}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <span>
                    Računi <strong className="float-right">{preview.counts.accounts}</strong>
                  </span>
                  <span>
                    Transakcije{' '}
                    <strong className="float-right">{preview.counts.transactions}</strong>
                  </span>
                  <span>
                    Obaveze <strong className="float-right">{preview.counts.commitments}</strong>
                  </span>
                  <span>
                    Ciljevi <strong className="float-right">{preview.counts.goals}</strong>
                  </span>
                  <span>
                    Dugovi <strong className="float-right">{preview.counts.debts}</strong>
                  </span>
                  <span>
                    Događaji <strong className="float-right">{preview.counts.plannedEvents}</strong>
                  </span>
                </div>
                <Button
                  className="mt-4 w-full"
                  variant="danger"
                  onClick={() => setConfirmImport(true)}
                >
                  Zameni postojeće podatke
                </Button>
              </div>
            ) : null}
          </Card>
        </section>
      </div>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-bold text-muted">Prenos i AI alati</h2>
        <Link
          to="/more/ai-plan"
          className="flex min-h-20 items-center gap-3 rounded-card border bg-surface p-4 transition hover:border-accent"
        >
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
            <WandSparkles size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-bold">AI pomoć za plan</span>
            <span className="mt-1 block text-xs leading-5 text-muted">
              Uvezite nov Blueprint u praznu Mirnu ili pripremite bezbedan Predlog izmena za
              postojeći plan.
            </span>
          </span>
          <ArrowRight className="shrink-0 text-muted" size={18} />
        </Link>
        <p className="mt-2 text-xs leading-5 text-muted">
          Backup vraća celu bazu. Blueprint prenosi novi plan. Patch menja samo pregledane planerske
          vrednosti.
        </p>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-bold text-muted">Lokalno skladište</h2>
        <Card
          className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          data-testid="storage-protection-card"
        >
          <div className="flex min-w-0 items-start gap-3" data-testid="storage-protection-header">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
              <ShieldCheck size={20} />
            </span>
            <div className="min-w-0 flex-1" data-testid="storage-protection-copy">
              <p className="font-bold">{storageTitle}</p>
              <p className="mt-1 text-xs leading-5 text-muted">{storageExplanation}</p>
              <div className="mt-3 grid gap-1 text-xs text-muted">
                <p>
                  Iskorišćeno{' '}
                  <strong className="text-foreground">{storageValue(storage.usage)}</strong>
                </p>
                <p>
                  Procena kvote{' '}
                  <strong className="text-foreground">~{storageValue(storage.quota)}</strong>
                </p>
              </div>
            </div>
          </div>
          {storage.status === 'best-effort' ? (
            <Button
              className="w-full sm:w-auto"
              size="sm"
              variant="secondary"
              onClick={() => void requestPersistentStorage()}
              data-testid="storage-protection-action"
            >
              Zaštiti lokalne podatke
            </Button>
          ) : null}
        </Card>
      </section>

      {actionError ? (
        <p role="alert" className="mt-4 rounded-xl bg-danger-soft p-3 text-sm text-danger">
          {actionError}
        </p>
      ) : null}

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-bold text-danger">Opasna zona</h2>
        <Card className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-danger-soft text-danger">
            <RotateCcw size={20} />
          </span>
          <div className="flex-1">
            <p className="font-bold">Obriši sve lokalne podatke</p>
            <p className="text-xs text-muted">
              Aplikacija se vraća na onboarding. Pre ovoga izvezite JSON backup.
            </p>
          </div>
          <Button size="sm" variant="danger" onClick={() => setConfirmReset(true)}>
            Obriši
          </Button>
        </Card>
      </section>

      <ConfirmDialog
        open={confirmImport}
        onOpenChange={setConfirmImport}
        title="Zameniti sve postojeće podatke?"
        description="Validirani backup će atomski zameniti sve lokalne tabele. Ako bilo koji upis ne uspe, trenutni podaci ostaju netaknuti."
        danger
        confirmLabel="Zameni podatke"
        onConfirm={async () => {
          if (!preview) return;
          try {
            await replaceWithBackup(preview);
            setPreview(null);
            setConfirmImport(false);
            success('Backup je uspešno vraćen.');
          } catch {
            setImportError('Uvoz nije primenjen. Postojeći podaci su ostali netaknuti.');
            setConfirmImport(false);
          }
        }}
      />
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Obrisati sve podatke sa ovog uređaja?"
        description="Ovo uključuje račune, transakcije, planove, ciljeve i podešavanja. Oporavak je moguć samo iz JSON backup-a."
        danger
        confirmLabel="Obriši sve"
        onConfirm={async () => {
          await resetAllFinanceData();
          setConfirmReset(false);
        }}
      />
    </SettingsLayout>
  );
};
