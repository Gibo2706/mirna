import { calculateAccountBalances, calculateDebtProgress } from '@/domain/calculations';
import { getPlannedIncomeOccurrences } from '@/domain/recurrence';
import { isGoalCompletionEvent } from '@/domain/goals';
import {
  accountSchema,
  categorySchema,
  commitmentSchema,
  debtPaymentSchema,
  debtSchema,
  goalSchema,
  plannedEventSchema,
  plannedIncomeSchema,
  presetSchema,
  salaryScenarioSchema,
  transactionSchema,
  variableBudgetSchema,
} from '@/domain/schemas';
import type {
  Account,
  AppSettings,
  Category,
  Debt,
  FixedCommitment,
  LedgerTransaction,
  PlannedEvent,
  PlannedIncome,
  QuickAddPreset,
  SalaryScenario,
  SavingsGoal,
  VariableBudget,
} from '@/domain/types';
import { createId } from '@/lib/id';
import { db, financeTables } from './database';
import { auditedFinanceTransaction } from './sync/mutation-audit';

const nowIso = (): string => new Date().toISOString();

const requireAccount = async (accountId: string): Promise<Account> => {
  const account = await db.accounts.get(accountId);
  if (!account) throw new Error('Račun ne postoji.');
  return account;
};

const requireCategory = async (categoryId: string, kind: Category['kind']): Promise<Category> => {
  const category = await db.categories.get(categoryId);
  if (!category) throw new Error('Kategorija ne postoji.');
  if (category.kind !== kind) {
    throw new Error(
      kind === 'income'
        ? 'Planirani prihod mora koristiti prihodnu kategoriju.'
        : 'Trošak mora koristiti rashodnu kategoriju.',
    );
  }
  return category;
};

const eventFundingOccurrenceKey = (eventId: string): string => `event-funding:${eventId}`;

const requireAvailableFunds = async (
  accountId: string,
  amount: number,
  message = 'Nema dovoljno sredstava na izabranom računu.',
): Promise<void> => {
  const [account, accounts, transactions] = await Promise.all([
    requireAccount(accountId),
    db.accounts.toArray(),
    db.transactions.toArray(),
  ]);
  const balance =
    calculateAccountBalances(accounts, transactions)[account.id] ?? account.openingBalance;
  if (balance < amount) throw new Error(message);
};

export async function saveAccount(account: Account): Promise<void> {
  accountSchema.parse(account);
  if (account.openingBalance < 0) {
    throw new Error(
      'Početno stanje ne može biti negativno jer Mirna ne modeluje dozvoljeni minus.',
    );
  }
  await auditedFinanceTransaction([db.accounts], async (audit) => {
    const previous = await db.accounts.get(account.id);
    await db.accounts.put(account);
    await audit.upsert('account', previous, account);
  });
}

export async function deleteAccount(accountId: string): Promise<void> {
  const settings = await db.settings.get('settings');
  const [transactionCount, referenceCount] = await Promise.all([
    db.transactions
      .filter(
        (transaction) =>
          transaction.accountId === accountId || transaction.toAccountId === accountId,
      )
      .count(),
    Promise.all([
      db.commitments.where('accountId').equals(accountId).count(),
      db.goals.where('linkedAccountId').equals(accountId).count(),
      db.plannedEvents.where('accountId').equals(accountId).count(),
      db.plannedIncomes.where('accountId').equals(accountId).count(),
      db.presets.filter((preset) => preset.defaultAccountId === accountId).count(),
    ]).then((counts) => counts.reduce((sum, count) => sum + count, 0)),
  ]);
  if (transactionCount > 0 || referenceCount > 0 || settings?.defaultAccountId === accountId) {
    throw new Error(
      'Račun ima povezane podatke i ne može biti obrisan. Arhivirajte ga umesto toga.',
    );
  }
  await auditedFinanceTransaction([db.accounts], async (audit) => {
    const previous = await db.accounts.get(accountId);
    await db.accounts.delete(accountId);
    await audit.delete('account', previous);
  });
}

export async function saveCategory(category: Category): Promise<void> {
  categorySchema.parse(category);
  await auditedFinanceTransaction([db.categories], async (audit) => {
    const previous = await db.categories.get(category.id);
    await db.categories.put(category);
    await audit.upsert('category', previous, category);
  });
}

