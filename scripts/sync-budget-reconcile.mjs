import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  ACCOUNTING_SNAPSHOT_SQL,
  planReconciliation,
  reconstructAccounting,
  safeAccountingSummary,
} from './sync-budget-reconcile-lib.mjs';
import { parseCloudflareCount, parseCloudflareBucketBytes } from './sync-staging-contract.mjs';
import { fetchWorkerHealthSnapshot } from './sync-staging-verify-lib.mjs';
import {
  API_ROUTE_REGISTRY,
  ROUTE_BUDGET_REGISTRY_VERSION,
} from '../services/sync-worker/src/route-registry.ts';

const DATABASE = 'mirna-sync-staging-eu';
const BUCKET = 'mirna-sync-staging-eu';
const CONFIG = 'services/sync-worker/wrangler.jsonc';
const WORKER_URL = 'https://mirna-sync-staging.bogdan-markovic2706.workers.dev/v1/health';
const ORIGIN = 'https://mirna-finansije.vercel.app';

export function parseReconcileOptions(args) {
  const options = { apply: false, verify: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env' && args[++i] === 'staging') options.staging = true;
    else if (args[i] === '--apply') options.apply = true;
    else if (args[i] === '--verify') options.verify = true;
    else throw new Error('Only --env staging [--apply | --verify] is supported.');
  }
  if (!options.staging || (options.apply && options.verify))
    throw new Error('Explicit --env staging is required; --verify is read-only.');
  return options;
}

