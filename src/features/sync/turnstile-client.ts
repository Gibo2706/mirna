import { SyncApiError, type VerificationReason } from './api';

export type TurnstileAction = 'mirna_vault_create' | 'mirna_pairing_create' | 'mirna_recovery_init';

export type TurnstilePhase =
  | 'idle'
  | 'script-loading'
  | 'widget-ready'
  | 'waiting'
  | 'token-received'
  | 'server-verifying'
  | 'success'
  | 'expired'
  | 'rejected'
  | 'network-error'
  | 'configuration-error';

export interface TurnstileViewState {
  readonly phase: TurnstilePhase;
  readonly action?: TurnstileAction;
  readonly requestId?: string;
  readonly verificationAttemptId?: string;
  readonly verificationReason?: VerificationReason;
}

type TurnstileListener = (state: TurnstileViewState) => void;

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: TurnstileAction;
      execution: 'execute';
      appearance: 'always';
      size: 'flexible' | 'compact';
      theme: 'auto';
      callback: (token: string) => void;
      'before-interactive-callback': () => void;
      'after-interactive-callback': () => void;
      'error-callback': (errorCode?: string | number) => void;
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
      () => reject(new SyncApiError('TURNSTILE_SCRIPT_BLOCKED')),
      LOAD_TIMEOUT_MS,
    );
    const loaded = (): void => {
      window.clearTimeout(timeout);
      if (window.turnstile) resolve(window.turnstile);
      else reject(new SyncApiError('TURNSTILE_CONFIG'));
    };
    const failed = (): void => {
      window.clearTimeout(timeout);
      reject(new SyncApiError('TURNSTILE_SCRIPT_BLOCKED'));
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
  token(action: TurnstileAction): Promise<{
    readonly token: string;
    readonly verificationAttemptId: string;
  }>;
  markServerVerifying?(): void;
  markServerResult?(error?: unknown): void;
  dispose(): void;
}

export interface TurnstileUiController {
  attach(container: HTMLElement | null): void;
  subscribe(listener: TurnstileListener): () => void;
  readonly state: TurnstileViewState;
}

interface ActiveWidget {
  readonly api: TurnstileApi;
  readonly widgetId: string;
  readonly size: 'flexible' | 'compact';
  readonly rerender: (size: 'flexible' | 'compact') => void;
}

interface TurnstileProviderOptions {
  readonly onState?: (state: TurnstileViewState) => void | Promise<void>;
}

const serverFailurePhase = (error: SyncApiError): TurnstilePhase | null => {
  if (
    error.code === 'HUMAN_VERIFICATION_REQUIRED' ||
    error.code === 'HUMAN_VERIFICATION_REJECTED'
  ) {
    return 'rejected';
  }
  if (error.code === 'HUMAN_VERIFICATION_EXPIRED') return 'expired';
  if (error.code === 'HUMAN_VERIFICATION_CONFIGURATION') return 'configuration-error';
  if (error.code === 'HUMAN_VERIFICATION_UNAVAILABLE') return 'network-error';
  if (
    error.code === 'NETWORK_FAILURE' ||
    error.code === 'REQUEST_TIMEOUT' ||
    error.code === 'REQUEST_ABORTED'
  ) {
    return 'network-error';
  }
  if (
    error.code === 'PROTOCOL_MISMATCH' ||
    error.code === 'INVALID_RESPONSE' ||
    error.code === 'INVALID_RESPONSE_CONTENT_TYPE'
  ) {
    return 'configuration-error';
  }
  return null;
};

/**
 * Owns one visible Managed widget and serializes token requests. A token is
 * never reused: every protected API attempt discards the previous widget and
 * obtains a fresh token plus a fresh diagnostic attempt identifier.
 */