export async function deleteCategory(categoryId: string): Promise<void> {
  const references = await Promise.all([
    db.transactions.where('categoryId').equals(categoryId).count(),
    db.commitments.where('categoryId').equals(categoryId).count(),
    db.variableBudgets.where('categoryId').equals(categoryId).count(),
    db.plannedEvents.where('categoryId').equals(categoryId).count(),
    db.plannedIncomes.where('categoryId').equals(categoryId).count(),
    db.presets.filter((preset) => preset.categoryId === categoryId).count(),
  ]);
  if (references.some((count) => count > 0)) {
    throw new Error('Kategorija se koristi i ne može biti obrisana. Arhivirajte je umesto toga.');
  }
  await auditedFinanceTransaction([db.categories], async (audit) => {
    const previous = await db.categories.get(categoryId);
    await db.categories.delete(categoryId);
    await audit.delete('category', previous);
  });
}

export async function saveTransaction(transaction: LedgerTransaction): Promise<void> {
  transactionSchema.parse(transaction);
  if (transaction.source !== 'manual' && transaction.source !== 'quick-add') {
    throw new Error('Povezane transakcije menjajte kroz odgovarajući finansijski tok.');
  }
  if (
    transaction.occurrenceKey ||
    transaction.plannedIncomeId ||
    transaction.plannedEventId ||
    transaction.goalId ||
    transaction.debtPaymentId
  ) {
    throw new Error('Ručna transakcija ne sme preuzeti vezu sistemskog plana.');
  }
  await auditedFinanceTransaction([db.accounts, db.categories, db.transactions], async (audit) => {
    await requireAccount(transaction.accountId);
    if (transaction.toAccountId) await requireAccount(transaction.toAccountId);
    if (transaction.categoryId && transaction.type === 'income') {
      await requireCategory(transaction.categoryId, 'income');
    }
    if (transaction.categoryId && transaction.type === 'expense') {
      await requireCategory(transaction.categoryId, 'expense');
    }

    const [accounts, transactions, existing] = await Promise.all([
      db.accounts.toArray(),
      db.transactions.toArray(),
      db.transactions.get(transaction.id),
    ]);
    const nextTransactions = [
      ...transactions.filter((value) => value.id !== transaction.id),
      transaction,
    ];
    const nextBalances = calculateAccountBalances(accounts, nextTransactions);
    const affectedAccountIds = new Set(
      [
        existing?.accountId,
        existing?.toAccountId,
        transaction.accountId,
        transaction.toAccountId,
      ].filter((value): value is string => Boolean(value)),
    );
    for (const accountId of affectedAccountIds) {
      if ((nextBalances[accountId] ?? 0) < 0) {
        const account = accounts.find((value) => value.id === accountId);
        throw new Error(
          `Transakcija bi spustila račun „${account?.name ?? accountId}” ispod nule.`,
        );
      }
    }
    await db.transactions.put(transaction);
    await audit.upsert('transaction', existing, transaction);
  });
}

export async function deleteTransaction(transactionId: string): Promise<void> {
  await auditedFinanceTransaction(
    [db.transactions, db.plannedEvents, db.goals, db.debtPayments, db.debts],
    async (audit) => {
      const transaction = await db.transactions.get(transactionId);
      if (!transaction) return;
      if (transaction.occurrenceKey?.startsWith('event-funding:')) {
        const eventId = transaction.occurrenceKey.slice('event-funding:'.length);
        const event = await db.plannedEvents.get(eventId);
        if (event?.paidTransactionId) {
          throw new Error('Prvo obrišite povezani trošak događaja.');
        }
      }
      if (transaction.plannedEventId) {
        const event = await db.plannedEvents.get(transaction.plannedEventId);
        if (event?.paidTransactionId === transaction.id) {
          const updatedEvent = { ...event, paidTransactionId: undefined };
          await db.plannedEvents.put(updatedEvent);
          await audit.upsert('planned-event', event, updatedEvent);
          const goal = event.linkedGoalId ? await db.goals.get(event.linkedGoalId) : undefined;
          if (goal?.usedAt && isGoalCompletionEvent(goal, event)) {
            const otherCompletion = (
              await db.plannedEvents.where('linkedGoalId').equals(goal.id).toArray()
            ).some(
              (candidate) =>
                candidate.id !== event.id &&
                Boolean(candidate.paidTransactionId) &&
                isGoalCompletionEvent(goal, candidate),
            );
            if (!otherCompletion) {
              const updatedGoal = { ...goal, usedAt: undefined };
              await db.goals.put(updatedGoal);
              await audit.upsert('goal', goal, updatedGoal);
            }
          }
          const fundingTransfer = await db.transactions
            .where('occurrenceKey')
            .equals(eventFundingOccurrenceKey(event.id))
            .first();
          if (fundingTransfer) {
            await db.transactions.delete(fundingTransfer.id);
            await audit.delete('transaction', fundingTransfer);
          }
        }
      }
      if (transaction.debtPaymentId) {
        const payment = await db.debtPayments.get(transaction.debtPaymentId);
        if (payment?.transactionId === transaction.id) {
          await db.debtPayments.delete(payment.id);
          await audit.delete('debt-payment', payment);
          const debt = await db.debts.get(payment.debtId);
          if (debt) {
            const remainingPayments = await db.debtPayments
              .where('debtId')
              .equals(payment.debtId)
              .toArray();
            const remaining = calculateDebtProgress(debt, remainingPayments).remaining;
            const updatedDebt = {
              ...debt,
              status: remaining === 0 ? ('paid' as const) : ('open' as const),
            };
            await db.debts.put(updatedDebt);
            await audit.upsert('debt', debt, updatedDebt);
          }
        }
      }
      await db.transactions.delete(transactionId);
      await audit.delete('transaction', transaction);
    },
  );
}

