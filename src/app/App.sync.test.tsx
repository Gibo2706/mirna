import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { SyncUiServices } from '@/features/sync/ui-services';

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
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
    vi.stubEnv('VITE_MIRNA_APP_ENV', 'local-beta');
    vi.stubEnv('VITE_MIRNA_BETA_ONLY', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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

  it('does not construct a runtime or make sync requests when the feature is disabled', () => {
    vi.stubEnv('VITE_MIRNA_SYNC_ENABLED', 'false');
    vi.stubEnv('VITE_MIRNA_BETA_ONLY', 'false');
    const loadLocalStatus = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    render(
      <MemoryRouter initialEntries={['/']}>
        <App syncServices={{ loadLocalStatus } as unknown as SyncUiServices} />
      </MemoryRouter>,
    );

    expect(loadLocalStatus).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByText('Test sync ulaz')).not.toBeInTheDocument();
  });
});
