import {
  SYNC_CRYPTO_SUITE,
  SYNC_DOMAIN_LABELS,
  SYNC_HKDF_LABELS,
  SYNC_LIMITS,
  SYNC_PROTOCOL_VERSION,
} from './constants';
import { canonicalBytes } from './canonical';
import {
  aesGcmNonceSchema,
  encryptedKeyAadSchema,
  encryptedKeyEnvelopeSchema,
  publicEcKeySchema,
  recoveryBundleSchema,
  signatureSchema,
  type EncryptedKeyAadV1,
  type EncryptedKeyEnvelopeV1,
  type PublicEcKeyV1,
  type RecoveryBundleV1,
} from './schemas';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  clearBytes,
  concatBytes,
  decodeCrockfordBase32,
  encodeCrockfordBase32,
  groupCode,
  timingSafeEqual,
  ungroupCode,
  utf8,
} from './encoding';

export interface CryptoRuntime {
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

const currentCrypto = (): CryptoRuntime => {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw new Error('Ovaj pregledač ne podržava bezbednu šifrovanu sinhronizaciju.');
  }
  return globalThis.crypto;
};

const arrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(value.length);
  copy.set(value);
  return copy.buffer;
};

const assertByteLength = (value: Uint8Array, expected: number, label: string): void => {
  if (value.length !== expected) throw new Error(`${label} mora imati ${expected} bajtova.`);
};

const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const P256_HALF_ORDER = P256_ORDER >> 1n;
const DOMAIN_SEPARATOR = Uint8Array.of(0);

const bytesToBigInt = (value: Uint8Array): bigint =>
  value.reduce((result, byte) => (result << 8n) | BigInt(byte), 0n);

