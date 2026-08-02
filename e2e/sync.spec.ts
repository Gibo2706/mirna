import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  devices,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Response,
} from '@playwright/test';
import {
  createSyntheticFinanceFixtureData,
  defaultSyntheticFinanceFixtureInput,
} from '../src/tests/fixtures/syntheticFinanceFixture';

const ENABLED_APP_ORIGIN = 'http://localhost:4173';
const DISABLED_APP_ORIGIN = 'http://localhost:4174';
const SYNC_API_ORIGIN = 'http://localhost:8787';
const DATABASE_NAME = 'mirna-finance';
const SYNC_VAULT_RECORD_ID = 'active-sync-vault';
const PLAINTEXT_SENTINEL = 'MIRNA_E2E_PLAINTEXT_SENTINEL_7F4B6A';
const PHONE_DEVICE_NAME = 'Sintetički telefon';
const DESKTOP_DEVICE_NAME = 'Sintetički računar';
const RECOVERED_DEVICE_NAME = 'Sintetički oporavljeni uređaj';

const repositoryRoot = resolve(import.meta.dirname, '..');
const workerState = resolve(repositoryRoot, '.wrangler/sync-e2e-state');
const workerD1State = resolve(workerState, 'v3/d1/miniflare-D1DatabaseObject');

interface LocalSyncSecurityView {
  readonly vaultId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly manifestVersion: number;
  readonly manifestDeviceCount: number;
  readonly keyEpoch: number;
  readonly signingPrivateKeyExtractable: boolean;
  readonly agreementPrivateKeyExtractable: boolean;
  readonly localWrappingKeyExtractable: boolean;
  readonly encryptedVaultKey: string;
  readonly lastSnapshotRevision: number;
  readonly lastSnapshotId: string | null;
  readonly firstUploadConsent: string;
  readonly syncBlockReason?: string;
  readonly pendingLocalOperationCount: number;
  readonly pendingConflictCount: number;
}

type D1Row = Readonly<Record<string, unknown>>;

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const localD1Path = (): string => {
  const candidates = readdirSync(workerD1State).filter(
    (name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite',
  );
  if (candidates.length !== 1 || !candidates[0]) {
    throw new Error('Expected exactly one isolated Miniflare D1 database.');
  }
  return resolve(workerD1State, candidates[0]);
};

const localD1 = (command: string): readonly D1Row[] => {
  const database = new DatabaseSync(localD1Path());
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const rows: unknown = database.prepare(command).all();
    if (!Array.isArray(rows)) throw new Error('Local D1 result is invalid.');
    return rows.filter(
      (row): row is D1Row => typeof row === 'object' && row !== null && !Array.isArray(row),
    );
  } catch {
    throw new Error('Lokalna D1 provera nije uspela; redovi nisu ispisani.');
  } finally {
    database.close();
  }
};

const requestBodies: string[] = [];
const unexpectedSyncResponses: string[] = [];

const captureSyncRequestBodies = (context: BrowserContext): void => {
  context.on('request', (request) => {
    if (!request.url().startsWith(`${SYNC_API_ORIGIN}/`)) return;
    const body = request.postData();
    if (body !== null) requestBodies.push(body);
  });
  context.on('response', (response) => {
    if (!response.url().startsWith(`${SYNC_API_ORIGIN}/`) || response.status() < 400) return;
    const request = response.request();
    unexpectedSyncResponses.push(
      `${request.method()} ${new URL(response.url()).pathname} ${response.status()}`,
    );
  });
};

const dismissOfflineReady = async (page: Page): Promise<void> => {
  const button = page.getByRole('button', { name: 'U redu' });
  if (await button.isVisible().catch(() => false)) await button.click();
};

const seedSyntheticPlan = async (page: Page): Promise<void> => {
  await page.goto(`${ENABLED_APP_ORIGIN}/`);
  await expect(page.getByRole('heading', { name: /Planiraj\. Beleži/ })).toBeVisible();
  await page.getByRole('button', { name: 'Nastavi' }).click();
  await page.getByRole('button', { name: /Razumem/ }).click();
  await page.getByRole('button', { name: /Uvezi backup/ }).click();

  const data = createSyntheticFinanceFixtureData(defaultSyntheticFinanceFixtureInput(new Date()));
  data.accounts[0] = { ...data.accounts[0], name: PLAINTEXT_SENTINEL };
  const backup = JSON.stringify({
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    application: { name: 'Mirna', version: '2.4.0-beta.1', currency: 'RSD' },
    data,
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'synthetic-sync-e2e.json',
    mimeType: 'application/json',
    buffer: Buffer.from(backup),
  });
  await expect(page.getByRole('heading', { name: 'Backup je validan' })).toBeVisible();
  await page.getByRole('button', { name: 'Vrati backup' }).click();
  await expect(page.getByLabel('Glavna navigacija')).toBeVisible();
  await dismissOfflineReady(page);
};

const readRecoveryCode = async (page: Page): Promise<string> => {
  const code = (await page.getByTestId('sync-recovery-code').textContent())?.trim() ?? '';
  expect(code.startsWith('MR1-'), 'Recovery prezentacija mora imati v1 prefiks.').toBe(true);
  return code;
};

const confirmRecoveryGroups = async (page: Page, recoveryCode: string): Promise<void> => {
  const groups = recoveryCode.slice('MR1-'.length).split('-');
  const fields = page.locator('[data-testid^="sync-recovery-confirmation-"]');
  const fieldCount = await fields.count();
  expect(fieldCount, 'UI mora nasumično tražiti barem jednu recovery grupu.').toBeGreaterThan(0);
  for (let index = 0; index < fieldCount; index += 1) {
    const field = fields.nth(index);
    const testId = await field.getAttribute('data-testid');
    const groupNumber = Number(testId?.slice('sync-recovery-confirmation-'.length));
    expect(
      Number.isSafeInteger(groupNumber) && groupNumber >= 1 && groupNumber <= groups.length,
    ).toBe(true);
    await field.fill(groups[groupNumber - 1]);
  }
};

const assertNoPageOverflow = async (page: Page, label: string): Promise<void> => {
  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(
    layout.documentWidth <= layout.viewportWidth + 1,
    `${label} ne sme da pravi horizontalni overflow na ${layout.viewportWidth}px.`,
  ).toBe(true);
};

