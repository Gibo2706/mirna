# Mirna Encrypted Sync — Protocol V1

Status: frozen core cryptographic profile for experimental `2.4.0-beta.1`
Protocol version: `1`
Deployment boundary: staging only
Interoperability status: incomplete until all Phase 1–3 schemas and routes pass
their gates

## Normative scope

The words **MUST**, **MUST NOT**, **SHOULD** and **MAY** describe protocol v1
requirements. The core encoding, signature, manifest, pairing-secret and
recovery profiles in this document are frozen. Snapshot and operation sections
describe the required direction but are not a claim that their complete wire
schemas or Worker routes are implemented.

An implementation MUST reject an unknown protocol version, suite, transcript
type, object type, command type or unexpected JSON field. It MUST NOT negotiate
a weaker algorithm or reinterpret a v1 value using a later format.

The only v1 suite is:

```text
MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1
```

There is no compatibility fallback.

## Notation and canonical encoding

| Notation       | Meaning                                                             |
| -------------- | ------------------------------------------------------------------- |
| `JCS(x)`       | UTF-8 bytes of RFC 8785 JSON Canonicalization Scheme output for `x` |
| `UTF8(s)`      | UTF-8 encoding of string `s`                                        |
| `0x00`         | one zero byte used as a domain separator                            |
| `concat(a, b)` | byte concatenation                                                  |
| `DS(label, x)` | `concat(UTF8(label), 0x00, JCS(x))`                                 |
| `SHA256(x)`    | 32-byte SHA-256 digest                                              |
| `HMAC(k, x)`   | HMAC-SHA-256 with key `k`                                           |
| `b64u(x)`      | canonical, unpadded RFC 4648 base64url                              |

All binary JSON fields use canonical unpadded base64url. A decoder MUST reject
padding, non-alphabet characters, non-canonical encodings and an impossible
length. Common exact encoded lengths are:

| Raw value                           | Bytes | Base64url characters |
| ----------------------------------- | ----: | -------------------: |
| Opaque ID                           |    16 |                   22 |
| SHA-256 value or 256-bit capability |    32 |                   43 |
| AES-GCM nonce                       |    12 |                   16 |
| P-256 public key                    |    65 |                   87 |
| P-256 signature                     |    64 |                   86 |

Protocol JSON is RFC 8785 JCS with a deliberately narrower input profile. It
accepts only null, booleans, strings, arrays, plain objects and finite safe
integers. It rejects floating-point values, negative zero, unsupported values,
lone Unicode surrogates, non-plain objects and cycles. Protocol data therefore
MUST represent currency as integer RSD values and timestamps as strict ISO 8601
strings where a schema calls for them.

