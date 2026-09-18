export const WORKER_BUILD_PATTERN = /^[0-9a-f]{7,64}$/u;
export const DEFAULT_BUILD_CONVERGENCE_TIMEOUT_MS = 120_000;
export const DEFAULT_BUILD_CONVERGENCE_INTERVAL_MS = 10_000;
export const DEFAULT_BUILD_CONVERGENCE_MAX_ATTEMPTS = 7;

// Seven GETs at most, leaving room for preflight on the same 10/60s limiter.
// The wall-clock bound also accommodates a full 429 cooldown and network latency.
const RATE_LIMIT_WINDOW_MS = 60_000;
const requestTimeout = () => AbortSignal.timeout(10_000);
const sleepFor = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const corsDetails = (status, headers) =>
  `HTTP ${status}\nAccess-Control-Allow-Origin: ${headers.get('Access-Control-Allow-Origin') ?? '<missing>'}` +
  `\nAccess-Control-Allow-Headers: ${headers.get('Access-Control-Allow-Headers') ?? '<missing>'}` +
  `\nAccess-Control-Allow-Methods: ${headers.get('Access-Control-Allow-Methods') ?? '<missing>'}`;
const requireOrigin = (status, headers, expected) => {
  const received = headers.get('Access-Control-Allow-Origin');
  if (received !== expected) {
    throw new Error(
      `CORS_ORIGIN_MISMATCH: Expected: ${expected}\nReceived: ${received ?? '<missing>'}\n${corsDetails(status, headers)}`,
    );
  }
};
const rateLimitDelay = (headers, now) => {
  const value = headers.get('Retry-After');
  const seconds = value && /^\d+$/u.test(value.trim()) ? Number(value) : NaN;
  const retryAt = value ? Date.parse(value) : NaN;
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Number.isFinite(retryAt)
      ? retryAt - now()
      : 0;
  return Math.max(RATE_LIMIT_WINDOW_MS, delay);
};

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

export const fetchWorkerHealthSnapshot = async ({
  fetchImpl = fetch,
  workerUrl,
  productionOrigin,
  now = Date.now,
}) => {
  let response;
  try {
    response = await fetchImpl(workerUrl, {
      headers: {
        'Cache-Control': 'no-cache',
        'X-Mirna-Protocol-Version': '1',
        ...(productionOrigin ? { Origin: productionOrigin } : {}),
      },
      cache: 'no-store',
      redirect: 'error',
      signal: requestTimeout(),
    });
  } catch {
    return { kind: 'retryable', reason: 'NETWORK_FAILURE: Worker health GET' };
  }

  if (response.status === 429) {
    await response.body?.cancel();
    return {
      kind: 'retryable',
      reason: `RATE_LIMITED: ${corsDetails(response.status, response.headers)} (GET)`,
      retryAfterMs: rateLimitDelay(response.headers, now),
    };
  }
  // Edge deployment errors may lack CORS headers; preserve their HTTP diagnosis.
  if (productionOrigin && (response.status === 200 || response.status === 403)) {
    requireOrigin(response.status, response.headers, productionOrigin);
  }
  let health;
  try {
    health = await response.json();
  } catch {
    if (response.status === 404 || response.status >= 500) {
      return {
        kind: 'retryable',
        reason: `${response.status === 503 ? 'SERVICE_DEGRADED: ' : ''}HTTP ${response.status}`,
      };
    }
    throw new Error('Worker health payload nije validan JSON.');
  }

  if (!isHealthPayload(health) && (response.status === 404 || response.status >= 500)) {
    if (!hasHealthIdentity(health)) {
      return {
        kind: 'retryable',
        reason: `${response.status === 503 ? 'SERVICE_DEGRADED: ' : ''}HTTP ${response.status}`,
      };
    }
  }
  if (!isHealthPayload(health)) {
    throw new Error('Worker health payload, environment ili protokol nisu ispravni.');
  }
  if (response.status !== 200 && response.status !== 503) {
    throw new Error(`Worker health HTTP status ${response.status} nije dozvoljen.`);
  }
  return {
    kind: 'health',
    health,
    healthHttpStatus: response.status,
    healthHeaders: new Headers(response.headers),
    requestOrigin: productionOrigin,
  };
};

