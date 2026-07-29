# Contributing

[Issues](https://github.com/Gibo2706/mirna/issues), feature ideas, design
proposals, bug reports, and synthetic reproductions are welcome.

## Current contribution status

No contributor agreement is active yet. Until contributor terms are finalized,
external code and documentation changes are not merged. A draft pull request
may be used for technical discussion, but it will not be accepted into the
project during this temporary pause.

Do not submit real financial data, private exports, credentials, or another
person's work as a reproduction.

## Development

Mirna uses Node 22 and the committed lockfile. With NVM:

```bash
nvm use
npm ci
npm run check
npm run test:e2e
```

## Financial and privacy rules

- Read `docs/FINANCIAL-INVARIANTS.md` before changing calculations or writes.
- Keep plans separate from actual ledger transactions.
- Store money as integer RSD and keep domain rules deterministic.
- Validate a complete import before one atomic replacement transaction.
- Use synthetic names, amounts, dates, screenshots, and fixtures.
- Never commit exports, backups, credentials, private records, or
  machine-specific paths.
- Open an issue before introducing analytics, cloud sync, authentication,
  remote financial-data transmission, or third-party AI SDKs because these
  would change Mirna's privacy model.

## Change quality

Keep one concern per change. Explain the user-visible result, affected
financial invariants, risk, and verification. Add focused tests for behavior
changes.

Before presenting a change for discussion:

```bash
npm run public:check
npm run public:history
npm run check
npm run test:coverage
npm run test:e2e
npm audit --audit-level=high
```

Generated reports do not belong in the repository. Security reports follow
`SECURITY.md` and the planned
[GitHub Security page](https://github.com/Gibo2706/mirna/security), never a
public issue with vulnerability details.
