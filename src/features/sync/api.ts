import { canonicalizeJson } from '@/domain/sync/canonical';
import { SYNC_LIMITS, SYNC_PROTOCOL_VERSION } from '@/domain/sync/constants';
import { base64UrlToBytes, bytesToBase64Url, decodeUtf8, utf8 } from '@/domain/sync/encoding';
import {
  deviceAcknowledgementRequestSchema,
  deviceAcknowledgementResponseSchema,
  operationChangesResponseSchema,
  operationEnvelopeSchema,
  operationUploadRequestSchema,
  operationUploadResponseSchema,
  type OperationChangesResponseV1,
  type OperationEnvelopeV1,
} from '@/domain/sync/operation';
import {
  authChallengeRequestSchema,
  authChallengeSchema,
  authSessionRequestSchema,
  authSessionResponseSchema,
  deviceKeyEnvelopeResponseSchema,
  deviceRenewRequestSchema,
  deviceRenewResponseSchema,
  manifestChangesResponseSchema,
  opaqueIdSchema,
  pairingApprovalSchema,
  pairingCandidateSchema,
  pairingCreateRequestSchema,
  pairingCreateResponseSchema,
  pairingFinalizeRequestSchema,
  pairingFinalizeResponseSchema,
  pairingInspectRequestSchema,
  pairingPollRequestSchema,
  pairingPollResponseSchema,
  recoveryBundleFetchRequestSchema,
  recoveryBundleFetchResponseSchema,
  recoveryChallengeRequestSchema,
  recoveryChallengeSchema,
  recoveryCompleteRequestSchema,
  recoveryCompleteResponseSchema,
  secureDeviceRevocationRequestSchema,
  secureDeviceRevocationResponseSchema,
  vaultCreateRequestSchema,
  vaultCreateResponseSchema,
  vaultDeletionRequestSchema,
  vaultDeletionResponseSchema,
  vaultManifestSchema,
} from '@/domain/sync/schemas';
import {
  encryptedSnapshotEnvelopeSchema,
  type EncryptedSnapshotArtifactV1,
  type EncryptedSnapshotEnvelopeV1,
} from '@/domain/sync/snapshot';
import { z, type ZodType } from 'zod';
import { parseSyncApiOrigin, type SyncClientConfig } from './config';
import type { TurnstileAction, TurnstileTokenProvider } from './turnstile-client';
import type { BetaDiagnosticEventInput } from './diagnostics';

const REQUEST_CONTENT_TYPE = 'application/json; charset=utf-8';
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_RESPONSE_LIMIT_BYTES = 256 * 1_024;
const RECOVERY_RESPONSE_LIMIT_BYTES = 2 * 1_024 * 1_024;
const OPERATION_RESPONSE_LIMIT_BYTES = 2 * 1_024 * 1_024;
const ERROR_RESPONSE_LIMIT_BYTES = 32 * 1_024;
const ACCESS_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const SUPPORT_ID = /^MIRNA-(?:[0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/u;
const SUPPORT_ID_WAIT_MS = 500;
const SNAPSHOT_ENVELOPE_HEADER = 'X-Mirna-Snapshot-Envelope';

const accountingReasonSchema = z.enum([
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

const accountingFailureSchema = z.strictObject({
  category: z.enum([
    'SERVICE_QUOTA_EXHAUSTED',
    'VAULT_QUOTA_EXCEEDED',
    'SERVICE_MAINTENANCE',
    'USAGE_ACCOUNTING_UNAVAILABLE',
    'USAGE_RESERVATION_UNDERESTIMATED',
    'USAGE_SETTLEMENT_FAILED',
    'D1_STORAGE_LIMIT_REACHED',
  ]),
  reason: accountingReasonSchema.optional(),
  phase: z.enum(['request-reservation', 'route-reservation', 'settlement']),
  route: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  businessCommitted: z.boolean(),
  serviceFlagsChanged: z.boolean(),
  workerBuild: z.string().regex(/^(?:[0-9a-f]{7,64}|local|replace-at-deploy|unknown)$/u),
  faultRole: z.enum(['origin', 'blocked', 'none']).optional(),
  originRequestId: z.string().uuid().optional(),
  originRoute: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,63}$/u)
    .optional(),
  lifecycleOperation: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,63}$/u)
    .optional(),
  businessWorkStarted: z.boolean().optional(),
});

export type AccountingFailure = z.output<typeof accountingFailureSchema>;

const publicErrorSchema = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  error: z.strictObject({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u),
    message: z.string().min(1).max(512),
    requestId: z.string().uuid(),
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
    accounting: accountingFailureSchema.optional(),
  }),
});

export type VerificationReason = NonNullable<
  z.output<typeof publicErrorSchema>['error']['verificationReason']
>;

const healthResponseSchema = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  status: z.enum(['ok', 'degraded']),
  environment: z.enum(['local', 'staging']),
  buildCommit: z.string().regex(/^(?:[0-9a-f]{7,64}|local|replace-at-deploy|unknown)$/u),
  writesEnabled: z.boolean(),
  services: z.strictObject({
    d1: z.enum(['ok', 'unavailable']),
    r2: z.enum(['ok', 'unavailable']),
  }),
  readiness: z
    .strictObject({
      storage: z.enum(['ok', 'error']),
      accountingSchema: z.enum(['ok', 'error']),
      accountingState: z.enum(['ok', 'fault']),
      writes: z.enum(['enabled', 'disabled']),
      routeBudgetConformance: z.enum(['ok', 'fault']),
      routeBudgetRegistryVersion: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[1-9][0-9]*$/u),
    })
    .optional(),
});

const pairingApprovedResponseSchema = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  status: z.literal('approved'),
  expiresAt: z.string().datetime(),
});

const pairingCancelledResponseSchema = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  status: z.literal('cancelled'),
  expiresAt: z.string().datetime(),
});

const snapshotCommitResponseSchema = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  snapshotId: opaqueIdSchema,
  revision: z.number().int().positive(),
  snapshotHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  committed: z.literal(true),
});