export async function adjustAccountBalance(
  accountId: string,
  targetBalance: number,
  date: string,
  note: string,
): Promise<void> {
  if (!Number.isSafeInteger(targetBalance)) throw new Error('Stanje mora biti ceo broj dinara.');
  if (targetBalance < 0) {
    throw new Error('Stanje ne može biti negativno jer Mirna ne modeluje dozvoljeni minus.');
  }
  await auditedFinanceTransaction([db.accounts, db.transactions], async (audit) => {
    const account = await db.accounts.get(accountId);
    if (!account) throw new Error('Račun ne postoji.');
    const transactions = await db.transactions.toArray();
    const current = calculateAccountBalances([account], transactions)[account.id] ?? 0;
    const delta = targetBalance - current;
    if (delta === 0) return;
    const transaction: LedgerTransaction = {
      id: createId('tx'),
      type: 'adjustment',
      amount: delta,
      accountId,
      date,
      description: `Usklađivanje stanja — ${account.name}`,
      notes: note || `Prethodno stanje: ${current}; novo stanje: ${targetBalance}`,
      source: 'adjustment',
      createdAt: nowIso(),
    };
    await db.transactions.add(transaction);
    await audit.upsert('transaction', null, transaction);
  });
}

export async function markCommitmentPaid(input: {
  occurrenceKey: string;
  name: string;
  amount: number;
  date: string;
  accountId: string;
  categoryId: string;
}): Promise<string> {
  return auditedFinanceTransaction(
    [db.commitments, db.accounts, db.categories, db.transactions],
    async (audit) => {
      const commitmentId = input.occurrenceKey.slice(0, input.occurrenceKey.lastIndexOf(':'));
      const commitment = await db.commitments.get(commitmentId);
      if (!commitment) throw new Error('Fiksna obaveza ne postoji.');
      if (
        commitment.name !== input.name ||
        commitment.amount !== input.amount ||
        commitment.accountId !== input.accountId ||
        commitment.categoryId !== input.categoryId
      ) {
        throw new Error('Plan obaveze je promenjen. Osvežite ekran i pokušajte ponovo.');
      }
      await requireAccount(commitment.accountId);
      await requireCategory(commitment.categoryId, 'expense');
      const existing = await db.transactions
        .where('occurrenceKey')
        .equals(input.occurrenceKey)
        .first();
      if (existing) return existing.id;
      await requireAvailableFunds(commitment.accountId, input.amount);
      const transaction: LedgerTransaction = {
        id: createId('tx'),
        type: 'expense',
        amount: input.amount,
        accountId: input.accountId,
        categoryId: input.categoryId,
        date: input.date,
        description: input.name,
        source: 'commitment',
        occurrenceKey: input.occurrenceKey,
        createdAt: nowIso(),
      };
      transactionSchema.parse(transaction);
      await db.transactions.add(transaction);
      await audit.upsert('transaction', null, transaction);
      return transaction.id;
    },
  );
}

