---
name: Mirna
description: Calm personal finance for daily decisions on a phone.
colors:
  accent: '#2f7d64'
  background: '#f6f6f3'
  surface: '#ffffff'
  foreground: '#171a18'
  muted: '#606963'
  border: '#dde1dc'
  warning: '#865014'
  danger: '#b84343'
typography:
  body:
    fontFamily: 'Manrope Variable, Manrope, Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: '16px'
    fontWeight: 400
  money:
    fontFamily: 'Manrope Variable, Manrope, Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: '36px'
    fontWeight: 800
    letterSpacing: '-0.03em'
rounded:
  control: '12px'
  card: '16px'
spacing:
  small: '8px'
  content: '16px'
  section: '24px'
---

## Overview

Mirna is a daily money tool. One prominent safe-to-spend amount anchors the dashboard. Other information uses divided lists, concise labels and consistent financial signs. Preserve the product's Serbian language and identity.

## Colors

Use the CSS variables in `src/index.css`, including their dark appearance overrides. Green indicates positive money/status and primary actions; red indicates expenses/errors; amber indicates attention. Always accompany status colors with text. Charts use these same tokens.

## Typography

Manrope is the existing self-hosted typeface. Tabular numerals align money; readable labels carry hierarchy without uppercase eyebrows. Income uses +, expense uses −, and transfers remain neutral with account direction. Use integer RSD formatting.

## Layout

Mobile pages have 16px gutters. Page actions follow the heading on small screens and sit beside it when space permits. Maintain at least 44px touch targets. At desktop widths, related finance sections form two columns; avoid repeating metric tiles. Month uses aligned plan/actual/remaining rows. Support 320–430px phones, safe areas and scrolling sheets.

## Elevation & Depth

Dividers separate content. Cards have borders without shadows. Reserve elevation for the floating add action and modal overlays; no decorative blur or gradient blobs.

## Shapes

Controls use modest rounded corners. Primary dashboard summary and dialogs may have larger radii. Avoid nested cards and icon tiles.

## Components

`PageHeader` handles wrapping actions. `Sheet` supplies a title, description, close control and scrolling body. `.sheet-actions` keeps the primary action available. `AccountPicker` shows current balance and savings status. `ProtectedSpendingPreview` explains before/after money and unchanged target. Tappable finance rows open details; frequent payment and transfer actions remain directly available.

## Do's and Don'ts

- Show real ledger balances and paid versus planned status.
- Keep details and destructive actions inside the relevant sheet.
- Explain disabled financial actions and prevent duplicate submission.
- Do not classify transfers as income or expenses.
- Do not hide meaningful reconciliation failures or expose internal diagnostic jargon as routine status.
- Do not add libraries to reproduce reference components.