const assertSyncWidths = async (
  page: Page,
  label: string,
  visibleTestId?: string,
): Promise<void> => {
  for (const width of [320, 360, 390, 412, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await assertNoPageOverflow(page, `${label} (${width}px)`);
    if (visibleTestId) {
      const element = page.getByTestId(visibleTestId);
      await expect(element).toBeVisible();
      const dimensions = await element.evaluate((node) => ({
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
      }));
      expect(
        dimensions.scrollWidth <= dimensions.clientWidth + 1,
        `${label} mora bezbedno da prelomi sadržaj na ${width}px.`,
      ).toBe(true);
    }
  }
};

const readLocalSyncSecurityView = async (page: Page): Promise<LocalSyncSecurityView> =>
  page.evaluate(
    ({ databaseName, vaultRecordId }) =>
      new Promise<LocalSyncSecurityView>((resolvePromise, reject) => {
        const open = indexedDB.open(databaseName);
        open.onerror = () => reject(new Error('Lokalna baza nije otvorena.'));
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction([
            'syncVault',
            'syncDevice',
            'syncKeys',
            'syncMetadata',
            'syncOutbox',
            'syncConflicts',
          ]);
          const vaultRequest = transaction.objectStore('syncVault').get(vaultRecordId);
          const deviceRequest = transaction.objectStore('syncDevice').get('local-sync-device');
          const keysRequest = transaction.objectStore('syncKeys').getAll();
          const metadataRequest = transaction.objectStore('syncMetadata').get('sync-metadata');
          const outboxRequest = transaction.objectStore('syncOutbox').count();
          const conflictsRequest = transaction.objectStore('syncConflicts').getAll();
          transaction.onerror = () => reject(new Error('Lokalni sync zapisi nisu pročitani.'));
          transaction.oncomplete = () => {
            database.close();
            const vault = vaultRequest.result as {
              vaultId: string;
              keyEpoch: number;
              manifest: { manifestVersion: number; devices: unknown[] };
            };
            const device = deviceRequest.result as {
              deviceId: string;
              displayName: string;
              signingPrivateKey: CryptoKey;
              agreementPrivateKey: CryptoKey;
              localWrappingKey: CryptoKey;
            };
            const key = (
              keysRequest.result as Array<{ encryptedKey: unknown; vaultId: string }>
            ).find((candidate) => candidate.vaultId === vault.vaultId);
            const metadata = metadataRequest.result as {
              lastSnapshotRevision: number;
              lastSnapshotId: string | null;
              firstUploadConsent: string;
              syncBlockReason?: string;
            };
            if (!vault || !device || !key || !metadata) {
              reject(new Error('Lokalni sync setup nije potpun.'));
              return;
            }
            resolvePromise({
              vaultId: vault.vaultId,
              deviceId: device.deviceId,
              displayName: device.displayName,
              manifestVersion: vault.manifest.manifestVersion,
              manifestDeviceCount: vault.manifest.devices.length,
              keyEpoch: vault.keyEpoch,
              signingPrivateKeyExtractable: device.signingPrivateKey.extractable,
              agreementPrivateKeyExtractable: device.agreementPrivateKey.extractable,
              localWrappingKeyExtractable: device.localWrappingKey.extractable,
              encryptedVaultKey: JSON.stringify(key.encryptedKey),
              lastSnapshotRevision: metadata.lastSnapshotRevision,
              lastSnapshotId: metadata.lastSnapshotId,
              firstUploadConsent: metadata.firstUploadConsent,
              syncBlockReason: metadata.syncBlockReason,
              pendingLocalOperationCount: outboxRequest.result,
              pendingConflictCount: (
                conflictsRequest.result as Array<{ resolutionState?: string }>
              ).filter((conflict) => conflict.resolutionState === 'pending').length,
            });
          };
        };
      }),
    { databaseName: DATABASE_NAME, vaultRecordId: SYNC_VAULT_RECORD_ID },
  );

const hasAccountName = async (page: Page, name: string): Promise<boolean> =>
  page.evaluate(
    ({ databaseName, expectedName }) =>
      new Promise<boolean>((resolvePromise, reject) => {
        const open = indexedDB.open(databaseName);
        open.onerror = () => reject(new Error('Lokalna baza nije otvorena.'));
        open.onsuccess = () => {
          const database = open.result;
          const request = database.transaction('accounts').objectStore('accounts').getAll();
          request.onerror = () => reject(new Error('Računi nisu pročitani.'));
          request.onsuccess = () => {
            database.close();
            resolvePromise(
              (request.result as Array<{ name?: string }>).some(
                (account) => account.name === expectedName,
              ),
            );
          };
        };
      }),
    { databaseName: DATABASE_NAME, expectedName: name },
  );

interface LocalFinanceMergeView {
  readonly transactions: readonly { readonly description: string; readonly notes?: string }[];
  readonly budgets: readonly { readonly name: string; readonly defaultAmount: number }[];
}

const readLocalFinanceMergeView = (page: Page): Promise<LocalFinanceMergeView> =>
  page.evaluate(
    (databaseName) =>
      new Promise<LocalFinanceMergeView>((resolvePromise, reject) => {
        const open = indexedDB.open(databaseName);
        open.onerror = () => reject(new Error('Lokalna baza nije otvorena.'));
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction(['transactions', 'variableBudgets']);
          const transactions = transaction.objectStore('transactions').getAll();
          const budgets = transaction.objectStore('variableBudgets').getAll();
          transaction.onerror = () => reject(new Error('Finansijski zapisi nisu pročitani.'));
          transaction.oncomplete = () => {
            database.close();
            resolvePromise({
              transactions: transactions.result as LocalFinanceMergeView['transactions'],
              budgets: budgets.result as LocalFinanceMergeView['budgets'],
            });
          };
        };
      }),
    DATABASE_NAME,
  );

const addPresetExpense = async (
  page: Page,
  presetName: string,
  formattedAmount: string,
): Promise<void> => {
  if (new URL(page.url()).pathname !== '/') await page.goto(`${ENABLED_APP_ORIGIN}/`);
  await dismissOfflineReady(page);
  await page.getByRole('button', { name: 'Dodaj transakciju' }).click();
  await page
    .getByRole('button', { name: new RegExp(`${presetName}.*${formattedAmount}`, 'i') })
    .click();
  await page.getByRole('button', { name: new RegExp(`Sačuvaj ${formattedAmount}`, 'i') }).click();
  const confirmation = page.getByRole('button', { name: 'Potvrdi i sačuvaj' });
  if (await confirmation.isVisible().catch(() => false)) await confirmation.click();
  await expect(page.getByText('Transakcija je sačuvana.')).toBeVisible();
};

const editTransactionNote = async (
  page: Page,
  description: string,
  note: string,
): Promise<void> => {
  if (new URL(page.url()).pathname !== '/more/transactions') {
    await page.goto(`${ENABLED_APP_ORIGIN}/more/transactions`);
  }
  await page.getByRole('button', { name: `Detalji ${description}` }).click();
  await page.getByLabel('Beleška').fill(note);
  await page.getByRole('button', { name: 'Sačuvaj izmene' }).click();
  await expect(page.getByText('Transakcija je izmenjena.')).toBeVisible();
};

