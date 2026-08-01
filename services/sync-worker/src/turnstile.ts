import type { RequestContext } from './context';
import { HttpError } from './errors';

export const TURNSTILE_TOKEN_HEADER = 'X-Mirna-Turnstile-Token';

export type TurnstileAction = 'mirna_vault_create' | 'mirna_pairing_create' | 'mirna_recovery_init';

interface TurnstileSiteverifyResponse {
  readonly success?: boolean;
  readonly hostname?: string;
  readonly action?: string;
}

const isSiteverifyResponse = (value: unknown): value is TurnstileSiteverifyResponse =>
  typeof value === 'object' && value !== null;

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const verificationFailed = (): HttpError =>
  new HttpError(403, 'HUMAN_VERIFICATION_REQUIRED', 'Human verification is required.');

const exactExpectedHostname = (context: RequestContext): string => {
  if (context.allowedOrigin === null) throw verificationFailed();
  try {
    return new URL(context.allowedOrigin).hostname;
  } catch {
    throw verificationFailed();
  }
};

/**
 * Siteverify is authoritative and makes tokens single-use. The Worker never
 * logs or persists the token, response body, secret or visitor IP address.
 */
export const requireTurnstile = async (
  context: RequestContext,
  expectedAction: TurnstileAction,
  fetcher: Fetch = fetch,
): Promise<void> => {
  // Local Miniflare tests exercise the validator separately with injected
  // Siteverify responses. A deployed staging Worker can never bypass it.
  if (context.env.MIRNA_ENVIRONMENT !== 'staging') return;

  const token = context.request.headers.get(TURNSTILE_TOKEN_HEADER);
  const secret = context.env.TURNSTILE_SECRET_KEY;
  if (!token || token.length > 2_048 || !secret) throw verificationFailed();

  const body = new URLSearchParams({
    secret,
    response: token,
    idempotency_key: context.requestId,
  });
  const remoteIp = context.request.headers.get('CF-Connecting-IP');
  if (remoteIp && remoteIp.length <= 64) body.set('remoteip', remoteIp);

  try {
    const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw verificationFailed();
    const result: unknown = await response.json();
    if (
      !isSiteverifyResponse(result) ||
      result.success !== true ||
      result.hostname !== exactExpectedHostname(context) ||
      result.action !== expectedAction
    ) {
      throw verificationFailed();
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw verificationFailed();
  }
};
