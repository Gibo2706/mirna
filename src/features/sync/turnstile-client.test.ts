import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserTurnstileTokenProvider } from './turnstile-client';
import { SyncApiError } from './api';

afterEach(() => {
  delete window.turnstile;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('visible Turnstile client', () => {
  it('renders a React-owned always-visible Managed widget and tracks server verification', async () => {
    let options: Record<string, unknown> | undefined;
    const api = {
      render: vi.fn((_container: HTMLElement, nextOptions: Record<string, unknown>) => {
        options = nextOptions;
        return 'widget-1';
      }),
      execute: vi.fn(),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    window.turnstile = api;
    const provider = new BrowserTurnstileTokenProvider('1x00000000000000000000AA');
    const states: string[] = [];
    provider.subscribe((state) => states.push(state.phase));
    const container = document.createElement('div');
    document.body.append(container);
    provider.attach(container);

    const token = provider.token('mirna_vault_create');
    await vi.waitFor(() => expect(api.render).toHaveBeenCalledOnce());
    expect(options).toMatchObject({
      appearance: 'always',
      execution: 'execute',
      action: 'mirna_vault_create',
    });
    expect(api.execute).toHaveBeenCalledWith('widget-1');
    (options?.callback as (value: string) => void)('single-use-token');
    await expect(token).resolves.toBe('single-use-token');

    provider.markServerVerifying();
    provider.markServerResult();
    expect(states).toEqual(
      expect.arrayContaining([
        'script-loading',
        'widget-ready',
        'waiting',
        'token-received',
        'server-verifying',
        'success',
      ]),
    );
    expect(api.remove).toHaveBeenCalledWith('widget-1');
  });

  it('resets rejected/expired attempts and obtains a fresh token on retry', async () => {
    const renders: Record<string, unknown>[] = [];
    const api = {
      render: vi.fn((_container: HTMLElement, options: Record<string, unknown>) => {
        renders.push(options);
        return `widget-${renders.length}`;
      }),
      execute: vi.fn(),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    window.turnstile = api;
    const provider = new BrowserTurnstileTokenProvider('1x00000000000000000000AA');
    provider.attach(document.createElement('div'));

    const expired = provider.token('mirna_pairing_create');
    await vi.waitFor(() => expect(renders).toHaveLength(1));
    (renders[0]?.['expired-callback'] as () => void)();
    await expect(expired).rejects.toMatchObject({ code: 'TURNSTILE_EXPIRED' });
    expect(api.reset).toHaveBeenCalledWith('widget-1');

    provider.retry();
    const fresh = provider.token('mirna_pairing_create');
    await vi.waitFor(() => expect(renders).toHaveLength(2));
    (renders[1]?.callback as (value: string) => void)('fresh-token');
    await expect(fresh).resolves.toBe('fresh-token');
    provider.markServerVerifying();
    provider.markServerResult(
      new SyncApiError('HUMAN_VERIFICATION_REJECTED', 403, '123e4567-e89b-42d3-a456-426614174000'),
    );
    expect(provider.state).toMatchObject({
      phase: 'rejected',
      requestId: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(api.reset).toHaveBeenCalledWith('widget-2');
  });
});
