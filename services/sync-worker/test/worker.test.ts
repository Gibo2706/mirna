import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const request = (path: string, init?: RequestInit): Request =>
  new Request(`https://sync.invalid${path}`, init);

describe('Worker HTTP foundation', () => {
  it('reports D1 and R2 reachability without exposing binding identifiers', async () => {
    const response = await SELF.fetch(request('/v1/health'));
    const body = await response.json<{
      status: string;
      protocolVersion: number;
      environment: string;
      writesEnabled: boolean;
      services: { d1: string; r2: string };
    }>();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 'ok',
      protocolVersion: 1,
      environment: 'local',
      buildCommit: 'local',
      writesEnabled: true,
      services: { d1: 'ok', r2: 'ok' },
    });
    expect(JSON.stringify(body)).not.toMatch(/database|bucket|account|LOCAL_MINIFLARE/u);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Mirna-Protocol-Version')).toBe('1');
    expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('allows only the exact configured CORS origin', async () => {
    const allowed = await SELF.fetch(
      request('/v1/health', { headers: { Origin: 'http://localhost:5173' } }),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');

    const rejected = await SELF.fetch(
      request('/v1/health', { headers: { Origin: 'https://attacker.invalid' } }),
    );
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(await rejected.json()).toMatchObject({
      error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed.' },
      protocolVersion: 1,
    });
  });

  it('answers strict preflight requests without reflecting arbitrary headers', async () => {
    const response = await SELF.fetch(
      request('/v1/health', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'X-Mirna-Protocol-Version',
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects unsupported methods, content types and routes with safe JSON', async () => {
    const wrongMethod = await SELF.fetch(
      request('/v1/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('Allow')).toBe('GET, OPTIONS');

    const wrongDeletionMethod = await SELF.fetch(
      request('/v1/vault', {
        headers: {
          Origin: 'http://localhost:5173',
          'X-Mirna-Protocol-Version': '1',
        },
      }),
    );
    expect(wrongDeletionMethod.status).toBe(405);
    expect(wrongDeletionMethod.headers.get('Allow')).toBe('DELETE, OPTIONS');

    const wrongContentType = await SELF.fetch(
      request('/v1/not-implemented', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Origin: 'http://localhost:5173',
          'X-Mirna-Protocol-Version': '1',
        },
        body: 'plaintext is not accepted',
      }),
    );
    expect(wrongContentType.status).toBe(415);
    expect(await wrongContentType.json()).toMatchObject({
      error: {
        code: 'UNSUPPORTED_CONTENT_TYPE',
        message: 'Content-Type must be application/json.',
      },
    });

    const unknownRoute = await SELF.fetch(
      request('/v1/not-implemented', {
        headers: {
          Origin: 'http://localhost:5173',
          'X-Mirna-Protocol-Version': '1',
        },
      }),
    );
    const unknownBody = await unknownRoute.text();
    expect(unknownRoute.status).toBe(404);
    expect(unknownBody).not.toMatch(/stack|Error:|services\/sync-worker/u);
  });

  it('rejects an explicitly incompatible protocol version', async () => {
    const response = await SELF.fetch(
      request('/v1/health', { headers: { 'X-Mirna-Protocol-Version': '2' } }),
    );

    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'PROTOCOL_UPGRADE_REQUIRED',
        message: 'Sync protocol version is not supported.',
      },
      protocolVersion: 1,
    });
  });
});