const REMOTE_ERROR_CODES = new Set([
  'AUTHENTICATION_REQUIRED',
  'AUTH_CHALLENGE_LIMIT',
  'AUTH_SESSION_LIMIT',
  'AUTHORIZATION_WINDOW_INVALID',
  'CHALLENGE_CONTEXT_MISMATCH',
  'CHALLENGE_INVALID',
  'CHALLENGE_REUSED',
  'DEVICE_AUTHORIZATION_REQUIRED',
  'DEVICE_KEY_ENVELOPE_NOT_FOUND',
  'DEVICE_KEY_ENVELOPE_SET_INVALID',
  'DEVICE_LIMIT_REACHED',
  'DEVICE_RENEWAL_CONTEXT_MISMATCH',
  'DELETION_CONTEXT_MISMATCH',
  'DELETION_IDEMPOTENCY_REUSED',
  'DELETION_JOB_NOT_FOUND',
  'DELETION_SIGNATURE_INVALID',
  'DELETION_STATE_CHANGED',
  'HUMAN_VERIFICATION_REQUIRED',
  'HUMAN_VERIFICATION_CONFIGURATION',
  'HUMAN_VERIFICATION_EXPIRED',
  'HUMAN_VERIFICATION_REJECTED',
  'HUMAN_VERIFICATION_UNAVAILABLE',
  'INTERNAL_ERROR',
  'INVALID_JSON',
  'INVALID_PUBLIC_KEY',
  'INVALID_REQUEST',
  'MANIFEST_INVALID',
  'MANIFEST_CURSOR_INVALID',
  'MANIFEST_STATE_CHANGED',
  'METHOD_NOT_ALLOWED',
  'NEW_RECOVERY_BINDING_INVALID',
  'NON_CANONICAL_REQUEST',
  'ORIGIN_MISMATCH',
  'ORIGIN_NOT_ALLOWED',
  'ORIGIN_REQUIRED',
  'OPERATION_CIPHERTEXT_INVALID',
  'OPERATION_CONTEXT_MISMATCH',
  'OPERATION_ID_REUSED',
  'OPERATION_KEY_EPOCH_CONFLICT',
  'OPERATION_SEQUENCE_CONFLICT',
  'OPERATION_SIGNATURE_INVALID',
  'OPERATION_STATE_CHANGED',
  'OPERATION_STATE_UNAVAILABLE',
  'PAIRING_ALREADY_FINALIZED',
  'PAIRING_CONTEXT_MISMATCH',
  'PAIRING_CREATE_CONFLICT',
  'PAIRING_DEVICE_MISSING',
  'PAIRING_FINALIZATION_CONFLICT',
  'PAIRING_FINALIZATION_MISMATCH',
  'PAIRING_FINALIZATION_SIGNATURE_INVALID',
  'PAIRING_ID_REUSED',
  'PAIRING_LIMIT_REACHED',
  'PAIRING_SIGNATURE_INVALID',
  'PAIRING_STATE_CHANGED',
  'PAIRING_TRANSCRIPT_MISMATCH',
  'PREFLIGHT_NOT_ALLOWED',
  'PROTOCOL_UPGRADE_REQUIRED',
  'RECOVERY_BINDING_INVALID',
  'RECOVERY_CHALLENGE_LIMIT',
  'RECOVERY_CHALLENGE_MISMATCH',
  'RECOVERY_DEVICE_MISMATCH',
  'RECOVERY_MANIFEST_CURSOR_INVALID',
  'RECOVERY_IDEMPOTENCY_REUSED',
  'RECOVERY_PROOF_INVALID',
  'RECOVERY_SIGNATURE_INVALID',
  'RECOVERY_STATE_CONFLICT',
  'RECOVERY_TRANSCRIPT_MISMATCH',
  'RATE_LIMITED',
  'RATE_LIMIT_UNAVAILABLE',
  'REQUEST_TOO_LARGE',
  'REQUEST_LENGTH_MISMATCH',
  'RESOURCE_NOT_FOUND',
  'ROUTE_NOT_FOUND',
  'SECURE_REVOCATION_CONTEXT_MISMATCH',
  'SECURE_REVOCATION_HASH_MISMATCH',
  'SECURE_REVOCATION_SIGNATURE_INVALID',
  'SECURE_REVOCATION_STATE_CHANGED',
  'SECURITY_TRANSITION_ID_REUSED',
  'SERVICE_BUDGET_EXHAUSTED',
  'SERVICE_QUOTA_EXHAUSTED',
  'SERVICE_MAINTENANCE',
  'USAGE_ACCOUNTING_UNAVAILABLE',
  'USAGE_RESERVATION_UNDERESTIMATED',
  'USAGE_SETTLEMENT_FAILED',
  'D1_STORAGE_LIMIT_REACHED',
  'SIGNATURE_INVALID',
  'STALE_JOB_RETRY_REQUIRED',
  'STORAGE_QUOTA_REACHED',
  'SNAPSHOT_BODY_REQUIRED',
  'SNAPSHOT_CIPHERTEXT_INVALID',
  'SNAPSHOT_COMMIT_UNAVAILABLE',
  'SNAPSHOT_ID_REUSED',
  'SNAPSHOT_LENGTH_MISMATCH',
  'SNAPSHOT_NOT_FOUND',
  'SNAPSHOT_REVISION_CONFLICT',
  'SNAPSHOT_SIGNATURE_INVALID',
  'SNAPSHOT_STATE_CHANGED',
  'SNAPSHOT_STATE_UNAVAILABLE',
  'SNAPSHOT_STORAGE_UNAVAILABLE',
  'SNAPSHOT_TOO_LARGE',
  'UNSUPPORTED_CONTENT_TYPE',
  'VAULT_ALREADY_EXISTS',
  'VAULT_CREATION_IDEMPOTENCY_REUSED',
  'VAULT_QUOTA_EXCEEDED',
  'ACK_CONTEXT_CONFLICT',
  'ACK_ROLLBACK_DETECTED',
]);

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  SYNC_DISABLED: 'Sinhronizacija nije uključena.',
  INVALID_CLIENT_REQUEST: 'Zahtev za sinhronizaciju nije ispravan.',
  SESSION_REQUIRED: 'Potrebna je nova potvrda uređaja.',
  REQUEST_ABORTED: 'Zahtev za sinhronizaciju je otkazan.',
  REQUEST_TIMEOUT: 'Zahtev za sinhronizaciju je istekao.',
  NETWORK_FAILURE: 'Servis za sinhronizaciju trenutno nije dostupan.',
  INVALID_RESPONSE: 'Servis je vratio neispravan odgovor.',
  INVALID_RESPONSE_CONTENT_TYPE: 'Servis je vratio nepodržan format odgovora.',
  RESPONSE_TOO_LARGE: 'Odgovor servisa je veći od dozvoljenog.',
  PROTOCOL_MISMATCH: 'Potrebna je novija verzija aplikacije.',
  PROTOCOL_UPGRADE_REQUIRED: 'Potrebna je novija verzija aplikacije.',
  DEVICE_AUTHORIZATION_REQUIRED:
    'Ovlašćenje ovog uređaja je isteklo ili je opozvano. Obnovite ga sa drugog aktivnog uređaja.',
  AUTHENTICATION_REQUIRED: 'Sync sesija je istekla. Uređaj će ponovo potvrditi svoj potpis.',
  HUMAN_VERIFICATION_REQUIRED: 'Potrebna je kratka provera pre nastavka.',
  HUMAN_VERIFICATION_CONFIGURATION:
    'Bezbednosna provera na serveru nije pravilno podešena. Kopirajte dijagnostiku za podršku.',
  HUMAN_VERIFICATION_EXPIRED: 'Bezbednosna provera je istekla ili je već iskorišćena.',
  HUMAN_VERIFICATION_REJECTED: 'Provera nije prihvaćena. Pripremite novu i pokušajte ponovo.',
  HUMAN_VERIFICATION_UNAVAILABLE:
    'Cloudflare bezbednosna provera trenutno nije dostupna. Pokušajte ponovo.',
  TURNSTILE_REQUIRED: 'Provera protiv zloupotrebe trenutno nije dostupna.',
  TURNSTILE_SCRIPT_BLOCKED:
    'Bezbednosna provera nije učitana. Proverite mrežu ili blokiranje sadržaja i pokušajte ponovo.',
  TURNSTILE_CONFIG:
    'Bezbednosna provera nije pravilno podešena. Kopirajte dijagnostiku za podršku.',
  TURNSTILE_EXPIRED: 'Bezbednosna provera je istekla. Pokušajte ponovo.',
  TURNSTILE_TIMEOUT: 'Bezbednosna provera je predugo čekala. Pokušajte ponovo.',
  TURNSTILE_REJECTED: 'Provera nije prihvaćena. Pokušajte ponovo ili kopirajte dijagnostiku.',
  SERVICE_BUDGET_EXHAUSTED:
    'Sinhronizacija je privremeno pauzirana zbog ograničenja servisa. Promene ostaju sačuvane na ovom uređaju.',
  SERVICE_QUOTA_EXHAUSTED:
    'Servis je dostigao postavljeno ograničenje korišćenja. Lokalne promene ostaju sačuvane.',
  SERVICE_MAINTENANCE: 'Sinhronizacija je privremeno zaustavljena radi provere servisa.',
  USAGE_ACCOUNTING_UNAVAILABLE:
    'Servis trenutno ne može pouzdano da izmeri potrošnju. Sinhronizacija je zaustavljena pre novih promena.',
  USAGE_RESERVATION_UNDERESTIMATED:
    'Servis je otkrio grešku u proceni potrošnje. Kopirajte Request ID i Support ID.',
  USAGE_SETTLEMENT_FAILED:
    'Servis nije uspeo da poravna izmerenu potrošnju. Kopirajte Request ID i Support ID.',
  D1_STORAGE_LIMIT_REACHED:
    'Cloud baza je dostigla postavljeno ograničenje prostora. Lokalne promene ostaju sačuvane.',
  VAULT_QUOTA_EXCEEDED:
    'Sinhronizacija za ovaj trezor je privremeno pauzirana. Promene ostaju sačuvane na ovom uređaju.',
  REMOTE_ERROR: 'Zahtev za sinhronizaciju nije uspeo.',
};

