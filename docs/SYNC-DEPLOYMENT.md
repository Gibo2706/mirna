# Mirna Encrypted Sync — Staging Deployment

Status: safe runbook for experimental `2.4.0-beta.1`, protocol version 1
Authorized target: Cloudflare staging only
Current remote status: provisioning stopped before writes because R2 activation
requires a billing step; no resource or deployment is asserted
Production status: not authorized and not configured

## Non-negotiable stop conditions

Stop before accepting or enabling anything if Cloudflare asks for:

- a payment method;
- R2 billing or subscription activation;
- a Workers Paid or other paid plan;
- paid overage;
- a paid rate-limiting, observability or regional product;
- resource creation in an account whose plan/ownership has not been verified.

Do not click through, accept a checkout, attach billing or continue with a
different paid product. Record only the generic blocker; do not copy account
email, account ID, database ID, bucket credentials, OAuth material or tokens
into an issue or deployment report.

R2 has a documented monthly free allowance, but usage beyond it is billed and
initial R2 activation may require a billing step. It is not a hard-free safety
boundary. If that activation appears, the R2 provisioning step remains blocked
until a separate explicit decision.

That stop condition was reached on 2026-07-31 while inspecting the authorized
account: D1 had no existing database and R2 returned its subscription-required
response. No D1 database, R2 bucket or Worker deployment was created, and no
billing action was accepted.

## Deployment state and configuration

The checked-in configuration is:

```text
services/sync-worker/wrangler.jsonc
```

It defines only:

- local Miniflare bindings with deliberately non-deployable labels;
- one `staging` Worker environment;
- placeholder staging D1 and R2 bindings;
- disabled Worker observability;
- a five-minute bounded cleanup trigger.

There is no production environment. Do not add one as part of staging work.
The placeholder values are intentionally fail-closed:

```text
REPLACE_WITH_STAGING_D1_UUID_DO_NOT_DEPLOY
replace-with-staging-r2-bucket-do-not-deploy
replace-at-deploy
```

A non-dry deployment MUST NOT run while any of those placeholders remains.
Automatic resource provisioning must stay disabled for reviewed development,
migration and deployment commands.

## Current platform assumptions

These values were checked against Cloudflare documentation on 2026-07-31. They
can change and MUST be rechecked immediately before remote provisioning.

| Product     | Documented Free-plan boundary relevant to staging                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers     | 100,000 requests/day; 10 ms CPU per HTTP/Cron invocation; 128 MB memory; 50 subrequests; six simultaneous outbound connections; 100 MB Free-plan request body limit |
| D1          | 5 million rows read/day; 100,000 rows written/day; ten databases; 500 MB/database; 5 GB/account; 50 queries/Free Worker invocation; 2 MB maximum row/BLOB/string    |
| R2 Standard | 10 GB-month storage, one million Class A and ten million Class B operations per month included; usage-priced beyond the allowance                                   |

D1 Free read/write/storage exhaustion returns errors rather than silently
charging. R2 does not provide the same hard-failure cost boundary. The Mirna
application limits of 8 MiB per encrypted snapshot, 64 KiB per encrypted
operation and bounded retention are required regardless of the platform's
larger limits.

Primary references:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/)
- [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)

## Data-location statement

Create both staging storage resources with the immutable `eu` jurisdiction at
creation. For D1, Cloudflare documents that the database runs and persists
inside that jurisdiction. For R2, objects are stored and processed inside the
selected jurisdiction. The jurisdiction cannot be added or changed later.

This does not make Worker request processing EU-only. A globally deployed
Worker may receive and process HTTP requests at other Cloudflare edge locations
and then access EU-bound storage. Do not claim full EU-only request processing
without separately configured and verified regional services.

## Prerequisites

Run from the repository root with Node 22 selected only for the current shell:

```sh
nvm use 22
node --version
npx wrangler --version --config services/sync-worker/wrangler.jsonc
```

The intended pinned CLI version for this branch is `4.118.0`. Do not install a
global Wrangler. Never place a Cloudflare API token, OAuth credential or secret
in a command, tracked file or shell transcript.

Before any remote action, all phase gates needed by the routes being deployed
and the complete local quality gate must pass. At minimum, the Worker itself
must pass:

```sh
npx tsc --project services/sync-worker/tsconfig.json --pretty false
npx vitest run --config services/sync-worker/vitest.config.ts
npx wrangler deploy --dry-run --env staging --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false
```

A dry run compiles only. It does not prove D1/R2 behavior or authorize a later
deployment. The invalid placeholders should remain during the initial
compile-only review.

## Local storage verification

Use local Miniflare D1/R2 only. Every Wrangler command names the configuration
explicitly and disables automatic provisioning:

```sh
npx wrangler d1 migrations list MIRNA_SYNC_DB --local --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false
npx wrangler d1 migrations apply MIRNA_SYNC_DB --local --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false
npx wrangler dev --local --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false
```

