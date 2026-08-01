import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const SUPPORT_ID = /^MIRNA-(?:[0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/u;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SINCE = /^(\d{1,3})(m|h|d)$/u;
const MAX_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1_000;

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith('--') || value === undefined) {
    throw new Error('Upotreba: npm run sync:logs -- --support <ID> [--since 2h]');
  }
  options.set(key, value);
}

const supportId = options.get('--support');
const requestId = options.get('--request');
if ((supportId ? 1 : 0) + (requestId ? 1 : 0) !== 1) {
  throw new Error('Navedite tačno jedan --support ili --request identifikator.');
}
if (supportId && !SUPPORT_ID.test(supportId)) throw new Error('Support ID nije ispravan.');
if (requestId && !REQUEST_ID.test(requestId)) throw new Error('Request ID nije ispravan.');

const since = options.get('--since') ?? '2h';
const parsedSince = SINCE.exec(since);
if (!parsedSince) throw new Error('--since mora biti, na primer, 30m, 2h ili 7d.');
const amount = Number(parsedSince[1]);
const unit = parsedSince[2];
const multiplier = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
const lookbackMs = amount * multiplier;
if (!Number.isSafeInteger(lookbackMs) || lookbackMs < 60_000 || lookbackMs > MAX_LOOKBACK_MS) {
  throw new Error('--since mora biti između 1 minuta i 14 dana.');
}

const createdAfter = Date.now() - lookbackMs;
const predicate = supportId
  ? `hex(support_ref) = '${createHash('sha256')
      .update(`MIRNA-BETA-DIAGNOSTICS-V1/support\0${supportId}`)
      .digest('hex')
      .toUpperCase()}'`
  : `request_id = '${requestId}'`;
const command = `SELECT created_at, event_type, severity, request_id, technical_code, route_action, worker_build, safe_details_json
FROM beta_diagnostic_events
WHERE ${predicate} AND created_at >= ${createdAfter}
ORDER BY created_at DESC
LIMIT 200`;

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'wrangler',
    'd1',
    'execute',
    'mirna-sync-staging-eu',
    '--remote',
    '--env',
    'staging',
    '--config',
    'services/sync-worker/wrangler.jsonc',
    '--command',
    command,
    '--json',
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr || 'D1 upit nije uspeo.\n');
  process.exit(result.status ?? 1);
}
process.stdout.write(result.stdout);
