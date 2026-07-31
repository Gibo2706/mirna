import { canonicalizeJson } from '@/domain/sync/canonical';
import { SYNC_LIMITS, SYNC_PROTOCOL_VERSION } from '@/domain/sync/constants';
import { base64UrlToBytes, bytesToBase64Url, decodeUtf8, utf8 } from '@/domain/sync/encoding';
import {
  authChallengeRequestSchema,
  authChallengeSchema,
  authSessionRequestSchema,
  authSessionResponseSchema,
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
  vaultCreateRequestSchema,
  vaultCreateResponseSchema,
  vaultManifestSchema,
} from '@/domain/sync/schemas';
import {
  encryptedSnapshotEnvelopeSchema,
  type EncryptedSnapshotArtifactV1,
  type EncryptedSnapshotEnvelopeV1,
} from '@/domain/sync/snapshot';
import { z, type ZodType } from 'zod';
import { parseSyncApiOrigin, type SyncClientConfig } from './config';

const REQUEST_CONTENT_TYPE = 'application/json; charset=utf-8';
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_RESPONSE_LIMIT_BYTES = 256 * 1_024;
const RECOVERY_RESPONSE_LIMIT_BYTES = 2 * 1_024 * 1_024;
const ERROR_RESPONSE_LIMIT_BYTES = 32 * 1_024;
const ACCESS_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const SNAPSHOT_ENVELOPE_HEADER = 'X-Mirna-Snapshot-Envelope';

const publicErrorSchema = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  error: z.strictObject({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u),
    message: z.string().min(1).max(512),
    requestId: z.string().uuid(),
  }),
});

const healthResponseSchema = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  status: z.enum(['ok', 'degraded']),
  buildCommit: z.string().regex(/^(?:[0-9a-f]{7,64}|local|replace-at-deploy|unknown)$/u),
  services: z.strictObject({
    d1: z.enum(['ok', 'unavailable']),
    r2: z.enum(['ok', 'unavailable']),
  }),
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
  'DEVICE_LIMIT_REACHED',
  'INTERNAL_ERROR',
  'INVALID_JSON',
  'INVALID_PUBLIC_KEY',
  'INVALID_REQUEST',
  'MANIFEST_INVALID',
  'MANIFEST_STATE_CHANGED',
  'METHOD_NOT_ALLOWED',
  'NEW_RECOVERY_BINDING_INVALID',
  'NON_CANONICAL_REQUEST',
  'ORIGIN_MISMATCH',
  'ORIGIN_NOT_ALLOWED',
  'ORIGIN_REQUIRED',
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
]);

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  SYNC_DISABLED: 'Beta sinhronizacija nije uključena.',
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
  REMOTE_ERROR: 'Zahtev za sinhronizaciju nije uspeo.',
};

export class SyncApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly requestId: string | null = null,
  ) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.REMOTE_ERROR);
    this.name = 'SyncApiError';
  }
}

class MemoryAccessSession {
  #token: string | null = null;

  set(token: string): void {
    if (!ACCESS_TOKEN.test(token)) throw new SyncApiError('INVALID_RESPONSE');
    this.#token = token;
  }

  authorization(): string {
    if (this.#token === null) throw new SyncApiError('SESSION_REQUIRED');
    return `Bearer ${this.#token}`;
  }

  clear(): void {
    this.#token = null;
  }

  get active(): boolean {
    return this.#token !== null;
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

export interface SyncRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface SyncApiClientOptions {
  readonly fetch?: typeof fetch;
  readonly defaultTimeoutMs?: number;
}

interface RequestSpec<T> {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly path: string;
  readonly responseSchema: ZodType<T>;
  readonly expectedStatuses: readonly number[];
  readonly body?: BodyInit;
  readonly authenticated?: boolean;
  readonly responseLimitBytes?: number;
  readonly contentType?: string;
  readonly headers?: HeadersInit;
}

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
});

export class MirnaSyncApi {
  readonly #config: SyncClientConfig;
  readonly #fetch: typeof fetch;
  readonly #defaultTimeoutMs: number;
  readonly #session = new MemoryAccessSession();

  constructor(config: SyncClientConfig, options: SyncApiClientOptions = {}) {
    this.#config = config.enabled
      ? Object.freeze({ enabled: true, apiOrigin: parseSyncApiOrigin(config.apiOrigin) })
      : Object.freeze({ enabled: false, apiOrigin: null });
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#defaultTimeoutMs = parseTimeout(options.defaultTimeoutMs, DEFAULT_TIMEOUT_MS);
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
    return this.#post(
      SYNC_PHASE_ONE_ROUTES.createVault,
      vaultCreateRequestSchema,
      vaultCreateResponseSchema,
      input,
      [200, 201],
      false,
      options,
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
    this.#session.set(response.accessToken);
    return Object.freeze({
      expiresAt: response.expiresAt,
      authorizationExpiresAt: response.authorizationExpiresAt,
    });
  }

  async createPairing(
    input: z.input<typeof pairingCreateRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof pairingCreateResponseSchema>> {
    return this.#post(
      SYNC_PHASE_ONE_ROUTES.createPairing,
      pairingCreateRequestSchema,
      pairingCreateResponseSchema,
      input,
      [200, 201],
      false,
      options,
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

  async requestRecoveryChallenge(
    input: z.input<typeof recoveryChallengeRequestSchema>,
    options?: SyncRequestOptions,
  ): Promise<z.output<typeof recoveryChallengeSchema>> {
    return this.#post(
      SYNC_PHASE_ONE_ROUTES.recoveryChallenge,
      recoveryChallengeRequestSchema,
      recoveryChallengeSchema,
      input,
      [201],
      false,
      options,
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
    if (options?.signal?.aborted === true) throw new SyncApiError('REQUEST_ABORTED');

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

  async #request<T>(spec: RequestSpec<T>, options?: SyncRequestOptions): Promise<T> {
    this.#assertEnabled();
    if (!this.#config.enabled) throw new SyncApiError('SYNC_DISABLED');
    const timeoutMs = parseTimeout(options?.timeoutMs, this.#defaultTimeoutMs);
    if (options?.signal?.aborted === true) throw new SyncApiError('REQUEST_ABORTED');

    const headers = new Headers(spec.headers);
    headers.set('Accept', 'application/json');
    headers.set('X-Mirna-Protocol-Version', String(SYNC_PROTOCOL_VERSION));
    if (spec.body !== undefined) {
      headers.set('Content-Type', spec.contentType ?? REQUEST_CONTENT_TYPE);
    }
    if (spec.authenticated === true) {
      headers.set('Authorization', this.#session.authorization());
    }

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
      if (timedOut) throw new SyncApiError('REQUEST_TIMEOUT');
      if (controller.signal.aborted) throw new SyncApiError('REQUEST_ABORTED');
      if (error instanceof SyncApiError) {
        if (spec.authenticated === true && error.status === 401) this.#session.clear();
        throw error;
      }
      throw new SyncApiError('NETWORK_FAILURE');
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', abortFromCaller);
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
    throw new SyncApiError(safeCode, response.status, remote.error.requestId);
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
