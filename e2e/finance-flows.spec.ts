import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  createSyntheticFinanceFixtureData,
  defaultSyntheticFinanceFixtureInput,
} from '../src/tests/fixtures/syntheticFinanceFixture';

const APPLICATION_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

test.beforeEach(async ({ page }, testInfo) => {
  const initialTime = testInfo.title.includes('midnight rollover')
    ? '2032-07-31T23:59:00+02:00'
    : '2032-07-28T12:00:00+02:00';
  await page.clock.install({ time: new Date(initialTime) });
});

const resetDatabase = async (page: Page) => {
  await page.goto('/');
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase('mirna-finance');
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('IndexedDB reset nije uspeo.'));
        request.onblocked = () => resolve();
      }),
  );
  await page.reload();
};

const dismissOfflineReady = async (page: Page) => {
  const button = page.getByRole('button', { name: 'U redu' });
  if (await button.isVisible().catch(() => false)) await button.click();
};

const navigate = async (page: Page, name: string) => {
  await page.getByLabel('Glavna navigacija').getByRole('link', { name, exact: true }).click();
};

const financeStoreNames = [
  'accounts',
  'transactions',
  'categories',
  'plannedIncomes',
  'commitments',
  'variableBudgets',
  'goals',
  'debts',
  'debtPayments',
  'plannedEvents',
  'presets',
  'salaryScenarios',
  'settings',
] as const;

const readDatabaseJson = async (
  page: Page,
  stores: readonly string[] = financeStoreNames,
): Promise<string> =>
  page.evaluate(
    (storeNames) =>
      new Promise<string>((resolve, reject) => {
        const request = indexedDB.open('mirna-finance');
        request.onerror = () => reject(request.error ?? new Error('Baza nije otvorena.'));
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction(storeNames, 'readonly');
          const state: Record<string, unknown[]> = {};
          for (const storeName of storeNames) {
            const readRequest = transaction.objectStore(storeName).getAll();
            readRequest.onsuccess = () => {
              const result = readRequest.result as unknown[];
              state[storeName] = result.sort((left, right) => {
                const leftId =
                  typeof left === 'object' && left && 'id' in left ? String(left.id) : '';
                const rightId =
                  typeof right === 'object' && right && 'id' in right ? String(right.id) : '';
                return leftId.localeCompare(rightId);
              });
            };
          }
          transaction.oncomplete = () => {
            database.close();
            resolve(JSON.stringify(state));
          };
          transaction.onerror = () =>
            reject(transaction.error ?? new Error('Čitanje baze nije uspelo.'));
        };
      }),
    [...stores],
  );

const finishProductTour = async (page: Page) => {
  for (let index = 0; index < 5; index += 1) {
    await page.getByRole('button', { name: 'Dalje' }).click();
  }
  await page.getByRole('button', { name: /Završi/ }).click();
};

const seedPlan = async (page: Page) => {
  await resetDatabase(page);
  await expect(page.getByRole('heading', { name: /Planiraj\. Beleži/ })).toBeVisible();
  await page.getByRole('button', { name: 'Nastavi' }).click();
  await page.getByRole('button', { name: /Razumem/ }).click();
  await page.getByRole('button', { name: /Uvezi backup/ }).click();
  const data = createSyntheticFinanceFixtureData(
    defaultSyntheticFinanceFixtureInput(new Date('2032-07-28T10:00:00.000Z')),
  );
  const backup = JSON.stringify({
    schemaVersion: 3,
    exportedAt: '2032-07-28T10:00:00.000Z',
    application: { name: 'Mirna', version: '2.2.1', currency: 'RSD' },
    data,
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'synthetic-finance-fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(backup),
  });
  await expect(page.getByRole('heading', { name: 'Backup je validan' })).toBeVisible();
  await page.getByRole('button', { name: 'Vrati backup' }).click();
  await expect(page.getByRole('heading', { name: /jul 2032/i })).toBeVisible();
  await dismissOfflineReady(page);
};

const receiveFirstPlannedIncome = async (page: Page, receivedDate = '2032-07-28') => {
  await navigate(page, 'Mesec');
  await page.getByRole('button', { name: 'Primljeno', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Primljen prihod — Plata/ })).toBeVisible();
  await page.getByLabel('Datum prijema').fill(receivedDate);
  await page.getByRole('button', { name: 'Potvrdi prijem' }).click();
  await expect(page.getByText('Prihod je evidentiran kao primljen.')).toBeVisible();
};

test('cold start paints the local shell before the application bundle is ready', async ({
  page,
}) => {
  let delayed = false;
  await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
    if (!delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await route.continue();
  });

  const navigation = page.goto('/');
  await expect(page.getByLabel('Mirna se pokreće')).toBeVisible({ timeout: 5_000 });
  await navigation;
  await expect(page.getByRole('heading', { name: /Planiraj\. Beleži/ })).toBeVisible();
});

