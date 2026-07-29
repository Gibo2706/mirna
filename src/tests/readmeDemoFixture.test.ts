import { describe, expect, it } from 'vitest';
import { calculateAccountBalances } from '@/domain/calculations';
import { assertFinanceDataIntegrity } from '@/domain/integrity';
import { readmeDemoFixture } from './fixtures/readmeDemoFixture';

describe('README documentation fixture', () => {
  it('is a deterministic, internally valid synthetic finance dataset', () => {
    const { data, frozenAt, viewport } = readmeDemoFixture;

    expect(() => assertFinanceDataIntegrity(data)).not.toThrow();
    expect(frozenAt).toBe('2034-04-18T10:00:00.000Z');
    expect(viewport).toEqual({ width: 390, height: 844 });
    expect(data.settings).toHaveLength(1);
    expect(data.transactions.length).toBeGreaterThan(0);
    expect(data.plannedEvents.length).toBeGreaterThanOrEqual(3);
    expect(data.goals.map((goal) => goal.goalType).sort()).toEqual(['reserve', 'sinking']);

    const balances = calculateAccountBalances(data.accounts, data.transactions);
    expect(balances.docs_account_daily).toBeGreaterThan(0);
    expect(data.accounts.filter((account) => account.protected)).toHaveLength(2);
  });
});