const editBudgetAmount = async (page: Page, name: string, amount: string): Promise<void> => {
  if (new URL(page.url()).pathname !== '/more/budgets') {
    await page.goto(`${ENABLED_APP_ORIGIN}/more/budgets`);
  }
  await page.getByRole('button', { name: `Izmeni ${name}` }).click();
  await page.getByLabel('Podrazumevani mesečni iznos').fill(amount);
  await page.getByRole('button', { name: 'Sačuvaj budžet' }).click();
  await expect(page.getByText('Budžet je sačuvan.')).toBeVisible();
};

const synchronizeSuccessfully = async (page: Page): Promise<void> => {
  await page.goto(`${ENABLED_APP_ORIGIN}/more/sync`);
  const button = page.getByRole('button', { name: 'Sinhronizuj sada' });
  await expect(button).toBeVisible();
  const localState = await readLocalSyncSecurityView(page);
  await expect(
    button,
    `Ručni sync mora biti dozvoljen; lokalni blok: ${localState.syncBlockReason ?? 'nema'}.`,
  ).toBeEnabled();
  const syncResponses: Response[] = [];
  const captureResponse = (response: Response): void => {
    if (response.url().startsWith(`${SYNC_API_ORIGIN}/`)) syncResponses.push(response);
  };
  page.on('response', captureResponse);
  await button.click();
  await expect(button).toBeDisabled();
  await expect(button).toBeEnabled();
  page.off('response', captureResponse);
  const failures = await Promise.all(
    syncResponses
      .filter((response) => response.status() >= 400)
      .map(async (response) => {
        const body = (await response.json().catch((): undefined => undefined)) as
          { error?: { code?: string } } | undefined;
        return {
          method: response.request().method(),
          path: new URL(response.url()).pathname,
          status: response.status(),
          code: body?.error?.code,
        };
      }),
  );
  expect(
    failures.filter(
      (failure) =>
        !(
          failure.method === 'PUT' &&
          failure.path.startsWith('/v1/snapshots/') &&
          failure.status === 409 &&
          failure.code === 'SNAPSHOT_ACK_PENDING'
        ),
    ),
  ).toEqual([]);
  expect(await readLocalSyncSecurityView(page)).toMatchObject({
    pendingLocalOperationCount: 0,
    pendingConflictCount: 0,
    syncBlockReason: undefined,
  });
};

const synchronizeUntilConflict = async (page: Page): Promise<void> => {
  await page.goto(`${ENABLED_APP_ORIGIN}/more/sync`);
  const button = page.getByRole('button', { name: 'Sinhronizuj sada' });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByText(/Konfliktna radnja/).first()).toBeVisible();
  await expect(button).toBeEnabled();
  expect((await readLocalSyncSecurityView(page)).syncBlockReason).toBeUndefined();
};

const expectSyncRejected = async (page: Page): Promise<void> => {
  await page.goto(`${ENABLED_APP_ORIGIN}/more/sync`);
  const rejected = page.waitForResponse(
    (response) => response.url().startsWith(`${SYNC_API_ORIGIN}/`) && response.status() >= 400,
  );
  const button = page.getByRole('button', { name: 'Sinhronizuj sada' });
  await button.click();
  expect((await rejected).status()).toBeGreaterThanOrEqual(400);
  await expect(page.getByRole('alert').last()).toContainText(
    'Ovlašćenje ovog uređaja je isteklo ili je opozvano.',
  );
  await expect(button).toBeEnabled();
};

const alterChecksum = (code: string): string =>
  `${code.slice(0, -1)}${code.endsWith('0') ? '1' : '0'}`;

const startPairingRequest = async (page: Page, deviceName: string): Promise<string> => {
  await page.goto(`${ENABLED_APP_ORIGIN}/more/sync`);
  await expect(page.getByRole('heading', { name: 'Šifrovana sinhronizacija' })).toBeVisible();
  await page.getByRole('button', { name: 'Poveži ovaj uređaj' }).click();
  await page.getByLabel('Naziv ovog uređaja').fill(deviceName);
  await page.getByRole('button', { name: 'Napravi zahtev za povezivanje' }).click();
  const pairingCode = (await page.getByTestId('sync-pairing-code').textContent())?.trim() ?? '';
  expect(pairingCode.startsWith('MIRNA-P1-'), 'Ručni pairing kod mora biti protokol v1.').toBe(
    true,
  );
  await expect(page.getByTestId('sync-pairing-qr')).toBeVisible();
  const qrSource = await page.getByTestId('sync-pairing-qr').getAttribute('src');
  expect(qrSource?.startsWith('data:image/png'), 'QR mora nastati lokalno kao data URL.').toBe(
    true,
  );
  return pairingCode;
};

const inspectPairingOnExistingDevice = async (page: Page, pairingCode: string): Promise<string> => {
  await page.getByLabel('QR sadržaj ili ručni kod').fill(pairingCode);
  await page.getByRole('button', { name: 'Proveri zahtev lokalno i na serveru' }).click();
  await expect(page.getByTestId('sync-existing-device-sas')).toBeVisible();
  return (await page.getByTestId('sync-existing-device-sas').textContent())?.trim() ?? '';
};

const waitForNewDeviceSas = async (page: Page): Promise<string> => {
  const poll = page.getByRole('button', { name: 'Proveri odgovor' });
  if (await poll.isVisible().catch(() => false)) await poll.click();
  await expect(page.getByTestId('sync-new-device-sas')).toBeVisible();
  return (await page.getByTestId('sync-new-device-sas').textContent())?.trim() ?? '';
};

