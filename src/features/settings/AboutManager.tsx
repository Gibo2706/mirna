import { ExternalLink, LockKeyhole, Smartphone, WifiOff } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { SettingsLayout } from '@/components/SettingsLayout';
import { InfoRow } from '@/components/ui/InfoRow';
import { APPLICATION_VERSION } from '@/lib/version';

const externalLinkProps = {
  target: '_blank',
  rel: 'noreferrer noopener',
} as const;

export const AboutManager = () => (
  <SettingsLayout
    title="O aplikaciji"
    description="Mirna je lokalni, deterministički planer ličnih finansija."
  >
    <Card className="rounded-hero border-0 bg-[#17251f] p-6 text-white">
      <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#64b792]">
        Mirna {APPLICATION_VERSION}
      </p>
      <h2 className="mt-2 text-3xl font-extrabold tracking-tight">Vaš novac ostaje vaš.</h2>
      <p className="mt-3 max-w-xl text-sm leading-6 text-white/65">
        Bez naloga, backend-a, cloud sinhronizacije, analitike i spoljašnjih finansijskih API-ja.
      </p>
    </Card>
    <div className="mt-5 grid gap-3 sm:grid-cols-3">
      {[
        [LockKeyhole, 'Privatno', 'Finansije ostaju u IndexedDB bazi ovog uređaja.'],
        [WifiOff, 'Offline', 'Posle prvog učitavanja app shell radi bez interneta.'],
        [Smartphone, 'Installable', 'PWA optimizovana za moderan Android telefon.'],
      ].map(([Icon, title, detail]) => (
        <Card key={String(title)}>
          <Icon className="text-accent" />
          <h3 className="mt-4 font-bold">{String(title)}</h3>
          <p className="mt-1 text-sm leading-6 text-muted">{String(detail)}</p>
        </Card>
      ))}
    </div>
    <Card className="mt-5">
      <h2 className="font-bold">Važna odgovornost</h2>
      <p className="mt-2 text-sm leading-6 text-muted">
        Local-first znači da programer ili cloud servis nemaju kopiju vaših podataka. Redovno
        preuzimajte kompletan JSON backup, naročito pre promene telefona ili čišćenja browser
        podataka.
      </p>
    </Card>
    <Card className="mt-5">
      <h2 className="font-bold">Otvoren izvorni kod</h2>
      <p className="mt-2 text-sm leading-6 text-muted">
        Mirna je dostupna pod GNU Affero General Public License, isključivo verzijom 3
        (AGPL-3.0-only). Licenca uređuje korišćenje, izmene i dostupnost odgovarajućeg izvornog
        koda. Program se pruža bez garancije.
      </p>
      <dl className="mt-4 border-t pt-1">
        <InfoRow
          label="Izvorni kod"
          value={
            <a
              href="https://github.com/Gibo2706/mirna"
              {...externalLinkProps}
              className="inline-flex min-h-11 items-center justify-end gap-1.5 text-accent"
            >
              GitHub <ExternalLink size={14} aria-hidden="true" />
            </a>
          }
        />
        <InfoRow
          label="Autor"
          value={
            <a
              href="https://github.com/Gibo2706"
              {...externalLinkProps}
              className="inline-flex min-h-11 items-center justify-end text-accent"
            >
              Bogdan Marković
            </a>
          }
        />
      </dl>
    </Card>
  </SettingsLayout>
);
