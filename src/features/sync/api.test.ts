import { canonicalizeJson } from '@/domain/sync/canonical';
import {
  SYNC_CRYPTO_SUITE,
  SYNC_PROTOCOL_VERSION,
  SYNC_TRANSCRIPT_TYPES,
} from '@/domain/sync/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MirnaSyncApi, SyncApiError } from './api';
import type { SyncClientConfig } from './config';

const API_ORIGIN = 'https://mirna-sync-staging.example.workers.dev';
const APP_ORIGIN = 'https://mirna-staging.example';
const NOW = '2026-07-31T10:00:00.000Z';
const LATER = '2026-07-31T10:02:00.000Z';
const AUTHORIZATION_EXPIRY = '2026-08-30T10:00:00.000Z';
const opaqueId = (character: string): string => character.repeat(22);
const hash = (character: string): string => character.repeat(43);
const signature = (character: string): string => character.repeat(86);
const publicKey = (character: string): string => character.repeat(87);

const enabledConfig: SyncClientConfig = {
  enabled: true,
  apiOrigin: API_ORIGIN,
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
  buildCommit: 'abcdef1',
  services: { d1: 'ok', r2: 'ok' },
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Mirna sync API transport', () => {
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
});
