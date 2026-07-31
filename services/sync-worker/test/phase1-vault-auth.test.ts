import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SYNC_PROTOCOL_VERSION } from '../../../src/domain/sync/constants';
import { bytesToHex } from '../../../src/domain/sync/encoding';
import { authSessionResponseSchema } from '../../../src/domain/sync/schemas';
import {
  createAccessSession,
  createInitialVaultFixture,
  issueChallenge,
  parseVaultCreateResponse,
  postCanonical,
  randomEncoded,
  registerInitialVault,
  signChallenge,
  tamperEncoded,
  TEST_ORIGIN,
} from './protocol-fixtures';

const errorCode = async (response: Response): Promise<string | undefined> => {
  const body = await response.json<{ error?: { code?: string } }>();
  return body.error?.code;
};

describe('Phase 1 vault initialization', () => {
  it('creates the initial vault atomically and treats an exact retry as idempotent', async () => {
    const fixture = await createInitialVaultFixture();

    const created = await registerInitialVault(fixture);
    expect(created.status).toBe(201);
    expect(await parseVaultCreateResponse(created)).toMatchObject({
      protocolVersion: 1,
      vaultId: fixture.vaultId,
      manifestVersion: 1,
      created: true,
    });

    const retried = await registerInitialVault(fixture);
    expect(retried.status).toBe(200);
    expect(await parseVaultCreateResponse(retried)).toMatchObject({
      vaultId: fixture.vaultId,
      created: false,
    });

    const counts = await env.MIRNA_SYNC_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM vaults WHERE vault_id = ?1) AS vaults,
         (SELECT COUNT(*) FROM devices WHERE vault_id = ?1) AS devices,
         (SELECT COUNT(*) FROM vault_manifests WHERE vault_id = ?1) AS manifests,
         (SELECT COUNT(*) FROM recovery_records WHERE vault_id = ?1) AS recovery_records`,
    )
      .bind(fixture.vaultId)
      .first<Record<string, number>>();
    expect(counts).toEqual({ vaults: 1, devices: 1, manifests: 1, recovery_records: 1 });
  });

  it('rejects recovery-envelope and duplicate-request tampering', async () => {
    const fixture = await createInitialVaultFixture();
    const brokenBinding = {
      ...fixture.recovery,
      recoveryEnvelope: {
        ...fixture.recovery.recoveryEnvelope,
        aad: {
          ...fixture.recovery.recoveryEnvelope.aad,
          parentManifestHash: randomEncoded(),
        },
      },
    };
    const brokenResponse = await postCanonical('/v1/vaults', {
      protocolVersion: 1,
      suite: fixture.manifest.suite,
      manifest: fixture.manifest,
      recovery: brokenBinding,
    });
    expect(brokenResponse.status).toBe(409);
    expect(await errorCode(brokenResponse)).toBe('RECOVERY_BINDING_INVALID');

    expect((await registerInitialVault(fixture)).status).toBe(201);
    const changedGate = {
      ...fixture.recovery,
      recoveryGateKeyHash: randomEncoded(),
    };
    const duplicateTamper = await postCanonical('/v1/vaults', {
      protocolVersion: 1,
      suite: fixture.manifest.suite,
      manifest: fixture.manifest,
      recovery: changedGate,
    });
    expect(duplicateTamper.status).toBe(409);
    expect(await errorCode(duplicateTamper)).toBe('VAULT_ALREADY_EXISTS');
  });

  it('persists only public metadata, hashes and ciphertext—not synthetic plaintext secrets', async () => {
    const fixture = await createInitialVaultFixture();
    expect((await registerInitialVault(fixture)).status).toBe(201);

    const stored = await env.MIRNA_SYNC_DB.prepare(
      `SELECT m.canonical_manifest,
              r.canonical_recovery_envelope,
              hex(r.recovery_gate_key_hash) AS recovery_gate_key_hash_hex
         FROM vault_manifests m
         JOIN recovery_records r ON r.vault_id = m.vault_id
        WHERE m.vault_id = ?1`,
    )
      .bind(fixture.vaultId)
      .first<Record<string, string>>();
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain('SALARY-123456-RSD-PRIVATE-DATA!!');
    expect(serialized).not.toContain(bytesToHex(fixture.recoveryRoot).toUpperCase());
    expect(serialized).not.toContain(bytesToHex(fixture.vaultMasterKey).toUpperCase());

    const bucket = await env.MIRNA_SYNC_BUCKET.list();
    expect(bucket.objects).toEqual([]);
  });

  it('rejects a cryptographically valid initial authorization dated in 2099 before persistence', async () => {
    const fixture = await createInitialVaultFixture({
      now: Date.parse('2099-01-01T12:00:00.000Z'),
    });

    const response = await registerInitialVault(fixture);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('AUTHORIZATION_WINDOW_INVALID');

    const counts = await env.MIRNA_SYNC_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM vaults WHERE vault_id = ?1) AS vaults,
         (SELECT COUNT(*) FROM devices WHERE vault_id = ?1) AS devices,
         (SELECT COUNT(*) FROM vault_manifests WHERE vault_id = ?1) AS manifests,
         (SELECT COUNT(*) FROM recovery_records WHERE vault_id = ?1) AS recovery_records`,
    )
      .bind(fixture.vaultId)
      .first<Record<string, number>>();
    expect(counts).toEqual({ vaults: 0, devices: 0, manifests: 0, recovery_records: 0 });
  });

  it('accepts bounded client clock skew while using server time for operational grants', async () => {
    const clientNow = Date.now() + 60_000;
    const fixture = await createInitialVaultFixture({ now: clientNow });

    expect((await registerInitialVault(fixture)).status).toBe(201);
    const session = await createAccessSession(fixture);
    expect(session.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const stored = await env.MIRNA_SYNC_DB.prepare(
      `SELECT v.created_at AS vault_created_at,
              g.issued_at AS grant_issued_at,
              r.signed_updated_at AS signed_recovery_updated_at
         FROM vaults v
         JOIN device_grants g ON g.vault_id = v.vault_id
         JOIN recovery_records r ON r.vault_id = v.vault_id
        WHERE v.vault_id = ?1`,
    )
      .bind(fixture.vaultId)
      .first<Record<string, number>>();
    expect(stored).not.toBeNull();
    expect(stored!.vault_created_at).toBeLessThan(clientNow);
    expect(stored!.grant_issued_at).toBeLessThan(clientNow);
    expect(stored!.signed_recovery_updated_at).toBe(Date.parse(fixture.recovery.updatedAt));
  });
});

