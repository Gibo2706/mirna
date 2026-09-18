import { describe, expect, it, vi } from 'vitest';
import { verifyStagingSnapshot } from './sync-staging-contract.mjs';
import {
  fetchWorkerHealthSnapshot,
  verifyProductionCors,
  waitForExpectedWorkerBuild,
} from './sync-staging-verify-lib.mjs';

const expectedBuild = '80d664a038088e3f48182ca2a5fee559b3dadd16';
const oldBuild = '7095f4dd289a9faaafa642329372877034bf5e48';
const health = (buildCommit = expectedBuild) => ({
  status: 'ok',
  environment: 'staging',
  protocolVersion: 1,
  buildCommit,
  services: { d1: 'ok', r2: 'ok' },
  readiness: { accountingState: 'ok', routeBudgetConformance: 'ok' },
});
const healthResult = (buildCommit) => ({
  kind: 'health',
  health: health(buildCommit),
  healthHttpStatus: 200,
});
const virtualTime = () => {
  let current = 0;
  return {
    now: () => current,
    sleep: vi.fn((milliseconds) => {
      current += milliseconds;
      return Promise.resolve();
    }),
  };
};

describe('Worker deployment convergence', () => {
  it('returns immediately when the first health response has the expected SHA', async () => {
    const readHealth = vi.fn(() => Promise.resolve(healthResult(expectedBuild)));

    const result = await waitForExpectedWorkerBuild({ expectedBuild, readHealth });

    expect(result.attempts).toBe(1);
    expect(readHealth).toHaveBeenCalledOnce();
  });

  it('retries old builds and succeeds when the expected SHA converges', async () => {
    const clock = virtualTime();
    const readHealth = vi
      .fn()
      .mockResolvedValueOnce(healthResult(oldBuild))
      .mockResolvedValueOnce(healthResult(oldBuild))
      .mockResolvedValueOnce(healthResult(expectedBuild));

    const result = await waitForExpectedWorkerBuild({
      expectedBuild,
      readHealth,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result).toMatchObject({ attempts: 3, elapsedMs: 20_000 });
    expect(clock.sleep).toHaveBeenCalledTimes(2);
  });

  it('fails boundedly with expected and last received SHA when the old build persists', async () => {
    const clock = virtualTime();

    await expect(
      waitForExpectedWorkerBuild({
        expectedBuild,
        readHealth: () => Promise.resolve(healthResult(oldBuild)),
        timeoutMs: 4_000,
        intervalMs: 2_000,
        sleep: clock.sleep,
        now: clock.now,
      }),
    ).rejects.toThrow(
      new RegExp(`Expected: ${expectedBuild}\\nLast received: ${oldBuild}\\nAttempts: 3`, 'u'),
    );
  });

  it('rejects an invalid health payload immediately without retrying', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('{"status":"ok"}')));

    await expect(
      waitForExpectedWorkerBuild({
        expectedBuild,
        readHealth: () =>
          fetchWorkerHealthSnapshot({ fetchImpl, workerUrl: 'https://worker.example/health' }),
      }),
    ).rejects.toThrow(/payload, environment ili protokol/u);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('bounds persistent network failures instead of retrying forever', async () => {
    const clock = virtualTime();
    const readHealth = vi.fn(() =>
      Promise.resolve({ kind: 'retryable', reason: 'network failure' }),
    );

    await expect(
      waitForExpectedWorkerBuild({
        expectedBuild,
        readHealth,
        timeoutMs: 4_000,
        intervalMs: 2_000,
        sleep: clock.sleep,
        now: clock.now,
      }),
    ).rejects.toThrow(/Attempts: 3[\s\S]*network failure/u);
    expect(readHealth).toHaveBeenCalledTimes(3);
  });

  it('retries a temporary 5xx response without a health payload', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"deploying"}', { status: 503 }))
      .mockResolvedValueOnce(Response.json(health(expectedBuild)));
    const clock = virtualTime();

    const result = await waitForExpectedWorkerBuild({
      expectedBuild,
      readHealth: () =>
        fetchWorkerHealthSnapshot({ fetchImpl, workerUrl: 'https://worker.example/health' }),
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.attempts).toBe(2);
  });
});

const workerUrl = 'https://worker.example/v1/health';
const productionOrigin = 'https://mirna-finansije.vercel.app';
const corsHeaders = {
  'Access-Control-Allow-Origin': productionOrigin,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'X-Mirna-Protocol-Version, X-Mirna-Support-Id',
};
const response = (status = 200, headers = corsHeaders, build = expectedBuild) =>
  Response.json(
    { ...health(build), status: status === 503 ? 'degraded' : 'ok' },
    { status, headers },
  );
const preflight = (status = 204, headers = corsHeaders) => new Response(null, { status, headers });
const converge = (fetchImpl, clock = virtualTime()) =>
  waitForExpectedWorkerBuild({
    expectedBuild,
    readHealth: () =>
      fetchWorkerHealthSnapshot({ fetchImpl, workerUrl, productionOrigin, now: clock.now }),
    sleep: clock.sleep,
    now: clock.now,
  });
const checkCors = async (fetchImpl, clock = virtualTime()) => {
  const healthSnapshot = await converge(fetchImpl, clock);
  const result = await verifyProductionCors({
    fetchImpl,
    workerUrl,
    productionOrigin,
    healthSnapshot,
    sleep: clock.sleep,
    now: clock.now,
  });
  return { result, healthSnapshot };
};

