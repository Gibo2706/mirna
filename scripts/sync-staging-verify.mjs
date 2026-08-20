import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import {
  parseCloudflareBucketBytes,
  parseCloudflareCount,
  verifyStagingSnapshot,
} from './sync-staging-contract.mjs';

const DATABASE = 'mirna-sync-staging-eu';
const BUCKET = 'mirna-sync-staging-eu';
const WORKER_URL = 'https://mirna-sync-staging.bogdan-markovic2706.workers.dev/v1/health';
const PRODUCTION_ORIGIN = 'https://mirna-finansije.vercel.app';
const CONFIG = 'services/sync-worker/wrangler.jsonc';
const BUILD = /^[0-9a-f]{7,64}$/u;
const conformanceArtifact = JSON.parse(
  readFileSync('services/sync-worker/route-budget-conformance.json', 'utf8'),
);
const registrySource = readFileSync('services/sync-worker/src/route-registry.ts', 'utf8');
if (
  conformanceArtifact.status !== 'registry-complete' ||
  conformanceArtifact.routeCount !== 27 ||
  conformanceArtifact.suite !== 'npm run sync:route-budget:verify' ||
  conformanceArtifact.coverage !== 'complete-worker-runtime-suite-with-source-derived-bounds' ||
  !registrySource.includes(
    `ROUTE_BUDGET_REGISTRY_VERSION = '${conformanceArtifact.registryVersion}'`,
  )
) {
  throw new Error('Lokalni route-budget conformance marker nije potpun ili usklađen.');
}

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith('--') || value === undefined) {
    throw new Error('Upotreba: npm run sync:staging:verify -- --expected-build <commit>');
  }
  options.set(key, value);
}
const expectedBuild = options.get('--expected-build');
if (!expectedBuild || !BUILD.test(expectedBuild)) {
  throw new Error('--expected-build mora biti tačan javni build identifikator.');
}

const runWrangler = (args) => {
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', ...args],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) throw new Error('Cloudflare read-only provera nije uspela.');
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('Cloudflare read-only provera nije vratila očekivani JSON.');
  }
};

const sql = `
SELECT name FROM mirna_d1_migrations ORDER BY id;
PRAGMA table_info(usage_reservations);
PRAGMA table_info(service_flags);
PRAGMA table_info(usage_daily_buckets);
PRAGMA table_info(usage_rolling_totals);
PRAGMA table_info(resource_totals);
PRAGMA table_info(pairing_request_totals);
PRAGMA index_list(usage_reservations);
PRAGMA index_info(idx_usage_reservations_failure);
SELECT COUNT(*) AS row_count, MIN(accept_new_vaults) AS accept_new_vaults,
       MIN(accept_pairings) AS accept_pairings, MIN(accept_writes) AS accept_writes,
       MIN(maintenance_mode) AS maintenance_mode, MIN(accounting_fault) AS accounting_fault,
       MIN(state_reason) AS state_reason
  FROM service_flags WHERE singleton_id = 1;
SELECT COUNT(*) AS row_count, MIN(r2_stored_bytes) AS r2_stored_bytes,
       MIN(r2_object_count) AS r2_object_count, MIN(d1_storage_bytes) AS d1_storage_bytes
  FROM resource_totals WHERE singleton_id = 1;
SELECT COUNT(*) AS row_count, MIN(total_count) AS total_count,
       (SELECT COUNT(*) FROM pairing_requests) AS actual_count
  FROM pairing_request_totals WHERE singleton_id = 1;
SELECT COUNT(*) AS row_count, MIN(worker_requests) AS worker_requests,
       MIN(d1_rows_read) AS d1_rows_read, MIN(d1_rows_written) AS d1_rows_written,
       MIN(r2_class_a) AS r2_class_a, MIN(r2_class_b) AS r2_class_b
  FROM usage_rolling_totals WHERE scope_type = 'global' AND scope_id = 'service';
SELECT COUNT(*) AS row_count, MIN(worker_requests) AS worker_requests,
       MIN(d1_rows_read) AS d1_rows_read, MIN(d1_rows_written) AS d1_rows_written,
       MIN(r2_class_a) AS r2_class_a, MIN(r2_class_b) AS r2_class_b
  FROM usage_daily_buckets
 WHERE scope_type = 'global' AND scope_id = 'service' AND utc_day = date('now');
SELECT SUM(CASE WHEN state = 'reserved' THEN 1 ELSE 0 END) AS reserved_count,
       SUM(CASE WHEN settlement_failure_code IS NOT NULL AND reconciled_at IS NULL THEN 1 ELSE 0 END)
         AS unreconciled_failure_count
  FROM usage_reservations;`;

