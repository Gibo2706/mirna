import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readCanonicalJson } from '../src/validation';
import { TEST_ORIGIN } from './protocol-fixtures';

const canonicalHeaders = (): Headers =>
  new Headers({
    'Content-Type': 'application/json',
    Origin: TEST_ORIGIN,
    'X-Mirna-Protocol-Version': '1',
  });

const errorCode = async (response: Response): Promise<string | undefined> =>
  (await response.json<{ error?: { code?: string } }>()).error?.code;

const streamingBody = (
  chunks: readonly Uint8Array[],
): { body: ReadableStream<Uint8Array>; wasCancelled: () => boolean } => {
  let nextChunk = 0;
  let cancelled = false;
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[nextChunk];
        nextChunk += 1;
        if (chunk) {
          controller.enqueue(chunk);
          return;
        }
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
    wasCancelled: () => cancelled,
  };
};

describe('bounded canonical request reader', () => {
  it('rejects an oversized chunked endpoint body with 413 before JSON parsing and cancels it', async () => {
    const source = streamingBody([
      new Uint8Array(100 * 1_024).fill(0x7b),
      new Uint8Array(70 * 1_024).fill(0x41),
      new Uint8Array(16).fill(0x42),
    ]);
    const request = new Request('https://sync.invalid/v1/pairings', {
      method: 'POST',
      headers: canonicalHeaders(),
      body: source.body,
    });
    expect(request.headers.has('Content-Length')).toBe(false);

    const response = await SELF.fetch(request);
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe('REQUEST_TOO_LARGE');
    expect(source.wasCancelled()).toBe(true);
  });

  it('cancels a directly bounded stream immediately after the limit is crossed', async () => {
    const source = streamingBody([
      new TextEncoder().encode('{"ok":'),
      new Uint8Array(16).fill(0x31),
      new TextEncoder().encode('}'),
    ]);
    const request = new Request('https://sync.invalid/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: source.body,
    });
    await expect(
      readCanonicalJson(request, z.strictObject({ ok: z.boolean() }), 8),
    ).rejects.toMatchObject({ status: 413, code: 'REQUEST_TOO_LARGE' });
    expect(source.wasCancelled()).toBe(true);
  });

  it('rejects malformed and mismatched declared lengths before schema parsing', async () => {
    const malformed = new Request('https://sync.invalid/v1/pairings', {
      method: 'POST',
      headers: {
        ...Object.fromEntries(canonicalHeaders()),
        'Content-Length': '01',
      },
      body: '{}',
    });
    expect(malformed.headers.get('Content-Length')).toBe('01');
    const malformedResponse = await SELF.fetch(malformed);
    expect(malformedResponse.status).toBe(400);
    expect(await errorCode(malformedResponse)).toBe('REQUEST_LENGTH_MISMATCH');

    const mismatch = new Request('https://sync.invalid/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '9' },
      body: '{}',
    });
    await expect(readCanonicalJson(mismatch, z.strictObject({}), 128)).rejects.toMatchObject({
      status: 400,
      code: 'REQUEST_LENGTH_MISMATCH',
    });
  });
});
