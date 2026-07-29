# Security model

## Trust boundaries

Mirna is a static PWA. Code and assets are downloaded from an HTTPS origin;
financial state is stored in that origin's IndexedDB. There is no Mirna API or
server-side financial database.

The browser profile, device, hosting origin, export destination, and any
external service receiving copied data are separate trust boundaries.

## Controls

- Strict TypeScript and Zod schemas constrain imported data.
- Full imports are validated before one atomic Dexie replacement transaction.
- Plan Patch permits only an explicit field and operation allowlist.
- Blueprint and Patch reject ledger history, payment state, internal IDs, and
  existing-balance changes.
- Content Security Policy limits scripts, connections, workers, framing, and
  form targets to local application needs.
- The service worker precaches only application-shell assets.
- Repository and reachable-history checks reject risky paths, common secret
  forms, archives, exports, and workstation paths.
- CI has read-only repository permission and no deployment step or production
  secrets.

## Limitations

- A compromised device, browser profile, dependency, or hosting origin can
  expose local data.
- Browser storage is not guaranteed durable and is not encrypted by Mirna.
- Plaintext exports leave Mirna's control after saving or sharing.
- CSP permits inline styles required by the current UI toolchain.
- Deterministic invariants protect financial correctness; external AI output is
  never authoritative.

Changes to storage, imports, service workers, CSP, exports, or AI bridge formats
need focused tests and review against these boundaries.
