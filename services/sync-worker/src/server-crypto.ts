import { canonicalizeJson } from '../../../src/domain/sync/canonical';
import { createOpaqueId, sha256 } from '../../../src/domain/sync/crypto';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  concatBytes,
  utf8,
} from '../../../src/domain/sync/encoding';

const ZERO = Uint8Array.of(0);

export const canonicalText = (value: unknown): string => canonicalizeJson(value);

export const randomOpaqueId = (): string => createOpaqueId();

export const randomSecret = (bytes = 32): string => {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToBase64Url(value);
};

export const domainHashBytes = async (label: string, value: Uint8Array): Promise<Uint8Array> =>
  sha256(concatBytes(utf8(label), ZERO, value));

export const hashEncodedSecret = async (
  label: string,
  encoded: string,
  expectedBytes = 32,
): Promise<Uint8Array> => {
  const decoded = base64UrlToBytes(encoded);
  if (decoded.length !== expectedBytes) throw new Error('Secret has an invalid length.');
  return domainHashBytes(label, decoded);
};

export const toDatabaseBlob = (value: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(value.length);
  copy.set(value);
  return copy.buffer;
};

export const encodedToDatabaseBlob = (value: string, expectedBytes?: number): ArrayBuffer => {
  const decoded = base64UrlToBytes(value);
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new Error('Encoded field has an invalid length.');
  }
  return toDatabaseBlob(decoded);
};

export const isoTimestamp = (milliseconds: number): string => new Date(milliseconds).toISOString();
