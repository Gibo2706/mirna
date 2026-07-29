import type { FinanceData } from './types';

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const uniqueIds = <T extends { id: string }>(label: string, values: T[]): Set<string> => {
  const ids = new Set<string>();
  for (const value of values) {
    assert(!ids.has(value.id), `${label} sadrži ponovljen ID ${value.id}.`);
    ids.add(value.id);
  }
  return ids;
};

/**
 * The single cross-table integrity boundary used by backup import/export and
 * database verification tests. Commands still validate their own inputs before
 * writing so invalid data never becomes observable between mutations.
 */
export function assertFinanceDataIntegrity(data: FinanceData): void {
  const accounts = uniqueIds('Računi', data.accounts);
  const transactions = uniqueIds('Transakcije', data.transactions);
  const categories = uniqueIds('Kategorije', data.categories);
  const plannedIncomes = uniqueIds('Planirani prihodi', data.plannedIncomes);
  const commitments = uniqueIds('Fiksne obaveze', data.commitments);
  uniqueIds('Promenljivi budžeti', data.variableBudgets);
  const goals = uniqueIds('Ciljevi', data.goals);
  const debts = uniqueIds('Dugovi', data.debts);
  const debtPayments = uniqueIds('Uplate dugova', data.debtPayments);
  uniqueIds('Planirani događaji', data.plannedEvents);
  uniqueIds('Quick Add preseti', data.presets);
  const scenarios = uniqueIds('Scenariji plate', data.salaryScenarios);
  uniqueIds('Podešavanja', data.settings);
  assert(data.settings.length === 1, 'Baza mora imati tačno jedan zapis podešavanja.');

  const accountById = new Map(data.accounts.map((value) => [value.id, value]));
  const categoryById = new Map(data.categories.map((value) => [value.id, value]));
  const goalById = new Map(data.goals.map((value) => [value.id, value]));
  const debtById = new Map(data.debts.map((value) => [value.id, value]));
  const paymentById = new Map(data.debtPayments.map((value) => [value.id, value]));
  const eventById = new Map(data.plannedEvents.map((value) => [value.id, value]));
  const transactionById = new Map(data.transactions.map((value) => [value.id, value]));

  const occurrenceKeys = new Set<string>();
  const eventTransactionLinks = new Set<string>();
  const debtTransactionLinks = new Set<string>();

  for (const transaction of data.transactions) {
    assert(
      accounts.has(transaction.accountId),
      `Transakcija ${transaction.id} ima nepoznat račun.`,
    );
    if (transaction.toAccountId) {
      assert(
        accounts.has(transaction.toAccountId),
        `Transfer ${transaction.id} ima nepoznat ciljni račun.`,
      );
    }
    if (transaction.type === 'transfer') {
      assert(transaction.toAccountId, `Transfer ${transaction.id} nema ciljni račun.`);
      assert(
        transaction.accountId !== transaction.toAccountId,
        `Transfer ${transaction.id} koristi isti izvorni i ciljni račun.`,
      );
    }
    if (transaction.categoryId) {
      const category = categoryById.get(transaction.categoryId);
      assert(category, `Transakcija ${transaction.id} ima nepoznatu kategoriju.`);
      if (transaction.type === 'income') {
        assert(
          category.kind === 'income',
          `Prihod ${transaction.id} mora koristiti prihodnu kategoriju.`,
        );
      }
      if (transaction.type === 'expense') {
        assert(
          category.kind === 'expense',
          `Trošak ${transaction.id} mora koristiti rashodnu kategoriju.`,
        );
      }
    }
    if (transaction.goalId) {
      const goal = goalById.get(transaction.goalId);
      assert(goal, `Transakcija ${transaction.id} ima nepoznat cilj.`);
      if (transaction.source === 'goal') {
        assert(
          transaction.type === 'transfer' && transaction.toAccountId === goal.linkedAccountId,
          `Uplata cilja ${transaction.id} nije transfer na povezani račun.`,
        );
      }
    }
    if (transaction.source === 'goal') {
      assert(transaction.goalId, `Uplata cilja ${transaction.id} nema vezu ka cilju.`);
    }
    if (transaction.occurrenceKey) {
      assert(
        !occurrenceKeys.has(transaction.occurrenceKey),
        `Ponavlja se occurrence ${transaction.occurrenceKey}.`,
      );
      occurrenceKeys.add(transaction.occurrenceKey);
    }
    if (transaction.source === 'commitment') {
      const separator = transaction.occurrenceKey?.lastIndexOf(':') ?? -1;
      const commitmentId = transaction.occurrenceKey?.slice(0, separator);
      assert(
        separator > 0 && commitmentId && commitments.has(commitmentId),
        `Transakcija ${transaction.id} ima nepoznatu fiksnu obavezu.`,
      );
    }
    if (transaction.plannedIncomeId) {
      assert(
        plannedIncomes.has(transaction.plannedIncomeId),
        `Transakcija ${transaction.id} ima nepoznat planirani prihod.`,
      );
      assert(
        transaction.source === 'planned-income' &&
          transaction.type === 'income' &&
          transaction.occurrenceKey?.startsWith(`income:${transaction.plannedIncomeId}:`),
        `Transakcija ${transaction.id} nije ispravna realizacija planiranog prihoda.`,
      );
    }
    if (transaction.source === 'planned-income') {
      assert(transaction.plannedIncomeId, `Planirani prihod ${transaction.id} nema vezu ka planu.`);
    }
    if (transaction.plannedEventId) {
      const event = eventById.get(transaction.plannedEventId);
      assert(event, `Transakcija ${transaction.id} ima nepoznat planirani događaj.`);
      assert(
        !eventTransactionLinks.has(transaction.plannedEventId),
        `Događaj ${transaction.plannedEventId} je povezan sa više transakcija.`,
      );
      eventTransactionLinks.add(transaction.plannedEventId);
      assert(
        transaction.source === 'planned-event' && transaction.type === 'expense',
        `Transakcija događaja ${transaction.id} mora biti trošak.`,
      );
      assert(
        event.paidTransactionId === transaction.id,
        `Događaj ${event.id} nema povratnu vezu ka transakciji ${transaction.id}.`,
      );
    }
    if (transaction.source === 'planned-event') {
      assert(
        transaction.plannedEventId,
        `Transakcija događaja ${transaction.id} nema vezu ka planu.`,
      );
    }
    if (transaction.debtPaymentId) {
      assert(
        debtPayments.has(transaction.debtPaymentId),
        `Transakcija ${transaction.id} ima nepoznatu uplatu duga.`,
      );
      assert(
        !debtTransactionLinks.has(transaction.debtPaymentId),
        `Uplata duga ${transaction.debtPaymentId} ima više transakcija.`,
      );
      debtTransactionLinks.add(transaction.debtPaymentId);
      assert(
        transaction.source === 'debt' && transaction.type === 'expense',
        `Transakcija duga ${transaction.id} mora biti trošak.`,
      );
    }
    if (transaction.source === 'debt') {
      assert(transaction.debtPaymentId, `Transakcija duga ${transaction.id} nema vezu ka uplati.`);
    }
  }

  const primarySalaries = data.plannedIncomes.filter((value) => value.isPrimarySalary);
  assert(primarySalaries.length <= 1, 'Može postojati samo jedan primarni plan plate.');
  for (const plannedIncome of data.plannedIncomes) {
    assert(
      accounts.has(plannedIncome.accountId),
      `Planirani prihod ${plannedIncome.id} ima nepoznat račun.`,
    );
    assert(
      categoryById.get(plannedIncome.categoryId)?.kind === 'income',
      `Planirani prihod ${plannedIncome.id} mora koristiti prihodnu kategoriju.`,
    );
  }
  for (const commitment of data.commitments) {
    assert(accounts.has(commitment.accountId), `Obaveza ${commitment.id} ima nepoznat račun.`);
    assert(
      categoryById.get(commitment.categoryId)?.kind === 'expense',
      `Obaveza ${commitment.id} mora koristiti rashodnu kategoriju.`,
    );
  }
  for (const budget of data.variableBudgets) {
    assert(
      categoryById.get(budget.categoryId)?.kind === 'expense',
      `Budžet ${budget.id} mora koristiti rashodnu kategoriju.`,
    );
  }

  const linkedGoalAccounts = new Set<string>();
  for (const goal of data.goals) {
    const linkedAccount = accountById.get(goal.linkedAccountId);
    assert(linkedAccount, `Cilj ${goal.id} ima nepoznat račun.`);
    assert(linkedAccount.protected, `Cilj ${goal.id} mora koristiti zaštićen račun.`);
    assert(
      !linkedGoalAccounts.has(goal.linkedAccountId),
      `Više ciljeva koristi isti namenski račun ${goal.linkedAccountId}.`,
    );
    linkedGoalAccounts.add(goal.linkedAccountId);
    assert(
      goal.goalType === 'sinking' || !goal.usedAt,
      `Rezervni fond ${goal.id} ne može biti označen kao iskorišćen.`,
    );
  }

  for (const payment of data.debtPayments) {
    const debt = debtById.get(payment.debtId);
    assert(debt, `Uplata ${payment.id} ima nepoznat dug.`);
    if (payment.source === 'self') {
      assert(payment.transactionId, `Lična uplata ${payment.id} nema transakciju.`);
      const transaction = transactionById.get(payment.transactionId);
      assert(transaction, `Uplata ${payment.id} ima nepoznatu transakciju.`);
      assert(
        transaction.debtPaymentId === payment.id &&
          transaction.source === 'debt' &&
          transaction.type === 'expense' &&
          transaction.amount === payment.amount,
        `Uplata ${payment.id} i njena transakcija nisu usklađene.`,
      );
    } else {
      assert(!payment.transactionId, `Spoljna uplata ${payment.id} ne sme imati transakciju.`);
    }
  }

  for (const debt of data.debts) {
    const paid = data.debtPayments
      .filter((payment) => payment.debtId === debt.id)
      .reduce((sum, payment) => sum + payment.amount, 0);
    assert(paid <= debt.originalAmount, `Dug ${debt.id} je preplaćen.`);
  }

  for (const event of data.plannedEvents) {
    assert(accounts.has(event.accountId), `Događaj ${event.id} ima nepoznat račun.`);
    assert(
      categoryById.get(event.categoryId)?.kind === 'expense',
      `Događaj ${event.id} mora koristiti rashodnu kategoriju.`,
    );
    if (event.linkedGoalId) {
      assert(goals.has(event.linkedGoalId), `Događaj ${event.id} ima nepoznat cilj.`);
    }
    if (event.paidTransactionId) {
      const transaction = transactionById.get(event.paidTransactionId);
      assert(transaction, `Događaj ${event.id} ima nepoznatu transakciju.`);
      assert(
        transaction.plannedEventId === event.id &&
          transaction.source === 'planned-event' &&
          transaction.type === 'expense',
        `Događaj ${event.id} i njegova transakcija nisu usklađeni.`,
      );
    }
  }

  for (const goal of data.goals.filter((value) => value.usedAt)) {
    assert(
      data.plannedEvents.some(
        (event) =>
          event.linkedGoalId === goal.id &&
          event.accountId === goal.linkedAccountId &&
          Boolean(event.paidTransactionId),
      ),
      `Iskorišćeni namenski cilj ${goal.id} nema plaćen povezani događaj.`,
    );
  }

  for (const preset of data.presets) {
    if (preset.defaultAccountId) {
      assert(accounts.has(preset.defaultAccountId), `Preset ${preset.id} ima nepoznat račun.`);
    }
    if (preset.categoryId) {
      assert(
        categoryById.get(preset.categoryId)?.kind === preset.type,
        `Preset ${preset.id} ima kategoriju pogrešnog tipa.`,
      );
    }
  }

  const settings = data.settings[0];
  if (settings.defaultAccountId) {
    assert(accounts.has(settings.defaultAccountId), 'Podrazumevani račun ne postoji.');
  }
  if (settings.activeSalaryScenarioId) {
    assert(scenarios.has(settings.activeSalaryScenarioId), 'Aktivni scenario plate ne postoji.');
  }

  // Keep sets/maps referenced so future additions cannot accidentally shadow them.
  void transactions;
  void categories;
  void debts;
  void paymentById;
}
