import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '../../../src/domain/sync/canonical';
import { SYNC_CRYPTO_SUITE, SYNC_PROTOCOL_VERSION } from '../../../src/domain/sync/constants';
import {
  createEncryptedOperation,
  hashSyncOperation,
  operationResultStateHash,
  parseSyncOperation,
  protocolOperationDefaults,
  type OperationEnvelopeV1,
  type SyncOperationV1,
} from '../../../src/domain/sync/operation';
import {
  createAccessSession,
  createInitialVaultFixture,
  postCanonical,
  randomEncoded,
  registerInitialVault,
  tamperEncoded,
  TEST_ORIGIN,
  type InitialVaultFixture,
} from './protocol-fixtures';

interface OperationFixture {
  vault: InitialVaultFixture;
  accessToken: string;
}

const errorCode = async (response: Response): Promise<string | undefined> => {
  const body = await response.json<{ error?: { code?: string } }>();
  return body.error?.code;
};

const createFixture = async (): Promise<OperationFixture> => {
  const vault = await createInitialVaultFixture();
  expect((await registerInitialVault(vault)).status).toBe(201);
  const { accessToken } = await createAccessSession(vault);
  return { vault, accessToken };
};

const accountValue = (id: string) => ({
  id,
  name: 'Sintetički račun',
  kind: 'checking' as const,
  openingBalance: 10_000,
  protected: false,
  color: '#123456',
  archived: false,
  createdAt: '2026-07-31T10:00:00.000Z',
});

const createOperation = async (
  fixture: OperationFixture,
  options: {
    operationId?: string;
    deviceSequence?: number;
    previousOperation?: SyncOperationV1;
    entityId?: string;
  } = {},
): Promise<{ operation: SyncOperationV1; envelope: OperationEnvelopeV1 }> => {
  const operationId = options.operationId ?? randomEncoded(16);
  const deviceSequence = options.deviceSequence ?? 1;
  const previousHash = options.previousOperation
    ? await hashSyncOperation(options.previousOperation)
    : deviceSequence === 1
      ? null
      : randomEncoded();
  const causalFrontier =
    deviceSequence === 1
      ? []
      : [
          {
            deviceId: fixture.vault.deviceId,
            deviceSequence: deviceSequence - 1,
            operationHash: previousHash!,
          },
        ];
  const value = accountValue(options.entityId ?? `account-${operationId}`);
  const provisional = parseSyncOperation({
    ...protocolOperationDefaults,
    vaultId: fixture.vault.vaultId,
    operationId,
    mutationGroupId: randomEncoded(16),
    mutationGroupIndex: 0,
    mutationGroupSize: 1,
    deviceId: fixture.vault.deviceId,
    deviceSequence,
    lamportTime: deviceSequence,
    causalFrontier,
    command: {
      type: 'account.upsert',
      entityType: 'account',
      entityId: value.id,
      precondition: { entityVersion: 0, stateHash: null, tombstone: false },
      result: { entityVersion: 1, stateHash: randomEncoded(), tombstone: false },
      value,
      tombstone: null,
    },
    previousOperationHash: previousHash,
    keyEpoch: 1,
    createdAt: '2026-07-31T10:00:00.000Z',
  });
  const operation = parseSyncOperation({
    ...provisional,
    command: {
      ...provisional.command,
      result: {
        ...provisional.command.result,
        stateHash: await operationResultStateHash(provisional),
      },
    },
  });
  return {
    operation,
    envelope: await createEncryptedOperation({
      operation,
      vaultMasterKey: fixture.vault.vaultMasterKey,
      signingPrivateKey: fixture.vault.deviceKeys.signing.privateKey,
    }),
  };
};

const uploadOperation = (
  fixture: OperationFixture,
  envelope: OperationEnvelopeV1,
): Promise<Response> =>
  postCanonical(
    '/v1/operations',
    { protocolVersion: SYNC_PROTOCOL_VERSION, envelope },
    { accessToken: fixture.accessToken },
  );

const getChanges = (fixture: OperationFixture, after = 0, limit = 20): Promise<Response> =>
  SELF.fetch(`https://sync.invalid/v1/changes?after=${after}&limit=${limit}`, {
    headers: {
      Authorization: `Bearer ${fixture.accessToken}`,
      Origin: TEST_ORIGIN,
      'X-Mirna-Protocol-Version': String(SYNC_PROTOCOL_VERSION),
    },
  });

