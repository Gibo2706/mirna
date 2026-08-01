import { z } from 'zod';
import type { AuthenticatedDevice } from './auth';
import { authenticateRequest } from './auth';
import type { RequestContext } from './context';
import { HttpError } from './errors';
import { jsonResponse } from './http';
import { domainHashBytes, toDatabaseBlob } from './server-crypto';
import { readCanonicalJson } from './validation';

const SUPPORT_HEADER = 'X-Mirna-Support-Id';
const SUPPORT_ID = /^MIRNA-(?:[0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/u;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const MAX_SUPPORT_EVENTS_PER_DAY = 200;
const MAX_VAULT_EVENTS_PER_DAY = 1_000;
const GLOBAL_EVENT_CAP = 50_000;

const clientEventSchema = z.strictObject({
  action: z.enum(['mirna_vault_create', 'mirna_pairing_create', 'mirna_recovery_init']).optional(),
  build: z.string().min(1).max(64).optional(),
  eventType: z.enum([
    'turnstile_script_loading',
    'turnstile_widget_ready',
    'turnstile_waiting',
    'turnstile_token_received',
    'turnstile_server_verifying',
    'turnstile_success',
    'turnstile_expired',
    'turnstile_rejected',
    'turnstile_network_error',
    'turnstile_configuration_error',
    'sync_request_error',
    'health_result',
  ]),
  occurredAt: z.string().datetime({ offset: true }),
  online: z.boolean().optional(),
  requestId: z.string().regex(REQUEST_ID).optional(),
  safeCode: z.string().regex(SAFE_CODE).optional(),
  verificationAttemptId: z.string().uuid().optional(),
  verificationReason: z
    .enum([
      'INVALID_INPUT_RESPONSE',
      'TIMEOUT_OR_DUPLICATE',
      'HOSTNAME_MISMATCH',
      'ACTION_MISMATCH',
      'SITEVERIFY_UNAVAILABLE',
      'CONFIGURATION_ERROR',
    ])
    .optional(),
  accountingCategory: z
    .enum([
      'SERVICE_QUOTA_EXHAUSTED',
      'VAULT_QUOTA_EXCEEDED',
      'SERVICE_MAINTENANCE',
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'USAGE_RESERVATION_UNDERESTIMATED',
      'USAGE_SETTLEMENT_FAILED',
      'D1_STORAGE_LIMIT_REACHED',
    ])
    .optional(),
  reservationPhase: z.enum(['request-reservation', 'route-reservation', 'settlement']).optional(),
  route: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,63}$/u)
    .optional(),
  businessCommitted: z.boolean().optional(),
  serviceFlagsChanged: z.boolean().optional(),
  workerBuild: z
    .string()
    .regex(/^(?:[0-9a-f]{7,64}|local|replace-at-deploy|unknown)$/u)
    .optional(),
  severity: z.enum(['info', 'error']),
});

type ClientEvent = z.output<typeof clientEventSchema>;

export type ServerDiagnosticCategory =
  | 'missing-token'
  | 'invalid-token-length'
  | 'missing-secret'
  | 'siteverify-http-error'
  | 'siteverify-invalid-body'
  | 'siteverify-schema-error'
  | 'siteverify-missing-input-secret'
  | 'siteverify-invalid-input-secret'
  | 'siteverify-missing-input-response'
  | 'siteverify-invalid-input-response'
  | 'siteverify-bad-request'
  | 'siteverify-timeout-or-duplicate'
  | 'siteverify-internal-error'
  | 'siteverify-unknown-error'
  | 'hostname-mismatch'
  | 'action-mismatch'
  | 'siteverify-network-timeout'
  | 'siteverify-network-policy'
  | 'siteverify-network-redirect'
  | 'siteverify-runtime-context-error'
  | 'siteverify-type-error'
  | 'siteverify-network-error'
  | 'siteverify-started'
  | 'verified';

interface DiagnosticInput {
  readonly eventType:
    'turnstile_client_phase' | 'turnstile_siteverify_result' | 'health_result' | 'request_error';
  readonly severity: 'info' | 'error';
  readonly category: string;
  readonly action?: string;
  readonly requestId?: string;
  readonly vaultId?: string;
  readonly deviceId?: string;
  readonly details?: Readonly<Record<string, string | boolean>>;
}

const safeBuild = (value: string): string =>
  /^(?:[0-9a-f]{7,64}|local|replace-at-deploy)$/u.test(value) ? value : 'unknown';

const hashReference = async (label: string, value: string): Promise<ArrayBuffer> =>
  toDatabaseBlob(
    await domainHashBytes(`MIRNA-BETA-DIAGNOSTICS-V1/${label}`, new TextEncoder().encode(value)),
  );

const utcDayStart = (now: number): number => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

const canonicalSafeDetails = (details: DiagnosticInput['details']): string => {
  const entries = Object.entries(details ?? {})
    .filter(
      ([key, value]) =>
        /^[a-z][a-zA-Z0-9]{0,31}$/u.test(key) &&
        (typeof value === 'boolean' || (typeof value === 'string' && value.length <= 128)),
    )
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(Object.fromEntries(entries));
};