Local tests must use synthetic finance sentinels only. Inspect local D1 rows,
R2 objects, API payloads and available test logs to confirm that known
plaintext finance strings do not appear. This regression check is necessary but
does not prove perfect secrecy.

## Authentication and private account check

Authenticate interactively only after local gates pass:

```sh
npx wrangler login --config services/sync-worker/wrangler.jsonc
npx wrangler whoami --config services/sync-worker/wrangler.jsonc
```

Inspect the result privately. Confirm the intended account and current plan,
then close or clear any captured terminal view before sharing a report. Do not
paste identity output anywhere.

Confirm in current official documentation and the account dashboard:

1. Workers remains on the allowed Free plan.
2. D1 creation does not require an upgrade and there is capacity for another
   Free database.
3. R2 Standard is already available without accepting billing activation, or
   stop before activating it.
4. No paid overage or subscription has been enabled.
5. Rate-limiting bindings and optional Turnstile do not introduce a paid
   dependency. Neither is required for normal background sync authorization.

Do not treat a rate limiter as exact attempt state. Pairing and recovery limits
must remain authoritative in D1. Turnstile, if evaluated later, is restricted
to anonymous setup/recovery screens and needs a separate privacy/CSP review.

## Check for existing staging resources

Do not create a duplicate resource. Inspect the intended account privately:

```sh
npx wrangler d1 list --config services/sync-worker/wrangler.jsonc
npx wrangler r2 bucket list --config services/sync-worker/wrangler.jsonc
```

If the R2 list action redirects to or requests billing activation, stop there.
Do not activate R2 merely to inspect it. If an EU-jurisdiction resource with the
intended staging name already exists, verify its jurisdiction and ownership
before deciding whether it can be reused. Jurisdiction cannot be corrected
after creation.

The expected names are placeholders for this staging design only:

```text
Worker: mirna-sync-staging
D1:     mirna-sync-staging-eu
R2:     mirna-sync-staging-eu
```

## Provision D1 staging

After the account and no-payment checks pass, create D1 explicitly with the EU
jurisdiction:

```sh
npx wrangler d1 create mirna-sync-staging-eu --jurisdiction=eu --config services/sync-worker/wrangler.jsonc
```

This is an intentional remote write. Do not use `--update-config`; review the
returned binding data privately. Replace only the staging D1 placeholder in
`services/sync-worker/wrangler.jsonc` with the returned database identifier.
The documentation intentionally uses only this placeholder:

```text
<STAGING_D1_DATABASE_ID>
```

A D1 resource identifier is not a decryption secret, but it still should not be
copied into reports where it is unnecessary. Do not change the local binding.

## R2 payment activation stop gate

Perform this step only if R2 Standard is already available with no checkout,
payment method, subscription activation or paid-plan acceptance. Otherwise stop
and leave the staging R2 placeholder untouched.

When the no-payment gate has passed, create the private EU-jurisdiction bucket:

```sh
npx wrangler r2 bucket create mirna-sync-staging-eu --jurisdiction=eu --config services/sync-worker/wrangler.jsonc
```

If the command itself asks for billing activation, cancel it. Do not accept and
continue.

After successful creation, replace only the staging bucket placeholder in the
configuration. Keep:

```json
{
  "binding": "MIRNA_SYNC_BUCKET",
  "bucket_name": "<STAGING_R2_BUCKET_NAME>",
  "jurisdiction": "eu",
  "remote": false
}
```

The bucket must remain private. Do not enable a public `r2.dev` URL, custom
public domain or client-side direct object access. Snapshot access is proxied by
the authenticated Worker.

## Review configuration before migration

Before touching remote D1:

1. confirm the `staging` environment names only the staging Worker and storage;
2. confirm both resources were created with `eu`, not a location hint;
3. set `MIRNA_BUILD_COMMIT` to the exact reviewed feature-branch commit using a
   placeholder during documentation review:

   ```text
   <FEATURE_BRANCH_COMMIT>
   ```

4. keep Worker observability disabled and ensure source has no secret/body
   logging;
5. verify exact CORS origins; add a preview origin only when that exact preview
   is intentionally used, never a wildcard;
6. confirm no production environment, route or custom domain was added;
7. rerun the staging dry run with automatic provisioning disabled.

Do not configure a server encryption master key. The Worker has no vault-data
decryption secret. If optional Turnstile is implemented later, its value is set
interactively and never committed:

```sh
npx wrangler secret put TURNSTILE_SECRET_KEY --env staging --config services/sync-worker/wrangler.jsonc
```

Do not create that secret while Turnstile is disabled or before its privacy,
origin and server-side single-use validation are implemented.

## Apply remote migrations

Use the explicit database name rather than relying on an ambiguous binding.
List first, inspect the exact pending migration set, and only then apply:

```sh
npx wrangler d1 migrations list mirna-sync-staging-eu --remote --env staging --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false
npx wrangler d1 migrations apply mirna-sync-staging-eu --remote --env staging --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false
```

