import { canonicalizeJson } from '../../../src/domain/sync/canonical';
import type { z } from 'zod';
import { HttpError } from './errors';

const DEFAULT_MAX_BODY_BYTES = 160 * 1_024;

const readBoundedUtf8Body = async (request: Request, maxBytes: number): Promise<string> => {
  const declaredLength = request.headers.get('Content-Length');
  let expectedLength: number | null = null;
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
      throw new HttpError(400, 'REQUEST_LENGTH_MISMATCH', 'Request length is invalid.');
    }
    expectedLength = Number(declaredLength);
    if (!Number.isSafeInteger(expectedLength)) {
      throw new HttpError(400, 'REQUEST_LENGTH_MISMATCH', 'Request length is invalid.');
    }
    if (expectedLength > maxBytes) {
      throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Request body is too large.');
    }
  }
  if (request.body === null) {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      received += part.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Request body is too large.');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (expectedLength !== null && received !== expectedLength) {
    throw new HttpError(400, 'REQUEST_LENGTH_MISMATCH', 'Request length is invalid.');
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  }
};

export const readCanonicalJson = async <T extends z.ZodType>(
  request: Request,
  schema: T,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<z.output<T>> => {
  const raw = await readBoundedUtf8Body(request, maxBytes);

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  }

  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new HttpError(400, 'INVALID_REQUEST', 'Request body does not match protocol v1.');
  }
  if (raw !== canonicalizeJson(parsed.data)) {
    throw new HttpError(
      400,
      'NON_CANONICAL_REQUEST',
      'Request body must use the canonical protocol representation.',
    );
  }
  return parsed.data;
};
