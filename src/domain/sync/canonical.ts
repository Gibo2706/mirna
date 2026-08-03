import canonicalize from 'canonicalize';
import { utf8 } from './encoding';

export type CanonicalJson =
  null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

const assertString = (value: string): void => {
  if (LONE_SURROGATE.test(value)) {
    throw new Error('Kanonski JSON ne prihvata neusaglašene Unicode surrogate znakove.');
  }
};

type AssertCanonicalJson = (
  value: unknown,
  seen?: WeakSet<object>,
) => asserts value is CanonicalJson;

export const assertCanonicalJson: AssertCanonicalJson = (value, seen = new WeakSet()) => {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    assertString(value);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error('Kanonski protokol prihvata samo konačne bezbedne cele brojeve.');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new Error('Vrednost nije podržan I-JSON tip.');
  }
  if (seen.has(value)) throw new Error('Kanonski JSON ne prihvata kružne reference.');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertCanonicalJson(item, seen);
    seen.delete(value);
    return;
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Kanonski JSON prihvata samo obične objekte.');
  }
  for (const [key, item] of Object.entries(value)) {
    assertString(key);
    assertCanonicalJson(item, seen);
  }
  seen.delete(value);
};

export const canonicalizeJson = (value: unknown): string => {
  assertCanonicalJson(value);
  const result: unknown = canonicalize(value);
  if (typeof result !== 'string') throw new Error('Vrednost nema kanonski JSON zapis.');
  return result;
};

export const canonicalBytes = (value: unknown): Uint8Array => utf8(canonicalizeJson(value));