const acknowledge = (
  fixture: OperationFixture,
  cursor: number,
  snapshot: { id: string | null; revision: number } = { id: null, revision: 0 },
): Promise<Response> =>
  postCanonical(
    '/v1/acks',
    {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      acknowledgedServerCursor: cursor,
      causalFrontierHash: randomEncoded(),
      acknowledgedSnapshotId: snapshot.id,
      acknowledgedSnapshotRevision: snapshot.revision,
    },
    { accessToken: fixture.accessToken },
  );

const installSyntheticCurrentSnapshot = async (
  fixture: OperationFixture,
): Promise<{ id: string; revision: number }> => {
  const now = Date.now();
  const id = randomEncoded(16);
  await env.MIRNA_SYNC_DB.batch([
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO snapshots (
         vault_id, snapshot_id, revision, base_revision, key_epoch, creating_device_id,
         crypto_suite, nonce, aad, ciphertext_hash, ciphertext_size, envelope_signature,
         previous_snapshot_hash, idempotency_key_hash, r2_object_key, state,
         created_at, committed_at, cleanup_after
       ) VALUES (?1, ?2, 1, 0, 1, ?3, ?4, ?5, ?6, ?7, 16, ?8, NULL, ?9, ?10,
                 'temporary', ?11, NULL, ?12)`,
    ).bind(
      fixture.vault.vaultId,
      id,
      fixture.vault.deviceId,
      SYNC_CRYPTO_SUITE,
      new Uint8Array(12),
      new TextEncoder().encode('{}'),
      new Uint8Array(32),
      new Uint8Array(64),
      new Uint8Array(32).fill(1),
      `v1/${fixture.vault.vaultId}/snapshots/${id}`,
      now,
      now + 60_000,
    ),
    env.MIRNA_SYNC_DB.prepare(
      `UPDATE vaults
          SET current_snapshot_id = ?2, current_snapshot_revision = 1, updated_at = ?3
        WHERE vault_id = ?1`,
    ).bind(fixture.vault.vaultId, id, now),
    env.MIRNA_SYNC_DB.prepare(
      `UPDATE snapshots
          SET state = 'committed', committed_at = ?3, cleanup_after = NULL
        WHERE vault_id = ?1 AND snapshot_id = ?2`,
    ).bind(fixture.vault.vaultId, id, now),
  ]);
  return { id, revision: 1 };
};

const addUnacknowledgedActiveDevice = async (fixture: OperationFixture): Promise<string> => {
  const deviceId = randomEncoded(16);
  const now = Date.now();
  await env.MIRNA_SYNC_DB.batch([
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO devices (
         vault_id, device_id, signing_public_key_raw, agreement_public_key_raw,
         status, added_in_manifest_version, created_at
       ) VALUES (?1, ?2, ?3, ?4, 'active', 1, ?5)`,
    ).bind(
      fixture.vault.vaultId,
      deviceId,
      fixture.vault.devicePublicKeys.signing.value,
      fixture.vault.devicePublicKeys.agreement.value,
      now,
    ),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO device_grants (
         grant_id, vault_id, device_id, grant_version, issued_by_device_id,
         authorization_transcript_hash, authorization_signature, issued_at, expires_at
       ) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      randomEncoded(16),
      fixture.vault.vaultId,
      deviceId,
      fixture.vault.deviceId,
      new Uint8Array(32),
      new Uint8Array(64),
      now,
      now + 24 * 60 * 60 * 1_000,
    ),
  ]);
  return deviceId;
};

