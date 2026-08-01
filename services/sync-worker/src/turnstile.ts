import { z } from 'zod';
import type { RequestContext } from './context';
import { HttpError } from './errors';
import { recordBetaDiagnostic, type ServerDiagnosticCategory } from './diagnostics';

export const TURNSTILE_TOKEN_HEADER = 'X-Mirna-Turnstile-Token';

export type TurnstileAction = 'mirna_vault_create' | 'mirna_pairing_create' | 'mirna_recovery_init';

const siteverifySchema = z.strictObject({
  success: z.boolean(),
  challenge_ts: z.string().datetime({ offset: true }).optional(),
  hostname: z.string().min(1).max(253).optional(),
  'error-codes': z
    .array(
      z.enum([
        'missing-input-secret',
        'invalid-input-secret',
        'missing-input-response',
        'invalid-input-response',
        'bad-request',
        'timeout-or-duplicate',
        'internal-error',
      ]),
    )
    .max(8)
    .optional(),
  messages: z.array(z.string().max(256)).max(8).optional(),
  action: z.string().min(1).max(32).optional(),
  cdata: z.string().max(255).optional(),
  metadata: z
    .strictObject({
      ephemeral_id: z.string().min(1).max(255).optional(),
    })
    .optional(),
});

type SiteverifyResult = z.output<typeof siteverifySchema>;
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const verificationError = (
  category: ServerDiagnosticCategory,
): { readonly error: HttpError; readonly category: ServerDiagnosticCategory } => {
  switch (category) {
    case 'missing-secret':
    case 'siteverify-missing-input-secret':
    case 'siteverify-invalid-input-secret':
    case 'hostname-mismatch':
    case 'action-mismatch':
      return {
        category,
        error: new HttpError(
          503,
          'HUMAN_VERIFICATION_CONFIGURATION',
          'Human verification is not configured correctly.',
        ),
      };
    case 'siteverify-timeout-or-duplicate':
      return {
        category,
        error: new HttpError(
          403,
          'HUMAN_VERIFICATION_EXPIRED',
          'Human verification expired or was already used.',
        ),
      };
    case 'siteverify-http-error':
    case 'siteverify-internal-error':
    case 'siteverify-network-timeout':
    case 'siteverify-network-policy':
    case 'siteverify-network-redirect':
    case 'siteverify-runtime-context-error':
    case 'siteverify-type-error':
    case 'siteverify-network-error':
      return {
        category,
        error: new HttpError(
          503,
          'HUMAN_VERIFICATION_UNAVAILABLE',
          'Human verification is temporarily unavailable.',
        ),
      };
    default:
      return {
        category,
        error: new HttpError(
          403,
          'HUMAN_VERIFICATION_REJECTED',
          'Human verification was not accepted.',
        ),
      };
  }
};

const fail = async (
  context: RequestContext,
  action: TurnstileAction,
  category: ServerDiagnosticCategory,
  details?: Readonly<Record<string, string | boolean>>,
): Promise<never> => {
  const failure = verificationError(category);
  await recordBetaDiagnostic(context, {
    eventType: 'turnstile_siteverify_result',
    severity: 'error',
    category: failure.category,
    action,
    requestId: context.requestId,
    details,
  });
  throw failure.error;
};

const exactExpectedHostname = async (
  context: RequestContext,
  action: TurnstileAction,
): Promise<string> => {
  if (context.allowedOrigin === null) return fail(context, action, 'hostname-mismatch');
  try {
    return new URL(context.allowedOrigin).hostname;
  } catch {
    return fail(context, action, 'hostname-mismatch');
  }
};

const categoryForCodes = (result: SiteverifyResult): ServerDiagnosticCategory => {
  const codes = new Set(result['error-codes'] ?? []);
  if (codes.has('missing-input-secret')) return 'siteverify-missing-input-secret';
  if (codes.has('invalid-input-secret')) return 'siteverify-invalid-input-secret';
  if (codes.has('missing-input-response')) return 'siteverify-missing-input-response';
  if (codes.has('invalid-input-response')) return 'siteverify-invalid-input-response';
  if (codes.has('bad-request')) return 'siteverify-bad-request';
  if (codes.has('timeout-or-duplicate')) return 'siteverify-timeout-or-duplicate';
  if (codes.has('internal-error')) return 'siteverify-internal-error';
  return 'siteverify-unknown-error';
};

