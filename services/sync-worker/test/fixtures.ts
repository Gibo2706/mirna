import { bytesToBase64Url } from '../../../src/domain/sync/encoding';
import type { Env } from '../src/env';

export const bytes = (length: number, value: number): Uint8Array =>
  new Uint8Array(length).fill(value);

export const opaqueId = (value: number): string => bytesToBase64Url(bytes(16, value));

export const rawP256PublicKey = (value: number): string => {
  const raw = bytes(65, value);
  raw[0] = 4;
  return bytesToBase64Url(raw);
};

export const SEEDED_VAULT_ID = opaqueId(1);
export const SEEDED_DEVICE_ID = opaqueId(2);
export const SEEDED_RECOVERY_LOOKUP_ID = opaqueId(3);
export const SEEDED_SIGNING_PUBLIC_KEY = rawP256PublicKey(4);
export const SEEDED_AGREEMENT_PUBLIC_KEY = rawP256PublicKey(5);

export const seedVaultAndDevice = async (env: Env, now: number): Promise<void> => {
  await env.MIRNA_SYNC_DB.batch([
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO vaults (
         vault_id, protocol_version, crypto_suite, status, current_key_epoch,
         current_manifest_version, current_snapshot_revision, created_at, updated_at
       ) VALUES (?1, 1, ?2, 'active', 1, 0, 0, ?3, ?3)`,
    ).bind(SEEDED_VAULT_ID, 'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1', now - 10_000),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO devices (
         vault_id, device_id, signing_public_key_raw, agreement_public_key_raw, status,
         added_in_manifest_version, created_at
       ) VALUES (?1, ?2, ?3, ?4, 'active', 1, ?5)`,
    ).bind(
      SEEDED_VAULT_ID,
      SEEDED_DEVICE_ID,
      SEEDED_SIGNING_PUBLIC_KEY,
      SEEDED_AGREEMENT_PUBLIC_KEY,
      now - 9_000,
    ),
  ]);
};
