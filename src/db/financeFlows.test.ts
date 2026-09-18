import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavingsGoal } from '@/domain/types';
import {
  calculateAccountBalances,
  calculateMonthlyFinancialSummary,
  reconcileCashLedger,
} from '@/domain/calculations';
import { assertFinanceDataIntegrity } from '@/domain/integrity';
import { getAllCommitmentOccurrences } from '@/domain/recurrence';
import {
  checking,
  savings,
  expenseCategory,
  monthlyCommitment,
  settings,
  tx,
} from '@/tests/factories';
import { db, financeTables } from './database';
import { readFinanceData } from './queries';
import {
  deleteGoal,
  deleteTransaction,
  linkTransactionToCommitment,
  markCommitmentPaid,
  saveTransaction,
  saveAccount,
  saveGoal,
  unlinkCommitmentPayment,
  withdrawFromGoal,
} from './commands';
import {
  ACTIVE_SYNC_VAULT_RECORD_ID,
  LOCAL_SYNC_DEVICE_RECORD_ID,
  SYNC_METADATA_RECORD_ID,
  type SyncVaultRecord,
  type SyncDeviceRecord,
  type SyncMetadataRecord,
} from './sync/records';
import { parseSyncMutationIntent } from './sync/mutation-audit';

const goal: SavingsGoal = {
  id: 'rent-goal',
  name: 'Stan',
  emoji: 'S',
  linkedAccountId: savings.id,
  targetAmount: 30_000,
  plannedMonthlyContribution: 30_000,
  contributionOverrides: {},
  goalType: 'reserve',
  archived: false,
  createdAt: checking.createdAt,
};
const rent = { ...monthlyCommitment, name: 'Stan', amount: 30_000, dueDay: 1, endDate: undefined };
const payment = {
  occurrenceKey: 'commitment:2026-10-01',
  name: rent.name,
  amount: rent.amount,
  date: '2026-10-01',
  accountId: checking.id,
  categoryId: expenseCategory.id,
};
const enableSync = async () => {
  const vaultId = 'V'.repeat(22);
  await db.syncVault.put({
    id: ACTIVE_SYNC_VAULT_RECORD_ID,
    vaultId,
    status: 'active',
    keyEpoch: 1,
  } as SyncVaultRecord);
  await db.syncDevice.put({
    id: LOCAL_SYNC_DEVICE_RECORD_ID,
    vaultId,
    deviceId: 'D'.repeat(22),
  } as SyncDeviceRecord);
  await db.syncMetadata.put({
    id: SYNC_METADATA_RECORD_ID,
    vaultId,
    bootstrapMode: 'complete',
  } as SyncMetadataRecord);
};
const balances = async () =>
  calculateAccountBalances(await db.accounts.toArray(), await db.transactions.toArray());

