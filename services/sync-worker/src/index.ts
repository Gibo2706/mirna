import {
  planScheduledCleanup,
  runScheduledCleanup,
  scheduledCleanupEstimateInput,
  scheduledCleanupHasWork,
} from './cleanup';
import { enforceEdgeRateLimit } from './abuse';
import { estimateScheduledCleanupUsage, runBudgetWindowMaintenance, usageBudget } from './budget';
import type { RequestContext } from './context';
import type { Env } from './env';
import { HttpError } from './errors';
import {
  createRequestId,
  errorResponse,
  getAllowedOrigin,
  hasDisallowedOrigin,
  isBinaryContentType,
  isJsonContentType,
  noContentResponse,
  requiresJsonContentType,
  validatePreflightHeaders,
} from './http';
import { allowedMethodsForPath, isSnapshotUploadPath, routeRequest } from './router';
import { RouteUsageMeter } from './metering';

const HEALTH_PATH = '/v1/health';

const handlePreflight = (
  request: Request,
  requestId: string,
  allowedOrigin: string | null,
): Response => {
  if (allowedOrigin === null) {
    return errorResponse('ORIGIN_NOT_ALLOWED', 'Origin is not allowed.', 403, { requestId });
  }

  const methods = allowedMethodsForPath(new URL(request.url).pathname);
  if (!methods) {
    return errorResponse('ROUTE_NOT_FOUND', 'Route was not found.', 404, {
      requestId,
      allowedOrigin,
    });
  }

  const requestedMethod = request.headers.get('Access-Control-Request-Method');
  if (
    !requestedMethod ||
    !methods.includes(requestedMethod) ||
    !validatePreflightHeaders(request)
  ) {
    return errorResponse('PREFLIGHT_NOT_ALLOWED', 'Preflight request is not allowed.', 403, {
      requestId,
      allowedOrigin,
    });
  }

  return noContentResponse({ requestId, allowedOrigin, allowedMethods: [...methods, 'OPTIONS'] });
};

const executeRoute = async (context: RequestContext): Promise<Response> => {
  const { request, requestId, allowedOrigin } = context;
  if (request.method === 'OPTIONS') {
    return handlePreflight(request, requestId, allowedOrigin);
  }

  const requestedProtocol = request.headers.get('X-Mirna-Protocol-Version');
  const pathname = new URL(request.url).pathname;
  if (
    (pathname !== HEALTH_PATH && requestedProtocol !== '1') ||
    (requestedProtocol !== null && requestedProtocol !== '1')
  ) {
    return errorResponse(
      'PROTOCOL_UPGRADE_REQUIRED',
      'Sync protocol version is not supported.',
      426,
      { requestId, allowedOrigin },
    );
  }

  const snapshotUpload = request.method === 'PUT' && isSnapshotUploadPath(pathname);
  if (snapshotUpload && !isBinaryContentType(request)) {
    return errorResponse(
      'UNSUPPORTED_CONTENT_TYPE',
      'Content-Type must be application/octet-stream.',
      415,
      { requestId, allowedOrigin },
    );
  }

  if (!snapshotUpload && requiresJsonContentType(request) && !isJsonContentType(request)) {
    return errorResponse(
      'UNSUPPORTED_CONTENT_TYPE',
      'Content-Type must be application/json.',
      415,
      { requestId, allowedOrigin },
    );
  }

  if (pathname !== HEALTH_PATH && allowedOrigin === null) {
    return errorResponse('ORIGIN_REQUIRED', 'An allowed Origin header is required.', 403, {
      requestId,
      allowedOrigin,
    });
  }

  await enforceEdgeRateLimit(request, context.accountingEnv ?? context.env);
  await usageBudget.reserveRoute(context);

  const usageMeter = new RouteUsageMeter();
  context.usageMeter = usageMeter;
  context.env = usageMeter.wrapEnvironment(context.accountingEnv ?? context.env);

  return routeRequest(context);
};

const responseWithAccountingWarning = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set('X-Mirna-Accounting-Status', 'reconciliation-required');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const throwCapturedError = (error: unknown): never => {
  if (error instanceof Error) throw error;
  throw new Error('Worker captured a non-error rejection.');
};

const fetchHandler = async (
  request: Request,
  env: Env,
  requestId: string,
  allowedOrigin: string | null,
): Promise<Response> => {
  if (hasDisallowedOrigin(request, env)) {
    return errorResponse('ORIGIN_NOT_ALLOWED', 'Origin is not allowed.', 403, { requestId });
  }

  const context: RequestContext = {
    request,
    env,
    accountingEnv: env,
    requestId,
    allowedOrigin,
    budgetReservationIds: [],
  };
  await usageBudget.reserveRequest(context);
  let response: Response | undefined;
  let routeError: unknown;
  try {
    response = await executeRoute(context);
  } catch (error) {
    routeError = error;
  }

  let settlementError: unknown;
  try {
    await usageBudget.settle(context);
  } catch (error) {
    settlementError = error;
  }

  if (settlementError !== undefined) {
    if (response && context.businessCommit?.committed === true) {
      return responseWithAccountingWarning(response);
    }
    throwCapturedError(settlementError);
  }
  if (routeError !== undefined) throwCapturedError(routeError);
  if (!response) throw new Error('Route completed without a response.');
  return response;
};

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    const requestId = createRequestId();
    const allowedOrigin = getAllowedOrigin(request, env);

    try {
      return await fetchHandler(request, env, requestId, allowedOrigin);
    } catch (error) {
      if (error instanceof HttpError) {
        const allowedMethods = allowedMethodsForPath(new URL(request.url).pathname);
        return errorResponse(error.code, error.message, error.status, {
          requestId,
          allowedOrigin,
          verificationReason:
            env.MIRNA_ENVIRONMENT === 'staging' ? error.verificationReason : undefined,
          accounting: env.MIRNA_ENVIRONMENT === 'staging' ? error.accounting : undefined,
          headers:
            error.status === 405 && allowedMethods
              ? { Allow: [...allowedMethods, 'OPTIONS'].join(', ') }
              : undefined,
        });
      }
      return errorResponse('INTERNAL_ERROR', 'Request could not be processed.', 500, {
        requestId,
        allowedOrigin,
      });
    }
  },

  scheduled(controller, env, context) {
    context.waitUntil(
      (async () => {
        const requestContext: RequestContext = {
          request: new Request('https://mirna.invalid/__scheduled/cleanup'),
          env,
          accountingEnv: env,
          requestId: crypto.randomUUID(),
          allowedOrigin: null,
          budgetReservationIds: [],
        };
        await usageBudget.reserveRequest(requestContext);
        try {
          const usageMeter = new RouteUsageMeter(true);
          requestContext.usageMeter = usageMeter;
          requestContext.env = usageMeter.wrapEnvironment(env);
          const expiredUsageBuckets = await runBudgetWindowMaintenance(
            requestContext.env,
            controller.scheduledTime,
          );
          const plan = await planScheduledCleanup(requestContext.env, controller.scheduledTime);
          if (expiredUsageBuckets === 0 && !scheduledCleanupHasWork(plan)) return;
          await usageBudget.reserveScheduledCleanup(
            requestContext,
            estimateScheduledCleanupUsage(scheduledCleanupEstimateInput(plan, expiredUsageBuckets)),
          );
          await runScheduledCleanup(requestContext.env, controller.scheduledTime, plan);
        } finally {
          await usageBudget.settle(requestContext);
        }
      })(),
    );
  },
};

export default worker;
