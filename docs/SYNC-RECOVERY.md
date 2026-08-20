# Mirna Encrypted Sync — Recovery

Status: protocol v1 recovery design for stable `2.4.1`
Deployment boundary: configured production, beta and local clients
Implementation status: client/Worker recovery, current-snapshot recovery and
atomic sole-device key/recovery rotation are implemented; pairing/bootstrap/
sync have completed a real staging exercise, while independent security review
remains pending

## What recovery can and cannot do

The recovery code is an accountless client-side capability. It is designed to
let a person who lost every authorized device decrypt the server-held recovery
envelope locally, authorize a replacement device and replace the recovery
capability. The sync service does not receive the secret portion of the code and
does not have a support or administrator decrypt path.

The required user warning is:

> If every authorized device and the recovery code are lost, encrypted cloud
> data cannot be recovered.

Recovery is not a password reset. Support cannot recreate the vault master key,
and a server database copy alone cannot decrypt the recovery bundle.

A stolen recovery code is powerful. An attacker who has the complete code and
can reach the service may recover the vault unless the old recovery record has
already been rotated or invalidated. Printed, downloaded and copied recovery
codes therefore require the same physical care as other high-value secrets.

## Recovery material

Initial setup creates all of the following locally with
`crypto.getRandomValues` or Web Crypto:

- `recoveryLookupId`: 16 random bytes, represented as a 22-character canonical
  base64url opaque ID;
- `recoveryRoot`: 32 random bytes and the secret component of the code;
- a P-256 ECDSA recovery signing key pair;
- an AES-256-GCM recovery wrapping key derived from the root;
- a separate 32-byte online HMAC gate value derived from the root;
- an encrypted recovery bundle bound to the current vault, epoch and manifest.

The lookup ID is not treated as secret. It lets the service locate a bounded
record without receiving a vault ID in the recovery code. The recovery root is
secret and MUST never be sent, logged, placed in a request URL or persisted in
ordinary Mirna storage.

The recovery signing key has a different job from the online HMAC gate. The
ECDSA public key is pinned in the signed vault manifest. Its private PKCS8 bytes
exist only inside the encrypted recovery bundle. The HMAC value only gates an
online attempt; it is not authority for client membership.

## Recovery code format

The canonical code is:

```text
MR1-XXXX-XXXX-...-XXXX
```

After the `MR1-` prefix there are exactly 84 Crockford Base32 characters,
grouped into 21 blocks of four. The decoded 52 bytes are:

```text
recoveryLookupId[16] || recoveryRoot[32] || checksum[4]
```

The checksum is:

```text
first 4 bytes of SHA-256(
  UTF8("MIRNA-RECOVERY-CODE-V1")
  || 0x00
  || recoveryLookupId[16]
  || recoveryRoot[32]
)
```

Canonical output is uppercase and uses the Crockford alphabet. Input may map
`O` to `0` and `I`/`L` to `1`, ignore grouping separators, and then MUST verify
the exact decoded length and checksum. The checksum detects transcription
errors; it does not turn the code into a low-entropy password.

The code does not contain the vault ID, vault master key, finance data or a
private device key.

## Key derivation and separation

The recovery root is the only HKDF input key material. The vault master key is
not an input to either recovery derivation.

First compute:

```text
recoverySalt = SHA-256(
  UTF8("MIRNA-E2EE-V1/recovery-salt")
  || 0x00
  || recoveryLookupId[16]
)
```

The canonical context is:

```json
{
  "protocolVersion": 1,
  "suite": "MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1",
  "vaultId": "OPAQUE_VAULT_ID",
  "recoveryLookupId": "OPAQUE_LOOKUP_ID"
}
```

HKDF-SHA-256 derives two independent values:

| Purpose                   | HKDF `info`                                                            | Output                          |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------- |
| Local recovery decryption | `concat("MIRNA-E2EE-V1/recovery-wrap-key", 0x00, JCS(context))`        | non-extractable AES-256-GCM key |
| Online recovery gate      | `concat("MIRNA-E2EE-V1/recovery-server-gate-key", 0x00, JCS(context))` | 32-byte HMAC gate key           |

Knowing the online gate value must not reveal the wrapping key. Neither value is
reused for manifest signatures, device authentication, pairing or finance
objects.

## Encrypted recovery bundle

Before encryption, the strict bundle contains:

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

`manifestHash` is the SHA-256 hash of the domain-separated canonical manifest
body; it excludes the manifest signature. This pin lets a recovered client
reject a server-supplied first manifest that does not match the state trusted at
setup/rotation.

The bundle is JCS-serialized and encrypted locally with AES-256-GCM under the
recovery wrapping key. Its AAD includes:

```text
protocolVersion
suite
vaultId
keyEpoch
objectType = recovery-vault-key
objectId
creatingDeviceId
recoveryLookupId
parentManifestHash = manifestHash
```

The envelope has a fresh random object ID and 12-byte nonce. Decryption MUST
check that vault ID, lookup ID, epoch and manifest hash match across the outer
envelope, AAD and decrypted bundle before importing or using any key.

## What the service stores

The recovery record contains only:

- protocol and suite;
- opaque vault and recovery lookup IDs;
- key epoch;
- the encrypted recovery bundle envelope, nonce and clear AAD;
- the recovery signing public key;
- a domain-separated SHA-256 hash of the 32-byte online gate key;
- update/rotation and bounded attempt state.

The service MUST NOT store the code, root, wrapping key, recovery signing
private key, decrypted bundle or vault master key. It also MUST NOT log the
entered code, proof body, envelope ciphertext or raw request body.

The service can still observe recovery timing, network metadata, lookup
attempts, ciphertext size and whether a bounded attempt succeeded. It can also
delete or withhold the envelope.

## Why HMAC is not recovery authority

The service challenges a recovery client with a one-time, short-lived transcript
of type `mirna-recovery-proof-v1`. The transcript binds:

- protocol version and vault;
- challenge ID and 32-byte challenge;
- proposed new device ID and both public keys;
- issue and expiry time.

The client proves the online gate value with HMAC-SHA-256 over JCS bytes of that
strict transcript. The service consumes the challenge once and updates an
authoritative D1 attempt counter. Edge rate limiting is additional abuse
control, not exact recovery state.

This HMAC proves possession only to the service. A copied D1 record contains
only the gate-key hash and cannot produce the proof. A compromised Worker can
observe a gate key presented during a live recovery, but key separation means
it still does not reveal the recovery wrapping key and cannot by itself produce
a client-accepted membership change.

The actual `recover-device` manifest transition MUST be signed by the previous
recovery ECDSA private key from the decrypted bundle. Clients verify it against
the recovery signing public key in the prior pinned manifest. A server-created
self-signed replacement manifest or an HMAC-only membership transition is
invalid.

## End-to-end recovery sequence

The protocol-v1 recovery flow proceeds in this order:

1. The user intentionally opens recovery and enters or imports the code locally.
2. The client parses the prefix, canonical Crockford form, exact length and
   checksum before making a network request.
3. The client uses only the lookup ID to request a one-time recovery challenge.
4. The client derives the online gate value and submits an HMAC proof bound to
   the newly generated device public keys and exact challenge.
5. The service enforces expiry, one-time use, attempt/lock state and a uniform
   public error policy before returning the encrypted record.
6. The client derives the wrapping key and decrypts the bundle locally.
7. The client verifies the bundle identity, epoch, recovery public key and
   manifest-body pin, then verifies the complete manifest chain it receives.
8. The client imports the recovery signing private key only into Web Crypto,
   creates a `recover-device` transition for its new non-extractable device keys
   and signs that transition.
9. The service validates the HMAC lifecycle and the recovery ECDSA transition,
   then atomically advances membership without treating D1 as the cryptographic
   authority.
10. The recovered client creates a new random vault key/epoch, lookup ID, root
    and recovery signing key pair, encrypts a new bundle pinned to the proposed
    sole-device `recover-device` transition, and authorizes that complete
    transition with the prior recovery key.
11. One compare-and-swap transaction installs the manifest, sole active device,
    new random epoch and recovery record, and invalidates the old lookup/gate
    hash. Exact retries return the retained committed result and never
    reactivate the old code.
12. The user explicitly acknowledges saving the new recovery code before the
    client reports recovery complete.

Steps 9–12 require failure injection between storage operations. A response
loss after a successful commit must be retryable without creating two active
recovery authorities. A failure before commit must leave the previous code
usable rather than leaving the vault without recovery.

The Worker routes, Serbian UI and atomic transition are implemented locally.
Failure/race tests cover stale challenges, one-time consumption, retry response
loss and compare-and-swap contention. These gates do not replace an independent
review.

## Lost or compromised device policy

Adding a recovered device does not erase a lost device and does not make an old
vault key disappear. If recovery is used because a device may be stolen or
compromised, completion additionally requires:

1. revoke the old device in a signed manifest transition;
2. generate a new random 32-byte vault master key;
3. increment the key epoch;
4. encrypt a new snapshot under the new epoch;
5. wrap the new key separately for each remaining active device;
6. replace the recovery bundle under the new root and epoch;
7. prevent the revoked device from receiving any new envelope.

