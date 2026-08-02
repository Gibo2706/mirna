import { db, type FinanceDatabase } from '@/db/database';
import type { SyncBetaDiagnosticEventRecord } from '@/db/sync/diagnostic-records';
import { APPLICATION_VERSION } from '@/lib/version';
import { canonicalizeJson } from '@/domain/sync/canonical';

const SUPPORT_RECORD_ID = 'sync-beta-support' as const;
const SUPPORT_PREFIX = 'MIRNA';
const SUPPORT_BYTES = 16;
const MAX_LOCAL_EVENTS = 200;
const MAX_SERVER_EVENT_BYTES = 2_048;
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const VERIFICATION_ATTEMPT_ID = REQUEST_ID;
const VERIFICATION_REASONS = new Set([
  'INVALID_INPUT_RESPONSE',
  'TIMEOUT_OR_DUPLICATE',
  'HOSTNAME_MISMATCH',
  'ACTION_MISMATCH',
  'SITEVERIFY_UNAVAILABLE',
  'CONFIGURATION_ERROR',
]);
const ACCOUNTING_CATEGORIES = new Set([
  'SERVICE_QUOTA_EXHAUSTED',
  'VAULT_QUOTA_EXCEEDED',
  'SERVICE_MAINTENANCE',
  'USAGE_ACCOUNTING_UNAVAILABLE',
  'USAGE_RESERVATION_UNDERESTIMATED',
  'USAGE_SETTLEMENT_FAILED',
  'D1_STORAGE_LIMIT_REACHED',
]);
const ACCOUNTING_REASONS = new Set([
  'FLAGS_READ_FAILED',
  'RESOURCE_TOTALS_READ_FAILED',
  'ROLLING_TOTALS_REFRESH_FAILED',
  'DAILY_BUCKET_INITIALIZATION_FAILED',
  'GLOBAL_RESERVATION_INSERT_FAILED',
  'VAULT_RESERVATION_INSERT_FAILED',
  'RESERVATION_BATCH_FAILED',
  'RESERVATION_CONSTRAINT_FAILED',
  'RESERVATION_RESULT_EMPTY',
  'RESERVATION_METADATA_INVALID',
  'SCHEMA_NOT_READY',
  'REQUIRED_ACCOUNTING_ROW_MISSING',
  'ACCOUNTING_FAULT_ACTIVE',
  'SERVICE_FLAGS_DISABLED',
  'HARD_LIMIT_REACHED',
  'D1_STORAGE_LIMIT_REACHED',
  'USAGE_RESERVATION_UNDERESTIMATED',
  'USAGE_SETTLEMENT_FAILED',
]);
const RESERVATION_PHASES = new Set(['request-reservation', 'route-reservation', 'settlement']);

export const BETA_DIAGNOSTIC_EVENT_TYPES = [
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
  'budget_request_reservation_succeeded',
  'budget_route_reservation_succeeded',
  'vault_create_business_committed',
  'budget_settlement_succeeded',
  'sync_activation_succeeded',
  'health_result',
] as const;

export type BetaDiagnosticEventType = (typeof BETA_DIAGNOSTIC_EVENT_TYPES)[number];

export interface BetaDiagnosticEventInput {
  readonly eventType: BetaDiagnosticEventType;
  readonly severity?: 'info' | 'error';
  readonly action?: 'mirna_vault_create' | 'mirna_pairing_create' | 'mirna_recovery_init';
  readonly requestId?: string;
  readonly safeCode?: string;
  readonly verificationReason?: string;
  readonly verificationAttemptId?: string;
  readonly accountingCategory?: string;
  readonly accountingReason?: string;
  readonly reservationPhase?: string;
  readonly route?: string;
  readonly businessCommitted?: boolean;
  readonly serviceFlagsChanged?: boolean;
  readonly workerBuild?: string;
  readonly build?: string;
  readonly online?: boolean;
}

export interface BetaDiagnosticsSnapshot {
  readonly supportId: string;
  readonly events: readonly SyncBetaDiagnosticEventRecord[];
}

const encodeBase32 = (bytes: Uint8Array): string => {
  let accumulator = 0;
  let bits = 0;
  let encoded = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) encoded += BASE32[(accumulator << (5 - bits)) & 31];
  return encoded;
};

export const createSupportId = (): string => {
  const encoded = encodeBase32(crypto.getRandomValues(new Uint8Array(SUPPORT_BYTES)));
  return `${SUPPORT_PREFIX}-${encoded.match(/.{1,4}/gu)?.join('-') ?? encoded}`;
};

const boundedValue = (value: string | undefined, pattern: RegExp): string | undefined =>
  value !== undefined && pattern.test(value) ? value : undefined;

const safeEvent = (input: BetaDiagnosticEventInput): SyncBetaDiagnosticEventRecord => ({
  id: crypto.randomUUID(),
  createdAt: new Date().toISOString(),
  eventType: input.eventType,
  severity: input.severity ?? (input.eventType.endsWith('error') ? 'error' : 'info'),
  action: input.action,
  requestId: boundedValue(input.requestId, REQUEST_ID),
  safeCode: boundedValue(input.safeCode, SAFE_CODE),
  verificationReason:
    input.verificationReason && VERIFICATION_REASONS.has(input.verificationReason)
      ? input.verificationReason
      : undefined,
  verificationAttemptId: boundedValue(input.verificationAttemptId, VERIFICATION_ATTEMPT_ID),
  accountingCategory:
    input.accountingCategory && ACCOUNTING_CATEGORIES.has(input.accountingCategory)
      ? input.accountingCategory
      : undefined,
  accountingReason:
    input.accountingReason && ACCOUNTING_REASONS.has(input.accountingReason)
      ? input.accountingReason
      : undefined,
  reservationPhase:
    input.reservationPhase && RESERVATION_PHASES.has(input.reservationPhase)
      ? input.reservationPhase
      : undefined,
  route: boundedValue(input.route, /^[a-z][a-z0-9-]{0,63}$/u),
  businessCommitted: input.businessCommitted,
  serviceFlagsChanged: input.serviceFlagsChanged,
  workerBuild: input.workerBuild?.slice(0, 64),
  build: input.build?.slice(0, 64) ?? APPLICATION_VERSION,
  online: input.online ?? navigator.onLine,
});