describe('Phase 3 encrypted operation transport', () => {
  it('accepts an exact retry, returns ciphertext pages and persists no command plaintext', async () => {
    const fixture = await createFixture();
    const createdOperation = await createOperation(fixture);

    const created = await uploadOperation(fixture, createdOperation.envelope);
    expect(created.status).toBe(201);
    const accepted = await created.json<{ serverCursor: number }>();
    expect(accepted.serverCursor).toBeGreaterThan(0);

    const retried = await uploadOperation(fixture, createdOperation.envelope);
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({
      operationId: createdOperation.operation.operationId,
      serverCursor: accepted.serverCursor,
      accepted: true,
    });

    const changes = await getChanges(fixture, 0, 1);
    expect(changes.status).toBe(200);
    await expect(changes.json()).resolves.toMatchObject({
      changes: [{ ...createdOperation.envelope, serverCursor: accepted.serverCursor }],
      nextCursor: accepted.serverCursor,
      hasMore: false,
    });

    const stored = await env.MIRNA_SYNC_DB.prepare(
      `SELECT canonical_envelope, ciphertext
         FROM sync_changes WHERE vault_id = ?1 AND operation_id = ?2`,
    )
      .bind(fixture.vault.vaultId, createdOperation.operation.operationId)
      .first<{ canonical_envelope: string; ciphertext: ArrayBuffer }>();
    expect(stored?.canonical_envelope).toBe(canonicalizeJson(createdOperation.envelope));
    expect(stored?.canonical_envelope).not.toContain('Sintetički račun');
    expect(new TextDecoder().decode(new Uint8Array(stored!.ciphertext))).not.toContain(
      'Sintetički račun',
    );
  });

  it('rejects sequence reuse, sequence gaps, tampering, stale epochs and invalid sessions', async () => {
    const fixture = await createFixture();
    const first = await createOperation(fixture);
    expect((await uploadOperation(fixture, first.envelope)).status).toBe(201);

    const sequenceReuse = await createOperation(fixture);
    const reused = await uploadOperation(fixture, sequenceReuse.envelope);
    expect(reused.status).toBe(409);
    expect(await errorCode(reused)).toBe('OPERATION_ID_REUSED');

    const skipped = await createOperation(fixture, { deviceSequence: 3 });
    const gap = await uploadOperation(fixture, skipped.envelope);
    expect(gap.status).toBe(409);
    expect(await errorCode(gap)).toBe('OPERATION_SEQUENCE_CONFLICT');

    const badCiphertext = await uploadOperation(fixture, {
      ...first.envelope,
      ciphertext: tamperEncoded(first.envelope.ciphertext),
    });
    expect(badCiphertext.status).toBe(403);
    expect(await errorCode(badCiphertext)).toBe('OPERATION_CIPHERTEXT_INVALID');

    const badSignature = await uploadOperation(fixture, {
      ...first.envelope,
      operationId: randomEncoded(16),
      aad: { ...first.envelope.aad, operationId: randomEncoded(16) },
      signature: tamperEncoded(first.envelope.signature),
    });
    expect(badSignature.status).toBeGreaterThanOrEqual(400);

    const next = await createOperation(fixture, {
      deviceSequence: 2,
      previousOperation: first.operation,
    });
    await env.MIRNA_SYNC_DB.prepare('UPDATE vaults SET current_key_epoch = 2 WHERE vault_id = ?1')
      .bind(fixture.vault.vaultId)
      .run();
    const stale = await uploadOperation(fixture, next.envelope);
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('OPERATION_KEY_EPOCH_CONFLICT');

    const invalidSession = await postCanonical(
      '/v1/operations',
      { protocolVersion: SYNC_PROTOCOL_VERSION, envelope: next.envelope },
      { accessToken: randomEncoded() },
    );
    expect(invalidSession.status).toBe(401);
  });

  it('rejects cursor rollback and compacts only after every active device acknowledges the snapshot', async () => {
    const fixture = await createFixture();
    const operation = await createOperation(fixture);
    const created = await uploadOperation(fixture, operation.envelope);
    const cursor = (await created.json<{ serverCursor: number }>()).serverCursor;
    expect((await acknowledge(fixture, cursor)).status).toBe(200);
    const rollback = await acknowledge(fixture, cursor - 1);
    expect(rollback.status).toBe(409);
    expect(await errorCode(rollback)).toBe('ACK_ROLLBACK_DETECTED');
    const future = await acknowledge(fixture, cursor + 1);
    expect(future.status).toBe(409);
    expect(await errorCode(future)).toBe('ACK_CONTEXT_CONFLICT');

    const snapshot = await installSyntheticCurrentSnapshot(fixture);
    const secondDeviceId = await addUnacknowledgedActiveDevice(fixture);
    expect((await acknowledge(fixture, cursor, snapshot)).status).toBe(200);
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        'SELECT compacted_at FROM sync_changes WHERE vault_id = ?1 AND server_cursor = ?2',
      )
        .bind(fixture.vault.vaultId, cursor)
        .first<number>('compacted_at'),
    ).toBeNull();

    const revokedAt = Date.now();
    await env.MIRNA_SYNC_DB.batch([
      env.MIRNA_SYNC_DB.prepare(
        `UPDATE devices SET status = 'revoked', revoked_at = ?3
          WHERE vault_id = ?1 AND device_id = ?2`,
      ).bind(fixture.vault.vaultId, secondDeviceId, revokedAt),
      env.MIRNA_SYNC_DB.prepare(
        `UPDATE device_grants SET revoked_at = ?3
          WHERE vault_id = ?1 AND device_id = ?2`,
      ).bind(fixture.vault.vaultId, secondDeviceId, revokedAt),
    ]);
    expect((await acknowledge(fixture, cursor, snapshot)).status).toBe(200);
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        'SELECT compacted_at FROM sync_changes WHERE vault_id = ?1 AND server_cursor = ?2',
      )
        .bind(fixture.vault.vaultId, cursor)
        .first<number>('compacted_at'),
    ).not.toBeNull();
  });
});