export const waitForExpectedWorkerBuild = async ({
  expectedBuild,
  readHealth,
  timeoutMs = DEFAULT_BUILD_CONVERGENCE_TIMEOUT_MS,
  intervalMs = DEFAULT_BUILD_CONVERGENCE_INTERVAL_MS,
  maxAttempts = DEFAULT_BUILD_CONVERGENCE_MAX_ATTEMPTS,
  sleep = sleepFor,
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
    intervalMs <= 0 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1
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
    const delayMs = Math.max(intervalMs, result.retryAfterMs ?? 0);
    if (
      attempts >= maxAttempts ||
      elapsedMs + delayMs > timeoutMs ||
      result.retryAfterMs > RATE_LIMIT_WINDOW_MS
    ) {
      throw new Error(
        `Worker build nije konvergirao (limit: ${timeoutMs}ms / ${maxAttempts} attempts).\n` +
          `Expected: ${expectedBuild}\n` +
          `Last received: ${lastReceived}\n` +
          `Attempts: ${attempts}` +
          (lastRetryableReason ? `\nLast retryable error: ${lastRetryableReason}` : ''),
      );
    }
    await sleep(delayMs);
  }
};

export const verifyProductionCors = async ({
  fetchImpl = fetch,
  workerUrl,
  productionOrigin,
  healthSnapshot,
  sleep = sleepFor,
  now = Date.now,
}) => {
  // Only reuse a response to a request bearing this exact Origin. Readiness is
  // still evaluated by verifyStagingSnapshot using the unchanged payload/status.
  if (healthSnapshot?.requestOrigin !== productionOrigin || !productionOrigin) {
    throw new Error(
      'CORS_ORIGIN_MISMATCH: health snapshot was not requested with the expected Origin.',
    );
  }
  const { healthHttpStatus, healthHeaders } = healthSnapshot;
  requireOrigin(healthHttpStatus, healthHeaders, productionOrigin);
  if (healthHttpStatus !== 200 && healthHttpStatus !== 503) {
    throw new Error(
      `${healthHttpStatus === 429 ? 'RATE_LIMITED' : 'HEALTH_HTTP_STATUS'}: ${corsDetails(healthHttpStatus, healthHeaders)} (GET)`,
    );
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let preflight;
    try {
      preflight = await fetchImpl(workerUrl, {
        method: 'OPTIONS',
        headers: {
          'Cache-Control': 'no-cache',
          Origin: productionOrigin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'x-mirna-protocol-version,x-mirna-support-id',
        },
        cache: 'no-store',
        redirect: 'error',
        signal: requestTimeout(),
      });
    } catch {
      throw new Error('NETWORK_FAILURE: Production CORS OPTIONS request failed.');
    }
    await preflight.body?.cancel();
    const details = `${corsDetails(preflight.status, preflight.headers)} (OPTIONS)`;
    if (preflight.status === 429) {
      const delayMs = rateLimitDelay(preflight.headers, now);
      if (attempt === 1 || delayMs > RATE_LIMIT_WINDOW_MS) {
        throw new Error(`RATE_LIMITED: ${details}`);
      }
      await sleep(delayMs);
      continue;
    }
    if (preflight.status !== 204) {
      throw new Error(`CORS_PREFLIGHT_STATUS: ${details}\nExpected: HTTP 204`);
    }
    requireOrigin(preflight.status, preflight.headers, productionOrigin);
    const tokens = (name) =>
      (preflight.headers.get(name) ?? '').split(',').map((value) => value.trim());
    const allowedHeaders = tokens('Access-Control-Allow-Headers').map((value) =>
      value.toLowerCase(),
    );
    if (
      !tokens('Access-Control-Allow-Methods').includes('GET') ||
      !allowedHeaders.includes('x-mirna-protocol-version') ||
      !allowedHeaders.includes('x-mirna-support-id')
    ) {
      throw new Error(
        `CORS_HEADERS_MISMATCH: ${details}\nExpected method: GET; headers: x-mirna-protocol-version, x-mirna-support-id`,
      );
    }
    return { healthHttpStatus, readiness: healthHttpStatus === 503 ? 'SERVICE_DEGRADED' : 'ok' };
  }
};
