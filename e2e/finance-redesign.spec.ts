import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  createSyntheticFinanceFixtureData,
  defaultSyntheticFinanceFixtureInput,
} from '../src/tests/fixtures/syntheticFinanceFixture';
import type { LedgerTransaction } from '../src/domain/types';

const seed = async (page: Page, funded = false) => {
  await page.clock.install({ time: new Date('2032-07-28T12:00:00+02:00') });
  await page.goto('/');
  await page.getByRole('button', { name: 'Nastavi' }).click();
  await page.getByRole('button', { name: /Razumem/ }).click();
  await page.getByRole('button', { name: /Uvezi backup/ }).click();
  const data = createSyntheticFinanceFixtureData(
    defaultSyntheticFinanceFixtureInput(new Date('2032-07-28T10:00:00Z')),
  );
  const checking = data.accounts.find((a) => a.id === 'acct_checking')!;
  const goal = data.goals[0];
  const savings = data.accounts.find((a) => a.id === goal.linkedAccountId)!;
  checking.openingBalance = funded ? 1000 : 100000;
  savings.openingBalance = funded ? 30000 : 0;
  goal.name = 'Stan';
  goal.targetAmount = 50000;
  goal.plannedMonthlyContribution = 20000;
  goal.contributionOverrides = {};
  goal.targetDate = '2032-12-31';
  data.goals = [goal];
  data.accounts = [checking, savings];
  data.transactions = [];
  data.plannedEvents = [];
  data.debts = [];
  data.debtPayments = [];
  data.variableBudgets = [];
  data.presets = [];
  data.plannedIncomes = data.plannedIncomes.filter((p) => p.accountId === checking.id);
  data.commitments = [
    {
      ...data.commitments[0],
      id: 'rent',
      name: 'Kirija',
      amount: 30000,
      accountId: checking.id,
      frequency: 'monthly',
      dueDay: 28,
      startDate: '2032-07-01',
      endDate: undefined,
    },
  ];
  data.settings[0].defaultAccountId = checking.id;
  await page.locator('input[type="file"]').setInputFiles({
    name: 'test-fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 3,
        exportedAt: '2032-07-28T10:00:00Z',
        application: { name: 'Mirna', version: '2.4.1', currency: 'RSD' },
        data,
      }),
    ),
  });
  await expect(page.getByRole('heading', { name: 'Backup je validan' })).toBeVisible();
  await page.getByRole('button', { name: 'Vrati backup' }).click();
  await expect(page.getByRole('heading', { name: /jul 2032/i })).toBeVisible();
  const dismiss = page.getByRole('button', { name: 'U redu', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  return { checking, savings, goal };
};
const ledger = (page: Page): Promise<LedgerTransaction[]> =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('mirna-finance');
        r.onerror = () => reject(r.error ?? new Error('IndexedDB could not open'));
        r.onsuccess = () => {
          const db = r.result;
          const t = db.transaction('transactions');
          const q = t.objectStore('transactions').getAll();
          q.onsuccess = () => resolve(q.result);
          t.oncomplete = () => db.close();
        };
      }),
  );
const nav = (page: Page, name: string) =>
  page.getByLabel('Glavna navigacija').getByRole('link', { name, exact: true }).click();
const movement = (rows: LedgerTransaction[], id: string) =>
  rows.reduce(
    (n, t) =>
      n +
      (t.toAccountId === id ? t.amount : 0) +
      (t.accountId === id
        ? t.type === 'income' || t.type === 'adjustment'
          ? t.amount
          : -t.amount
        : 0),
    0,
  );