const bigIntToFixedBytes = (value: bigint, length: number): Uint8Array => {
  if (value < 0n) throw new Error('Negativna vrednost potpisa nije dozvoljena.');
  const result = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    result[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new Error('Vrednost potpisa je prevelika.');
  return result;
};

export const normalizeP256Signature = (signature: Uint8Array): Uint8Array => {
  assertByteLength(signature, 64, 'P-256 ECDSA potpis');
  const rBytes = signature.slice(0, 32);
  const r = bytesToBigInt(rBytes);
  const s = bytesToBigInt(signature.slice(32));
  if (r <= 0n || r >= P256_ORDER) throw new Error('ECDSA r vrednost je van P-256 opsega.');
  if (s <= 0n || s >= P256_ORDER) throw new Error('ECDSA s vrednost je van P-256 opsega.');
  const normalizedS = s > P256_HALF_ORDER ? P256_ORDER - s : s;
  return concatBytes(rBytes, bigIntToFixedBytes(normalizedS, 32));
};

export const isNormalizedP256Signature = (signature: Uint8Array): boolean => {
  if (signature.length !== 64) return false;
  const r = bytesToBigInt(signature.slice(0, 32));
  const s = bytesToBigInt(signature.slice(32));
  return r > 0n && r < P256_ORDER && s > 0n && s <= P256_HALF_ORDER;
};

export const randomBytes = (
  length: number,
  runtime: CryptoRuntime = currentCrypto(),
): Uint8Array => {
  if (!Number.isSafeInteger(length) || length <= 0 || length > 65_536) {
    throw new Error('Neispravna dužina slučajne vrednosti.');
  }
  return runtime.getRandomValues(new Uint8Array(length));
};

export const createOpaqueId = (runtime: CryptoRuntime = currentCrypto()): string =>
  bytesToBase64Url(randomBytes(SYNC_LIMITS.objectIdBytes, runtime));

export const sha256 = async (
  value: Uint8Array,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<Uint8Array> =>
  new Uint8Array(await runtime.subtle.digest('SHA-256', arrayBuffer(value)));

export const hashCanonical = async (
  value: unknown,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<string> => bytesToBase64Url(await sha256(canonicalBytes(value), runtime));

export const domainSeparatedCanonicalBytes = (label: string, value: unknown): Uint8Array => {
  if (!/^MIRNA-[A-Za-z0-9/-]+$/u.test(label)) {
    throw new Error('Neispravna oznaka domena protokola.');
  }
  return concatBytes(utf8(label), DOMAIN_SEPARATOR, canonicalBytes(value));
};

export const hashDomainSeparatedCanonical = async (
  label: string,
  value: unknown,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<string> =>
  bytesToBase64Url(await sha256(domainSeparatedCanonicalBytes(label, value), runtime));

export interface DeviceKeyPairs {
  signing: CryptoKeyPair;
  agreement: CryptoKeyPair;
}

export const generateDeviceKeyPairs = async (
  runtime: CryptoRuntime = currentCrypto(),
): Promise<DeviceKeyPairs> => {
  const [signing, agreement] = await Promise.all([
    runtime.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']),
    runtime.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
  ]);
  if (
    !('privateKey' in signing) ||
    !('privateKey' in agreement) ||
    signing.privateKey.extractable ||
    agreement.privateKey.extractable
  ) {
    throw new Error('Pregledač nije napravio neizvozive privatne ključeve.');
  }
  return { signing, agreement };
};

export const generateEphemeralAgreementKeyPair = async (
  runtime: CryptoRuntime = currentCrypto(),
): Promise<CryptoKeyPair> => {
  const pair = await runtime.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ]);
  if (!('privateKey' in pair) || pair.privateKey.extractable) {
    throw new Error('Pregledač nije napravio bezbedan privremeni ključ.');
  }
  return pair;
};

export const exportPublicEcKey = async (
  key: CryptoKey,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<PublicEcKeyV1> => {
  if (key.type !== 'public') throw new Error('Očekivan je javni ključ.');
  const raw = new Uint8Array(await runtime.subtle.exportKey('raw', key));
  if (raw.length !== 65 || raw[0] !== 4) {
    throw new Error('P-256 javni ključ nema kanonski nekomprimovani SEC1 oblik.');
  }
  return publicEcKeySchema.parse({ format: 'raw-p256', value: bytesToBase64Url(raw) });
};

export const importSigningPublicKey = async (
  value: PublicEcKeyV1,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<CryptoKey> => {
  const parsed = publicEcKeySchema.parse(value);
  return runtime.subtle.importKey(
    'raw',
    arrayBuffer(base64UrlToBytes(parsed.value)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
};

export const importAgreementPublicKey = async (
  value: PublicEcKeyV1,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<CryptoKey> => {
  const parsed = publicEcKeySchema.parse(value);
  return runtime.subtle.importKey(
    'raw',
    arrayBuffer(base64UrlToBytes(parsed.value)),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
};

export const signCanonical = async (
  value: unknown,
  privateKey: CryptoKey,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<string> => {
  if (privateKey.type !== 'private' || privateKey.algorithm.name !== 'ECDSA') {
    throw new Error('Potpis zahteva ECDSA privatni ključ.');
  }
  const signature = normalizeP256Signature(
    new Uint8Array(
      await runtime.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        arrayBuffer(canonicalBytes(value)),
      ),
    ),
  );
  return signatureSchema.parse(bytesToBase64Url(signature));
};

export const verifyCanonicalSignature = async (
  value: unknown,
  signature: string,
  publicKey: CryptoKey,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<boolean> => {
  const parsedSignature = signatureSchema.parse(signature);
  if (publicKey.type !== 'public' || publicKey.algorithm.name !== 'ECDSA') return false;
  const signatureBytes = base64UrlToBytes(parsedSignature);
  if (!isNormalizedP256Signature(signatureBytes)) return false;
  return runtime.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    arrayBuffer(signatureBytes),
    arrayBuffer(canonicalBytes(value)),
  );
};

export const signDomainSeparatedCanonical = async (
  label: string,
  value: unknown,
  privateKey: CryptoKey,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<string> => {
  if (privateKey.type !== 'private' || privateKey.algorithm.name !== 'ECDSA') {
    throw new Error('Potpis zahteva ECDSA privatni ključ.');
  }
  const signature = normalizeP256Signature(
    new Uint8Array(
      await runtime.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        arrayBuffer(domainSeparatedCanonicalBytes(label, value)),
      ),
    ),
  );
  return signatureSchema.parse(bytesToBase64Url(signature));
};

export const verifyDomainSeparatedCanonicalSignature = async (
  label: string,
  value: unknown,
  signature: string,
  publicKey: CryptoKey,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<boolean> => {
  const parsedSignature = signatureSchema.parse(signature);
  if (publicKey.type !== 'public' || publicKey.algorithm.name !== 'ECDSA') return false;
  const signatureBytes = base64UrlToBytes(parsedSignature);
  if (!isNormalizedP256Signature(signatureBytes)) return false;
  return runtime.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    arrayBuffer(signatureBytes),
    arrayBuffer(domainSeparatedCanonicalBytes(label, value)),
  );
};

const importHkdfMaterial = (raw: Uint8Array, runtime: CryptoRuntime): Promise<CryptoKey> =>
  runtime.subtle.importKey('raw', arrayBuffer(raw), 'HKDF', false, ['deriveBits', 'deriveKey']);

const deriveHkdfAesKey = async (
  material: CryptoKey,
  salt: Uint8Array,
  info: Uint8Array,
  runtime: CryptoRuntime,
): Promise<CryptoKey> =>
  runtime.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: arrayBuffer(salt),
      info: arrayBuffer(info),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

const objectKeyContext = (input: {
  vaultId: string;
  keyEpoch: number;
  objectType: string;
  objectId: string;
  purpose: 'snapshot' | 'operation';
}) => ({
  protocolVersion: SYNC_PROTOCOL_VERSION,
  suite: SYNC_CRYPTO_SUITE,
  vaultId: input.vaultId,
  keyEpoch: input.keyEpoch,
  objectType: input.objectType,
  objectId: input.objectId,
  purpose: input.purpose,
});

export const deriveObjectEncryptionKey = async (
  vaultMasterKey: Uint8Array,
  input: {
    vaultId: string;
    keyEpoch: number;
    objectType: string;
    objectId: string;
    purpose: 'snapshot' | 'operation';
  },
  runtime: CryptoRuntime = currentCrypto(),
): Promise<CryptoKey> => {
  assertByteLength(vaultMasterKey, SYNC_LIMITS.vaultMasterKeyBytes, 'Glavni ključ trezora');
  const context = objectKeyContext(input);
  const salt = await sha256(
    domainSeparatedCanonicalBytes(SYNC_DOMAIN_LABELS.objectSalt, {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: input.vaultId,
      keyEpoch: input.keyEpoch,
    }),
    runtime,
  );
  const material = await importHkdfMaterial(vaultMasterKey, runtime);
  return deriveHkdfAesKey(
    material,
    salt,
    concatBytes(utf8(SYNC_HKDF_LABELS[input.purpose]), DOMAIN_SEPARATOR, canonicalBytes(context)),
    runtime,
  );
};

export const encryptAesGcm = async (
  plaintext: Uint8Array,
  key: CryptoKey,
  nonce: Uint8Array,
  aad: unknown,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<Uint8Array> => {
  assertAes256GcmKey(key, 'encrypt');
  assertByteLength(nonce, SYNC_LIMITS.aesGcmNonceBytes, 'AES-GCM nonce');
  return new Uint8Array(
    await runtime.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: arrayBuffer(nonce),
        additionalData: arrayBuffer(canonicalBytes(aad)),
        tagLength: 128,
      },
      key,
      arrayBuffer(plaintext),
    ),
  );
};

export const decryptAesGcm = async (
  ciphertext: Uint8Array,
  key: CryptoKey,
  nonce: Uint8Array,
  aad: unknown,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<Uint8Array> => {
  assertAes256GcmKey(key, 'decrypt');
  assertByteLength(nonce, SYNC_LIMITS.aesGcmNonceBytes, 'AES-GCM nonce');
  return new Uint8Array(
    await runtime.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: arrayBuffer(nonce),
        additionalData: arrayBuffer(canonicalBytes(aad)),
        tagLength: 128,
      },
      key,
      arrayBuffer(ciphertext),
    ),
  );
};

const assertAes256GcmKey = (key: CryptoKey, usage: 'encrypt' | 'decrypt'): void => {
  const algorithm = key.algorithm;
  if (
    key.type !== 'secret' ||
    algorithm.name !== 'AES-GCM' ||
    !('length' in algorithm) ||
    algorithm.length !== 256 ||
    !key.usages.includes(usage)
  ) {
    throw new Error(`Operacija zahteva AES-256-GCM ključ sa ${usage} namenom.`);
  }
};

export const generateLocalWrappingKey = async (
  runtime: CryptoRuntime = currentCrypto(),
): Promise<CryptoKey> => {
  const key = await runtime.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  if (key.extractable) throw new Error('Lokalni ključ za čuvanje mora biti neizvoziv.');
  return key;
};

export const createEncryptedKeyEnvelope = async (
  rawVaultMasterKey: Uint8Array,
  key: CryptoKey,
  aad: EncryptedKeyAadV1,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<EncryptedKeyEnvelopeV1> => {
  assertByteLength(rawVaultMasterKey, SYNC_LIMITS.vaultMasterKeyBytes, 'Glavni ključ trezora');
  return createEncryptedPayloadEnvelope(rawVaultMasterKey, key, aad, runtime);
};

const createEncryptedPayloadEnvelope = async (
  plaintext: Uint8Array,
  key: CryptoKey,
  aad: EncryptedKeyAadV1,
  runtime: CryptoRuntime,
): Promise<EncryptedKeyEnvelopeV1> => {
  const parsedAad = encryptedKeyAadSchema.parse(aad);
  const nonce = randomBytes(SYNC_LIMITS.aesGcmNonceBytes, runtime);
  const ciphertext = await encryptAesGcm(plaintext, key, nonce, parsedAad, runtime);
  return encryptedKeyEnvelopeSchema.parse({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    vaultId: parsedAad.vaultId,
    keyEpoch: parsedAad.keyEpoch,
    objectId: parsedAad.objectId,
    nonce: bytesToBase64Url(nonce),
    aad: parsedAad,
    ciphertext: bytesToBase64Url(ciphertext),
  });
};

export const openEncryptedKeyEnvelope = async (
  envelope: EncryptedKeyEnvelopeV1,
  key: CryptoKey,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<Uint8Array> => {
  const plaintext = await openEncryptedPayloadEnvelope(envelope, key, runtime);
  assertByteLength(plaintext, SYNC_LIMITS.vaultMasterKeyBytes, 'Dešifrovani ključ trezora');
  return plaintext;
};

const openEncryptedPayloadEnvelope = async (
  envelope: EncryptedKeyEnvelopeV1,
  key: CryptoKey,
  runtime: CryptoRuntime,
): Promise<Uint8Array> => {
  const parsed = encryptedKeyEnvelopeSchema.parse(envelope);
  if (
    parsed.vaultId !== parsed.aad.vaultId ||
    parsed.keyEpoch !== parsed.aad.keyEpoch ||
    parsed.objectId !== parsed.aad.objectId
  ) {
    throw new Error('Omot ključa i njegov AAD nisu usaglašeni.');
  }
  const nonce = base64UrlToBytes(aesGcmNonceSchema.parse(parsed.nonce));
  return decryptAesGcm(base64UrlToBytes(parsed.ciphertext), key, nonce, parsed.aad, runtime);
};

export const derivePairingWrappingKey = async (
  ownPrivateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  pairingSalt: Uint8Array,
  context: unknown,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<CryptoKey> =>
  (await derivePairingAgreementKeys(ownPrivateKey, peerPublicKey, pairingSalt, context, runtime))
    .wrappingKey;

export interface PairingAgreementKeys {
  wrappingKey: CryptoKey;
  confirmationKey: CryptoKey;
}

export async function derivePairingAgreementKeys(
  ownPrivateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  pairingSalt: Uint8Array,
  context: unknown,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<PairingAgreementKeys> {
  if (ownPrivateKey.type !== 'private' || ownPrivateKey.algorithm.name !== 'ECDH') {
    throw new Error('Uparivanje zahteva privatni ECDH ključ.');
  }
  if (peerPublicKey.type !== 'public' || peerPublicKey.algorithm.name !== 'ECDH') {
    throw new Error('Uparivanje zahteva javni ECDH ključ druge strane.');
  }
  assertByteLength(pairingSalt, SYNC_LIMITS.pairingSaltBytes, 'Pairing salt');
  const shared = new Uint8Array(
    await runtime.subtle.deriveBits({ name: 'ECDH', public: peerPublicKey }, ownPrivateKey, 256),
  );
  try {
    const material = await importHkdfMaterial(shared, runtime);
    const contextHash = await sha256(
      domainSeparatedCanonicalBytes(SYNC_DOMAIN_LABELS.pairingContext, context),
      runtime,
    );
    const [wrappingKey, confirmationKey] = await Promise.all([
      deriveHkdfAesKey(
        material,
        pairingSalt,
        concatBytes(utf8(SYNC_HKDF_LABELS.pairingWrapping), DOMAIN_SEPARATOR, contextHash),
        runtime,
      ),
      runtime.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: arrayBuffer(pairingSalt),
          info: arrayBuffer(
            concatBytes(utf8(SYNC_HKDF_LABELS.pairingConfirmation), DOMAIN_SEPARATOR, contextHash),
          ),
        },
        material,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign', 'verify'],
      ),
    ]);
    return { wrappingKey, confirmationKey };
  } finally {
    clearBytes(shared);
  }
}

export const createPairingKeyConfirmation = async (
  transcript: unknown,
  confirmationKey: CryptoKey,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<string> => {
  if (confirmationKey.type !== 'secret' || confirmationKey.algorithm.name !== 'HMAC') {
    throw new Error('Pairing potvrda zahteva HMAC ključ izveden ECDH razmenom.');
  }
  return bytesToBase64Url(
    new Uint8Array(
      await runtime.subtle.sign(
        'HMAC',
        confirmationKey,
        arrayBuffer(
          domainSeparatedCanonicalBytes(SYNC_DOMAIN_LABELS.pairingConfirmation, transcript),
        ),
      ),
    ),
  );
};

export const verifyPairingKeyConfirmation = async (
  transcript: unknown,
  confirmation: string,
  confirmationKey: CryptoKey,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<boolean> => {
  if (confirmationKey.type !== 'secret' || confirmationKey.algorithm.name !== 'HMAC') {
    return false;
  }
  const confirmationBytes = base64UrlToBytes(confirmation);
  assertByteLength(confirmationBytes, 32, 'Pairing key confirmation');
  return runtime.subtle.verify(
    'HMAC',
    confirmationKey,
    arrayBuffer(confirmationBytes),
    arrayBuffer(domainSeparatedCanonicalBytes(SYNC_DOMAIN_LABELS.pairingConfirmation, transcript)),
  );
};

export interface PairingSecrets {
  claimToken: Uint8Array;
  transcriptMacKey: Uint8Array;
  sasKey: Uint8Array;
}

const deriveHkdfBits = async (
  material: CryptoKey,
  salt: Uint8Array,
  info: Uint8Array,
  runtime: CryptoRuntime,
): Promise<Uint8Array> =>
  new Uint8Array(
    await runtime.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: arrayBuffer(salt),
        info: arrayBuffer(info),
      },
      material,
      256,
    ),
  );

export const derivePairingSecrets = async (
  pairingRootSecret: Uint8Array,
  context: { pairingRequestId: string; pairingSalt: string; origin: string },
  runtime: CryptoRuntime = currentCrypto(),
): Promise<PairingSecrets> => {
  assertByteLength(pairingRootSecret, SYNC_LIMITS.pairingSecretBytes, 'Tajna za uparivanje');
  const pairingSalt = base64UrlToBytes(context.pairingSalt);
  assertByteLength(pairingSalt, SYNC_LIMITS.pairingSaltBytes, 'Pairing salt');
  const origin = new URL(context.origin);
  if (
    origin.origin !== context.origin ||
    (origin.protocol !== 'https:' && origin.hostname !== 'localhost')
  ) {
    throw new Error('Pairing kontekst zahteva tačan HTTPS origin.');
  }
  const material = await importHkdfMaterial(pairingRootSecret, runtime);
  const baseContext = canonicalBytes({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    origin: context.origin,
    pairingRequestId: context.pairingRequestId,
    pairingSalt: context.pairingSalt,
  });
  const [claimToken, transcriptMacKey, sasKey] = await Promise.all([
    deriveHkdfBits(
      material,
      pairingSalt,
      concatBytes(utf8(SYNC_HKDF_LABELS.pairingClaim), DOMAIN_SEPARATOR, baseContext),
      runtime,
    ),
    deriveHkdfBits(
      material,
      pairingSalt,
      concatBytes(utf8(SYNC_HKDF_LABELS.pairingTranscriptMac), DOMAIN_SEPARATOR, baseContext),
      runtime,
    ),
    deriveHkdfBits(
      material,
      pairingSalt,
      concatBytes(utf8(SYNC_HKDF_LABELS.pairingSas), DOMAIN_SEPARATOR, baseContext),
      runtime,
    ),
  ]);
  return { claimToken, transcriptMacKey, sasKey };
};

const hmacSha256 = async (
  rawKey: Uint8Array,
  usage: 'sign' | 'verify',
  runtime: CryptoRuntime,
): Promise<CryptoKey> =>
  runtime.subtle.importKey('raw', arrayBuffer(rawKey), { name: 'HMAC', hash: 'SHA-256' }, false, [
    usage,
  ]);

export const createPairingTranscriptMac = async (
  transcript: unknown,
  transcriptMacKey: Uint8Array,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<string> => {
  assertByteLength(transcriptMacKey, 32, 'Pairing transcript MAC ključ');
  const key = await hmacSha256(transcriptMacKey, 'sign', runtime);
  return bytesToBase64Url(
    new Uint8Array(
      await runtime.subtle.sign(
        'HMAC',
        key,
        arrayBuffer(
          domainSeparatedCanonicalBytes(SYNC_DOMAIN_LABELS.pairingTranscriptMac, transcript),
        ),
      ),
    ),
  );
};

export const verifyPairingTranscriptMac = async (
  transcript: unknown,
  mac: string,
  transcriptMacKey: Uint8Array,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<boolean> => {
  assertByteLength(transcriptMacKey, 32, 'Pairing transcript MAC ključ');
  const key = await hmacSha256(transcriptMacKey, 'verify', runtime);
  return runtime.subtle.verify(
    'HMAC',
    key,
    arrayBuffer(base64UrlToBytes(mac)),
    arrayBuffer(domainSeparatedCanonicalBytes(SYNC_DOMAIN_LABELS.pairingTranscriptMac, transcript)),
  );
};

export interface RecoveryKeys {
  wrappingKey: CryptoKey;
  gateKey: Uint8Array;
}

export const deriveRecoveryKeys = async (
  recoveryRoot: Uint8Array,
  context: { vaultId: string; recoveryLookupId: string },
  runtime: CryptoRuntime = currentCrypto(),
): Promise<RecoveryKeys> => {
  assertByteLength(recoveryRoot, SYNC_LIMITS.recoveryRootBytes, 'Recovery tajna');
  const lookupId = base64UrlToBytes(context.recoveryLookupId);
  assertByteLength(lookupId, SYNC_LIMITS.recoveryLookupIdBytes, 'Recovery lookup ID');
  const material = await importHkdfMaterial(recoveryRoot, runtime);
  const salt = await sha256(
    concatBytes(utf8('MIRNA-E2EE-V1/recovery-salt'), Uint8Array.of(0), lookupId),
    runtime,
  );
  const recoveryContext = canonicalBytes({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    vaultId: context.vaultId,
    recoveryLookupId: context.recoveryLookupId,
  });
  const wrappingKey = await deriveHkdfAesKey(
    material,
    salt,
    concatBytes(utf8(SYNC_HKDF_LABELS.recoveryWrapping), Uint8Array.of(0), recoveryContext),
    runtime,
  );
  const gateKey = new Uint8Array(
    await runtime.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: arrayBuffer(salt),
        info: arrayBuffer(
          concatBytes(
            utf8(SYNC_HKDF_LABELS.recoveryAuthentication),
            Uint8Array.of(0),
            recoveryContext,
          ),
        ),
      },
      material,
      256,
    ),
  );
  return { wrappingKey, gateKey };
};

export const generateRecoverySigningKeyPair = async (
  runtime: CryptoRuntime = currentCrypto(),
): Promise<CryptoKeyPair> => {
  const pair = await runtime.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  if (!('privateKey' in pair)) throw new Error('Recovery potpisni ključ nije napravljen.');
  return pair;
};

export const exportRecoverySigningPrivateKey = async (
  privateKey: CryptoKey,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<string> => {
  if (privateKey.type !== 'private' || privateKey.algorithm.name !== 'ECDSA') {
    throw new Error('Očekivan je recovery ECDSA privatni ključ.');
  }
  return bytesToBase64Url(new Uint8Array(await runtime.subtle.exportKey('pkcs8', privateKey)));
};

export const importRecoverySigningPrivateKey = async (
  encoded: string,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<CryptoKey> =>
  runtime.subtle.importKey(
    'pkcs8',
    arrayBuffer(base64UrlToBytes(encoded)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

export const createEncryptedRecoveryBundleEnvelope = async (
  bundle: RecoveryBundleV1,
  wrappingKey: CryptoKey,
  aad: EncryptedKeyAadV1,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<EncryptedKeyEnvelopeV1> => {
  const parsedBundle = recoveryBundleSchema.parse(bundle);
  const { signature: _signature, ...manifestBody } = parsedBundle.pinnedManifest;
  void _signature;
  const actualManifestHash = await hashDomainSeparatedCanonical(
    SYNC_DOMAIN_LABELS.manifestBody,
    manifestBody,
    runtime,
  );
  if (
    parsedBundle.pinnedManifestHash !== actualManifestHash ||
    parsedBundle.vaultId !== parsedBundle.pinnedManifest.vaultId ||
    parsedBundle.recoveryLookupId !== parsedBundle.pinnedManifest.recoveryLookupId ||
    parsedBundle.keyEpoch !== parsedBundle.pinnedManifest.keyEpoch ||
    !timingSafeEqual(
      canonicalBytes(parsedBundle.recoverySigningPublicKey),
      canonicalBytes(parsedBundle.pinnedManifest.recoverySigningPublicKey),
    ) ||
    aad.objectType !== 'recovery-vault-key' ||
    aad.vaultId !== parsedBundle.vaultId ||
    aad.recoveryLookupId !== parsedBundle.recoveryLookupId ||
    aad.keyEpoch !== parsedBundle.keyEpoch ||
    aad.parentManifestHash !== parsedBundle.pinnedManifestHash
  ) {
    throw new Error('Recovery paket nije vezan za očekivani manifest i epohu.');
  }
  const plaintext = canonicalBytes(parsedBundle);
  try {
    return await createEncryptedPayloadEnvelope(plaintext, wrappingKey, aad, runtime);
  } finally {
    clearBytes(plaintext);
  }
};

export const openEncryptedRecoveryBundleEnvelope = async (
  envelope: EncryptedKeyEnvelopeV1,
  wrappingKey: CryptoKey,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<RecoveryBundleV1> => {
  if (envelope.aad.objectType !== 'recovery-vault-key') {
    throw new Error('Omot nije recovery paket.');
  }
  const plaintext = await openEncryptedPayloadEnvelope(envelope, wrappingKey, runtime);
  let bundle: RecoveryBundleV1;
  try {
    const decoded: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
    );
    bundle = recoveryBundleSchema.parse(decoded);
    if (!timingSafeEqual(plaintext, canonicalBytes(bundle))) {
      throw new Error('Recovery paket nije prenet u kanonskom JSON obliku.');
    }
  } catch {
    throw new Error('Recovery paket nije validan kanonski JSON.');
  } finally {
    clearBytes(plaintext);
  }
  const { signature: _signature, ...manifestBody } = bundle.pinnedManifest;
  void _signature;
  const actualManifestHash = await hashDomainSeparatedCanonical(
    SYNC_DOMAIN_LABELS.manifestBody,
    manifestBody,
    runtime,
  );
  if (
    bundle.pinnedManifestHash !== actualManifestHash ||
    bundle.vaultId !== bundle.pinnedManifest.vaultId ||
    bundle.recoveryLookupId !== bundle.pinnedManifest.recoveryLookupId ||
    bundle.keyEpoch !== bundle.pinnedManifest.keyEpoch ||
    !timingSafeEqual(
      canonicalBytes(bundle.recoverySigningPublicKey),
      canonicalBytes(bundle.pinnedManifest.recoverySigningPublicKey),
    ) ||
    bundle.vaultId !== envelope.vaultId ||
    bundle.recoveryLookupId !== envelope.aad.recoveryLookupId ||
    bundle.keyEpoch !== envelope.keyEpoch ||
    bundle.pinnedManifestHash !== envelope.aad.parentManifestHash
  ) {
    throw new Error('Recovery paket ne pripada očekivanom trezoru ili manifestu.');
  }
  return bundle;
};

export const createRecoveryProof = async (
  transcript: unknown,
  gateKey: Uint8Array,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<string> => {
  assertByteLength(gateKey, 32, 'Recovery gate ključ');
  const key = await runtime.subtle.importKey(
    'raw',
    arrayBuffer(gateKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToBase64Url(
    new Uint8Array(
      await runtime.subtle.sign(
        'HMAC',
        key,
        arrayBuffer(domainSeparatedCanonicalBytes(SYNC_DOMAIN_LABELS.recoveryProof, transcript)),
      ),
    ),
  );
};

export const verifyRecoveryProof = async (
  transcript: unknown,
  proof: string,
  gateKey: Uint8Array,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<boolean> => {
  assertByteLength(gateKey, 32, 'Recovery gate ključ');
  const key = await runtime.subtle.importKey(
    'raw',
    arrayBuffer(gateKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return runtime.subtle.verify(
    'HMAC',
    key,
    arrayBuffer(base64UrlToBytes(proof)),
    arrayBuffer(domainSeparatedCanonicalBytes(SYNC_DOMAIN_LABELS.recoveryProof, transcript)),
  );
};

export const hashPairingClaimToken = async (
  claimToken: Uint8Array,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<string> => {
  assertByteLength(claimToken, 32, 'Pairing claim token');
  return bytesToBase64Url(
    await sha256(
      concatBytes(utf8(SYNC_DOMAIN_LABELS.pairingClaimHash), DOMAIN_SEPARATOR, claimToken),
      runtime,
    ),
  );
};

export const hashRecoveryGateKey = async (
  gateKey: Uint8Array,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<string> => {
  assertByteLength(gateKey, 32, 'Recovery gate ključ');
  return bytesToBase64Url(
    await sha256(
      concatBytes(utf8(SYNC_DOMAIN_LABELS.recoveryGateHash), DOMAIN_SEPARATOR, gateKey),
      runtime,
    ),
  );
};

const RECOVERY_PREFIX = 'MR1-';
const PAIRING_PREFIX = 'MIRNA-P1-';

const checksum = async (
  value: Uint8Array,
  length: number,
  runtime: CryptoRuntime,
): Promise<Uint8Array> => (await sha256(value, runtime)).slice(0, length);

export const createRecoveryCode = async (
  recoveryLookupId: string,
  recoveryRoot: Uint8Array,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<string> => {
  const lookupIdBytes = base64UrlToBytes(recoveryLookupId);
  assertByteLength(lookupIdBytes, SYNC_LIMITS.recoveryLookupIdBytes, 'Recovery lookup ID');
  assertByteLength(recoveryRoot, SYNC_LIMITS.recoveryRootBytes, 'Recovery tajna');
  const payload = concatBytes(lookupIdBytes, recoveryRoot);
  const recoveryChecksum = await checksum(
    concatBytes(utf8(SYNC_DOMAIN_LABELS.recoveryCode), DOMAIN_SEPARATOR, payload),
    4,
    runtime,
  );
  const encoded = encodeCrockfordBase32(concatBytes(payload, recoveryChecksum));
  return `${RECOVERY_PREFIX}${groupCode(encoded, 4)}`;
};

export const parseRecoveryCode = async (
  value: string,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<{ recoveryLookupId: string; recoveryRoot: Uint8Array }> => {
  const normalized = value.trim().toUpperCase();
  if (!normalized.startsWith(RECOVERY_PREFIX))
    throw new Error('Recovery kod ima pogrešan prefiks.');
  const decoded = decodeCrockfordBase32(ungroupCode(normalized.slice(RECOVERY_PREFIX.length)));
  assertByteLength(decoded, 52, 'Recovery kod');
  const payload = decoded.slice(0, 48);
  const suppliedChecksum = decoded.slice(48);
  const expectedChecksum = await checksum(
    concatBytes(utf8(SYNC_DOMAIN_LABELS.recoveryCode), DOMAIN_SEPARATOR, payload),
    4,
    runtime,
  );
  if (!timingSafeEqual(suppliedChecksum, expectedChecksum)) {
    throw new Error('Recovery kod ima neispravnu kontrolnu sumu.');
  }
  return {
    recoveryLookupId: bytesToBase64Url(payload.slice(0, 16)),
    recoveryRoot: payload.slice(16),
  };
};

export const createPairingCode = async (
  pairingRequestId: string,
  pairingSecret: Uint8Array,
  pairingSalt: Uint8Array,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<string> => {
  const requestBytes = base64UrlToBytes(pairingRequestId);
  assertByteLength(requestBytes, SYNC_LIMITS.objectIdBytes, 'ID zahteva za uparivanje');
  assertByteLength(pairingSecret, SYNC_LIMITS.pairingSecretBytes, 'Tajna za uparivanje');
  assertByteLength(pairingSalt, SYNC_LIMITS.pairingSaltBytes, 'Pairing salt');
  const payload = concatBytes(
    Uint8Array.of(SYNC_PROTOCOL_VERSION),
    requestBytes,
    pairingSecret,
    pairingSalt,
  );
  const pairingChecksumInput = concatBytes(
    utf8(SYNC_DOMAIN_LABELS.pairingCode),
    DOMAIN_SEPARATOR,
    payload,
  );
  const encoded = encodeCrockfordBase32(
    concatBytes(payload, await checksum(pairingChecksumInput, 4, runtime)),
  );
  return `${PAIRING_PREFIX}${groupCode(encoded)}`;
};

export const parsePairingCode = async (
  value: string,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<{ pairingRequestId: string; pairingSecret: Uint8Array; pairingSalt: Uint8Array }> => {
  const normalized = value.trim().toUpperCase();
  if (!normalized.startsWith(PAIRING_PREFIX))
    throw new Error('Kod za uparivanje ima pogrešan prefiks.');
  const decoded = decodeCrockfordBase32(ungroupCode(normalized.slice(PAIRING_PREFIX.length)));
  assertByteLength(decoded, 85, 'Kod za uparivanje');
  const payload = decoded.slice(0, 81);
  const pairingChecksumInput = concatBytes(
    utf8(SYNC_DOMAIN_LABELS.pairingCode),
    DOMAIN_SEPARATOR,
    payload,
  );
  if (!timingSafeEqual(decoded.slice(81), await checksum(pairingChecksumInput, 4, runtime))) {
    throw new Error('Kod za uparivanje ima neispravnu kontrolnu sumu.');
  }
  if (payload[0] !== SYNC_PROTOCOL_VERSION) {
    throw new Error('Kod za uparivanje koristi nepoznatu verziju.');
  }
  return {
    pairingRequestId: bytesToBase64Url(payload.slice(1, 17)),
    pairingSecret: payload.slice(17, 49),
    pairingSalt: payload.slice(49),
  };
};

export const createPairingQrPayload = (mirnaOrigin: string, pairingCode: string): string => {
  const origin = new URL(mirnaOrigin);
  if (origin.protocol !== 'https:' && origin.hostname !== 'localhost') {
    throw new Error('QR uparivanje zahteva HTTPS Mirna origin.');
  }
  origin.pathname = '/more/sync';
  origin.search = '';
  origin.hash = new URLSearchParams({
    protocol: String(SYNC_PROTOCOL_VERSION),
    suite: SYNC_CRYPTO_SUITE,
    pair: pairingCode,
  }).toString();
  return origin.toString();
};

export const parsePairingQrPayload = (value: string, expectedMirnaOrigin: string): string => {
  const parsed = new URL(value);
  const expected = new URL(expectedMirnaOrigin);
  if (parsed.origin !== expected.origin || parsed.pathname !== '/more/sync') {
    throw new Error('QR kod nije namenjen očekivanom Mirna originu.');
  }
  const parameters = new URLSearchParams(parsed.hash.slice(1));
  if (
    parameters.get('protocol') !== String(SYNC_PROTOCOL_VERSION) ||
    parameters.get('suite') !== SYNC_CRYPTO_SUITE
  ) {
    throw new Error('QR kod koristi nepodržanu sync verziju ili crypto suite.');
  }
  const code = parameters.get('pair');
  if (!code) throw new Error('QR kod ne sadrži zahtev za uparivanje.');
  return code;
};

export const deriveShortAuthenticationString = async (
  transcript: unknown,
  pairingMac: string,
  sasKey: Uint8Array,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<string> => {
  assertByteLength(sasKey, 32, 'Pairing SAS ključ');
  const key = await hmacSha256(sasKey, 'sign', runtime);
  const digest = new Uint8Array(
    await runtime.subtle.sign(
      'HMAC',
      key,
      arrayBuffer(
        concatBytes(
          utf8(SYNC_DOMAIN_LABELS.pairingSas),
          DOMAIN_SEPARATOR,
          await sha256(canonicalBytes(transcript), runtime),
          base64UrlToBytes(pairingMac),
        ),
      ),
    ),
  );
  return bytesToHex(digest.slice(0, 8)).toUpperCase().match(/.{4}/gu)?.join('-') ?? '';
};

export const describeKeyFingerprint = async (
  key: PublicEcKeyV1,
  runtime: CryptoRuntime = currentCrypto(),
): Promise<string> => {
  const digest = await sha256(canonicalBytes(publicEcKeySchema.parse(key)), runtime);
  return bytesToHex(digest.slice(0, 8)).match(/.{4}/gu)?.join(' ') ?? '';
};
