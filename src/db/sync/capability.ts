import Dexie, { type EntityTable } from 'dexie';

interface CryptoKeyProbeRecord {
  id: 'crypto-key-probe';
  signingPrivateKey: CryptoKey;
  signingPublicKey: CryptoKey;
  agreementPrivateKey: CryptoKey;
  agreementPublicKey: CryptoKey;
  peerAgreementPrivateKey: CryptoKey;
  peerAgreementPublicKey: CryptoKey;
  localWrappingKey: CryptoKey;
}

class CryptoKeyProbeDatabase extends Dexie {
  keys!: EntityTable<CryptoKeyProbeRecord, 'id'>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({ keys: 'id' });
  }
}

export type IndexedDbCryptoKeyCapability =
  | {
      supported: true;
      signingAfterReopen: true;
      agreementAfterReopen: true;
      encryptionAfterReopen: true;
      privateKeyExportRejected: true;
      localKeyExportRejected: true;
    }
  | {
      supported: false;
      reason:
        | 'web-crypto-unavailable'
        | 'indexed-db-unavailable'
        | 'key-generation-failed'
        | 'crypto-key-persistence-failed'
        | 'persisted-key-operation-failed'
        | 'non-extractability-check-failed';
    };

const probeDatabaseName = (runtime: Crypto): string => {
  const suffix = runtime.getRandomValues(new Uint32Array(4));
  return `mirna-sync-crypto-probe-${Array.from(suffix, (part) => part.toString(16)).join('-')}`;
};

const bytesEqual = (left: ArrayBuffer, right: ArrayBuffer): boolean => {
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
};

const exportMustFail = async (
  subtle: SubtleCrypto,
  format: 'pkcs8' | 'raw',
  key: CryptoKey,
): Promise<boolean> => {
  if (key.extractable) return false;
  try {
    await subtle.exportKey(format, key);
    return false;
  } catch {
    return true;
  }
};

const generateProbeRecord = async (subtle: SubtleCrypto): Promise<CryptoKeyProbeRecord> => {
  const [signing, agreement, peerAgreement, localWrappingKey] = await Promise.all([
    subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']),
    subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
    subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
    subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
  ]);

  return {
    id: 'crypto-key-probe',
    signingPrivateKey: signing.privateKey,
    signingPublicKey: signing.publicKey,
    agreementPrivateKey: agreement.privateKey,
    agreementPublicKey: agreement.publicKey,
    peerAgreementPrivateKey: peerAgreement.privateKey,
    peerAgreementPublicKey: peerAgreement.publicKey,
    localWrappingKey,
  };
};

const verifyPersistedOperations = async (
  record: CryptoKeyProbeRecord,
  runtime: Crypto,
): Promise<boolean> => {
  const message = new TextEncoder().encode('mirna-indexeddb-crypto-key-probe-v1');
  const signature = await runtime.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    record.signingPrivateKey,
    message,
  );
  const signatureValid = await runtime.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    record.signingPublicKey,
    signature,
    message,
  );
  if (!signatureValid) return false;

  const [leftSecret, rightSecret] = await Promise.all([
    runtime.subtle.deriveBits(
      { name: 'ECDH', public: record.peerAgreementPublicKey },
      record.agreementPrivateKey,
      256,
    ),
    runtime.subtle.deriveBits(
      { name: 'ECDH', public: record.agreementPublicKey },
      record.peerAgreementPrivateKey,
      256,
    ),
  ]);
  const agreementValid = bytesEqual(leftSecret, rightSecret);
  new Uint8Array(leftSecret).fill(0);
  new Uint8Array(rightSecret).fill(0);
  if (!agreementValid) return false;

  const nonce = runtime.getRandomValues(new Uint8Array(12));
  const ciphertext = await runtime.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    record.localWrappingKey,
    message,
  );
  const plaintext = await runtime.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    record.localWrappingKey,
    ciphertext,
  );
  const encryptionValid = new TextDecoder().decode(plaintext) === new TextDecoder().decode(message);
  new Uint8Array(plaintext).fill(0);
  nonce.fill(0);
  return encryptionValid;
};

/**
 * Exercises the browser's actual structured-clone path for non-extractable
 * CryptoKeys. A failed probe has no exported-private-key fallback.
 */
export const probeIndexedDbCryptoKeyPersistence =
  async (): Promise<IndexedDbCryptoKeyCapability> => {
    const runtime = globalThis.crypto;
    if (!runtime?.subtle) return { supported: false, reason: 'web-crypto-unavailable' };
    if (typeof globalThis.indexedDB === 'undefined') {
      return { supported: false, reason: 'indexed-db-unavailable' };
    }

    const databaseName = probeDatabaseName(runtime);
    let database: CryptoKeyProbeDatabase | undefined;
    let stage: 'generate' | 'persist' | 'operate' | 'non-extractability' = 'generate';
    try {
      const record = await generateProbeRecord(runtime.subtle);
      stage = 'persist';
      database = new CryptoKeyProbeDatabase(databaseName);
      await database.keys.put(record);
      database.close();

      database = new CryptoKeyProbeDatabase(databaseName);
      const persisted = await database.keys.get('crypto-key-probe');
      if (!persisted) throw new Error('Persisted CryptoKey probe record is missing.');

      stage = 'operate';
      if (!(await verifyPersistedOperations(persisted, runtime))) {
        throw new Error('Persisted CryptoKey operation verification failed.');
      }

      stage = 'non-extractability';
      const [signingRejected, agreementRejected, localRejected] = await Promise.all([
        exportMustFail(runtime.subtle, 'pkcs8', persisted.signingPrivateKey),
        exportMustFail(runtime.subtle, 'pkcs8', persisted.agreementPrivateKey),
        exportMustFail(runtime.subtle, 'raw', persisted.localWrappingKey),
      ]);
      if (!signingRejected || !agreementRejected || !localRejected) {
        throw new Error('A persisted secret key was extractable.');
      }

      return {
        supported: true,
        signingAfterReopen: true,
        agreementAfterReopen: true,
        encryptionAfterReopen: true,
        privateKeyExportRejected: true,
        localKeyExportRejected: true,
      };
    } catch {
      const reason =
        stage === 'generate'
          ? 'key-generation-failed'
          : stage === 'persist'
            ? 'crypto-key-persistence-failed'
            : stage === 'operate'
              ? 'persisted-key-operation-failed'
              : 'non-extractability-check-failed';
      return { supported: false, reason };
    } finally {
      database?.close();
      try {
        await Dexie.delete(databaseName);
      } catch {
        // The probe result remains conservative; no secret key material is returned.
      }
    }
  };
