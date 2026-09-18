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
- Savings actuals count user transfers from non-protected to protected accounts,
  including historical manual and Quick Add deposits without `goalId`. The
  destination account determines the goal. System-linked funding is excluded.
- Savings actuals are gross deposits; withdrawals do not erase previous deposits.
  A withdrawal moves cash to a spendable account without income, expense, target
  changes or automatic sinking-goal completion.
- Accounts with ledger history cannot change their protected classification;
  goals with account history cannot be reassigned to another account.
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

## Commitment payments

- The planned occurrence identifies which obligation is paid. Actual amount,
  account and payment date describe the real ledger movement independently.
- Linking an independent manual expense preserves its ID, amount, account and
  date; it changes classification without inserting another expense. Amount
  differences require explicit confirmation.
- Savings-funded payment creates one protected-to-spendable transfer and one
  commitment expense in the same audited transaction and sync mutation group.
  The funding occurrence key is `commitment-funding:<payment occurrence key>`.
- Funding and payment must agree on amount, date and payment account at the
  import/sync integrity boundary. Deleting the payment removes both records;
  funded payments cannot be unlinked while leaving funding behind.
- Unlinking an unfunded commitment payment preserves the expense and reopens
  the planned occurrence. Deletions cannot leave negative account balances.

## Import boundary

- Validate shape, references and full integrity before writing.
- Replace full data only in one transaction.
- Unknown Blueprint balance is `null`; import is blocked until the user enters
  an explicit integer, including explicit zero.
- Patch never mutates actual ledger history or existing balances.