describe('Phase 1 challenge and access-session authentication', () => {
  it('issues a signed, origin-bound challenge and consumes it exactly once', async () => {
    const fixture = await createInitialVaultFixture();
    expect((await registerInitialVault(fixture)).status).toBe(201);
    const challenge = await issueChallenge(fixture);
    const request = {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      challenge,
      signature: await signChallenge(fixture, challenge),
    };

    const first = await postCanonical('/v1/auth/session', request);
    expect(first.status).toBe(201);
    const issuedSession = authSessionResponseSchema.parse(await first.json());
    expect(issuedSession.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const second = await postCanonical('/v1/auth/session', request);
    expect(second.status).toBe(403);
    expect(await errorCode(second)).toBe('CHALLENGE_INVALID');
    const counts = await env.MIRNA_SYNC_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM auth_challenges
           WHERE vault_id = ?1 AND device_id = ?2 AND consumed_at IS NOT NULL) AS consumed,
         (SELECT COUNT(*) FROM access_sessions
           WHERE vault_id = ?1 AND device_id = ?2) AS sessions`,
    )
      .bind(fixture.vaultId, fixture.deviceId)
      .first<Record<string, number>>();
    expect(counts).toEqual({ consumed: 1, sessions: 1 });

    const manifest = await SELF.fetch('https://sync.invalid/v1/vault/manifest', {
      headers: {
        Authorization: `Bearer ${issuedSession.accessToken}`,
        Origin: TEST_ORIGIN,
        'X-Mirna-Protocol-Version': '1',
      },
    });
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({ vaultId: fixture.vaultId, manifestVersion: 1 });
  });

  it('rejects a tampered challenge, tampered signature and wrong audience', async () => {
    const fixture = await createInitialVaultFixture();
    expect((await registerInitialVault(fixture)).status).toBe(201);

    const challenge = await issueChallenge(fixture);
    const signature = await signChallenge(fixture, challenge);
    const changedChallenge = { ...challenge, challenge: tamperEncoded(challenge.challenge) };
    const tamperedChallenge = await postCanonical('/v1/auth/session', {
      protocolVersion: 1,
      challenge: changedChallenge,
      signature,
    });
    expect(tamperedChallenge.status).toBe(403);
    expect(await errorCode(tamperedChallenge)).toBe('CHALLENGE_INVALID');

    const tamperedSignature = await postCanonical('/v1/auth/session', {
      protocolVersion: 1,
      challenge,
      signature: tamperEncoded(signature),
    });
    expect(tamperedSignature.status).toBe(403);
    expect(await errorCode(tamperedSignature)).toBe('SIGNATURE_INVALID');

    const approvalChallenge = await issueChallenge(fixture, '/v1/pairings/approve');
    const wrongAudience = await postCanonical('/v1/auth/session', {
      protocolVersion: 1,
      challenge: approvalChallenge,
      signature: await signChallenge(fixture, approvalChallenge),
    });
    expect(wrongAudience.status).toBe(403);
    expect(await errorCode(wrongAudience)).toBe('CHALLENGE_CONTEXT_MISMATCH');
  });

  it('rejects expired challenges, grants and sessions, plus revoked devices', async () => {
    const fixture = await createInitialVaultFixture();
    expect((await registerInitialVault(fixture)).status).toBe(201);

    const challenge = await issueChallenge(fixture);
    const expiredAt = Date.now() - 1;
    await env.MIRNA_SYNC_DB.prepare(
      `UPDATE auth_challenges
          SET created_at = ?2, expires_at = ?3
        WHERE challenge_id = ?1`,
    )
      .bind(challenge.challengeId, expiredAt - 1_000, expiredAt)
      .run();
    const expiredChallenge = await postCanonical('/v1/auth/session', {
      protocolVersion: 1,
      challenge,
      signature: await signChallenge(fixture, challenge),
    });
    expect(expiredChallenge.status).toBe(403);
    expect(await errorCode(expiredChallenge)).toBe('CHALLENGE_INVALID');

    const session = await createAccessSession(fixture);
    await env.MIRNA_SYNC_DB.prepare(`UPDATE access_sessions SET created_at = ?1, expires_at = ?2`)
      .bind(expiredAt - 1_000, expiredAt)
      .run();
    const expiredSession = await SELF.fetch('https://sync.invalid/v1/vault/manifest', {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Origin: TEST_ORIGIN,
        'X-Mirna-Protocol-Version': '1',
      },
    });
    expect(expiredSession.status).toBe(401);

    await env.MIRNA_SYNC_DB.prepare(`UPDATE access_sessions SET expires_at = ?1, revoked_at = NULL`)
      .bind(Date.now() + 10_000)
      .run();
    await env.MIRNA_SYNC_DB.prepare(
      `UPDATE devices SET status = 'revoked', revoked_at = ?1 WHERE device_id = ?2`,
    )
      .bind(Date.now(), fixture.deviceId)
      .run();
    const revokedDevice = await SELF.fetch('https://sync.invalid/v1/vault/manifest', {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Origin: TEST_ORIGIN,
        'X-Mirna-Protocol-Version': '1',
      },
    });
    expect(revokedDevice.status).toBe(401);

    await env.MIRNA_SYNC_DB.prepare(
      `UPDATE devices SET status = 'active', revoked_at = NULL WHERE device_id = ?1`,
    )
      .bind(fixture.deviceId)
      .run();
    await env.MIRNA_SYNC_DB.prepare(
      `UPDATE device_grants
          SET issued_at = ?1, expires_at = ?2
        WHERE vault_id = ?3 AND device_id = ?4`,
    )
      .bind(expiredAt - 1_000, expiredAt, fixture.vaultId, fixture.deviceId)
      .run();
    const expiredGrant = await SELF.fetch('https://sync.invalid/v1/vault/manifest', {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Origin: TEST_ORIGIN,
        'X-Mirna-Protocol-Version': '1',
      },
    });
    expect(expiredGrant.status).toBe(401);
  });
});