test('a clean new user gets a structurally minimal generic onboarding plan', async ({ page }) => {
  await resetDatabase(page);
  await expect(page.getByRole('heading', { name: /Planiraj\. Beleži/ })).toBeVisible();

  await page.getByRole('button', { name: 'Nastavi' }).click();
  await expect(
    page.getByRole('heading', { name: 'Vaši finansijski podaci ostaju na ovom uređaju.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Razumem/ }).click();
  await page.getByRole('button', { name: /Kreni od osnova/ }).click();
  await page.getByLabel('Trenutno stanje (RSD)').fill('55000');
  await page.getByLabel('Mesečna plata / prihod (opciono)').fill('100000');
  await page.getByLabel('Očekivani dan (opciono)').fill('5');
  await page.getByRole('button', { name: 'Nastavi' }).click();
  await page.getByRole('button', { name: 'Preskoči' }).click();
  await page.getByRole('button', { name: 'Preskoči' }).click();
  await expect(page.getByRole('heading', { name: 'Upoznajte Mirnu' })).toBeVisible();
  await finishProductTour(page);
  await page.getByRole('button', { name: 'Idi na početnu' }).click();
  await expect(page.getByRole('heading', { name: /jul 2032/i })).toBeVisible();
  await expect(page.getByText('Još nemaš cilj štednje.')).toBeVisible();

  const databaseJson = await readDatabaseJson(page);
  expect(databaseJson).toContain('"name":"Tekući račun"');
  expect(databaseJson).toContain('"name":"Drugo"');
  expect(databaseJson).toContain('"transactions":[]');
  expect(databaseJson).toContain('"debts":[]');
  expect(databaseJson).toContain('"commitments":[]');
  expect(databaseJson).toContain('"plannedEvents":[]');
  expect(databaseJson).toContain('"goals":[]');
});

const completeIncomeAndGoalOnboarding = async (
  page: Page,
  options: {
    incomeTiming: 'currentMonth' | 'nextMonth';
    goalType: 'sinking' | 'reserve';
  },
) => {
  await resetDatabase(page);
  await page.getByRole('button', { name: 'Nastavi' }).click();
  await page.getByRole('button', { name: /Razumem/ }).click();
  await page.getByRole('button', { name: /Kreni od osnova/ }).click();
  await page.getByLabel('Trenutno stanje (RSD)').fill('91000');
  await page.getByLabel('Mesečna plata / prihod (opciono)').fill('154000');
  await page.getByLabel('Očekivani dan (opciono)').fill('11');
  await page
    .getByRole('radio', {
      name:
        options.incomeTiming === 'currentMonth'
          ? /Tek treba da stigne ovog meseca/
          : /Već je uključena u trenutno stanje/,
    })
    .check();
  await page.getByRole('button', { name: 'Nastavi' }).click();
  await page.getByRole('button', { name: 'Preskoči' }).click();
  await page.getByRole('checkbox', { name: 'Dodaj prvi cilj' }).check();
  await page
    .getByRole('radio', {
      name:
        options.goalType === 'sinking'
          ? /Štedim za konkretnu stvar/
          : /Pravim rezervu za nepredviđeno/,
    })
    .check();
  await page
    .getByLabel('Naziv cilja')
    .fill(options.goalType === 'sinking' ? 'Sintetička oprema' : 'Sintetička rezerva');
  await page.getByLabel('Ciljni iznos (RSD)').fill('275000');
  await page.getByRole('button', { name: 'Nastavi na vodič' }).click();
  await expect(page.getByRole('heading', { name: 'Upoznajte Mirnu' })).toBeVisible();
};

test('onboarding starts income this month and maps a concrete goal to sinking', async ({
  page,
}) => {
  await completeIncomeAndGoalOnboarding(page, {
    incomeTiming: 'currentMonth',
    goalType: 'sinking',
  });
  const state = JSON.parse(
    await readDatabaseJson(page, ['accounts', 'transactions', 'plannedIncomes', 'goals']),
  ) as Record<string, Array<Record<string, unknown>>>;
  expect(state.plannedIncomes[0].startDate).toBe('2032-07-01');
  expect(state.goals[0].goalType).toBe('sinking');
  expect(state.accounts.find((value) => value.protected)).toMatchObject({ openingBalance: 0 });
  expect(state.transactions).toEqual([]);
});

test('onboarding starts already-in-balance income next month and creates a reserve', async ({
  page,
}) => {
  await completeIncomeAndGoalOnboarding(page, {
    incomeTiming: 'nextMonth',
    goalType: 'reserve',
  });
  const state = JSON.parse(
    await readDatabaseJson(page, ['accounts', 'transactions', 'plannedIncomes', 'goals']),
  ) as Record<string, Array<Record<string, unknown>>>;
  expect(state.plannedIncomes[0].startDate).toBe('2032-08-01');
  expect(state.goals[0].goalType).toBe('reserve');
  expect(
    state.accounts.find((account) => account.id === state.plannedIncomes[0].accountId),
  ).toMatchObject({ openingBalance: 91_000, protected: false });
  expect(state.transactions).toEqual([]);
});

test('a populated V2.2.1 user bypasses onboarding with every financial store preserved', async ({
  page,
}) => {
  await seedPlan(page);
  const before = await readDatabaseJson(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: /jul 2032/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Planiraj\. Beleži/ })).toHaveCount(0);
  expect(await readDatabaseJson(page)).toBe(before);
});

test('revisiting the product tour is explanatory and leaves all local data unchanged', async ({
  page,
}) => {
  await seedPlan(page);
  const before = await readDatabaseJson(page);
  await page.goto('/more/help');
  await page.getByRole('button', { name: 'Ponovi vodič' }).click();
  await finishProductTour(page);
  await expect(page.getByRole('heading', { name: 'Pomoć i vodič' })).toBeVisible();
  expect(await readDatabaseJson(page)).toBe(before);
});

test('Blueprint preview imports a complete plan locally without inventing history', async ({
  page,
}) => {
  await resetDatabase(page);
  await page.getByRole('button', { name: 'Nastavi' }).click();
  await page.getByRole('button', { name: /Razumem/ }).click();
  await page.getByRole('button', { name: /Već imam finansijski plan/ }).click();
  await expect(page.getByText('Mirna Plan Blueprint v1')).toBeVisible();
  await page.getByRole('button', { name: 'Imam JSON' }).click();
  const blueprint = {
    planBlueprintVersion: 1,
    currency: 'RSD',
    accounts: [
      {
        key: 'checking',
        name: 'Glavni račun',
        kind: 'checking',
        startingBalance: null,
        protected: false,
      },
      {
        key: 'reserve',
        name: 'Rezerva',
        kind: 'savings',
        startingBalance: 5_000,
        protected: true,
      },
    ],
    categories: [
      { key: 'salary', name: 'Plata', kind: 'income', icon: '💼' },
      { key: 'food', name: 'Hrana', kind: 'expense', icon: '🥗' },
    ],
    plannedIncomes: [
      {
        key: 'salary',
        name: 'Plata',
        amount: 100_000,
        categoryKey: 'salary',
        accountKey: 'checking',
        frequency: 'monthly',
        startDate: '2032-07-01',
        expectedDay: 5,
        active: true,
        isPrimarySalary: true,
      },
    ],
    fixedCommitments: [
      {
        key: 'internet',
        name: 'Internet',
        amount: 3_000,
        categoryKey: 'food',
        accountKey: 'checking',
        frequency: 'monthly',
        startDate: '2032-07-01',
        dueDay: 10,
        active: true,
      },
    ],
    variableBudgets: [
      {
        key: 'food',
        name: 'Hrana',
        defaultAmount: 18_000,
        categoryKey: 'food',
        overrides: {},
        active: true,
      },
    ],
    goals: [
      {
        key: 'reserve',
        name: 'Rezerva',
        emoji: '🛟',
        targetAmount: 100_000,
        linkedAccountKey: 'reserve',
        plannedMonthlyContribution: 5_000,
        contributionOverrides: {},
        goalType: 'reserve',
      },
    ],
    debts: [],
    plannedEvents: [
      {
        key: 'annual',
        title: 'Godišnji trošak',
        date: '2032-12-15',
        plannedAmount: 12_000,
        categoryKey: 'food',
        accountKey: 'checking',
      },
    ],
    salaryScenarios: [],
    quickAddPresets: [
      {
        key: 'other',
        name: 'Drugo',
        emoji: '•••',
        type: 'expense',
        categoryKey: 'food',
        defaultAccountKey: 'checking',
        position: 0,
        active: true,
      },
    ],
  };
  await page.getByLabel('Mirna Plan Blueprint v1').fill(JSON.stringify(blueprint));
  await page.getByRole('button', { name: 'Proveri plan' }).click();
  await expect(page.getByRole('heading', { name: 'Plan je spreman za proveru' })).toBeVisible();
  const importButton = page.getByRole('button', { name: 'Uvezi plan' });
  await expect(importButton).toBeDisabled();
  const unresolvedBalance = page.getByLabel('Trenutno stanje — Glavni račun');
  await unresolvedBalance.fill('40000');
  await unresolvedBalance.press('Tab');
  await expect(importButton).toBeEnabled();
  await expect(page.getByText('Godišnji trošak', { exact: true })).toBeVisible();
  for (const width of [360, 390, 412, 430]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  }
  await importButton.click();
  await expect(page.getByRole('heading', { name: 'Upoznajte Mirnu' })).toBeVisible();
  const imported = await readDatabaseJson(page);
  expect(imported).toContain('"name":"Glavni račun"');
  expect(imported).toContain('"name":"Internet"');
  expect(imported).toContain('"title":"Godišnji trošak"');
  expect(imported).toContain('"transactions":[]');
  expect(imported).toContain('"debtPayments":[]');
});

test('Patch preview changes only reviewed planning values and stays usable on mobile', async ({
  page,
}) => {
  await seedPlan(page);
  const actualBefore = await readDatabaseJson(page, ['accounts', 'transactions', 'debtPayments']);
  await page.goto('/more/ai-plan');
  await page
    .getByText('Predloži izmene postojećeg plana', { exact: true })
    .locator('xpath=ancestor::button[1]')
    .click();
  await expect(page.getByText('Mirna Plan Patch v1')).toBeVisible();
  await page.getByRole('button', { name: 'Imam Patch JSON' }).click();
  await page.getByLabel('Mirna Plan Patch v1').fill(
    JSON.stringify({
      planPatchVersion: 1,
      operations: [
        {
          op: 'update',
          entity: 'variableBudget',
          ref: 'variableBudget:budget_food',
          changes: { defaultAmount: 15_000 },
        },
      ],
    }),
  );
  await page.getByRole('button', { name: 'Prikaži razlike' }).click();
  await expect(page.getByRole('heading', { name: 'Proverite svaku izmenu' })).toBeVisible();
  await expect(page.getByText('15.000 RSD', { exact: true })).toBeVisible();
  for (const width of [360, 390, 412, 430]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('button', { name: 'Primeni izmene' })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  }
  await page.getByRole('button', { name: 'Primeni izmene' }).click();
  await expect(page.getByRole('heading', { name: 'AI pomoć za plan' })).toBeVisible();
  expect(await readDatabaseJson(page, ['accounts', 'transactions', 'debtPayments'])).toBe(
    actualBefore,
  );
  const updatedAmount = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('mirna-finance');
        request.onerror = () => reject(request.error ?? new Error('Baza nije otvorena.'));
        request.onsuccess = () => {
          const readRequest = request.result
            .transaction('variableBudgets', 'readonly')
            .objectStore('variableBudgets')
            .get('budget_food');
          readRequest.onerror = () =>
            reject(readRequest.error ?? new Error('Budžet nije pročitan.'));
          readRequest.onsuccess = () =>
            resolve((readRequest.result as { defaultAmount: number }).defaultAmount);
        };
      }),
  );
  expect(updatedAmount).toBe(15_000);
});

