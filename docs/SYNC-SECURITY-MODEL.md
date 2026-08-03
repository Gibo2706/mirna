# Mirna Encrypted Sync — Security Model

Status: experimental design for `2.4.0-beta.1`, protocol version 1
Deployment boundary: staging only
Review status: not independently audited

## Security statement

Mirna Sync is an optional end-to-end encrypted sync beta. It is designed so
that the sync service does not receive the keys needed to decrypt financial
content. An independent security review is required before production
enablement.

This design does not promise zero risk, formal verification, uninterrupted
availability or protection from malicious code executing after the Mirna vault
is unlocked.

## Scope and trust boundaries

The trusted computing base for plaintext includes the user's authorized,
unlocked browser contexts, the Mirna JavaScript delivered by the trusted Mirna
origin, browser cryptographic/storage implementations, the operating system and
the device itself.

The Cloudflare Worker, D1 and R2 are not trusted with plaintext. They may relay
or store ciphertext, public keys, signed manifests, encrypted key envelopes,
opaque random identifiers, authorization expiries, sizes, revisions/cursors and
minimal abuse/operational metadata. They never receive the vault master key,
recovery root secret, private device keys, decrypted operations or financial
plaintext.

The Vercel deployment and dependency delivery path are integrity-sensitive:
malicious JavaScript served from the trusted Mirna origin can read plaintext
while the application is open and unlocked. End-to-end encryption cannot solve
that web-application trust problem.

Existing local Mirna financial data in IndexedDB remains protected by the
browser/device security model. Encrypted sync does not automatically add
application-level encryption to the ordinary local finance stores.