const VERIFICATION_REASON_MESSAGES: Readonly<Record<VerificationReason, string>> = {
  INVALID_INPUT_RESPONSE: 'Provera nije prihvaćena. Napravite novu proveru i pokušajte ponovo.',
  TIMEOUT_OR_DUPLICATE:
    'Provera je istekla ili je isti rezultat već iskorišćen. Potrebna je potpuno nova provera.',
  HOSTNAME_MISMATCH: 'Klijent i server nisu usklađeni. Kopirajte Request ID i Support ID.',
  ACTION_MISMATCH: 'Klijent i server nisu usklađeni. Kopirajte Request ID i Support ID.',
  SITEVERIFY_UNAVAILABLE:
    'Bezbednosna provera trenutno nije dostupna. Pokušajte ponovo kada veza proradi.',
  CONFIGURATION_ERROR:
    'Bezbednosna provera nije pravilno podešena. Kopirajte Request ID i Support ID.',
};

export class SyncApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly requestId: string | null = null,
    readonly verificationReason: VerificationReason | null = null,
    readonly accounting: AccountingFailure | null = null,
  ) {
    super(
      verificationReason
        ? VERIFICATION_REASON_MESSAGES[verificationReason]
        : (ERROR_MESSAGES[code] ?? ERROR_MESSAGES.REMOTE_ERROR),
    );
    this.name = 'SyncApiError';
  }
}

class MemoryAccessSession {
  #token: string | null = null;
  #expiresAt = 0;