test('Patch safely adds a goal with a new protected zero-balance account', async ({ page }) => {
  await seedPlan(page);
  const transactionsBefore = await readDatabaseJson(page, ['transactions', 'debtPayments']);
  await page.goto('/more/ai-plan');
  await page
    .getByText('Predloži izmene postojećeg plana', { exact: true })
    .locator('xpath=ancestor::button[1]')
    .click();
  await page.getByRole('button', { name: 'Imam Patch JSON' }).click();
  await page.getByLabel('Mirna Plan Patch v1').fill(
    JSON.stringify({
      planPatchVersion: 1,
      operations: [
        {
          op: 'addGoalWithProtectedAccount',
          value: {
            accountName: 'Štednja — sintetička biblioteka',
            goalName: 'Sintetička biblioteka',
            emoji: '📚',
            targetAmount: 132_000,
            plannedMonthlyContribution: 11_000,
            contributionOverrides: {},
            goalType: 'sinking',
          },
        },
      ],
    }),
  );
  await page.getByRole('button', { name: 'Prikaži razlike' }).click();
  await expect(page.getByText('0 RSD — ne dodaje se novac', { exact: true })).toBeVisible();
  await expect(page.getByText('Štednja — sintetička biblioteka', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Primeni izmene' }).click();
  await expect(page.getByText('Pregledane izmene su primenjene.')).toBeVisible();

  const state = JSON.parse(
    await readDatabaseJson(page, ['accounts', 'transactions', 'debtPayments', 'goals']),
  ) as Record<string, Array<Record<string, unknown>>>;
  const account = state.accounts.find((value) => value.name === 'Štednja — sintetička biblioteka');
  const goal = state.goals.find((value) => value.name === 'Sintetička biblioteka');
  expect(account).toMatchObject({
    openingBalance: 0,
    protected: true,
    kind: 'savings',
  });
  expect(goal).toMatchObject({ linkedAccountId: account?.id, goalType: 'sinking' });
  expect(
    JSON.stringify({ transactions: state.transactions, debtPayments: state.debtPayments }),
  ).toBe(transactionsBefore);
});

test('high-risk management rows keep title, amount, status and action separated', async ({
  page,
}, testInfo) => {
  await seedPlan(page);
  for (const theme of ['Svetli', 'Tamni'] as const) {
    await page.goto('/more/appearance');
    await page.getByRole('button', { name: new RegExp(`^${theme}`) }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(theme === 'Tamni');
    for (const width of [360, 390, 412, 430]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ['/more/accounts', '/more/commitments', '/more/debts', '/more/events']) {
        await page.goto(route);
        await expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
            ),
          )
          .toBe(true);
      }
      await page.goto('/more/events');
      const row = page.getByTestId('planned-event-row').first();
      const titleBox = await row.getByTestId('planned-event-title').boundingBox();
      const amountBox = await row.getByTestId('planned-event-amount').boundingBox();
      const statusBox = await row.getByTestId('planned-event-status').boundingBox();
      const actionBox = await row.getByTestId('planned-event-action').boundingBox();
      expect(titleBox).not.toBeNull();
      expect(amountBox).not.toBeNull();
      expect(statusBox).not.toBeNull();
      expect(actionBox).not.toBeNull();
      expect(titleBox!.width).toBeGreaterThan(70);
      expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(amountBox!.x);
      expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(actionBox!.x);
      await expect(row.getByTestId('planned-event-action')).toBeVisible();

      const screenshotPath = testInfo.outputPath(`events-${theme.toLowerCase()}-${width}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await testInfo.attach(`events-${theme.toLowerCase()}-${width}`, {
        path: screenshotPath,
        contentType: 'image/png',
      });
    }
  }
});

test('core financial screens fit supported mobile widths without horizontal overflow', async ({
  page,
}) => {
  await seedPlan(page);
  for (const width of [360, 390, 412, 430]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['Mesec', 'Ciljevi', 'Prognoza']) {
      await navigate(page, route);
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        )
        .toBe(true);
    }
  }
});

test('forecast semantics, storage protection, and contextual Quick Add stay usable on mobile', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        persisted: () => Promise.resolve(false),
        persist: () => Promise.resolve(false),
        estimate: () =>
          Promise.resolve({
            usage: 2.1 * 1024 ** 2,
            quota: 10.2 * 1024 ** 3,
          }),
      },
    });
  });
  await seedPlan(page);

  await expect(page.getByRole('button', { name: 'Dodaj transakciju' })).toBeVisible();
  await navigate(page, 'Mesec');
  const monthQuickAdd = page.getByRole('button', { name: 'Dodaj transakciju' });
  await expect(monthQuickAdd).toBeVisible();
  await monthQuickAdd.click();
  await expect(page.getByRole('heading', { name: 'Brzi unos' })).toBeVisible();
  await page.keyboard.press('Escape');

  for (const route of ['/goals', '/forecast', '/more', '/more/data']) {
    await page.goto(route);
    await expect(page.getByRole('button', { name: 'Dodaj transakciju' })).toHaveCount(0);
  }

  for (const width of [360, 390, 412, 430]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/forecast');
    await expect(page.getByRole('heading', { name: 'Prognoza' })).toBeVisible();
    await expect(page.getByText(/Saldo plana/).first()).toBeVisible();
    await expect(page.getByText('na kraju meseca', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/slobodno/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Dodaj transakciju' })).toHaveCount(0);

    await page.goto('/more/data');
    await expect(page.getByRole('heading', { name: 'Podaci, backup i izvoz' })).toBeVisible();
    await expect(page.getByText('Standardna zaštita', { exact: true })).toBeVisible();
    await expect(page.getByText('2,1 MB', { exact: true })).toBeVisible();
    await expect(page.getByText('~10,2 GB', { exact: true })).toBeVisible();
    await expect(page.getByText(/Best effort|Persistent/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Dodaj transakciju' })).toHaveCount(0);

    const cardBox = await page.getByTestId('storage-protection-card').boundingBox();
    const headerBox = await page.getByTestId('storage-protection-header').boundingBox();
    const copyBox = await page.getByTestId('storage-protection-copy').boundingBox();
    const actionBox = await page.getByTestId('storage-protection-action').boundingBox();
    expect(cardBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(copyBox).not.toBeNull();
    expect(actionBox).not.toBeNull();
    expect(copyBox!.width).toBeGreaterThanOrEqual(180);
    expect(actionBox!.width).toBeGreaterThanOrEqual(cardBox!.width - 40);
    expect(actionBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
  }
});

test('installed PWA cold reload keeps the dashboard available offline', async ({
  context,
  page,
}) => {
  await seedPlan(page);
  await receiveFirstPlannedIncome(page);
  await navigate(page, 'Početna');
  await page.getByRole('button', { name: 'Dodaj transakciju' }).click();
  await page.getByRole('button', { name: /Kafa.*360 RSD/ }).click();
  await page.getByRole('button', { name: /Sačuvaj 360 RSD/ }).click();
  await page.getByRole('button', { name: 'Potvrdi i sačuvaj' }).click();
  await expect(page.getByText('Transakcija je sačuvana.')).toBeVisible();

  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /jul 2032/i })).toBeVisible();

  await navigate(page, 'Više');
  await page.getByRole('link', { name: /Transakcije/ }).click();
  await expect(page.getByText('Kafa', { exact: true })).toHaveCount(1);
  await navigate(page, 'Početna');
  await page.getByRole('button', { name: 'Dodaj transakciju' }).click();
  await page.getByRole('button', { name: /Apoteka.*1.350 RSD/ }).click();
  await page.getByRole('button', { name: /Sačuvaj 1.350 RSD/ }).click();
  await page.getByRole('button', { name: 'Potvrdi i sačuvaj' }).click();
  await expect(page.getByText('Transakcija je sačuvana.')).toBeVisible();

  for (const route of ['Mesec', 'Ciljevi', 'Prognoza', 'Više']) {
    await navigate(page, route);
  }
  await page.getByRole('link', { name: /Backup, uvoz i izvoz/ }).click();
  const markdownDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Preuzmi: Sažetak za ChatGPT/ }).click();
  const markdownDownload = await markdownDownloadPromise;
  expect(await markdownDownload.path()).toBeTruthy();
});

test('planned salary and independent marketplace income create distinct actual income', async ({
  page,
}) => {
  await seedPlan(page);
  await receiveFirstPlannedIncome(page);
  await expect(page.getByText(/187.000 RSD primljeno · 0 RSD preostalo/)).toBeVisible();

  await navigate(page, 'Početna');
  await page.getByRole('button', { name: 'Dodaj transakciju' }).click();
  await page.getByRole('button', { name: /Prodaja opreme.*Unesite iznos/ }).click();
  await page.getByLabel('Iznos (ceo broj RSD)').fill('4600');
  await page.getByRole('button', { name: /Sačuvaj 4.600 RSD/ }).click();
  await page.getByRole('button', { name: 'Potvrdi i sačuvaj' }).click();
  await expect(page.getByText('Transakcija je sačuvana.')).toBeVisible();

  await navigate(page, 'Više');
  await page.getByRole('link', { name: /Transakcije/ }).click();
  await expect(page.getByText('Plata', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Prodaja opreme', { exact: true })).toHaveCount(1);
});

test('a manual transaction note stays editable and searchable', async ({ page }) => {
  await seedPlan(page);
  await receiveFirstPlannedIncome(page);
  await navigate(page, 'Početna');
  await page.getByRole('button', { name: 'Dodaj transakciju' }).click();
  await page.getByRole('button', { name: /Kafa.*360 RSD/ }).click();
  await page.getByRole('button', { name: /Sačuvaj 360 RSD/ }).click();
  await page.getByRole('button', { name: 'Potvrdi i sačuvaj' }).click();
  await expect(page.getByText('Transakcija je sačuvana.')).toBeVisible();

  await navigate(page, 'Više');
  await page.getByRole('link', { name: /Transakcije/ }).click();
  await page.getByRole('button', { name: 'Detalji Kafa' }).click();
  await page.getByLabel('Beleška').fill('Originalna beleška za export');
  await page.getByRole('button', { name: 'Sačuvaj izmene' }).click();
  await expect(page.getByText('Transakcija je izmenjena.')).toBeVisible();
  await page.getByLabel('Pretraga').fill('Originalna beleška za export');
  await expect(page.getByText('Kafa', { exact: true })).toHaveCount(1);
});

test('goal-funded spending and self/external debt payments preserve cash semantics', async ({
  page,
}) => {
  await seedPlan(page);
  await receiveFirstPlannedIncome(page);

  await navigate(page, 'Ciljevi');
  const trainingGoal = page
    .getByRole('heading', { name: 'Stručna radionica', exact: true })
    .locator('xpath=ancestor::div[contains(@class,"rounded-card")][1]');
  await trainingGoal.getByRole('button', { name: 'Prebaci u štednju' }).click();
  await page.getByLabel('Iznos (RSD)').fill('96000');
  await page.getByRole('button', { name: /Prebaci 96.000 RSD/ }).click();
  await expect(page.getByText(/Novac je prebačen u štednju/)).toBeVisible();

  await navigate(page, 'Više');
  await page.getByRole('link', { name: /Planirani događaji/ }).click();
  await page.getByRole('button', { name: 'Detalji događaja Put do stručne radionice' }).click();
  await page.getByRole('button', { name: 'Označi kao plaćeno' }).click();
  await page.getByRole('button', { name: /Plati sa Štednja — stručna radionica/ }).click();
  await expect(page.getByText('Događaj je označen kao plaćen.')).toBeVisible();

  await navigate(page, 'Više');
  await page.getByRole('link', { name: /Dugovi/ }).click();
  const courseDebt = page
    .getByRole('heading', { name: 'Program stručnog kursa', exact: true })
    .locator('xpath=ancestor::div[contains(@class,"rounded-card")][1]');
  await courseDebt.getByRole('button', { name: 'Evidentiraj otplatu' }).click();
  await page.getByLabel('Iznos').fill('11000');
  await page.getByRole('button', { name: 'Sačuvaj otplatu' }).click();
  await expect(page.getByText('Otplata je evidentirana.')).toBeVisible();

  await courseDebt.getByRole('button', { name: 'Evidentiraj otplatu' }).click();
  await page.getByLabel('Ko je platio').selectOption('external');
  await page.getByLabel('Iznos').fill('7000');
  await page.getByRole('button', { name: 'Sačuvaj korekciju duga' }).click();
  await expect(page.getByText('Otplata je evidentirana.')).toBeVisible();
  await expect(courseDebt).toContainText('56.000 RSD');

  await navigate(page, 'Više');
  await page.getByRole('link', { name: /Transakcije/ }).click();
  await expect(page.getByText('Put do stručne radionice', { exact: true })).toHaveCount(1);
  await expect(
    page.getByText('Otplata duga — Program stručnog kursa', { exact: true }),
  ).toHaveCount(1);
});

test('protected event top-up is atomic, idempotent, and preserves historical goal plans', async ({
  page,
}) => {
  await seedPlan(page);
  await receiveFirstPlannedIncome(page);

  await navigate(page, 'Ciljevi');
  const relocationCard = page
    .getByRole('heading', { name: 'Preseljenje', exact: true })
    .locator('xpath=ancestor::div[contains(@class,"rounded-card")][1]');
  await relocationCard.getByRole('button', { name: 'Prebaci u štednju' }).click();
  await page.getByLabel('Iznos (RSD)').fill('240000');
  await page.getByRole('button', { name: /Prebaci 240.000 RSD/ }).click();
  await expect(page.getByText(/Novac je prebačen u štednju/)).toBeVisible();

  await navigate(page, 'Više');
  await page.getByRole('link', { name: /Planirani događaji/ }).click();
  await page.getByRole('button', { name: 'Detalji događaja Preseljenje i depozit' }).click();
  await page.getByRole('button', { name: 'Označi kao plaćeno' }).click();
  await expect(page.getByText(/Na računu Štednja — preseljenje imaš 240.000 RSD/)).toBeVisible();
  await expect(page.getByText(/nedostaje 6.000 RSD/)).toBeVisible();

  for (const width of [360, 390, 412, 430]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    await expect(
      page.getByRole('button', { name: /Dopuni iz Tekući račun i plati/ }),
    ).toBeVisible();
  }

  const payButton = page.getByRole('button', {
    name: /Dopuni iz Tekući račun i plati/,
  });
  await payButton.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByText('Događaj je označen kao plaćen.')).toBeVisible();

  const state = await page.evaluate(
    () =>
      new Promise<{
        checkingBalance: number;
        relocationBalance: number;
        eventExpenses: number;
        eventTopUps: number;
      }>((resolve, reject) => {
        const request = indexedDB.open('mirna-finance');
        request.onerror = () => reject(request.error ?? new Error('Baza nije otvorena.'));
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction(['accounts', 'transactions'], 'readonly');
          const accountsRequest = transaction.objectStore('accounts').getAll();
          const transactionsRequest = transaction.objectStore('transactions').getAll();
          transaction.oncomplete = () => {
            const accounts = accountsRequest.result as Array<{
              id: string;
              openingBalance: number;
            }>;
            const transactions = transactionsRequest.result as Array<{
              type: string;
              amount: number;
              accountId: string;
              toAccountId?: string;
              plannedEventId?: string;
              occurrenceKey?: string;
            }>;
            const balance = (accountId: string) =>
              (accounts.find((account) => account.id === accountId)?.openingBalance ?? 0) +
              transactions.reduce((sum, entry) => {
                if (entry.type === 'income' && entry.accountId === accountId)
                  return sum + entry.amount;
                if (entry.type === 'expense' && entry.accountId === accountId)
                  return sum - entry.amount;
                if (entry.type === 'transfer') {
                  if (entry.accountId === accountId) sum -= entry.amount;
                  if (entry.toAccountId === accountId) sum += entry.amount;
                }
                return sum;
              }, 0);
            resolve({
              checkingBalance: balance('acct_checking'),
              relocationBalance: balance('acct_relocation'),
              eventExpenses: transactions.filter(
                (entry) => entry.plannedEventId === 'event_relocation',
              ).length,
              eventTopUps: transactions.filter(
                (entry) => entry.occurrenceKey === 'event-funding:event_relocation',
              ).length,
            });
            database.close();
          };
          transaction.onerror = () =>
            reject(transaction.error ?? new Error('Čitanje baze nije uspelo.'));
        };
      }),
  );
  expect(state).toEqual({
    checkingBalance: 78_000,
    relocationBalance: 0,
    eventExpenses: 1,
    eventTopUps: 1,
  });

  await navigate(page, 'Ciljevi');
  await expect(
    page
      .getByRole('heading', { name: 'Preseljenje', exact: true })
      .locator('xpath=ancestor::div[contains(@class,"rounded-card")][1]'),
  ).toContainText('Iskorišćeno');

  await navigate(page, 'Mesec');
  const monthInput = page.getByLabel('Izaberi mesec');
  await monthInput.fill('2032-08');
  const contributionPlan = page.getByText('Plan doprinosa', { exact: true }).locator('xpath=..');
  await expect(contributionPlan).toContainText('113.000 RSD');
  await monthInput.fill('2032-09');
  await expect(contributionPlan).toContainText('87.000 RSD');
});

test('retroactive salary keeps the July occurrence linked and books actual cash in August', async ({
  page,
}) => {
  await seedPlan(page);
  await navigate(page, 'Mesec');
  await page.getByRole('button', { name: 'Primljeno', exact: true }).click();
  for (const width of [360, 390, 412, 430]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByLabel('Datum prijema')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  }
  await page.getByLabel('Datum prijema').fill('2032-08-01');
  await page.getByLabel('Beleška (opciono)').fill('Leglo u avgustu');
  await page.getByRole('button', { name: 'Potvrdi prijem' }).click();
  await expect(page.getByText(/0 RSD primljeno · 0 RSD preostalo/)).toBeVisible();
  await expect(page.getByText('01.08.2032', { exact: true })).toBeVisible();

  await page.getByLabel('Izaberi mesec').fill('2032-08');
  const incomeCard = page.getByText('Prihod', { exact: true }).first().locator('xpath=..');
  await expect(incomeCard).toContainText('187.000 RSD');
});

test('midnight rollover refreshes the current month and calculations without reload', async ({
  page,
}) => {
  expect(
    await page.evaluate(() => {
      const now = new Date();
      return {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        localTime: [
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          now.getHours(),
          now.getMinutes(),
        ],
      };
    }),
  ).toEqual({
    timeZone: 'Europe/Belgrade',
    localTime: [2032, 6, 31, 23, 59],
  });

  await seedPlan(page);
  await receiveFirstPlannedIncome(page, '2032-07-31');
  await navigate(page, 'Početna');
  await page.getByRole('button', { name: 'Dodaj transakciju' }).click();
  await page.getByRole('button', { name: /Kafa.*360 RSD/ }).click();
  await page.getByRole('button', { name: /Sačuvaj 360 RSD/ }).click();
  await page.getByRole('button', { name: 'Potvrdi i sačuvaj' }).click();
  const spentCard = page.getByText('Potrošeno', { exact: true }).locator('xpath=..');
  await expect(spentCard).toContainText('360 RSD');

  await page.clock.runFor(2 * 60 * 1000);
  expect(
    await page.evaluate(() => {
      const now = new Date();
      return [now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()];
    }),
  ).toEqual([2032, 7, 1, 0, 1]);
  await expect(page.getByRole('heading', { name: /avgust 2032/i })).toBeVisible();
  await expect(spentCard).toContainText('0 RSD');
});

test('seed, daily expense, goal transfer and paid commitment preserve finance invariants', async ({
  page,
}) => {
  await seedPlan(page);
  await receiveFirstPlannedIncome(page);
  await navigate(page, 'Početna');

  await page.getByRole('button', { name: 'Dodaj transakciju' }).click();
  await page.getByRole('button', { name: /Apoteka.*1.350 RSD/ }).click();
  await page.getByRole('button', { name: /Sačuvaj 1.350 RSD/ }).click();
  await expect(page.getByRole('heading', { name: 'Potvrditi trošak?' })).toBeVisible();
  await page.getByRole('button', { name: 'Potvrdi i sačuvaj' }).click();
  await expect(page.getByText('Transakcija je sačuvana.')).toBeVisible();

  await navigate(page, 'Mesec');
  const pharmacy = page
    .locator('div')
    .filter({ hasText: /^🧴 Apoteka/ })
    .last();
  await expect(pharmacy).toContainText('1.350 RSD / 7.200 RSD');

  await navigate(page, 'Ciljevi');
  const relocationCard = page
    .getByRole('heading', { name: 'Preseljenje', exact: true })
    .locator('xpath=ancestor::div[contains(@class,"rounded-card")][1]');
  await relocationCard.getByRole('button', { name: 'Prebaci u štednju' }).click();
  await page.getByLabel('Iznos (RSD)').fill('42000');
  await page.getByRole('button', { name: /Prebaci 42.000 RSD/ }).click();
  await expect(page.getByText(/Novac je prebačen u štednju/)).toBeVisible();
  await expect(relocationCard).toContainText('42.000 RSD');

  await navigate(page, 'Početna');
  await page.getByRole('button', { name: 'Označi kao plaćeno: Rata za laptop' }).click();
  await expect(page.getByText('Označeno kao plaćeno.')).toBeVisible();

  await navigate(page, 'Više');
  await page.getByRole('link', { name: /Transakcije/ }).click();
  await expect(page.getByText('Rata za laptop', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Uplata za cilj — Preseljenje', { exact: true })).toBeVisible();
});

test('forecast scenario is isolated and JSON/Markdown export can restore data', async ({
  page,
}) => {
  await seedPlan(page);

  await navigate(page, 'Prognoza');
  await page.getByLabel('Scenario plate').selectOption('scenario_potential');
  const september = page.getByRole('button', { name: /septembar 2032/i });
  await september.click();
  await expect(september).toContainText('241.000 RSD');

  await navigate(page, 'Više');
  await page.getByRole('link', { name: /Backup, uvoz i izvoz/ }).click();

  const backupDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Izvezi: Kompletan JSON backup/ }).click();
  const backupDownload = await backupDownloadPromise;
  const backupPath = await backupDownload.path();
  if (!backupPath) throw new Error('JSON backup nije sačuvan na disk.');
  const backupText = await readFile(backupPath, 'utf8');
  expect(backupText).toContain(`"version": "${APPLICATION_VERSION}"`);
  await expect(page.getByText('Backup je svež — napravljen danas.')).toBeVisible();

  const markdownDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Preuzmi: Sažetak za ChatGPT/ }).click();
  const markdownDownload = await markdownDownloadPromise;
  const markdownPath = await markdownDownload.path();
  if (!markdownPath) throw new Error('Markdown export nije sačuvan na disk.');
  const markdown = await readFile(markdownPath, 'utf8');
  expect(markdown).toContain('# Mirna Financial Snapshot');
  expect(markdown).toContain(`- appVersion: ${APPLICATION_VERSION}`);
  expect(markdown).toContain('## Current actual balances');
  expect(markdown).toContain('## Balance adjustments');
  expect(markdown).toContain('## Cash ledger reconciliation');
  expect(markdown).toContain('## Forecast');
  expect(markdown).toContain('Monthly plan balance');
  expect(markdown).not.toContain('Monthly net flow');
  expect(markdown).toContain('## Recent notable transactions');
  expect(markdown).toContain('## Major irregular expenses — last 180 days');
  expect(markdown).toContain('### Expense reconciliation');

  await page.getByRole('button', { name: 'Obriši' }).click();
  await page.getByRole('button', { name: 'Obriši sve' }).click();
  await expect(page.getByRole('heading', { name: /Planiraj\. Beleži/ })).toBeVisible();
  await page.getByRole('button', { name: 'Nastavi' }).click();
  await page.getByRole('button', { name: /Razumem/ }).click();
  await page.getByRole('button', { name: /Uvezi backup/ }).click();
  await page.locator('input[type="file"]').setInputFiles(backupPath);
  await expect(page.getByRole('heading', { name: 'Backup je validan' })).toBeVisible();
  await page.getByRole('button', { name: 'Vrati backup' }).click();
  await navigate(page, 'Početna');
  await expect(page.getByText('Mobilni paket', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
});

test('Quick Add accepts consecutive touch entries while success feedback is visible', async ({
  page,
}) => {
  await seedPlan(page);
  await receiveFirstPlannedIncome(page);
  await navigate(page, 'Početna');

  const addExpense = async () => {
    await page.getByRole('button', { name: 'Dodaj transakciju' }).tap();
    await page.getByRole('button', { name: /Apoteka.*1.350 RSD/ }).tap();
    await page.getByRole('button', { name: /Sačuvaj 1.350 RSD/ }).tap();
    await expect(page.getByText(/Sačuvati trošak „Apoteka” od 1.350 RSD/)).toBeVisible();
    await page.getByRole('button', { name: 'Potvrdi i sačuvaj' }).tap();
    await expect(page.getByText('Transakcija je sačuvana.').last()).toBeVisible();
  };

  await addExpense();
  await addExpense();

  await navigate(page, 'Više');
  await page.getByRole('link', { name: /Transakcije/ }).tap();
  await expect(page.getByText('Apoteka', { exact: true })).toHaveCount(2);
});

test('10,000-transaction fixture keeps startup and core interactions responsive', async ({
  page,
}, testInfo) => {
  test.slow();
  await seedPlan(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('mirna-finance');
        request.onerror = () => reject(request.error ?? new Error('Baza nije otvorena.'));
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('transactions', 'readwrite');
          const store = transaction.objectStore('transactions');
          for (let index = 0; index < 10_000; index += 1) {
            store.add({
              id: `perf-${index}`,
              type: 'expense',
              amount: 100 + (index % 20),
              accountId: 'acct_checking',
              categoryId: 'cat_food',
              date: `2032-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
              description: `Performance ${index}`,
              source: 'manual',
              createdAt: new Date(2032, index % 12, (index % 28) + 1, 12).toISOString(),
            });
          }
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () =>
            reject(transaction.error ?? new Error('Fixture nije upisan.'));
          transaction.onabort = () =>
            reject(transaction.error ?? new Error('Fixture upis je prekinut.'));
        };
      }),
  );

  const timings: Record<string, number> = {};
  let startedAt = Date.now();
  await page.reload();
  await expect(page.getByRole('heading', { name: /jul 2032/i })).toBeVisible();
  timings.startup = Date.now() - startedAt;

  startedAt = Date.now();
  await navigate(page, 'Mesec');
  await expect(page.getByRole('heading', { name: 'Mesečni pregled' })).toBeVisible();
  timings.month = Date.now() - startedAt;

  startedAt = Date.now();
  await page.getByRole('button', { name: 'Dodaj transakciju' }).click();
  await expect(page.getByRole('button', { name: /Apoteka.*1.350 RSD/ })).toBeVisible();
  timings.quickAdd = Date.now() - startedAt;
  await page.keyboard.press('Escape');

  startedAt = Date.now();
  await navigate(page, 'Više');
  await page.getByRole('link', { name: /Transakcije/ }).click();
  await expect(page.getByRole('button', { name: /Učitaj još/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Detalji/ })).toHaveCount(100);
  timings.transactions = Date.now() - startedAt;

  startedAt = Date.now();
  await navigate(page, 'Prognoza');
  await expect(page.getByRole('heading', { name: 'Prognoza' })).toBeVisible();
  timings.forecast = Date.now() - startedAt;

  await navigate(page, 'Više');
  await page.getByRole('link', { name: /Backup, uvoz i izvoz/ }).click();
  startedAt = Date.now();
  const exportDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Preuzmi: Sažetak za ChatGPT/ }).click();
  await exportDownloadPromise;
  timings.export = Date.now() - startedAt;

  expect(timings.startup).toBeLessThan(5_000);
  expect(timings.month).toBeLessThan(4_000);
  expect(timings.quickAdd).toBeLessThan(2_000);
  expect(timings.transactions).toBeLessThan(4_000);
  expect(timings.forecast).toBeLessThan(4_000);
  expect(timings.export).toBeLessThan(5_000);
  console.info(JSON.stringify({ performanceTimingsMs: timings }));
  await testInfo.attach('performance-timings.json', {
    body: JSON.stringify(timings, null, 2),
    contentType: 'application/json',
  });
});

