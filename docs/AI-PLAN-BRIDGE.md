# AI Plan Bridge

Mirna Plan Bridge is provider-neutral and user-mediated. Mirna has no AI SDK,
API key or automatic network call.

## Blueprint v1

Blueprint configures a new or empty installation. It may contain accounts,
categories, planned income, commitments, budgets, goals, debts, events,
scenarios and quick-entry presets.

It cannot contain transactions, payments, paid state, internal IDs or backup
metadata. An unknown account balance must be `null`; Mirna asks the user for the
actual value and blocks import until all balances are resolved. Zero means an
explicitly confirmed empty account.

## Patch v1

Patch proposes allowlisted changes to an existing plan using stable references
from a locally generated context. The user sees a diff before applying it.

Patch cannot change actual transactions, existing account balances, debt
payment history, event payment state or internal metadata. Normal account
creation is rejected.

The special `addGoalWithProtectedAccount` operation creates exactly two linked
records in one local transaction:

1. a protected savings account with opening balance 0;
2. a goal linked to that account.

The external tool cannot provide a balance for this operation, and the preview
states that no money is created.

## Safe usage

- Share only the minimum context needed.
- Remove notes that should not leave the device.
- Treat generated JSON as a proposal, not financial advice.
- Verify names, amounts, dates, references and goal type in Mirna's preview.
- Use JSON backup, not Blueprint, to restore real application history.