  set(token: string, expiresAt: string): void {
    if (!ACCESS_TOKEN.test(token)) throw new SyncApiError('INVALID_RESPONSE');
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      throw new SyncApiError('INVALID_RESPONSE');
    }
    this.#token = token;
    this.#expiresAt = expiry;
  }

  authorization(): string {
    if (!this.active || this.#token === null) {
      this.clear();
      throw new SyncApiError('SESSION_REQUIRED');
    }
    return `Bearer ${this.#token}`;
  }

  clear(): void {
    this.#token = null;
    this.#expiresAt = 0;
  }

  get active(): boolean {
    return this.#token !== null && Date.now() < this.#expiresAt;
  }
}

class RequestWasAborted extends Error {}

const waitForAbortable = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw new RequestWasAborted();

  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new RequestWasAborted());
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
};

const parseDeclaredLength = (response: Response, limit: number): number | null => {
  const header = response.headers.get('Content-Length');
  if (header === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(header)) throw new SyncApiError('INVALID_RESPONSE');
  const length = Number(header);
  if (!Number.isSafeInteger(length)) throw new SyncApiError('INVALID_RESPONSE');
  if (length > limit) throw new SyncApiError('RESPONSE_TOO_LARGE');
  return length;
};

const readBoundedResponseText = async (
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<string> => {
  const bytes = await readBoundedResponseBytes(response, limit, signal);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SyncApiError('INVALID_RESPONSE');
  }
};

const readBoundedResponseBytes = async (
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> => {
  parseDeclaredLength(response, limit);
  if (response.body === null) throw new SyncApiError('INVALID_RESPONSE');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const part = await waitForAbortable(reader.read(), signal);
      if (part.done) break;
      received += part.value.byteLength;
      if (received > limit) {
        await reader.cancel();
        throw new SyncApiError('RESPONSE_TOO_LARGE');
      }
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(new ArrayBuffer(received));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SyncApiError('INVALID_RESPONSE');
  }
};

const parseSchema = <T>(schema: ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SyncApiError('INVALID_RESPONSE');
  return parsed.data;
};

const serializeRequest = (schema: ZodType, value: unknown): string => {
  try {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error('Invalid request.');
    return canonicalizeJson(parsed.data);
  } catch {
    throw new SyncApiError('INVALID_CLIENT_REQUEST');
  }
};

const exactOpaqueId = (value: string): string => {
  const result = opaqueIdSchema.safeParse(value);
  if (!result.success) throw new SyncApiError('INVALID_CLIENT_REQUEST');
  return result.data;
};

const responseLimitForStatus = (
  status: number,
  expectedStatuses: readonly number[],
  successLimit: number,
): number => (expectedStatuses.includes(status) ? successLimit : ERROR_RESPONSE_LIMIT_BYTES);

const parseTimeout = (value: number | undefined, fallback: number): number => {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    throw new SyncApiError('INVALID_CLIENT_REQUEST');
  }
  return timeout;
};

const signalIsAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

export interface SyncRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface SyncApiClientOptions {
  readonly fetch?: typeof fetch;
  readonly defaultTimeoutMs?: number;
  readonly turnstile?: TurnstileTokenProvider;
  readonly diagnostics?: {
    supportId(): Promise<string>;
    record(input: BetaDiagnosticEventInput): Promise<void>;
  };
}

interface RequestSpec<T> {
  readonly method: 'DELETE' | 'GET' | 'POST' | 'PUT';
  readonly path: string;
  readonly responseSchema: ZodType<T>;
  readonly expectedStatuses: readonly number[];
  readonly body?: BodyInit;
  readonly authenticated?: boolean;
  readonly responseLimitBytes?: number;
  readonly contentType?: string;
  readonly headers?: HeadersInit;
}