describe('real savings and commitment flows', () => {
  beforeEach(async () => {
    await db.transaction(
      'rw',
      [...financeTables(), db.syncVault, db.syncDevice, db.syncMetadata, db.syncOutbox],
      async () => {
        await Promise.all(
          [...financeTables(), db.syncVault, db.syncDevice, db.syncMetadata, db.syncOutbox].map(
            (table) => table.clear(),
          ),
        );
      },
    );
    await db.accounts.bulkAdd([checking, { ...savings, openingBalance: 30_000 }]);
    await db.categories.add(expenseCategory);
    await db.goals.add(goal);
    await db.commitments.add(rent);
    await db.settings.add(settings);
  });
  afterEach(() => vi.restoreAllMocks());

  it('preserves the savings meaning of recorded account and goal history', async () => {
    await saveTransaction(
      tx({ id: 'history', type: 'transfer', amount: 500, toAccountId: savings.id }),
    );
    await expect(saveAccount({ ...savings, protected: false })).rejects.toThrow('namenu štednje');
    const other = { ...savings, id: 'other' };
    await saveAccount(other);
    await expect(saveGoal({ ...goal, linkedAccountId: other.id })).rejects.toThrow('istorijom');
    await expect(saveAccount({ ...checking, openingBalance: 0 })).rejects.toThrow('ispod nule');
    expect((await db.goals.get(goal.id))?.linkedAccountId).toBe(savings.id);
  });

  it('withdraws saved money without changing the target, income, expenses or total cash', async () => {
    await enableSync();
    const id = await withdrawFromGoal({
      goalId: goal.id,
      toAccountId: checking.id,
      amount: 30_000,
      date: '2026-09-25',
      notes: 'Za kiriju',
    });
    expect(await balances()).toEqual({ checking: 130_000, savings: 0 });
    expect(await db.goals.get(goal.id)).toEqual(goal);
    expect(await db.transactions.get(id)).toMatchObject({
      type: 'transfer',
      amount: 30_000,
      accountId: savings.id,
      toAccountId: checking.id,
      notes: 'Za kiriju',
    });
    const data = await readFinanceData();
    expect(reconcileCashLedger(data.accounts, data.transactions)).toMatchObject({
      recordedIncome: 0,
      recordedExpenses: 0,
      actualCurrentTotal: 130_000,
      difference: 0,
    });
    assertFinanceDataIntegrity(data);
    expect(await db.syncOutbox.count()).toBe(1);
  });

  it.each([0, -1, 30_001, 0.5])(
    'rejects invalid or underfunded withdrawal %s atomically',
    async (amount) => {
      await expect(
        withdrawFromGoal({ goalId: goal.id, toAccountId: checking.id, amount, date: '2026-09-25' }),
      ).rejects.toThrow();
      expect(await db.transactions.count()).toBe(0);
      expect((await balances()).savings).toBe(30_000);
    },
  );

  it('requires an active goal and a spendable destination', async () => {
    await expect(
      withdrawFromGoal({
        goalId: goal.id,
        toAccountId: savings.id,
        amount: 1_000,
        date: '2026-09-25',
      }),
    ).rejects.toThrow();
    await db.goals.update(goal.id, { archived: true });
    await expect(
      withdrawFromGoal({
        goalId: goal.id,
        toAccountId: checking.id,
        amount: 1_000,
        date: '2026-09-25',
      }),
    ).rejects.toThrow();
    expect(await db.transactions.count()).toBe(0);
  });

  it('pays early at the actual amount and account while preserving the October plan', async () => {
    const id = await markCommitmentPaid({
      ...payment,
      actualAmount: 29_850,
      paymentDate: '2026-09-25',
      paymentAccountId: savings.id,
    });
    expect(await db.transactions.get(id)).toMatchObject({
      date: '2026-09-25',
      amount: 29_850,
      accountId: savings.id,
      occurrenceKey: payment.occurrenceKey,
      source: 'commitment',
    });
    expect(await db.commitments.get(rent.id)).toEqual(rent);
    const data = await readFinanceData();
    const summary = (month: string) =>
      calculateMonthlyFinancialSummary({ ...data, month, events: data.plannedEvents });
    expect(summary('2026-09')).toMatchObject({
      fixed: { actual: 29_850 },
      actualExpenses: 29_850,
      expenseReconciliation: { difference: 0 },
    });
    expect(summary('2026-10')).toMatchObject({
      fixed: { planned: 30_000, actual: 0, remaining: 0 },
      actualExpenses: 0,
    });
    expect(
      getAllCommitmentOccurrences(data.commitments, '2026-10', data.transactions)[0]
        .paidTransactionId,
    ).toBe(id);
    assertFinanceDataIntegrity(data);
  });

  it('validates the actual occurrence instead of accepting arbitrary keys', async () => {
    await expect(
      markCommitmentPaid({ ...payment, occurrenceKey: 'commitment:2026-10-02' }),
    ).rejects.toThrow();
    await expect(
      markCommitmentPaid({ ...payment, occurrenceKey: 'commitment:garbage' }),
    ).rejects.toThrow();
    expect(await db.transactions.count()).toBe(0);
  });

  it('links and unlinks an existing expense in place without another cash movement', async () => {
    const manual = tx({
      id: 'already-paid',
      type: 'expense',
      amount: 30_000,
      categoryId: expenseCategory.id,
      date: '2026-09-25',
      source: 'quick-add',
      notes: 'Ranije plaćeno',
    });
    await saveTransaction(manual);
    const before = await balances();
    await enableSync();
    await linkTransactionToCommitment({
      occurrenceKey: payment.occurrenceKey,
      transactionId: manual.id,
    });
    expect(await db.transactions.count()).toBe(1);
    expect(await balances()).toEqual(before);
    expect(await db.transactions.get(manual.id)).toEqual({
      ...manual,
      source: 'commitment',
      occurrenceKey: payment.occurrenceKey,
    });
    const intent = parseSyncMutationIntent((await db.syncOutbox.toArray())[0].canonicalPayload);
    expect(intent.previousValue).toMatchObject({ id: manual.id, source: 'quick-add' });
    expect(intent.value).toMatchObject({ id: manual.id, source: 'commitment' });
    assertFinanceDataIntegrity(await readFinanceData());
    await unlinkCommitmentPayment(manual.id);
    expect(await db.transactions.get(manual.id)).toMatchObject({
      id: manual.id,
      source: 'manual',
      amount: 30_000,
      notes: manual.notes,
    });
    expect((await db.transactions.get(manual.id))?.occurrenceKey).toBeUndefined();
    expect(await balances()).toEqual(before);
    expect(await db.transactions.count()).toBe(1);
  });

  it('requires explicit amount mismatch consent and never overwrites the plan', async () => {
    await saveTransaction(
      tx({ id: 'different', type: 'expense', amount: 29_850, categoryId: expenseCategory.id }),
    );
    const input = { occurrenceKey: payment.occurrenceKey, transactionId: 'different' };
    await expect(linkTransactionToCommitment(input)).rejects.toThrow();
    await linkTransactionToCommitment({ ...input, confirmAmountMismatch: true });
    expect((await db.transactions.get('different'))?.amount).toBe(29_850);
    expect((await db.commitments.get(rent.id))?.amount).toBe(30_000);
  });

  it('rejects missing, income, linked and duplicate payment targets', async () => {
    await expect(
      linkTransactionToCommitment({
        occurrenceKey: payment.occurrenceKey,
        transactionId: 'missing',
      }),
    ).rejects.toThrow();
    await db.transactions.add(tx({ id: 'income', type: 'income', amount: 30_000 }));
    await expect(
      linkTransactionToCommitment({
        occurrenceKey: payment.occurrenceKey,
        transactionId: 'income',
      }),
    ).rejects.toThrow();
    const first = await markCommitmentPaid(payment);
    await expect(
      linkTransactionToCommitment({ occurrenceKey: 'commitment:2026-11-01', transactionId: first }),
    ).rejects.toThrow();
    await saveTransaction(
      tx({ id: 'other', type: 'expense', amount: 30_000, categoryId: expenseCategory.id }),
    );
    await expect(
      linkTransactionToCommitment({ occurrenceKey: payment.occurrenceKey, transactionId: 'other' }),
    ).rejects.toThrow();
  });

  it('creates one audited savings transfer and one expense even on concurrent submission', async () => {
    await db.accounts.update(checking.id, { openingBalance: 0 });
    await enableSync();
    const input = { ...payment, paymentDate: '2026-09-25', fundingAccountId: savings.id };
    const [first, second] = await Promise.all([
      markCommitmentPaid(input),
      markCommitmentPaid(input),
    ]);
    expect(first).toBe(second);
    expect(await db.transactions.count()).toBe(2);
    expect(await balances()).toEqual({ checking: 0, savings: 0 });
    const data = await readFinanceData();
    expect(reconcileCashLedger(data.accounts, data.transactions)).toMatchObject({
      recordedIncome: 0,
      recordedExpenses: 30_000,
      difference: 0,
    });
    expect(
      calculateMonthlyFinancialSummary({ ...data, month: '2026-09', events: data.plannedEvents }),
    ).toMatchObject({
      fixed: { actual: 30_000 },
      savings: { actual: 0 },
      actualExpenses: 30_000,
      expenseReconciliation: { difference: 0 },
    });
    const outbox = await db.syncOutbox.toArray();
    expect(outbox).toHaveLength(2);
    expect(new Set(outbox.map((row) => row.mutationGroupId)).size).toBe(1);
    expect(outbox.map((row) => row.mutationGroupSize)).toEqual([2, 2]);
    assertFinanceDataIntegrity(data);
    const transfer = data.transactions.find((row) => row.type === 'transfer')!;
    await expect(deleteTransaction(transfer.id)).rejects.toThrow();
    await expect(unlinkCommitmentPayment(first)).rejects.toThrow();
    await deleteTransaction(first);
    expect(await db.transactions.count()).toBe(0);
    expect(await balances()).toEqual({ checking: 0, savings: 30_000 });
  });

  it('rolls back funding and sync intents if the expense write fails', async () => {
    await enableSync();
    const realAdd = db.transactions.add.bind(db.transactions);
    vi.spyOn(db.transactions, 'add').mockImplementation((row, key) => {
      if (row.type === 'expense') throw new Error('synthetic expense failure');
      return realAdd(row, key);
    });
    await expect(markCommitmentPaid({ ...payment, fundingAccountId: savings.id })).rejects.toThrow(
      'synthetic expense failure',
    );
    expect(await db.transactions.count()).toBe(0);
    expect(await db.syncOutbox.count()).toBe(0);
    expect((await balances()).savings).toBe(30_000);
  });

  it('rolls back local funding/payment when the sync outbox fails', async () => {
    await enableSync();
    vi.spyOn(db.syncOutbox, 'bulkAdd').mockRejectedValueOnce(new Error('outbox failed'));
    await expect(markCommitmentPaid({ ...payment, fundingAccountId: savings.id })).rejects.toThrow(
      'outbox failed',
    );
    expect(await db.transactions.count()).toBe(0);
    expect(await db.syncOutbox.count()).toBe(0);
  });

  it('does not let generic edits strip system payment linkage', async () => {
    const id = await markCommitmentPaid(payment);
    const row = (await db.transactions.get(id))!;
    await expect(
      saveTransaction({ ...row, source: 'manual', occurrenceKey: undefined }),
    ).rejects.toThrow();
    expect((await db.transactions.get(id))?.source).toBe('commitment');
  });

  it('keeps a goal with historical manual transfers and prevents unsafe transfer deletion', async () => {
    await db.accounts.update(savings.id, { openingBalance: 0 });
    await saveTransaction(
      tx({ id: 'deposit', type: 'transfer', amount: 30_000, toAccountId: savings.id }),
    );
    expect(await deleteGoal(goal.id)).toBe('archived');
    await saveTransaction(
      tx({
        id: 'spent',
        type: 'expense',
        amount: 20_000,
        accountId: savings.id,
        categoryId: expenseCategory.id,
      }),
    );
    await expect(deleteTransaction('deposit')).rejects.toThrow();
    expect((await balances()).savings).toBe(10_000);
  });
});
