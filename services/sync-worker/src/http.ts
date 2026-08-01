import type { Env } from './env';
import type { VerificationReason } from './errors';

export const SYNC_PROTOCOL_VERSION = 1 as const;

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const ALLOWED_REQUEST_HEADERS = new Set([
  'authorization',
  'content-type',
  'idempotency-key',
  'x-mirna-snapshot-envelope',
  'x-mirna-protocol-version',
  'x-mirna-support-id',
  'x-mirna-turnstile-token',
  'x-mirna-verification-attempt-id',
]);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface PublicError {
  error: {
    code: string;
    message: string;
    requestId: string;
    verificationReason?: VerificationReason;
  };
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
}

export const createRequestId = (): string => crypto.randomUUID();

const configuredOrigins = (value: string): ReadonlySet<string> => {
  const origins = new Set<string>();

  for (const candidate of value.split(',')) {
    const exact = candidate.trim();
    if (!exact || exact === 'null' || exact.includes('*')) continue;

    try {
      const parsed = new URL(exact);
      const secureOrigin = parsed.protocol === 'https:';
      const knownLocalDevelopmentOrigin =
        parsed.protocol === 'http:' &&
        (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
      if (parsed.origin === exact && (secureOrigin || knownLocalDevelopmentOrigin)) {
        origins.add(exact);
      }
    } catch {
      // Invalid configuration fails closed; it is never reflected to a client.
    }
  }

  return origins;
};

export const getAllowedOrigin = (request: Request, env: Env): string | null => {
  const origin = request.headers.get('Origin');
  if (origin === null) return null;
  return configuredOrigins(env.MIRNA_ALLOWED_ORIGINS).has(origin) ? origin : null;
};

export const hasDisallowedOrigin = (request: Request, env: Env): boolean =>
  request.headers.has('Origin') && getAllowedOrigin(request, env) === null;

const applySecurityHeaders = (
  headers: Headers,
  requestId: string,
  allowedOrigin: string | null,
): void => {
  headers.set('Cache-Control', 'no-store');
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Mirna-Protocol-Version', String(SYNC_PROTOCOL_VERSION));
  headers.set('X-Request-Id', requestId);
  headers.append('Vary', 'Origin');

  if (allowedOrigin !== null) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin);
    headers.set(
      'Access-Control-Expose-Headers',
      'Content-Length, X-Mirna-Protocol-Version, X-Mirna-Snapshot-Envelope, X-Request-Id',
    );
  }
};

export const jsonResponse = (
  body: unknown,
  options: {
    status?: number;
    requestId: string;
    allowedOrigin?: string | null;
    headers?: HeadersInit;
  },
): Response => {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', JSON_CONTENT_TYPE);
  applySecurityHeaders(headers, options.requestId, options.allowedOrigin ?? null);

  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers,
  });
};

export const binaryResponse = (
  body: BodyInit,
  options: {
    requestId: string;
    allowedOrigin?: string | null;
    contentLength: number;
    headers?: HeadersInit;
  },
): Response => {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Length', String(options.contentLength));
  applySecurityHeaders(headers, options.requestId, options.allowedOrigin ?? null);

  return new Response(body, { status: 200, headers });
};

export const noContentResponse = (options: {
  requestId: string;
  allowedOrigin: string;
  allowedMethods: readonly string[];
}): Response => {
  const headers = new Headers({
    'Access-Control-Allow-Headers': [...ALLOWED_REQUEST_HEADERS].sort().join(', '),
    'Access-Control-Allow-Methods': options.allowedMethods.join(', '),
    'Access-Control-Max-Age': '600',
  });
  applySecurityHeaders(headers, options.requestId, options.allowedOrigin);
  return new Response(null, { status: 204, headers });
};

export const errorResponse = (
  code: string,
  message: string,
  status: number,
  options: {
    requestId: string;
    allowedOrigin?: string | null;
    headers?: HeadersInit;
    verificationReason?: VerificationReason;
  },
): Response =>
  jsonResponse(
    {
      error: {
        code,
        message,
        requestId: options.requestId,
        ...(options.verificationReason ? { verificationReason: options.verificationReason } : {}),
      },
      protocolVersion: SYNC_PROTOCOL_VERSION,
    } satisfies PublicError,
    {
      status,
      requestId: options.requestId,
      allowedOrigin: options.allowedOrigin,
      headers: options.headers,
    },
  );

export const isJsonContentType = (request: Request): boolean =>
  request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() ===
  'application/json';

export const isBinaryContentType = (request: Request): boolean =>
  request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() ===
  'application/octet-stream';

export const requiresJsonContentType = (request: Request): boolean =>
  MUTATING_METHODS.has(request.method.toUpperCase());

export const validatePreflightHeaders = (request: Request): boolean => {
  const requested = request.headers.get('Access-Control-Request-Headers');
  if (requested === null || requested.trim() === '') return true;

  return requested
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .every((header) => ALLOWED_REQUEST_HEADERS.has(header));
};
