# Privacy

Mirna is a local-first application.

## Local records

Accounts, transactions, plans, goals, debts, and settings are stored in
IndexedDB for the current browser origin. Mirna has no account system, bank
connection or analytics. The published stable application has no cloud sync.

Mirna does not provide application-level encryption. Anyone who can access the
unlocked browser profile or device may be able to read local records.

## Network boundary

The hosting provider, browser, and network process ordinary web-request
metadata when application files are downloaded. Mirna does not attach
financial records to those requests.

## Experimental encrypted sync

The `2.4.0-beta.1` beta source includes optional accountless encrypted sync.
It is feature-flagged, staging-only, not deployed to production and still
requires independent security review. When disabled, it makes no sync requests.

When a user explicitly enables it, the browser encrypts finance snapshots and
operations before upload. The sync service receives ciphertext plus unavoidable
operational metadata such as opaque vault/device identifiers, public keys,
authorization and request timing, approximate sizes, IP/network information,
key epochs and server cursors. It does not receive the vault master key,
recovery root, device private keys or plaintext finance content.

Friendly device names and coarse device types are stored only in a dedicated
local IndexedDB directory. They are excluded from ordinary finance backup,
encrypted sync snapshots and protocol requests. Automatic synchronization runs
inside the foreground application; the service worker does not receive finance
plaintext or keys and does not perform killed-process encrypted sync.

End-to-end encryption does not protect an unlocked or compromised device and
does not hide traffic timing or sizes. Local finance tables remain readable to
the browser profile; sync does not add application-level encryption at rest to
those existing tables.

## Exports and AI Plan Bridge

JSON, CSV, and Markdown exports are plaintext files created locally at the
user's request. The user decides where to save or share them. Ordinary backups
exclude sync keys, recovery material, sessions and sync protocol stores.

Blueprint and Patch do not call an AI provider. Copying or sharing a prompt or
plan context is an explicit action. After information is shared with ChatGPT,
Claude, Gemini, or another external service, that service's privacy terms and
retention rules apply.

## Retention and deletion

Records remain until Mirna or the browser deletes them. Clearing site data,
switching browser profiles, or removing a PWA can make records unrecoverable.
A separately stored JSON backup is the recovery mechanism for local finance
data. Deleting the encrypted cloud vault removes remote ciphertext and sync
metadata but deliberately keeps local finance data. Clearing the browser or
removing the PWA may also destroy local device and recovery capabilities.

## Public project data

Issues, discussions, and test fixtures must use synthetic data. Do not attach
real exports, screenshots, access tokens, or personal financial records.
