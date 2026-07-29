import { useMemo, useState } from 'react';
import { AlertTriangle, CalendarRange, ChevronDown, Info, TrendingUp } from 'lucide-react';
import { Link } from 'react-router';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { FinanceSnapshot } from '@/domain/types';
import { calculateAccountBalances } from '@/domain/calculations';
import { calculateForecast } from '@/domain/forecast';
import { currentMonthKey, formatMonth } from '@/lib/dates';
import { formatCompactRsd, formatRsd } from '@/lib/format';
import { useCurrentDate } from '@/lib/useCurrentDate';
import { saveSalaryScenario, updateSettings } from '@/db/commands';
import { Card } from '@/components/ui/Card';
import { Field, Input, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/PageHeader';

export const ForecastPage = ({ snapshot }: { snapshot: FinanceSnapshot }) => {
  const currentDate = useCurrentDate();
  const currentMonth = currentMonthKey(currentDate);
  const [scenarioId, setScenarioId] = useState(
    snapshot.settingsRecord.activeSalaryScenarioId ?? '',
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState('');
  const scenario = snapshot.salaryScenarios.find((value) => value.id === scenarioId);
  const balances = useMemo(
    () => calculateAccountBalances(snapshot.accounts, snapshot.transactions),
    [snapshot.accounts, snapshot.transactions],
  );
  const forecast = calculateForecast({
    startMonth: currentMonth,
    months: 12,
    accounts: snapshot.accounts,
    accountBalances: balances,
    plannedIncomes: snapshot.plannedIncomes,
    scenario,
    commitments: snapshot.commitments,
    variableBudgets: snapshot.variableBudgets,
    plannedEvents: snapshot.plannedEvents,
    goals: snapshot.goals,
    debts: snapshot.debts,
    debtPayments: snapshot.debtPayments,
    transactions: snapshot.transactions,
  });
  const tightest = [...forecast].sort(
    (left, right) => left.monthlyPlanBalance - right.monthlyPlanBalance,
  )[0];
  const lowest = [...forecast].sort(
    (left, right) => left.projectedSpendableBalance - right.projectedSpendableBalance,
  )[0];
  const tightestIsCashDeficit = Boolean(tightest && tightest.projectedSpendableBalance < 0);
  const tightestHasPlanDeficit = Boolean(tightest && tightest.monthlyPlanBalance < 0);
  const chartData = forecast.map((item) => ({
    ...item,
    label: formatMonth(item.month).slice(0, 3),
    outflow:
      item.fixedCommitments +
      item.variableBudgets +
      item.plannedEvents +
      item.savingsContributions +
      item.debtRepayments,
  }));
  const hasPlan =
    snapshot.plannedIncomes.some((value) => value.active) ||
    snapshot.commitments.some((value) => value.active) ||
    snapshot.variableBudgets.some((value) => value.active) ||
    snapshot.plannedEvents.some((value) => !value.paidTransactionId) ||
    snapshot.goals.some((value) => !value.archived) ||
    snapshot.debts.some((value) => value.status === 'open');

  const updateScenarioStart = async (startMonth: string) => {
    if (!scenario) return;
    setError('');
    try {
      await saveSalaryScenario({ ...scenario, startMonth });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Početak scenarija nije sačuvan.');
    }
  };

  const selectScenario = async (nextScenarioId: string) => {
    const previous = scenarioId;
    setScenarioId(nextScenarioId);
    setError('');
    try {
      await updateSettings({
        activeSalaryScenarioId: nextScenarioId || undefined,
      });
    } catch (caught) {
      setScenarioId(previous);
      setError(caught instanceof Error ? caught.message : 'Scenario nije aktiviran.');
    }
  };

  if (!hasPlan) {
    return (
      <main className="screen">
        <PageHeader
          eyebrow="Narednih 12 meseci"
          title="Prognoza"
          description="Deterministički pregled onoga što sledi po trenutnom planu."
        />
        <Card className="border-dashed py-10 text-center">
          <CalendarRange className="mx-auto text-muted" size={28} />
          <h2 className="mt-4 text-lg font-bold">Prognoza još nema dovoljno plana</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
            Dodajte prihod i nekoliko planiranih troškova. Mirna neće prikazivati prazan grafikon
            kao da već postoji koristan signal.
          </p>
          <Link
            to="/more"
            className="mt-5 inline-flex min-h-11 items-center rounded-xl bg-accent px-4 text-sm font-semibold text-white"
          >
            Postavi plan
          </Link>
        </Card>
      </main>
    );
  }

  return (
    <main className="screen">
      <PageHeader
        eyebrow="Narednih 12 meseci"
        title="Prognoza"
        description="Deterministički pregled planiranog cash-flow-a, bez promene istorijskih podataka."
      />

      <Card className="mb-5 grid gap-4 sm:grid-cols-2">
        <Field label="Scenario plate">
          <Select value={scenarioId} onChange={(event) => void selectScenario(event.target.value)}>
            <option value="">Osnovni plan — bez scenarija</option>
            {snapshot.salaryScenarios.map((value) => (
              <option key={value.id} value={value.id}>
                {value.name} — {formatRsd(value.monthlyAmount)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Scenario važi od meseca" hint="Uključujući izabrani mesec.">
          <Input
            type="month"
            value={scenario?.startMonth ?? currentMonth}
            disabled={!scenario}
            onChange={(event) => void updateScenarioStart(event.target.value)}
          />
        </Field>
        <div className="flex items-start gap-2 rounded-xl bg-accent-soft p-3 text-sm sm:col-span-2">
          <Info size={17} className="mt-0.5 shrink-0 text-accent" />
          <p>
            Scenario utiče samo na prognozu. Mesečni plan i stvarne transakcije ostaju nepromenjeni.
          </p>
        </div>
      </Card>
      {error ? (
        <p role="alert" className="mb-5 rounded-xl bg-danger-soft p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Card
          className={
            tightestIsCashDeficit
              ? 'bg-danger-soft'
              : tightestHasPlanDeficit
                ? 'bg-warning-soft'
                : ''
          }
        >
          <p className="text-xs font-bold uppercase tracking-wide text-muted">
            Najslabiji mesečni saldo
          </p>
          <div className="mt-2 flex items-center gap-2">
            {tightestHasPlanDeficit ? (
              <AlertTriangle className={tightestIsCashDeficit ? 'text-danger' : 'text-warning'} />
            ) : (
              <TrendingUp className="text-accent" />
            )}
            <div>
              <p className="font-extrabold capitalize">
                {tightest ? formatMonth(tightest.month) : '—'}
              </p>
              <p className="money text-sm text-muted">
                Saldo plana {tightest ? formatRsd(tightest.monthlyPlanBalance) : '—'}
              </p>
            </div>
          </div>
        </Card>
        <Card>
          <p className="text-xs font-bold uppercase tracking-wide text-muted">
            Najniže raspoloživo stanje
          </p>
          <div className="mt-2 flex items-center gap-2">
            <CalendarRange className="text-accent" />
            <div>
              <p className="font-extrabold capitalize">
                {lowest ? formatMonth(lowest.month) : '—'}
              </p>
              <p
                className={`money text-sm ${lowest?.projectedSpendableBalance < 0 ? 'text-danger' : 'text-muted'}`}
              >
                {lowest ? formatRsd(lowest.projectedSpendableBalance) : '—'}
              </p>
            </div>
          </div>
        </Card>
      </div>

      <Card className="mt-5">
        <div>
          <h2 className="font-bold">Prilivi, planirani odlivi i stanje</h2>
          <p className="mt-1 text-xs text-muted">
            Zeleno: prihod · sivo: odlivi i alokacije · linija: raspoloživi novac
          </p>
        </div>
        <div className="mt-4 h-80 w-full" aria-label="Grafik prognoze za 12 meseci">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ left: -15, right: 4, top: 8 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis
                dataKey="label"
                interval={1}
                tick={{ fontSize: 11, fill: 'var(--muted)' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={formatCompactRsd}
                tick={{ fontSize: 10, fill: 'var(--muted)' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                formatter={(value) => formatRsd(Number(value))}
                contentStyle={{
                  borderRadius: 14,
                  borderColor: 'var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--foreground)',
                }}
              />
              <Bar
                dataKey="plannedIncome"
                name="Prihod"
                fill="var(--accent)"
                radius={[5, 5, 0, 0]}
              />
              <Bar
                dataKey="outflow"
                name="Planirani odlivi"
                fill="var(--border)"
                radius={[5, 5, 0, 0]}
              />
              <Line
                type="monotone"
                dataKey="projectedSpendableBalance"
                name="Raspoloživo stanje"
                stroke="var(--warning)"
                strokeWidth={3}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <section className="mt-5">
        <h2 className="mb-3 text-lg font-bold">Mesec po mesec</h2>
        <Card className="divide-y p-0">
          {forecast.map((item) => {
            const isExpanded = expanded === item.month;
            const shortfallTotal = Object.values(item.goalShortfalls).reduce(
              (sum, value) => sum + value,
              0,
            );
            return (
              <button
                key={item.month}
                className="w-full p-4 text-left"
                onClick={() => setExpanded(isExpanded ? null : item.month)}
                aria-expanded={isExpanded}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`size-2.5 shrink-0 rounded-full ${item.status === 'negative' ? 'bg-danger' : item.status === 'tight' ? 'bg-warning' : 'bg-accent'}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-bold capitalize">{formatMonth(item.month)}</p>
                    <p className="money text-xs text-muted">
                      saldo plana {formatRsd(item.monthlyPlanBalance)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p
                      className={`money text-sm font-extrabold ${item.projectedSpendableBalance < 0 ? 'text-danger' : ''}`}
                    >
                      {formatRsd(item.projectedSpendableBalance)}
                    </p>
                    <p className="text-[0.68rem] text-muted">na kraju meseca</p>
                  </div>
                  <ChevronDown
                    size={18}
                    className={`text-muted transition ${isExpanded ? 'rotate-180' : ''}`}
                  />
                </div>
                {isExpanded ? (
                  <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-surface-2 p-3 text-xs sm:grid-cols-4">
                    {[
                      ['Prihod', item.plannedIncome],
                      ['Fiksno', item.fixedCommitments],
                      ['Promenljivo', item.variableBudgets],
                      ['Događaji', item.plannedEvents],
                      ['Štednja', item.savingsContributions],
                      ['Dugovi', item.debtRepayments],
                      ['Zaštićeno stanje', item.projectedProtectedBalance],
                      ['Ukupan keš', item.projectedTotalCash],
                    ].map(([label, value]) => (
                      <div key={String(label)}>
                        <p className="text-muted">{label}</p>
                        <p className="money mt-1 font-bold">{formatRsd(Number(value))}</p>
                      </div>
                    ))}
                    {shortfallTotal > 0 ? (
                      <p className="col-span-2 rounded-lg bg-warning-soft p-2 text-warning sm:col-span-4">
                        Projektovani manjak ciljeva do roka: {formatRsd(shortfallTotal)}. Plan nije
                        automatski povećan.
                      </p>
                    ) : null}
                    {item.eventFunding.map((funding) => {
                      const account = snapshot.accounts.find(
                        (value) => value.id === funding.accountId,
                      );
                      return (
                        <p
                          key={funding.eventId}
                          className={`col-span-2 rounded-lg p-2 sm:col-span-4 ${
                            funding.status === 'fully-funded'
                              ? 'bg-accent-soft text-accent'
                              : 'bg-warning-soft text-warning'
                          }`}
                        >
                          {funding.title} · {account?.name ?? funding.accountId}:{' '}
                          {funding.status === 'fully-funded'
                            ? `u potpunosti pokriveno (${formatRsd(funding.plannedAmount)})`
                            : `${funding.status === 'partially-funded' ? 'delimično pokriveno' : 'nije pokriveno'} · manjak izvora ${formatRsd(funding.fundingGap)}`}
                        </p>
                      );
                    })}
                  </div>
                ) : null}
              </button>
            );
          })}
        </Card>
      </section>
    </main>
  );
};
