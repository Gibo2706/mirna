import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { APIRequestContext, TestInfo } from '@playwright/test';

interface WorkerStatus {
  pid: number | null;
  phase: string;
  code: number | null;
  signal: string | null;
}

const workerStatus = (): WorkerStatus | null => {
  const file = resolve('.wrangler/sync-e2e-worker-status.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as WorkerStatus;
};
const processAlive = (status: WorkerStatus | null): boolean => {
  if (!status?.pid || status.phase !== 'running') return false;
  try {
    process.kill(status.pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const assertSyncWorkerAvailable = async (request: APIRequestContext): Promise<void> => {
  const status = workerStatus();
  if (!processAlive(status)) {
    throw new Error(
      `Sync E2E infrastructure failure: Worker process is not running (${status?.phase ?? 'no status'}). See sync-worker-diagnostics.json.`,
    );
  }
  try {
    const response = await request.get('http://127.0.0.1:8787/v1/health', { timeout: 2_000 });
    if (response.status() !== 200) {
      throw new Error(`Sync E2E infrastructure failure: Worker health HTTP ${response.status()}.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Sync E2E infrastructure')) throw error;
    throw new Error(
      'Sync E2E infrastructure failure: Worker health is unreachable. See sync-worker-diagnostics.json.',
    );
  }
};

export const attachSyncWorkerDiagnostics = async (testInfo: TestInfo): Promise<void> => {
  // The script emits only allowlisted health/process fields and log diagnostics.
  // No browser state, request bodies, SQL rows or raw Wrangler log is attached.
  const diagnostics = execFileSync(
    process.execPath,
    ['scripts/sync-e2e-diagnostics.mjs', '--snapshot'],
    {
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
  const path = testInfo.outputPath('sync-worker-diagnostics.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, diagnostics);
  await testInfo.attach('sync-worker-diagnostics.json', { path, contentType: 'application/json' });
};
