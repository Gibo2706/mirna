import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  createHeroMarkup,
  createOverviewMarkup,
  createSocialPreviewMarkup,
} from './readme-assets/compositions.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..');
const fixturePath = join(root, 'src/tests/fixtures/readmeDemoFixture.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const outputDirectory = join(root, 'docs/assets/readme');
const socialPreviewPath = join(root, 'docs/assets/github-social-preview.png');
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'mirna-readme-assets-'));
const baseUrl = 'http://127.0.0.1:4174';
const viteCli = join(root, 'node_modules/vite/bin/vite.js');
const expectedNotice = "Synthetic test data. Not based on any real person's financial records.";

if (fixture.syntheticDataNotice !== expectedNotice) {
  throw new Error('README fixture is missing the required synthetic-data notice.');
}

const expectedOutputs = [
  'home-dark.png',
  'month-light.png',
  'goals-light.png',
  'forecast-dark.png',
  'planned-events-dark.png',
  'ai-plan-bridge-light.png',
  'mirna-hero.png',
  'product-overview.png',
  'github-social-preview.png',
];

const readPngDimensions = (file) => {
  const buffer = readFileSync(file);
  if (buffer.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error(`${file} is not a PNG file.`);
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
};

const waitForServer = async (url, attempts = 120) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The controlled preview is still starting.
    }
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 250));
  }
  throw new Error(`Preview did not become ready at ${url}.`);
};

const dismissPwaStatus = async (page) => {
  for (const label of ['U redu', 'Kasnije']) {
    const button = page.getByRole('button', { name: label, exact: true });
    if (await button.isVisible().catch(() => false)) await button.click();
  }
};