See [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) and
[RFC 4648](https://www.rfc-editor.org/rfc/rfc4648.html).

## Registered values

### Object types

```text
local-vault-key
recovery-vault-key
pairing-vault-key
snapshot
operation
device-key-envelope
```

### Transcript types

```text
mirna-auth-challenge-v1
mirna-vault-manifest-v1
mirna-pairing-envelope-v1
mirna-pairing-finalize-v1
mirna-sensitive-request-v1
mirna-snapshot-envelope-v1
mirna-operation-envelope-v1
mirna-recovery-proof-v1
```

### HKDF labels

```text
MIRNA-E2EE-V1/snapshot-object-key
MIRNA-E2EE-V1/operation-object-key
MIRNA-E2EE-V1/recovery-wrap-key
MIRNA-E2EE-V1/recovery-server-gate-key
MIRNA-E2EE-V1/pairing-vmk-envelope-key
MIRNA-E2EE-V1/pairing-key-confirmation
MIRNA-E2EE-V1/pairing-claim-token
MIRNA-E2EE-V1/pairing-transcript-mac-key
MIRNA-E2EE-V1/pairing-sas-key
MIRNA-E2EE-V1/device-envelope-key
```

A registered label is purpose-specific. Values derived under one label MUST NOT
be substituted for another purpose.

## P-256 public keys and signatures

Signing uses ECDSA P-256 with SHA-256. Agreement uses ECDH P-256 followed by
HKDF-SHA-256. Public keys have exactly this JSON form:

```json
{
  "format": "raw-p256",
  "value": "BASE64URL_OF_65_BYTES"
}
```

The decoded value MUST be the 65-byte uncompressed SEC1 point
`0x04 || X[32] || Y[32]`. Compressed points, JWK wire values and other curves
are not valid protocol v1 public keys.

An ECDSA signature is exactly the 64-byte IEEE-P1363 value `r[32] || s[32]`.
The P-256 group order is:

```text
FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
```

Both scalars MUST be in range. The signer normalizes `s` to low-S, and the
verifier rejects a signature unless `1 <= s <= floor(n / 2)`. DER-encoded or
high-S signatures are not accepted.

A domain-separated signature over body `x` and label `L` is:

```text
ECDSA-P256-SHA256(privateKey, DS(L, x))
```

Private device keys MUST be generated non-extractable. The recovery signing
private key is exportable only so its PKCS8 bytes can be placed inside the
encrypted recovery bundle; it MUST NOT be exported or stored separately in
plaintext.

## AES-256-GCM envelopes

AES-GCM uses:

- a 32-byte AES key;
- a fresh 12-byte nonce;
- a 128-bit authentication tag;
- `JCS(aad)` as additional authenticated data.

Web Crypto returns and accepts `ciphertext || tag`; that complete byte string is
the envelope `ciphertext` field after base64url encoding. The tag is not split
into another JSON field.

A caller MUST create a new random object ID and nonce whenever plaintext or
protected metadata changes. Idempotent retry is the only case where an existing
nonce is reused: the client resends the exact frozen ciphertext envelope rather
than encrypting again.

## Object key derivation

The vault master key is 32 random bytes and never crosses the service boundary.
For a snapshot or operation, define:

```json
{
  "protocolVersion": 1,
  "suite": "MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1",
  "vaultId": "OPAQUE_ID",
  "keyEpoch": 1,
  "objectType": "snapshot-or-operation",
  "objectId": "OPAQUE_ID",
  "purpose": "snapshot-or-operation"
}
```

The HKDF salt is:

```text
SHA256(DS("MIRNA-E2EE-V1/object-salt", {
  protocolVersion,
  suite,
  vaultId,
  keyEpoch
}))
```

The HKDF input key material is the current vault master key. HKDF `info` is:

```text
UTF8(purpose-specific-label) || 0x00 || JCS(full-object-context)
```

The derived non-extractable AES-256-GCM key is valid only for that object and
purpose. A fresh 96-bit nonce is still mandatory.

## Encrypted key envelope

`EncryptedKeyEnvelopeV1` contains:

```text
protocolVersion
suite
vaultId
keyEpoch
objectId
nonce
aad
ciphertext
```

Its strict AAD contains:

```text
protocolVersion
suite
vaultId
keyEpoch
objectType
objectId
creatingDeviceId
recoveryLookupId
parentManifestHash
```

`objectType` is one of `local-vault-key`, `recovery-vault-key` or
`pairing-vault-key`. `recoveryLookupId` is populated only for a recovery
envelope and is otherwise null. Envelope and AAD vault, epoch and object IDs
MUST match exactly before decryption. The parent manifest-body hash binds the
wrapped key to accepted membership state.

## Vault manifest

### Body and signature

The unsigned `VaultManifestV1` body has exactly these fields:

```text
type = mirna-vault-manifest-v1
protocolVersion
suite
vaultId
manifestVersion
keyEpoch
devices[]
revokedDevices[]
recoverySigningPublicKey
previousManifestHash
transition
```

Each active device contains its opaque ID, signing/agreement public keys,
`authorizedAt` and `authorizationExpiresAt`. Each revoked entry retains its
public keys, revocation time and author, and the last manifest version in which
it was authorized. Device arrays are sorted by device ID and contain no ID in
both sets.

The signature field is not part of the manifest body. Define:

```text
manifestBytes = DS("MIRNA-E2EE-V1/manifest-body", manifestBody)
manifestHash  = b64u(SHA256(manifestBytes))
signature     = b64u(ECDSA-P256-SHA256(authorityPrivateKey, manifestBytes))
```

Client pins always use `manifestHash`; they never hash a signature field.
Consequently, ECDSA representation variance cannot create a second manifest
identity.

### Genesis and transitions

Genesis has version 1, key epoch 1, one active device, no revoked device, no
previous hash and transition kind `create`. It is self-signed by that device.
This is trust on first use, not proof supplied by the service.

Every later manifest increments the manifest version by exactly one and names
the previous manifest-body hash. The supported transitions are:

| Transition        | Authority                  | Required effect                                                   |
| ----------------- | -------------------------- | ----------------------------------------------------------------- |
| `add-device`      | active, non-expired device | add exactly one device without changing epoch or recovery key     |
| `renew-device`    | active, non-expired device | extend exactly one device authorization without changing its keys |
| `revoke-device`   | active, non-expired device | move exactly one active device to the revoked set                 |
| `rotate-key`      | active, non-expired device | increment only the key epoch in the manifest step                 |
| `recover-device`  | prior recovery signing key | add the recovered device under recovery authority                 |
| `rotate-recovery` | prior recovery signing key | replace only the recovery signing public key                      |

The full secure-revocation workflow additionally creates a new random vault
master key and new envelopes outside the manifest body. Incrementing the epoch
without completing those steps does not provide forward exclusion.

A device-authorized transition is verified with the authorizing device key from
the previous accepted manifest. A recovery transition is verified with the
recovery public key from that previous manifest. The service's D1 device row or
recovery gate-hash record cannot replace either signature authority.

### Pinning

For a locally pinned `(manifestVersion, manifestHash)` pair, a client MUST:

- reject a lower version;
- reject a different body hash for the same version;
- require the next manifest's `previousManifestHash` to equal the pin;
- verify each intervening transition when more than one version must be
  traversed;
- update the durable pin only after the full transition is accepted.

Pairing authenticates the first pin with the pairing-secret transcript MAC.
Recovery authenticates it with the hash inside the decrypted recovery bundle.
A server-provided self-signature alone is insufficient for a new device.

## Pairing protocol

### Pairing code

The new device generates independent random values:

- pairing request ID: 16 bytes;
- pairing root: 32 bytes;
- pairing salt: 32 bytes;
- polling token: 32 bytes;
- device signing and agreement key pairs.

The manual code is:

```text
MIRNA-P1- + grouped Crockford Base32(payload || checksum)

payload  = protocolVersion[1] || requestId[16] || pairingRoot[32] || pairingSalt[32]
checksum = first 4 bytes of SHA256(payload)
```

The checksum detects transcription errors; it is not authorization. Canonical
output uses the Crockford alphabet and grouped uppercase characters. Input may
map `O` to `0` and `I`/`L` to `1` before checksum validation.

The QR payload is generated locally and uses the exact expected Mirna origin,
path `/more/sync`, and URL fragment `#pair=...`. Fragment material is not sent
as an HTTP request target. The parser MUST reject a different origin or path.
No vault key, recovery root, finance content or private device key appears in
the QR.

### Pairing-secret separation

The root is HKDF input key material and the 32-byte pairing salt is HKDF salt.
The common derivation context is:

```json
{
  "protocolVersion": 1,
  "suite": "MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1",
  "origin": "EXACT_HTTPS_OR_LOCALHOST_ORIGIN",
  "pairingRequestId": "OPAQUE_ID",
  "pairingSalt": "BASE64URL_32_BYTES"
}
```

Three independent 32-byte values are derived with these `info` values:

```text
UTF8("MIRNA-E2EE-V1/pairing-claim-token") || 0x00 || JCS(context)
UTF8("MIRNA-E2EE-V1/pairing-transcript-mac-key") || 0x00 || JCS(context)
UTF8("MIRNA-E2EE-V1/pairing-sas-key") || 0x00 || JCS(context)
```

The new-device creation request sends only the SHA-256 hash of the claim token
and an independent polling-token hash. The existing device presents the claim
token when inspecting/approving. The Worker never receives the pairing root,
transcript-MAC key or SAS key.

### ECDH wrapping and transcript binding

The approving device creates a fresh ephemeral ECDH key pair and performs ECDH
with the new device's static agreement public key. The 32-byte shared secret is
HKDF input key material, the pairing salt is HKDF salt, and wrapping-key `info`
is:

```text
UTF8("MIRNA-E2EE-V1/pairing-vmk-envelope-key")
|| 0x00
|| SHA256(DS("MIRNA-E2EE-V1/pairing-context", wrappingContext))
```

The shared ECDH bytes are cleared on a best-effort basis after derivation.

The strict v1 pairing transcript MUST bind at least:

- exact Mirna origin and pairing request ID;
- initial/parent manifest pin and candidate manifest-body hash;
- both devices' IDs and both signing/agreement public-key sets;
- authorizing device identity;
- the fresh ephemeral agreement public key;
- vault ID, suite, protocol version and key epoch;
- snapshot/head revision and causal frontier offered to the new device;
- the protected key-envelope digest and byte length.

The pairing transcript MAC is:

```text
b64u(HMAC(transcriptMacKey,
  DS("MIRNA-E2EE-V1/pairing-transcript-mac", pairingTranscript)))
```

The approving device also signs the strict envelope/transcript with its device
signing key. The new device MUST validate its own identity and key set, the
request, origin, manifest pins, epoch, ECDH key, AAD, ciphertext digest/length,
device signature and pairing MAC before decrypting or finalizing.

The cryptographic derivation helpers exist, but the complete strict transcript
schema and Worker enforcement remain a Phase 1 gate. Pairing is not complete
until those are implemented and adversarially tested.

### Short Authentication String

The SAS is keyed; it is not a truncation of public data and is not an encryption
key. Define:

```text
digest = HMAC(sasKey,
  UTF8("MIRNA-E2EE-V1/pairing-sas")
  || 0x00
  || SHA256(JCS(pairingTranscript))
  || pairingTranscriptMac[32])
```

The UI uses the first eight digest bytes as four uppercase hexadecimal groups:

```text
XXXX-XXXX-XXXX-XXXX
```

Both devices display and explicitly confirm the same value. A mismatch or user
rejection cancels and invalidates the request.

### Lifecycle

Pairings are one-time, expire after five minutes, allow at most five failed
attempts, are cancellable and are limited to three active requests per vault.
Finalization is signed by the new device and binds the request, new device,
candidate manifest hash, envelope hash and confirmation time. A second
finalization MUST be idempotently rejected or return the already finalized
result without creating another device.

## Recovery protocol

### Recovery code

Recovery uses an independent 16-byte lookup ID and 32-byte random root. The code
is exactly:

```text
MR1- + 84 Crockford Base32 characters grouped in blocks of four

payload  = recoveryLookupId[16] || recoveryRoot[32]
checksum = first 4 bytes of SHA256(
  UTF8("MIRNA-RECOVERY-CODE-V1") || 0x00 || payload
)
```

The decoded payload plus checksum is exactly 52 bytes. The lookup ID is opaque
and not secret; the root is a powerful client-side secret and never reaches the
service.

### Key separation

Define:

```text
recoverySalt = SHA256(
  UTF8("MIRNA-E2EE-V1/recovery-salt")
  || 0x00
  || recoveryLookupId[16]
)
```

The strict recovery context is:

```json
{
  "protocolVersion": 1,
  "suite": "MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1",
  "vaultId": "OPAQUE_ID",
  "recoveryLookupId": "OPAQUE_ID"
}
```

With the recovery root as HKDF input key material and `recoverySalt` as salt:

- the AES-256-GCM wrapping key uses
  `MIRNA-E2EE-V1/recovery-wrap-key || 0x00 || JCS(context)`;
- the 32-byte online gate value uses
  `MIRNA-E2EE-V1/recovery-server-gate-key || 0x00 || JCS(context)`.

Neither derivation includes the vault master key. The service retains only
`SHA256(domain || 0x00 || gateKey)` and receives the gate key transiently with
a challenge-bound proof. The stored hash MUST NOT allow derivation of either
recovery-derived key.

### Encrypted recovery bundle

The encrypted bundle contains exactly:

```text
protocolVersion
suite
vaultId
recoveryLookupId
keyEpoch
vaultMasterKey
recoverySigningPrivateKeyPkcs8
recoverySigningPublicKey
manifestHash
```

It is encrypted locally under the recovery wrapping key with
`objectType = recovery-vault-key`, the same lookup ID and epoch, and
`parentManifestHash = manifestHash`. Decryption MUST reject any mismatch among
the envelope, AAD and bundle before using a key.

The service record contains the encrypted bundle envelope, recovery signing
public key, online gate verifier, lookup ID, epoch and update time. It cannot
decrypt the bundle.

### Online proof versus membership authority

The HMAC proof is over JCS bytes of a strict
`mirna-recovery-proof-v1` challenge transcript containing the vault, one-time
challenge identity/value, proposed new device keys, issue time and expiry. It
authorizes one bounded online recovery attempt and is subject to an
authoritative D1 attempt counter.

The HMAC is not a client trust anchor. A recovery manifest transition MUST be
signed with the recovery ECDSA private key recovered from the encrypted bundle
and verified against the recovery public key in the previously pinned manifest.
D1 stores only a domain-separated hash of the gate key. A D1-only compromise
therefore cannot produce the challenge-bound HMAC proof. A compromised Worker
executing a live recovery can observe the presented gate key, but it does not
reveal the separately derived wrapping key and cannot create a client-accepted
transition without the recovery signing private key.

Successful recovery MUST rotate the recovery root, lookup ID, gate verifier and
recovery signing key, and invalidate the prior record. Replacing a lost or
suspected device also requires revocation and completion of a fresh random vault
master key/key-epoch rotation before claiming forward exclusion.

The Phase 1 route and client lifecycle implement this as one sole-device,
new-epoch, new-recovery transition and retain an exact completion response for
bounded idempotent retry. It currently refuses a vault that already has a
committed cloud snapshot; Phase 2 must add snapshot re-encryption and atomic
reference rotation before general post-snapshot recovery is complete. See
[SYNC-RECOVERY.md](./SYNC-RECOVERY.md) for operational details.

## Device authentication and sessions

A challenge request names protocol version, vault ID, device ID and one exact
audience. Supported sensitive audiences currently include session creation,
pairing approval/cancellation, device renewal/revocation, recovery rotation and
vault deletion.

The Worker creates a transcript containing:

```text
type = mirna-auth-challenge-v1
protocolVersion
vaultId
deviceId
challengeId
challenge[32]
issuedAt
expiresAt
audience
```

The device signs the canonical transcript. The Worker resolves its signing key
only from current authorized membership, verifies the exact audience, refuses
expired/revoked grants and consumes the challenge once.

A successful session response returns a random 32-byte access token, session
expiry and device-authorization expiry. The session is about 15 minutes and the
device grant is 30 days. D1 stores only the access-token hash; the browser keeps
the token only in memory. A token alone cannot add, renew or revoke a device,
rotate recovery or keys, or delete a vault. Those operations require a fresh
audience-bound signature.

The Worker challenge/session routes and memory-only browser transport are
implemented locally. Remote staging behavior is not verified until the staging
gate passes.

## Snapshot protocol requirements

Phase 2 will define strict `SyncSnapshotV1` plaintext and
`EncryptedSnapshotEnvelopeV1` clear metadata. The clear envelope is limited to
vault/object identity, revision and base revision, key epoch, creating device,
nonce/AAD, compression mode, ciphertext length/hash, previous accepted snapshot
hash, protocol/suite and signature. Finance state and causal data stay inside
the ciphertext.

Snapshots MUST:

- use a unique object key and nonce;
- be signed as a complete envelope;
- be at most 8 MiB encrypted in staging;
- be streamed through the Worker to private R2;
- use an atomic D1 `currentRevision == baseRevision` compare-and-swap;
- use a stable idempotency key;
- leave a durable cleanup record before R2 upload;
- be pinned and checked for rollback/fork by clients;
- be schema/integrity validated and atomically applied after local decryption;
- never overwrite dirty local state after remote advancement.

Compression, if used, is an authenticated `gzip` or explicit `none` mode and
happens before encryption. Phase 2 is not implemented end to end, so no complete
snapshot wire schema is declared interoperable yet.

## Operation protocol requirements

Phase 3 will define strict encrypted `SyncOperationV1` commands. Plaintext inside
the ciphertext includes operation/device identity, per-device sequence, Lamport
value, causal frontier, allowlisted command and payload, entity precondition,
previous device-operation hash, epoch and local creation time. Arbitrary table
writes, scripts and unrestricted JSON Patch are forbidden.

The server-visible envelope contains only the opaque operation ID, device ID and
sequence, epoch, nonce/AAD, ciphertext size/hash, signature and accepted server
cursor. One operation is limited to 64 KiB and one batch to 100 operations.

Uniqueness on `(vaultId, operationId)` and
`(vaultId, deviceId, deviceSequence)` provides storage idempotence. Clients
still verify signatures, hash chains and causal frontiers because a server cursor
is not cryptographic ordering. Tombstones and compacted operations remain until
the required authorized-device acknowledgement policy permits deletion.

Phase 3 is not implemented end to end, so no complete operation wire schema is
declared interoperable yet.

## HTTP profile

All sync routes live under `/v1`. Security-sensitive JSON schemas are strict and
reject unknown fields. State-changing browser requests require an exact allowed
`Origin`; authenticated routes never use wildcard CORS.

Responses use a protocol field or explicit protocol header and, where
applicable:

```text
Cache-Control: no-store
Content-Type: application/json; charset=utf-8
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

Unexpected methods/content types, oversized bodies and unsupported versions are
rejected before expensive work. Public errors are stable and generic; they do
not contain stack traces, secret values or storage/account identifiers.

The intended small API surface includes health, vault creation, authentication,
manifest transitions, pairing, devices, snapshots, changes,
acknowledgements, recovery and vault deletion. At the time of this document,
only the Worker foundation and `GET /v1/health` are implemented. Other endpoint
names are not a compatibility promise until their schemas and tests land.

## Limits and lifetimes

| Limit                     |       Protocol v1 staging value |
| ------------------------- | ------------------------------: |
| Devices per vault         |                              10 |
| Active pairings per vault |                               3 |
| Pairing lifetime          |                       5 minutes |
| Pairing attempts          |                               5 |
| Challenge lifetime        |                       2 minutes |
| Access session            |                      15 minutes |
| Device authorization      |                         30 days |
| Authorization warning     |            5 days before expiry |
| Recovery attempts         |      5 before delay/lock policy |
| Snapshot ciphertext       |                           8 MiB |
| Operation ciphertext      |                          64 KiB |
| Operations per batch      |                             100 |
| Retained snapshots        | 3 plus bounded transition grace |
| Orphan lifetime           |                          1 hour |

Rate limiting is defense in depth. Exact pairing/recovery attempt state is
authoritative in D1 and MUST be updated atomically. A rate-limit binding is not
authentication, quota accounting or a replay defense.

## Security limitations

Protocol v1 protects finance payload confidentiality against a storage-only
compromise when clients and cryptographic code behave as specified. It does not
hide service metadata, prevent deletion/withholding, remotely erase an old
device, protect plaintext on an unlocked compromised endpoint or make a
malicious authorized device trustworthy.

This profile has not passed an independent security audit. It must remain
feature-flagged and staging-only until every phase gate and the independent
review gate pass.
