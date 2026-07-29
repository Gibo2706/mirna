# Architecture

Mirna is a static React PWA with a local Dexie database. The application has no
financial-data backend.

## Code layout

```text
src/
  app/          routing, PWA lifecycle, theme, and error boundaries
  components/   application shell and reusable UI primitives
  db/           Dexie schema, reads, and atomic commands
  domain/       types, recurrence, integrity, and financial calculations
  features/     user-facing product areas
  pages/        route-level composition
  tests/        factories and clearly synthetic fixtures
e2e/            browser acceptance flows
public/         icons and static PWA assets
```

## Data flow

Pages and features read a snapshot through the database query layer. Mutations
go through database commands, which own validation, relationship checks, and
transactions. Financial calculations remain pure domain functions and do not
live in JSX.

```text
UI → validated command → atomic Dexie write → snapshot query → pure calculation → UI
```

## Import boundaries

JSON backup restore validates shape and complete referential integrity before
replacing data in one transaction. Blueprint and Patch are narrower plan
formats: both reject actual ledger history and internal state. Patch uses an
operation allowlist and a review screen.

Backup schema versions 1 and 2 are migrated deterministically to version 3.
Legacy goal types are inferred from goal-event-account relationships, never
from special record IDs.

## Version and release metadata

`package.json` is the single application-version source. The About screen,
backup metadata, and Markdown export import that value through
`src/lib/version.ts`. Backup schema versioning is independent from the
application version.

## PWA boundary

Vite creates the production assets and Workbox manifest. Only application-shell
files are precached. IndexedDB data is not part of the service-worker cache.