const d1Payload = runWrangler([
  'd1',
  'execute',
  DATABASE,
  '--remote',
  '--env',
  'staging',
  '--config',
  CONFIG,
  '--command',
  sql,
  '--json',
]);
const resultSets = (Array.isArray(d1Payload) ? d1Payload : [d1Payload]).map(
  (entry) => entry.results ?? entry.result?.results ?? [],
);
if (resultSets.length !== 15) throw new Error('D1 verifier nije dobio očekivane rezultate.');

const columns = (index) => resultSets[index].map(({ name }) => name);
const first = (index) => resultSets[index][0] ?? null;
const r2Payload = runWrangler(['r2', 'bucket', 'info', BUCKET, '--jurisdiction', 'eu', '--json']);
const r2 = r2Payload.result ?? r2Payload;
const objectCount = parseCloudflareCount(r2.object_count ?? r2.objectCount, 'R2 object count');
const parsedBucketSize = parseCloudflareBucketBytes(r2.bucket_size ?? r2.bucketSize ?? r2.size);
const bucketBytes = parsedBucketSize.bytes;

let health;
let healthHttpStatus;
try {
  const response = await fetch(WORKER_URL, {
    headers: { 'X-Mirna-Protocol-Version': '1' },
    cache: 'no-store',
    redirect: 'error',
  });
  healthHttpStatus = response.status;
  health = await response.json();
} catch {
  throw new Error('Worker health provera nije uspela.');
}

try {
  const response = await fetch(WORKER_URL, {
    headers: {
      Origin: PRODUCTION_ORIGIN,
      'X-Mirna-Protocol-Version': '1',
    },
    cache: 'no-store',
    redirect: 'error',
  });
  if (
    response.status !== 200 ||
    response.headers.get('Access-Control-Allow-Origin') !== PRODUCTION_ORIGIN
  ) {
    throw new Error('invalid production health CORS');
  }
  await response.body?.cancel();

  const preflight = await fetch(WORKER_URL, {
    method: 'OPTIONS',
    headers: {
      Origin: PRODUCTION_ORIGIN,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'x-mirna-protocol-version,x-mirna-support-id',
    },
    cache: 'no-store',
    redirect: 'error',
  });
  const allowedHeaders = preflight.headers.get('Access-Control-Allow-Headers') ?? '';
  if (
    preflight.status !== 204 ||
    preflight.headers.get('Access-Control-Allow-Origin') !== PRODUCTION_ORIGIN ||
    !allowedHeaders.includes('x-mirna-protocol-version') ||
    !allowedHeaders.includes('x-mirna-support-id')
  ) {
    throw new Error('invalid production preflight CORS');
  }
  await preflight.body?.cancel();
} catch {
  throw new Error('Produkcioni Vercel origin nije ispravno dozvoljen na Worker-u.');
}

const expectedMigrations = readdirSync('services/sync-worker/migrations')
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
  .sort();
const snapshot = {
  migrations: resultSets[0].map(({ name }) => name),
  columns: {
    usage_reservations: columns(1),
    service_flags: columns(2),
    usage_daily_buckets: columns(3),
    usage_rolling_totals: columns(4),
    resource_totals: columns(5),
    pairing_request_totals: columns(6),
  },
  indexes: resultSets[7].map(({ name }) => name),
  failureIndexColumns: resultSets[8].map(({ name }) => name),
  flags: first(9),
  resources: first(10),
  pairingTotals: first(11),
  rolling: first(12),
  daily: first(13),
  unresolved: first(14),
  r2: { readable: true, objectCount, bytes: bucketBytes, exactBytes: parsedBucketSize.exact },
  health,
  healthHttpStatus,
};
const verification = verifyStagingSnapshot(
  snapshot,
  expectedMigrations,
  expectedBuild,
  conformanceArtifact.registryVersion,
);
if (!verification.ok) {
  process.stderr.write(
    `Staging readiness nije prošao:\n${verification.errors.map((error) => `- ${error}`).join('\n')}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify(
    {
      status: 'ok',
      migrations: expectedMigrations.length,
      accountingSchema: 'ok',
      accountingState: 'ok',
      unresolvedReservations: 0,
      d1StorageBytes: snapshot.resources.d1_storage_bytes,
      r2Objects: objectCount,
      r2Bytes: bucketBytes,
      workerBuild: health.buildCommit,
      productionOrigin: PRODUCTION_ORIGIN,
      routeBudgetConformance: health.readiness.routeBudgetConformance,
      routeBudgetRegistryVersion: health.readiness.routeBudgetRegistryVersion,
    },
    null,
    2,
  )}\n`,
);