test('legacy review notice uses generic copy and can be dismissed', async ({ page }) => {
  await seedPlan(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('mirna-finance');
        request.onerror = () => reject(request.error ?? new Error('Baza nije otvorena.'));
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('settings', 'readwrite');
          const store = transaction.objectStore('settings');
          const read = store.get('settings');
          read.onsuccess = () => {
            store.put({ ...read.result, seedReviewRecommended: true });
          };
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () =>
            reject(transaction.error ?? new Error('Podešavanje nije sačuvano.'));
        };
      }),
  );
  await page.reload();

  await expect(
    page.getByText('Pregledajte podatke iz ranije verzije', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Stariji plan može sadržati stavke koje nova verzija može preciznije modelovati. Vaše vrednosti nisu automatski menjane.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Pregledano' }).click();
  await expect(
    page.getByText('Pregledajte podatke iz ranije verzije', { exact: true }),
  ).not.toBeVisible();
});

test('direct routes reload and supported viewports have no horizontal page overflow', async ({
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  await seedPlan(page);
  const routes: Array<[string, RegExp]> = [
    ['/', /jul 2032/i],
    ['/month', /Mesečni pregled/i],
    ['/goals', /^Ciljevi$/i],
    ['/forecast', /^Prognoza$/i],
    ['/more', /^Više$/i],
    ['/more/accounts', /^Računi$/i],
    ['/more/income', /Planirani prihodi/i],
    ['/more/debts', /^Dugovi$/i],
    ['/more/events', /Planirani događaji/i],
    ['/more/data', /Podaci, backup i izvoz/i],
    ['/more/ai-plan', /^AI pomoć za plan$/i],
    ['/more/help', /^Pomoć i vodič$/i],
    ['/more/about', /^O aplikaciji$/i],
  ];
  for (const [route, heading] of routes) {
    await page.goto(route);
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
  }
  await expect(page.getByText(`Mirna ${APPLICATION_VERSION}`, { exact: true })).toBeVisible();
  await expect(page.getByText(/AGPL-3.0-only/)).toBeVisible();
  const sourceLink = page.getByRole('link', { name: /GitHub/ });
  await expect(sourceLink).toHaveAttribute('href', 'https://github.com/Gibo2706/mirna');
  await expect(sourceLink).toHaveAttribute('target', '_blank');
  await expect(sourceLink).toHaveAttribute('rel', 'noreferrer noopener');
  const authorLink = page.getByRole('link', { name: 'Bogdan Marković' });
  await expect(authorLink).toHaveAttribute('href', 'https://github.com/Gibo2706');
  await expect(authorLink).toHaveAttribute('target', '_blank');
  await expect(authorLink).toHaveAttribute('rel', 'noreferrer noopener');

  for (const width of [360, 390, 412, 430, 1280]) {
    await page.setViewportSize({ width, height: width < 600 ? 900 : 800 });
    for (const route of ['/', '/month', '/goals', '/forecast']) {
      await page.goto(route);
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        )
        .toBe(true);
    }
  }
  expect(runtimeErrors).toEqual([]);
});