async function main() {
  const options = parseReconcileOptions(process.argv.slice(2));
  const evidence = `.private/sync-accounting-incident/${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  if (spawnSync('git', ['check-ignore', '--quiet', evidence]).status !== 0)
    throw new Error('Evidence directory must be git-ignored.');
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const save = (name, value) =>
    writeFileSync(
      `${evidence}/${name}`,
      typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
      { mode: 0o600 },
    );
  const wrangler = (args, { binary = false } = {}) => {
    const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
      encoding: binary ? undefined : 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: 'false',
        WRANGLER_LOG_PATH: `${process.cwd()}/${evidence}/wrangler.log`,
      },
    });
    if (result.status !== 0 || result.error) {
      save('wrangler-error.log', String(result.stderr ?? 'Cloudflare command failed'));
      throw new Error('Cloudflare staging command failed; see private evidence.');
    }
    return binary ? result.stdout : JSON.parse(result.stdout);
  };
  const query = (sql) =>
    wrangler([
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
  const readSnapshot = () => {
    const result = query(ACCOUNTING_SNAPSHOT_SQL);
    if (
      !Array.isArray(result) ||
      result.length !== 1 ||
      !result[0].success ||
      result[0].results?.length !== 1
    )
      throw new Error('Invalid accounting snapshot.');
    return JSON.parse(result[0].results[0].snapshot);
  };
  const before = readSnapshot();
  save('before.json', before);
  const healthBefore = await fetchWorkerHealthSnapshot({
    workerUrl: WORKER_URL,
    productionOrigin: ORIGIN,
  });
  save('health-before.json', healthBefore);
  const info = wrangler(['d1', 'info', DATABASE, '--env', 'staging', '--config', CONFIG, '--json']);
  save('d1-info.json', info);
  const marker = JSON.parse(
    readFileSync('services/sync-worker/route-budget-conformance.json', 'utf8'),
  );
  const health = healthBefore.health;
  if (!health) throw new Error('Worker health is unavailable; repair is refused.');
  let storageVerified = health.services?.d1 === 'ok' && health.services?.r2 === 'ok';
  const checkedObjects = [];
  const readObject = (objectKey) =>
    wrangler(
      [
        'r2',
        'object',
        'get',
        `${BUCKET}/${objectKey}`,
        '--remote',
        '--jurisdiction',
        'eu',
        '--pipe',
      ],
      { binary: true },
    );
  if (options.apply) {
    // Use actual object reads and provider bucket counts; never change R2 or infer bytes from reservations.
    // Bounded operator check: large inventories must use the existing cursor-based reconciliation.
    if (before.inventory.length > 100)
      throw new Error('Use bounded inventory reconciliation before this repair.');
    const bucketPayload = wrangler([
      'r2',
      'bucket',
      'info',
      BUCKET,
      '--jurisdiction',
      'eu',
      '--json',
    ]);
    save('r2-info.json', bucketPayload);
    const bucket = bucketPayload.result ?? bucketPayload;
    const count = parseCloudflareCount(
      bucket.object_count ?? bucket.objectCount,
      'R2 object count',
    );
    const size = parseCloudflareBucketBytes(bucket.bucket_size ?? bucket.bucketSize ?? bucket.size);
    storageVerified &&= count === before.inventory.length;
    for (const object of before.inventory) {
      const bytes = readObject(object.object_key);
      storageVerified &&= bytes.length === object.ciphertext_bytes;
      checkedObjects.push({
        objectKey: object.object_key,
        expectedBytes: object.ciphertext_bytes,
        actualBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    save('r2-verified.json', { count, size, checked: checkedObjects, verified: storageVerified });
  }
  const now = Date.now();
  const readiness = {
    schema: health.readiness?.accountingSchema === 'ok',
    registry:
      health.readiness?.routeBudgetConformance === 'ok' &&
      health.readiness?.routeBudgetRegistryVersion === marker.registryVersion &&
      marker.status === 'registry-complete' &&
      marker.registryVersion === ROUTE_BUDGET_REGISTRY_VERSION &&
      marker.routeCount === API_ROUTE_REGISTRY.length &&
      marker.suite === 'npm run sync:route-budget:verify' &&
      marker.coverage === 'complete-worker-runtime-suite-with-source-derived-bounds',
    storage: storageVerified,
    providerD1Bytes: info.database_size,
  };
  const plan = planReconciliation(before, now, readiness);
  save('plan.json', { now, readiness, ...plan });
  process.stdout.write(
    JSON.stringify(
      {
        mode: options.apply ? 'apply' : options.verify ? 'verify' : 'dry-run',
        ...safeAccountingSummary(before, plan.accounting),
        driftEntries: plan.accounting.drift.length,
        proposedRepairs: plan.repairs.map((r) => r.code),
        blockers: plan.blockers,
        globalHeadroom: plan.accounting.headroom.filter((x) => x.scope_type === 'global'),
        evidence,
      },
      null,
      2,
    ) + '\n',
  );
  if (options.verify) {
    if (
      plan.blockers.length ||
      plan.accounting.drift.length ||
      plan.accounting.errors.length ||
      before.reservations.some(
        (r) =>
          r.state === 'reserved' ||
          (r.settlement_failure_code !== null && r.reconciled_at === null),
      ) ||
      before.flags[0]?.accounting_fault !== 0
    )
      process.exitCode = 1;
    return;
  }
  if (!options.apply) return;
  if (plan.blockers.length) throw new Error('Repair refused: ' + plan.blockers.join(', '));
  if (!plan.statements.length) {
    process.stdout.write('Already reconciled; no changes.\n');
    return;
  }
  const sql = plan.statements.join(';\n') + ';';
  if (Buffer.byteLength(sql) > 90000)
    throw new Error('Repair batch exceeds the bounded D1 query size.');
  save('repair.sql', sql);
  // REST query executes semicolon-separated statements as one D1 batch/transaction.
  // The first CHECK guard aborts on concurrent changes; any later failure rolls everything back.
  const result = query(sql);
  save('apply-result.json', result);
  if (result.length !== plan.statements.length || result.some((r) => !r.success))
    throw new Error('Repair batch result is incomplete.');
  const after = readSnapshot();
  save('after.json', after);
  const accounting = reconstructAccounting(after, Date.now());
  save('after-accounting.json', accounting);
  const postPlan = planReconciliation(after, Date.now(), readiness);
  if (
    postPlan.blockers.length ||
    postPlan.statements.length ||
    accounting.drift.length ||
    after.flags[0]?.accounting_fault !== 0 ||
    after.reservations.length !== before.reservations.length ||
    ['vaults', 'devices', 'snapshots', 'sync_changes', 'pairing_requests'].some(
      (k) => after.counts[0][k] !== before.counts[0][k],
    )
  ) {
    throw new Error(
      'Postconditions changed or failed; inspect private evidence before any further action.',
    );
  }
  for (const object of checkedObjects) {
    if (createHash('sha256').update(readObject(object.objectKey)).digest('hex') !== object.sha256)
      throw new Error('R2 object changed during repair; inspect private evidence.');
  }
  save('r2-preserved.json', { objects: checkedObjects.length, unchanged: true });
  save(
    'health-after.json',
    await fetchWorkerHealthSnapshot({ workerUrl: WORKER_URL, productionOrigin: ORIGIN }),
  );
  process.stdout.write(
    'Accounting repair committed; equality, invariants and preserved business counts verified.\n',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
}
