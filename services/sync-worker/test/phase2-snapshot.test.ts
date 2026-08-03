import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '../../../src/domain/sync/canonical';
import { bytesToBase64Url, utf8 } from '../../../src/domain/sync/encoding';
import { manifestBodyHash } from '../../../src/domain/sync/manifest';
import {
  createEncryptedSnapshot,
  hashEncryptedSnapshotEnvelope,
  type EncryptedSnapshotArtifactV1,
} from '../../../src/domain/sync/snapshot';
import { emptyFinanceData } from '../../../src/tests/factories';
import { SNAPSHOT_ENVELOPE_HEADER } from '../src/snapshots';
import {
  createAccessSession,
  createInitialVaultFixture,
  randomEncoded,
  registerInitialVault,
  tamperEncoded,
  TEST_ORIGIN,
  type InitialVaultFixture,
} from './protocol-fixtures';

interface SnapshotFixture {
  fixture: InitialVaultFixture;
  accessToken: string;
  artifact: EncryptedSnapshotArtifactV1;
}

const encodedEnvelope = (artifact: EncryptedSnapshotArtifactV1): string =>
  bytesToBase64Url(utf8(canonicalizeJson(artifact.envelope)));

const errorCode = async (response: Response): Promise<string | undefined> => {
  const body = await response.json<{ error?: { code?: string } }>();
  return body.error?.code;
};

const uploadSnapshot = (
  snapshot: SnapshotFixture,
  options: {
    artifact?: EncryptedSnapshotArtifactV1;
    body?: Uint8Array;
    contentLength?: number;
    contentType?: string;
    idempotencyKey?: string;
    accessToken?: string;
  } = {},
): Promise<Response> => {
  const artifact = options.artifact ?? snapshot.artifact;
  const body = options.body ?? artifact.ciphertext;
  const requestBody = new Uint8Array(new ArrayBuffer(body.byteLength));
  requestBody.set(body);
  return SELF.fetch(`https://sync.invalid/v1/snapshots/${artifact.envelope.snapshotId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${options.accessToken ?? snapshot.accessToken}`,
      'Content-Length': String(options.contentLength ?? body.byteLength),
      'Content-Type': options.contentType ?? 'application/octet-stream',
      'Idempotency-Key': options.idempotencyKey ?? randomEncoded(),
      Origin: TEST_ORIGIN,
      [SNAPSHOT_ENVELOPE_HEADER]: encodedEnvelope(artifact),
      'X-Mirna-Protocol-Version': '1',
    },
    body: requestBody.buffer,
  });
};

const createSnapshotFixture = async (): Promise<SnapshotFixture> => {
  const fixture = await createInitialVaultFixture();
  expect((await registerInitialVault(fixture)).status).toBe(201);
  const { accessToken } = await createAccessSession(fixture);
  const artifact = await createEncryptedSnapshot({
    data: emptyFinanceData(),
    vaultId: fixture.vaultId,
    revision: 1,
    baseRevision: 0,
    keyEpoch: 1,
    creatingDeviceId: fixture.deviceId,
    createdAt: new Date().toISOString(),
    parentManifestHash: await manifestBodyHash(fixture.manifest),
    previousSnapshotHash: null,
    causalFrontier: { serverCursor: 0, devices: [] },
    vaultMasterKey: fixture.vaultMasterKey,
    signingPrivateKey: fixture.deviceKeys.signing.privateKey,
    compression: 'none',
  });
  return { fixture, accessToken, artifact };
};

