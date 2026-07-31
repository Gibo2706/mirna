import { SYNC_CRYPTO_SUITE, SYNC_DOMAIN_LABELS } from '../../../src/domain/sync/constants';
import {
  importSigningPublicKey,
  verifyDomainSeparatedCanonicalSignature,
} from '../../../src/domain/sync/crypto';
import { base64UrlToBytes } from '../../../src/domain/sync/encoding';
import {
  authChallengeRequestSchema,
  authChallengeSchema,
  authSessionRequestSchema,
  authSessionResponseSchema,
  vaultManifestSchema,
  type AuthChallengeV1,
} from '../../../src/domain/sync/schemas';
import type { RequestContext } from './context';
import { forbidden, HttpError, unauthorized } from './errors';
import { jsonResponse } from './http';
import { readWorkerLimits } from './limits';
import {
  domainHashBytes,
  hashEncodedSecret,
  isoTimestamp,
  randomOpaqueId,
  randomSecret,
  toDatabaseBlob,
} from './server-crypto';
import { readCanonicalJson } from './validation';

interface AuthorizedDeviceRow {
  signing_public_key_raw: string;
  agreement_public_key_raw: string;
  authorization_expires_at: number;
  canonical_manifest: string;
}

interface StoredChallengeRow extends AuthorizedDeviceRow {
  vault_id: string;
  device_id: string;
  audience: AuthChallengeV1['audience'];
  origin: string;
  created_at: number;
  expires_at: number;
}

export interface AuthenticatedDevice {
  vaultId: string;
  deviceId: string;
  signingPublicKeyRaw: string;
  authorizationExpiresAt: number;
  sessionExpiresAt: number;
}

const findAuthorizedDevice = (
  database: D1Database,
  vaultId: string,
  deviceId: string,
  now: number,
): Promise<AuthorizedDeviceRow | null> =>
  database
    .prepare(
      `SELECT d.signing_public_key_raw, d.agreement_public_key_raw,
              g.expires_at AS authorization_expires_at, m.canonical_manifest
         FROM devices d
         JOIN vaults v
           ON v.vault_id = d.vault_id
          AND v.status = 'active'
         JOIN device_grants g
          ON g.vault_id = d.vault_id
          AND g.device_id = d.device_id
         JOIN vault_manifests m
           ON m.vault_id = v.vault_id
          AND m.manifest_version = v.current_manifest_version
        WHERE d.vault_id = ?1
          AND d.device_id = ?2
          AND d.status = 'active'
          AND d.revoked_at IS NULL
          AND g.revoked_at IS NULL
          AND g.expires_at > ?3
        ORDER BY g.grant_version DESC
        LIMIT 1`,
    )
    .bind(vaultId, deviceId, now)
    .first<AuthorizedDeviceRow>();

const hasCurrentManifestMembership = (
  row: AuthorizedDeviceRow,
  deviceId: string,
  now: number,
): boolean => {
  try {
    const manifest = vaultManifestSchema.parse(JSON.parse(row.canonical_manifest));
    const member = manifest.devices.find((device) => device.deviceId === deviceId);
    return (
      member?.publicKeys.signing.value === row.signing_public_key_raw &&
      member.publicKeys.agreement.value === row.agreement_public_key_raw &&
      Date.parse(member.authorizationExpiresAt) === row.authorization_expires_at &&
      row.authorization_expires_at > now
    );
  } catch {
    return false;
  }
};

