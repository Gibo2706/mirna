import { runScheduledCleanup } from './cleanup';
import { enforceEdgeRateLimit } from './abuse';
import { runBudgetWindowMaintenance, usageBudget } from './budget';
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
    requestId,
    allowedOrigin,
    budgetReservationIds: [],
  };
  await usageBudget.reserveRequest(context);
  try {
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

    await enforceEdgeRateLimit(request, env);
    await usageBudget.reserveRoute(context);

    const usageMeter = new RouteUsageMeter();
    context.usageMeter = usageMeter;
    context.env = usageMeter.wrapEnvironment(env);

    return await routeRequest(context);
  } finally {
    await usageBudget.settle(context);
  }
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
        await runBudgetWindowMaintenance(env, controller.scheduledTime);
        const requestContext: RequestContext = {
          request: new Request('https://mirna.invalid/__scheduled/cleanup'),
          env,
          requestId: crypto.randomUUID(),
          allowedOrigin: null,
          budgetReservationIds: [],
        };
        await usageBudget.reserveRequest(requestContext);
        try {
          await usageBudget.reserveScheduledCleanup(requestContext);
          const usageMeter = new RouteUsageMeter();
          requestContext.usageMeter = usageMeter;
          requestContext.env = usageMeter.wrapEnvironment(env);
          await runScheduledCleanup(requestContext.env, controller.scheduledTime);
        } finally {
          await usageBudget.settle(requestContext);
        }
      })(),
    );
  },
};

export default worker;
