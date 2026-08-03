import {
  ArrowRight,
  CalendarClock,
  BanknoteArrowDown,
  CircleDollarSign,
  CloudCog,
  Database,
  Gauge,
  HelpCircle,
  Info,
  ListChecks,
  MoonStar,
  ReceiptText,
  Repeat2,
  Tags,
  UserRoundCheck,
  WalletCards,
  WandSparkles,
} from 'lucide-react';
import { Link } from 'react-router';
import type { FinanceSnapshot } from '@/domain/types';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/PageHeader';

const Row = ({
  to,
  icon: Icon,
  label,
  detail,
}: {
  to: string;
  icon: typeof WalletCards;
  label: string;
  detail?: string;
}) => (
  <Link to={to} className="flex min-h-16 items-center gap-3 px-4 transition hover:bg-surface-2">
    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
      <Icon size={19} />
    </span>
    <span className="flex-1 font-semibold">{label}</span>
    {detail ? <span className="text-xs text-muted">{detail}</span> : null}
    <ArrowRight size={17} className="text-muted" />
  </Link>
);

const backupDetail = (lastBackupAt?: string): string => {
  if (!lastBackupAt) return 'Napravite backup';
  const age = Math.floor((Date.now() - new Date(lastBackupAt).getTime()) / 86_400_000);
  return age <= 7 ? 'Backup je svež' : `Star ${age} dana`;
};

export const MorePage = ({
  snapshot,
  syncEnabled = false,
}: {
  snapshot: FinanceSnapshot;
  syncEnabled?: boolean;
}) => (
  <main className="screen">
    <PageHeader
      eyebrow="Kontrola"
      title="Više"
      description="Upravljajte planom, podacima i izgledom aplikacije."
    />
    <div className="grid gap-5 lg:grid-cols-2">
      <section>
        <h2 className="mb-2 px-1 text-sm font-bold text-muted">Novac</h2>
        <Card className="divide-y p-0">
          <Row
            to="/more/income"
            icon={BanknoteArrowDown}
            label="Planirani prihodi"
            detail={String(snapshot.plannedIncomes.filter((value) => value.active).length)}
          />
          <Row
            to="/more/accounts"
            icon={WalletCards}
            label="Računi"
            detail={String(snapshot.accounts.filter((value) => !value.archived).length)}
          />
          <Row
            to="/more/transactions"
            icon={Repeat2}
            label="Transakcije"
            detail={String(snapshot.transactions.length)}
          />
          <Row
            to="/more/commitments"
            icon={ReceiptText}
            label="Fiksne obaveze"
            detail={String(snapshot.commitments.filter((value) => value.active).length)}
          />
          <Row
            to="/more/budgets"
            icon={Gauge}
            label="Promenljivi budžeti"
            detail={String(snapshot.variableBudgets.filter((value) => value.active).length)}
          />
          <Row
            to="/more/categories"
            icon={Tags}
            label="Kategorije"
            detail={String(snapshot.categories.filter((value) => !value.archived).length)}
          />
          <Row
            to="/more/debts"
            icon={CircleDollarSign}
            label="Dugovi"
            detail={String(snapshot.debts.filter((value) => value.status === 'open').length)}
          />
          <Row
            to="/more/events"
            icon={CalendarClock}
            label="Planirani događaji"
            detail={String(
              snapshot.plannedEvents.filter((value) => !value.paidTransactionId).length,
            )}
          />
        </Card>
      </section>
      <div className="grid content-start gap-5">
        <section>
          <h2 className="mb-2 px-1 text-sm font-bold text-muted">Brzi unos i prognoza</h2>
          <Card className="divide-y p-0">
            <Row
              to="/more/presets"
              icon={ListChecks}
              label="Prečice za brzi unos"
              detail={String(snapshot.presets.filter((value) => value.active).length)}
            />
            <Row
              to="/more/scenarios"
              icon={UserRoundCheck}
              label="Scenariji plate"
              detail={String(snapshot.salaryScenarios.length)}
            />
          </Card>
        </section>
        <section>
          <h2 className="mb-2 px-1 text-sm font-bold text-muted">Podaci i alati</h2>
          <Card className="divide-y p-0">
            {syncEnabled ? (
              <Row to="/more/sync" icon={CloudCog} label="Sinhronizacija — Beta" detail="E2EE" />
            ) : null}
            <Row
              to="/more/data"
              icon={Database}
              label="Backup, uvoz i izvoz"
              detail={backupDetail(snapshot.settingsRecord.lastBackupAt)}
            />
            <Row
              to="/more/ai-plan"
              icon={WandSparkles}
              label="AI pomoć za plan"
              detail="Lokalni prenos"
            />
          </Card>
        </section>
        <section>
          <h2 className="mb-2 px-1 text-sm font-bold text-muted">Aplikacija</h2>
          <Card className="divide-y p-0">
            <Row
              to="/more/appearance"
              icon={MoonStar}
              label="Izgled"
              detail={
                snapshot.settingsRecord.appearance === 'system'
                  ? 'Sistemski'
                  : snapshot.settingsRecord.appearance === 'dark'
                    ? 'Tamni'
                    : 'Svetli'
              }
            />
            <Row to="/more/help" icon={HelpCircle} label="Pomoć i vodič" />
            <Row to="/more/about" icon={Info} label="O aplikaciji" />
          </Card>
        </section>
      </div>
    </div>
  </main>
);
