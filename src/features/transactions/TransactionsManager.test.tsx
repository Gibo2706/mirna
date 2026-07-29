import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ToastProvider } from '@/components/ToastProvider';
import { emptyFinanceData, settings, tx } from '@/tests/factories';
import { TransactionsManager } from './TransactionsManager';

describe('transaction history at scale', () => {
  it('keeps the rendered list bounded with 10,000 transactions', () => {
    const data = emptyFinanceData();
    data.transactions = Array.from({ length: 10_000 }, (_, index) =>
      tx({
        id: `tx-${index}`,
        type: 'expense',
        amount: 100 + (index % 20),
        date: `2026-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
        description: `Transakcija ${index}`,
      }),
    );
    const startedAt = performance.now();
    render(
      <MemoryRouter>
        <ToastProvider>
          <TransactionsManager snapshot={{ ...data, settingsRecord: settings }} />
        </ToastProvider>
      </MemoryRouter>,
    );
    const elapsed = performance.now() - startedAt;

    expect(screen.getAllByRole('button', { name: /^Detalji/ })).toHaveLength(100);
    expect(screen.getByRole('button', { name: /Učitaj još/ })).toBeVisible();
    expect(elapsed).toBeLessThan(2_000);
  });
});
