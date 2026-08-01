# Mirna Encrypted Sync — Architecture

Status: experimental `2.4.0-beta.1` design, protocol version 1
Deployment boundary: staging only
Production status: disabled and not deployed
Review status: independent security review required

## Purpose and current status

Mirna Encrypted Sync is an optional, accountless, end-to-end encrypted sync
beta. It is designed so that the sync service does not receive the keys needed
to decrypt financial content. The existing local-first application remains the
primary system: disabling sync must preserve normal offline behavior and must
produce no sync requests.

This document describes both the intended three-phase architecture and the
implementation state on 2026-07-31. These are not equivalent:

| Area                                                 | Current state                                                                                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared protocol primitives                           | RFC 8785 canonicalization, strict encodings, Web Crypto helpers, recovery-code primitives and signed manifest validation are implemented in the beta source |
| Worker foundation                                    | Local D1/R2 bindings, four versioned migrations, strict HTTP/origin/body handling, health, bounded cleanup and staging rate-limit bindings are implemented  |
| Pairing, recovery and device-auth routes             | Implemented locally with D1-backed state, exact retry/race controls and adversarial Worker coverage; remote staging remains unverified                      |
| Client sync storage and Phase 1 lifecycle            | Dexie key capability/storage, Serbian enable/pair/recovery UI and the enable, pairing, SAS and recovery state machines pass the Phase 1 browser gate        |
| Encrypted snapshots                                  | Implemented locally with authenticated compression, private R2 proxying, D1 revision CAS, rollback/fork pins and retry-safe cleanup                         |
| Encrypted operation sync, conflicts and key rotation | Implemented locally with transactional outbox intent, signed ciphertext operations, explicit conflict resolution, ACK compaction and rotate-on-revoke       |
| Cloud-vault deletion                                 | Implemented locally as recovery-authorized, resumable R2-first deletion that retains local finance data                                                     |
| Remote staging resources                             | Blocked before provisioning because R2 activation requires a billing step; no remote deployment is asserted                                                 |
| Production enablement                                | Not authorized; no production Worker environment is defined                                                                                                 |

All three implementation phases passed focused unit, Worker and isolated
multi-context browser gates locally on 2026-07-31. This is engineering test
evidence, not an independent security audit or remote-staging claim.

## System boundary

```text
Authorized, unlocked Mirna client
  - plaintext finance data
  - device private keys
  - vault master key
  - recovery and pairing secrets
               |
               | HTTPS: signed metadata and ciphertext only
               v
Cloudflare Worker
  - strict /v1 API validation and authorization
  - no decrypt endpoint and no content-decryption key
          |                              |
          | small records                | private snapshot objects
          v                              v
        D1                              R2
  metadata, public keys,          encrypted snapshots only
  hashes, signed manifests,
  encrypted envelopes and
  encrypted operations
```

The plaintext trust boundary includes the authorized browser context, the Mirna
JavaScript delivered by the trusted origin, Web Crypto and IndexedDB browser
implementations, the operating system and the device. Cloudflare is not trusted
with plaintext, but it remains trusted for availability and for executing the
documented authorization checks correctly.

## Data classification

### Client-only secret material

The following values must not be sent to the Worker, D1 or R2:

- the 256-bit vault master key;
- the 256-bit recovery root;
- device signing and agreement private keys;
- the recovery signing private key outside its locally encrypted recovery
  bundle;
- the non-extractable local wrapping key;
- the 256-bit pairing root;
- decrypted snapshots and operations;
- plaintext transactions, balances, categories, notes, goals, debts, planned
  events or backups.

The pairing root is separated with HKDF into independent claim, transcript-MAC
and SAS capabilities. Only the claim capability, or its hash as required by a
specific request, may cross the service boundary. The root itself does not.

### Service-visible data

The service may process or retain only the minimum required operational data:

- opaque random vault, device, request, object and operation identifiers;
- public P-256 signing and agreement keys;
- signed manifest bodies and transitions;
- encrypted key, pairing and recovery envelopes;
- hashes of access, polling and claim capabilities;
- challenge, grant, expiry, revocation and bounded attempt state;
- key epochs, manifest versions, snapshot revisions, operation sequences and
  server cursors;
