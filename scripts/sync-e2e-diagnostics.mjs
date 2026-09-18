import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Wrangler's debug log contains complete request/config objects. Artifacts use
// a fail-closed projection of known infrastructure diagnostics, never raw lines.
// In particular, redacting only env variable names would not protect E2EE data.
export const sanitizeWranglerLog = (raw) => {
  const diagnostics = [];
  for (const line of raw.split('\n')) {
    const timestamp = line.match(/^--- (\d{4}-\d{2}-\d{2}T[\d:.]+Z) (debug|info|warn|error)$/u);
    if (timestamp) diagnostics.push(`${timestamp[1]} ${timestamp[2]}`);
    const messages = line.match(
      /Error in ProxyController: Error inside ProxyWorker|Error inside ProxyWorker|Network connection lost\.|SQLITE_(?:BUSY|LOCKED|IOERR|CORRUPT|ERROR)|database is locked|socket hang up|ECONNRESET|ECONNREFUSED|EADDRINUSE|SIGSEGV|SIGABRT|\[ERROR\]/gu,
    );
    if (messages) diagnostics.push(...messages);
    else if (/\b(?:Error|error|cause|exception)\b/u.test(line)) {
      diagnostics.push('[unrecognized diagnostic detail redacted]');
    }
  }
  return `${diagnostics.join('\n')}\n`;
};

const publicValue = (value) =>
  typeof value === 'string' &&
  /^(?:ok|error|degraded|local|staging|missing|unavailable|fault|faulted|enabled|disabled|incomplete|mismatch|maintenance)$/u.test(
    value,
  );
const fields = (object, names) =>
  Object.fromEntries(
    names.filter((name) => publicValue(object?.[name])).map((name) => [name, object[name]]),
  );
export const safeHealthPayload = (health) => ({
  ...fields(health, ['status', 'environment']),
  ...(health?.protocolVersion === 1 ? { protocolVersion: 1 } : {}),
  services: fields(health?.services, ['d1', 'r2']),
  readiness: fields(health?.readiness, [
    'storage',
    'accountingSchema',
    'accountingState',
    'routeBudgetConformance',
    'writes',
  ]),
});

export const publishSanitizedLog = () => {
  const output = resolve('.wrangler/sync-e2e-wrangler.log');
  const privateLog = resolve('.wrangler/sync-e2e-private/wrangler.log');
  const input = existsSync(privateLog) ? privateLog : output;
  if (existsSync(input)) writeFileSync(output, sanitizeWranglerLog(readFileSync(input, 'utf8')));
};

export const monitorWorker = (worker, { saveStatus, fail, publishLog }) => {
  let stopping = false;
  let reported = false;
  const status = (phase, code = null, signal = null) => {
    saveStatus({ pid: worker.pid ?? null, phase, code, signal });
  };
  const unexpected = (code, signal) => {
    if (reported) return;
    reported = true;
    status('exited', code, signal);
    publishLog();
    fail(
      code || 1,
      `Sync E2E Worker exited unexpectedly (exit code: ${code ?? 'none'}, signal: ${signal ?? 'none'}). Sanitized log: .wrangler/sync-e2e-wrangler.log`,
    );
  };
  status('starting');
  worker.once('spawn', () => status('running'));
  worker.once('error', () => unexpected(null, null));
  worker.once('exit', (code, signal) => {
    if (!stopping) unexpected(code, signal);
    else {
      status('stopped', code, signal);
      publishLog();
    }
  });
  return (signal = 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    status('stopping');
    worker.kill(signal);
  };
};

const serviceState = async () => {
  // Inspection only, never a write-capable connection or a production database.
  const directory = resolve('.wrangler/sync-e2e-state/v3/d1/miniflare-D1DatabaseObject');
  if (!existsSync(directory)) return { available: false };
  const files = readdirSync(directory).filter(
    (name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite',
  );
  if (files.length !== 1) return { available: false };
  const { DatabaseSync } = await import('node:sqlite');
  let database;
  try {
    database = new DatabaseSync(resolve(directory, files[0]), { readOnly: true });
    database.exec('PRAGMA busy_timeout = 100');
    const flags = database
      .prepare(
        'SELECT accept_new_vaults, accept_pairings, accept_writes, maintenance_mode, accounting_fault FROM service_flags WHERE singleton_id = 1',
      )
      .get();
    const counts = database
      .prepare("SELECT COUNT(*) AS reserved FROM usage_reservations WHERE state = 'reserved'")
      .get();
    return {
      available: true,
      flags: Object.fromEntries(
        Object.entries(flags ?? {}).filter(([, value]) => value === 0 || value === 1),
      ),
      reserved: typeof counts?.reserved === 'number' ? counts.reserved : null,
    };
  } catch {
    return { available: false };
  } finally {
    database?.close();
  }
};

export const snapshotDiagnostics = async () => {
  publishSanitizedLog();
  const statusPath = resolve('.wrangler/sync-e2e-worker-status.json');
  const status = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, 'utf8')) : null;
  let alive = false;
  if (Number.isInteger(status?.pid) && status?.phase === 'running') {
    try {
      process.kill(status.pid, 0);
      alive = true;
    } catch {
      /* Process exited. */
    }
  }
  let health = { reachable: false };
  try {
    const response = await fetch('http://127.0.0.1:8787/v1/health', {
      signal: AbortSignal.timeout(2_000),
    });
    health = {
      reachable: true,
      httpStatus: response.status,
      payload: safeHealthPayload(await response.json()),
    };
  } catch {
    /* Unreachable/invalid health is reported without dumping the response. */
  }
  const log = resolve('.wrangler/sync-e2e-wrangler.log');
  return {
    process: {
      alive,
      pid: status?.pid ?? null,
      phase: status?.phase ?? 'unknown',
      code: status?.code ?? null,
      signal: status?.signal ?? null,
    },
    health,
    serviceState: await serviceState(),
    logTail: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').slice(-100) : [],
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--snapshot'))
    process.stdout.write(`${JSON.stringify(await snapshotDiagnostics(), null, 2)}\n`);
  else publishSanitizedLog();
}
