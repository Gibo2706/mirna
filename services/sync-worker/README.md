# Mirna encrypted sync Worker

This directory is the Cloudflare Worker foundation for the experimental Mirna
end-to-end encrypted sync beta (protocol version 1). It is part of the same
AGPL-3.0-only source tree as the client.

The implemented HTTP surface is intentionally small:

- `GET /v1/health` checks D1 and R2 binding reachability without returning
  account, database or bucket identifiers;
- exact-origin CORS and preflight handling;
- consistent no-store JSON responses and generic public errors;
- D1-backed vault genesis, signed challenge/session authentication, pairing,
  manifest finalization and all-devices-lost recovery;
- authenticated private snapshot upload/read through R2 with revision CAS,
  idempotency and retry-safe orphan cleanup;
- encrypted operation upload, paginated changes, active-device acknowledgements
  and acknowledgement-gated compaction;
- signed device renewal, recovery-backed revoke-and-rotate, epoch envelopes,
  manifest history and resumable cloud-vault deletion;
- per-route edge rate-limit bindings, authoritative D1 attempt counters and
  atomic hard quotas;
- a five-minute, bounded and idempotent cleanup task.

All three local implementation phases passed their client, Worker and isolated
multi-context browser gates on 2026-07-31. Remote staging remains unverified
because R2 provisioning stopped at the no-billing gate. This is not a security
audit or production-readiness claim.

## Security and data boundary

D1 stores only public cryptographic material, encrypted envelopes, opaque IDs,
secure hashes and minimal lifecycle metadata. R2 is reserved for encrypted
snapshot objects. This Worker has no server-side content-decryption key and no
decrypt or escrow endpoint.

Never add plaintext transactions, balances, categories, notes, goals, debts,
planned events, backups, request bodies, access tokens, pairing codes or
recovery codes to D1, R2 or logs. `observability.enabled` remains `false`; the
Worker source contains no `console` logging. Cloudflare still processes normal
platform metadata at its infrastructure boundary.

This is not an audit claim. Independent security review is required before any
production enablement.

## Local commands (Node 22, session only)

From the repository root, use the already loaded NVM installation for the current shell:

```sh
nvm use 22
```

The checked-in local D1 and R2 identifiers are deliberately non-deployable
Miniflare placeholders. Do not replace them for local work.

Apply or inspect migrations against local storage only:

```sh
npx wrangler d1 migrations list MIRNA_SYNC_DB --local --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false
npx wrangler d1 migrations apply MIRNA_SYNC_DB --local --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false
```

Run the Worker and its focused checks:

```sh
npx wrangler dev --local --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false
npx tsc --project services/sync-worker/tsconfig.json --pretty false
npx vitest run --config services/sync-worker/vitest.config.ts
```

The Vitest configuration uses Cloudflare's current `cloudflareTest()` plugin,
applies every migration in `migrations/` to isolated local D1 storage and
exercises real local D1/R2 bindings. No fixture contains real financial content.

## Safe staging dry run

Staging is the only remote environment defined. There is deliberately no
production environment. Before provisioning, the invalid staging placeholders
must still be present for a fail-closed compile-only review:

```sh
npx wrangler deploy --dry-run --env staging --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false
```

Do not run a non-dry deployment while either
`REPLACE_WITH_STAGING_D1_UUID_DO_NOT_DEPLOY` or
`replace-with-staging-r2-bucket-do-not-deploy` remains in the configuration.
Automatic resource provisioning must remain disabled for all reviewed commands.

The exact local allowed origin is `http://localhost:5173`. Staging contains a
fail-closed `.invalid` placeholder which must be replaced by one exact isolated
Vercel preview origin. The production Mirna origin is deliberately not allowed.
Never add a wildcard or reflect an arbitrary `Origin`.

## Staging provisioning and payment stop gate

Provisioning is authorized only after verifying current Cloudflare plan limits,
free allowances and the selected account without copying account identifiers or
credentials into source or reports. Cloudflare's current primary documentation
should be rechecked immediately before the action:

