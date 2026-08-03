import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from './canonical';

describe('RFC 8785 canonical protocol JSON', () => {
  it('sorts object properties recursively without reordering arrays', () => {
    expect(
      canonicalizeJson({
        z: [{ b: 2, a: 1 }],
        a: { '\u20ac': 'euro', '\r': 'return', '1': 'one' },
      }),
    ).toBe('{"a":{"\\r":"return","1":"one","€":"euro"},"z":[{"a":1,"b":2}]}');
  });

  it.each([
    ['undefined', { value: undefined }],
    ['undefined array item', [undefined]],
    ['non-finite number', { value: Number.POSITIVE_INFINITY }],
    ['floating point number', { value: 1.5 }],
    ['negative zero', { value: -0 }],
    ['unsafe integer', { value: Number.MAX_SAFE_INTEGER + 1 }],
    ['class instance', new Date()],
    ['lone surrogate', { value: '\uD800' }],
  ])('rejects %s rather than signing an ambiguous value', (_label, value) => {
    expect(() => canonicalizeJson(value)).toThrow();
  });

  it('rejects circular references', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => canonicalizeJson(value)).toThrow(/kružne/u);
  });
});