The new vault key MUST be random and MUST NOT be derived from the old key. A
revoked device still knows all plaintext and old keys it obtained before
rotation. Forward exclusion applies only to content created under the completed
new epoch.

For a committed snapshot, the recovery client first downloads the current
ciphertext through a recovery-authorized route, verifies its manifest/device
signature chain and decrypts it locally under the old key. The atomic recovery
transaction then revokes every old device/grant/session, installs the sole new
device and random key epoch, supersedes the old snapshot and clears the current
pointer. The recovered client retains the verified finance data locally and the
continuous service publishes a fresh snapshot under the new epoch. If any
verification fails, recovery stops before the membership transition.

## Recovery rotation without device loss

An authorized user should be able to rotate recovery material while a trusted
device remains available. Rotation creates a new code and signing key, updates
the encrypted bundle, signs a `rotate-recovery` manifest transition with the old
recovery authority, commits with expected recovery/manifest versions, and then
invalidates the prior verifier.

The old code must fail uniformly after commit. The new code is not considered
usable until the user explicitly acknowledges safe storage locally. The service must
retain at most the minimum retry metadata needed to distinguish a completed
rotation from a new request; it does not retain both active roots.

## User experience and custody

### Setup

The code is shown intentionally once after sync setup. Before activation, the
user must explicitly acknowledge that it was saved in a safe place. Copy,
download or print never checks the acknowledgement automatically. The UI must
explain that the service cannot recover the vault without the code.

Allowed explicit actions are:

- copy after a user gesture;
- download as a plain-text recovery document;
- print-friendly view;
- locally generated QR view when privacy and shoulder-surfing risk are clear.

The app must not auto-copy the code. It must not include the code in analytics,
error reports, support diagnostics, screenshots or accessibility snapshots
unless the user has explicitly opened the sensitive value.

### Storage advice

Keep the code offline or in a trusted password manager, separate from the only
authorized device. A printout should be stored where unauthorized people cannot
photograph or copy it. Deleting the downloaded file does not guarantee secure
erasure on flash storage or cloud-backed folders.

### Wrong, old or damaged code

The client should distinguish local formatting/checksum errors from a generic
server refusal without exposing whether an arbitrary lookup exists. An old code
after successful rotation is intentionally invalid. Repeated online failures
trigger a bounded delay/lock; they must not create an unlimited brute-force or
resource-exhaustion path.

## Browser and endpoint limitations

Recovery protects against loss of local keys only while the code and encrypted
server record remain available. It does not protect against:

- malicious JavaScript executing at the trusted Mirna origin while the bundle
  is decrypted;
- a malicious browser extension or compromised operating system reading input
  or memory;
- an unlocked stolen device exfiltrating plaintext;
- browser storage eviction of unsynced local finance data;
- the service deleting or withholding ciphertext;
- a copied recovery code being used before rotation.

Temporary byte buffers are cleared on a best-effort basis, but JavaScript does
not provide a perfect secure-erasure guarantee. Existing finance IndexedDB data
is not automatically application-encrypted by sync.

## Backup and export separation

Ordinary Mirna JSON backups, CSV exports, Markdown exports and diagnostics MUST
exclude:

- the recovery code and root;
- the lookup-to-root combination;
- the recovery wrapping and online gate keys;
- the recovery signing private key;
- the vault master key and local wrapping key;
- device private keys and access sessions.

The explicit recovery-code download is a separate sensitive artifact. Importing
an ordinary Mirna backup must never silently replace or export sync recovery
state.

## Required recovery gate

Recovery is not complete until focused tests cover at least:

- canonical code generation, aliases, grouping, checksum and fixed vectors;
- a wrong, truncated, changed-prefix and old rotated code;
- derivation separation between wrapping and online gate values;
- recovery-envelope ciphertext, nonce and AAD tampering;
- wrong vault, lookup ID, epoch, manifest hash and recovery public key;
- copied D1 gate value failing to create an accepted manifest transition;
- replayed/expired/consumed challenges and strict attempt limits;
- recovery ECDSA transition validation and signature substitution;
- atomic recovery rotation, response-loss retry and old-verifier invalidation;
- lost-device revocation plus random vault-key/epoch rotation;
- absence of recovery secrets and known finance plaintext in server storage,
  logs, API bodies and ordinary backups;
- IndexedDB close/reopen behavior for non-extractable device/local keys;
- multi-browser loss-and-recovery behavior using synthetic finance data only.

Passing internal tests is necessary but is not an independent security audit.
Recovery is available with configured sync in 2.4.1; the independent review
gate remains an explicit security caveat.
