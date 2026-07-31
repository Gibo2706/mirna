import { describe, expect, it } from 'vitest';
import { probeIndexedDbCryptoKeyPersistence } from './capability';

describe('IndexedDB CryptoKey capability probe', () => {
  it('persists non-extractable keys across a real close/reopen cycle without exporting secrets', async () => {
    const result = await probeIndexedDbCryptoKeyPersistence();

    expect(result).toEqual({
      supported: true,
      signingAfterReopen: true,
      agreementAfterReopen: true,
      encryptionAfterReopen: true,
      privateKeyExportRejected: true,
      localKeyExportRejected: true,
    });
  });
});