Do not run arbitrary remote SQL or manually edit the migration table. A
migration failure stops deployment. Investigate it without dropping or
recreating a resource and without applying destructive repair SQL.

The four migrations cover foundation, snapshot, operation and device-security /
deletion state. Migration presence is still not runtime evidence: before
staging use, apply the exact ordered set and run the Worker and browser gates
against the same feature commit.

## Deploy the staging Worker

Deployment is allowed only after:

- all required local and phase gates pass;
- both bindings refer to verified EU staging resources;
- placeholders are gone;
- migrations succeeded;
- the exact feature commit is recorded;
- only synthetic smoke data is prepared;
- no payment or production action occurred.

Run one final dry build, then the intentional staging deployment:

```sh
npx wrangler deploy --dry-run --env staging --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false --strict
npx wrangler deploy --env staging --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false --strict
```

Do not use `--temporary`, automatic framework configuration, an unqualified
environment, or a production route. Keep the returned Worker hostname private
until response headers, CORS and health output have been reviewed. A staging URL
is not authorization to point the production Mirna application at it.

## Health and smoke verification

Use a placeholder hostname in documentation and replace it only in the private
operator shell:

```sh
curl --fail-with-body --silent --show-error \
  "https://STAGING_WORKER_HOST.example/v1/health"
```

The health response may reveal only:

```text
status
protocolVersion
buildCommit
D1 reachability
R2 reachability
```

It must use `Cache-Control: no-store` and must not return account, database or
bucket identifiers, environment dumps, secrets or stack traces.

Staging smoke tests use synthetic ciphertext only and verify:

- exact allowed and denied origins;
- strict methods, content types, schemas and `/v1` protocol handling;
- D1 and R2 reachability through the Worker;
- challenge/session expiry, one-time use and bounded active-session rotation;
- pairing/recovery attempt bounds and race handling;
- 8 MiB snapshot enforcement, private R2 access, acknowledgement-gated
  compaction and D1/R2 failure recovery;
- operation idempotence/limits, conflict convergence, device expiry/renewal,
  revoke-and-rotate and resumable recovery-authorized deletion;
- no known synthetic finance plaintext in D1, R2, API JSON or available Worker
  logs.

Record remote checks as pending until the routes run against provisioned
staging D1/R2. Passing local Miniflare tests is not remote verification.

## Staging client boundary

Only a local build or isolated preview may target the staging Worker. Use
placeholder values in examples:

```text
VITE_MIRNA_SYNC_ENABLED=true
VITE_MIRNA_SYNC_API_URL=https://STAGING_WORKER_HOST.example
```

Do not change production Vercel environment variables, deploy `2.4.0-beta.1` to
the production alias or enable sync for the stable application. The preview
must use synthetic finance data and one exact CORS origin. When the feature flag
is false, the client must make zero sync requests.

## Monitoring and quota response

Review Workers request/CPU failures, D1 row read/write/storage use and R2
storage/Class A/Class B operations through the private Cloudflare dashboard.
Do not enable raw request logging or paid observability. Application logs, if
later introduced, are limited to a random request ID, route, status, latency,
size class and generic error code.

Approaching a Free-plan boundary is handled by pausing staging use, reducing
synthetic load or cleaning eligible encrypted test data. Do not solve it by
upgrading, accepting overage or weakening retention/correctness rules.

Scheduled cleanup is bounded and idempotent. It must never delete a current
snapshot or an operation not yet eligible under active-device acknowledgement
rules. Cleanup failure is retried; it is not permission to bypass D1 state.

## Failure and rollback handling

If deployment fails, stop and preserve the evidence needed to diagnose the
staging-only failure without exposing identifiers or secrets. Do not recreate
D1/R2, drop tables, empty a bucket or force a new deployment as a first
response.

Worker code rollback does not automatically roll back D1 migrations or client
protocol state. A rollback is safe only when the selected Worker version is
schema- and protocol-compatible with the already applied migration. Otherwise
disable the staging client and repair forward with a reviewed migration.

If plaintext or secret material is found in any server-visible location:

1. stop all staging clients;
2. do not publish the sensitive sample;
3. preserve only non-sensitive diagnostic metadata;
4. invalidate affected sessions/pairings/recovery state as applicable;
5. fix the boundary and rerun the full plaintext-leak gate before redeploying.

## Completion record

A staging deployment report may state only verified facts:

- exact feature commit and protocol version;
- which local/phase gates passed and when;
- whether D1 and R2 were created or reused with EU jurisdiction;
- whether any provisioning step was blocked by payment activation;
- whether migrations, health and synthetic smoke checks passed;
- Worker hostname only when sharing it is necessary;
- explicit confirmation that no production client/deployment or paid action
  occurred.

Never include account identity, resource IDs, credentials, tokens, recovery or
pairing material. Successful staging smoke tests do not constitute an
independent security audit or production approval.