export class BrowserTurnstileTokenProvider
  implements TurnstileTokenProvider, TurnstileUiController
{
  readonly #siteKey: string;
  readonly #onState?: TurnstileProviderOptions['onState'];
  readonly #listeners = new Set<TurnstileListener>();
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;
  #container: HTMLElement | null = null;
  #resizeObserver?: ResizeObserver;
  #active?: ActiveWidget;
  #state: TurnstileViewState = Object.freeze({ phase: 'idle' });

  constructor(siteKey: string, options: TurnstileProviderOptions = {}) {
    this.#siteKey = siteKey;
    this.#onState = options.onState;
  }

  get state(): TurnstileViewState {
    return this.#state;
  }

  subscribe(listener: TurnstileListener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  attach(container: HTMLElement | null): void {
    if (this.#container === container) return;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#removeActive();
    this.#container = container;
    if (container && typeof ResizeObserver !== 'undefined') {
      this.#resizeObserver = new ResizeObserver(() => this.#rerenderForSize());
      this.#resizeObserver.observe(container);
    }
  }

  token(action: TurnstileAction): Promise<{
    readonly token: string;
    readonly verificationAttemptId: string;
  }> {
    const verificationAttemptId = crypto.randomUUID();
    const operation = this.#queue.then(() => this.#execute(action, verificationAttemptId));
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  markServerVerifying(): void {
    this.#publish({ ...this.#state, phase: 'server-verifying' });
  }

  markServerResult(error?: unknown): void {
    if (error === undefined) {
      this.#removeActive();
      this.#publish({ ...this.#state, phase: 'success', requestId: undefined });
      return;
    }
    if (!(error instanceof SyncApiError)) return;
    const phase = serverFailurePhase(error);
    if (phase === null) {
      this.#removeActive();
      this.#publish({ ...this.#state, phase: 'success', requestId: error.requestId ?? undefined });
      return;
    }
    this.#removeActive();
    this.#publish({
      ...this.#state,
      phase,
      requestId: error.requestId ?? undefined,
      verificationReason: error.verificationReason ?? undefined,
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#removeActive();
    this.#container = null;
    this.#listeners.clear();
  }

  async #execute(
    action: TurnstileAction,
    verificationAttemptId: string,
  ): Promise<{ readonly token: string; readonly verificationAttemptId: string }> {
    if (this.#disposed) throw new SyncApiError('TURNSTILE_CONFIG');
    const container = this.#container;
    if (!container) {
      this.#publish({ phase: 'configuration-error', action, verificationAttemptId });
      throw new SyncApiError('TURNSTILE_CONFIG');
    }

    this.#removeActive();
    container.replaceChildren();
    this.#publish({ phase: 'script-loading', action, verificationAttemptId });
    let api: TurnstileApi;
    try {
      api = await loadTurnstile();
    } catch (error) {
      this.#publish({ phase: 'configuration-error', action, verificationAttemptId });
      throw error;
    }
    if (this.#disposed || this.#container !== container) {
      throw new SyncApiError('TURNSTILE_CONFIG');
    }

    return new Promise<{ readonly token: string; readonly verificationAttemptId: string }>(
      (resolve, reject) => {
        let settled = false;
        let renderGeneration = 0;
        const finish = (result: { token?: string; errorCode?: string }): void => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          if (result.token) {
            this.#publish({ phase: 'token-received', action, verificationAttemptId });
            resolve({ token: result.token, verificationAttemptId });
            return;
          }
          const code = result.errorCode ?? 'TURNSTILE_REQUIRED';
          this.#removeActive();
          reject(new SyncApiError(code));
        };
        const timeout = window.setTimeout(() => {
          this.#publish({ phase: 'expired', action, verificationAttemptId });
          finish({ errorCode: 'TURNSTILE_TIMEOUT' });
        }, CHALLENGE_TIMEOUT_MS);

        const renderWidget = (size: 'flexible' | 'compact'): void => {
          if (settled) return;
          const previous = this.#active;
          this.#active = undefined;
          if (previous) {
            try {
              previous.api.remove(previous.widgetId);
            } catch {
              // A failed iframe is discarded before a new responsive render.
            }
          }
          container.replaceChildren();
          const generation = ++renderGeneration;
          const current = (callback: () => void): void => {
            if (generation === renderGeneration) callback();
          };
          try {
            const widgetId = api.render(container, {
              sitekey: this.#siteKey,
              action,
              execution: 'execute',
              appearance: 'always',
              size,
              theme: 'auto',
              callback: (token) => current(() => finish({ token })),
              'before-interactive-callback': () =>
                current(() => this.#publish({ phase: 'waiting', action, verificationAttemptId })),
              'after-interactive-callback': () =>
                current(() => this.#publish({ phase: 'waiting', action, verificationAttemptId })),
              'error-callback': () =>
                current(() => {
                  this.#publish({ phase: 'rejected', action, verificationAttemptId });
                  finish({ errorCode: 'TURNSTILE_REJECTED' });
                }),
              'expired-callback': () =>
                current(() => {
                  this.#publish({ phase: 'expired', action, verificationAttemptId });
                  finish({ errorCode: 'TURNSTILE_EXPIRED' });
                }),
              'timeout-callback': () =>
                current(() => {
                  this.#publish({ phase: 'expired', action, verificationAttemptId });
                  finish({ errorCode: 'TURNSTILE_TIMEOUT' });
                }),
            });
            this.#active = { api, widgetId, size, rerender: renderWidget };
            this.#publish({ phase: 'widget-ready', action, verificationAttemptId });
            api.execute(widgetId);
            this.#publish({ phase: 'waiting', action, verificationAttemptId });
          } catch {
            this.#publish({ phase: 'configuration-error', action, verificationAttemptId });
            finish({ errorCode: 'TURNSTILE_CONFIG' });
          }
        };

        renderWidget(this.#widgetSize(container));
      },
    );
  }

  #publish(state: TurnstileViewState): void {
    this.#state = Object.freeze(state);
    for (const listener of this.#listeners) listener(this.#state);
    Promise.resolve(this.#onState?.(this.#state)).catch(() => {
      // Observability is best-effort and never changes verification state.
    });
  }

  #widgetSize(container: HTMLElement): 'flexible' | 'compact' {
    const width = container.clientWidth || container.getBoundingClientRect().width;
    return width >= 300 ? 'flexible' : 'compact';
  }

  #rerenderForSize(): void {
    const active = this.#active;
    const container = this.#container;
    if (!active || !container || !['widget-ready', 'waiting'].includes(this.#state.phase)) return;
    const nextSize = this.#widgetSize(container);
    if (nextSize !== active.size) active.rerender(nextSize);
  }

  #removeActive(): void {
    const active = this.#active;
    this.#active = undefined;
    if (!active) return;
    try {
      active.api.remove(active.widgetId);
    } catch {
      // The script can disappear during page teardown. Cleanup stays best-effort.
    }
    this.#container?.replaceChildren();
  }
}
