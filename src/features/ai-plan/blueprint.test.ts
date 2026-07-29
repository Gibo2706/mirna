import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFinanceDataIntegrity } from '@/domain/integrity';
import { db, financeTables } from '@/db/database';
import { readFinanceData } from '@/db/queries';
import {
  createBlueprintPrompt,
  importPlanBlueprint,
  MAX_AI_PLAN_INPUT_BYTES,
  normalizePlanBlueprint,
  parsePlanBlueprint,
  PLAN_BLUEPRINT_VERSION,
  type PlanBlueprint,
} from './blueprint';

const validBlueprint = (): PlanBlueprint => ({
  planBlueprintVersion: PLAN_BLUEPRINT_VERSION,
  currency: 'RSD',
  accounts: [
    {
      key: 'checking',
      name: 'Tekući račun',
      kind: 'checking',
      startingBalance: 42_000,
      protected: false,
    },
    {
      key: 'savings',
      name: 'Štednja — rezerva',
      kind: 'savings',
      startingBalance: 3_000,
      protected: true,
    },
  ],
  categories: [
    { key: 'salary', name: 'Plata', kind: 'income', icon: '💼' },
    { key: 'food', name: 'Hrana', kind: 'expense', icon: '🥗' },
  ],
  plannedIncomes: [
    {
      key: 'salary_plan',
      name: 'Plata',
      amount: 120_000,
      categoryKey: 'salary',
      accountKey: 'checking',
      frequency: 'monthly',
      startDate: '2026-08-01',
      expectedDay: 5,
      active: true,
      isPrimarySalary: true,
    },
  ],
  fixedCommitments: [
    {
      key: 'internet',
      name: 'Internet',
      amount: 3_000,
      categoryKey: 'food',
      accountKey: 'checking',
      frequency: 'monthly',
      startDate: '2026-08-01',
      dueDay: 10,
      active: true,
    },
  ],
  variableBudgets: [
    {
      key: 'budget_food',
      name: 'Hrana',
      defaultAmount: 20_000,
      categoryKey: 'food',
      overrides: { '2026-12': 25_000 },
      active: true,
    },
  ],
  goals: [
    {
      key: 'reserve_goal',
      name: 'Rezerva',
      emoji: '🛟',
      targetAmount: 150_000,
      linkedAccountKey: 'savings',
      plannedMonthlyContribution: 10_000,
      contributionOverrides: {},
      goalType: 'reserve',
    },
  ],
  debts: [
    {
      key: 'debt_marko',
      creditor: 'Poverilac A',
      originalAmount: 20_000,
      priority: 'medium',
      paymentOverrides: {},
    },
  ],
  plannedEvents: [
    {
      key: 'gift',
      title: 'Poklon',
      date: '2026-12-20',
      plannedAmount: 5_000,
      categoryKey: 'food',
      accountKey: 'checking',
    },
  ],
  salaryScenarios: [
    {
      key: 'new_job',
      name: 'Novi posao',
      monthlyAmount: 150_000,
      startMonth: '2027-01',
    },
  ],
  quickAddPresets: [
    {
      key: 'food_quick',
      name: 'Hrana',
      emoji: '🥗',
      type: 'expense',
      categoryKey: 'food',
      defaultAccountKey: 'checking',
      position: 0,
      active: true,
    },
  ],
});

const parse = (value: unknown) => parsePlanBlueprint(JSON.stringify(value));

