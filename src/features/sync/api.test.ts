import { canonicalizeJson } from '@/domain/sync/canonical';
import {
  SYNC_CRYPTO_SUITE,
  SYNC_PROTOCOL_VERSION,
  SYNC_TRANSCRIPT_TYPES,
} from '@/domain/sync/constants';
import { generateDeviceKeyPairs } from '@/domain/sync/crypto';
import { bytesToBase64Url, utf8 } from '@/domain/sync/encoding';
import { createEncryptedSnapshot, type EncryptedSnapshotArtifactV1 } from '@/domain/sync/snapshot';
import { emptyFinanceData } from '@/tests/factories';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MirnaSyncApi, SyncApiError } from './api';
import type { SyncClientConfig } from './config';

const API_ORIGIN = 'https://mirna-sync-staging.example.workers.dev';
const APP_ORIGIN = 'https://mirna-staging.example';
const NOW = '2026-07-31T10:00:00.000Z';
const LATER = '2099-07-31T10:02:00.000Z';
const AUTHORIZATION_EXPIRY = '2099-08-30T10:00:00.000Z';
const opaqueId = (character: string): string => character.repeat(22);
const hash = (character: string): string => character.repeat(43);
const signature = (character: string): string => character.repeat(86);
const publicKey = (character: string): string => character.repeat(87);

const enabledConfig: SyncClientConfig = {
  enabled: true,
  apiOrigin: API_ORIGIN,
  turnstileSiteKey: '1x00000000000000000000AA',
  appEnvironment: 'local-beta',
  betaOnly: true,
};

const protocolResponse = (body: unknown, status = 200, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Mirna-Protocol-Version': String(SYNC_PROTOCOL_VERSION),
      ...Object.fromEntries(new Headers(headers)),
    },
  });

const healthBody = {
  protocolVersion: SYNC_PROTOCOL_VERSION,
  status: 'ok',
  environment: 'staging',
  buildCommit: 'abcdef1',
  writesEnabled: true,
  services: { d1: 'ok', r2: 'ok' },
  readiness: {
    storage: 'ok',
    accountingSchema: 'ok',
    accountingState: 'ok',
    routeBudgetConformance: 'ok',
    routeBudgetRegistryVersion: '2026-08-02.1',
    writes: 'enabled',
  },
} as const;

const authChallenge = {
  type: SYNC_TRANSCRIPT_TYPES.authChallenge,
  protocolVersion: SYNC_PROTOCOL_VERSION,
  suite: SYNC_CRYPTO_SUITE,
  vaultId: opaqueId('A'),
  deviceId: opaqueId('B'),
  challengeId: opaqueId('C'),
  challenge: hash('D'),
  issuedAt: NOW,
  expiresAt: LATER,
  audience: '/v1/auth/session',
  origin: APP_ORIGIN,
  method: 'POST',
} as const;

const initialManifest = {
  type: SYNC_TRANSCRIPT_TYPES.manifest,
  protocolVersion: SYNC_PROTOCOL_VERSION,
  suite: SYNC_CRYPTO_SUITE,
  vaultId: opaqueId('A'),
  manifestVersion: 1,
  keyEpoch: 1,
  devices: [
    {
      deviceId: opaqueId('B'),
      publicKeys: {
        signing: { format: 'raw-p256', value: publicKey('E') },
        agreement: { format: 'raw-p256', value: publicKey('F') },
      },
      authorizedAt: NOW,
      authorizationExpiresAt: AUTHORIZATION_EXPIRY,
    },
  ],
  revokedDevices: [],
  recoveryLookupId: opaqueId('G'),
  recoverySigningPublicKey: { format: 'raw-p256', value: publicKey('H') },
  previousManifestHash: null,
  transition: {
    transitionId: opaqueId('I'),
    kind: 'create',
    authorizationKind: 'device',
    authorizingDeviceId: opaqueId('B'),
    affectedDeviceId: opaqueId('B'),
    occurredAt: NOW,
  },
  signature: signature('J'),
} as const;

