import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserTurnstileTokenProvider } from './turnstile-client';
import { SyncApiError } from './api';

afterEach(() => {
  delete window.turnstile;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
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
      size: 'compact',
      theme: 'auto',
    });
    expect(api.execute).toHaveBeenCalledWith('widget-1');
    (options?.callback as (value: string) => void)('single-use-token');
    const result = await token;
    expect(result.token).toBe('single-use-token');
    expect(result.verificationAttemptId).toMatch(/^[0-9a-f-]{36}$/u);

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

  it('removes rejected/expired attempts and obtains a fresh token and attempt ID on retry', async () => {
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
    const expiredAttemptId = provider.state.verificationAttemptId;
    (renders[0]?.['expired-callback'] as () => void)();
    await expect(expired).rejects.toMatchObject({ code: 'TURNSTILE_EXPIRED' });
    expect(api.remove).toHaveBeenCalledWith('widget-1');

    const fresh = provider.token('mirna_pairing_create');
    await vi.waitFor(() => expect(renders).toHaveLength(2));
    expect(provider.state.verificationAttemptId).not.toBe(expiredAttemptId);
    (renders[1]?.callback as (value: string) => void)('fresh-token');
    const freshResult = await fresh;
    expect(freshResult.token).toBe('fresh-token');
    expect(freshResult.verificationAttemptId).toMatch(/^[0-9a-f-]{36}$/u);
    provider.markServerVerifying();
    provider.markServerResult(
      new SyncApiError('HUMAN_VERIFICATION_REJECTED', 403, '123e4567-e89b-42d3-a456-426614174000'),
    );
    expect(provider.state).toMatchObject({
      phase: 'rejected',
      requestId: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(api.remove).toHaveBeenCalledWith('widget-2');
  });

  it.each([320, 360, 390, 412, 430])(
    'selects a supported responsive widget size at a %i px viewport',
    async (viewportWidth) => {
      let options: Record<string, unknown> | undefined;
      const api = {
        render: vi.fn((_container: HTMLElement, nextOptions: Record<string, unknown>) => {
          options = nextOptions;
          return 'responsive-widget';
        }),
        execute: vi.fn(),
        remove: vi.fn(),
      };
      window.turnstile = api;
      const container = document.createElement('div');
      Object.defineProperty(container, 'clientWidth', {
        configurable: true,
        value: viewportWidth - 64,
      });
      const provider = new BrowserTurnstileTokenProvider('1x00000000000000000000AA');
      provider.attach(container);

      const token = provider.token('mirna_vault_create');
      await vi.waitFor(() => expect(api.render).toHaveBeenCalledOnce());
      expect(options).toMatchObject({
        size: viewportWidth <= 360 ? 'compact' : 'flexible',
        theme: 'auto',
        appearance: 'always',
        execution: 'execute',
      });
      (options?.callback as (value: string) => void)('responsive-token');
      await expect(token).resolves.toMatchObject({ token: 'responsive-token' });
      provider.dispose();
    },
  );

  it('discards and rerenders the pending widget after a meaningful width change', async () => {
    let resize: (() => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    const renders: Record<string, unknown>[] = [];
    const api = {
      render: vi.fn((_container: HTMLElement, options: Record<string, unknown>) => {
        renders.push(options);
        return `responsive-widget-${renders.length}`;
      }),
      execute: vi.fn(),
      remove: vi.fn(),
    };
    window.turnstile = api;
    let width = 280;
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      get: () => width,
    });
    const provider = new BrowserTurnstileTokenProvider('1x00000000000000000000AA');
    provider.attach(container);
    const token = provider.token('mirna_vault_create');
    await vi.waitFor(() => expect(renders).toHaveLength(1));
    expect(renders[0]).toMatchObject({ size: 'compact' });

    width = 320;
    resize?.();
    await vi.waitFor(() => expect(renders).toHaveLength(2));
    expect(api.remove).toHaveBeenCalledWith('responsive-widget-1');
    expect(renders[1]).toMatchObject({ size: 'flexible' });
    (renders[1]?.callback as (value: string) => void)('rerendered-token');
    await expect(token).resolves.toMatchObject({ token: 'rerendered-token' });
    provider.dispose();
  });
});