export const handleAuthChallenge = async (context: RequestContext): Promise<Response> => {
  const input = await readCanonicalJson(context.request, authChallengeRequestSchema);
  if (context.allowedOrigin === null || input.origin !== context.allowedOrigin) {
    throw forbidden('ORIGIN_MISMATCH', 'Challenge origin does not match the request origin.');
  }

  const now = Date.now();
  const device = await findAuthorizedDevice(
    context.env.MIRNA_SYNC_DB,
    input.vaultId,
    input.deviceId,
    now,
  );
  if (!device || !hasCurrentManifestMembership(device, input.deviceId, now)) {
    throw forbidden(
      'DEVICE_AUTHORIZATION_REQUIRED',
      'Device authorization is missing, expired or revoked.',
    );
  }

  const challengeId = randomOpaqueId();
  const challenge = randomSecret();
  const limits = readWorkerLimits(context.env);
  const expiresAt = Math.min(now + limits.challengeLifetimeMs, device.authorization_expires_at);
  const response = authChallengeSchema.parse({
    type: 'mirna-auth-challenge-v1',
    protocolVersion: 1,
    suite: SYNC_CRYPTO_SUITE,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    challengeId,
    challenge,
    issuedAt: isoTimestamp(now),
    expiresAt: isoTimestamp(expiresAt),
    audience: input.audience,
    origin: input.origin,
    method: 'POST',
  });
  const challengeHash = await domainHashBytes(
    SYNC_DOMAIN_LABELS.authChallengeHash,
    base64UrlToBytes(challenge),
  );
  const inserted = await context.env.MIRNA_SYNC_DB.prepare(
    `INSERT INTO auth_challenges (
       challenge_id, vault_id, device_id, audience, origin, challenge_hash,
       created_at, expires_at, consumed_at
     )
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL
      WHERE (
        SELECT COUNT(*)
          FROM auth_challenges
         WHERE vault_id = ?2
           AND device_id = ?3
           AND consumed_at IS NULL
           AND expires_at > ?7
      ) < ?9`,
  )
    .bind(
      challengeId,
      input.vaultId,
      input.deviceId,
      input.audience,
      input.origin,
      toDatabaseBlob(challengeHash),
      now,
      expiresAt,
      limits.maxActiveAuthChallengesPerDevice,
    )
    .run();
  if (inserted.meta.changes !== 1) {
    throw new HttpError(429, 'AUTH_CHALLENGE_LIMIT', 'Too many active authentication challenges.');
  }

  return jsonResponse(response, {
    status: 201,
    requestId: context.requestId,
    allowedOrigin: context.allowedOrigin,
  });
};

const loadStoredChallenge = async (
  database: D1Database,
  challenge: AuthChallengeV1,
  now: number,
): Promise<StoredChallengeRow | null> => {
  const hash = await domainHashBytes(
    SYNC_DOMAIN_LABELS.authChallengeHash,
    base64UrlToBytes(challenge.challenge),
  );
  const row = await database
    .prepare(
      `SELECT c.vault_id, c.device_id, c.audience, c.origin, c.created_at, c.expires_at,
              d.signing_public_key_raw, d.agreement_public_key_raw,
              g.expires_at AS authorization_expires_at, m.canonical_manifest
         FROM auth_challenges c
         JOIN devices d
           ON d.vault_id = c.vault_id
          AND d.device_id = c.device_id
          AND d.status = 'active'
          AND d.revoked_at IS NULL
         JOIN vaults v
           ON v.vault_id = c.vault_id
          AND v.status = 'active'
         JOIN device_grants g
           ON g.vault_id = c.vault_id
          AND g.device_id = c.device_id
          AND g.revoked_at IS NULL
          AND g.expires_at > ?9
         JOIN vault_manifests m
           ON m.vault_id = v.vault_id
          AND m.manifest_version = v.current_manifest_version
        WHERE c.challenge_id = ?1
          AND c.vault_id = ?2
          AND c.device_id = ?3
          AND c.audience = ?4
          AND c.origin = ?5
          AND c.created_at = ?6
          AND c.expires_at = ?7
          AND c.challenge_hash = ?8
          AND c.consumed_at IS NULL
          AND c.expires_at > ?9
        ORDER BY g.grant_version DESC
        LIMIT 1`,
    )
    .bind(
      challenge.challengeId,
      challenge.vaultId,
      challenge.deviceId,
      challenge.audience,
      challenge.origin,
      Date.parse(challenge.issuedAt),
      Date.parse(challenge.expiresAt),
      toDatabaseBlob(hash),
      now,
    )
    .first<StoredChallengeRow>();
  return row && hasCurrentManifestMembership(row, challenge.deviceId, now) ? row : null;
};

