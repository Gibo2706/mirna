import { importAgreementPublicKey, importSigningPublicKey } from '../../../src/domain/sync/crypto';
import type { DevicePublicKeysV1, PublicEcKeyV1 } from '../../../src/domain/sync/schemas';
import { HttpError } from './errors';

const invalidPublicKey = (): HttpError =>
  new HttpError(400, 'INVALID_PUBLIC_KEY', 'A supplied P-256 public key is invalid.');

export const assertValidSigningPublicKey = async (key: PublicEcKeyV1): Promise<void> => {
  try {
    await importSigningPublicKey(key);
  } catch {
    throw invalidPublicKey();
  }
};

export const assertValidDevicePublicKeys = async (keys: DevicePublicKeysV1): Promise<void> => {
  try {
    await Promise.all([
      importSigningPublicKey(keys.signing),
      importAgreementPublicKey(keys.agreement),
    ]);
  } catch {
    throw invalidPublicKey();
  }
};
