# Mirna Encrypted Sync — Beta/Staging Operations

Status: experimental `2.4.0-beta.1`, protocol version 1

Authorized Worker: `mirna-sync-staging`

Authorized application: <https://mirna-finansije-beta.vercel.app>
Stable production: out of scope and unchanged

This runbook defines the operational procedure for the dedicated beta. It must
not contain Cloudflare account identifiers, credentials, Turnstile secrets,
Vercel tokens or finance plaintext. The checked-in D1 resource identifier is a
binding identifier, not a decryption secret; it is still omitted from reports.

## Fixed architecture and trust boundary

```text
Mirna beta PWA
  -> exact-origin HTTPS
mirna-sync-staging Worker
  -> EU-jurisdiction D1 metadata and ciphertext operations
  -> private EU-jurisdiction R2 Standard snapshot ciphertext
```

The Worker never receives a vault master key, recovery wrapping key, private
device key or readable finance payload. Cloudflare can see ordinary request
metadata and can deny, delay or delete ciphertext. EU jurisdiction constrains
D1/R2 according to each product's guarantee; it does not make globally executed
Worker requests EU-only. No regional execution product is configured.

There is no production Worker environment, public R2 URL, Durable Object,
Queue, paid observability or server-side encryption master key in this design.

Staging CORS allows exactly the beta origin plus explicit local development at
`http://localhost:5173` and `http://127.0.0.1:5173`. It never reflects an
arbitrary origin and does not allow the stable production application.

## Source-controlled staging safety caps

The authoritative values live in
`services/sync-worker/src/config/staging-budgets.ts`. Environment variables,
headers, query strings, client JSON and D1 values cannot raise them.

| Global boundary           | Rolling 30 days | UTC day   | Current resource |
| ------------------------- | --------------- | --------- | ---------------- |
| Worker requests           | 1,500,000       | 50,000    | —                |
| D1 rows read              | 25,000,000      | 2,000,000 | —                |
| D1 rows written           | 500,000         | 40,000    | —                |
| R2 Class A                | 400,000         | 20,000    | —                |
| R2 Class B                | 4,000,000       | 200,000   | —                |
| R2 Standard ciphertext    | —               | —         | 4 GiB            |
| R2 objects                | —               | —         | 100,000          |
| D1 application storage    | —               | —         | 256 MiB          |
| Active non-deleted vaults | —               | —         | 50               |

Per vault: 25,000 Worker requests, 250,000 D1 reads, 25,000 D1 writes,
1,000 R2 Class A, 10,000 R2 Class B, 64 MiB and 2,000 R2 objects per rolling
window/current inventory as applicable. Existing security caps remain ten
devices, three active pairings, 8 MiB snapshots, 64 KiB operations and 100
operations per batch. A vault pauses at 100 unresolved local conflicts or 5,000
uncompacted encrypted operations.

Every HTTP request first reserves a conservative ledger-overhead vector. The
route then reserves its maximum D1/R2 vector before application work. D1 batch
conditions make concurrent cap checks and counter increments atomic. D1 result
metadata is aggregated across the route for rows read, rows written and current
database size. Successful and failed routes commit observed units and release
the unused reservation atomically. If metadata is missing, a route crashes, or
observed work exceeds its reviewed maximum, accounting stays conservative and
the full reservation remains charged; an exceeded maximum also engages the
maintenance kill switch. The ledger's own D1 cost is included in the first
reservation and is not recursively metered. Scheduled cleanup uses the same
reserve/measure/reconcile path, including every R2 ListObjects call.

R2 classification is explicit and tested: Put/List/Copy are Class A; Get/Head
are Class B; Delete is currently provider-free but its Worker/D1 work remains
metered. Temporary objects enter the D1 inventory before Put, are committed only
after the existing snapshot CAS succeeds, and remain conservatively charged if
deletion cannot be confirmed.

Budget errors are intentionally generic:

- `VAULT_QUOTA_EXCEEDED` / HTTP 429;
- `SERVICE_BUDGET_EXHAUSTED` / HTTP 503.

The client preserves local data/outbox work, shows a calm Serbian pause message
and applies a six-hour jittered automatic backoff. Manual local use and JSON
backup remain available.

## D1 operator kill switches

There is no public administration endpoint. Only an authenticated D1 operator
may update the singleton row:

```sql
UPDATE service_flags
SET accept_new_vaults = 0,
    accept_pairings = 0,
    accept_writes = 0,
    maintenance_mode = 1,
    updated_at = unixepoch('subsec') * 1000
WHERE singleton_id = 1;
```

Normal beta defaults are `accept_new_vaults=1`, `accept_pairings=1`,
`accept_writes=1`, `maintenance_mode=0`. Reads needed for recovery/export may
remain available while writes are paused. The health route exposes only the
derived `writesEnabled` boolean, never counter values or flags individually.

## Turnstile boundary

The dedicated managed widget is named `Mirna Sync Beta` and is restricted to:

```text
mirna-finansije-beta.vercel.app
localhost
127.0.0.1
```

The SPA loads the exact `challenges.cloudflare.com` script only when an
anonymous create flow requests a token. Explicit-render widgets are removed
after success, error, expiry or timeout so the next attempt receives a fresh
single-use token. Protected routes/actions are:

