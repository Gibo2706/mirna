# Mirna

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People recording and planning their personal money every day, primarily on a phone.

## Product Purpose

Help people understand what they can safely spend, record what happened to their money, and prepare for upcoming obligations without learning an internal accounting model.

## Operating Context

Local-first, offline-capable personal finance PWA. Serbian Latin interface and integer RSD amounts. Desktop supports deeper planning and review. Optional end-to-end encrypted sync connects devices.

## Capabilities and Constraints

- Accounts, income, expenses, transfers, savings goals, recurring commitments, budgets, events, debts and forecast scenarios.
- Ledger-derived balances and activity are authoritative. Transfers are neither income nor expenses. Opening balances and adjustments are not income.
- Protected savings are excluded from spendable cash. A goal target remains unchanged when saved money is used; reserve goals can refill.
- Actual payment dates are separate from the occurrence being paid. Existing expenses can be associated with plans without duplicating money.
- Preserve React, Dexie, routing and the E2EE protocol. Use the existing audited command layer for mutations.
- Financial invariants are defined in docs/FINANCIAL-INVARIANTS.md.

## Brand Commitments

Keep the Mirna name and identity. Calm, clear Serbian language. The requested craft references are modern banking utilities, Monzo, YNAB clarity and Apple Settings hierarchy. Avoid generic SaaS dashboards, decorative card repetition and glassmorphism.

## Evidence on Hand

Production code and tests, docs/FINANCIAL-INVARIANTS.md, and synthetic fixtures under src/tests/fixtures. Never present synthetic financial data as real customer evidence.

## Product Principles

1. The same movement of money has the same meaning through every entry point.
2. Make consequences visible before changing saved money.
3. Preserve financial identity, history, privacy and atomicity.
4. Put daily decisions ahead of secondary settings and diagnostics.
5. Keep forms and long Serbian labels usable on small phones.

## Accessibility & Inclusion

Semantic buttons and dialog titles, visible keyboard focus, status/error announcements, minimum 44px touch targets, reduced motion, sufficient contrast and status labels that do not rely on color. Supported phone widths include 320, 360, 390, 412 and 430px.