- [D1 data jurisdiction](https://developers.cloudflare.com/d1/configuration/data-location/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

Authenticate interactively, then inspect identity privately:

```sh
npx wrangler login
npx wrangler whoami
```

Do not paste `whoami` output into issues, commits or reports.

**R2 PAYMENT ACTIVATION STOP GATE:** if Cloudflare asks for a payment method,
billing activation, a paid plan, paid overage or any paid product, stop before
creating or enabling R2 and report the blocker. Do not accept the prompt. D1 has
the same no-paid-upgrade rule. The owner must explicitly authorize any payment
activation in a later decision.

Only after the no-payment gate and current limits are verified may an operator
create the EU-jurisdiction staging resources:

```sh
npx wrangler d1 create mirna-sync-staging-eu --jurisdiction=eu --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false
npx wrangler r2 bucket create mirna-sync-staging-eu --jurisdiction=eu --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false
```

Replace only the two resource placeholders with the returned resource values,
and set `MIRNA_BUILD_COMMIT` to the exact feature-branch commit being deployed.
Never commit account IDs, API tokens, OAuth material or `.dev.vars`.

After another dry run passes, list and apply the remote migration explicitly:

```sh
npx wrangler d1 migrations list mirna-sync-staging-eu --remote --env staging --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false
npx wrangler d1 migrations apply mirna-sync-staging-eu --remote --env staging --config services/sync-worker/wrangler.jsonc --x-provision=false --x-auto-create=false
```

A staging deployment is a separate intentional step. It must use `--env staging`,
must keep automatic provisioning disabled, and must not be connected to real
Mirna finance data.

## Budget diagnosis and repair

The staging accounting tools are intentionally separated:

```sh
npm run sync:budget:diagnose -- --env staging --since 6h
npm run sync:budget:repair -- --env staging --request <REQUEST_ID> \
  --operation pairing-create --pairing-request <PAIRING_REQUEST_ID> --apply
```

Diagnosis is read-only. Both commands write a mode-`0600`, ignored evidence
snapshot under `.private/sync-budget-evidence/`. Repair accepts only staging and
the proven `pairing-create` incident signature. It requires the exact HTTP and
pairing request IDs plus `--apply`, derives the business commit from the single
isolated pending D1 row, and refuses non-target incidents, counter drift or
reached hard limits. Two exact CAS writes change only the three reservation
reconciliation fields and the four accounting-fault fields; admission,
maintenance and usage counters are never rewritten. The tool never reads
request bodies, financial rows, recovery envelopes, keys or tokens.

## Cleanup and storage safety

The cron runs once per hour at minute 7. It first inspects a bounded work set,
skips the expensive route reservation when no cleanup is pending, and reserves
only the inspected batch. Each expired-metadata category uses one
indexed `DELETE … LIMIT` statement capped by
`MIRNA_EPHEMERAL_CLEANUP_BATCH_SIZE` (1,000 in staging). Snapshot cleanup stays
separately capped at 10 objects because each object needs D1 claim/delete work
and an R2 operation. This is a row bound, not a claim that each deleted row
consumes another Worker query.

Anonymous staging storage also fails closed at 1,000 vaults and 5,000 retained
pairing requests. Per-device active challenge/session and pairing/recovery
limits are enforced in the same D1 write that creates or transitions the row,
so concurrent requests cannot pass a count-then-write race. These are staging
safety ceilings, not permanent Free-plan guarantees.

R2 objects are removed before their D1 metadata. If R2 deletion fails, the
claimed metadata remains eligible for a later retry. A committed current
snapshot is never selected: only `temporary`, `orphaned` or explicitly
`superseded` rows with an elapsed `cleanup_after` timestamp are eligible.
Operation cleanup timestamps are set only after the required authorized-device
acknowledgements.

The snapshot upload route creates its `temporary` D1 row, including a
mandatory `cleanup_after`, before streaming to R2. The later vault-revision CAS
promotes that same row. This ordering guarantees that an R2 success followed by
a CAS failure still leaves a durable cleanup record; a raw R2 upload without the
pre-created record is outside the supported protocol.
