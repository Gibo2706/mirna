const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CROCKFORD_DECODE = new Map(
  [...CROCKFORD_ALPHABET].map((character, index) => [character, index]),
);

for (const [alias, canonical] of [
  ['O', '0'],
  ['I', '1'],
  ['L', '1'],
] as const) {
  CROCKFORD_DECODE.set(alias, CROCKFORD_DECODE.get(canonical)!);
}

export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export const decodeUtf8 = (value: BufferSource): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(value);

export const concatBytes = (...values: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(values.reduce((length, value) => length + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
};

export const bytesToBase64Url = (value: Uint8Array): string => {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

export const base64UrlToBytes = (value: string): Uint8Array => {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw new Error('Neispravan base64url zapis.');
  }
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('Neispravan base64url zapis.');
  }
  const result = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64Url(result) !== value) throw new Error('Base64url zapis nije kanonski.');
  return result;
};

export const bytesToHex = (value: Uint8Array): string =>
  [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export const hexToBytes = (value: string): Uint8Array => {
  if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new Error('Neispravan hexadecimalni zapis.');
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
};

export const timingSafeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};

export const clearBytes = (...values: readonly Uint8Array[]): void => {
  for (const value of values) value.fill(0);
};

export const encodeCrockfordBase32 = (value: Uint8Array): string => {
  let bits = 0;
  let accumulator = 0;
  let output = '';
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += CROCKFORD_ALPHABET[(accumulator >>> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) output += CROCKFORD_ALPHABET[(accumulator << (5 - bits)) & 31];
  return output;
};

export const decodeCrockfordBase32 = (value: string): Uint8Array => {
  const compact = value.toUpperCase().replaceAll(/[-\s]/gu, '');
  if (!compact) return new Uint8Array();
  let bits = 0;
  let accumulator = 0;
  const output: number[] = [];
  for (const character of compact) {
    const decoded = CROCKFORD_DECODE.get(character);
    if (decoded === undefined) throw new Error('Kod sadrži nedozvoljen znak.');
    accumulator = (accumulator << 5) | decoded;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((accumulator >>> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0 && accumulator !== 0) throw new Error('Kod ima neispravno završno popunjavanje.');
  return Uint8Array.from(output);
};

export const groupCode = (value: string, groupLength = 5): string =>
  value.match(new RegExp(`.{1,${groupLength}}`, 'gu'))?.join('-') ?? '';

export const ungroupCode = (value: string): string => value.replaceAll(/[-\s]/gu, '').toUpperCase();