| Route                         | Expected action        |
| ----------------------------- | ---------------------- |
| `POST /v1/vaults`             | `mirna_vault_create`   |
| `POST /v1/pairings`           | `mirna_pairing_create` |
| `POST /v1/recovery/challenge` | `mirna_recovery_init`  |

The Worker posts the token to Siteverify and checks success, exact hostname and
exact action. Turnstile is defense in depth; edge rate limits, D1 attempt
counters, signatures, sessions and idempotency remain authoritative. Token,
secret and visitor IP values are never logged or stored.

The public site key is `VITE_TURNSTILE_SITE_KEY`. The secret is set only through
the Cloudflare secret store as `TURNSTILE_SECRET_KEY`. Automated local tests use
Cloudflare's documented always-pass test keys; real staging material never
enters `.env`, `.dev.vars`, test fixtures or Git.

## Local gate

Use Node 22 only for the current shell and pinned Wrangler `4.118.0`:

```sh
nvm use 22
npm ci
npm run sync:migrations:local
npm run check
npm run test:coverage
npm run test:e2e
npm run sync:test:e2e
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
```

Before remote work, also run:

```sh
npm run sync:types
npx wrangler deploy --dry-run --env staging \
  --config services/sync-worker/wrangler.jsonc
```

Fresh migrated Worker tests must cover concurrent reservation, daily/rolling
exhaustion, per-vault isolation, inventory release/orphan behavior, kill switch,
external budget override attempts and Turnstile hostname/action mismatch.

## Cloudflare staging procedure

Always list resources first and reuse only an exact verified match. The only
authorized names are:

```text
Worker:          mirna-sync-staging
D1:              mirna-sync-staging-eu
R2 Standard:     mirna-sync-staging-eu
Turnstile widget: Mirna Sync Beta
```

Creation commands, when the account has already activated D1/R2 and no checkout
or paid-plan acceptance appears:

```sh
npx wrangler d1 create mirna-sync-staging-eu --jurisdiction eu
npx wrangler r2 bucket create mirna-sync-staging-eu \
  --jurisdiction eu --storage-class Standard
```

Never combine a jurisdiction with a location hint. Do not enable R2
InfrequentAccess, `r2.dev`, a custom bucket domain or lifecycle rules.

After reviewing the binding diff and regenerating types:

```sh
npx wrangler d1 migrations list mirna-sync-staging-eu --remote \
  --env staging --config services/sync-worker/wrangler.jsonc
npx wrangler d1 migrations apply mirna-sync-staging-eu --remote \
  --env staging --config services/sync-worker/wrangler.jsonc
npx wrangler deploy --env staging \
  --config services/sync-worker/wrangler.jsonc
```

Set/rotate the real Turnstile secret without putting it in a command argument,
tracked file or report. Verify the secret binding only by name. Never print its
value.

## Dedicated Vercel beta project

The only authorized project and alias are:

```text
project: mirna-finansije-beta
alias:   https://mirna-finansije-beta.vercel.app
branch:  feat/e2ee-sync
```

Verify `.vercel/project.json` privately before using the CLI. If it names any
other project, use an isolated temporary working copy or relink only after
confirming the dedicated beta project. Never alter the stable project.

The beta Production environment contains only:

```text
VITE_MIRNA_SYNC_ENABLED=true
VITE_MIRNA_SYNC_API_URL=<exact staging workers.dev origin>
VITE_TURNSTILE_SITE_KEY=<public beta site key>
VITE_MIRNA_APP_ENV=beta
VITE_MIRNA_BETA_ONLY=true
```

Every env change requires a new beta deployment. The build must contain the
visible `Mirna Sync — Beta` marker, `noindex, nofollow`, a `robots.txt` that
disallows all crawlers and a CSP that permits only the exact Turnstile origin
for script/frame/connect plus the exact staging Worker origin for connect. The
stable project receives none of these variables.

## Remote smoke and plaintext sentinel gate

Use unique synthetic data labelled:

```text
Synthetic beta test data. Not based on a real person's financial records.
```

At low volume verify beta load/marker/noindex, health and strict CORS, the three
Turnstile-protected anonymous entry points, device auth, create/upload/download,
operation sync, pairing, recovery, conflict convergence, revocation/rotation,
offline continuity and deletion. Remove disposable test vaults through the
authenticated protocol when they are no longer needed.

Search for unique synthetic finance sentinels in remote D1 values, downloaded
R2 object bytes, API JSON and safe Worker logs. Identifiers, timestamps, public
keys, signatures and ciphertext are expected; readable finance sentinels are
not. Never use real personal records for staging.

Low-volume real-staging quota verification may inspect only aggregate D1
counters, aggregate R2 count/bytes, migration state and service flags. Do not
expose a public usage endpoint or attempt to exhaust real provider allowances.

## Rollback and incident response

Pause writes with service flags before investigating an integrity, plaintext or
cost incident. Worker rollback is safe only to a protocol/schema-compatible
version; migrations are forward-only. Do not drop the database, empty the
bucket, recreate resources or force-push as a first response.

If plaintext or a real secret appears server-side: pause the beta clients,
rotate/invalidate affected credentials, preserve only non-sensitive diagnostic
metadata, repair forward, rerun the plaintext gate and deploy a reviewed build.

Primary current references:

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)
- [Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Turnstile explicit rendering](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
