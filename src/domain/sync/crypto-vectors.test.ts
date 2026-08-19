/** Synthetic standards vectors only. No production or user key material. */
import { describe, expect, it } from 'vitest';
import {
  importAgreementPublicKey,
  importSigningPublicKey,
  isNormalizedP256Signature,
  normalizeP256Signature,
  type CryptoRuntime,
} from './crypto';
import { bytesToBase64Url, bytesToHex, concatBytes, hexToBytes, utf8 } from './encoding';

const runtime = globalThis.crypto as CryptoRuntime;

const fromHex = (value: string): Uint8Array =>
  hexToBytes(value.replaceAll(/\s/gu, '').toLowerCase());

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(value.length);
  copy.set(value);
  return copy.buffer;
};

const rawP256Point = (x: Uint8Array, y: Uint8Array): Uint8Array =>
  concatBytes(Uint8Array.of(0x04), x, y);

describe('Mirna sync official cryptographic vectors', () => {
  it('matches the RFC 5903 section 8.1 P-256 ECDH shared-secret vector', async () => {
    const initiatorPrivate = fromHex(
      'C88F01F5 10D9AC3F 70A292DA A2316DE5 44E9AAB8 AFE84049 C62A9C57 862D1433',
    );
    const initiatorX = fromHex(
      'DAD0B653 94221CF9 B051E1FE CA5787D0 98DFE637 FC90B9EF 945D0C37 72581180',
    );
    const initiatorY = fromHex(
      '5271A046 1CDB8252 D61F1C45 6FA3E59A B1F45B33 ACCF5F58 389E0577 B8990BB3',
    );
    const responderX = fromHex(
      'D12DFB52 89C8D4F8 1208B702 70398C34 2296970A 0BCCB74C 736FC755 4494BF63',
    );
    const responderY = fromHex(
      '56FBF3CA 366CC23E 8157854C 13C58D6A AC23F046 ADA30F83 53E74F33 039872AB',
    );
    const expectedSharedX = fromHex(
      'D6840F6B 42F6EDAF D13116E0 E1256520 2FEF8E9E CE7DCE03 812464D0 4B9442DE',
    );

    const initiatorKey = await runtime.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: bytesToBase64Url(initiatorX),
        y: bytesToBase64Url(initiatorY),
        d: bytesToBase64Url(initiatorPrivate),
        ext: false,
        key_ops: ['deriveBits'],
      },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    const responderRaw = rawP256Point(responderX, responderY);
    const responderKey = await importAgreementPublicKey(
      { format: 'raw-p256', value: bytesToBase64Url(responderRaw) },
      runtime,
    );
    const sharedX = new Uint8Array(
      await runtime.subtle.deriveBits({ name: 'ECDH', public: responderKey }, initiatorKey, 256),
    );

    expect(bytesToHex(sharedX)).toBe(bytesToHex(expectedSharedX));

    await expect(
      importAgreementPublicKey(
        { format: 'raw-p256', value: bytesToBase64Url(responderRaw.slice(1)) },
        runtime,
      ),
    ).rejects.toThrow();

    const invalidPrefix = responderRaw.slice();
    invalidPrefix[0] = 0x05;
    await expect(
      importAgreementPublicKey(
        { format: 'raw-p256', value: bytesToBase64Url(invalidPrefix) },
        runtime,
      ),
    ).rejects.toThrow();
  });

  it('verifies the RFC 6979 P-256/SHA-256 sample signature in canonical low-S form', async () => {
    const publicX = fromHex(
      '60FED4BA 255A9D31 C961EB74 C6356D68 C049B892 3B61FA6C E669622E 60F29FB6',
    );
    const publicY = fromHex(
      '7903FE10 08B8BC99 A41AE9E9 5628BC64 F2F1B20C 2D7E9F51 77A3C294 D4462299',
    );
    const r = fromHex('EFD48B2A ACB6A8FD 1140DD9C D45E81D6 9D2C877B 56AAF991 C34D0EA8 4EAF3716');
    const rfcHighS = fromHex(
      'F7CB1C94 2D657C41 D436C7A1 B6E29F65 F3E900DB B9AFF406 4DC4AB2F 843ACDA8',
    );
    const expectedLowS = fromHex(
      '0834E36A D29A83BF 2BC9385E 491D6099 C8FDF9D1 ED67AA7E A5F51F93 782857A9',
    );
    const publicKey = await importSigningPublicKey(
      {
        format: 'raw-p256',
        value: bytesToBase64Url(rawP256Point(publicX, publicY)),
      },
      runtime,
    );
    const rfcSignature = concatBytes(r, rfcHighS);
    const lowSSignature = normalizeP256Signature(rfcSignature);

    expect(isNormalizedP256Signature(rfcSignature)).toBe(false);
    expect(bytesToHex(lowSSignature)).toBe(bytesToHex(concatBytes(r, expectedLowS)));
    expect(isNormalizedP256Signature(lowSSignature)).toBe(true);
    expect(
      await runtime.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        toArrayBuffer(lowSSignature),
        toArrayBuffer(utf8('sample')),
      ),
    ).toBe(true);

    expect(() => normalizeP256Signature(concatBytes(new Uint8Array(32), expectedLowS))).toThrow();
    expect(() => normalizeP256Signature(rfcSignature.slice(1))).toThrow();
  });

  it('matches RFC 5869 Appendix A.1 HKDF-SHA-256 output keying material', async () => {
    const inputKeyMaterial = fromHex('0b'.repeat(22));
    const salt = fromHex('000102030405060708090a0b0c');
    const info = fromHex('f0f1f2f3f4f5f6f7f8f9');
    const expectedOutput = fromHex(
      '3cb25f25faacd57a90434f64d0362f2a' +
        '2d2d0a90cf1a5a4c5db02d56ecc4c5bf' +
        '34007208d5b887185865',
    );
    const material = await runtime.subtle.importKey(
      'raw',
      toArrayBuffer(inputKeyMaterial),
      'HKDF',
      false,
      ['deriveBits'],
    );
    const output = new Uint8Array(
      await runtime.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: toArrayBuffer(salt),
          info: toArrayBuffer(info),
        },
        material,
        42 * 8,
      ),
    );

    expect(bytesToHex(output)).toBe(bytesToHex(expectedOutput));
  });

  it('matches RFC 9173 Appendix A.4 AES-256-GCM and rejects altered authenticated data', async () => {
    const keyBytes = fromHex(
      '71776572747975696f70617364666768' + '71776572747975696f70617364666768',
    );
    const iv = fromHex('5477656c7665313231323132');
    const plaintext = fromHex(
      '526561647920746f2067656e65726174' + '6520612033322d62797465207061796c' + '6f6164',
    );
    const aad = fromHex(
      '07880700008202820102820282020182' + '02820201820018281a000f4240010100' + '0c0201',
    );
    const ciphertext = fromHex(
      '90eab6457593379298a8724e16e61f83' + '7488e127212b59ac91f8a86287b7d076' + '30a122',
    );
    const authenticationTag = fromHex('d2c51cb2481792dae8b21d848cede99b');
    const expectedSealed = concatBytes(ciphertext, authenticationTag);
    const key = await runtime.subtle.importKey(
      'raw',
      toArrayBuffer(keyBytes),
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    const algorithm = {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad),
      tagLength: 128,
    } satisfies AesGcmParams;

    const sealed = new Uint8Array(
      await runtime.subtle.encrypt(algorithm, key, toArrayBuffer(plaintext)),
    );
    expect(bytesToHex(sealed)).toBe(bytesToHex(expectedSealed));
    expect(
      bytesToHex(
        new Uint8Array(await runtime.subtle.decrypt(algorithm, key, toArrayBuffer(expectedSealed))),
      ),
    ).toBe(bytesToHex(plaintext));

    const alteredAad = aad.slice();
    alteredAad[alteredAad.length - 1] ^= 0x01;
    await expect(
      runtime.subtle.decrypt(
        { ...algorithm, additionalData: toArrayBuffer(alteredAad) },
        key,
        toArrayBuffer(expectedSealed),
      ),
    ).rejects.toThrow();

    const alteredCiphertext = expectedSealed.slice();
    alteredCiphertext[0] ^= 0x01;
    await expect(
      runtime.subtle.decrypt(algorithm, key, toArrayBuffer(alteredCiphertext)),
    ).rejects.toThrow();
  });
});