const anonymousServerEvent = (eventType: BetaDiagnosticEventType): boolean =>
  eventType.startsWith('turnstile_') ||
  eventType === 'health_result' ||
  eventType.startsWith('budget_') ||
  eventType === 'vault_create_business_committed' ||
  eventType === 'sync_activation_succeeded';

export class BetaDiagnosticsService {
  readonly #database: FinanceDatabase;
  readonly #apiOrigin: string;
  readonly #fetch: typeof fetch;
  #supportId?: Promise<string>;
  readonly #listeners = new Set<() => void>();

  constructor(apiOrigin: string, options?: { database?: FinanceDatabase; fetch?: typeof fetch }) {
    this.#database = options?.database ?? db;
    this.#apiOrigin = apiOrigin;
    this.#fetch = options?.fetch ?? globalThis.fetch.bind(globalThis);
  }

  supportId(): Promise<string> {
    return (this.#supportId ??= this.#readOrCreateSupportId());
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async record(input: BetaDiagnosticEventInput): Promise<void> {
    const event = safeEvent(input);
    const supportId = await this.supportId();
    await this.#database.transaction('rw', this.#database.syncBetaDiagnosticEvents, async () => {
      await this.#database.syncBetaDiagnosticEvents.add(event);
      const overflow = (
        await this.#database.syncBetaDiagnosticEvents.orderBy('createdAt').primaryKeys()
      ).slice(0, -MAX_LOCAL_EVENTS);
      if (overflow.length > 0) await this.#database.syncBetaDiagnosticEvents.bulkDelete(overflow);
    });
    if (anonymousServerEvent(input.eventType)) {
      void this.#sendToWorker(supportId, event);
    }
    this.#notify();
  }

  async snapshot(): Promise<BetaDiagnosticsSnapshot> {
    return {
      supportId: await this.supportId(),
      events: await this.#database.syncBetaDiagnosticEvents
        .orderBy('createdAt')
        .reverse()
        .toArray(),
    };
  }

  async clear(): Promise<void> {
    await this.#database.syncBetaDiagnosticEvents.clear();
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  async #readOrCreateSupportId(): Promise<string> {
    const existing = await this.#database.syncBetaSupport.get(SUPPORT_RECORD_ID);
    if (existing) return existing.supportId;
    const supportId = createSupportId();
    try {
      await this.#database.syncBetaSupport.add({
        id: SUPPORT_RECORD_ID,
        supportId,
        createdAt: new Date().toISOString(),
      });
      return supportId;
    } catch {
      const concurrent = await this.#database.syncBetaSupport.get(SUPPORT_RECORD_ID);
      if (concurrent) return concurrent.supportId;
      throw new Error('Support ID nije moguće bezbedno sačuvati.');
    }
  }

  async #sendToWorker(supportId: string, event: SyncBetaDiagnosticEventRecord): Promise<void> {
    try {
      const payload: Record<string, string | boolean> = {
        eventType: event.eventType,
        severity: event.severity,
        occurredAt: event.createdAt,
      };
      if (event.action !== undefined) payload.action = event.action;
      if (event.requestId !== undefined) payload.requestId = event.requestId;
      if (event.safeCode !== undefined) payload.safeCode = event.safeCode;
      if (event.verificationReason !== undefined) {
        payload.verificationReason = event.verificationReason;
      }
      if (event.verificationAttemptId !== undefined) {
        payload.verificationAttemptId = event.verificationAttemptId;
      }
      if (event.accountingCategory !== undefined) {
        payload.accountingCategory = event.accountingCategory;
      }
      if (event.accountingReason !== undefined) payload.accountingReason = event.accountingReason;
      if (event.reservationPhase !== undefined) payload.reservationPhase = event.reservationPhase;
      if (event.route !== undefined) payload.route = event.route;
      if (event.businessCommitted !== undefined) {
        payload.businessCommitted = event.businessCommitted;
      }
      if (event.serviceFlagsChanged !== undefined) {
        payload.serviceFlagsChanged = event.serviceFlagsChanged;
      }
      if (event.workerBuild !== undefined) payload.workerBuild = event.workerBuild;
      if (event.build !== undefined) payload.build = event.build;
      if (event.online !== undefined) payload.online = event.online;
      const body = canonicalizeJson(payload);
      if (new TextEncoder().encode(body).byteLength > MAX_SERVER_EVENT_BYTES) return;
      await this.#fetch(`${this.#apiOrigin}/v1/diagnostics/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Mirna-Protocol-Version': '1',
          'X-Mirna-Support-Id': supportId,
        },
        body,
        cache: 'no-store',
        credentials: 'omit',
        mode: 'cors',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      // Local history remains authoritative when the diagnostic uplink is offline.
    }
  }
}
