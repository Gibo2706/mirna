import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viteEntrypoint = resolve(repositoryRoot, 'node_modules/vite/bin/vite.js');
const outputRoot = resolve(repositoryRoot, '.wrangler/sync-e2e-web');
const expectedOutputRoot = resolve(repositoryRoot, '.wrangler', 'sync-e2e-web');
const enabledOutput = resolve(outputRoot, 'enabled');
const disabledOutput = resolve(outputRoot, 'disabled');

if (outputRoot !== expectedOutputRoot) {
  throw new Error('Refusing to reset an unexpected Vite output directory.');
}

mkdirSync(dirname(outputRoot), { recursive: true });
rmSync(outputRoot, { recursive: true, force: true });

const build = (outputDirectory, environment) => {
  const result = spawnSync(
    process.execPath,
    [viteEntrypoint, 'build', '--outDir', outputDirectory, '--emptyOutDir'],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...environment,
      },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Sync E2E Vite build failed.');
};

build(enabledOutput, {
  VITE_MIRNA_SYNC_ENABLED: 'true',
  VITE_MIRNA_SYNC_API_URL: 'http://localhost:8787',
  VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  VITE_MIRNA_APP_ENV: 'local-beta',
  VITE_MIRNA_BETA_ONLY: 'true',
});
build(disabledOutput, {
  VITE_MIRNA_SYNC_ENABLED: 'false',
  VITE_MIRNA_SYNC_API_URL: '',
  VITE_TURNSTILE_SITE_KEY: '',
  VITE_MIRNA_APP_ENV: '',
  VITE_MIRNA_BETA_ONLY: 'false',
});

const preview = (outputDirectory, port) =>
  spawn(
    process.execPath,
    [
      viteEntrypoint,
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--strictPort',
      '--outDir',
      outputDirectory,
    ],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit',
    },
  );

const servers = [preview(enabledOutput, '4173'), preview(disabledOutput, '4174')];
let stopping = false;

const stop = (signal = 'SIGTERM') => {
  if (stopping) return;
  stopping = true;
  for (const server of servers) {
    if (!server.killed) server.kill(signal);
  }
};

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

for (const server of servers) {
  server.once('error', (error) => {
    stop();
    throw error;
  });
  server.once('exit', (code, signal) => {
    if (!stopping && code !== 0) {
      process.exitCode = code ?? (signal ? 1 : 0);
      stop();
    }
  });
}