const createSnapshotArtifact = async (): Promise<EncryptedSnapshotArtifactV1> => {
  const keys = await generateDeviceKeyPairs();
  return createEncryptedSnapshot({
    data: emptyFinanceData(),
    vaultId: opaqueId('A'),
    revision: 1,
    baseRevision: 0,
    keyEpoch: 1,
    creatingDeviceId: opaqueId('B'),
    createdAt: NOW,
    parentManifestHash: hash('P'),
    previousSnapshotHash: null,
    causalFrontier: { serverCursor: 0, devices: [] },
    vaultMasterKey: new Uint8Array(32).fill(7),
    signingPrivateKey: keys.signing.privateKey,
    compression: 'none',
  });
};

const sessionResponse = () =>
  protocolResponse(
    {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      accessToken: hash('T'),
      expiresAt: LATER,
      authorizationExpiresAt: AUTHORIZATION_EXPIRY,
    },
    201,
  );

const establishSession = (api: MirnaSyncApi) =>
  api.createSession({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    challenge: authChallenge,
    signature: signature('K'),
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Mirna sync API transport', () => {
  it.each([
    [
      'SERVICE_QUOTA_EXHAUSTED',
      'Beta servis je dostigao postavljeno ograničenje korišćenja. Lokalne promene ostaju sačuvane.',
    ],
    [
      'VAULT_QUOTA_EXCEEDED',
      'Beta sinhronizacija za ovaj trezor je privremeno pauzirana. Promene ostaju sačuvane na ovom uređaju.',
    ],
    ['SERVICE_MAINTENANCE', 'Beta sinhronizacija je privremeno zaustavljena radi provere servisa.'],
    [
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Beta servis trenutno ne može pouzdano da izmeri potrošnju. Sinhronizacija je zaustavljena pre novih promena.',
    ],
    [
      'USAGE_RESERVATION_UNDERESTIMATED',
      'Beta servis je otkrio grešku u proceni potrošnje. Kopirajte Request ID i Support ID.',
    ],
    [
      'USAGE_SETTLEMENT_FAILED',
      'Beta servis nije uspeo da poravna izmerenu potrošnju. Kopirajte Request ID i Support ID.',
    ],
    [
      'D1_STORAGE_LIMIT_REACHED',
      'Beta baza je dostigla postavljeno ograničenje prostora. Lokalne promene ostaju sačuvane.',
    ],
  ])('maps %s to its dedicated safe Serbian message', (code, message) => {
    expect(new SyncApiError(code).message).toBe(message);
  });

  it('performs no fetch or persistent write while the feature is disabled', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const localWrite = vi.spyOn(Storage.prototype, 'setItem');
    const api = new MirnaSyncApi({ enabled: false, apiOrigin: null }, { fetch: fetchMock });

    await expect(api.requestAuthChallenge({} as never)).rejects.toMatchObject({
      code: 'SYNC_DISABLED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localWrite).not.toHaveBeenCalled();
  });

  it('sends the exact origin route, protocol headers and canonical request body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(protocolResponse(authChallenge, 201));
    const api = new MirnaSyncApi(enabledConfig, { fetch: fetchMock });
    const input = {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: authChallenge.vaultId,
      deviceId: authChallenge.deviceId,
      audience: authChallenge.audience,
      origin: APP_ORIGIN,
    } as const;

    await expect(api.requestAuthChallenge(input)).resolves.toEqual(authChallenge);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${API_ORIGIN}/v1/auth/challenge`);
    expect(init).toMatchObject({
      method: 'POST',
      body: canonicalizeJson(input),
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(headers.get('X-Mirna-Protocol-Version')).toBe('1');
    expect(headers.has('Origin')).toBe(false);
    expect(headers.has('Authorization')).toBe(false);
  });

  it('never replays a failed action-bound token and uses a fresh token and attempt ID', async () => {
    const input = {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      requestId: opaqueId('Q'),
      deviceId: opaqueId('R'),
      publicKeys: {
        signing: { format: 'raw-p256' as const, value: publicKey('S') },
        agreement: { format: 'raw-p256' as const, value: publicKey('T') },
      },
      pairingSalt: hash('U'),
      pairingClaimTokenHash: hash('V'),
      pollingTokenHash: hash('W'),
    } as const;
    const verificationAttemptId = '123e4567-e89b-42d3-a456-426614174000';
    const retryAttemptId = '123e4567-e89b-42d3-a456-426614174001';
    const turnstile = {
      token: vi
        .fn()
        .mockResolvedValueOnce({
          token: 'failed-single-use-token',
          verificationAttemptId,
        })
        .mockResolvedValueOnce({
          token: 'fresh-single-use-token',
          verificationAttemptId: retryAttemptId,
        }),
      markServerVerifying: vi.fn(),
      markServerResult: vi.fn(),
      dispose: vi.fn(),
    };
    const diagnostics = {
      supportId: vi.fn().mockResolvedValue('MIRNA-0123-4567-89AB-CDEF-GHJK-MNPQ-RS'),
      record: vi.fn().mockResolvedValue(undefined),
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        protocolResponse(
          {
            protocolVersion: SYNC_PROTOCOL_VERSION,
            requestId: input.requestId,
            expiresAt: LATER,
          },
          201,
        ),
      );
    const api = new MirnaSyncApi(enabledConfig, { fetch: fetchMock, turnstile, diagnostics });

    await expect(api.createPairing(input)).rejects.toMatchObject({ code: 'NETWORK_FAILURE' });
    await expect(api.createPairing(input)).resolves.toMatchObject({ requestId: input.requestId });
    expect(turnstile.token).toHaveBeenCalledTimes(2);
    expect(turnstile.token).toHaveBeenNthCalledWith(1, 'mirna_pairing_create');
    expect(turnstile.token).toHaveBeenNthCalledWith(2, 'mirna_pairing_create');
    expect(turnstile.markServerVerifying).toHaveBeenCalledTimes(2);
    expect(turnstile.markServerResult).toHaveBeenLastCalledWith();
    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const retryHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get('X-Mirna-Turnstile-Token')).toBe('failed-single-use-token');
    expect(firstHeaders.get('X-Mirna-Verification-Attempt-Id')).toBe(verificationAttemptId);
    expect(retryHeaders.get('X-Mirna-Turnstile-Token')).toBe('fresh-single-use-token');
    expect(retryHeaders.get('X-Mirna-Verification-Attempt-Id')).toBe(retryAttemptId);
    expect(retryHeaders.get('X-Mirna-Support-Id')).toBe('MIRNA-0123-4567-89AB-CDEF-GHJK-MNPQ-RS');
  });

  it('never blocks a sync request when the diagnostic Support ID is unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(protocolResponse(healthBody));
    const diagnostics = {
      supportId: vi.fn().mockRejectedValue(new Error('IndexedDB unavailable')),
      record: vi.fn().mockResolvedValue(undefined),
    };
    const api = new MirnaSyncApi(enabledConfig, { fetch: fetchMock, diagnostics });

    await expect(api.health()).resolves.toEqual(healthBody);
    expect(fetchMock).toHaveBeenCalledOnce();
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.has('X-Mirna-Support-Id')).toBe(false);
  });

  it('preserves only the allowlisted beta verification reason and Request ID', async () => {
    const requestId = '123e4567-e89b-42d3-a456-426614174000';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      protocolResponse(
        {
          protocolVersion: SYNC_PROTOCOL_VERSION,
          error: {
            code: 'HUMAN_VERIFICATION_REJECTED',
            message: 'Human verification was not accepted.',
            requestId,
            verificationReason: 'INVALID_INPUT_RESPONSE',
          },
        },
        403,
      ),
    );
    const api = new MirnaSyncApi(enabledConfig, { fetch: fetchMock });

    let caught: unknown;
    try {
      await api.health();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'HUMAN_VERIFICATION_REJECTED',
      requestId,
      verificationReason: 'INVALID_INPUT_RESPONSE',
    });
    expect(caught).toBeInstanceOf(SyncApiError);
    expect((caught as SyncApiError).message).toMatch(/Provera nije prihvaćena/u);
  });

  it('preserves a safe accounting reason and records diagnostics without delaying rejection', async () => {
    const requestId = '123e4567-e89b-42d3-a456-426614174000';
    const diagnostics = {
      supportId: vi.fn().mockResolvedValue('MIRNA-0123-4567-89AB-CDEF-GHJK-MNPQ-RS'),
      record: vi.fn().mockResolvedValue(undefined),
    };
    const api = new MirnaSyncApi(enabledConfig, {
      diagnostics,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        protocolResponse(
          {
            protocolVersion: SYNC_PROTOCOL_VERSION,
            error: {
              code: 'USAGE_ACCOUNTING_UNAVAILABLE',
              message: 'Accounting is unavailable.',
              requestId,
              accounting: {
                category: 'USAGE_ACCOUNTING_UNAVAILABLE',
                reason: 'USAGE_RESERVATION_UNDERESTIMATED',
                phase: 'route-reservation',
                route: 'vault-create',
                businessCommitted: false,
                serviceFlagsChanged: false,
                workerBuild: 'abcdef1',
              },
            },
          },
          503,
        ),
      ),
    });

    await expect(
      api.requestAuthChallenge({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        vaultId: authChallenge.vaultId,
        deviceId: authChallenge.deviceId,
        audience: authChallenge.audience,
        origin: APP_ORIGIN,
      }),
    ).rejects.toMatchObject({
      code: 'USAGE_ACCOUNTING_UNAVAILABLE',
      requestId,
      accounting: {
        reason: 'USAGE_RESERVATION_UNDERESTIMATED',
        phase: 'route-reservation',
        route: 'vault-create',
      },
    });
    await vi.waitFor(() =>
      expect(diagnostics.record).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId,
          accountingReason: 'USAGE_RESERVATION_UNDERESTIMATED',
        }),
      ),
    );
  });

  it('fails closed before fetch when a protected route has no Turnstile provider', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const api = new MirnaSyncApi(enabledConfig, { fetch: fetchMock });
    await expect(api.createPairing({} as never)).rejects.toMatchObject({
      code: 'TURNSTILE_REQUIRED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a session token only in memory and redacts it from URLs, bodies and errors', async () => {
    const accessToken = hash('T');
    const requestId = '8b0c8cfa-7a49-4a23-b25c-e8dfcb378098';
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        protocolResponse(
          {
            protocolVersion: SYNC_PROTOCOL_VERSION,
            accessToken,
            expiresAt: LATER,
            authorizationExpiresAt: AUTHORIZATION_EXPIRY,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(protocolResponse(initialManifest))
      .mockResolvedValueOnce(
        protocolResponse(
          {
            protocolVersion: SYNC_PROTOCOL_VERSION,
            error: {
              code: 'AUTHENTICATION_REQUIRED',
              message: `Server must not echo ${accessToken}`,
              requestId,
            },
          },
          401,
        ),
      );
    const persistentWrite = vi.spyOn(Storage.prototype, 'setItem');
    const api = new MirnaSyncApi(enabledConfig, { fetch: fetchMock });

    await expect(
      api.createSession({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        challenge: authChallenge,
        signature: signature('K'),
      }),
    ).resolves.toEqual({
      expiresAt: LATER,
      authorizationExpiresAt: AUTHORIZATION_EXPIRY,
    });
    expect(api.hasActiveSession).toBe(true);
    expect(persistentWrite).not.toHaveBeenCalled();

    await expect(api.getCurrentManifest()).resolves.toEqual(initialManifest);
    const authenticatedCalls = fetchMock.mock.calls.slice(1);
    for (const [url, init] of authenticatedCalls) {
      expect(url).toBeTypeOf('string');
      expect(url as string).not.toContain(accessToken);
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${accessToken}`);
    }

    let caught: unknown;
    try {
      await api.getCurrentManifest();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SyncApiError);
    expect(caught).toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
      status: 401,
      requestId,
    });
    expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(accessToken);
    expect(api.hasActiveSession).toBe(false);
  });

  it('keeps an access token only in memory and stops reusing it at its server expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(sessionResponse());
    const persistentWrite = vi.spyOn(Storage.prototype, 'setItem');
    const api = new MirnaSyncApi(enabledConfig, { fetch: fetchMock });

    await establishSession(api);
    expect(api.hasActiveSession).toBe(true);
    expect(persistentWrite).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(LATER));
    expect(api.hasActiveSession).toBe(false);
  });

  it.each([
    {
      name: 'malformed JSON',
      response: () =>
        new Response('{', {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Mirna-Protocol-Version': '1',
          },
        }),
      code: 'INVALID_RESPONSE',
    },
    {
      name: 'wrong content type',
      response: () =>
        new Response(JSON.stringify(healthBody), {
          status: 200,
          headers: {
            'Content-Type': 'text/plain',
            'X-Mirna-Protocol-Version': '1',
          },
        }),
      code: 'INVALID_RESPONSE_CONTENT_TYPE',
    },
    {
      name: 'oversized declared body',
      response: () =>
        protocolResponse(healthBody, 200, { 'Content-Length': String(256 * 1_024 + 1) }),
      code: 'RESPONSE_TOO_LARGE',
    },
    {
      name: 'incompatible protocol header',
      response: () => protocolResponse(healthBody, 200, { 'X-Mirna-Protocol-Version': '2' }),
      code: 'PROTOCOL_MISMATCH',
    },
  ])('rejects $name without exposing response details', async ({ response, code }) => {
    const api = new MirnaSyncApi(enabledConfig, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response()),
    });
    await expect(api.health()).rejects.toMatchObject({ code });
  });

  it('rejects a malformed structured error instead of trusting server text', async () => {
    const secret = hash('S');
    const api = new MirnaSyncApi(enabledConfig, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        protocolResponse(
          {
            protocolVersion: SYNC_PROTOCOL_VERSION,
            error: { code: secret, message: secret, requestId: secret },
          },
          400,
        ),
      ),
    });
    let caught: unknown;
    try {
      await api.health();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(secret);
  });

  it('honors a caller AbortSignal even when the injected fetch does not settle', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>(() => undefined));
    const api = new MirnaSyncApi(enabledConfig, { fetch: fetchMock });
    const controller = new AbortController();
    const request = api.health({ signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
  });

  it('aborts a request at the configured timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>(() => undefined));
    const api = new MirnaSyncApi(enabledConfig, {
      fetch: fetchMock,
      defaultTimeoutMs: 25,
    });
    const rejection = expect(api.health()).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it('uploads snapshot ciphertext as a bounded binary body with a canonical envelope header', async () => {
    const artifact = await createSnapshotArtifact();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        protocolResponse(
          {
            protocolVersion: 1,
            snapshotId: artifact.envelope.snapshotId,
            revision: 1,
            snapshotHash: hash('Q'),
            committed: true,
          },
          201,
        ),
      );
    const api = new MirnaSyncApi(enabledConfig, { fetch: fetchMock });
    await establishSession(api);

    await expect(api.uploadSnapshot(artifact, hash('I'))).resolves.toMatchObject({
      snapshotId: artifact.envelope.snapshotId,
      revision: 1,
    });
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe(`${API_ORIGIN}/v1/snapshots/${artifact.envelope.snapshotId}`);
    expect(init?.method).toBe('PUT');
    expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(artifact.ciphertext);
    const headers = new Headers(init?.headers);
    expect(headers.get('Content-Type')).toBe('application/octet-stream');
    expect(headers.get('Idempotency-Key')).toBe(hash('I'));
    expect(headers.get('X-Mirna-Snapshot-Envelope')).toBe(
      bytesToBase64Url(utf8(canonicalizeJson(artifact.envelope))),
    );
    expect(headers.get('Authorization')).toBe(`Bearer ${hash('T')}`);
  });

  it('downloads only a canonical, size-bounded binary snapshot response', async () => {
    const artifact = await createSnapshotArtifact();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        new Response(artifact.ciphertext.slice().buffer, {
          status: 200,
          headers: {
            'Content-Length': String(artifact.ciphertext.byteLength),
            'Content-Type': 'application/octet-stream',
            'X-Mirna-Protocol-Version': '1',
            'X-Mirna-Snapshot-Envelope': bytesToBase64Url(
              utf8(canonicalizeJson(artifact.envelope)),
            ),
          },
        }),
      );
    const api = new MirnaSyncApi(enabledConfig, { fetch: fetchMock });
    await establishSession(api);

    await expect(api.downloadCurrentSnapshot()).resolves.toEqual({
      envelope: artifact.envelope,
      ciphertext: artifact.ciphertext,
    });
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe(`${API_ORIGIN}/v1/snapshots/current`);
    expect(new Headers(init?.headers).get('Accept')).toBe('application/octet-stream');
    expect(init?.cache).toBe('no-store');
  });
});