export async function markPlannedIncomeReceived(input: {
  plannedIncomeId: string;
  occurrenceKey: string;
  month: string;
  receivedDate: string;
  amount?: number;
  accountId?: string;
  notes?: string;
}): Promise<string> {
  return auditedFinanceTransaction(
    [db.plannedIncomes, db.accounts, db.categories, db.transactions],
    async (audit) => {
      const existing = await db.transactions
        .where('occurrenceKey')
        .equals(input.occurrenceKey)
        .first();
      if (existing) return existing.id;

      const plannedIncome = await db.plannedIncomes.get(input.plannedIncomeId);
      if (!plannedIncome) throw new Error('Planirani prihod ne postoji.');
      const accountId = input.accountId ?? plannedIncome.accountId;
      await requireAccount(accountId);
      await requireCategory(plannedIncome.categoryId, 'income');
      const occurrence = getPlannedIncomeOccurrences(plannedIncome, input.month).find(
        (value) => value.key === input.occurrenceKey,
      );
      if (!occurrence) {
        throw new Error('Ovaj prihod nije planiran za izabrani mesec.');
      }
      const amount = input.amount ?? occurrence.amount;
      const transaction: LedgerTransaction = {
        id: createId('tx'),
        type: 'income',
        amount,
        accountId,
        categoryId: occurrence.categoryId,
        date: input.receivedDate,
        description: occurrence.name,
        notes: input.notes?.trim() || undefined,
        source: 'planned-income',
        occurrenceKey: occurrence.key,
        plannedIncomeId: plannedIncome.id,
        createdAt: nowIso(),
      };
      transactionSchema.parse(transaction);
      try {
        await db.transactions.add(transaction);
        await audit.upsert('transaction', null, transaction);
      } catch (caught) {
        const concurrent = await db.transactions
          .where('occurrenceKey')
          .equals(occurrence.key)
          .first();
        if (concurrent) return concurrent.id;
        throw caught;
      }
      return transaction.id;
    },
  );
}

export async function markPlannedEventPaid(input: {
  eventId: string;
  date?: string;
  actualAmount?: number;
  paymentAccountId?: string;
  topUpFromAccountId?: string;
}): Promise<string> {
  return auditedFinanceTransaction(
    [db.plannedEvents, db.goals, db.accounts, db.categories, db.transactions],
    async (audit) => {
      const event = await db.plannedEvents.get(input.eventId);
      if (!event) throw new Error('Planirani događaj ne postoji.');
      if (event.paidTransactionId) return event.paidTransactionId;
      const existing = await db.transactions.where('plannedEventId').equals(event.id).first();
      if (existing) {
        const updatedEvent = { ...event, paidTransactionId: existing.id };
        await db.plannedEvents.put(updatedEvent);
        await audit.upsert('planned-event', event, updatedEvent);
        const linkedGoal = event.linkedGoalId ? await db.goals.get(event.linkedGoalId) : undefined;
        if (
          linkedGoal &&
          existing.accountId === event.accountId &&
          isGoalCompletionEvent(linkedGoal, event)
        ) {
          const updatedGoal = { ...linkedGoal, usedAt: existing.date };
          await db.goals.put(updatedGoal);
          await audit.upsert('goal', linkedGoal, updatedGoal);
        }
        return existing.id;
      }
      if (event.plannedAmount <= 0) throw new Error('Unesite iznos događaja pre plaćanja.');
      const amount = input.actualAmount ?? event.plannedAmount;
      const paymentAccountId = input.paymentAccountId ?? event.accountId;
      const paymentAccount = await requireAccount(paymentAccountId);
      await requireCategory(event.categoryId, 'expense');
      const [accounts, transactions] = await Promise.all([
        db.accounts.toArray(),
        db.transactions.toArray(),
      ]);
      const balances = calculateAccountBalances(accounts, transactions);
      const available = balances[paymentAccount.id] ?? paymentAccount.openingBalance;
      const shortfall = Math.max(0, amount - available);

      if (shortfall > 0) {
        if (!paymentAccount.protected || !input.topUpFromAccountId) {
          throw new Error(
            paymentAccount.protected
              ? 'Zaštićeni račun nema dovoljno sredstava. Izaberite račun za dopunu.'
              : 'Nema dovoljno sredstava na izabranom računu.',
          );
        }
        const sourceAccount = await requireAccount(input.topUpFromAccountId);
        if (sourceAccount.protected || sourceAccount.id === paymentAccount.id) {
          throw new Error('Dopuna mora doći sa drugog raspoloživog računa.');
        }
        const sourceBalance = balances[sourceAccount.id] ?? sourceAccount.openingBalance;
        if (sourceBalance < shortfall) {
          throw new Error('Nema dovoljno sredstava na izabranom računu.');
        }
        const existingFunding = await db.transactions
          .where('occurrenceKey')
          .equals(eventFundingOccurrenceKey(event.id))
          .first();
        if (existingFunding) {
          throw new Error('Postoji nedovršena dopuna za ovaj događaj. Osvežite ekran.');
        }
        const fundingTransfer: LedgerTransaction = {
          id: createId('tx'),
          type: 'transfer',
          amount: shortfall,
          accountId: sourceAccount.id,
          toAccountId: paymentAccount.id,
          date: input.date ?? event.date,
          description: `Dopuna za događaj — ${event.title}`,
          notes: `Automatska dopuna zaštićenog računa „${paymentAccount.name}”.`,
          source: 'manual',
          occurrenceKey: eventFundingOccurrenceKey(event.id),
          createdAt: nowIso(),
        };
        transactionSchema.parse(fundingTransfer);
        await db.transactions.add(fundingTransfer);
        await audit.upsert('transaction', null, fundingTransfer);
      }

      const transaction: LedgerTransaction = {
        id: createId('tx'),
        type: 'expense',
        amount,
        accountId: paymentAccount.id,
        categoryId: event.categoryId,
        date: input.date ?? event.date,
        description: event.title,
        notes: event.notes,
        source: 'planned-event',
        plannedEventId: event.id,
        createdAt: nowIso(),
      };
      transactionSchema.parse(transaction);
      await db.transactions.add(transaction);
      await audit.upsert('transaction', null, transaction);
      const updatedEvent = {
        ...event,
        accountId: paymentAccount.id,
        paidTransactionId: transaction.id,
      };
      await db.plannedEvents.put(updatedEvent);
      await audit.upsert('planned-event', event, updatedEvent);
      const linkedGoal = event.linkedGoalId ? await db.goals.get(event.linkedGoalId) : undefined;
      if (
        linkedGoal &&
        paymentAccount.id === event.accountId &&
        isGoalCompletionEvent(linkedGoal, event)
      ) {
        const updatedGoal = { ...linkedGoal, usedAt: transaction.date };
        await db.goals.put(updatedGoal);
        await audit.upsert('goal', linkedGoal, updatedGoal);
      }
      return transaction.id;
    },
  );
}

