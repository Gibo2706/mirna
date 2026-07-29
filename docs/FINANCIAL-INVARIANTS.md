# Financial invariants

These rules are authoritative across UI, database commands, imports and tests.

## Ledger

- Money is stored as integer RSD.
- Opening balance is initial state, not income.
- Income and expense affect one account.
- A transfer is one ledger record with source and destination; it is neither
  income nor expense.
- Adjustment changes balance but is excluded from income/expense reporting.
- An occurrence, debt payment or paid event cannot create duplicate ledger
  effects.

## Plans

- Planned income, commitments, budgets and events do not become actual
  transactions without an explicit user action.
- Income already included in the onboarding balance starts its plan next month;
  no synthetic receipt is created.
- One primary salary plan may be active in the dataset.
- Monthly overrides preserve historical plans.

## Goals and protected money

- Every goal references one protected savings account.
- Two goals cannot share the same protected account.
- Transfers fund a goal; they do not create money.
- A new Patch-created goal account always has opening balance 0.
- Protected money is excluded from spendable cash.
- A sinking goal may be marked used only through its linked event lifecycle.
- A reserve remains replenishable and cannot use the sinking-goal `usedAt`
  state.
- When migrating a legacy goal without a type, Mirna infers `sinking` only if a
  planned event references that goal and uses its linked account. Other legacy
  goals default to `reserve`.

## Debt and events

- Debt repayments cannot exceed original debt.
- Self-funded repayment creates an expense and a linked payment record.
- External repayment reduces debt without creating a personal cash expense.
- Paid event and transaction links are bidirectional and unique.

## Import boundary

- Validate shape, references and full integrity before writing.
- Replace full data only in one transaction.
- Unknown Blueprint balance is `null`; import is blocked until the user enters
  an explicit integer, including explicit zero.
- Patch never mutates actual ledger history or existing balances.