const enableAndPairTwoDevices = async (
  phone: Page,
  desktop: Page,
): Promise<{
  readonly recoveryCode: string;
  readonly phone: LocalSyncSecurityView;
  readonly desktop: LocalSyncSecurityView;
}> => {
  const pairingCode = await startPairingRequest(desktop, DESKTOP_DEVICE_NAME);
  await assertSyncWidths(desktop, 'QR i ručni pairing kod', 'sync-pairing-code');
  await seedSyntheticPlan(phone);
  await phone.goto(`${ENABLED_APP_ORIGIN}/more/sync`);
  await phone.getByRole('button', { name: 'Uključi na prvom uređaju' }).click();
  await phone.getByRole('button', { name: 'Proveri ovaj uređaj' }).click();
  await expect(phone.getByText('Pregledač je prošao lokalnu proveru.')).toBeVisible();
  await phone.getByLabel('Naziv ovog uređaja').fill(PHONE_DEVICE_NAME);
  await phone.getByRole('button', { name: 'Napravi recovery kod' }).click();
  const recoveryCode = await readRecoveryCode(phone);
  await assertSyncWidths(phone, 'Recovery kod i eksplicitne akcije', 'sync-recovery-code');
  await expect(phone.getByRole('button', { name: 'Kopiraj recovery kod' })).toBeVisible();
  await confirmRecoveryGroups(phone, recoveryCode);
  await phone.getByRole('button', { name: 'Potvrdi sačuvani kod' }).click();
  await phone.getByRole('button', { name: 'Aktiviraj šifrovanu sinhronizaciju' }).click();
  await phone
    .getByRole('button', { name: /Saglasan sam — pošalji prvi šifrovani snapshot/i })
    .click();
  await expect
    .poll(async () => (await readLocalSyncSecurityView(phone)).lastSnapshotRevision)
    .toBe(1);

  const existingSas = await inspectPairingOnExistingDevice(phone, pairingCode);
  await phone.getByRole('button', { name: 'Poklapa se — odobri' }).click();
  expect(await waitForNewDeviceSas(desktop)).toBe(existingSas);
  await desktop.getByRole('button', { name: 'Poklapaju se — poveži' }).click();
  await expect(desktop.getByRole('heading', { name: 'Ovaj uređaj je povezan' })).toBeVisible();
  await synchronizeSuccessfully(desktop);
  await expect.poll(() => hasAccountName(desktop, PLAINTEXT_SENTINEL)).toBe(true);

  return {
    recoveryCode,
    phone: await readLocalSyncSecurityView(phone),
    desktop: await readLocalSyncSecurityView(desktop),
  };
};

const expectPrivateMaterialAbsent = (
  haystack: string,
  forbiddenValues: readonly string[],
): void => {
  for (const forbidden of forbiddenValues) {
    expect(
      haystack.includes(forbidden),
      'Server saobraćaj i D1 ne smeju sadržati recovery/VMK/finance plaintext.',
    ).toBe(false);
  }
};

test.beforeEach(() => {
  requestBodies.length = 0;
  unexpectedSyncResponses.length = 0;
});

