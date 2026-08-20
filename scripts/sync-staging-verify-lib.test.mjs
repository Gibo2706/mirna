import { describe, expect, it, vi } from 'vitest';
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

    expect(result).toMatchObject({ attempts: 3, elapsedMs: 4_000 });
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

describe('production CORS verification', () => {
  it('fails when the expected production origin is not returned exactly', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response('{}', {
          status: 200,
          headers: { 'Access-Control-Allow-Origin': 'https://wrong.example' },
        }),
      ),
    );

    await expect(
      verifyProductionCors({
        fetchImpl,
        workerUrl: 'https://worker.example/health',
        productionOrigin: 'https://mirna-finansije.vercel.app',
      }),
    ).rejects.toThrow(/Produkcioni Vercel origin/u);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
