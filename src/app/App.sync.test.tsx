import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

vi.mock('@/db/queries', () => ({
  useFinanceSnapshot: () => null,
}));

vi.mock('@/features/sync/SyncManager', () => ({
  SyncManager: ({ preOnboarding }: { preOnboarding?: boolean }) => (
    <div>
      <h1>Test sync ulaz</h1>
      <p>{preOnboarding ? 'pre-onboarding' : 'onboarded'}</p>
    </div>
  ),
}));

describe('pre-onboarding sync route', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_MIRNA_SYNC_ENABLED', 'true');
    vi.stubEnv('VITE_MIRNA_SYNC_API_URL', 'http://localhost');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('opens pairing and recovery entry before onboarding when the flag is enabled', async () => {
    render(
      <MemoryRouter initialEntries={['/more/sync']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Test sync ulaz' })).toBeVisible();
    expect(screen.getByText('pre-onboarding')).toBeVisible();
  });
});
