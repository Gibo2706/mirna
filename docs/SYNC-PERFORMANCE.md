# Mirna Encrypted Sync — Performance Characterization

Status: local engineering evidence for experimental `2.4.0-beta.1`
Protocol version: `1`
Measured: 2026-07-31

## Scope

These measurements characterize the feature branch with synthetic data. They
are not production service-level objectives and do not predict every browser,
device, network or Cloudflare location. Cryptographic micro-measurements run on
Node 22 Web Crypto; the multi-device timings run in Playwright Chromium against
local Vite and Miniflare processes.

The current client uses one app-level foreground runtime. It performs a cold
start attempt, debounces local mutations for three seconds, enforces a
30-second minimum automatic gap without dropping intervening triggers, pauses
periodic work while hidden and uses a five-minute visible refresh. These are
load bounds and UX behavior, not service-level guarantees. No measurement or
claim in this document represents execution while a killed PWA process is
inactive.

## Snapshot and key measurements

The deterministic Vitest characterization generates two P-256 device key sets,
derives pairing agreement keys in both directions, constructs canonical
snapshots, compresses them with gzip and encrypts/signs them with fresh test
keys.

| Synthetic case      |   Plaintext | Encrypted gzip |    Assembly | Crypto + compression |
| ------------------- | ----------: | -------------: | ----------: | -------------------: |
| 250 transactions    |   135,204 B |       14,468 B |   100.29 ms |             67.01 ms |
| 10,000 transactions | 5,339,454 B |      475,335 B | 1,402.79 ms |          1,194.79 ms |

In the same run, two-device key generation took 2.72 ms and the two-sided
pairing derivation took 3.78 ms. Both encrypted artifacts stayed well below the
8 MiB protocol limit. The assertions enforce the size boundary and key
non-extractability; timings are reported for comparison rather than used as
flaky pass/fail thresholds.

A separate IndexedDB characterization queued 250 offline operation intents in
366.37 ms. Their canonical payloads totalled 153,010 bytes, or approximately
612 bytes per intent before encryption and transport framing.

## Browser workflow sample

One complete two-context Playwright run recorded:

| Workflow                                                |  Elapsed |
| ------------------------------------------------------- | -------: |
| Initial upload and pairing                              | 9,788 ms |
| Incremental operation upload                            | 1,705 ms |
| Independent two-device merge                            | 5,144 ms |
| Conflict detection, explicit resolution and convergence | 6,404 ms |
| Device revoke, key rotation and new snapshot            | 1,282 ms |
| Encrypted cloud-vault deletion                          | 4,808 ms |

These include UI polling and local process/network overhead, so they must not be
compared directly with the Web Crypto timings above. The E2E test attaches its
current JSON timing record to the Playwright result on every run.

## Reproduction

Use repository-pinned dependencies and Node 22:

```sh
npm run sync:test
npm run sync:test:e2e
```

For visible micro-measurements:

```sh
npx vitest run src/domain/sync/performance.test.ts \
  src/db/sync/operation-repository.test.ts --reporter=verbose --silent=false
```

Only synthetic fixtures are permitted. Re-run and record a fresh sample before
making a release claim, after cryptographic/protocol changes, or when changing
the supported runtime.