export async function contributeToGoal(input: {
  goalId: string;
  fromAccountId: string;
  amount: number;
  date: string;
}): Promise<string> {
  return auditedFinanceTransaction([db.goals, db.accounts, db.transactions], async (audit) => {
    const goal = await db.goals.get(input.goalId);
    if (!goal) throw new Error('Cilj ne postoji.');
    if (goal.archived) throw new Error('Arhivirani cilj ne prima nove uplate.');
    if (goal.goalType === 'sinking' && goal.usedAt) {
      throw new Error('Iskorišćeni namenski cilj ne prima nove uplate.');
    }
    const sourceAccount = await requireAccount(input.fromAccountId);
    if (sourceAccount.protected) {
      throw new Error('Uplata cilja mora doći sa raspoloživog računa.');
    }
    const linkedAccount = await requireAccount(goal.linkedAccountId);
    if (!linkedAccount.protected) {
      throw new Error('Namenski račun cilja mora biti zaštićen.');
    }
    if (goal.linkedAccountId === input.fromAccountId) {
      throw new Error('Izvorni i ciljni račun moraju biti različiti.');
    }
    const transactions = await db.transactions.toArray();
    const accounts = await db.accounts.toArray();
    const balance =
      calculateAccountBalances(accounts, transactions)[linkedAccount.id] ??
      linkedAccount.openingBalance;
    const remaining = Math.max(0, goal.targetAmount - Math.max(0, balance));
    if (remaining === 0) throw new Error('Cilj je već popunjen.');
    if (input.amount <= 0 || input.amount > remaining) {
      throw new Error(`Uplata mora biti između 1 i ${remaining} RSD.`);
    }
    await requireAvailableFunds(input.fromAccountId, input.amount);
    const transaction: LedgerTransaction = {
      id: createId('tx'),
      type: 'transfer',
      amount: input.amount,
      accountId: input.fromAccountId,
      toAccountId: goal.linkedAccountId,
      date: input.date,
      description: `Uplata za cilj — ${goal.name}`,
      source: 'goal',
      goalId: goal.id,
      createdAt: nowIso(),
    };
    transactionSchema.parse(transaction);
    await db.transactions.add(transaction);
    await audit.upsert('transaction', null, transaction);
    return transaction.id;
  });
}

