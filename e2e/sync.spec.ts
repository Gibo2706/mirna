import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { devices, expect, test, type BrowserContext, type Page } from '@playwright/test';
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
const wranglerEntrypoint = resolve(repositoryRoot, 'node_modules/wrangler/bin/wrangler.js');
const workerConfig = resolve(repositoryRoot, 'services/sync-worker/wrangler.jsonc');
const workerState = resolve(repositoryRoot, '.wrangler/sync-e2e-state');

interface LocalSyncSecurityView {
  readonly vaultId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly manifestVersion: number;
  readonly manifestDeviceCount: number;
  readonly signingPrivateKeyExtractable: boolean;
  readonly agreementPrivateKeyExtractable: boolean;
  readonly localWrappingKeyExtractable: boolean;
  readonly encryptedVaultKey: string;
  readonly lastSnapshotRevision: number;
  readonly lastSnapshotId: string | null;
  readonly firstUploadConsent: string;
}

type D1Row = Readonly<Record<string, unknown>>;

const isD1Envelope = (value: unknown): value is { readonly results: readonly unknown[] } =>
  typeof value === 'object' && value !== null && 'results' in value && Array.isArray(value.results);

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const localD1 = (command: string): readonly D1Row[] => {
  try {
    const execution = spawnSync(
      process.execPath,
      [
        wranglerEntrypoint,
        'd1',
        'execute',
        'mirna-sync-local',
        '--local',
        '--persist-to',
        workerState,
        '--config',
        workerConfig,
        '--command',
        command,
        '--json',
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          CI: 'true',
          WRANGLER_LOG_PATH: resolve(repositoryRoot, '.wrangler/sync-e2e-query.log'),
        },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (execution.error || execution.status !== 0 || typeof execution.stdout !== 'string') {
      throw new Error('Wrangler D1 command failed.');
    }
    const parsed: unknown = JSON.parse(execution.stdout);
    const envelopes: unknown[] = [];
    if (Array.isArray(parsed)) {
      for (const envelope of parsed) envelopes.push(envelope);
    } else {
      envelopes.push(parsed);
    }
    return envelopes.flatMap((envelope): D1Row[] => {
      if (!isD1Envelope(envelope)) return [];
      return envelope.results.filter(
        (row): row is D1Row => typeof row === 'object' && row !== null && !Array.isArray(row),
      );
    });
  } catch {
    throw new Error('Lokalna D1 provera nije uspela; redovi nisu ispisani.');
  }
};

const requestBodies: string[] = [];

const captureSyncRequestBodies = (context: BrowserContext): void => {
  context.on('request', (request) => {
    if (!request.url().startsWith(`${SYNC_API_ORIGIN}/`)) return;
    const body = request.postData();
    if (body !== null) requestBodies.push(body);
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
    `${label} ne sme da pravi horizontalni overflow na 360px.`,
  ).toBe(true);
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
          ]);
          const vaultRequest = transaction.objectStore('syncVault').get(vaultRecordId);
          const deviceRequest = transaction.objectStore('syncDevice').get('local-sync-device');
          const keysRequest = transaction.objectStore('syncKeys').getAll();
          const metadataRequest = transaction.objectStore('syncMetadata').get('sync-metadata');
          transaction.onerror = () => reject(new Error('Lokalni sync zapisi nisu pročitani.'));
          transaction.oncomplete = () => {
            database.close();
            const vault = vaultRequest.result as {
              vaultId: string;
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
              signingPrivateKeyExtractable: device.signingPrivateKey.extractable,
              agreementPrivateKeyExtractable: device.agreementPrivateKey.extractable,
              localWrappingKeyExtractable: device.localWrappingKey.extractable,
              encryptedVaultKey: JSON.stringify(key.encryptedKey),
              lastSnapshotRevision: metadata.lastSnapshotRevision,
              lastSnapshotId: metadata.lastSnapshotId,
              firstUploadConsent: metadata.firstUploadConsent,
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
  await expect(phone.getByText('Šifrovani snapshot je uspešno poslat.')).toBeVisible();

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