const verifyStoredChallenge = async (
  context: RequestContext,
  challenge: AuthChallengeV1,
  signature: string,
  expectedAudience: AuthChallengeV1['audience'],
  expectedDeviceId?: string,
): Promise<StoredChallengeRow> => {
  const now = Date.now();
  if (
    challenge.audience !== expectedAudience ||
    challenge.origin !== context.allowedOrigin ||
    challenge.method !== 'POST' ||
    (expectedDeviceId !== undefined && challenge.deviceId !== expectedDeviceId)
  ) {
    throw forbidden('CHALLENGE_CONTEXT_MISMATCH', 'Challenge context does not match the request.');
  }
  const stored = await loadStoredChallenge(context.env.MIRNA_SYNC_DB, challenge, now);
  if (!stored) throw forbidden('CHALLENGE_INVALID', 'Challenge is invalid, expired or consumed.');
  const publicKey = await importSigningPublicKey({
    format: 'raw-p256',
    value: stored.signing_public_key_raw,
  });
  if (
    !(await verifyDomainSeparatedCanonicalSignature(
      SYNC_DOMAIN_LABELS.authChallenge,
      challenge,
      signature,
      publicKey,
    ))
  ) {
    throw forbidden('SIGNATURE_INVALID', 'Challenge signature is invalid.');
  }
  return stored;
};

export const consumeSensitiveChallenge = async (
  context: RequestContext,
  challenge: AuthChallengeV1,
  signature: string,
  expectedAudience: AuthChallengeV1['audience'],
  expectedDeviceId: string,
): Promise<void> => {
  await verifyStoredChallenge(context, challenge, signature, expectedAudience, expectedDeviceId);
  const result = await context.env.MIRNA_SYNC_DB.prepare(
    `UPDATE auth_challenges
        SET consumed_at = ?2
      WHERE challenge_id = ?1
        AND consumed_at IS NULL
        AND expires_at > ?2`,
  )
    .bind(challenge.challengeId, Date.now())
    .run();
  if (result.meta.changes !== 1) {
    throw forbidden('CHALLENGE_REUSED', 'Challenge was already consumed.');
  }
};

