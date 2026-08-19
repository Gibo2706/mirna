# Changelog

All notable changes to Mirna are documented here.

## [2.4.0-beta.1] - Unreleased

### Added

- Added optional, accountless end-to-end encrypted sync behind an explicit
  feature flag, with local-first behavior preserved when disabled.
- Added recovery-code setup, authenticated two-device pairing with SAS,
  encrypted snapshot bootstrap, continuous encrypted operations and explicit
  conflict resolution.
- Added expiring device authorization, signed renewal, recovery-backed device
  revocation with a fresh vault-key epoch, and resumable encrypted cloud-vault
  deletion that retains local finance data.
- Added a Cloudflare Worker with strict protocol-v1 routes, D1 migrations,
  private R2 snapshot storage, bounded cleanup and local Worker/browser gates.
- Added D1-backed rolling/daily hard budgets, per-vault quotas, R2 object
  inventory, source-controlled caps and operator kill switches.
- Added dedicated beta Turnstile validation for anonymous vault, pairing and
  recovery initiation plus beta-only marking and crawler exclusion.
- Added a visible React-owned Managed Turnstile widget, explicit verification
  states and fresh-token retry.
- Added beta-only privacy-safe Support ID/Request ID diagnostics with a local
  200-event IndexedDB ring, strict 14-day D1 retention and bounded operator
  lookup.
- Added one app-level sync runtime so cold start, ordinary finance mutations,
  reconnect and stale foreground resume synchronize without visiting settings.
- Added coalesced/deferred scheduler wake-ups, hidden-page polling suspension,
  persistent service-limit pause handling and automatic paired-device download.
- Added local-only friendly device aliases and a consumer-oriented sync screen;
  protocol IDs and support diagnostics now stay behind technical details.

### Security

- Device private keys and local wrapping keys are non-extractable Web Crypto
  keys; access sessions remain memory-only and D1 stores token hashes.
- Snapshot and operation ciphertext is signed and bound to strict AAD, manifest
  and causal chains; unknown fields, versions and crypto suites fail closed.
- Ordinary JSON backups explicitly exclude sync state and secret material.
- Stable feature-off Vercel CSP no longer authorizes the staging Worker or
  challenge origin; beta retains an exact environment-gated allowlist.
- Fixed staging Siteverify failures caused by an undersized Worker timeout and
  a strict parser that did not accept Cloudflare's observed bounded `messages`
  response field.
- Stable production remains disabled. The dedicated beta target is isolated at
  `mirna-finansije-beta.vercel.app`; independent security review is pending.

## [2.3.2] - 2026-07-30

### Changed

- Completed the final public-source privacy cleanup with fully synthetic
  regression scenarios.
- Replaced private-era legacy goal IDs with generic goal-event-account
  migration inference.
- Polished public documentation in English with a Serbian Latin README.
- Adopted the canonical GNU AGPL version 3 text under `AGPL-3.0-only`.
- Added a proportional brand policy and third-party dependency notices.
- Added individual copyright attribution and canonical public-repository
  metadata.
- Rebuilt both READMEs as concise product pages with reproducible, synthetic
  real-UI screenshots and a GitHub social preview.
- Hardened repository, reachable-history, CI, and source-package checks.

### Security

- The production dependency audit reported no vulnerabilities at release time.
- Remaining audit findings were limited to development tooling; no breaking
  forced upgrade was applied.

## [2.3.1] - 2026-07-29

### Added

- Onboarding choice for income timing and first-goal purpose.
- Explicit unresolved Blueprint account balances using `null`.
- Safe Patch operation for a new goal with a linked zero-balance protected account.
- Public repository safety and source packaging scripts.
- CI, Dependabot, community templates and public architecture/security docs.

### Changed

- Regression fixtures and browser scenarios now use clearly synthetic data.
- README and public documentation are concise and public-safe.
- Repository, deployment and editor ignore policies are hardened.

### Security

- Upgraded to patched React Router 8.3.0 and brace-expansion 5.0.8.
- Blueprint import is blocked until every unknown account balance is resolved.
- General Patch account creation and all external balance injection remain forbidden.
- CI uses a read-only repository token and contains no deployment step.

## [2.3.0] - 2026-07-28

- Added generic onboarding, product tour, Blueprint v1 and Patch v1.
- Improved mobile financial-management layouts and PWA lifecycle UX.
