import { describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  decodeCrockfordBase32,
  encodeCrockfordBase32,
  timingSafeEqual,
} from './encoding';

describe('sync binary encodings', () => {
  it('round-trips canonical unpadded base64url', () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).toBe('AAEC_f7_');
    expect(base64UrlToBytes(encoded)).toEqual(bytes);
    expect(() => base64UrlToBytes(`${encoded}=`)).toThrow();
  });

  it('round-trips Crockford Base32 and accepts only documented visual aliases', () => {
    const bytes = Uint8Array.from([0, 16, 32, 48, 64, 80, 96, 112]);
    const encoded = encodeCrockfordBase32(bytes);
    expect(decodeCrockfordBase32(encoded)).toEqual(bytes);
    expect(decodeCrockfordBase32(encoded.replaceAll('0', 'O'))).toEqual(bytes);
    expect(() => decodeCrockfordBase32(`${encoded}U`)).toThrow();
  });

  it('compares different lengths without early length return', () => {
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(timingSafeEqual(Uint8Array.of(1), Uint8Array.of(1, 0))).toBe(false);
  });
});