export async function recordDebtPayment(input: {
  debtId: string;
  source?: 'self' | 'external';
  accountId?: string;
  categoryId?: string;
  amount: number;
  date: string;
  notes?: string;
}): Promise<string> {
  return auditedFinanceTransaction(
    [db.debts, db.debtPayments, db.accounts, db.categories, db.transactions],
    async (audit) => {
      const debt = await db.debts.get(input.debtId);
      if (!debt) throw new Error('Dug ne postoji.');
      const payments = await db.debtPayments.where('debtId').equals(debt.id).toArray();
      const { remaining } = calculateDebtProgress(debt, payments);
      if (remaining === 0) {
        throw new Error('Nema dovoljno preostalog duga za ovu uplatu.');
      }
      if (input.amount <= 0 || input.amount > remaining) {
        throw new Error(`Uplata mora biti između 1 i ${remaining} RSD.`);
      }

      const source = input.source ?? 'self';
      const paymentId = createId('payment');
      const transactionId = source === 'self' ? createId('tx') : undefined;
      if (source === 'self') {
        if (!input.accountId || !input.categoryId) {
          throw new Error('Lična otplata mora imati račun i kategoriju.');
        }
        await requireAccount(input.accountId);
        await requireCategory(input.categoryId, 'expense');
        await requireAvailableFunds(input.accountId, input.amount);
        const transaction: LedgerTransaction = {
          id: transactionId!,
          type: 'expense',
          amount: input.amount,
          accountId: input.accountId,
          categoryId: input.categoryId,
          date: input.date,
          description: `Otplata duga — ${debt.creditor}`,
          notes: input.notes,
          source: 'debt',
          debtPaymentId: paymentId,
          createdAt: nowIso(),
        };
        transactionSchema.parse(transaction);
        await db.transactions.add(transaction);
        await audit.upsert('transaction', null, transaction);
      }
      const payment = {
        id: paymentId,
        debtId: debt.id,
        amount: input.amount,
        date: input.date,
        source,
        transactionId,
        notes: input.notes,
        createdAt: nowIso(),
      };
      debtPaymentSchema.parse(payment);
      await db.debtPayments.add(payment);
      await audit.upsert('debt-payment', null, payment);
      if (input.amount === remaining) {
        const updatedDebt = { ...debt, status: 'paid' as const };
        await db.debts.put(updatedDebt);
        await audit.upsert('debt', debt, updatedDebt);
      }
      return transactionId ?? paymentId;
    },
  );
}

export async function saveCommitment(value: FixedCommitment): Promise<void> {
  commitmentSchema.parse(value);
  if (value.endDate && value.endDate < value.startDate)
    throw new Error('Krajnji datum nije validan.');
  await requireAccount(value.accountId);
  await requireCategory(value.categoryId, 'expense');
  await auditedFinanceTransaction([db.commitments], async (audit) => {
    const previous = await db.commitments.get(value.id);
    await db.commitments.put(value);
    await audit.upsert('commitment', previous, value);
  });
}

export async function saveVariableBudget(value: VariableBudget): Promise<void> {
  variableBudgetSchema.parse(value);
  await requireCategory(value.categoryId, 'expense');
  await auditedFinanceTransaction([db.variableBudgets], async (audit) => {
    const previous = await db.variableBudgets.get(value.id);
    await db.variableBudgets.put(value);
    await audit.upsert('variable-budget', previous, value);
  });
}

export async function saveGoal(value: SavingsGoal): Promise<void> {
  goalSchema.parse(value);
  const duplicate = await db.goals.where('linkedAccountId').equals(value.linkedAccountId).first();
  if (duplicate && duplicate.id !== value.id) {
    throw new Error('Jedan namenski štedni račun može biti povezan samo sa jednim ciljem.');
  }
  const account = await requireAccount(value.linkedAccountId);
  if (!account.protected) throw new Error('Namenski račun cilja mora biti zaštićen.');
  if (value.usedAt) {
    const hasCompletion = (
      await db.plannedEvents.where('linkedGoalId').equals(value.id).toArray()
    ).some((event) => Boolean(event.paidTransactionId) && isGoalCompletionEvent(value, event));
    if (!hasCompletion) {
      throw new Error('Iskorišćeni namenski cilj mora imati plaćen povezani događaj.');
    }
  }
  await auditedFinanceTransaction([db.goals], async (audit) => {
    const previous = await db.goals.get(value.id);
    await db.goals.put(value);
    await audit.upsert('goal', previous, value);
  });
}

export async function saveDebt(value: Debt): Promise<void> {
  debtSchema.parse(value);
  const payments = await db.debtPayments.where('debtId').equals(value.id).toArray();
  const paid = payments.reduce((sum, payment) => sum + payment.amount, 0);
  if (paid > value.originalAmount) {
    throw new Error('Originalni iznos ne može biti manji od evidentiranih uplata.');
  }
  if (
    (paid === value.originalAmount && value.status !== 'paid') ||
    (paid < value.originalAmount && value.status !== 'open')
  ) {
    throw new Error('Status duga nije usklađen sa evidentiranim uplatama.');
  }
  await auditedFinanceTransaction([db.debts], async (audit) => {
    const previous = await db.debts.get(value.id);
    await db.debts.put(value);
    await audit.upsert('debt', previous, value);
  });
}