test('Turnstile activation UI fits 320-430 px and rerenders at the supported breakpoint', async ({
  browser,
}) => {
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 320, height: 800 },
    serviceWorkers: 'block',
    timezoneId: 'Europe/Belgrade',
  });
  await context.route('https://challenges.cloudflare.com/turnstile/v0/api.js**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `(() => {
        const widgets = new Map();
        let sequence = 0;
        window.turnstile = {
          render(container, options) {
            const id = 'fake-turnstile-' + (++sequence);
            const widget = document.createElement('div');
            widget.dataset.fakeTurnstile = id;
            widget.style.width = options.size === 'flexible' ? '100%' : '150px';
            widget.style.height = options.size === 'flexible' ? '65px' : '140px';
            widget.textContent = 'Test Turnstile ' + options.size;
            container.append(widget);
            widgets.set(id, widget);
            window.__mirnaTestTurnstileSize = options.size;
            return id;
          },
          execute() {},
          remove(id) {
            widgets.get(id)?.remove();
            widgets.delete(id);
          }
        };
      })();`,
    }),
  );
  const page = await context.newPage();
  await seedSyntheticPlan(page);
  await page.goto(`${ENABLED_APP_ORIGIN}/more/sync`);
  await page.getByRole('button', { name: 'Uključi na prvom uređaju' }).click();
  await page.getByRole('button', { name: 'Proveri ovaj uređaj' }).click();
  await expect(page.getByText('Pregledač je prošao lokalnu proveru.')).toBeVisible();
  await page.getByRole('button', { name: 'Napravi recovery kod' }).click();
  const recoveryCode = await readRecoveryCode(page);
  await confirmRecoveryGroups(page, recoveryCode);
  await page.getByRole('button', { name: 'Potvrdi sačuvani kod' }).click();
  await page.getByRole('button', { name: 'Aktiviraj šifrovanu sinhronizaciju' }).click();
  const mount = page.getByTestId('sync-turnstile-widget');
  await expect(mount.locator('[data-fake-turnstile]')).toBeVisible();

  for (const width of [320, 360, 390, 412, 430]) {
    await page.setViewportSize({ width, height: 800 });
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { __mirnaTestTurnstileSize?: string }).__mirnaTestTurnstileSize,
        ),
      )
      .toBe(width <= 360 ? 'compact' : 'flexible');
    await assertNoPageOverflow(page, `Turnstile aktivacija (${width}px)`);
    const bounds = await mount.evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      childWidth: node.firstElementChild?.getBoundingClientRect().width ?? 0,
    }));
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
    expect(bounds.childWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
  }

  expect(await readRecoveryCode(page)).toBe(recoveryCode);
  await context.close();
});

test('activation preserves the prepared setup and creates one vault after an accounting retry', async ({
  browser,
}) => {
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 360, height: 800 },
    serviceWorkers: 'block',
    timezoneId: 'Europe/Belgrade',
  });
  captureSyncRequestBodies(context);

  const failedRequestId = '386f51bc-bdc3-4da9-a952-5cc878f1a340';
  let vaultCreateAttempts = 0;
  await context.route(`${SYNC_API_ORIGIN}/v1/vaults`, async (route) => {
    vaultCreateAttempts += 1;
    if (vaultCreateAttempts > 1) {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 503,
      contentType: 'application/json; charset=utf-8',
      headers: {
        'Access-Control-Allow-Origin': ENABLED_APP_ORIGIN,
        'Access-Control-Expose-Headers': 'X-Mirna-Protocol-Version, X-Request-Id',
        'Cache-Control': 'no-store',
        'X-Mirna-Protocol-Version': '1',
        'X-Request-Id': failedRequestId,
      },
      body: JSON.stringify({
        protocolVersion: 1,
        error: {
          code: 'USAGE_ACCOUNTING_UNAVAILABLE',
          message: 'Accounting is unavailable.',
          requestId: failedRequestId,
          accounting: {
            category: 'USAGE_ACCOUNTING_UNAVAILABLE',
            reason: 'USAGE_RESERVATION_UNDERESTIMATED',
            phase: 'route-reservation',
            route: 'vault-create',
            businessCommitted: false,
            serviceFlagsChanged: false,
            workerBuild: 'abcdef1',
          },
        },
      }),
    });
  });

  const page = await context.newPage();
  await seedSyntheticPlan(page);
  await page.goto(`${ENABLED_APP_ORIGIN}/more/sync`);
  await page.getByRole('button', { name: 'Uključi na prvom uređaju' }).click();
  await page.getByRole('button', { name: 'Proveri ovaj uređaj' }).click();
  await expect(page.getByText('Pregledač je prošao lokalnu proveru.')).toBeVisible();
  await page.getByLabel('Naziv ovog uređaja').fill('Accounting retry telefon');
  await page.getByRole('button', { name: 'Napravi recovery kod' }).click();
  const recoveryCode = await readRecoveryCode(page);
  await confirmRecoveryGroups(page, recoveryCode);
  await page.getByRole('button', { name: 'Potvrdi sačuvani kod' }).click();
  await page.getByRole('button', { name: 'Aktiviraj šifrovanu sinhronizaciju' }).click();

  const accountingError = page.getByTestId('sync-activation-accounting-error');
  await expect(accountingError).toContainText('USAGE_RESERVATION_UNDERESTIMATED');
  await expect(accountingError).toContainText('route-reservation');
  await expect(accountingError).toContainText('vault-create');
  await expect(accountingError).toContainText(failedRequestId);
  await expect(page.getByTestId('sync-recovery-code')).toHaveText(recoveryCode);
  expect(Number(localD1('SELECT COUNT(*) AS count FROM vaults')[0]?.count)).toBe(0);

  await page.getByRole('button', { name: 'Pokušaj aktivaciju ponovo' }).click();
  await expect(page.getByRole('heading', { name: 'Ovaj uređaj je povezan' })).toBeVisible();
  expect(vaultCreateAttempts).toBe(2);
  expect(Number(localD1('SELECT COUNT(*) AS count FROM vaults')[0]?.count)).toBe(1);
  expect((await readLocalSyncSecurityView(page)).displayName).toBe('Accounting retry telefon');

  await context.close();
});

test('Phase 1-2: two isolated devices sync ciphertext, pair, reject unsafe paths, and recover', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const desktopContext = await browser.newContext({
    ...devices['Desktop Chrome'],
    serviceWorkers: 'allow',
    timezoneId: 'Europe/Belgrade',
  });
  const phoneContext = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 360, height: 800 },
    serviceWorkers: 'allow',
    timezoneId: 'Europe/Belgrade',
  });
  captureSyncRequestBodies(desktopContext);
  captureSyncRequestBodies(phoneContext);
  const desktop = await desktopContext.newPage();
  const phone = await phoneContext.newPage();

  const pairingCode = await startPairingRequest(desktop, DESKTOP_DEVICE_NAME);
  await expect(desktop.getByTestId('sync-pairing-code')).toBeVisible();

  await seedSyntheticPlan(phone);
  await phone.goto(`${ENABLED_APP_ORIGIN}/more/sync`);
  await phone.getByRole('button', { name: 'Uključi na prvom uređaju' }).click();
  await phone.getByRole('button', { name: 'Proveri ovaj uređaj' }).click();
  await expect(phone.getByText('Pregledač je prošao lokalnu proveru.')).toBeVisible();
  await phone.getByLabel('Naziv ovog uređaja').fill(PHONE_DEVICE_NAME);
  await phone.getByRole('button', { name: 'Napravi recovery kod' }).click();
  const firstRecoveryCode = await readRecoveryCode(phone);
  await assertNoPageOverflow(phone, 'Prikaz recovery koda');
  await confirmRecoveryGroups(phone, firstRecoveryCode);
  await phone.getByRole('button', { name: 'Potvrdi sačuvani kod' }).click();
  const activateSync = phone.getByRole('button', {
    name: 'Aktiviraj šifrovanu sinhronizaciju',
  });
  await expect(activateSync).toBeVisible();
  await activateSync.click();
  await expect(phone.getByRole('heading', { name: 'Ovaj uređaj je povezan' })).toBeVisible();
  await phone
    .getByRole('button', { name: /Saglasan sam — pošalji prvi šifrovani snapshot/i })
    .click();
  await expect
    .poll(async () => (await readLocalSyncSecurityView(phone)).lastSnapshotRevision)
    .toBe(1);
  expect(
    unexpectedSyncResponses.filter((entry) => entry !== 'GET /v1/snapshots/current 404'),
  ).toEqual([]);

  const phoneLocal = await readLocalSyncSecurityView(phone);
  expect(phoneLocal.displayName).toBe(PHONE_DEVICE_NAME);
  expect(phoneLocal.signingPrivateKeyExtractable).toBe(false);
  expect(phoneLocal.agreementPrivateKeyExtractable).toBe(false);
  expect(phoneLocal.localWrappingKeyExtractable).toBe(false);
  expect(phoneLocal.encryptedVaultKey.includes('vaultMasterKey')).toBe(false);
  expect(phoneLocal.lastSnapshotRevision).toBe(1);
  expect(phoneLocal.lastSnapshotId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  expect(phoneLocal.firstUploadConsent).toBe('accepted');

  await phone.getByLabel('QR sadržaj ili ručni kod').fill(alterChecksum(pairingCode));
  await phone.getByRole('button', { name: 'Proveri zahtev lokalno i na serveru' }).click();
  await expect(phone.getByRole('alert').last()).toBeVisible();

  const existingSas = await inspectPairingOnExistingDevice(phone, pairingCode);
  expect(existingSas).toMatch(/^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/u);
  await phone.getByRole('button', { name: 'Poklapa se — odobri' }).click();
  const newDeviceSas = await waitForNewDeviceSas(desktop);
  expect(newDeviceSas).toBe(existingSas);
  await desktop.getByRole('button', { name: 'Poklapaju se — poveži' }).click();
  await expect(desktop.getByRole('heading', { name: 'Ovaj uređaj je povezan' })).toBeVisible();
  await desktop.getByRole('button', { name: 'Sinhronizuj sada' }).click();
  await expect
    .poll(async () => (await readLocalSyncSecurityView(desktop)).lastSnapshotRevision)
    .toBe(1);
  await expect.poll(() => hasAccountName(desktop, PLAINTEXT_SENTINEL)).toBe(true);

  const desktopLocal = await readLocalSyncSecurityView(desktop);
  expect(desktopLocal.vaultId).toBe(phoneLocal.vaultId);
  expect(desktopLocal.displayName).toBe(DESKTOP_DEVICE_NAME);
  expect(desktopLocal.manifestVersion).toBe(2);
  expect(desktopLocal.manifestDeviceCount).toBe(2);
  expect(desktopLocal.signingPrivateKeyExtractable).toBe(false);
  expect(desktopLocal.agreementPrivateKeyExtractable).toBe(false);
  expect(desktopLocal.localWrappingKeyExtractable).toBe(false);
  const desktopAfterDownload = await readLocalSyncSecurityView(desktop);
  expect(desktopAfterDownload.lastSnapshotRevision).toBe(1);
  expect(desktopAfterDownload.lastSnapshotId).toBe(phoneLocal.lastSnapshotId);

  await phone.getByLabel('QR sadržaj ili ručni kod').fill(pairingCode);
  await phone.getByRole('button', { name: 'Proveri zahtev lokalno i na serveru' }).click();
  await expect(phone.getByRole('alert').last()).toBeVisible();

  const mismatchContext = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 360, height: 800 },
    serviceWorkers: 'allow',
    timezoneId: 'Europe/Belgrade',
  });
  captureSyncRequestBodies(mismatchContext);
  const mismatchDevice = await mismatchContext.newPage();
  const mismatchCode = await startPairingRequest(mismatchDevice, 'Sintetički SAS mismatch');
  await assertNoPageOverflow(mismatchDevice, 'Prikaz pairing koda');
  const mismatchExistingSas = await inspectPairingOnExistingDevice(desktop, mismatchCode);
  await desktop.getByRole('button', { name: 'Poklapa se — odobri' }).click();
  const mismatchNewSas = await waitForNewDeviceSas(mismatchDevice);
  expect(mismatchNewSas).toBe(mismatchExistingSas);
  await mismatchDevice.getByRole('button', { name: 'Ne poklapaju se — otkaži' }).click();
  await expect(
    mismatchDevice.getByRole('button', { name: 'Napravi zahtev za povezivanje' }),
  ).toBeVisible();
  const cancelledPairings = localD1(
    `SELECT COUNT(*) AS count FROM pairing_requests WHERE vault_id = ${sqlLiteral(phoneLocal.vaultId)} AND status = 'cancelled'`,
  );
  expect(Number(cancelledPairings[0]?.count)).toBeGreaterThanOrEqual(1);

  const expiringContext = await browser.newContext({
    ...devices['Desktop Chrome'],
    serviceWorkers: 'allow',
    timezoneId: 'Europe/Belgrade',
  });
  captureSyncRequestBodies(expiringContext);
  const expiringDevice = await expiringContext.newPage();
  const expiringCode = await startPairingRequest(expiringDevice, 'Sintetički istekli uređaj');
  const newestPending = localD1(
    "SELECT pairing_request_id FROM pairing_requests WHERE status = 'pending' ORDER BY rowid DESC LIMIT 1",
  );
  const expiringRequestIdValue = newestPending[0]?.pairing_request_id;
  if (typeof expiringRequestIdValue !== 'string') {
    throw new Error('Lokalni pairing red nema očekivani nečitljivi ID.');
  }
  const expiringRequestId = expiringRequestIdValue;
  expect(expiringRequestId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  localD1(
    `UPDATE pairing_requests SET expires_at = created_at + 1 WHERE pairing_request_id = ${sqlLiteral(expiringRequestId)} AND status = 'pending'`,
  );
  await expiringDevice.waitForTimeout(1_100);
  await desktop.getByLabel('QR sadržaj ili ručni kod').fill(expiringCode);
  await desktop.getByRole('button', { name: 'Proveri zahtev lokalno i na serveru' }).click();
  await expect(desktop.getByRole('alert').last()).toBeVisible();

  const pairedDeviceCounts = localD1(
    `SELECT status, COUNT(*) AS count FROM devices WHERE vault_id = ${sqlLiteral(phoneLocal.vaultId)} GROUP BY status ORDER BY status`,
  );
  expect(
    Number(pairedDeviceCounts.find((row) => row.status === 'active')?.count),
    'Tačno dva uređaja moraju biti aktivna pre recovery-ja.',
  ).toBe(2);
  const committedSnapshots = localD1(
    `SELECT COUNT(*) AS count FROM snapshots WHERE vault_id = ${sqlLiteral(phoneLocal.vaultId)} AND state = 'committed'`,
  );
  expect(Number(committedSnapshots[0]?.count)).toBe(1);

  await Promise.all([
    phoneContext.close(),
    desktopContext.close(),
    mismatchContext.close(),
    expiringContext.close(),
  ]);

  const recoveryContext = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 360, height: 800 },
    serviceWorkers: 'allow',
    timezoneId: 'Europe/Belgrade',
  });
  captureSyncRequestBodies(recoveryContext);
  const recoveryPage = await recoveryContext.newPage();
  await recoveryPage.goto(`${ENABLED_APP_ORIGIN}/more/sync`);
  await recoveryPage.getByRole('button', { name: 'Izgubljeni su svi uređaji' }).click();
  await recoveryPage.getByLabel('Naziv ovog uređaja').fill(RECOVERED_DEVICE_NAME);
  await recoveryPage.getByLabel('Postojeći recovery kod').fill(firstRecoveryCode);
  await recoveryPage.getByRole('button', { name: 'Proveri kod i pripremi oporavak' }).click();
  const rotatedRecoveryCode = await readRecoveryCode(recoveryPage);
  expect(rotatedRecoveryCode).not.toBe(firstRecoveryCode);
  await assertNoPageOverflow(recoveryPage, 'Prikaz rotiranog recovery koda');
  await confirmRecoveryGroups(recoveryPage, rotatedRecoveryCode);
  await recoveryPage.getByRole('button', { name: 'Potvrdi novi kod i završi oporavak' }).click();
  await expect(recoveryPage.getByRole('heading', { name: 'Ovaj uređaj je povezan' })).toBeVisible();

  const recoveredLocal = await readLocalSyncSecurityView(recoveryPage);
  expect(recoveredLocal.vaultId).toBe(phoneLocal.vaultId);
  expect(recoveredLocal.displayName).toBe(RECOVERED_DEVICE_NAME);
  expect(recoveredLocal.manifestVersion).toBe(3);
  expect(recoveredLocal.manifestDeviceCount).toBe(1);
  expect(recoveredLocal.signingPrivateKeyExtractable).toBe(false);
  expect(recoveredLocal.agreementPrivateKeyExtractable).toBe(false);
  expect(recoveredLocal.localWrappingKeyExtractable).toBe(false);

  const recoveredDeviceCounts = localD1(
    `SELECT status, COUNT(*) AS count FROM devices WHERE vault_id = ${sqlLiteral(phoneLocal.vaultId)} GROUP BY status ORDER BY status`,
  );
  expect(Number(recoveredDeviceCounts.find((row) => row.status === 'active')?.count)).toBe(1);
  expect(Number(recoveredDeviceCounts.find((row) => row.status === 'revoked')?.count)).toBe(2);

  const storedCiphertextRows = localD1(`
    SELECT 'manifest' AS source, canonical_manifest AS payload
      FROM vault_manifests WHERE vault_id = ${sqlLiteral(phoneLocal.vaultId)}
    UNION ALL
    SELECT 'recovery', canonical_recovery_envelope
      FROM recovery_records WHERE vault_id = ${sqlLiteral(phoneLocal.vaultId)}
    UNION ALL
    SELECT 'pairing-envelope', canonical_envelope
      FROM pairing_envelopes WHERE vault_id = ${sqlLiteral(phoneLocal.vaultId)}
    UNION ALL
    SELECT 'pairing-manifest', candidate_manifest
      FROM pairing_envelopes WHERE vault_id = ${sqlLiteral(phoneLocal.vaultId)}
    UNION ALL
    SELECT 'snapshot-envelope', canonical_envelope
      FROM snapshots WHERE vault_id = ${sqlLiteral(phoneLocal.vaultId)}
  `);
  const serverText = `${requestBodies.join('\n')}\n${JSON.stringify(storedCiphertextRows)}`;
  expectPrivateMaterialAbsent(serverText, [
    PLAINTEXT_SENTINEL,
    PHONE_DEVICE_NAME,
    DESKTOP_DEVICE_NAME,
    RECOVERED_DEVICE_NAME,
    firstRecoveryCode,
    firstRecoveryCode.replaceAll('-', ''),
    rotatedRecoveryCode,
    rotatedRecoveryCode.replaceAll('-', ''),
    '"vaultMasterKey"',
    '"recoveryRoot"',
    '"recoverySigningPrivateKeyPkcs8"',
  ]);

  const reusedContext = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 360, height: 800 },
    serviceWorkers: 'allow',
    timezoneId: 'Europe/Belgrade',
  });
  captureSyncRequestBodies(reusedContext);
  const reusedPage = await reusedContext.newPage();
  await reusedPage.goto(`${ENABLED_APP_ORIGIN}/more/sync`);
  await reusedPage.getByRole('button', { name: 'Izgubljeni su svi uređaji' }).click();
  await reusedPage.getByLabel('Naziv ovog uređaja').fill('Sintetički reused recovery');
  await reusedPage.getByLabel('Postojeći recovery kod').fill(firstRecoveryCode);
  await reusedPage.getByRole('button', { name: 'Proveri kod i pripremi oporavak' }).click();
  await expect(reusedPage.getByRole('alert').last()).toBeVisible();

  requestBodies.length = 0;
  await Promise.all([recoveryContext.close(), reusedContext.close()]);
});

test('Phase 3: two devices merge operations, resolve conflicts, renew, rotate, revoke and delete cloud state', async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  const performanceTimingsMs: Record<string, number> = {};
  const phoneContext = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'allow',
    timezoneId: 'Europe/Belgrade',
  });
  const desktopContext = await browser.newContext({
    ...devices['Desktop Chrome'],
    serviceWorkers: 'allow',
    timezoneId: 'Europe/Belgrade',
  });
  captureSyncRequestBodies(phoneContext);
  captureSyncRequestBodies(desktopContext);
  const phone = await phoneContext.newPage();
  const desktop = await desktopContext.newPage();
  let performanceStartedAt = performance.now();
  const initial = await enableAndPairTwoDevices(phone, desktop);
  performanceTimingsMs.initialUploadAndPairing = Math.round(
    performance.now() - performanceStartedAt,
  );
  expect(initial.phone.keyEpoch).toBe(1);
  expect(initial.desktop.keyEpoch).toBe(1);

  await phone.goto(`${ENABLED_APP_ORIGIN}/`);
  await phoneContext.setOffline(true);
  await addPresetExpense(phone, 'Kafa', '360 RSD');
  await expect
    .poll(async () => (await readLocalSyncSecurityView(phone)).pendingLocalOperationCount)
    .toBe(1);
  await phoneContext.setOffline(false);
  performanceStartedAt = performance.now();
  await synchronizeSuccessfully(phone);
  performanceTimingsMs.incrementalOperationUpload = Math.round(
    performance.now() - performanceStartedAt,
  );
  await synchronizeSuccessfully(desktop);
  await expect
    .poll(async () =>
      (await readLocalFinanceMergeView(desktop)).transactions.some(
        (transaction) => transaction.description === 'Kafa',
      ),
    )
    .toBe(true);

  await desktop.goto(`${ENABLED_APP_ORIGIN}/more/budgets`);
  await phone.goto(`${ENABLED_APP_ORIGIN}/`);
  await Promise.all([desktopContext.setOffline(true), phoneContext.setOffline(true)]);
  await editBudgetAmount(desktop, 'Hrana', '32123');
  await addPresetExpense(phone, 'Apoteka', '1.350 RSD');
  await expect
    .poll(async () => ({
      desktop: (await readLocalSyncSecurityView(desktop)).pendingLocalOperationCount,
      phone: (await readLocalSyncSecurityView(phone)).pendingLocalOperationCount,
    }))
    .toEqual({ desktop: 1, phone: 1 });
  performanceStartedAt = performance.now();
  await phoneContext.setOffline(false);
  await synchronizeSuccessfully(phone);
  await desktopContext.setOffline(false);
  await synchronizeSuccessfully(desktop);
  await synchronizeSuccessfully(phone);
  performanceTimingsMs.independentMerge = Math.round(performance.now() - performanceStartedAt);

  for (const page of [phone, desktop]) {
    const merged = await readLocalFinanceMergeView(page);
    expect(merged.transactions.some((transaction) => transaction.description === 'Apoteka')).toBe(
      true,
    );
    expect(merged.budgets.find((budget) => budget.name === 'Hrana')?.defaultAmount).toBe(32_123);
  }

  await Promise.all([
    phone.goto(`${ENABLED_APP_ORIGIN}/more/transactions`),
    desktop.goto(`${ENABLED_APP_ORIGIN}/more/transactions`),
  ]);
  await Promise.all([phoneContext.setOffline(true), desktopContext.setOffline(true)]);
  await editTransactionNote(phone, 'Kafa', 'Telefon bira ovu vrednost');
  await editTransactionNote(desktop, 'Kafa', 'Računar bira drugu vrednost');
  await expect
    .poll(async () => ({
      desktop: (await readLocalSyncSecurityView(desktop)).pendingLocalOperationCount,
      phone: (await readLocalSyncSecurityView(phone)).pendingLocalOperationCount,
    }))
    .toEqual({ desktop: 1, phone: 1 });
  performanceStartedAt = performance.now();
  await phoneContext.setOffline(false);
  const deferredCompactions = unexpectedSyncResponses.filter(
    (entry) => entry.startsWith('PUT /v1/snapshots/') && entry.endsWith(' 409'),
  ).length;
  await synchronizeSuccessfully(phone);
  expect(
    unexpectedSyncResponses.filter(
      (entry) => entry.startsWith('PUT /v1/snapshots/') && entry.endsWith(' 409'),
    ),
  ).toHaveLength(deferredCompactions + 1);
  await desktopContext.setOffline(false);
  await synchronizeUntilConflict(desktop);
  await assertSyncWidths(desktop, 'Ekran za eksplicitnu rezoluciju konflikta');
  await desktop.getByRole('button', { name: 'Prihvati predlog drugog uređaja' }).click();
  await desktop.getByRole('button', { name: 'Potvrdi rezoluciju' }).click();
  await expect(desktop.getByText(/Konfliktna radnja/)).toHaveCount(0);
  await synchronizeSuccessfully(desktop);
  await synchronizeSuccessfully(phone);
  performanceTimingsMs.conflictDetectionResolutionAndMerge = Math.round(
    performance.now() - performanceStartedAt,
  );

  for (const page of [phone, desktop]) {
    const resolved = await readLocalFinanceMergeView(page);
    expect(
      resolved.transactions.find((transaction) => transaction.description === 'Kafa')?.notes,
    ).toBe('Telefon bira ovu vrednost');
  }

  localD1(
    `UPDATE device_grants SET issued_at = 0, expires_at = 1 WHERE vault_id = ${sqlLiteral(initial.phone.vaultId)} AND device_id = ${sqlLiteral(initial.desktop.deviceId)} AND revoked_at IS NULL`,
  );
  const expiredGrant = localD1(
    `SELECT expires_at FROM device_grants WHERE vault_id = ${sqlLiteral(initial.phone.vaultId)} AND device_id = ${sqlLiteral(initial.desktop.deviceId)} AND revoked_at IS NULL`,
  );
  expect(expiredGrant).toEqual([{ expires_at: 1 }]);
  await expectSyncRejected(desktop);

  await phone.goto(`${ENABLED_APP_ORIGIN}/more/sync`);
  const desktopLabel = `${initial.desktop.deviceId.slice(0, 8)}…${initial.desktop.deviceId.slice(-4)}`;
  const desktopDeviceRow = phone.locator('li').filter({ hasText: desktopLabel });
  await desktopDeviceRow.getByRole('button', { name: 'Obnovi 30 dana' }).click();
  const renewed = phone.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/renew') && response.request().method() === 'POST',
  );
  await phone.getByRole('button', { name: 'Obnovi ovlašćenje' }).click();
  expect((await renewed).status()).toBe(201);
  await expect.poll(async () => (await readLocalSyncSecurityView(phone)).manifestVersion).toBe(3);
  await synchronizeSuccessfully(desktop);
  expect((await readLocalSyncSecurityView(desktop)).manifestVersion).toBe(3);

  await phone.goto(`${ENABLED_APP_ORIGIN}/more/sync`);
  const revisionBeforeRevocation = (await readLocalSyncSecurityView(phone)).lastSnapshotRevision;
  performanceStartedAt = performance.now();
  await phone
    .locator('li')
    .filter({ hasText: desktopLabel })
    .getByRole('button', { name: 'Bezbedno opozovi' })
    .click();
  await assertSyncWidths(phone, 'Potvrda bezbednog opoziva uređaja');
  await phone.getByLabel('Recovery kod').fill(initial.recoveryCode);
  await phone.getByLabel('Za potvrdu unesite: OPOZOVI UREĐAJ').fill('OPOZOVI UREĐAJ');
  const revoked = phone.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/revoke') &&
      response.request().method() === 'POST',
  );
  await phone.getByRole('button', { name: 'Opozovi i rotiraj ključ' }).click();
  expect((await revoked).status()).toBe(201);
  await expect
    .poll(async () => {
      const view = await readLocalSyncSecurityView(phone);
      return {
        keyEpoch: view.keyEpoch,
        revisionAdvanced: view.lastSnapshotRevision > revisionBeforeRevocation,
      };
    })
    .toEqual({ keyEpoch: 2, revisionAdvanced: true });
  performanceTimingsMs.revokeRotateAndSnapshot = Math.round(
    performance.now() - performanceStartedAt,
  );

  const epochEnvelopes = localD1(
    `SELECT recipient_device_id FROM device_key_envelopes WHERE vault_id = ${sqlLiteral(initial.phone.vaultId)} AND key_epoch = 2 ORDER BY recipient_device_id`,
  );
  expect(epochEnvelopes).toEqual([{ recipient_device_id: initial.phone.deviceId }]);
  await expectSyncRejected(desktop);
  expect((await readLocalSyncSecurityView(desktop)).keyEpoch).toBe(1);

  await phone.goto(`${ENABLED_APP_ORIGIN}/more/sync`);
  performanceStartedAt = performance.now();
  await phone.getByRole('button', { name: 'Pripremi cloud brisanje' }).click();
  await assertSyncWidths(phone, 'Potvrda trajnog cloud brisanja');
  await phone.getByLabel('Recovery kod za cloud brisanje').fill(initial.recoveryCode);
  await phone
    .getByLabel('Za potvrdu unesite: OBRIŠI ŠIFROVANI CLOUD TREZOR')
    .fill('OBRIŠI ŠIFROVANI CLOUD TREZOR');
  const deleted = phone.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/vault' && response.request().method() === 'DELETE',
  );
  await phone.getByRole('button', { name: 'Trajno obriši cloud trezor' }).click();
  expect((await deleted).status()).toBe(200);
  await expect(phone.getByRole('button', { name: 'Uključi na prvom uređaju' })).toBeVisible();
  expect(await hasAccountName(phone, PLAINTEXT_SENTINEL)).toBe(true);
  expect(
    (await readLocalFinanceMergeView(phone)).transactions.some(
      (transaction) => transaction.description === 'Kafa',
    ),
  ).toBe(true);
  expect(
    localD1(
      `SELECT COUNT(*) AS count FROM vaults WHERE vault_id = ${sqlLiteral(initial.phone.vaultId)}`,
    ),
  ).toEqual([{ count: 0 }]);
  expect(
    localD1(
      `SELECT state FROM deletion_requests WHERE vault_id = ${sqlLiteral(initial.phone.vaultId)}`,
    ),
  ).toEqual([{ state: 'completed' }]);
  performanceTimingsMs.cloudDeletion = Math.round(performance.now() - performanceStartedAt);
  console.info(JSON.stringify({ syncBrowserPerformance: performanceTimingsMs }));
  await testInfo.attach('sync-performance-timings.json', {
    body: JSON.stringify(performanceTimingsMs, null, 2),
    contentType: 'application/json',
  });

  await Promise.all([phoneContext.close(), desktopContext.close()]);
});

test('disabled build exposes no sync entry point and makes no sync request', async ({
  browser,
}) => {
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 360, height: 800 },
    serviceWorkers: 'allow',
    timezoneId: 'Europe/Belgrade',
  });
  const syncRequests: string[] = [];
  context.on('request', (request) => {
    if (request.url().startsWith(`${SYNC_API_ORIGIN}/`)) syncRequests.push(request.method());
  });
  const page = await context.newPage();
  await page.goto(`${DISABLED_APP_ORIGIN}/more/sync`);
  await expect(page.getByRole('heading', { name: /Planiraj\. Beleži/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Poveži ovaj uređaj' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Izgubljeni su svi uređaji' })).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(syncRequests).toEqual([]);
  await assertNoPageOverflow(page, 'Feature-disabled onboarding');
  await context.close();
});
