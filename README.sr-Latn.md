# Mirna

[English](README.md) | Srpski

Mirna je local-first PWA za lične finansije: planira šta treba da se dogodi, beleži šta se
zaista dogodilo i pokazuje šta sledi.

[![CI](https://github.com/Gibo2706/mirna/actions/workflows/ci.yml/badge.svg)](https://github.com/Gibo2706/mirna/actions)
![Licenca: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-2f7d64?style=flat-square)
![Node 22](https://img.shields.io/badge/node-22-2f7d64?style=flat-square)
![Offline PWA](https://img.shields.io/badge/PWA-offline-2f7d64?style=flat-square)
![Local-first](https://img.shields.io/badge/data-local--first-2f7d64?style=flat-square)

[Javni demo](https://mirna-finansije.vercel.app) ·
[Izvorni kod](https://github.com/Gibo2706/mirna) ·
[Dokumentacija](#projektna-dokumentacija) ·
[Prijavite problem](https://github.com/Gibo2706/mirna/issues)

![Mirna početni ekran i prognoza sa sintetičkim finansijskim podacima u svedenoj grafitno-zelenoj kompoziciji.](docs/assets/readme/mirna-hero.png)

## Zašto Mirna

- **Plan i stvarna aktivnost ostaju odvojeni.** Budžet je namera; samo zapis u finansijskoj
  evidenciji menja stanje računa.
- **Prognoza pokazuje gde plan postaje tesan.** Projektuje poznate prihode, obaveze, budžete,
  ciljeve, dugove i jednokratne događaje bez izmišljanja finansijskih saveta.
- **Finansijski podaci ostaju local-first.** Uobičajen rad ne zahteva nalog, povezivanje sa
  bankom ili analitiku; opcioni sync šalje samo end-to-end šifrovan sadržaj.

## Pogledajte Mirnu u radu

![Tri stvarna Mirna ekrana sa mesečnim planom, trenutnim iznosom bezbednim za trošenje i determinističkom prognozom nad sintetičkim podacima.](docs/assets/readme/product-overview.png)

### Ciljevi su povezani sa stvarnim računima

Ciljevi štednje koriste namenske račune i transfere, pa se zaštićeni novac ne prikazuje kao
raspoloživ za trošenje.

<img src="docs/assets/readme/goals-light.png" width="390" alt="Mirna ekran ciljeva sa sintetičkom sigurnosnom rezervom i mesečnim doprinosom." />

### AI pomoć se završava na granici plana

Mirna lokalno priprema i pregleda strukturisane izmene plana. Ne povezuje se sa AI servisom i ne
dozvoljava da uvezeni planerski podaci naprave istoriju transakcija.

<img src="docs/assets/readme/ai-plan-bridge-light.png" width="390" alt="Mirna AI Plan Bridge ekran sa lokalnim Blueprint i Patch tokovima bez direktne AI veze." />

## Šta Mirna radi

- **Planira mesec:** redovne prihode, fiksne obaveze, promenljive budžete, dugove, doprinose
  štednji, planirane događaje i scenarije prihoda.
- **Beleži stvarno stanje:** proverljive prihode i troškove, transfere, prečice za unos, plaćanje
  događaja i poređenje plana sa stvarnom evidencijom.
- **Čuva novac za budućnost:** rezervne i namenske ciljeve povezane sa zaštićenim računima, uz
  deterministička pravila napretka i životnog ciklusa.
- **Gleda unapred:** dvanaestomesečnu prognozu koja ne menja istorijske transakcije i jasno
  pokazuje tesne mesece.
- **Prenosi podatke svesno:** validiran JSON backup schema v3, atomski oporavak, CSV izvoz i
  čitljive Markdown sažetke.
- **Radi offline:** instalabilnu PWA čije lokalne funkcije nastavljaju da rade posle prvog
  uspešnog učitavanja produkcione verzije.
- **Prenosi postojeći plan:** Blueprint v1 za novu instalaciju i dozvoljene Patch v1 izmene za
  postojeći plan.

## Local-first po dizajnu

Mirna čuva finansijske podatke u IndexedDB bazi trenutnog browser origin-a. Stabilna aplikacija
nema aplikacioni nalog, analitiku niti bankarsku integraciju. Izvoz nastaje samo kada ga korisnik
zatraži.

Mirna 2.4.1 sadrži opcionu, accountless, end-to-end šifrovanu sinhronizaciju. Browser šifruje
finansijske snapshot-e i operacije pre slanja. Servis može da čuva šifrat i operativne metapodatke,
ali ne dobija vault master ključ, recovery root, privatne ključeve uređaja niti čitljiv finansijski
sadržaj. Dok je uključena aplikacija aktivna, jedan globalni runtime sinhronizuje pri pokretanju,
lokalnoj promeni, povratku mreže i dovoljno dugom povratku u prvi plan. Mirna ne tvrdi da periodično
sinhronizuje nakon što operativni sistem ugasi PWA proces. Sync nije prošao nezavisan bezbednosni
pregled, zato čuvajte odvojen JSON backup i recovery kod. Pogledajte [sync arhitekturu](docs/SYNC-ARCHITECTURE.md),
[protokol](docs/SYNC-PROTOCOL.md), [oporavak](docs/SYNC-RECOVERY.md) i
[bezbednosni model](docs/SYNC-SECURITY-MODEL.md).

> **Čuvajte odvojen backup.** Promena profila, čišćenje skladišta, postupak operativnog sistema
> ili uklanjanje PWA mogu da obrišu podatke iz browser-a. JSON, CSV i Markdown izvozi su
> nešifrovani i treba ih čuvati u skladu sa tim.

Pre korišćenja osetljivih podataka pročitajte [PRIVACY.md](PRIVACY.md) i
[bezbednosni model](docs/SECURITY-MODEL.md).

## Finansijski model

| Pojam                 | Značenje u Mirni                                                 |
| --------------------- | ---------------------------------------------------------------- |
| **Plan**              | Očekivani prihodi, obaveze, budžeti, ciljevi, dugovi i događaji. |
| **Stvarno**           | Zapisi u finansijskoj evidenciji koji su zaista promenili račun. |
| **Preostalo**         | Neplaćeni ili nepotrošeni deo trenutnog plana.                   |
| **Transferi**         | Premeštanje između računa; nikada prihod ili trošak.             |
| **Zaštićena štednja** | Novac izuzet iz iznosa bezbednog za trošenje.                    |
| **Prognoza**          | Deterministička projekcija trenutnog stanja i sačuvanog plana.   |

Merodavna pravila su u
[docs/FINANCIAL-INVARIANTS.md](docs/FINANCIAL-INVARIANTS.md).

## AI Plan Bridge

Mirna nema direktan AI API niti SDK nekog provajdera. **Blueprint** opisuje celovit plan za novu
ili praznu instalaciju. **Patch** predlaže ograničen skup izmena postojećeg plana. Korisnik
kontroliše svaki korak kopiranja, lepljenja, pregleda i uvoza.

Nijedan format ne može neprimetno da izmeni postojeće stanje ili ubaci transakcije. Detalji su u
[docs/AI-PLAN-BRIDGE.md](docs/AI-PLAN-BRIDGE.md).

## Isprobajte

Otvorite [javni demo](https://mirna-finansije.vercel.app). Trenutni interfejs aplikacije je na
srpskom jeziku, latinicom. Demo može privremeno da zaostaje za repozitorijumom dok je izdanje u
pripremi.

Mirna je alat za planiranje, ne finansijski savet. Proveravajte plan i čuvajte backup iz kog se
podaci mogu vratiti.

## Razvoj

Mirna zahteva Node 22 i koristi sačuvani npm lockfile.

```bash
nvm use
npm ci
npm run dev
```

Glavni stack čine React 19, strogi TypeScript, Vite 8, Tailwind CSS 4,
Dexie/IndexedDB, Zod, Recharts, Workbox, Vitest i Playwright.

## Provera kvaliteta

```bash
npm run public:check
npm run public:history
npm run check
npm run test:coverage
npm run test:e2e
npm run sync:test:e2e
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
```

Vizuali za dokumentaciju ponovljivo nastaju iz zamrznutog sintetičkog fixture-a:

```bash
npm run docs:assets
```

## Projektna dokumentacija

- [Arhitektura](docs/ARCHITECTURE.md)
- [Finansijska pravila](docs/FINANCIAL-INVARIANTS.md)
- [Bezbednosni model](docs/SECURITY-MODEL.md)
- [AI Plan Bridge](docs/AI-PLAN-BRIDGE.md)
- [Arhitektura šifrovanog sync-a](docs/SYNC-ARCHITECTURE.md)
- [Protokol šifrovanog sync-a](docs/SYNC-PROTOCOL.md)
- [Performanse šifrovanog sync-a](docs/SYNC-PERFORMANCE.md)
- [Privatnost](PRIVACY.md)
- [Doprinosi](CONTRIBUTING.md)

## Doprinosi

Issue-i, predlozi funkcionalnosti, diskusije o dizajnu i sintetičke reprodukcije su dobrodošli.
Contributor sporazum još nije aktivan, pa se spoljne izmene koda i dokumentacije ne spajaju dok
se uslovi doprinosa ne utvrde. Pročitajte [CONTRIBUTING.md](CONTRIBUTING.md).

## Bezbednost

Ne objavljujte detalje ranjivosti niti stvarne finansijske podatke. Pratite
[SECURITY.md](SECURITY.md) i koristite
[GitHub Security](https://github.com/Gibo2706/mirna/security) kada privatno prijavljivanje
ranjivosti bude omogućeno.

## Licenca

Mirna je licencirana isključivo pod
[GNU Affero General Public License verzijom 3](LICENSE) (`AGPL-3.0-only`).
Komercijalna upotreba je dozvoljena uz poštovanje licence. Komponente trećih strana ostaju pod
sopstvenim uslovima; pogledajte [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Autorska atribucija je u [COPYRIGHT](COPYRIGHT). Licenca izvornog koda ne daje dozvolu da se
izmenjena verzija predstavlja kao zvanično Mirna izdanje; pogledajte
[TRADEMARKS.md](TRADEMARKS.md).

## Autor

Mirna je nezavisan open-source projekat koji je napravio i održava
[Bogdan Marković](https://github.com/Gibo2706) ([Gibo2706](https://github.com/Gibo2706)).