export async function savePlannedEvent(value: PlannedEvent): Promise<void> {
  plannedEventSchema.parse(value);
  const current = await db.plannedEvents.get(value.id);
  if (
    current?.paidTransactionId &&
    (current.accountId !== value.accountId || current.linkedGoalId !== value.linkedGoalId)
  ) {
    throw new Error('Prvo obrišite povezanu transakciju pre promene izvora događaja.');
  }
  await requireAccount(value.accountId);
  await requireCategory(value.categoryId, 'expense');
  if (value.linkedGoalId && !(await db.goals.get(value.linkedGoalId))) {
    throw new Error('Povezani cilj ne postoji.');
  }
  if (value.paidTransactionId) {
    const transaction = await db.transactions.get(value.paidTransactionId);
    if (
      !transaction ||
      transaction.plannedEventId !== value.id ||
      transaction.source !== 'planned-event' ||
      transaction.type !== 'expense'
    ) {
      throw new Error('Plaćeni događaj nema ispravnu povezanu transakciju.');
    }
  }
  await auditedFinanceTransaction([db.plannedEvents], async (audit) => {
    await db.plannedEvents.put(value);
    await audit.upsert('planned-event', current, value);
  });
}

export async function savePreset(value: QuickAddPreset): Promise<void> {
  presetSchema.parse(value);
  if (value.defaultAccountId) await requireAccount(value.defaultAccountId);
  if (value.categoryId) await requireCategory(value.categoryId, value.type);
  await auditedFinanceTransaction([db.presets], async (audit) => {
    const previous = await db.presets.get(value.id);
    await db.presets.put(value);
    await audit.upsert('quick-add-preset', previous, value);
  });
}

export async function savePlannedIncome(value: PlannedIncome): Promise<void> {
  plannedIncomeSchema.parse(value);
  await requireAccount(value.accountId);
  await requireCategory(value.categoryId, 'income');
  await auditedFinanceTransaction([db.plannedIncomes], async (audit) => {
    if (value.isPrimarySalary) {
      const duplicate = await db.plannedIncomes
        .filter((plannedIncome) => plannedIncome.isPrimarySalary && plannedIncome.id !== value.id)
        .first();
      if (duplicate) throw new Error('Može postojati samo jedan primarni plan plate.');
    }
    const previous = await db.plannedIncomes.get(value.id);
    await db.plannedIncomes.put(value);
    await audit.upsert('planned-income', previous, value);
  });
}

export async function saveSalaryScenario(value: SalaryScenario): Promise<void> {
  salaryScenarioSchema.parse(value);
  await auditedFinanceTransaction([db.salaryScenarios], async (audit) => {
    const previous = await db.salaryScenarios.get(value.id);
    await db.salaryScenarios.put(value);
    await audit.upsert('salary-scenario', previous, value);
  });
}

export async function deleteGoal(goalId: string): Promise<'deleted' | 'archived'> {
  return auditedFinanceTransaction([db.goals, db.transactions, db.plannedEvents], async (audit) => {
    const goal = await db.goals.get(goalId);
    if (!goal) return 'deleted';
    const [transactionCount, eventCount] = await Promise.all([
      db.transactions.where('goalId').equals(goalId).count(),
      db.plannedEvents.where('linkedGoalId').equals(goalId).count(),
    ]);
    if (transactionCount > 0 || eventCount > 0) {
      const updatedGoal = { ...goal, archived: true };
      await db.goals.put(updatedGoal);
      await audit.upsert('goal', goal, updatedGoal);
      return 'archived';
    }
    await db.goals.delete(goalId);
    await audit.delete('goal', goal);
    return 'deleted';
  });
}

export async function deleteDebt(debtId: string): Promise<void> {
  const count = await db.debtPayments.where('debtId').equals(debtId).count();
  if (count > 0) {
    throw new Error('Dug sa istorijom uplata ne može biti obrisan.');
  }
  await auditedFinanceTransaction([db.debts], async (audit) => {
    const previous = await db.debts.get(debtId);
    await db.debts.delete(debtId);
    await audit.delete('debt', previous);
  });
}

export async function deletePlannedEvent(eventId: string): Promise<void> {
  const event = await db.plannedEvents.get(eventId);
  if (event?.paidTransactionId) {
    throw new Error('Prvo obrišite povezanu transakciju.');
  }
  await auditedFinanceTransaction([db.plannedEvents], async (audit) => {
    await db.plannedEvents.delete(eventId);
    await audit.delete('planned-event', event);
  });
}

