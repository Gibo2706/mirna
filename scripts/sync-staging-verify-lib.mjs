export const WORKER_BUILD_PATTERN = /^[0-9a-f]{7,64}$/u;
export const DEFAULT_BUILD_CONVERGENCE_TIMEOUT_MS = 60_000;
export const DEFAULT_BUILD_CONVERGENCE_INTERVAL_MS = 2_000;

const shortBuild = (value) => (typeof value === 'string' ? value.slice(0, 12) : 'unavailable');

const isHealthPayload = (value) =>
  value !== null &&
  typeof value === 'object' &&
  value.environment === 'staging' &&
  value.protocolVersion === 1 &&
  WORKER_BUILD_PATTERN.test(value.buildCommit) &&
  (value.status === 'ok' || value.status === 'degraded') &&
  value.services !== null &&
  typeof value.services === 'object' &&
  value.readiness !== null &&
  typeof value.readiness === 'object';

const hasHealthIdentity = (value) =>
  value !== null &&
  typeof value === 'object' &&
  ('environment' in value || 'protocolVersion' in value || 'buildCommit' in value);

export const fetchWorkerHealthSnapshot = async ({ fetchImpl = fetch, workerUrl }) => {
  let response;
  try {
    response = await fetchImpl(workerUrl, {
      headers: {
        'Cache-Control': 'no-cache',
        'X-Mirna-Protocol-Version': '1',
      },
      cache: 'no-store',
      redirect: 'error',
    });
  } catch {
    return { kind: 'retryable', reason: 'network failure' };
  }

  let health;
  try {
    health = await response.json();
  } catch {
    if (response.status === 404 || response.status >= 500) {
      return { kind: 'retryable', reason: `HTTP ${response.status}` };
    }
    throw new Error('Worker health payload nije validan JSON.');
  }

  if (!isHealthPayload(health) && (response.status === 404 || response.status >= 500)) {
    if (!hasHealthIdentity(health)) {
      return { kind: 'retryable', reason: `HTTP ${response.status}` };
    }
  }
  if (!isHealthPayload(health)) {
    throw new Error('Worker health payload, environment ili protokol nisu ispravni.');
  }
  if (response.status !== 200 && response.status !== 503) {
    throw new Error(`Worker health HTTP status ${response.status} nije dozvoljen.`);
  }
  return { kind: 'health', health, healthHttpStatus: response.status };
};

export const waitForExpectedWorkerBuild = async ({
  expectedBuild,
  readHealth,
  timeoutMs = DEFAULT_BUILD_CONVERGENCE_TIMEOUT_MS,
  intervalMs = DEFAULT_BUILD_CONVERGENCE_INTERVAL_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
  log = () => undefined,
}) => {
  if (!WORKER_BUILD_PATTERN.test(expectedBuild)) {
    throw new Error('Expected Worker build nije validan.');
  }
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    throw new Error('Worker convergence interval nije validan.');
  }

  const startedAt = now();
  let attempts = 0;
  let lastReceived = 'unavailable';
  let lastRetryableReason;
  let waitingLogged = false;

  while (true) {
    attempts += 1;
    const result = await readHealth();
    if (result.kind === 'health') {
      lastReceived = result.health.buildCommit;
      if (lastReceived === expectedBuild) {
        if (attempts > 1) {
          log(
            `Worker build converged after ${Math.max(0, now() - startedAt)} ms / ${attempts} attempts.`,
          );
        }
        return { ...result, attempts, elapsedMs: Math.max(0, now() - startedAt) };
      }
      lastRetryableReason = undefined;
    } else if (result.kind === 'retryable') {
      lastRetryableReason = result.reason;
    } else {
      throw new Error('Worker health reader je vratio nepoznat rezultat.');
    }

    if (!waitingLogged) {
      log('Waiting for Worker deployment convergence...');
      waitingLogged = true;
    }
    log(
      `attempt ${attempts}: received ${shortBuild(lastReceived)}, expected ${shortBuild(expectedBuild)}` +
        (lastRetryableReason ? ` (${lastRetryableReason})` : ''),
    );

    const elapsedMs = Math.max(0, now() - startedAt);
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `Worker build nije konvergirao u roku od ${timeoutMs}ms.\n` +
          `Expected: ${expectedBuild}\n` +
          `Last received: ${lastReceived}\n` +
          `Attempts: ${attempts}` +
          (lastRetryableReason ? `\nLast retryable error: ${lastRetryableReason}` : ''),
      );
    }
    await sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
  }
};

export const verifyProductionCors = async ({ fetchImpl = fetch, workerUrl, productionOrigin }) => {
  try {
    const response = await fetchImpl(workerUrl, {
      headers: {
        'Cache-Control': 'no-cache',
        Origin: productionOrigin,
        'X-Mirna-Protocol-Version': '1',
      },
      cache: 'no-store',
      redirect: 'error',
    });
    if (
      response.status !== 200 ||
      response.headers.get('Access-Control-Allow-Origin') !== productionOrigin
    ) {
      throw new Error('invalid production health CORS');
    }
    await response.body?.cancel();

    const preflight = await fetchImpl(workerUrl, {
      method: 'OPTIONS',
      headers: {
        'Cache-Control': 'no-cache',
        Origin: productionOrigin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-mirna-protocol-version,x-mirna-support-id',
      },
      cache: 'no-store',
      redirect: 'error',
    });
    const allowedHeaders = preflight.headers.get('Access-Control-Allow-Headers') ?? '';
    if (
      preflight.status !== 204 ||
      preflight.headers.get('Access-Control-Allow-Origin') !== productionOrigin ||
      !allowedHeaders.includes('x-mirna-protocol-version') ||
      !allowedHeaders.includes('x-mirna-support-id')
    ) {
      throw new Error('invalid production preflight CORS');
    }
    await preflight.body?.cancel();
  } catch {
    throw new Error('Produkcioni Vercel origin nije ispravno dozvoljen na Worker-u.');
  }
};