describe('Phase 2 encrypted snapshot transport', () => {
  it('commits ciphertext through D1/R2 and streams the exact current artifact', async () => {
    const snapshot = await createSnapshotFixture();
    const idempotencyKey = randomEncoded();

    const created = await uploadSnapshot(snapshot, { idempotencyKey });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      protocolVersion: 1,
      snapshotId: snapshot.artifact.envelope.snapshotId,
      revision: 1,
      committed: true,
    });

    const retried = await uploadSnapshot(snapshot, { idempotencyKey });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      snapshotId: snapshot.artifact.envelope.snapshotId,
      revision: 1,
      committed: true,
    });

    const downloaded = await SELF.fetch('https://sync.invalid/v1/snapshots/current', {
      headers: {
        Authorization: `Bearer ${snapshot.accessToken}`,
        Origin: TEST_ORIGIN,
        'X-Mirna-Protocol-Version': '1',
      },
    });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(downloaded.headers.get('Cache-Control')).toBe('no-store');
    expect(downloaded.headers.get(SNAPSHOT_ENVELOPE_HEADER)).toBe(
      encodedEnvelope(snapshot.artifact),
    );
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(snapshot.artifact.ciphertext);

    const stored = await env.MIRNA_SYNC_DB.prepare(
      `SELECT state, canonical_envelope, r2_object_key
         FROM snapshots
        WHERE vault_id = ?1 AND snapshot_id = ?2`,
    )
      .bind(snapshot.fixture.vaultId, snapshot.artifact.envelope.snapshotId)
      .first<Record<string, string>>();
    expect(stored?.state).toBe('committed');
    expect(stored?.canonical_envelope).toBe(canonicalizeJson(snapshot.artifact.envelope));
    expect(JSON.stringify(stored)).not.toContain('Tekući');
    const object = await env.MIRNA_SYNC_BUCKET.get(stored!.r2_object_key);
    expect(object).not.toBeNull();
    expect(new TextDecoder().decode(await object!.arrayBuffer())).not.toContain('Tekući');
  });

  it('defers a new snapshot until every active device acknowledges the current revision', async () => {
    const snapshot = await createSnapshotFixture();
    expect((await uploadSnapshot(snapshot)).status).toBe(201);
    const nextArtifact = await createEncryptedSnapshot({
      data: emptyFinanceData(),
      vaultId: snapshot.fixture.vaultId,
      revision: 2,
      baseRevision: 1,
      keyEpoch: 1,
      creatingDeviceId: snapshot.fixture.deviceId,
      createdAt: new Date().toISOString(),
      parentManifestHash: await manifestBodyHash(snapshot.fixture.manifest),
      previousSnapshotHash: await hashEncryptedSnapshotEnvelope(snapshot.artifact.envelope),
      causalFrontier: { serverCursor: 0, devices: [] },
      vaultMasterKey: snapshot.fixture.vaultMasterKey,
      signingPrivateKey: snapshot.fixture.deviceKeys.signing.privateKey,
      compression: 'none',
    });

    const deferred = await uploadSnapshot(snapshot, { artifact: nextArtifact });
    expect(deferred.status).toBe(409);
    expect(await errorCode(deferred)).toBe('SNAPSHOT_ACK_PENDING');

    await env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO device_acknowledgements (
         vault_id, device_id, acknowledged_server_cursor,
         acknowledged_snapshot_id, acknowledged_snapshot_revision, acknowledged_at
       ) VALUES (?1, ?2, 0, ?3, 1, ?4)`,
    )
      .bind(
        snapshot.fixture.vaultId,
        snapshot.fixture.deviceId,
        snapshot.artifact.envelope.snapshotId,
        Date.now(),
      )
      .run();
    expect((await uploadSnapshot(snapshot, { artifact: nextArtifact })).status).toBe(201);
  });

  it('rejects stale concurrent writers and deletes the losing R2 object', async () => {
    const first = await createSnapshotFixture();
    const secondArtifact = await createEncryptedSnapshot({
      data: emptyFinanceData(),
      vaultId: first.fixture.vaultId,
      revision: 1,
      baseRevision: 0,
      keyEpoch: 1,
      creatingDeviceId: first.fixture.deviceId,
      createdAt: new Date().toISOString(),
      parentManifestHash: await manifestBodyHash(first.fixture.manifest),
      previousSnapshotHash: null,
      causalFrontier: { serverCursor: 0, devices: [] },
      vaultMasterKey: first.fixture.vaultMasterKey,
      signingPrivateKey: first.fixture.deviceKeys.signing.privateKey,
      compression: 'none',
    });

    const [left, right] = await Promise.all([
      uploadSnapshot(first),
      uploadSnapshot(first, { artifact: secondArtifact }),
    ]);
    expect([left.status, right.status].sort()).toEqual([201, 409]);

    const rows = await env.MIRNA_SYNC_DB.prepare(
      `SELECT state, r2_object_key FROM snapshots WHERE vault_id = ?1 ORDER BY snapshot_id`,
    )
      .bind(first.fixture.vaultId)
      .all<{ state: string; r2_object_key: string }>();
    expect(rows.results.filter((row) => row.state === 'committed')).toHaveLength(1);
    for (const row of rows.results.filter((candidate) => candidate.state !== 'committed')) {
      expect(await env.MIRNA_SYNC_BUCKET.head(row.r2_object_key)).toBeNull();
    }
    expect(
      (
        await env.MIRNA_SYNC_BUCKET.list({
          prefix: `v1/${first.fixture.vaultId}/snapshots/`,
        })
      ).objects,
    ).toHaveLength(1);
  });

  it('binds idempotency keys, snapshot IDs, signatures and ciphertext hashes', async () => {
    const snapshot = await createSnapshotFixture();
    const idempotencyKey = randomEncoded();
    expect((await uploadSnapshot(snapshot, { idempotencyKey })).status).toBe(201);

    const changedKeyRetry = await uploadSnapshot(snapshot, { idempotencyKey: randomEncoded() });
    expect(changedKeyRetry.status).toBe(409);
    expect(await errorCode(changedKeyRetry)).toBe('SNAPSHOT_ID_REUSED');

    const other = await createSnapshotFixture();
    const signedTamper = {
      ...other.artifact,
      envelope: {
        ...other.artifact.envelope,
        ciphertextHash: tamperEncoded(other.artifact.envelope.ciphertextHash),
      },
    };
    const badSignature = await uploadSnapshot(other, { artifact: signedTamper });
    expect(badSignature.status).toBe(403);
    expect(await errorCode(badSignature)).toBe('SNAPSHOT_SIGNATURE_INVALID');

    const bodyTamper = other.artifact.ciphertext.slice();
    bodyTamper[0] = (bodyTamper[0] ?? 0) ^ 1;
    const badCiphertext = await uploadSnapshot(other, { body: bodyTamper });
    expect(badCiphertext.status).not.toBeLessThan(400);
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        `SELECT COUNT(*) AS count FROM snapshots WHERE vault_id = ?1 AND state = 'committed'`,
      )
        .bind(other.fixture.vaultId)
        .first<number>('count'),
    ).toBe(0);
    const failedRow = await env.MIRNA_SYNC_DB.prepare(
      `SELECT r2_object_key FROM snapshots WHERE vault_id = ?1 AND snapshot_id = ?2`,
    )
      .bind(other.fixture.vaultId, other.artifact.envelope.snapshotId)
      .first<string>('r2_object_key');
    expect(failedRow).not.toBeNull();
    expect(await env.MIRNA_SYNC_BUCKET.head(failedRow!)).toBeNull();
  });

  it('fails closed for invalid transport framing and authorization', async () => {
    const snapshot = await createSnapshotFixture();

    const wrongType = await uploadSnapshot(snapshot, { contentType: 'application/json' });
    expect(wrongType.status).toBe(415);
    expect(await errorCode(wrongType)).toBe('UNSUPPORTED_CONTENT_TYPE');

    const tooLarge = await uploadSnapshot(snapshot, { contentLength: 8 * 1_024 * 1_024 + 1 });
    expect(tooLarge.status).toBe(413);
    expect(await errorCode(tooLarge)).toBe('SNAPSHOT_TOO_LARGE');

    const wrongLength = await uploadSnapshot(snapshot, {
      contentLength: snapshot.artifact.ciphertext.byteLength - 1,
    });
    expect(wrongLength.status).toBe(400);
    expect(await errorCode(wrongLength)).toBe('SNAPSHOT_LENGTH_MISMATCH');

    const invalidSession = await uploadSnapshot(snapshot, { accessToken: randomEncoded() });
    expect(invalidSession.status).toBe(401);
    expect(await errorCode(invalidSession)).toBe('AUTHENTICATION_REQUIRED');
  });

  it('removes an uploaded R2 object if the D1 CAS transaction aborts, then safely retries', async () => {
    const snapshot = await createSnapshotFixture();
    const idempotencyKey = randomEncoded();
    await env.MIRNA_SYNC_DB.prepare(
      `CREATE TRIGGER test_abort_snapshot_cas
       BEFORE UPDATE OF current_snapshot_revision ON vaults
       WHEN NEW.current_snapshot_revision > OLD.current_snapshot_revision
       BEGIN
         SELECT RAISE(ABORT, 'synthetic snapshot CAS failure');
       END`,
    ).run();

    const failed = await uploadSnapshot(snapshot, { idempotencyKey });
    expect(failed.status).toBe(503);
    expect(await errorCode(failed)).toBe('SNAPSHOT_COMMIT_UNAVAILABLE');
    expect(
      (
        await env.MIRNA_SYNC_BUCKET.list({
          prefix: `v1/${snapshot.fixture.vaultId}/snapshots/`,
        })
      ).objects,
    ).toEqual([]);
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        `SELECT state FROM snapshots WHERE vault_id = ?1 AND snapshot_id = ?2`,
      )
        .bind(snapshot.fixture.vaultId, snapshot.artifact.envelope.snapshotId)
        .first<string>('state'),
    ).toBe('temporary');

    await env.MIRNA_SYNC_DB.prepare('DROP TRIGGER test_abort_snapshot_cas').run();
    const recovered = await uploadSnapshot(snapshot, { idempotencyKey });
    expect(recovered.status).toBe(201);
    expect(
      (
        await env.MIRNA_SYNC_BUCKET.list({
          prefix: `v1/${snapshot.fixture.vaultId}/snapshots/`,
        })
      ).objects,
    ).toHaveLength(1);
  });

  it('does not return any current artifact before the first successful commit', async () => {
    const snapshot = await createSnapshotFixture();
    const response = await SELF.fetch('https://sync.invalid/v1/snapshots/current', {
      headers: {
        Authorization: `Bearer ${snapshot.accessToken}`,
        Origin: TEST_ORIGIN,
        'X-Mirna-Protocol-Version': '1',
      },
    });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('SNAPSHOT_NOT_FOUND');
  });
});