export const handleAuthSession = async (context: RequestContext): Promise<Response> => {
  const input = await readCanonicalJson(context.request, authSessionRequestSchema);
  const stored = await verifyStoredChallenge(
    context,
    input.challenge,
    input.signature,
    '/v1/auth/session',
  );
  const now = Date.now();
  const sessionId = randomOpaqueId();
  const accessToken = randomSecret();
  const accessTokenHash = await hashEncodedSecret(SYNC_DOMAIN_LABELS.accessTokenHash, accessToken);
  const limits = readWorkerLimits(context.env);
  const expiresAt = Math.min(now + limits.accessSessionLifetimeMs, stored.authorization_expires_at);
  const results = await context.env.MIRNA_SYNC_DB.batch([
    context.env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO access_sessions (
         session_id, vault_id, device_id, token_hash, created_at, expires_at,
         last_used_at, revoked_at
       )
       SELECT ?1, c.vault_id, c.device_id, ?2, ?3, ?4, NULL, NULL
         FROM auth_challenges c
        WHERE c.challenge_id = ?5
          AND c.consumed_at IS NULL
          AND c.expires_at > ?3
          AND EXISTS (
            SELECT 1
              FROM devices d
             WHERE d.vault_id = c.vault_id
               AND d.device_id = c.device_id
               AND d.status = 'active'
               AND d.revoked_at IS NULL
          )
          AND EXISTS (
            SELECT 1
              FROM device_grants g
             WHERE g.vault_id = c.vault_id
               AND g.device_id = c.device_id
               AND g.revoked_at IS NULL
               AND g.expires_at > ?3
          )
          AND (
            SELECT COUNT(*)
              FROM access_sessions s
             WHERE s.vault_id = c.vault_id
               AND s.device_id = c.device_id
               AND s.revoked_at IS NULL
               AND s.expires_at > ?3
          ) < ?6`,
    ).bind(
      sessionId,
      toDatabaseBlob(accessTokenHash),
      now,
      expiresAt,
      input.challenge.challengeId,
      limits.maxActiveSessionsPerDevice,
    ),
    context.env.MIRNA_SYNC_DB.prepare(
      `UPDATE auth_challenges
          SET consumed_at = ?2
        WHERE challenge_id = ?1
          AND consumed_at IS NULL
          AND expires_at > ?2
          AND EXISTS (SELECT 1 FROM access_sessions WHERE session_id = ?3)`,
    ).bind(input.challenge.challengeId, now, sessionId),
    context.env.MIRNA_SYNC_DB.prepare(
      `UPDATE devices
          SET last_seen_at = ?3
        WHERE vault_id = ?1
          AND device_id = ?2
          AND status = 'active'`,
    ).bind(stored.vault_id, stored.device_id, now),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    const activeSessions = await context.env.MIRNA_SYNC_DB.prepare(
      `SELECT COUNT(*) AS count
         FROM access_sessions
        WHERE vault_id = ?1
          AND device_id = ?2
          AND revoked_at IS NULL
          AND expires_at > ?3`,
    )
      .bind(stored.vault_id, stored.device_id, now)
      .first<number>('count');
    if (
      (activeSessions ?? limits.maxActiveSessionsPerDevice) >= limits.maxActiveSessionsPerDevice
    ) {
      throw new HttpError(429, 'AUTH_SESSION_LIMIT', 'Too many active access sessions.');
    }
    throw forbidden('CHALLENGE_REUSED', 'Challenge was already consumed.');
  }

  const response = authSessionResponseSchema.parse({
    protocolVersion: 1,
    accessToken,
    expiresAt: isoTimestamp(expiresAt),
    authorizationExpiresAt: isoTimestamp(stored.authorization_expires_at),
  });
  return jsonResponse(response, {
    status: 201,
    requestId: context.requestId,
    allowedOrigin: context.allowedOrigin,
  });
};

export const authenticateRequest = async (
  context: RequestContext,
): Promise<AuthenticatedDevice> => {
  const header = context.request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ') || header.length > 512) throw unauthorized();
  const token = header.slice('Bearer '.length);
  let tokenHash: Uint8Array;
  try {
    tokenHash = await hashEncodedSecret(SYNC_DOMAIN_LABELS.accessTokenHash, token);
  } catch {
    throw unauthorized();
  }
  const now = Date.now();
  const row = await context.env.MIRNA_SYNC_DB.prepare(
    `SELECT s.vault_id, s.device_id, s.expires_at AS session_expires_at,
            d.signing_public_key_raw, d.agreement_public_key_raw,
            g.expires_at AS authorization_expires_at, m.canonical_manifest
       FROM access_sessions s
       JOIN vaults v
         ON v.vault_id = s.vault_id
        AND v.status = 'active'
       JOIN devices d
         ON d.vault_id = s.vault_id
        AND d.device_id = s.device_id
        AND d.status = 'active'
        AND d.revoked_at IS NULL
       JOIN device_grants g
         ON g.vault_id = s.vault_id
        AND g.device_id = s.device_id
        AND g.revoked_at IS NULL
        AND g.expires_at > ?2
       JOIN vault_manifests m
         ON m.vault_id = v.vault_id
        AND m.manifest_version = v.current_manifest_version
      WHERE s.token_hash = ?1
        AND s.revoked_at IS NULL
        AND s.expires_at > ?2
      ORDER BY g.grant_version DESC
      LIMIT 1`,
  )
    .bind(toDatabaseBlob(tokenHash), now)
    .first<{
      vault_id: string;
      device_id: string;
      session_expires_at: number;
      signing_public_key_raw: string;
      agreement_public_key_raw: string;
      authorization_expires_at: number;
      canonical_manifest: string;
    }>();
  if (!row || !hasCurrentManifestMembership(row, row.device_id, now)) throw unauthorized();
  await context.env.MIRNA_SYNC_DB.prepare(
    `UPDATE access_sessions SET last_used_at = ?2 WHERE token_hash = ?1`,
  )
    .bind(toDatabaseBlob(tokenHash), now)
    .run();
  return {
    vaultId: row.vault_id,
    deviceId: row.device_id,
    signingPublicKeyRaw: row.signing_public_key_raw,
    authorizationExpiresAt: row.authorization_expires_at,
    sessionExpiresAt: row.session_expires_at,
  };
};