const boundedSupportId = async (
  diagnostics: SyncApiClientOptions['diagnostics'],
  signal?: AbortSignal,
): Promise<string | undefined> => {
  if (signalIsAborted(signal)) throw new SyncApiError('REQUEST_ABORTED');
  if (!diagnostics) return undefined;
  let timer: number | undefined;
  let abort: (() => void) | undefined;
  try {
    const supportId = await Promise.race([
      diagnostics.supportId(),
      new Promise<undefined>((resolve) => {
        timer = window.setTimeout(resolve, SUPPORT_ID_WAIT_MS);
      }),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new SyncApiError('REQUEST_ABORTED'));
        signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
    return supportId && SUPPORT_ID.test(supportId) ? supportId : undefined;
  } catch (error) {
    if (error instanceof SyncApiError && error.code === 'REQUEST_ABORTED') throw error;
    return undefined;
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
};

export type SyncSession = Readonly<{
  expiresAt: string;
  authorizationExpiresAt: string;
}>;

export interface DownloadedSnapshotV1 {
  readonly envelope: EncryptedSnapshotEnvelopeV1;
  readonly ciphertext: Uint8Array<ArrayBuffer>;
}

export const SYNC_PHASE_ONE_ROUTES = Object.freeze({
  health: '/v1/health',
  createVault: '/v1/vaults',
  authChallenge: '/v1/auth/challenge',
  authSession: '/v1/auth/session',
  createPairing: '/v1/pairings',
  currentManifest: '/v1/vault/manifest',
  recoveryChallenge: '/v1/recovery/challenge',
  recoveryBundle: '/v1/recovery/bundle',
  recoverySnapshot: '/v1/recovery/snapshot',
  currentSnapshot: '/v1/snapshots/current',
  operations: '/v1/operations',
  changes: '/v1/changes',
  acknowledgements: '/v1/acks',
  currentDeviceKeyEnvelope: '/v1/key-epochs/current',
  manifests: '/v1/manifests',
});

export class MirnaSyncApi {
  readonly #config: SyncClientConfig;
  readonly #fetch: typeof fetch;
  readonly #defaultTimeoutMs: number;
  readonly #session = new MemoryAccessSession();
  readonly #turnstile?: TurnstileTokenProvider;
  readonly #diagnostics?: SyncApiClientOptions['diagnostics'];

  constructor(config: SyncClientConfig, options: SyncApiClientOptions = {}) {
    this.#config = config.enabled
      ? Object.freeze({
          enabled: true,
          apiOrigin: parseSyncApiOrigin(config.apiOrigin),
          turnstileSiteKey: config.turnstileSiteKey,
          appEnvironment: config.appEnvironment,
          betaOnly: true,
        })
      : Object.freeze({ enabled: false, apiOrigin: null });
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#defaultTimeoutMs = parseTimeout(options.defaultTimeoutMs, DEFAULT_TIMEOUT_MS);
    this.#turnstile = options.turnstile;
    this.#diagnostics = options.diagnostics;
  }

  get hasActiveSession(): boolean {
    return this.#session.active;
  }

  clearSession(): void {
    this.#session.clear();
  }

  async health(options?: SyncRequestOptions): Promise<z.output<typeof healthResponseSchema>> {
    return this.#request(
      {
        method: 'GET',
        path: SYNC_PHASE_ONE_ROUTES.health,
        responseSchema: healthResponseSchema,
        expectedStatuses: [200, 503],
      },
      options,
    );
  }

  async createVault(
    input: z.input<typeof vaultCreateRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof vaultCreateResponseSchema>> {
    return this.#protectedPost(
      SYNC_PHASE_ONE_ROUTES.createVault,
      vaultCreateRequestSchema,
      vaultCreateResponseSchema,
      input,
      [200, 201],
      false,
      options,
      'mirna_vault_create',
      { 'Idempotency-Key': input.manifest.transition.transitionId },
    );
  }

  async requestAuthChallenge(
    input: z.input<typeof authChallengeRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof authChallengeSchema>> {
    return this.#post(
      SYNC_PHASE_ONE_ROUTES.authChallenge,
      authChallengeRequestSchema,
      authChallengeSchema,
      input,
      [201],
      false,
      options,
    );
  }

  async createSession(
    input: z.input<typeof authSessionRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<SyncSession> {
    const response = await this.#post(
      SYNC_PHASE_ONE_ROUTES.authSession,
      authSessionRequestSchema,
      authSessionResponseSchema,
      input,
      [201],
      false,
      options,
    );
    this.#session.set(response.accessToken, response.expiresAt);
    return Object.freeze({
      expiresAt: response.expiresAt,
      authorizationExpiresAt: response.authorizationExpiresAt,
    });
  }

  async createPairing(
    input: z.input<typeof pairingCreateRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof pairingCreateResponseSchema>> {
    return this.#protectedPost(
      SYNC_PHASE_ONE_ROUTES.createPairing,
      pairingCreateRequestSchema,
      pairingCreateResponseSchema,
      input,
      [200, 201],
      false,
      options,
      'mirna_pairing_create',
    );
  }

  async inspectPairing(
    pairingRequestId: string,
    input: z.input<typeof pairingInspectRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof pairingCandidateSchema>> {
    return this.#post(
      this.#pairingPath(pairingRequestId, 'inspect'),
      pairingInspectRequestSchema,
      pairingCandidateSchema,
      input,
      [200],
      false,
      options,
    );
  }

  async approvePairing(
    pairingRequestId: string,
    input: z.input<typeof pairingApprovalSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof pairingApprovedResponseSchema>> {
    return this.#post(
      this.#pairingPath(pairingRequestId, 'approve'),
      pairingApprovalSchema,
      pairingApprovedResponseSchema,
      input,
      [200],
      true,
      options,
    );
  }

  async pollPairing(
    pairingRequestId: string,
    input: z.input<typeof pairingPollRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof pairingPollResponseSchema>> {
    return this.#post(
      this.#pairingPath(pairingRequestId, 'poll'),
      pairingPollRequestSchema,
      pairingPollResponseSchema,
      input,
      [200],
      false,
      options,
    );
  }

  async cancelPairing(
    pairingRequestId: string,
    input: z.input<typeof pairingPollRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof pairingCancelledResponseSchema>> {
    return this.#post(
      this.#pairingPath(pairingRequestId, 'cancel'),
      pairingPollRequestSchema,
      pairingCancelledResponseSchema,
      input,
      [200],
      false,
      options,
    );
  }

  async finalizePairing(
    pairingRequestId: string,
    input: z.input<typeof pairingFinalizeRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof pairingFinalizeResponseSchema>> {
    return this.#post(
      this.#pairingPath(pairingRequestId, 'finalize'),
      pairingFinalizeRequestSchema,
      pairingFinalizeResponseSchema,
      input,
      [200, 201],
      false,
      options,
    );
  }

  async getCurrentManifest(
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof vaultManifestSchema>> {
    return this.#request(
      {
        method: 'GET',
        path: SYNC_PHASE_ONE_ROUTES.currentManifest,
        responseSchema: vaultManifestSchema,
        expectedStatuses: [200],
        authenticated: true,
      },
      options,
    );
  }

  async renewDevice(
    deviceId: string,
    input: z.input<typeof deviceRenewRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof deviceRenewResponseSchema>> {
    return this.#post(
      `/v1/devices/${exactOpaqueId(deviceId)}/renew`,
      deviceRenewRequestSchema,
      deviceRenewResponseSchema,
      input,
      [201],
      true,
      options,
    );
  }

  async secureRevokeDevice(
    deviceId: string,
    input: z.input<typeof secureDeviceRevocationRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof secureDeviceRevocationResponseSchema>> {
    return this.#post(
      `/v1/devices/${exactOpaqueId(deviceId)}/revoke`,
      secureDeviceRevocationRequestSchema,
      secureDeviceRevocationResponseSchema,
      input,
      [201],
      true,
      options,
    );
  }

  async getCurrentDeviceKeyEnvelope(
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof deviceKeyEnvelopeResponseSchema>> {
    return this.#request(
      {
        method: 'GET',
        path: SYNC_PHASE_ONE_ROUTES.currentDeviceKeyEnvelope,
        responseSchema: deviceKeyEnvelopeResponseSchema,
        expectedStatuses: [200],
        authenticated: true,
      },
      options,
    );
  }

  async getDeviceKeyEnvelope(
    keyEpoch: number,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof deviceKeyEnvelopeResponseSchema>> {
    if (!Number.isSafeInteger(keyEpoch) || keyEpoch < 2) {
      throw new SyncApiError('INVALID_CLIENT_REQUEST');
    }
    return this.#request(
      {
        method: 'GET',
        path: `/v1/key-epochs/${keyEpoch}`,
        responseSchema: deviceKeyEnvelopeResponseSchema,
        expectedStatuses: [200],
        authenticated: true,
      },
      options,
    );
  }

  async getManifestChanges(
    afterManifestVersion: number,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof manifestChangesResponseSchema>> {
    if (!Number.isSafeInteger(afterManifestVersion) || afterManifestVersion < 1) {
      throw new SyncApiError('INVALID_CLIENT_REQUEST');
    }
    return this.#request(
      {
        method: 'GET',
        path: `${SYNC_PHASE_ONE_ROUTES.manifests}?after=${afterManifestVersion}`,
        responseSchema: manifestChangesResponseSchema,
        expectedStatuses: [200],
        authenticated: true,
        responseLimitBytes: RECOVERY_RESPONSE_LIMIT_BYTES,
      },
      options,
    );
  }

  async deleteVault(
    input: z.input<typeof vaultDeletionRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof vaultDeletionResponseSchema>> {
    return this.#request(
      {
        method: 'DELETE',
        path: '/v1/vault',
        responseSchema: vaultDeletionResponseSchema,
        expectedStatuses: [200, 202],
        body: serializeRequest(vaultDeletionRequestSchema, input),
        authenticated: true,
      },
      options,
    );
  }

  async requestRecoveryChallenge(
    input: z.input<typeof recoveryChallengeRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof recoveryChallengeSchema>> {
    return this.#protectedPost(
      SYNC_PHASE_ONE_ROUTES.recoveryChallenge,
      recoveryChallengeRequestSchema,
      recoveryChallengeSchema,
      input,
      [201],
      false,
      options,
      'mirna_recovery_init',
    );
  }

  async fetchRecoveryBundle(
    input: z.input<typeof recoveryBundleFetchRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof recoveryBundleFetchResponseSchema>> {
    return this.#post(
      SYNC_PHASE_ONE_ROUTES.recoveryBundle,
      recoveryBundleFetchRequestSchema,
      recoveryBundleFetchResponseSchema,
      input,
      [200],
      false,
      options,
      RECOVERY_RESPONSE_LIMIT_BYTES,
    );
  }

  async completeRecovery(
    vaultId: string,
    input: z.input<typeof recoveryCompleteRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof recoveryCompleteResponseSchema>> {
    return this.#post(
      `/v1/vaults/${exactOpaqueId(vaultId)}/recover`,
      recoveryCompleteRequestSchema,
      recoveryCompleteResponseSchema,
      input,
      [200, 201],
      false,
      options,
    );
  }

  async uploadSnapshot(
    artifact: EncryptedSnapshotArtifactV1,
    idempotencyKey: string,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof snapshotCommitResponseSchema>> {
    const parsedEnvelope = encryptedSnapshotEnvelopeSchema.safeParse(artifact.envelope);
    if (
      !parsedEnvelope.success ||
      !ACCESS_TOKEN.test(idempotencyKey) ||
      artifact.ciphertext.byteLength !== parsedEnvelope.data.ciphertextLength
    ) {
      throw new SyncApiError('INVALID_CLIENT_REQUEST');
    }
    const body = new Uint8Array(new ArrayBuffer(artifact.ciphertext.byteLength));
    body.set(artifact.ciphertext);
    return this.#request(
      {
        method: 'PUT',
        path: `/v1/snapshots/${exactOpaqueId(parsedEnvelope.data.snapshotId)}`,
        responseSchema: snapshotCommitResponseSchema,
        expectedStatuses: [200, 201],
        body: body.buffer,
        authenticated: true,
        contentType: 'application/octet-stream',
        headers: {
          'Idempotency-Key': idempotencyKey,
          [SNAPSHOT_ENVELOPE_HEADER]: bytesToBase64Url(utf8(canonicalizeJson(parsedEnvelope.data))),
        },
      },
      options,
    );
  }

  async downloadCurrentSnapshot(options?: SyncRequestOptions): Promise<DownloadedSnapshotV1> {
    return this.#downloadSnapshot(
      {
        method: 'GET',
        path: SYNC_PHASE_ONE_ROUTES.currentSnapshot,
        authenticated: true,
      },
      options,
    );
  }

  async uploadOperation(
    envelope: OperationEnvelopeV1,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof operationUploadResponseSchema>> {
    return this.#post(
      SYNC_PHASE_ONE_ROUTES.operations,
      operationUploadRequestSchema,
      operationUploadResponseSchema,
      { protocolVersion: SYNC_PROTOCOL_VERSION, envelope: operationEnvelopeSchema.parse(envelope) },
      [200, 201],
      true,
      options,
    );
  }

  async getChanges(
    after: number,
    limit = SYNC_LIMITS.maxOperationsPerBatch,
    options?: SyncRequestOptions,
  ): Promise<OperationChangesResponseV1> {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > SYNC_LIMITS.maxOperationsPerBatch
    ) {
      throw new SyncApiError('INVALID_CLIENT_REQUEST');
    }
    return this.#request(
      {
        method: 'GET',
        path: `${SYNC_PHASE_ONE_ROUTES.changes}?after=${after}&limit=${limit}`,
        responseSchema: operationChangesResponseSchema,
        expectedStatuses: [200],
        authenticated: true,
        responseLimitBytes: OPERATION_RESPONSE_LIMIT_BYTES,
      },
      options,
    );
  }

  async acknowledgeChanges(
    input: z.input<typeof deviceAcknowledgementRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof deviceAcknowledgementResponseSchema>> {
    return this.#post(
      SYNC_PHASE_ONE_ROUTES.acknowledgements,
      deviceAcknowledgementRequestSchema,
      deviceAcknowledgementResponseSchema,
      input,
      [200],
      true,
      options,
    );
  }

  async fetchRecoverySnapshot(
    input: z.input<typeof recoveryBundleFetchRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<DownloadedSnapshotV1 | undefined> {
    try {
      return await this.#downloadSnapshot(
        {
          method: 'POST',
          path: SYNC_PHASE_ONE_ROUTES.recoverySnapshot,
          authenticated: false,
          body: serializeRequest(recoveryBundleFetchRequestSchema, input),
        },
        options,
      );
    } catch (error) {
      if (
        error instanceof SyncApiError &&
        error.status === 404 &&
        error.code === 'SNAPSHOT_NOT_FOUND'
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async #downloadSnapshot(
    spec: {
      readonly method: 'GET' | 'POST';
      readonly path: string;
      readonly authenticated: boolean;
      readonly body?: string;
    },
    options?: SyncRequestOptions,
  ): Promise<DownloadedSnapshotV1> {
    this.#assertEnabled();
    if (!this.#config.enabled) throw new SyncApiError('SYNC_DISABLED');
    const timeoutMs = parseTimeout(options?.timeoutMs, this.#defaultTimeoutMs);
    if (signalIsAborted(options?.signal)) throw new SyncApiError('REQUEST_ABORTED');

    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = (): void => controller.abort();
    options?.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const headers = new Headers({
        Accept: 'application/octet-stream',
        'X-Mirna-Protocol-Version': String(SYNC_PROTOCOL_VERSION),
      });
      if (spec.authenticated) headers.set('Authorization', this.#session.authorization());
      if (spec.body !== undefined) headers.set('Content-Type', REQUEST_CONTENT_TYPE);
      const response = await waitForAbortable(
        this.#fetch(`${this.#config.apiOrigin}${spec.path}`, {
          method: spec.method,
          headers,
          body: spec.body,
          cache: 'no-store',
          credentials: 'omit',
          mode: 'cors',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (response.status !== 200) {
        await this.#parseResponse(response, z.never(), [], 0, controller.signal);
        throw new SyncApiError('INVALID_RESPONSE', response.status);
      }
      if (response.headers.get('X-Mirna-Protocol-Version') !== String(SYNC_PROTOCOL_VERSION)) {
        throw new SyncApiError('PROTOCOL_MISMATCH', response.status);
      }
      if (response.headers.get('Content-Type') !== 'application/octet-stream') {
        throw new SyncApiError('INVALID_RESPONSE_CONTENT_TYPE', response.status);
      }
      const envelope = this.#parseSnapshotEnvelopeHeader(response);
      const ciphertext = await readBoundedResponseBytes(
        response,
        SYNC_LIMITS.maxSnapshotBytes,
        controller.signal,
      );
      if (ciphertext.byteLength !== envelope.ciphertextLength) {
        throw new SyncApiError('INVALID_RESPONSE');
      }
      return { envelope, ciphertext };
    } catch (error) {
      if (timedOut) throw new SyncApiError('REQUEST_TIMEOUT');
      if (controller.signal.aborted) throw new SyncApiError('REQUEST_ABORTED');
      if (error instanceof SyncApiError) {
        if (spec.authenticated && error.status === 401) this.#session.clear();
        throw error;
      }
      throw new SyncApiError('NETWORK_FAILURE');
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  #pairingPath(
    pairingRequestId: string,
    action: 'inspect' | 'approve' | 'poll' | 'cancel' | 'finalize',
  ): string {
    return `/v1/pairings/${exactOpaqueId(pairingRequestId)}/${action}`;
  }

  #post<RequestBody, ResponseBody>(
    path: string,
    requestSchema: ZodType<RequestBody>,
    responseSchema: ZodType<ResponseBody>,
    input: RequestBody,
    expectedStatuses: readonly number[],
    authenticated: boolean,
    options?: SyncRequestOptions,
    responseLimitBytes = DEFAULT_RESPONSE_LIMIT_BYTES,
  ): Promise<ResponseBody> {
    this.#assertEnabled();
    const body = serializeRequest(requestSchema, input);
    return this.#request(
      {
        method: 'POST',
        path,
        responseSchema,
        expectedStatuses,
        body,
        authenticated,
        responseLimitBytes,
      },
      options,
    );
  }

  async #protectedPost<RequestBody, ResponseBody>(
    path: string,
    requestSchema: ZodType<RequestBody>,
    responseSchema: ZodType<ResponseBody>,
    input: RequestBody,
    expectedStatuses: readonly number[],
    authenticated: boolean,
    options: SyncRequestOptions | undefined,
    action: TurnstileAction,
    additionalHeaders?: HeadersInit,
  ): Promise<ResponseBody> {
    this.#assertEnabled();
    if (!this.#turnstile) throw new SyncApiError('TURNSTILE_REQUIRED');
    const verification = await this.#turnstile.token(action);
    if (!verification.token || verification.token.length > 2_048) {
      throw new SyncApiError('TURNSTILE_REQUIRED');
    }
    this.#turnstile.markServerVerifying?.();
    try {
      const protectedHeaders = new Headers(additionalHeaders);
      protectedHeaders.set('X-Mirna-Turnstile-Token', verification.token);
      protectedHeaders.set('X-Mirna-Verification-Attempt-Id', verification.verificationAttemptId);
      const result = await this.#request(
        {
          method: 'POST',
          path,
          responseSchema,
          expectedStatuses,
          body: serializeRequest(requestSchema, input),
          authenticated,
          headers: protectedHeaders,
        },
        options,
      );
      this.#turnstile.markServerResult?.();
      return result;
    } catch (error) {
      this.#turnstile.markServerResult?.(error);
      throw error;
    }
  }

  async #request<T>(spec: RequestSpec<T>, options?: SyncRequestOptions): Promise<T> {
    this.#assertEnabled();
    if (!this.#config.enabled) throw new SyncApiError('SYNC_DISABLED');
    const timeoutMs = parseTimeout(options?.timeoutMs, this.#defaultTimeoutMs);
    if (signalIsAborted(options?.signal)) throw new SyncApiError('REQUEST_ABORTED');

    const headers = new Headers(spec.headers);
    headers.set('Accept', 'application/json');
    headers.set('X-Mirna-Protocol-Version', String(SYNC_PROTOCOL_VERSION));
    if (spec.body !== undefined) {
      headers.set('Content-Type', spec.contentType ?? REQUEST_CONTENT_TYPE);
    }
    if (spec.authenticated === true) {
      headers.set('Authorization', this.#session.authorization());
    }
    const supportId = await boundedSupportId(this.#diagnostics, options?.signal);
    if (options?.signal?.aborted === true) throw new SyncApiError('REQUEST_ABORTED');
    if (supportId) headers.set('X-Mirna-Support-Id', supportId);

    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = (): void => controller.abort();
    options?.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await waitForAbortable(
        this.#fetch(`${this.#config.apiOrigin}${spec.path}`, {
          method: spec.method,
          headers,
          body: spec.body,
          cache: 'no-store',
          credentials: 'omit',
          mode: 'cors',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        }),
        controller.signal,
      );
      return await this.#parseResponse(
        response,
        spec.responseSchema,
        spec.expectedStatuses,
        spec.responseLimitBytes ?? DEFAULT_RESPONSE_LIMIT_BYTES,
        controller.signal,
      );
    } catch (error) {
      if (timedOut) {
        const timeoutError = new SyncApiError('REQUEST_TIMEOUT');
        void this.#recordRequestError(timeoutError);
        throw timeoutError;
      }
      if (controller.signal.aborted) {
        const abortedError = new SyncApiError('REQUEST_ABORTED');
        void this.#recordRequestError(abortedError);
        throw abortedError;
      }
      if (error instanceof SyncApiError) {
        if (spec.authenticated === true && error.status === 401) this.#session.clear();
        void this.#recordRequestError(error);
        throw error;
      }
      const networkError = new SyncApiError('NETWORK_FAILURE');
      void this.#recordRequestError(networkError);
      throw networkError;
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  async #recordRequestError(error: SyncApiError): Promise<void> {
    try {
      await this.#diagnostics?.record({
        eventType: 'sync_request_error',
        severity: 'error',
        requestId: error.requestId ?? undefined,
        safeCode: error.code,
        verificationReason: error.verificationReason ?? undefined,
        accountingCategory: error.accounting?.category,
        accountingReason: error.accounting?.reason,
        reservationPhase: error.accounting?.phase,
        route: error.accounting?.route,
        businessCommitted: error.accounting?.businessCommitted,
        serviceFlagsChanged: error.accounting?.serviceFlagsChanged,
        workerBuild: error.accounting?.workerBuild,
        faultRole: error.accounting?.faultRole,
        originRequestId: error.accounting?.originRequestId,
        originRoute: error.accounting?.originRoute,
        lifecycleOperation: error.accounting?.lifecycleOperation,
        businessWorkStarted: error.accounting?.businessWorkStarted,
        online: navigator.onLine,
      });
    } catch {
      // Diagnostics must never change the outcome of a sync request.
    }
  }

  async #parseResponse<T>(
    response: Response,
    responseSchema: ZodType<T>,
    expectedStatuses: readonly number[],
    successLimit: number,
    signal: AbortSignal,
  ): Promise<T> {
    if (response.headers.get('X-Mirna-Protocol-Version') !== String(SYNC_PROTOCOL_VERSION)) {
      throw new SyncApiError('PROTOCOL_MISMATCH', response.status);
    }
    const contentType = response.headers.get('Content-Type');
    if (contentType === null || !JSON_CONTENT_TYPE.test(contentType)) {
      throw new SyncApiError('INVALID_RESPONSE_CONTENT_TYPE', response.status);
    }
    const text = await readBoundedResponseText(
      response,
      responseLimitForStatus(response.status, expectedStatuses, successLimit),
      signal,
    );
    const decoded = parseJson(text);
    if (expectedStatuses.includes(response.status)) {
      return parseSchema(responseSchema, decoded);
    }
    if (response.status < 400 || response.status > 599) {
      throw new SyncApiError('INVALID_RESPONSE', response.status);
    }
    const remote = parseSchema(publicErrorSchema, decoded);
    const safeCode = REMOTE_ERROR_CODES.has(remote.error.code) ? remote.error.code : 'REMOTE_ERROR';
    throw new SyncApiError(
      safeCode,
      response.status,
      remote.error.requestId,
      remote.error.verificationReason ?? null,
      remote.error.accounting ?? null,
    );
  }

  #parseSnapshotEnvelopeHeader(response: Response): EncryptedSnapshotEnvelopeV1 {
    const encoded = response.headers.get(SNAPSHOT_ENVELOPE_HEADER);
    if (!encoded || encoded.length > 24_000) throw new SyncApiError('INVALID_RESPONSE');
    try {
      const decoded = base64UrlToBytes(encoded);
      const copy = new Uint8Array(new ArrayBuffer(decoded.byteLength));
      copy.set(decoded);
      const canonicalEnvelope = decodeUtf8(copy);
      const envelope = encryptedSnapshotEnvelopeSchema.parse(
        JSON.parse(canonicalEnvelope) as unknown,
      );
      if (canonicalizeJson(envelope) !== canonicalEnvelope) {
        throw new Error('Snapshot envelope is not canonical.');
      }
      return envelope;
    } catch {
      throw new SyncApiError('INVALID_RESPONSE');
    }
  }

  #assertEnabled(): void {
    if (!this.#config.enabled) throw new SyncApiError('SYNC_DISABLED');
  }
}