- ciphertext, authenticated clear headers, ciphertext sizes and object hashes;
- request timing, origin, IP and other ordinary infrastructure metadata that
  Cloudflare necessarily observes.

Entity types, financial command names, labels and finance values stay inside
ciphertext. Device labels should also remain encrypted; the service needs only
a random device ID.

Metadata privacy is limited. A hosting provider can still observe traffic
timing, approximate payload sizes, public keys, authorization lifetimes, opaque
relationships and request network metadata. End-to-end encryption does not hide
those facts.

## Client architecture

### Existing finance domain remains authoritative

The React/Vite/Dexie application keeps its integer-RSD domain invariants and
existing finance validation. Sync must call the same command/domain layer as
local interactions. Decrypted input is never written directly to finance tables
before strict schema validation and existing integrity checks pass.

Ordinary Mirna JSON, CSV and Markdown exports remain separate from sync state.
They must not contain device keys, vault keys, sessions, pairing material,
recovery material or the local wrapping key.

### Local key storage

Each device creates:

- a non-extractable ECDSA P-256 signing key pair;
- a non-extractable ECDH P-256 agreement key pair;
- a non-extractable AES-256-GCM local wrapping key.

The browser must prove that the required non-extractable `CryptoKey` objects
survive an actual IndexedDB close/reopen cycle. Encrypted sync remains
unsupported if that capability test fails; there is no exported-private-key
fallback. The raw vault key may exist briefly in JavaScript memory, but at rest
it is wrapped by the local key.

This does not encrypt the existing local finance tables at application level.
Disk confidentiality and storage retention continue to depend on the browser,
operating system and device. JavaScript also cannot guarantee perfect memory
erasure.

### Sync-specific stores

Dexie schema versions 6 through 10 add `syncVault`, `syncDevice`, `syncKeys`,
`syncOutbox`, `syncInbox`, `syncConflicts`, `syncFrontier`, `syncMetadata`,
`syncCheckpoints` and `syncEntityStates`. These stores are isolated from
ordinary finance backups. Their roles are:

- vault and device state, including the pinned manifest;
- locally wrapped key envelopes and epoch state;
- deterministic outbox intents and encrypted envelopes;
- inbox/application frontier and applied operation IDs;
- local conflict records;
- snapshot/frontier pins, scheduler state and non-sensitive diagnostics.

For operation sync, a successful finance mutation and its deterministic outbox intent
must be written in one Dexie transaction. Web Crypto work must happen outside
that transaction, because asynchronous encryption inside a long-lived IndexedDB
transaction is unreliable. A later scheduler step encrypts the committed intent
and preserves exactly the same envelope for idempotent retries.

### Service worker boundary

The PWA service worker must not receive vault keys or decrypted finance data and
must not cache sync API responses. Sync uses explicit network-only requests and
`Cache-Control: no-store`; the service worker continues to cache only the
application shell and offline assets.

## Cryptographic membership authority

`VaultManifestV1` is the client-verifiable membership authority. It contains
the vault and key epoch, active and revoked device public keys, a recovery
signing public key, the previous manifest-body hash and a signed transition.

D1 device rows are only an operational index used to reject requests quickly.
A client does not trust a membership change merely because the Worker returned
it. It verifies the canonical signature and chain and pins the accepted
manifest-body hash locally.

The first manifest is self-signed and therefore provides trust on first use
only. A paired device accepts its first manifest through the pairing-secret
transcript MAC. A recovered device accepts it through the manifest hash pinned
inside the locally decrypted recovery bundle. The server cannot create either
trust anchor.

## Phase 1: accountless authorization, pairing and recovery

The intended Phase 1 flow is:

1. the first device creates a vault ID, vault master key, device keys, recovery
   material and genesis manifest locally;
2. only public state, capability hashes and encrypted envelopes are registered
   with the Worker;
3. a new device creates its own keys, a short-lived pairing request, a pairing
   root, independent salt and separate polling token;
