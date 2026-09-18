import { formatRsd } from '@/lib/format';
import type { ProtectedSpendingImpact } from './protectedSpending';

export const ProtectedSpendingPreview = ({ impacts }: { impacts: ProtectedSpendingImpact[] }) => (
  <div aria-live="polite" className="grid gap-3">
    {impacts.map((impact) => (
      <section key={impact.accountId} className="border-l border-warning pl-3 text-sm">
        <p className="font-semibold">
          Koristiš novac iz štednje „{impact.goalName ?? impact.accountName}”.
        </p>
        {impact.goalName && impact.goalName !== impact.accountName ? (
          <p className="text-xs text-muted">Račun: {impact.accountName}</p>
        ) : null}
        <dl className="mt-2 grid grid-cols-2 gap-2">
          <div>
            <dt className="text-xs text-muted">Sačuvano</dt>
            <dd className="money font-semibold">{formatRsd(impact.before)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Posle ove transakcije</dt>
            <dd className={`money font-semibold ${impact.after < 0 ? 'text-danger' : ''}`}>
              {formatRsd(impact.after)}
            </dd>
          </div>
        </dl>
        {impact.targetAmount !== undefined ? (
          <p className="mt-2 text-xs text-muted">Cilj ostaje {formatRsd(impact.targetAmount)}.</p>
        ) : null}
        {impact.after < 0 ? (
          <p className="mt-2 text-danger">Nema dovoljno novca u ovoj štednji.</p>
        ) : null}
      </section>
    ))}
  </div>
);
