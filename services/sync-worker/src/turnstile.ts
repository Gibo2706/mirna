import { z } from 'zod';
import type { RequestContext } from './context';
import { HttpError, type VerificationReason } from './errors';
import { recordBetaDiagnostic, type ServerDiagnosticCategory } from './diagnostics';

export const TURNSTILE_TOKEN_HEADER = 'X-Mirna-Turnstile-Token';
export const VERIFICATION_ATTEMPT_HEADER = 'X-Mirna-Verification-Attempt-Id';

export type TurnstileAction = 'mirna_vault_create' | 'mirna_pairing_create' | 'mirna_recovery_init';

const siteverifySchema = z.object({
  success: z.boolean(),
  challenge_ts: z.string().datetime({ offset: true }).optional(),
  hostname: z.string().min(1).max(253).optional(),
  'error-codes': z.array(z.string().min(1).max(64)).max(8).optional(),
  messages: z.array(z.string().max(256)).max(8).optional(),
  action: z.string().min(1).max(32).optional(),
  cdata: z.string().max(255).optional(),
  metadata: z
    .object({
      ephemeral_id: z.string().min(1).max(255).optional(),
    })
    .optional(),
});

type SiteverifyResult = z.output<typeof siteverifySchema>;
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const verificationError = (
  category: ServerDiagnosticCategory,
): {
  readonly error: HttpError;
  readonly category: ServerDiagnosticCategory;
  readonly reason: VerificationReason;
} => {
  switch (category) {
    case 'hostname-mismatch':
      return {
        category,
        reason: 'HOSTNAME_MISMATCH',
        error: new HttpError(
          503,
          'HUMAN_VERIFICATION_CONFIGURATION',
          'Human verification is not configured correctly.',
          'HOSTNAME_MISMATCH',
        ),
      };
    case 'action-mismatch':
      return {
        category,
        reason: 'ACTION_MISMATCH',
        error: new HttpError(
          503,
          'HUMAN_VERIFICATION_CONFIGURATION',
          'Human verification is not configured correctly.',
          'ACTION_MISMATCH',
        ),
      };
    case 'missing-secret':
    case 'siteverify-missing-input-secret':
    case 'siteverify-invalid-input-secret':
      return {
        category,
        reason: 'CONFIGURATION_ERROR',
        error: new HttpError(
          503,
          'HUMAN_VERIFICATION_CONFIGURATION',
          'Human verification is not configured correctly.',
          'CONFIGURATION_ERROR',
        ),
      };
    case 'siteverify-timeout-or-duplicate':
      return {
        category,
        reason: 'TIMEOUT_OR_DUPLICATE',
        error: new HttpError(
          403,
          'HUMAN_VERIFICATION_EXPIRED',
          'Human verification expired or was already used.',
          'TIMEOUT_OR_DUPLICATE',
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
        reason: 'SITEVERIFY_UNAVAILABLE',
        error: new HttpError(
          503,
          'HUMAN_VERIFICATION_UNAVAILABLE',
          'Human verification is temporarily unavailable.',
          'SITEVERIFY_UNAVAILABLE',
        ),
      };
    case 'siteverify-invalid-input-response':
    case 'siteverify-missing-input-response':
      return {
        category,
        reason: 'INVALID_INPUT_RESPONSE',
        error: new HttpError(
          403,
          'HUMAN_VERIFICATION_REJECTED',
          'Human verification was not accepted.',
          'INVALID_INPUT_RESPONSE',
        ),
      };
    default:
      return {
        category,
        reason: 'CONFIGURATION_ERROR',
        error: new HttpError(
          403,
          'HUMAN_VERIFICATION_REJECTED',
          'Human verification was not accepted.',
          'CONFIGURATION_ERROR',
        ),
      };
  }
};

const fail = async (
  context: RequestContext,
  action: TurnstileAction,
  category: ServerDiagnosticCategory,
  verificationAttemptId?: string,
  details?: Readonly<Record<string, string | boolean>>,
): Promise<never> => {
  const failure = verificationError(category);
  await recordBetaDiagnostic(context, {
    eventType: 'turnstile_siteverify_result',
    severity: 'error',
    category: failure.category,
    action,
    requestId: context.requestId,
    details: {
      ...(verificationAttemptId ? { verificationAttemptId } : {}),
      verificationReason: failure.reason,
      ...details,
    },
  });
  throw failure.error;
};

const exactExpectedHostname = async (
  context: RequestContext,
  action: TurnstileAction,
  verificationAttemptId?: string,
): Promise<string> => {
  if (context.allowedOrigin === null) {
    return fail(context, action, 'hostname-mismatch', verificationAttemptId);
  }
  try {
    return new URL(context.allowedOrigin).hostname;
  } catch {
    return fail(context, action, 'hostname-mismatch', verificationAttemptId);
  }
};

const challengeAgeBucket = (challengeTimestamp: string | undefined): string => {
  if (!challengeTimestamp) return 'missing';
  const timestamp = Date.parse(challengeTimestamp);
  if (!Number.isFinite(timestamp)) return 'invalid';
  const ageSeconds = (Date.now() - timestamp) / 1_000;
  if (ageSeconds < -5) return 'future';
  if (ageSeconds < 30) return 'under-30s';
  if (ageSeconds < 120) return '30-119s';
  if (ageSeconds <= 300) return '120-300s';
  return 'over-300s';
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
  verificationAttemptId: string,
  response: Response,
): Promise<SiteverifyResult> => {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return fail(context, action, 'siteverify-invalid-body', verificationAttemptId);
  }
  if (new TextEncoder().encode(text).byteLength > 16 * 1_024) {
    return fail(context, action, 'siteverify-invalid-body', verificationAttemptId);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return fail(context, action, 'siteverify-invalid-body', verificationAttemptId);
  }
  const parsed = siteverifySchema.safeParse(decoded);
  if (!parsed.success) {
    return fail(context, action, 'siteverify-schema-error', verificationAttemptId, {
      ...siteverifySchemaFailureDetails(decoded, parsed.error),
      siteverifyCallCount: '1',
    });
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
  const verificationAttemptId = context.request.headers.get(VERIFICATION_ATTEMPT_HEADER);
  if (!verificationAttemptId || !z.string().uuid().safeParse(verificationAttemptId).success) {
    return fail(context, expectedAction, 'siteverify-invalid-body');
  }
  const secret = context.env.TURNSTILE_SECRET_KEY;
  if (!secret) return fail(context, expectedAction, 'missing-secret', verificationAttemptId);

  const expectedHostname = await exactExpectedHostname(
    context,
    expectedAction,
    verificationAttemptId,
  );
  await recordBetaDiagnostic(context, {
    eventType: 'turnstile_siteverify_result',
    severity: 'info',
    category: 'siteverify-started',
    action: expectedAction,
    requestId: context.requestId,
    details: {
      verificationAttemptId,
      expectedHostname,
      expectedAction,
      siteverifyCallCount: '0',
    },
  });

  const body = new URLSearchParams({
    secret,
    response: token,
    idempotency_key: verificationAttemptId,
  });

  let response: Response;
  try {
    response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return fail(context, expectedAction, categoryForFetchError(error), verificationAttemptId, {
      errorName: safeFetchErrorName(error),
      expectedHostname,
      expectedAction,
      siteverifyCallCount: '1',
    });
  }
  if (!response.ok) {
    return fail(context, expectedAction, 'siteverify-http-error', verificationAttemptId, {
      expectedHostname,
      expectedAction,
      siteverifyCallCount: '1',
    });
  }
  const result = await parseSiteverify(context, expectedAction, verificationAttemptId, response);
  const resultDetails = {
    verificationAttemptId,
    siteverifySuccess: result.success,
    returnedHostname: result.hostname ?? 'missing',
    expectedHostname,
    returnedAction: result.action ?? 'missing',
    expectedAction,
    challengeAgeBucket: challengeAgeBucket(result.challenge_ts),
    siteverifyCallCount: '1',
  } as const;
  if (!result.success) {
    return fail(
      context,
      expectedAction,
      categoryForCodes(result),
      verificationAttemptId,
      resultDetails,
    );
  }
  if (result.hostname !== expectedHostname) {
    return fail(context, expectedAction, 'hostname-mismatch', verificationAttemptId, resultDetails);
  }
  if (result.action !== expectedAction) {
    return fail(context, expectedAction, 'action-mismatch', verificationAttemptId, resultDetails);
  }

  await recordBetaDiagnostic(context, {
    eventType: 'turnstile_siteverify_result',
    severity: 'info',
    category: 'verified',
    action: expectedAction,
    requestId: context.requestId,
    details: resultDetails,
  });
};
