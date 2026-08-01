import { describe, expect, it } from 'vitest';
import {
  createBackupEnvelope,
  createChatGptMarkdown,
  createTransactionsCsv,
  describeImportSchemaVersion,
  exportFullBackup,
  parseBackup,
  replaceWithBackup,
} from './backup';
import { db, financeTables } from '@/db/database';
import {
  checking,
  emptyFinanceData,
  expenseCategory,
  incomeCategory,
  savings,
  settings,
  tx,
} from '@/tests/factories';

describe('export and import formats', () => {
  it('round-trips a complete JSON backup with relationships intact', () => {
    const data = emptyFinanceData();
    data.goals.push({
      id: 'goal',
      name: 'Štednja',
      emoji: '🎯',
      targetAmount: 20_000,
      linkedAccountId: savings.id,
      plannedMonthlyContribution: 10_000,
      contributionOverrides: {},
      goalType: 'reserve',
      archived: false,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    data.transactions.push(
      tx({
        id: 'transfer',
        type: 'transfer',
        amount: 10_000,
        toAccountId: savings.id,
        source: 'goal',
        goalId: 'goal',
      }),
    );
    const envelope = createBackupEnvelope(data, new Date('2026-07-28T10:00:00.000Z'));
    const preview = parseBackup(JSON.stringify(envelope));
    expect(preview.envelope.data).toEqual(data);
    expect(preview.counts.transactions).toBe(1);
  });

  it('labels every supported source schema explicitly and rejects future schemas', () => {
    expect(describeImportSchemaVersion(1)).toBe('stari v1 format — biće bezbedno migriran');
    expect(describeImportSchemaVersion(2)).toBe('v2 format — biće bezbedno migriran');
    expect(describeImportSchemaVersion(3)).toBe('aktuelni v3 format');

    const future = {
      ...createBackupEnvelope(emptyFinanceData()),
      schemaVersion: 4,
    };
    expect(() => parseBackup(JSON.stringify(future))).toThrow('Backup nije validan');
  });

  it('migrates a v1 backup to v3 and preserves ledger balances', () => {
    const current = emptyFinanceData();
    current.goals.push({
      id: 'goal',
      name: 'Laboratorijska oprema',
      emoji: '🔬',
      targetAmount: 46_800,
      linkedAccountId: savings.id,
      plannedMonthlyContribution: 12_700,
      contributionOverrides: {},
      goalType: 'reserve',
      archived: false,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    current.transactions.push(
      tx({ id: 'income', type: 'income', amount: 18_300, categoryId: incomeCategory.id }),
    );
    const legacyData = structuredClone(current) as unknown as Record<string, unknown>;
    delete legacyData.plannedIncomes;
    for (const goal of legacyData.goals as Array<Record<string, unknown>>) {
      delete goal.contributionOverrides;
      delete goal.contributionStartMonth;
      delete goal.contributionEndMonth;
      delete goal.goalType;
      delete goal.usedAt;
    }
    for (const debt of legacyData.debts as Array<Record<string, unknown>>) {
      delete debt.paymentOverrides;
    }
    for (const payment of legacyData.debtPayments as Array<Record<string, unknown>>) {
      delete payment.source;
    }
    const preview = parseBackup(
      JSON.stringify({
        schemaVersion: 1,
        exportedAt: '2026-07-28T10:00:00.000Z',
        application: { name: 'Mirna', version: '1.0.0', currency: 'RSD' },
        data: legacyData,
      }),
    );
    expect(preview.sourceSchemaVersion).toBe(1);
    expect(preview.envelope.schemaVersion).toBe(3);
    expect(preview.envelope.data.transactions).toEqual(current.transactions);
    expect(preview.envelope.data.goals[0]?.contributionOverrides).toEqual({});
    expect(preview.envelope.data.goals[0]?.goalType).toBe('reserve');
    expect(preview.envelope.data.plannedIncomes).toMatchObject([
      { amount: settings.baseMonthlyIncome, isPrimarySalary: true },
    ]);
    expect(
      parseBackup(JSON.stringify(createBackupEnvelope(preview.envelope.data))).envelope.data,
    ).toEqual(preview.envelope.data);
  });

  it('migrates v2 goals using synthetic event-account relationships and preserves ledger history', () => {
    const current = emptyFinanceData();
    const reserveAccount = {
      ...savings,
      id: 'reserve-account',
      name: 'Rezervni fond',
      openingBalance: 3_700,
    };
    current.accounts.push(reserveAccount);
    current.goals.push({
      id: 'goal_training',
      name: 'Stručna radionica',
      emoji: '🧪',
      targetAmount: 48_600,
      linkedAccountId: savings.id,
      plannedMonthlyContribution: 14_400,
      contributionOverrides: { '2027-02': 14_400 },
      goalType: 'sinking',
      archived: false,
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    current.goals.push({
      id: 'goal_buffer',
      name: 'Rezervni fond',
      emoji: '🛟',
      targetAmount: 22_200,
      linkedAccountId: reserveAccount.id,
      plannedMonthlyContribution: 3_700,
      contributionOverrides: {},
      goalType: 'reserve',
      archived: false,
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    current.plannedEvents.push({
      id: 'event_training',
      title: 'Stručna radionica',
      date: '2027-03-18',
      plannedAmount: 48_600,
      categoryId: expenseCategory.id,
      accountId: savings.id,
      linkedGoalId: 'goal_training',
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    const legacyData = structuredClone(current) as unknown as Record<string, unknown>;
    for (const goal of legacyData.goals as Array<Record<string, unknown>>) {
      delete goal.goalType;
      delete goal.usedAt;
    }
    const balancesBefore = structuredClone(current.accounts);
    const transactionsBefore = structuredClone(current.transactions);
    const preview = parseBackup(
      JSON.stringify({
        schemaVersion: 2,
        exportedAt: '2027-01-28T10:00:00.000Z',
        application: { name: 'Mirna', version: '2.0.0', currency: 'RSD' },
        data: legacyData,
      }),
    );

    expect(preview.sourceSchemaVersion).toBe(2);
    expect(preview.envelope.schemaVersion).toBe(3);
    expect(preview.envelope.data.accounts).toEqual(balancesBefore);
    expect(preview.envelope.data.transactions).toEqual(transactionsBefore);
    expect(preview.envelope.data.goals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'goal_training',
          goalType: 'sinking',
          contributionOverrides: { '2027-02': 14_400 },
        }),
        expect.objectContaining({
          id: 'goal_buffer',
          goalType: 'reserve',
        }),
      ]),
    );
  });

  it('uses the paid transaction date for legacy sinking-goal usedAt metadata', () => {
    const current = emptyFinanceData();
    current.goals.push({
      id: 'goal_training',
      name: 'Stručna radionica',
      emoji: '🧪',
      targetAmount: 48_600,
      linkedAccountId: savings.id,
      plannedMonthlyContribution: 14_400,
      contributionOverrides: {},
      goalType: 'sinking',
      archived: false,
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    current.transactions.push(
      tx({
        id: 'training-paid',
        type: 'expense',
        amount: 48_600,
        accountId: savings.id,
        categoryId: expenseCategory.id,
        date: '2027-03-19',
        source: 'planned-event',
        plannedEventId: 'training',
      }),
    );
    current.plannedEvents.push({
      id: 'training',
      title: 'Stručna radionica',
      date: '2027-03-18',
      plannedAmount: 48_600,
      categoryId: expenseCategory.id,
      accountId: savings.id,
      linkedGoalId: 'goal_training',
      paidTransactionId: 'training-paid',
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    const legacyData = structuredClone(current) as unknown as Record<string, unknown>;
    for (const goal of legacyData.goals as Array<Record<string, unknown>>) {
      delete goal.goalType;
      delete goal.usedAt;
    }
    const preview = parseBackup(
      JSON.stringify({
        schemaVersion: 2,
        exportedAt: '2027-03-20T10:00:00.000Z',
        application: { name: 'Mirna', version: '2.0.0', currency: 'RSD' },
        data: legacyData,
      }),
    );

    expect(preview.envelope.data.goals[0]?.usedAt).toBe('2027-03-19');
    expect(preview.envelope.data.transactions).toEqual(current.transactions);
  });

  it('rejects a structurally valid backup with a broken account reference', () => {
    const data = emptyFinanceData();
    data.transactions.push(tx({ id: 'bad', type: 'expense', amount: 100, accountId: 'missing' }));
    expect(() => createBackupEnvelope(data)).toThrow('nepoznat račun');
  });

  it('rejects forbidden negative money during schema validation', () => {
    const envelope = createBackupEnvelope(emptyFinanceData());
    envelope.data.accounts[0].openingBalance = -1;
    envelope.data.plannedIncomes.push({
      id: 'salary',
      name: 'Plata',
      amount: -100,
      categoryId: incomeCategory.id,
      accountId: checking.id,
      frequency: 'monthly',
      startDate: '2026-07-01',
      active: true,
      isPrimarySalary: true,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    expect(() => parseBackup(JSON.stringify(envelope))).toThrow('Backup nije validan');
  });

  it('rolls back every table when a replacement write fails', async () => {
    await db.transaction('rw', financeTables(), async () => {
      await Promise.all(financeTables().map((table) => table.clear()));
    });
    const original = parseBackup(JSON.stringify(createBackupEnvelope(emptyFinanceData())));
    await replaceWithBackup(original);

    const replacement = parseBackup(JSON.stringify(createBackupEnvelope(emptyFinanceData())));
    replacement.envelope.data.transactions.push(
      tx({
        id: 'duplicate-one',
        type: 'expense',
        amount: 100,
        categoryId: expenseCategory.id,
        occurrenceKey: 'duplicate-occurrence',
      }),
      tx({
        id: 'duplicate-two',
        type: 'expense',
        amount: 100,
        categoryId: expenseCategory.id,
        occurrenceKey: 'duplicate-occurrence',
      }),
    );

    await expect(replaceWithBackup(replacement)).rejects.toThrow();
    expect(await db.accounts.toArray()).toEqual(original.envelope.data.accounts);
    expect(await db.transactions.toArray()).toEqual([]);
    expect(await db.settings.toArray()).toEqual(original.envelope.data.settings);
  });

  it('keeps every sync store and secret sentinel out of an ordinary JSON backup', async () => {
    const finance = emptyFinanceData();
    await replaceWithBackup(parseBackup(JSON.stringify(createBackupEnvelope(finance))));
    await db.syncMetadata.put({
      id: 'sync-metadata',
      vaultId: 'SYNC_VAULT_SENTINEL',
      localSchemaVersion: 1,
      firstUploadConsent: 'accepted',
      lastServerCursor: 0,
      lastSnapshotServerCursor: 0,
      lastSnapshotRevision: 0,
      lastSnapshotId: null,
      lastSnapshotHash: null,
      lastSnapshotContentHash: null,
      lastManifestHash: 'SYNC_SECRET_SENTINEL',
      lastLocalDataHash: null,
      enabledAt: '2026-07-31T10:00:00.000Z',
    });

    try {
      const backup = await exportFullBackup();
      const exported = JSON.parse(backup.content) as Record<string, unknown>;

      expect(Object.keys(exported).sort()).toEqual([
        'application',
        'data',
        'exportedAt',
        'schemaVersion',
      ]);
      expect(backup.content).not.toContain('SYNC_VAULT_SENTINEL');
      expect(backup.content).not.toContain('SYNC_SECRET_SENTINEL');
      expect(parseBackup(backup.content).envelope.data).toEqual(finance);
    } finally {
      await db.syncMetadata.clear();
    }
  });

  it('escapes CSV values and creates a useful Markdown snapshot', () => {
    const data = emptyFinanceData();
    data.transactions.push(
      tx({
        id: 'expense',
        type: 'expense',
        amount: 410,
        categoryId: expenseCategory.id,
        description: 'Kafa, "velika"',
        notes: 'red 1\nred 2',
      }),
    );
    const snapshot = { ...data, settingsRecord: settings };
    const csv = createTransactionsCsv(snapshot);
    expect(csv).toContain('"Kafa, ""velika"""');
    expect(csv).toContain('"red 1 red 2"');

    const markdown = createChatGptMarkdown(snapshot, new Date('2026-07-28T12:00:00.000Z'));
    expect(markdown).toContain('# Mirna Financial Snapshot');
    expect(markdown).toContain('- appVersion:');
    expect(markdown).toContain('- backupSchemaVersion: 3');
    expect(markdown).toContain('- currency: RSD');
    expect(markdown).toContain('## Current actual balances');
    expect(markdown).toContain('- Total actual cash:');
    expect(markdown).toContain('## Balance adjustments');
    expect(markdown).toContain('## Cash ledger reconciliation');
    expect(markdown).toContain('## Planned income');
    expect(markdown).toContain('## Forecast');
    expect(markdown).toContain('Monthly plan balance');
    expect(markdown).not.toContain('Monthly net flow');
    expect(markdown).toContain('## Recent notable transactions');
    expect(markdown).toContain('## Major irregular expenses — last 180 days');
    expect(markdown).toContain(
      '- 15.07.2026 — 410 RSD — Trošak — Kafa, "velika" — note: red 1 red 2 — classification: unplanned/ad-hoc',
    );
    expect(markdown).toContain('- Status: OK');
    expect(markdown).toContain(checking.name);
  });

  it('exports signed adjustments and reconciles a synthetic cash ledger exactly', () => {
    const current = { ...checking, name: 'Tekući račun', openingBalance: 2_400 };
    const cash = {
      ...savings,
      id: 'cash',
      name: 'Keš',
      openingBalance: 0,
      protected: false,
    };
    const data = emptyFinanceData();
    data.accounts = [current, cash];
    data.transactions = [
      tx({
        id: 'salary',
        type: 'income',
        amount: 72_800,
        accountId: current.id,
        categoryId: incomeCategory.id,
        date: '2026-07-05',
      }),
      tx({
        id: 'expenses',
        type: 'expense',
        amount: 48_300,
        accountId: current.id,
        categoryId: expenseCategory.id,
        date: '2026-07-28',
      }),
      tx({
        id: 'checking-adjustment',
        type: 'adjustment',
        amount: -3_200,
        accountId: current.id,
        date: '2026-07-28',
        description: 'Usklađivanje stanja — Tekući račun',
        notes: 'Sintetičko početno usklađivanje',
        source: 'adjustment',
      }),
      tx({
        id: 'cash-adjustment-one',
        type: 'adjustment',
        amount: 1_500,
        accountId: cash.id,
        date: '2026-07-28',
        description: 'Usklađivanje stanja — Keš',
        source: 'adjustment',
      }),
      tx({
        id: 'cash-adjustment-two',
        type: 'adjustment',
        amount: 450,
        accountId: cash.id,
        date: '2026-07-28',
        description: 'Sitno usklađivanje — Keš',
        source: 'adjustment',
      }),
    ];

    const markdown = createChatGptMarkdown(
      { ...data, settingsRecord: settings },
      new Date('2026-07-28T12:00:00.000Z'),
    );

    expect(markdown).toContain(
      '- 28.07.2026 — Tekući račun — -3.200 RSD\n  - Usklađivanje stanja — Tekući račun\n  - note: Sintetičko početno usklađivanje',
    );
    expect(markdown).toContain('- 28.07.2026 — Keš — +1.500 RSD');
    expect(markdown).toContain('- 28.07.2026 — Keš — +450 RSD');
    expect(markdown).toContain('- Opening balances: 2.400 RSD');
    expect(markdown).toContain('- Recorded income: 72.800 RSD');
    expect(markdown).toContain('- Recorded expenses: 48.300 RSD');
    expect(markdown).toContain('- Net balance adjustments: -1.250 RSD');
    expect(markdown).toContain('- Expected current total: 25.650 RSD');
    expect(markdown).toContain('- Actual current total: 25.650 RSD');
    expect(markdown).toContain('- Difference: 0 RSD');
    expect(markdown.match(/- Status: OK/g)).toHaveLength(2);
  });
});