describe('production CORS verification', () => {
  it('passes exact GET origin and strict preflight without an extra GET', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(preflight());
    await checkCors(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].headers.Origin).toBe(productionOrigin);
    expect(fetchImpl.mock.calls[1][1].method).toBe('OPTIONS');
  });

  it.each(['https://wrong.example', '*', ''])('rejects GET origin %s precisely', async (origin) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, { 'Access-Control-Allow-Origin': origin }));
    await expect(checkCors(fetchImpl)).rejects.toThrow(
      /CORS_ORIGIN_MISMATCH[\s\S]*Expected:[\s\S]*Received:/u,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('accepts CORS on valid 503 while retaining degraded readiness for the full verifier', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(preflight());
    const { result, healthSnapshot } = await checkCors(fetchImpl);
    expect(result).toEqual({ healthHttpStatus: 503, readiness: 'SERVICE_DEGRADED' });
    const verification = verifyStagingSnapshot(healthSnapshot, [], expectedBuild);
    expect(verification.ok).toBe(false);
    expect(verification.errors).toContain('Worker: health HTTP status is not ready');
    expect(verification.errors).toContain('Worker: health status is not ready');
  });

  it('retries rate-limited GET after a full limiter window, including non-JSON 429', async () => {
    const clock = virtualTime();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('limited', { status: 429, headers: corsHeaders }))
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(preflight());
    await checkCors(fetchImpl, clock);
    expect(clock.sleep).toHaveBeenCalledExactlyOnceWith(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('bounds persistent GET 429 and preserves HTTP status and ACAO', async () => {
    const clock = virtualTime();
    const fetchImpl = vi.fn(async () => {
      // A real response takes time; a 60s deadline alone cannot fit a 60s cooldown.
      await clock.sleep(100);
      return new Response(null, { status: 429, headers: corsHeaders });
    });
    await expect(checkCors(fetchImpl, clock)).rejects.toThrow(
      /RATE_LIMITED: HTTP 429[\s\S]*Access-Control-Allow-Origin: https:\/\/mirna-finansije.vercel.app/u,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clock.now()).toBe(60_200);
  });

  it.each(['120', new Date(120_000).toUTCString()])(
    'does not retry early when Retry-After %s exceeds the deadline',
    async (retryAfter) => {
      const fetchImpl = vi.fn(() =>
        Promise.resolve(
          new Response(null, {
            status: 429,
            headers: { ...corsHeaders, 'Retry-After': retryAfter },
          }),
        ),
      );
      await expect(checkCors(fetchImpl)).rejects.toThrow(/RATE_LIMITED: HTTP 429/u);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it('reports OPTIONS 403 with every CORS response header', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(preflight(403));
    await expect(checkCors(fetchImpl)).rejects.toThrow(
      /CORS_PREFLIGHT_STATUS: HTTP 403[\s\S]*Allow-Origin:[\s\S]*Allow-Headers:[\s\S]*Allow-Methods:/u,
    );
  });

  it.each([
    { 'Access-Control-Allow-Headers': 'x-mirna-protocol-version' },
    { 'Access-Control-Allow-Headers': 'x-mirna-protocol-version,x-mirna-support-id-fake' },
    { 'Access-Control-Allow-Headers': '*' },
    { 'Access-Control-Allow-Methods': 'POST, OPTIONS' },
    { 'Access-Control-Allow-Origin': '*' },
  ])('rejects invalid preflight headers %j', async (headers) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(preflight(204, { ...corsHeaders, ...headers }));
    await expect(checkCors(fetchImpl)).rejects.toThrow(/CORS_(HEADERS|ORIGIN)_MISMATCH/u);
  });

  it('bounds preflight 429 retries and preserves rate-limit diagnostics', async () => {
    const clock = virtualTime();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockImplementation(() => Promise.resolve(preflight(429)));
    await expect(checkCors(fetchImpl, clock)).rejects.toThrow(
      /RATE_LIMITED: HTTP 429[\s\S]*OPTIONS/u,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(clock.now()).toBe(60_000);
  });

  it('reports preflight network failure distinctly', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(checkCors(fetchImpl)).rejects.toThrow(/NETWORK_FAILURE.*OPTIONS/u);
  });

  it('recovers from a preflight 429 after one cooldown', async () => {
    const clock = virtualTime();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(preflight(429))
      .mockResolvedValueOnce(preflight());
    await checkCors(fetchImpl, clock);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(clock.now()).toBe(60_000);
  });

  it('does not reuse a snapshot fetched without the production Origin', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response());
    const healthSnapshot = await fetchWorkerHealthSnapshot({ fetchImpl, workerUrl });
    await expect(
      verifyProductionCors({ fetchImpl, workerUrl, productionOrigin, healthSnapshot }),
    ).rejects.toThrow(/not requested with the expected Origin/u);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('caps real GET network failures at seven attempts with their own diagnostic', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(checkCors(fetchImpl)).rejects.toThrow(/NETWORK_FAILURE: Worker health GET/u);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it('caps old builds at seven GETs even with the longer cooldown deadline', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(response(200, corsHeaders, oldBuild)));
    await expect(checkCors(fetchImpl)).rejects.toThrow(/Attempts: 7/u);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it('keeps convergence plus preflight below 10 health requests even at the deadline', async () => {
    const clock = virtualTime();
    const requests = [];
    const fetchImpl = vi.fn((url, options) => {
      requests.push(clock.now());
      expect(requests.filter((time) => clock.now() - time <= 60_000).length).toBeLessThan(10);
      expect(options.headers.Origin).toBe(productionOrigin);
      return Promise.resolve(
        options.method === 'OPTIONS'
          ? preflight()
          : response(200, corsHeaders, clock.now() < 60_000 ? oldBuild : expectedBuild),
      );
    });
    await checkCors(fetchImpl, clock);
    expect(requests).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 60_000]);
  });
});
