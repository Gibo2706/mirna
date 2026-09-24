import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorWorker, publishSanitizedLog } from './sync-e2e-diagnostics.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerEntrypoint = resolve(repositoryRoot, 'node_modules/wrangler/bin/wrangler.js');
const workerConfig = resolve(repositoryRoot, 'services/sync-worker/wrangler.jsonc');
const stateDirectory = resolve(repositoryRoot, '.wrangler/sync-e2e-state');
const expectedStateDirectory = resolve(repositoryRoot, '.wrangler', 'sync-e2e-state');
const wranglerLog = resolve(repositoryRoot, '.wrangler/sync-e2e-private/wrangler.log');
const workerStatus = resolve(repositoryRoot, '.wrangler/sync-e2e-worker-status.json');

if (stateDirectory !== expectedStateDirectory) {
  throw new Error('Refusing to reset an unexpected Wrangler persistence directory.');
}

mkdirSync(dirname(stateDirectory), { recursive: true });
rmSync(stateDirectory, { recursive: true, force: true });
mkdirSync(dirname(wranglerLog), { recursive: true, mode: 0o700 });
writeFileSync(wranglerLog, '', { mode: 0o600 });
writeFileSync(resolve(repositoryRoot, '.wrangler/sync-e2e-wrangler.log'), '');
rmSync(workerStatus, { force: true });

const environment = {
  ...process.env,
  WRANGLER_LOG: 'warn',
  WRANGLER_LOG_PATH: wranglerLog,
};

const migration = spawnSync(
  process.execPath,
  [
    wranglerEntrypoint,
    'd1',
    'migrations',
    'apply',
    'mirna-sync-local',
    '--local',
    '--persist-to',
    stateDirectory,
    '--config',
    workerConfig,
  ],
  {
    cwd: repositoryRoot,
    env: { ...environment, CI: 'true' },
    stdio: 'inherit',
  },
);

if (migration.error) throw migration.error;
if (migration.status !== 0) {
  throw new Error('Local sync migration failed.');
}

const worker = spawn(
  process.execPath,
  [
    wranglerEntrypoint,
    'dev',
    resolve(repositoryRoot, 'services/sync-worker/src/e2e-fixture.ts'),
    '--local',
    '--ip',
    '127.0.0.1',
    '--port',
    '8787',
    '--persist-to',
    stateDirectory,
    '--config',
    workerConfig,
    '--test-scheduled',
    '--log-level',
    'warn',
  ],
  {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
  },
);

const stop = monitorWorker(worker, {
  saveStatus: (status) => {
    writeFileSync(`${workerStatus}.tmp`, JSON.stringify(status));
    renameSync(`${workerStatus}.tmp`, workerStatus);
  },
  publishLog: publishSanitizedLog,
  fail: (code, message) => {
    process.stderr.write(`${message}\n`);
    process.exitCode = code;
  },
});

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