Web Crypto provides low-level primitives and is easy to misuse; its own
documentation recommends expert review before making security guarantees. It
also specifies serializable `CryptoKey` storage through facilities such as
IndexedDB, but does not guarantee disk encryption, secure erasure or indefinite
key retention. See the
[Web Crypto API overview](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
and [Web Cryptography security considerations](https://www.w3.org/TR/webcrypto/#security-considerations).

## Assets and protected properties

- Financial confidentiality: transactions, balances, categories, notes, goals,
  debts, planned events, snapshots and operations are not disclosed to the sync
  service or a passive network attacker.
- Cryptographic integrity: modified ciphertext, authenticated metadata,
  signatures, key envelopes and protocol versions are rejected.
- Device authenticity: only currently authorized, non-revoked, non-expired
  devices can create sessions or accepted mutations.
- Replay resistance: challenges, pairing capabilities, sensitive transitions
  and idempotency keys have one valid lifecycle.
- Rollback/fork detection: a client that accepted newer signed state rejects an
  older or incompatible branch.
- Forward exclusion: after secure revocation and a completed random-key
  rotation, a revoked device cannot decrypt later epochs.
- Local-first availability: local data remains usable when sync is offline,
  expired or unavailable.

Availability is deliberately limited: the service can delete, delay, reorder
within allowed API semantics, withhold or refuse ciphertext. E2EE cannot prevent
server-side denial of service.

## Cryptographic design constraints

- Exact allowlisted suite:
  `MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1`.
- ECDSA P-256/SHA-256 signatures; ECDH P-256 followed by HKDF-SHA-256;
  AES-256-GCM; SHA-256; HMAC-SHA-256 only for the online recovery gate proof;
  `crypto.getRandomValues` for every production secret.
- RFC 8785 JCS canonical bytes for signed/hash transcripts. JCS requires I-JSON,
  rejects duplicate property names and non-finite numbers, preserves Unicode
  strings and recursively sorts object keys by UTF-16 code units. See
  [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html).
- Protocol, suite and every encrypted envelope type are explicit. Unknown or
  downgraded versions fail closed.
- A unique random object ID, object-specific HKDF context and fresh 96-bit GCM
  nonce are required for every encrypted snapshot, operation and key envelope.
- AAD binds protocol, suite, vault ID, key epoch, object type/ID, creator,
  revision or operation identity and the relevant parent/frontier.
- Private device keys and a non-extractable local wrapping key are stored only
  as feature-tested `CryptoKey` objects in IndexedDB. The raw vault master key is
  stored only encrypted by that local key. No sync secret enters normal backup,
  local/session storage, cookies, URLs or logs.
- JavaScript buffers are cleared on a best-effort basis; perfect secure erasure
  is not possible in this runtime.

## Threat analysis

The mitigation column describes required protocol behavior. A mitigation is not
considered implemented until its phase gate and adversarial tests pass.

| Threat                           | Attacker capability                                                           | Protected property                                                  | Required mitigation                                                                                                                                                                                        | Residual risk                                                                                                                                                                | Scope                          |
| -------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Compromised D1 database          | Read, copy, edit, delete or roll back all metadata and encrypted operations   | Financial confidentiality, membership integrity, rollback detection | Store no decryption key/plaintext; signed manifest transitions; signed envelopes; client-pinned manifest/snapshot/frontier hashes; AEAD; client sequence/hash-chain verification                           | Access timing, sizes, opaque graph and authorization metadata leak; attacker can deny service or present a fork only a previously pinned client can detect                   | In scope                       |
| Compromised R2 bucket            | Read, replace, delete or replay snapshot objects                              | Snapshot confidentiality/integrity/rollback detection               | Ciphertext only; object-specific AES-GCM; signed full envelope; authenticated revision/parent; D1 committed reference; client pinning                                                                      | Size/timing leakage and deletion/withholding remain                                                                                                                          | In scope                       |
| Curious hosting provider         | Observe Worker execution, requests and stored data                            | Financial confidentiality and secret keys                           | Client-side encryption/decryption; proxy private R2 access; no body/ciphertext logs; no server master key or decrypt endpoint                                                                              | Ordinary request metadata, size, timing, IP and region handling remain visible                                                                                               | In scope                       |
| Network attacker                 | Observe, alter, replay or block traffic                                       | Confidentiality, integrity, authenticity                            | HTTPS; AEAD; signed canonical transcripts; strict origin/CORS; one-time challenges; rollback pins                                                                                                          | Traffic analysis and denial of service remain; compromised CA/origin delivery is addressed separately                                                                        | In scope                       |
| Replayed request                 | Re-submit captured auth, mutation or transition                               | Authenticity and idempotence                                        | One-time short-lived challenges; endpoint/audience-bound signatures; consumed state; unique idempotency keys; operation uniqueness; fresh signatures for sensitive actions                                 | A valid bearer token can be replayed within its short lifetime for non-sensitive allowed calls until revoked/expired                                                         | In scope                       |
| Pairing-code brute force         | Guess or submit many manual capabilities                                      | Vault membership and key confidentiality                            | At least 128-bit pairing secret; QR preferred; hash at rest; five-minute expiry; strict D1 attempt counter; rate limit; constant-time comparison; one-time/cancellable request                             | Online denial of service and metadata about attempt outcomes may remain                                                                                                      | In scope                       |
| Pairing request enumeration      | Probe identifiers and states                                                  | Membership/privacy                                                  | Random opaque IDs; separate polling capability; uniform public errors; no sequential IDs; origin/rate validation                                                                                           | Request existence may leak to a holder of a valid polling capability                                                                                                         | In scope                       |
| Malicious unauthenticated client | Create/flood vaults, pairings or expensive work                               | Authorization, availability, cost bound                             | Strict schemas/content types; size limits; hard per-vault quotas; anonymous endpoint rate limits; optional Turnstile only on setup/recovery; no expensive crypto on Worker before validation               | Distributed abuse can consume free quota or make service unavailable                                                                                                         | In scope                       |
| Stolen access token              | Use a short session token                                                     | Limited server access                                               | 256-bit opaque token; D1 stores only hash; about 15-minute expiry; memory-only client storage; grant/revocation checks every protected request; sensitive operations require a fresh device signature      | Attacker can use ordinary permitted endpoints during remaining token lifetime; token theft implies compromised runtime/network boundary                                      | In scope                       |
| Stolen but locked device         | Access device files/storage without unlocked Mirna runtime                    | Local key and financial confidentiality                             | Non-extractable device/local keys where supported; vault key locally wrapped; rely on OS/browser lock/storage isolation; recommend device encryption                                                       | Web Crypto does not guarantee encrypted key persistence; ordinary finance IndexedDB is not application-encrypted                                                             | In scope, platform-limited     |
| Stolen unlocked device           | Execute Mirna or inspect active plaintext/key use                             | Current/future confidentiality and authenticity                     | Immediate server revoke from another trusted device; complete random-key rotation; short sessions; UI warning and device list                                                                              | Attacker may copy plaintext, old keys and already decrypted history before revocation; cannot be remotely erased                                                             | In scope, limited mitigation   |
| Revoked device                   | Retain old keys and attempt API calls                                         | Server authorization and future confidentiality                     | Block sessions/uploads/downloads/pairing immediately; signed manifest revoke; new random vault key/epoch; new envelopes only for remaining devices                                                         | Revoked device retains everything learned before rotation and may receive data from another malicious authorized device                                                      | In scope                       |
| Malicious authorized device      | Decrypt, forge legitimate operations, leak key/plaintext or approve devices   | Integrity and confidentiality among trusted members                 | Signed per-device operations, device attribution, causal conflicts, manifest transitions, revocation and auditable local conflict history                                                                  | E2EE cannot prevent an authorized endpoint from reading or exfiltrating plaintext/vault keys; a single authorized device may perform allowed operations                      | In scope, cannot fully prevent |
| Server rollback                  | Return an earlier valid snapshot/manifest/change set                          | Freshness and history consistency                                   | Persist last accepted revision/hash/manifest/frontier; hash-linked signed states; reject older/broken parent; show explicit security warning                                                               | A brand-new/recovered device without an external checkpoint can be shown a self-consistent stale view; server can withhold all newer state                                   | In scope                       |
| Forked operation history         | Present different valid subsets/branches to clients                           | Consistency/integrity                                               | Per-device monotonic sequence and previous-operation hash; causal frontier; signed manifest/snapshot parent; client pinning and fork conflict                                                              | Without out-of-band gossip/transparency, isolated clients may not learn they received different internally consistent branches until histories meet                          | In scope                       |
| Ciphertext tampering             | Flip, truncate, substitute or extend ciphertext                               | Integrity                                                           | AES-GCM authentication plus signature over the complete clear envelope and ciphertext digest/bytes as specified                                                                                            | Denial of service remains                                                                                                                                                    | In scope                       |
| AAD tampering                    | Change vault, epoch, object identity, creator, parent or compression metadata | Context integrity                                                   | Canonical exact AAD reconstructed/validated and supplied to AES-GCM; signed envelope; strict schema/unknown-field rejection                                                                                | Denial of service remains                                                                                                                                                    | In scope                       |
| Signature substitution           | Swap signature, public key, signed object or signer identity                  | Authenticity                                                        | Sign domain-separated canonical transcript containing protocol/suite/object/audience/signer; resolve key only from pinned signed manifest; verify exact raw signature format                               | Compromised authorized private signing key can produce valid signatures until revoke                                                                                         | In scope                       |
| Nonce reuse                      | Reuse AES-GCM IV under the same key                                           | Confidentiality/integrity                                           | Random 96-bit nonce plus unique random object ID and object-specific HKDF key; local duplicate detection/tests; never caller-select production randomness                                                  | Random collision is non-zero; browser RNG failure or cloned faulty state remains a platform risk                                                                             | In scope                       |
| Key-envelope substitution        | Deliver a vault key envelope to the wrong device/vault/epoch                  | Vault-key confidentiality and membership integrity                  | Bind and sign vault, pairing request, both device IDs/keys, ephemeral key, suite and epoch; recipient checks its pinned request and own public keys before decrypt                                         | Malicious approved device can intentionally authorize a device within its allowed authority                                                                                  | In scope                       |
| Recovery-code theft              | Attacker obtains the 256-bit recovery root                                    | Vault confidentiality/membership                                    | Recovery root never sent; separate HKDF wrapping/auth keys; strict server attempts; recovery proof/challenge; rotate recovery root/verifier after use; notify/show new code                                | A stolen valid code plus server access is a powerful root recovery capability and may recover the vault; printed/copied code protection is the user's responsibility         | In scope                       |
| Lost all devices                 | No authorized key remains                                                     | Availability/recoverability                                         | One-time displayed checksummed recovery code; local decrypt of server recovery envelope; documented print/download workflow                                                                                | Without the recovery code, cloud ciphertext is intentionally unrecoverable; support has no backdoor                                                                          | In scope                       |
| Browser storage eviction         | Browser deletes IndexedDB keys/state                                          | Availability and rollback pins                                      | Detect unavailable/missing keys; pause safely; recovery flow; never regenerate and overwrite silently; encourage recovery-code custody/backup                                                              | Unsynced local finance data or pinned freshness state may be lost; restored client may have weaker rollback knowledge                                                        | In scope                       |
| Malicious browser extension      | Read/modify DOM, JS, network or storage with granted privilege                | Plaintext/key confidentiality and integrity                         | Minimize displayed secrets; no automatic recovery-code copy; CSP/dependency controls do not protect against privileged extensions; document risk                                                           | Privileged extension can read plaintext, impersonate the user and exfiltrate keys while unlocked                                                                             | In scope, cannot fully prevent |
| Compromised operating system     | Read memory/storage/input or modify browser                                   | All client-side properties                                          | Rely on device lock/update/encryption; short sessions; remote revoke/rotation after detection                                                                                                              | Full compromise defeats endpoint E2EE and can capture recovery/device keys                                                                                                   | In scope, cannot prevent       |
| Compromised Vercel deployment    | Serve malicious Mirna JavaScript or alter configuration                       | Plaintext/key confidentiality and operation integrity               | Strict CSP; no analytics/unnecessary scripts; locked reviewed dependencies; SHA-pinned Actions; public source; controlled prompt-based PWA updates; feature flag off in production                         | Malicious same-origin JavaScript can access plaintext and use non-extractable keys through Web Crypto; CSP cannot protect against an authorized malicious first-party bundle | In scope, high residual risk   |
| Malicious JavaScript update      | New bundle runs after install/update                                          | Plaintext/key confidentiality and integrity                         | Prompted update; never force-reload an open form; review/reproducible build guidance; no `unsafe-eval`; minimize dependency/runtime code                                                                   | Once accepted and executed at the trusted origin, malicious code can defeat endpoint protections                                                                             | In scope, high residual risk   |
| Dependency compromise            | Build or runtime dependency injects malicious behavior                        | Supply-chain integrity                                              | Lockfile; license/maintenance/scope review; minimal dependencies; SHA-pinned CI Actions; audits and secret/plaintext regression tests                                                                      | Package registry or maintainer compromise can evade routine review; independent review still required                                                                        | In scope                       |
| Denial of service                | Flood endpoints, delete/withhold data or exhaust quotas                       | Availability and cost bound                                         | Hard request/body/device/storage quotas; staged rate limits; backoff/jitter; idempotent cleanup; bounded queries/storage; local-first offline operation                                                    | Cloud sync can be unavailable and free quotas can be exhausted; no availability guarantee                                                                                    | In scope                       |
| Storage exhaustion               | Upload many/big snapshots/operations/orphans                                  | Availability and cost bound                                         | 8 MiB snapshots, 64 KiB operations, batch/device/pairing/snapshot limits; per-vault total quotas; temporary-object expiry; scheduled cleanup; indexed queries                                              | Distributed vault creation may still consume account-level allowances                                                                                                        | In scope                       |
| Metadata leakage                 | Observe IDs, public keys, grant times, sizes, cursors, IP/timing              | Privacy                                                             | Random opaque IDs; encrypted labels/command/entity types; coarse ephemeral/hash abuse keys; privacy-safe logging; no raw bodies/full user agents/permanent IPs                                             | Cloudflare still sees network metadata, public keys, sizes, timing, coarse relationships and edge processing location                                                        | In scope, acknowledged         |
| Diagnostic overcollection        | Support tooling captures secrets or finance data                              | Financial and key confidentiality                                   | Strict event/field allowlists; 2 KiB server JSON cap; hashed support/vault/device refs; no body/token/secret/IP/user-agent fields; local 200-event ring; 14-day D1 retention; copy/download review warning | A user can separately paste unrelated sensitive material into a support conversation; Cloudflare still observes ordinary request metadata                                    | In scope                       |
| Clock manipulation               | Change client clock to reorder/bypass expiry                                  | Authorization and causal correctness                                | Server timestamps control challenges/sessions/grants; sequence/Lamport/causal frontier, not wall time, control ordering; tolerate narrow documented skew only                                              | Displayed local times may be misleading; server clock compromise affects availability/expiry decisions                                                                       | In scope                       |
| Concurrent offline edits         | Multiple devices edit while disconnected                                      | Ledger correctness and user intent                                  | Causal frontiers; deterministic merge only for independent operations; same-entity/edit-delete/ledger conflicts stored locally and require user resolution; resolution is a new signed operation           | Users can choose an incorrect resolution; malicious devices can create conflicts/DoS                                                                                         | In scope                       |

## Recovery gate residual trust

Protocol v1 derives two independent values from the 256-bit recovery root using
different HKDF information strings:

- the recovery wrapping key encrypts the vault master key and never reaches the
  service;
- the recovery gate key authenticates a challenge-bound HMAC proof to the
  online service.

D1 stores only a domain-separated SHA-256 hash of the recovery gate key. During
a recovery attempt the client sends the gate key and a transcript-bound HMAC
proof over HTTPS; the Worker checks both and keeps neither in persistent
storage. The gate is therefore not a password-equivalent encryption key and a
D1-only compromise does not reveal either recovery-derived key. A compromised
Worker executing a live recovery can observe or misuse the presented gate key,
but HKDF separation prevents deriving the wrapping key from it.

The gate alone is deliberately insufficient to authorize new membership. The
client must also decrypt the recovery bundle locally and sign the replacement
manifest transition with the recovery ECDSA private key pinned by the previous
manifest. The Worker rate limits attempts, keeps an authoritative bounded D1
attempt counter, consumes the challenge, rotates both recovery material and the
sole-device manifest atomically, and retains only an exact idempotent completion
acknowledgement for a bounded retry window. A malicious running service can
still deny, delay or observe recovery traffic; it cannot decrypt the recovery
envelope from the gate key.

## Security UX requirements

- First sync requires explicit explanation, recovery confirmation and separate
  approval of the initial ciphertext upload.
- The recovery code is shown intentionally, never auto-copied and confirmed by
  random groups. The warning is explicit: if every authorized device and the
  recovery code are lost, encrypted cloud data cannot be recovered.
- Pairing uses a high-entropy QR/manual capability and a transcript-derived SAS
  confirmed on both devices. A mismatch cancels and invalidates the request.
- Expired authorization pauses only cloud sync; local Mirna remains usable.
- Rollback/fork and financial conflicts use clear warnings and never silently
  overwrite local unsynced data.
- Revocation explains the difference between blocking future server access and
  excluding future key epochs; it never claims remote erasure of a stolen
  device.
- Turnstile is a visible React-managed card with explicit loading, waiting,
  token, server-verifying, success, expiry, rejection, network and
  configuration states. Retry never reuses a token and preserves an already
  prepared activation lifecycle.
- Beta diagnostics displays Support ID and Request ID and explicitly states
  that reports must not contain financial data or secrets.

## Operational constraints

- Exact allowlisted CORS origins; never wildcard authenticated CORS.
- `Cache-Control: no-store`, strict JSON content types, `nosniff`,
  `Referrer-Policy: no-referrer`, consistent safe errors and no response stack
  traces.
- No sync API response enters the PWA cache; no vault key/decrypted data enters
  the service worker.
- Logs exclude authorization, tokens, pairing/recovery material, raw bodies,
  ciphertext, full vault IDs and financial content.
- Source-controlled global/per-vault hard budgets reserve work atomically and
  fail closed; D1 service flags can pause creation, pairing or writes without a
  public administration route.
- Turnstile protects only anonymous vault/pairing/recovery initiation and checks
  Siteverify success, exact hostname and action. It supplements rather than
  replaces D1 attempt counters, rate limits and cryptographic authorization.
- No production resource or paid Cloudflare capability is provisioned by this
  beta work.

## Review and production gate

Before any production enablement, Mirna requires independent review of the
threat model, cryptographic construction, recovery, revocation/rotation,
conflict behavior, dependencies and staging adversarial results, plus a manual
two-device mobile/desktop pairing exercise. Automated internal review is not an
independent security audit.