4. an authorized device inspects the candidate, creates a fresh ephemeral ECDH
   key, encrypts a vault-key envelope, signs the transition and authenticates
   the full transcript with the pairing-secret MAC;
5. both devices display the same keyed SAS before finalization;
6. the new device verifies its own keys, request, origin, manifest pin,
   signature, MAC, SAS and encrypted envelope before accepting the vault key.

Device authentication uses a one-time, short-lived 256-bit challenge signed for
one exact route audience. A successful proof yields a random 256-bit access
token valid for about 15 minutes; D1 stores only its hash and the client keeps
the token in memory. Device authorization lasts 30 days and is never silently
extended. Sensitive membership, recovery, rotation and deletion actions require
a fresh signed challenge rather than an access token alone.

Recovery derives an encryption key and an online HMAC gate from the recovery
root using different HKDF labels. The HMAC proves possession only to the
service. It is not allowed to authorize a manifest transition. Recovery
membership authority is a separate ECDSA key whose public key is pinned in the
previous manifest and whose private key exists only inside the encrypted
recovery bundle.

The detailed wire profile is in [SYNC-PROTOCOL.md](./SYNC-PROTOCOL.md), and the
custody and rotation flow is in [SYNC-RECOVERY.md](./SYNC-RECOVERY.md).

## Phase 2: encrypted snapshots

Phase 2 keeps compact metadata in D1 and stores each private snapshot ciphertext
in R2. The Worker proxies access; there are no public R2 object URLs. The
staging maximum is 8 MiB of encrypted snapshot data.

The intended upload protocol is retry-safe because D1 and R2 cannot participate
in one distributed transaction:

1. authenticate and validate the clear envelope and size;
2. create a temporary D1 record with an expiry before the R2 upload;
3. stream ciphertext to a private temporary R2 object;
4. atomically compare-and-swap the vault revision in D1;
5. mark that exact object committed, or mark it orphaned when the CAS fails;
6. retry safely by idempotency key;
7. let bounded scheduled cleanup remove expired temporary/orphan objects.

Clients pin revision, snapshot hash, manifest hash and causal frontier. They
reject an older revision, a different object for an accepted revision, a broken
parent link or a manifest fork. A decrypted snapshot is applied atomically only
after its signature, AAD, encryption tag, schema and finance integrity all pass.
If local state is dirty while the remote revision advanced, snapshot overwrite
is blocked instead of applying last-write-wins.

The beta source implements this flow locally. A new snapshot is not accepted
as routine compaction while an active device still owes an acknowledgement for
the current snapshot. The one exception is a mandatory key-epoch rotation
snapshot after revocation, because the old epoch must be replaced immediately.

## Phase 3: encrypted operations and conflicts

Phase 3 adds a small append-only ciphertext log in D1. Clear operation metadata
is restricted to opaque identity, device sequence, key epoch, size, nonce, AAD,
signature and server cursor. The command type, entity identity and payload stay
encrypted.

Clients verify per-device monotonic sequences, previous-operation hashes,
signatures and causal frontiers. Server cursors help pagination but are not
cryptographic truth. Operation IDs and domain idempotency prevent duplicate
transactions or payments.

Independent additions and unrelated entities may merge automatically. Concurrent
edits to the same financial entity, edit/delete races and cash-affecting
conflicts require explicit user review. Wall-clock time and silent
last-write-wins are not conflict-resolution mechanisms.

Snapshots remain the bootstrap and compaction format. Operations and tombstones
are retained until the required active-device acknowledgements pass the compacted
frontier. Device revocation blocks service access immediately. Future
confidentiality is then restored with a new random vault master key, a new key
epoch, recipient-bound envelopes only for remaining devices and a signed
manifest transition.

The beta source implements this flow locally. Explicit conflict-resolution
operations carry the sorted operation IDs they resolve, so every device can
recognize the decision and avoid presenting the same conflict again. A pending
conflict defers both compaction and server acknowledgement until the user makes
that decision.

## Worker, D1 and R2 responsibilities

### Worker

