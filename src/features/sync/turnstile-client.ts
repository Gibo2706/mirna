import { SyncApiError } from './api';

export type TurnstileAction = 'mirna_vault_create' | 'mirna_pairing_create' | 'mirna_recovery_init';

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: TurnstileAction;
      execution: 'execute';
      appearance: 'interaction-only';
      callback: (token: string) => void;
      'error-callback': () => void;
      'expired-callback': () => void;
      'timeout-callback': () => void;
    },
  ): string;
  execute(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_ID = 'mirna-turnstile-api';
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const LOAD_TIMEOUT_MS = 10_000;
const CHALLENGE_TIMEOUT_MS = 120_000;

let scriptPromise: Promise<TurnstileApi> | undefined;

const loadTurnstile = (): Promise<TurnstileApi> => {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');
    const timeout = window.setTimeout(
      () => reject(new SyncApiError('TURNSTILE_REQUIRED')),
      LOAD_TIMEOUT_MS,
    );
    const loaded = (): void => {
      window.clearTimeout(timeout);
      if (window.turnstile) resolve(window.turnstile);
      else reject(new SyncApiError('TURNSTILE_REQUIRED'));
    };
    const failed = (): void => {
      window.clearTimeout(timeout);
      reject(new SyncApiError('TURNSTILE_REQUIRED'));
    };
    script.addEventListener('load', loaded, { once: true });
    script.addEventListener('error', failed, { once: true });
    if (!existing) {
      script.id = SCRIPT_ID;
      script.src = SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.crossOrigin = 'anonymous';
      document.head.append(script);
    }
  }).catch((error: unknown) => {
    scriptPromise = undefined;
    throw error;
  });
  return scriptPromise;
};

export interface TurnstileTokenProvider {
  token(action: TurnstileAction): Promise<string>;
  dispose(): void;
}

export class BrowserTurnstileTokenProvider implements TurnstileTokenProvider {
  readonly #siteKey: string;
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;
  #active?: { api: TurnstileApi; widgetId: string; container: HTMLElement };

  constructor(siteKey: string) {
    this.#siteKey = siteKey;
  }

  token(action: TurnstileAction): Promise<string> {
    const operation = this.#queue.then(() => this.#execute(action));
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  dispose(): void {
    this.#disposed = true;
    this.#removeActive();
  }

  async #execute(action: TurnstileAction): Promise<string> {
    if (this.#disposed) throw new SyncApiError('TURNSTILE_REQUIRED');
    const api = await loadTurnstile();
    if (this.#disposed) throw new SyncApiError('TURNSTILE_REQUIRED');
    const container = document.createElement('div');
    container.setAttribute('aria-label', 'Cloudflare provera protiv zloupotrebe');
    container.style.position = 'fixed';
    container.style.inset = 'auto 1rem 1rem auto';
    container.style.zIndex = '2147483647';
    document.body.append(container);

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (token?: string): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        this.#removeActive();
        if (token) resolve(token);
        else reject(new SyncApiError('TURNSTILE_REQUIRED'));
      };
      const timeout = window.setTimeout(() => finish(), CHALLENGE_TIMEOUT_MS);
      try {
        const widgetId = api.render(container, {
          sitekey: this.#siteKey,
          action,
          execution: 'execute',
          appearance: 'interaction-only',
          callback: (token) => finish(token),
          'error-callback': () => finish(),
          'expired-callback': () => finish(),
          'timeout-callback': () => finish(),
        });
        this.#active = { api, widgetId, container };
        api.execute(widgetId);
      } catch {
        finish();
      }
    });
  }

  #removeActive(): void {
    const active = this.#active;
    this.#active = undefined;
    if (!active) return;
    try {
      active.api.remove(active.widgetId);
    } finally {
      active.container.remove();
    }
  }
}
