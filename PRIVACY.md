# Privacy

Mirna is a local-first application.

## Local records

Accounts, transactions, plans, goals, debts, and settings are stored in
IndexedDB for the current browser origin. Mirna has no application backend,
account system, bank connection, analytics, or cloud synchronization.

Mirna does not provide application-level encryption. Anyone who can access the
unlocked browser profile or device may be able to read local records.

## Network boundary

The hosting provider, browser, and network process ordinary web-request
metadata when application files are downloaded. Mirna does not attach
financial records to those requests.

## Exports and AI Plan Bridge

JSON, CSV, and Markdown exports are plaintext files created locally at the
user's request. The user decides where to save or share them.

Blueprint and Patch do not call an AI provider. Copying or sharing a prompt or
plan context is an explicit action. After information is shared with ChatGPT,
Claude, Gemini, or another external service, that service's privacy terms and
retention rules apply.

## Retention and deletion

Records remain until Mirna or the browser deletes them. Clearing site data,
switching browser profiles, or removing a PWA can make records unrecoverable.
A separately stored JSON backup is the recovery mechanism.

## Public project data

Issues, discussions, and test fixtures must use synthetic data. Do not attach
real exports, screenshots, access tokens, or personal financial records.
