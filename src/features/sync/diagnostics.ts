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
  'health_result',
] as const;

export type BetaDiagnosticEventType = (typeof BETA_DIAGNOSTIC_EVENT_TYPES)[number];

export interface BetaDiagnosticEventInput {
  readonly eventType: BetaDiagnosticEventType;
  readonly severity?: 'info' | 'error';
  readonly action?: 'mirna_vault_create' | 'mirna_pairing_create' | 'mirna_recovery_init';
  readonly requestId?: string;
  readonly safeCode?: string;
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
  build: input.build?.slice(0, 64) ?? APPLICATION_VERSION,
  online: input.online ?? navigator.onLine,
});

const anonymousServerEvent = (eventType: BetaDiagnosticEventType): boolean =>
  eventType.startsWith('turnstile_') || eventType === 'health_result';

export class BetaDiagnosticsService {
  readonly #database: FinanceDatabase;
  readonly #apiOrigin: string;
  readonly #fetch: typeof fetch;
  #supportId?: Promise<string>;

  constructor(apiOrigin: string, options?: { database?: FinanceDatabase; fetch?: typeof fetch }) {
    this.#database = options?.database ?? db;
    this.#apiOrigin = apiOrigin;
    this.#fetch = options?.fetch ?? globalThis.fetch.bind(globalThis);
  }

  supportId(): Promise<string> {
    return (this.#supportId ??= this.#readOrCreateSupportId());
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