const totals = (rows: LedgerTransaction[]) => ({
  income: rows.filter((t) => t.type === 'income').reduce((n, t) => n + t.amount, 0),
  expense: rows.filter((t) => t.type === 'expense').reduce((n, t) => n + t.amount, 0),
});
const manual = async (page: Page, type: 'Transfer' | 'Trošak', amount: string, to?: string) => {
  await page.getByRole('button', { name: 'Dodaj transakciju', exact: true }).click();
  await page.getByRole('button', { name: 'Druga transakcija' }).click();
  await page.getByRole('button', { name: type, exact: true }).click();
  await page.getByLabel('Iznos (ceo broj RSD)').fill(amount);
  if (type === 'Trošak')
    await page
      .getByRole('combobox', { name: 'Kategorija', exact: true })
      .selectOption({ index: 1 });
  if (to) await page.getByRole('combobox', { name: /^Na račun/ }).selectOption(to);
  await page
    .getByLabel('Opis', { exact: true })
    .fill(type === 'Transfer' ? 'Za Stan' : 'Kirija ručno');
  await page.getByRole('button', { name: /Sačuvaj/ }).click();
  await page.getByRole('button', { name: 'Potvrdi i sačuvaj' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
};

test('FAB and goal deposits agree; withdrawal preserves target and cash totals', async ({
  page,
}) => {
  const { checking, savings } = await seed(page);
  await manual(page, 'Transfer', '10000', savings.id);
  let rows = await ledger(page);
  expect(movement(rows, checking.id)).toBe(-10000);
  expect(movement(rows, savings.id)).toBe(10000);
  expect(totals(rows)).toEqual({ income: 0, expense: 0 });
  await nav(page, 'Ciljevi');
  const row = page.getByTestId('goal-row');
  await expect(row).toContainText('10.000 RSD');
  await nav(page, 'Mesec');
  await expect(page.getByText('Prebačeno u štednju').locator('..')).toContainText('10.000 RSD');
  await expect(page.getByText('Preostali doprinos').locator('..')).toContainText('10.000 RSD');
  await nav(page, 'Ciljevi');
  await row.getByRole('button', { name: 'Prebaci u štednju' }).click();
  await page.getByLabel('Iznos (RSD)', { exact: true }).fill('10000');
  await page.getByRole('button', { name: 'Prebaci 10.000 RSD', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  rows = await ledger(page);
  expect(movement(rows, savings.id)).toBe(20000);
  expect(totals(rows)).toEqual({ income: 0, expense: 0 });
  await row.getByRole('button', { name: 'Iskoristi sredstva' }).click();
  await page.getByLabel('Iznos za korišćenje (RSD)').fill('5000');
  await page.getByRole('button', { name: 'Prebaci na račun · 5.000 RSD' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  rows = await ledger(page);
  expect(movement(rows, savings.id)).toBe(15000);
  expect(movement(rows, checking.id)).toBe(-15000);
  expect(totals(rows)).toEqual({ income: 0, expense: 0 });
  await expect(row).toContainText('50.000 RSD');
  await expect(row).toContainText('15.000 RSD');
});

test('linking an existing rent expense changes classification without duplicating money', async ({
  page,
}) => {
  await seed(page);
  await manual(page, 'Trošak', '30000');
  const before = await ledger(page);
  await page.getByRole('button', { name: 'Označi kao plaćeno: Kirija' }).click();
  await page.getByRole('button', { name: 'Već sam ovo platio' }).click();
  await page.getByRole('radio').check();
  await page.getByRole('button', { name: 'Poveži plaćanje', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const after = await ledger(page);
  expect(after).toHaveLength(before.length);
  expect(after[0]).toMatchObject({
    id: before[0].id,
    amount: 30000,
    source: 'commitment',
    occurrenceKey: 'rent:2032-07-28',
  });
  expect(totals(after).expense).toBe(30000);
  await nav(page, 'Mesec');
  await expect(
    page
      .getByRole('region', { name: 'Plan i stvarno stanje' })
      .getByText('Fiksno', { exact: true })
      .locator('..'),
  ).toContainText('30.000');
  await expect(page.getByText('Završeno', { exact: true })).toBeVisible();
});

test('savings-funded rent creates one transfer and one expense atomically', async ({ page }) => {
  const { checking, savings } = await seed(page, true);
  await page.getByRole('button', { name: 'Označi kao plaćeno: Kirija' }).click();
  await page.getByLabel('Koristi štednju').check();
  await page.getByRole('combobox', { name: 'Iz štednje', exact: true }).selectOption(savings.id);
  await page.getByRole('button', { name: 'Potvrdi plaćanje', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const rows = await ledger(page);
  expect(rows).toHaveLength(2);
  expect(rows.filter((t) => t.type === 'transfer')).toHaveLength(1);
  expect(rows.filter((t) => t.type === 'expense')).toHaveLength(1);
  expect(movement(rows, checking.id)).toBe(0);
  expect(movement(rows, savings.id)).toBe(-30000);
  expect(totals(rows)).toEqual({ income: 0, expense: 30000 });
});

test('responsive finance screens and sheets at all requested mobile widths', async ({ page }) => {
  test.setTimeout(120_000);
  const { savings } = await seed(page, true);
  mkdirSync('screenshots/finance-redesign', { recursive: true });
  for (const [width, height] of [
    [320, 800],
    [360, 800],
    [390, 844],
    [412, 915],
    [430, 932],
  ]) {
    await page.setViewportSize({ width, height });
    for (const [path, name] of [
      ['/', 'dashboard'],
      ['/month', 'month'],
      ['/goals', 'goals'],
      ['/more', 'more'],
      ['/more/commitments', 'commitments'],
      ['/more/events', 'events'],
    ]) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const action = page.getByTestId('page-action');
      if (await action.count()) {
        const box = await action.boundingBox();
        expect(box?.width).toBeGreaterThan(100);
      }
      if (width === 390)
        await page.screenshot({
          animations: 'disabled',
          path: `screenshots/finance-redesign/${name}-mobile.png`,
          fullPage: true,
        });
    }
    await page.goto('/');
    await page.getByRole('button', { name: 'Dodaj transakciju', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    if (width === 390)
      await page.screenshot({
        animations: 'disabled',
        path: 'screenshots/finance-redesign/quick-add.png',
      });
    await page.getByRole('button', { name: 'Zatvori', exact: true }).click();
    await page.getByRole('button', { name: 'Označi kao plaćeno: Kirija' }).click();
    await page.getByLabel('Koristi štednju').check();
    await page.getByRole('combobox', { name: 'Iz štednje', exact: true }).selectOption(savings.id);
    await expect(
      page.getByRole('button', { name: 'Potvrdi plaćanje', exact: true }),
    ).toBeInViewport();
    if (width === 390)
      await page.screenshot({
        animations: 'disabled',
        path: 'screenshots/finance-redesign/payment.png',
      });
    await page.getByRole('button', { name: 'Zatvori', exact: true }).click();
    await nav(page, 'Ciljevi');
    await page.getByRole('button', { name: 'Iskoristi sredstva' }).click();
    await page.getByLabel('Iznos za korišćenje (RSD)').fill('5000');
    await expect(
      page.getByRole('button', { name: 'Prebaci na račun · 5.000 RSD' }),
    ).toBeInViewport();
    if (width === 390)
      await page.screenshot({
        animations: 'disabled',
        path: 'screenshots/finance-redesign/withdrawal.png',
      });
    await page.getByRole('button', { name: 'Zatvori', exact: true }).click();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [path, name] of [
    ['/', 'dashboard'],
    ['/month', 'month'],
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.screenshot({
      animations: 'disabled',
      path: `screenshots/finance-redesign/${name}-desktop.png`,
      fullPage: true,
    });
  }
});