/** Best-effort: diagnostic storage must never affect the sync response. */
export const recordBetaDiagnostic = async (
  context: RequestContext,
  input: DiagnosticInput,
): Promise<void> => {
  if (context.env.MIRNA_ENVIRONMENT !== 'staging') return;
  const supportId = context.request.headers.get(SUPPORT_HEADER);
  if (!supportId || !SUPPORT_ID.test(supportId)) return;
  const now = Date.now();
  const dayStart = utcDayStart(now);
  const supportRef = await hashReference('support', supportId);
  const vaultRef = input.vaultId ? await hashReference('vault', input.vaultId) : null;
  const deviceRef = input.deviceId ? await hashReference('device', input.deviceId) : null;
  const details = canonicalSafeDetails(input.details);
  if (new TextEncoder().encode(details).byteLength > 2_048) return;

  try {
    await context.env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO beta_diagnostic_events (
         event_id, created_at, expires_at, event_type, severity, support_ref,
         request_id, vault_ref, device_ref, technical_code, route_action,
         worker_build, safe_details_json
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
        WHERE (
            SELECT event_count FROM beta_diagnostic_totals WHERE singleton_id = 1
          ) < ?14
          AND (
            SELECT COUNT(*) FROM beta_diagnostic_events
             WHERE support_ref = ?6 AND created_at >= ?15
          ) < ?16
          AND (
            ?8 IS NULL OR (
              SELECT COUNT(*) FROM beta_diagnostic_events
               WHERE vault_ref = ?8 AND created_at >= ?15
            ) < ?17
          )`,
    )
      .bind(
        crypto.randomUUID(),
        now,
        now + RETENTION_MS,
        input.eventType,
        input.severity,
        supportRef,
        input.requestId && REQUEST_ID.test(input.requestId) ? input.requestId : context.requestId,
        vaultRef,
        deviceRef,
        input.category.slice(0, 64),
        input.action ?? null,
        safeBuild(context.env.MIRNA_BUILD_COMMIT),
        details,
        GLOBAL_EVENT_CAP,
        dayStart,
        MAX_SUPPORT_EVENTS_PER_DAY,
        MAX_VAULT_EVENTS_PER_DAY,
      )
      .run();
  } catch {
    // Privacy-safe beta telemetry is strictly non-authoritative.
  }
};

const isAnonymousClientEvent = (event: ClientEvent): boolean =>
  event.eventType.startsWith('turnstile_') || event.eventType === 'health_result';

const optionalAuthentication = async (
  context: RequestContext,
  event: ClientEvent,
): Promise<AuthenticatedDevice | undefined> => {
  if (isAnonymousClientEvent(event)) return undefined;
  if (!context.request.headers.has('Authorization')) {
    throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  }
  return authenticateRequest(context);
};

export const handleBetaDiagnosticEvent = async (context: RequestContext): Promise<Response> => {
  if (!['local', 'staging'].includes(context.env.MIRNA_ENVIRONMENT)) {
    throw new HttpError(404, 'ROUTE_NOT_FOUND', 'Route was not found.');
  }
  const supportId = context.request.headers.get(SUPPORT_HEADER);
  if (!supportId || !SUPPORT_ID.test(supportId)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'Support identifier is invalid.');
  }
  const event = await readCanonicalJson(context.request, clientEventSchema, 2_048);
  const authenticated = await optionalAuthentication(context, event);
  await recordBetaDiagnostic(context, {
    eventType:
      event.eventType === 'health_result'
        ? 'health_result'
        : event.eventType === 'sync_request_error'
          ? 'request_error'
          : 'turnstile_client_phase',
    severity: event.severity,
    category: event.eventType,
    action: event.action,
    requestId: event.requestId,
    vaultId: authenticated?.vaultId,
    deviceId: authenticated?.deviceId,
    details: {
      appBuild: event.build ?? 'unknown',
      online: event.online ?? false,
      safeCode: event.safeCode ?? 'NONE',
      verificationAttemptId: event.verificationAttemptId ?? 'NONE',
      verificationReason: event.verificationReason ?? 'NONE',
      ...(event.accountingCategory ? { accountingCategory: event.accountingCategory } : {}),
      ...(event.reservationPhase ? { reservationPhase: event.reservationPhase } : {}),
      ...(event.route ? { route: event.route } : {}),
      ...(event.businessCommitted !== undefined
        ? { businessCommitted: event.businessCommitted }
        : {}),
      ...(event.serviceFlagsChanged !== undefined
        ? { serviceFlagsChanged: event.serviceFlagsChanged }
        : {}),
      ...(event.workerBuild ? { clientWorkerBuild: event.workerBuild } : {}),
    },
  });
  return jsonResponse(
    { accepted: true, protocolVersion: 1 },
    { status: 202, requestId: context.requestId, allowedOrigin: context.allowedOrigin },
  );
};

export const diagnosticSupportHeader = SUPPORT_HEADER;