const safeFetchErrorName = (error: unknown): string => {
  if (!(error instanceof Error)) return 'unknown';
  return ['AbortError', 'Error', 'TimeoutError', 'TypeError'].includes(error.name)
    ? error.name
    : 'other';
};

const categoryForFetchError = (error: unknown): ServerDiagnosticCategory => {
  if (!(error instanceof Error)) return 'siteverify-network-error';
  const safeMessage = error.message.toLowerCase();
  if (
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    /\b(?:aborted|timeout|timed out)\b/u.test(safeMessage)
  ) {
    return 'siteverify-network-timeout';
  }
  if (/\bredirect/u.test(safeMessage)) return 'siteverify-network-redirect';
  if (
    /(?:cloudflare-owned|error 1024|host it cannot access|private network|public network)/u.test(
      safeMessage,
    )
  ) {
    return 'siteverify-network-policy';
  }
  if (
    /(?:different request|request context|global scope|disallowed operation)/u.test(safeMessage)
  ) {
    return 'siteverify-runtime-context-error';
  }
  if (error.name === 'TypeError') return 'siteverify-type-error';
  return 'siteverify-network-error';
};

const siteverifySchemaFailureDetails = (
  decoded: unknown,
  error: z.ZodError,
): Readonly<Record<string, string | boolean>> => {
  const object =
    typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : undefined;
  return {
    decodedType: object ? 'object' : Array.isArray(decoded) ? 'array' : typeof decoded,
    errorCodesType: Array.isArray(object?.['error-codes'])
      ? 'array'
      : typeof object?.['error-codes'],
    hasMessagesField: object ? Object.hasOwn(object, 'messages') : false,
    issueCodes: [...new Set(error.issues.map((issue) => issue.code))].sort().join(','),
  };
};

const parseSiteverify = async (
  context: RequestContext,
  action: TurnstileAction,
  response: Response,
): Promise<SiteverifyResult> => {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return fail(context, action, 'siteverify-invalid-body');
  }
  if (new TextEncoder().encode(text).byteLength > 16 * 1_024) {
    return fail(context, action, 'siteverify-invalid-body');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return fail(context, action, 'siteverify-invalid-body');
  }
  const parsed = siteverifySchema.safeParse(decoded);
  if (!parsed.success) {
    return fail(
      context,
      action,
      'siteverify-schema-error',
      siteverifySchemaFailureDetails(decoded, parsed.error),
    );
  }
  return parsed.data;
};

/**
 * Siteverify is authoritative and makes tokens single-use. Only an allowlisted
 * category is persisted; the token, secret, response body and visitor IP are
 * never logged or stored by Mirna.
 */
export const requireTurnstile = async (
  context: RequestContext,
  expectedAction: TurnstileAction,
  fetcher: Fetch = fetch,
): Promise<void> => {
  if (context.env.MIRNA_ENVIRONMENT !== 'staging') return;

  const token = context.request.headers.get(TURNSTILE_TOKEN_HEADER);
  if (!token) return fail(context, expectedAction, 'missing-token');
  if (token.length > 2_048) return fail(context, expectedAction, 'invalid-token-length');
  const secret = context.env.TURNSTILE_SECRET_KEY;
  if (!secret) return fail(context, expectedAction, 'missing-secret');

  const body = new URLSearchParams({
    secret,
    response: token,
    idempotency_key: context.requestId,
  });
  const remoteIp = context.request.headers.get('CF-Connecting-IP');
  if (remoteIp && remoteIp.length <= 64) body.set('remoteip', remoteIp);

  let response: Response;
  try {
    response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return fail(context, expectedAction, categoryForFetchError(error), {
      errorName: safeFetchErrorName(error),
    });
  }
  if (!response.ok) return fail(context, expectedAction, 'siteverify-http-error');
  const result = await parseSiteverify(context, expectedAction, response);
  if (!result.success) return fail(context, expectedAction, categoryForCodes(result));
  if (result.hostname !== (await exactExpectedHostname(context, expectedAction))) {
    return fail(context, expectedAction, 'hostname-mismatch');
  }
  if (result.action !== expectedAction) return fail(context, expectedAction, 'action-mismatch');

  await recordBetaDiagnostic(context, {
    eventType: 'turnstile_siteverify_result',
    severity: 'info',
    category: 'verified',
    action: expectedAction,
    requestId: context.requestId,
  });
};