The Worker is responsible for strict `/v1` schemas, exact-origin CORS,
challenge/session verification, grant and revocation checks, bounded payloads,
idempotency, safe generic errors and scheduled cleanup. It never decrypts a
finance payload. Responses use strict JSON, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` where
applicable.

There is intentionally no Durable Object, Queue, WebSocket or server push in
protocol v1. HTTP polling, D1 compare-and-swap, R2 and a five-minute cleanup trigger
are sufficient for the initial correctness model and keep the service small.

### D1

D1 holds public cryptographic membership, challenge/session hashes, expiry and
attempt state, signed manifests, encrypted envelopes, snapshot commit metadata,
small encrypted operations, acknowledgement frontiers and resumable deletion
state.
Indexes scope common request paths by vault and expiry. Security-critical
pairing and recovery attempt counters live in D1; an eventually consistent edge
rate limiter is defense in depth, not authorization state.

### R2

R2 is reserved for private encrypted snapshots. The application does not give
clients direct public object URLs. Object names are derived from opaque
identifiers, not finance data. Temporary and orphaned objects have bounded
cleanup records.

## Platform limits and cost boundary

The staging design is bounded for a small Free-plan evaluation, but it is not
described as permanently free. Limits and prices can change and must be checked
again immediately before provisioning.

As reviewed on 2026-07-31:

- Workers Free documents 100,000 requests/day, 10 ms CPU per HTTP or Cron
  invocation, 128 MB memory, 50 subrequests, six simultaneous outbound
  connections and a 100 MB Free-plan request body limit. See
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
- D1 Free documents 5 million rows read/day, 100,000 rows written/day, 5 GB
  total account storage, ten databases, 500 MB per database, 50 queries per
  Worker invocation and a 2 MB maximum row/BLOB/string. Free read/write/storage
  exhaustion fails requests rather than automatically converting the account to
  paid usage. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
  and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
- R2 Standard documents a monthly free allowance of 10 GB-month, one million
  Class A operations and ten million Class B operations. R2 is usage-priced
  beyond that allowance and its activation may require a billing step; it is
  not a hard-free service boundary. See
  [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

Application quotas are deliberately lower: ten devices per vault, three active
pairings, five-minute pairings, 15-minute sessions, 30-day device authorization,
8 MiB snapshots, 64 KiB operations, 100 operations per batch, three retained
snapshots and short orphan retention.

If Cloudflare requests a payment method, billing activation, paid plan or paid
overage, provisioning stops before acceptance. No service is upgraded and no
payment method is added without a separate explicit decision.

## Data location

The intended staging D1 database and R2 bucket use the immutable `eu`
jurisdiction selected at creation. Cloudflare documents that this constrains
where the D1 database runs/persists and where R2 objects are stored/processed.
It does not mean that a globally deployed Worker processes every HTTP request
only inside the EU. Workers may access jurisdiction-bound storage from other
edge locations unless additional regional products are configured. See
[D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/)
and [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/).

The staging beta does not claim EU-only request processing. Cloudflare still
observes ordinary request metadata at its infrastructure boundary.

## Availability and endpoint compromise

Encryption cannot make the service available. The Worker or storage provider
can delete, delay or withhold ciphertext, exhaust quotas or present a fork to a
client without a prior external checkpoint. Local finance data remains usable
when sync is unavailable.

Encryption also cannot protect plaintext from malicious first-party JavaScript
running after an authorized vault is unlocked. A compromised Mirna deployment,
browser extension, operating system or unlocked device can read plaintext or
invoke non-extractable keys through Web Crypto. Strict CSP, reviewed locked
dependencies, no third-party analytics, controlled PWA updates and public code
reduce this risk but do not eliminate it.

See [SYNC-SECURITY-MODEL.md](./SYNC-SECURITY-MODEL.md) for the complete threat
analysis and residual risks.

## Production gate

The feature remains disabled by default, staging-only and experimental until
the three phase gates pass and an independent review covers the cryptographic
construction, recovery, revocation/rotation, conflict behavior, dependencies
and staging adversarial results. A local or automated review is not an
independent security audit.