const waitForStableLayout = async (page) => {
  await page.locator('main').waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        caret-color: transparent !important;
        transition: none !important;
      }
      html { scroll-behavior: auto !important; }
    `,
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await dismissPwaStatus(page);
};

const updateAppearance = (page, appearance) =>
  page.evaluate(
    (nextAppearance) =>
      new Promise((resolveUpdate, rejectUpdate) => {
        const request = indexedDB.open('mirna-finance');
        request.onerror = () => rejectUpdate(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('settings', 'readwrite');
          const store = transaction.objectStore('settings');
          const getRequest = store.get('settings');
          getRequest.onerror = () => rejectUpdate(getRequest.error);
          getRequest.onsuccess = () => {
            store.put({
              ...getRequest.result,
              appearance: nextAppearance,
              updatedAt: '2034-04-18T10:00:00.000Z',
            });
          };
          transaction.oncomplete = () => {
            database.close();
            resolveUpdate();
          };
          transaction.onerror = () => rejectUpdate(transaction.error);
        };
      }),
    appearance,
  );

const captureScreen = async ({ page, route, appearance, heading, filename }) => {
  await updateAppearance(page, appearance);
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
  try {
    await page.getByRole('heading', { name: heading }).first().waitFor({ timeout: 15_000 });
  } catch (error) {
    const headings = await page.getByRole('heading').allTextContents();
    throw new Error(
      `Expected heading ${String(heading)} at ${page.url()}; visible headings: ${JSON.stringify(headings)}`,
      { cause: error },
    );
  }
  await waitForStableLayout(page);
  const path = join(temporaryDirectory, filename);
  await page.screenshot({ path, fullPage: false, animations: 'disabled', scale: 'css' });
  return readFileSync(path);
};

const renderComposite = async ({ browser, width, height, markup, filename }) => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(markup, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const path = join(temporaryDirectory, filename);
  await page.screenshot({ path, animations: 'disabled', scale: 'css' });
  await page.close();
  return readFileSync(path);
};

const verifyOutput = (filename, dimensions, maximumBytes) => {
  const path = join(temporaryDirectory, filename);
  const actualDimensions = readPngDimensions(path);
  const size = statSync(path).size;
  if (
    actualDimensions.width !== dimensions.width ||
    actualDimensions.height !== dimensions.height
  ) {
    throw new Error(
      `${filename} is ${actualDimensions.width}x${actualDimensions.height}; expected ${dimensions.width}x${dimensions.height}.`,
    );
  }
  if (size > maximumBytes) {
    throw new Error(`${filename} is ${size} bytes; limit is ${maximumBytes} bytes.`);
  }
  return { ...actualDimensions, size };
};

let preview;
let browser;

try {
  process.stdout.write('Building the controlled production preview…\n');
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  preview = spawn(
    process.execPath,
    [viteCli, 'preview', '--host', '127.0.0.1', '--port', '4174', '--strictPort'],
    { cwd: root, stdio: 'ignore' },
  );
  await waitForServer(baseUrl);
  process.stdout.write('Preview ready; opening an isolated browser context…\n');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: fixture.viewport,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    locale: 'sr-Latn-RS',
    serviceWorkers: 'allow',
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(fixture.frozenAt));
  process.stdout.write('Importing the synthetic v3 backup through onboarding…\n');
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Planiraj\. Beleži/ }).waitFor();
  await page.getByRole('button', { name: 'Nastavi' }).click();
  await page.getByRole('button', { name: /Razumem/ }).click();
  await page.getByRole('button', { name: /Uvezi backup/ }).click();

  const backup = {
    schemaVersion: 3,
    exportedAt: fixture.frozenAt,
    application: { name: 'Mirna', version: '2.3.2', currency: 'RSD' },
    data: fixture.data,
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: 'mirna-synthetic-readme-demo.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await page.getByRole('heading', { name: 'Backup je validan' }).waitFor();
  await page.getByRole('button', { name: 'Vrati backup' }).click();
  await page.getByRole('heading', { name: /april 2034/i }).waitFor();
  await dismissPwaStatus(page);
  process.stdout.write('Capturing real Mirna routes…\n');

  const home = await captureScreen({
    page,
    route: '/',
    appearance: 'dark',
    heading: /april 2034/i,
    filename: 'home-dark.png',
  });
  const month = await captureScreen({
    page,
    route: '/month',
    appearance: 'light',
    heading: 'Mesečni pregled',
    filename: 'month-light.png',
  });
  await captureScreen({
    page,
    route: '/goals',
    appearance: 'light',
    heading: 'Ciljevi',
    filename: 'goals-light.png',
  });
  const forecast = await captureScreen({
    page,
    route: '/forecast',
    appearance: 'dark',
    heading: 'Prognoza',
    filename: 'forecast-dark.png',
  });
  await captureScreen({
    page,
    route: '/more/events',
    appearance: 'dark',
    heading: 'Planirani događaji',
    filename: 'planned-events-dark.png',
  });
  await captureScreen({
    page,
    route: '/more/ai-plan',
    appearance: 'light',
    heading: 'AI pomoć za plan',
    filename: 'ai-plan-bridge-light.png',
  });

  const icon = readFileSync(join(root, 'public/app-icon.svg'));
  process.stdout.write('Rendering the README composites…\n');
  await renderComposite({
    browser,
    width: 1600,
    height: 900,
    filename: 'mirna-hero.png',
    markup: createHeroMarkup({ icon, home, forecast }),
  });
  await renderComposite({
    browser,
    width: 1600,
    height: 900,
    filename: 'product-overview.png',
    markup: createOverviewMarkup({ home, month, forecast }),
  });
  await renderComposite({
    browser,
    width: 1280,
    height: 640,
    filename: 'github-social-preview.png',
    markup: createSocialPreviewMarkup({ icon, home, forecast }),
  });

  const mobileDimensions = fixture.viewport;
  const results = [
    ...[
      'home-dark.png',
      'month-light.png',
      'goals-light.png',
      'forecast-dark.png',
      'planned-events-dark.png',
      'ai-plan-bridge-light.png',
    ].map((filename) => ({
      filename,
      ...verifyOutput(filename, mobileDimensions, 400_000),
    })),
    {
      filename: 'mirna-hero.png',
      ...verifyOutput('mirna-hero.png', { width: 1600, height: 900 }, 1_500_000),
    },
    {
      filename: 'product-overview.png',
      ...verifyOutput('product-overview.png', { width: 1600, height: 900 }, 1_500_000),
    },
    {
      filename: 'github-social-preview.png',
      ...verifyOutput('github-social-preview.png', { width: 1280, height: 640 }, 1_000_000),
    },
  ];

  mkdirSync(outputDirectory, { recursive: true });
  for (const filename of expectedOutputs.filter(
    (candidate) => candidate !== 'github-social-preview.png',
  )) {
    copyFileSync(join(temporaryDirectory, filename), join(outputDirectory, filename));
  }
  mkdirSync(dirname(socialPreviewPath), { recursive: true });
  copyFileSync(join(temporaryDirectory, 'github-social-preview.png'), socialPreviewPath);

  process.stdout.write('README assets generated from the synthetic local fixture:\n');
  for (const result of results) {
    process.stdout.write(
      `- ${result.filename}: ${result.width}x${result.height}, ${result.size} bytes\n`,
    );
  }

  await context.close();
} catch (error) {
  process.stderr.write(
    `README asset generation failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (preview) {
    if (preview.exitCode === null && preview.signalCode === null) preview.kill('SIGTERM');
    if (preview.exitCode === null && preview.signalCode === null) {
      await new Promise((resolveExit) => {
        preview.once('exit', resolveExit);
        setTimeout(resolveExit, 2_000);
      });
    }
    if (preview.exitCode === null && preview.signalCode === null) preview.kill('SIGKILL');
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