export async function deleteCommitment(commitmentId: string): Promise<void> {
  const hasHistory = await db.transactions
    .filter(
      (transaction) =>
        transaction.source === 'commitment' &&
        Boolean(transaction.occurrenceKey?.startsWith(`${commitmentId}:`)),
    )
    .count();
  if (hasHistory) {
    await auditedFinanceTransaction([db.commitments], async (audit) => {
      const previous = await db.commitments.get(commitmentId);
      if (!previous) return;
      const updated = { ...previous, active: false };
      await db.commitments.put(updated);
      await audit.upsert('commitment', previous, updated);
    });
    return;
  }
  await auditedFinanceTransaction([db.commitments], async (audit) => {
    const previous = await db.commitments.get(commitmentId);
    await db.commitments.delete(commitmentId);
    await audit.delete('commitment', previous);
  });
}

export async function deleteVariableBudget(budgetId: string): Promise<void> {
  await auditedFinanceTransaction([db.variableBudgets], async (audit) => {
    const previous = await db.variableBudgets.get(budgetId);
    await db.variableBudgets.delete(budgetId);
    await audit.delete('variable-budget', previous);
  });
}

export async function deletePreset(presetId: string): Promise<void> {
  await auditedFinanceTransaction([db.presets], async (audit) => {
    const previous = await db.presets.get(presetId);
    await db.presets.delete(presetId);
    await audit.delete('quick-add-preset', previous);
  });
}

export async function deletePlannedIncome(plannedIncomeId: string): Promise<void> {
  const hasHistory = await db.transactions.where('plannedIncomeId').equals(plannedIncomeId).count();
  if (hasHistory) {
    await auditedFinanceTransaction([db.plannedIncomes], async (audit) => {
      const previous = await db.plannedIncomes.get(plannedIncomeId);
      if (!previous) return;
      const updated = { ...previous, active: false };
      await db.plannedIncomes.put(updated);
      await audit.upsert('planned-income', previous, updated);
    });
    return;
  }
  await auditedFinanceTransaction([db.plannedIncomes], async (audit) => {
    const previous = await db.plannedIncomes.get(plannedIncomeId);
    await db.plannedIncomes.delete(plannedIncomeId);
    await audit.delete('planned-income', previous);
  });
}

export async function deleteSalaryScenario(scenarioId: string): Promise<void> {
  await auditedFinanceTransaction([db.salaryScenarios, db.settings], async (audit) => {
    const previousScenario = await db.salaryScenarios.get(scenarioId);
    await db.salaryScenarios.delete(scenarioId);
    await audit.delete('salary-scenario', previousScenario);
    const settings = await db.settings.get('settings');
    if (settings?.activeSalaryScenarioId === scenarioId) {
      const updatedSettings = {
        ...settings,
        activeSalaryScenarioId: undefined,
        updatedAt: nowIso(),
      };
      await db.settings.put(updatedSettings);
      await audit.upsert('settings', settings, updatedSettings);
    }
  });
}

export async function updateSettings(
  changes: Partial<Omit<AppSettings, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<void> {
  if (changes.defaultAccountId) await requireAccount(changes.defaultAccountId);
  if (
    changes.activeSalaryScenarioId &&
    !(await db.salaryScenarios.get(changes.activeSalaryScenarioId))
  ) {
    throw new Error('Scenario plate ne postoji.');
  }
  await auditedFinanceTransaction([db.settings], async (audit) => {
    const previous = await db.settings.get('settings');
    if (!previous) throw new Error('Podešavanja ne postoje.');
    const updated = { ...previous, ...changes, updatedAt: nowIso() };
    await db.settings.put(updated);
    await audit.upsert('settings', previous, updated);
  });
}

export async function resetAllFinanceData(): Promise<void> {
  await auditedFinanceTransaction(financeTables(), async (audit) => {
    const existing = await Promise.all(financeTables().map((table) => table.toArray()));
    await Promise.all(financeTables().map((table) => table.clear()));
    const entityTypes = [
      'transaction',
      'debt-payment',
      'account',
      'category',
      'planned-income',
      'commitment',
      'variable-budget',
      'goal',
      'debt',
      'planned-event',
      'quick-add-preset',
      'salary-scenario',
      'settings',
    ] as const;
    for (const [index, values] of existing.entries()) {
      for (const value of values as { id: string }[]) {
        await audit.delete(entityTypes[index], value);
      }
    }
  });
}