describe('Mirna Plan Blueprint v1', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.transaction('rw', financeTables(), async () => {
      await Promise.all(financeTables().map((table) => table.clear()));
    });
  });

  it('creates a provider-neutral conversion prompt with the complete v1 boundary', () => {
    const prompt = createBlueprintPrompt();
    expect(prompt).toContain('Mirna Plan Blueprint v1');
    expect(prompt).toContain('"planBlueprintVersion": 1');
    expect(prompt).toContain('"quickAddPresets": []');
    expect(prompt).toContain('Ne vraćaj istorijske transakcije');
    expect(prompt).toContain('tačno jedan JSON dokument');
    expect(prompt).toContain('kada stanje računa nije poznato koristi null');
    expect(prompt).not.toContain('API ključ');
  });

  it('validates and normalizes a complete planning blueprint without history', () => {
    const preview = parse(validBlueprint());
    const data = normalizePlanBlueprint(preview.blueprint);
    expect(preview.counts).toMatchObject({ accounts: 2, goals: 1, plannedEvents: 1 });
    expect(data.transactions).toEqual([]);
    expect(data.debtPayments).toEqual([]);
    expect(data.accounts.map((value) => value.openingBalance)).toEqual([42_000, 3_000]);
    expect(data.settings[0].onboardingCompleted).toBe(false);
    assertFinanceDataIntegrity(data);
  });

  it('keeps an unknown account balance unresolved until the user enters an explicit value', async () => {
    const blueprint = validBlueprint();
    blueprint.accounts[0].startingBalance = null;
    const preview = parse(blueprint);

    expect(preview.unresolvedAccountKeys).toEqual(['checking']);
    expect(() => normalizePlanBlueprint(preview.blueprint)).toThrow('Unesite trenutno stanje');
    await expect(importPlanBlueprint(preview)).rejects.toThrow('Unesite sva trenutna stanja');
  });

  it('distinguishes a confirmed zero balance from an unknown balance', () => {
    const blueprint = validBlueprint();
    blueprint.accounts[0].startingBalance = 0;
    const preview = parse(blueprint);
    const data = normalizePlanBlueprint(preview.blueprint);

    expect(preview.unresolvedAccountKeys).toEqual([]);
    expect(data.accounts[0].openingBalance).toBe(0);
  });

  it('accepts exactly one JSON markdown fence', () => {
    const raw = `\`\`\`json\n${JSON.stringify(validBlueprint())}\n\`\`\``;
    expect(parsePlanBlueprint(raw).blueprint.planBlueprintVersion).toBe(1);
  });

  it('rejects invalid or competing JSON documents', () => {
    expect(() => parsePlanBlueprint('{')).toThrow('validan JSON');
    expect(() =>
      parsePlanBlueprint(
        `\`\`\`json\n${JSON.stringify(validBlueprint())}\n\`\`\`\n\`\`\`json\n{}\n\`\`\``,
      ),
    ).toThrow('više');
    expect(() =>
      parsePlanBlueprint(
        `${JSON.stringify(validBlueprint())}\n${JSON.stringify(validBlueprint())}`,
      ),
    ).toThrow('jedan validan JSON');
  });

  it('rejects unsupported versions, duplicate keys and dangling references', () => {
    expect(() => parse({ ...validBlueprint(), planBlueprintVersion: 2 })).toThrow(
      'planBlueprintVersion',
    );
    const duplicate = validBlueprint();
    duplicate.accounts.push({ ...duplicate.accounts[0] });
    expect(() => parse(duplicate)).toThrow('ponavlja');
    const dangling = validBlueprint();
    dangling.plannedIncomes[0].accountKey = 'missing';
    expect(() => parse(dangling)).toThrow('ne postoji');
  });

  it('rejects decimal, negative and malformed temporal values', () => {
    const decimal = validBlueprint();
    decimal.variableBudgets[0].defaultAmount = 1.5;
    expect(() => parse(decimal)).toThrow('int');

    const negative = validBlueprint();
    negative.accounts[0].startingBalance = -1;
    expect(() => parse(negative)).toThrow('Too small');

    const badDate = validBlueprint();
    badDate.plannedEvents[0].date = '2026-02-30';
    expect(() => parse(badDate)).toThrow('stvarni ISO datum');

    const badMonth = validBlueprint();
    badMonth.salaryScenarios[0].startMonth = '2026-13';
    expect(() => parse(badMonth)).toThrow('YYYY-MM');
  });

  it('rejects oversized fields and input payloads', () => {
    const longName = validBlueprint();
    longName.accounts[0].name = 'a'.repeat(121);
    expect(() => parse(longName)).toThrow('Too big');
    expect(() => parsePlanBlueprint(' '.repeat(MAX_AI_PLAN_INPUT_BYTES + 1))).toThrow('512 KB');
  });

  it.each([
    ['transactions', []],
    ['adjustments', []],
    ['paidTransactionId', 'tx_forged'],
    ['occurrenceKey', 'forged:2026-08'],
    ['id', 'database-id'],
  ])('rejects forbidden history/internal field %s', (field, value) => {
    const blueprint = validBlueprint() as unknown as Record<string, unknown>;
    if (field === 'paidTransactionId' || field === 'occurrenceKey' || field === 'id') {
      (blueprint.plannedEvents as Array<Record<string, unknown>>)[0][field] = value;
    } else {
      blueprint[field] = value;
    }
    expect(() => parse(blueprint)).toThrow('ne prihvata');
  });

  it('imports normalized data atomically and passes full integrity', async () => {
    const preview = parse(validBlueprint());
    await importPlanBlueprint(preview);
    const data = await readFinanceData();
    expect(data.accounts).toHaveLength(2);
    expect(data.transactions).toEqual([]);
    expect(data.plannedEvents[0].paidTransactionId).toBeUndefined();
    assertFinanceDataIntegrity(data);
  });

  it('rolls back every write when the final table write fails', async () => {
    await db.settings.add({
      id: 'settings',
      onboardingCompleted: false,
      baseMonthlyIncome: 0,
      currency: 'RSD',
      locale: 'sr-Latn-RS',
      appearance: 'system',
      installHintDismissed: false,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    vi.spyOn(db.settings, 'bulkAdd').mockRejectedValueOnce(new Error('forced write failure'));
    await expect(importPlanBlueprint(parse(validBlueprint()))).rejects.toThrow(
      'forced write failure',
    );
    expect(await db.accounts.count()).toBe(0);
    expect(await db.settings.get('settings')).toMatchObject({ onboardingCompleted: false });
  });

  it('refuses to merge a full blueprint into existing financial data', async () => {
    await db.accounts.add({
      id: 'live',
      name: 'Živi račun',
      kind: 'checking',
      openingBalance: 1,
      protected: false,
      color: '#000',
      archived: false,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    await expect(importPlanBlueprint(parse(validBlueprint()))).rejects.toThrow('praznoj Mirni');
    expect(await db.accounts.get('live')).toBeTruthy();
  });
});
