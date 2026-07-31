import { canonicalizeJson } from '../../../src/domain/sync/canonical';
import { SYNC_CRYPTO_SUITE, SYNC_DOMAIN_LABELS } from '../../../src/domain/sync/constants';
import {
  importSigningPublicKey,
  verifyDomainSeparatedCanonicalSignature,
} from '../../../src/domain/sync/crypto';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  decodeUtf8,
  timingSafeEqual,
  utf8,
} from '../../../src/domain/sync/encoding';
import {
  encryptedSnapshotEnvelopeSchema,
  hashEncryptedSnapshotEnvelope,
  SNAPSHOT_SIGNATURE_DOMAIN,
  unsignedEncryptedSnapshotEnvelopeSchema,
  type EncryptedSnapshotEnvelopeV1,
} from '../../../src/domain/sync/snapshot';
import { authenticateRequest, type AuthenticatedDevice } from './auth';
import type { RequestContext } from './context';
import { conflict, forbidden, HttpError } from './errors';
import { binaryResponse, jsonResponse } from './http';
import { readWorkerLimits } from './limits';
import {
  canonicalText,
  encodedToDatabaseBlob,
  hashEncodedSecret,
  toDatabaseBlob,
} from './server-crypto';

export const SNAPSHOT_ENVELOPE_HEADER = 'X-Mirna-Snapshot-Envelope';
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

const MAX_ENVELOPE_HEADER_CHARACTERS = 24_000;
const SNAPSHOT_RETENTION_MS = 24 * 60 * 60 * 1_000;

interface VaultSnapshotStateRow {
  current_key_epoch: number;
  current_manifest_version: number;
  current_snapshot_id: string | null;
  current_snapshot_revision: number;
  manifest_hash: ArrayBuffer;
  current_snapshot_hash: ArrayBuffer | null;
}

interface StoredSnapshotRow {
  vault_id: string;
  snapshot_id: string;
  revision: number;
  base_revision: number;
  key_epoch: number;
  creating_device_id: string;
  ciphertext_hash: ArrayBuffer;
  ciphertext_size: number;
  idempotency_key_hash: ArrayBuffer;
  r2_object_key: string;
  state: 'temporary' | 'committed' | 'orphaned' | 'superseded' | 'deleting';
  canonical_envelope: string | null;
  envelope_hash: ArrayBuffer | null;
  canonical_commit_response: string | null;
  r2_etag: string | null;
}

const bytes = (value: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> => {
  const source = value instanceof Uint8Array ? value : new Uint8Array(value);
  const copy = new Uint8Array(new ArrayBuffer(source.byteLength));
  copy.set(source);
  return copy;
};

const invalidEnvelope = (): HttpError =>
  new HttpError(400, 'INVALID_SNAPSHOT_ENVELOPE', 'Snapshot envelope is invalid.');

const parseEnvelopeHeader = (request: Request): EncryptedSnapshotEnvelopeV1 => {
  const encoded = request.headers.get(SNAPSHOT_ENVELOPE_HEADER);
  if (!encoded || encoded.length > MAX_ENVELOPE_HEADER_CHARACTERS) throw invalidEnvelope();
  try {
    const text = decodeUtf8(bytes(base64UrlToBytes(encoded)));
    const parsed = encryptedSnapshotEnvelopeSchema.parse(JSON.parse(text) as unknown);
    if (canonicalizeJson(parsed) !== text) throw invalidEnvelope();
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalidEnvelope();
  }
};

const encodedEnvelopeHeader = (canonicalEnvelope: string): string =>
  bytesToBase64Url(utf8(canonicalEnvelope));

const requireIdempotencyHash = async (request: Request): Promise<Uint8Array> => {
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency key is required.');
  }
  try {
    return await hashEncodedSecret(SYNC_DOMAIN_LABELS.snapshotIdempotencyHash, idempotencyKey);
  } catch {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency key is invalid.');
  }
};

const requireExactContentLength = (request: Request, expected: number, maximum: number): void => {
  const value = request.headers.get('Content-Length');
  if (value === null) {
    throw new HttpError(411, 'CONTENT_LENGTH_REQUIRED', 'Content-Length is required.');
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new HttpError(400, 'INVALID_CONTENT_LENGTH', 'Content-Length is invalid.');
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maximum) {
    throw new HttpError(413, 'SNAPSHOT_TOO_LARGE', 'Snapshot exceeds the configured limit.');
  }
  if (length !== expected) {
    throw new HttpError(400, 'SNAPSHOT_LENGTH_MISMATCH', 'Snapshot length does not match.');
  }
};

const loadVaultSnapshotState = (
  database: D1Database,
  vaultId: string,
): Promise<VaultSnapshotStateRow | null> =>
  database
    .prepare(
      `SELECT v.current_key_epoch, v.current_manifest_version,
              v.current_snapshot_id, v.current_snapshot_revision,
              m.manifest_hash, s.envelope_hash AS current_snapshot_hash
         FROM vaults v
         JOIN vault_manifests m
           ON m.vault_id = v.vault_id
          AND m.manifest_version = v.current_manifest_version
         LEFT JOIN snapshots s
           ON s.vault_id = v.vault_id
          AND s.snapshot_id = v.current_snapshot_id
          AND s.state = 'committed'
        WHERE v.vault_id = ?1
          AND v.status = 'active'
        LIMIT 1`,
    )
    .bind(vaultId)
    .first<VaultSnapshotStateRow>();

const assertCurrentSnapshotContext = (
  envelope: EncryptedSnapshotEnvelopeV1,
  authenticated: AuthenticatedDevice,
  state: VaultSnapshotStateRow,
): void => {
  const expectedPreviousHash =
    state.current_snapshot_revision === 0
      ? null
      : state.current_snapshot_hash
        ? bytesToBase64Url(bytes(state.current_snapshot_hash))
        : undefined;
  if (expectedPreviousHash === undefined) {
    throw new HttpError(503, 'SNAPSHOT_STATE_UNAVAILABLE', 'Snapshot state is unavailable.');
  }
  if (
    envelope.vaultId !== authenticated.vaultId ||
    envelope.creatingDeviceId !== authenticated.deviceId ||
    envelope.keyEpoch !== state.current_key_epoch ||
    envelope.baseRevision !== state.current_snapshot_revision ||
    envelope.revision !== state.current_snapshot_revision + 1 ||
    envelope.parentManifestHash !== bytesToBase64Url(bytes(state.manifest_hash)) ||
    envelope.previousSnapshotHash !== expectedPreviousHash
  ) {
    throw conflict('SNAPSHOT_REVISION_CONFLICT', 'Snapshot base revision is stale.');
  }
};

const verifyEnvelopeSignature = async (
  envelope: EncryptedSnapshotEnvelopeV1,
  authenticated: AuthenticatedDevice,
): Promise<void> => {
  const { signature, ...unsigned } = envelope;
  const parsedUnsigned = unsignedEncryptedSnapshotEnvelopeSchema.parse(unsigned);
  const signingKey = await importSigningPublicKey({
    format: 'raw-p256',
    value: authenticated.signingPublicKeyRaw,
  });
  if (
    !(await verifyDomainSeparatedCanonicalSignature(
      SNAPSHOT_SIGNATURE_DOMAIN,
      parsedUnsigned,
      signature,
      signingKey,
    ))
  ) {
    throw forbidden('SNAPSHOT_SIGNATURE_INVALID', 'Snapshot signature is invalid.');
  }
};

const findStoredSnapshot = (
  database: D1Database,
  vaultId: string,
  snapshotId: string,
  idempotencyHash: Uint8Array,
): Promise<StoredSnapshotRow | null> =>
  database
    .prepare(
      `SELECT vault_id, snapshot_id, revision, base_revision, key_epoch,
              creating_device_id, ciphertext_hash, ciphertext_size,
              idempotency_key_hash, r2_object_key, state, canonical_envelope,
              envelope_hash, canonical_commit_response, r2_etag
         FROM snapshots
        WHERE vault_id = ?1
          AND (snapshot_id = ?2 OR idempotency_key_hash = ?3)
        LIMIT 1`,
    )
    .bind(vaultId, snapshotId, toDatabaseBlob(idempotencyHash))
    .first<StoredSnapshotRow>();

const assertExactStoredSnapshot = (
  stored: StoredSnapshotRow,
  envelope: EncryptedSnapshotEnvelopeV1,
  canonicalEnvelope: string,
  envelopeHash: Uint8Array,
  idempotencyHash: Uint8Array,
): void => {
  if (
    stored.snapshot_id !== envelope.snapshotId ||
    stored.revision !== envelope.revision ||
    stored.base_revision !== envelope.baseRevision ||
    stored.key_epoch !== envelope.keyEpoch ||
    stored.creating_device_id !== envelope.creatingDeviceId ||
    stored.ciphertext_size !== envelope.ciphertextLength ||
    stored.canonical_envelope !== canonicalEnvelope ||
    !timingSafeEqual(bytes(stored.ciphertext_hash), base64UrlToBytes(envelope.ciphertextHash)) ||
    !stored.envelope_hash ||
    !timingSafeEqual(bytes(stored.envelope_hash), envelopeHash) ||
    !timingSafeEqual(bytes(stored.idempotency_key_hash), idempotencyHash)
  ) {
    throw conflict('SNAPSHOT_ID_REUSED', 'Snapshot identity was already used with other data.');
  }
};

const committedRetry = async (
  context: RequestContext,
  stored: StoredSnapshotRow,
): Promise<Response> => {
  if (!stored.canonical_commit_response) {
    throw new HttpError(503, 'SNAPSHOT_STATE_UNAVAILABLE', 'Snapshot state is unavailable.');
  }
  const object = await context.env.MIRNA_SYNC_BUCKET.head(stored.r2_object_key);
  if (
    !object ||
    object.size !== stored.ciphertext_size ||
    !object.checksums.sha256 ||
    !timingSafeEqual(bytes(object.checksums.sha256), bytes(stored.ciphertext_hash))
  ) {
    throw new HttpError(503, 'SNAPSHOT_STORAGE_UNAVAILABLE', 'Snapshot storage is unavailable.');
  }
  return jsonResponse(JSON.parse(stored.canonical_commit_response) as unknown, {
    requestId: context.requestId,
    allowedOrigin: context.allowedOrigin,
  });
};

const insertTemporarySnapshot = async (
  context: RequestContext,
  envelope: EncryptedSnapshotEnvelopeV1,
  canonicalEnvelope: string,
  envelopeHash: Uint8Array,
  idempotencyHash: Uint8Array,
  objectKey: string,
  now: number,
): Promise<void> => {
  await context.env.MIRNA_SYNC_DB.prepare(
    `INSERT INTO snapshots (
       vault_id, snapshot_id, revision, base_revision, key_epoch,
       creating_device_id, crypto_suite, nonce, aad, ciphertext_hash,
       ciphertext_size, envelope_signature, previous_snapshot_hash,
       idempotency_key_hash, r2_object_key, state, created_at, cleanup_after,
       canonical_envelope, envelope_hash
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
       ?15, 'temporary', ?16, ?17, ?18, ?19
     )`,
  )
    .bind(
      envelope.vaultId,
      envelope.snapshotId,
      envelope.revision,
      envelope.baseRevision,
      envelope.keyEpoch,
      envelope.creatingDeviceId,
      SYNC_CRYPTO_SUITE,
      encodedToDatabaseBlob(envelope.nonce, 12),
      toDatabaseBlob(utf8(canonicalText(envelope.aad))),
      encodedToDatabaseBlob(envelope.ciphertextHash, 32),
      envelope.ciphertextLength,
      encodedToDatabaseBlob(envelope.signature, 64),
      envelope.previousSnapshotHash
        ? encodedToDatabaseBlob(envelope.previousSnapshotHash, 32)
        : null,
      toDatabaseBlob(idempotencyHash),
      objectKey,
      now,
      now + readWorkerLimits(context.env).orphanLifetimeMs,
      canonicalEnvelope,
      toDatabaseBlob(envelopeHash),
    )
    .run();
};

const markOrphanAndDelete = async (
  context: RequestContext,
  envelope: EncryptedSnapshotEnvelopeV1,
  objectKey: string,
): Promise<void> => {
  const now = Date.now();
  await context.env.MIRNA_SYNC_DB.prepare(
    `UPDATE snapshots
        SET state = 'orphaned', cleanup_after = ?3
      WHERE vault_id = ?1
        AND snapshot_id = ?2
        AND state = 'temporary'`,
  )
    .bind(envelope.vaultId, envelope.snapshotId, now)
    .run()
    .catch(() => undefined);
  await context.env.MIRNA_SYNC_BUCKET.delete(objectKey).catch(() => undefined);
};

const revisionConflictResponse = async (context: RequestContext, vaultId: string) => {
  const currentRevision =
    (await context.env.MIRNA_SYNC_DB.prepare(
      'SELECT current_snapshot_revision FROM vaults WHERE vault_id = ?1',
    )
      .bind(vaultId)
      .first<number>('current_snapshot_revision')) ?? 0;
  return jsonResponse(
    {
      protocolVersion: 1,
      error: {
        code: 'SNAPSHOT_REVISION_CONFLICT',
        message: 'Snapshot base revision is stale.',
        requestId: context.requestId,
      },
      currentRevision,
    },
    { status: 409, requestId: context.requestId, allowedOrigin: context.allowedOrigin },
  );
};

export const handleUploadSnapshot = async (
  context: RequestContext,
  snapshotId: string,
): Promise<Response> => {
  const envelope = parseEnvelopeHeader(context.request);
  if (envelope.snapshotId !== snapshotId) throw invalidEnvelope();
  const limits = readWorkerLimits(context.env);
  requireExactContentLength(context.request, envelope.ciphertextLength, limits.maxSnapshotBytes);
  if (!context.request.body) {
    throw new HttpError(400, 'SNAPSHOT_BODY_REQUIRED', 'Snapshot body is required.');
  }

  const [authenticated, idempotencyHash] = await Promise.all([
    authenticateRequest(context),
    requireIdempotencyHash(context.request),
  ]);
  await verifyEnvelopeSignature(envelope, authenticated);
  const canonicalEnvelope = canonicalText(envelope);
  const encodedEnvelopeHash = await hashEncryptedSnapshotEnvelope(envelope);
  const envelopeHash = base64UrlToBytes(encodedEnvelopeHash);

  let stored = await findStoredSnapshot(
    context.env.MIRNA_SYNC_DB,
    authenticated.vaultId,
    snapshotId,
    idempotencyHash,
  );
  if (stored) {
    assertExactStoredSnapshot(stored, envelope, canonicalEnvelope, envelopeHash, idempotencyHash);
    if (stored.state === 'committed') return committedRetry(context, stored);
    if (stored.state !== 'temporary') {
      return revisionConflictResponse(context, authenticated.vaultId);
    }
  }

  const state = await loadVaultSnapshotState(context.env.MIRNA_SYNC_DB, authenticated.vaultId);
  if (!state) throw new HttpError(404, 'VAULT_NOT_FOUND', 'Vault was not found.');
  try {
    assertCurrentSnapshotContext(envelope, authenticated, state);
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      return revisionConflictResponse(context, authenticated.vaultId);
    }
    throw error;
  }

  const objectKey =
    stored?.r2_object_key ??
    `v1/${authenticated.vaultId}/snapshots/${snapshotId}/${encodedEnvelopeHash}`;
  if (!stored) {
    const now = Date.now();
    try {
      await insertTemporarySnapshot(
        context,
        envelope,
        canonicalEnvelope,
        envelopeHash,
        idempotencyHash,
        objectKey,
        now,
      );
    } catch {
      stored = await findStoredSnapshot(
        context.env.MIRNA_SYNC_DB,
        authenticated.vaultId,
        snapshotId,
        idempotencyHash,
      );
      if (!stored) throw conflict('SNAPSHOT_STATE_CHANGED', 'Snapshot state changed.');
      assertExactStoredSnapshot(stored, envelope, canonicalEnvelope, envelopeHash, idempotencyHash);
      if (stored.state === 'committed') return committedRetry(context, stored);
      if (stored.state !== 'temporary') {
        return revisionConflictResponse(context, authenticated.vaultId);
      }
    }
  }

  let object: R2Object;
  try {
    object = await context.env.MIRNA_SYNC_BUCKET.put(objectKey, context.request.body, {
      sha256: encodedToDatabaseBlob(envelope.ciphertextHash, 32),
      httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'no-store' },
      customMetadata: { protocol: '1', snapshot: snapshotId },
    });
  } catch {
    await context.env.MIRNA_SYNC_BUCKET.delete(objectKey).catch(() => undefined);
    throw new HttpError(503, 'SNAPSHOT_STORAGE_UNAVAILABLE', 'Snapshot storage is unavailable.');
  }
  if (
    object.size !== envelope.ciphertextLength ||
    !object.checksums.sha256 ||
    !timingSafeEqual(bytes(object.checksums.sha256), base64UrlToBytes(envelope.ciphertextHash))
  ) {
    await markOrphanAndDelete(context, envelope, objectKey);
    throw new HttpError(400, 'SNAPSHOT_CIPHERTEXT_INVALID', 'Snapshot ciphertext is invalid.');
  }

  const now = Date.now();
  const commitBody = {
    protocolVersion: 1 as const,
    snapshotId,
    revision: envelope.revision,
    snapshotHash: encodedEnvelopeHash,
    committed: true,
  };
  const statements = [
    context.env.MIRNA_SYNC_DB.prepare(
      `UPDATE vaults
          SET current_snapshot_id = ?2,
              current_snapshot_revision = ?3,
              updated_at = ?4
        WHERE vault_id = ?1
          AND status = 'active'
          AND current_key_epoch = ?5
          AND current_snapshot_revision = ?6`,
    ).bind(
      authenticated.vaultId,
      snapshotId,
      envelope.revision,
      now,
      envelope.keyEpoch,
      envelope.baseRevision,
    ),
    context.env.MIRNA_SYNC_DB.prepare(
      `UPDATE snapshots
          SET state = 'committed', committed_at = ?3, cleanup_after = NULL,
              canonical_commit_response = ?4, r2_etag = ?5
        WHERE vault_id = ?1
          AND snapshot_id = ?2
          AND state = 'temporary'
          AND EXISTS (
            SELECT 1 FROM vaults v
             WHERE v.vault_id = ?1
               AND v.current_snapshot_id = ?2
               AND v.current_snapshot_revision = snapshots.revision
          )`,
    ).bind(authenticated.vaultId, snapshotId, now, canonicalText(commitBody), object.etag),
  ];
  if (envelope.baseRevision > 0) {
    statements.push(
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE snapshots
            SET state = 'superseded', cleanup_after = ?4
          WHERE vault_id = ?1
            AND snapshot_id != ?2
            AND revision = ?3
            AND state = 'committed'`,
      ).bind(authenticated.vaultId, snapshotId, envelope.baseRevision, now + SNAPSHOT_RETENTION_MS),
    );
  }
  statements.push(
    context.env.MIRNA_SYNC_DB.prepare(
      `UPDATE snapshots
          SET cleanup_after = ?3
        WHERE vault_id = ?1
          AND state = 'superseded'
          AND revision <= ?2`,
    ).bind(authenticated.vaultId, envelope.revision - limits.maxRetainedSnapshots, now),
  );

  let results: D1Result<unknown>[];
  try {
    results = await context.env.MIRNA_SYNC_DB.batch(statements);
  } catch {
    const raced = await findStoredSnapshot(
      context.env.MIRNA_SYNC_DB,
      authenticated.vaultId,
      snapshotId,
      idempotencyHash,
    );
    if (raced) {
      assertExactStoredSnapshot(raced, envelope, canonicalEnvelope, envelopeHash, idempotencyHash);
      if (raced.state === 'committed') return committedRetry(context, raced);
    }
    await context.env.MIRNA_SYNC_BUCKET.delete(objectKey).catch(() => undefined);
    throw new HttpError(503, 'SNAPSHOT_COMMIT_UNAVAILABLE', 'Snapshot commit is unavailable.');
  }
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    const raced = await findStoredSnapshot(
      context.env.MIRNA_SYNC_DB,
      authenticated.vaultId,
      snapshotId,
      idempotencyHash,
    );
    if (raced) {
      assertExactStoredSnapshot(raced, envelope, canonicalEnvelope, envelopeHash, idempotencyHash);
      if (raced.state === 'committed') return committedRetry(context, raced);
    }
    await markOrphanAndDelete(context, envelope, objectKey);
    return revisionConflictResponse(context, authenticated.vaultId);
  }

  return jsonResponse(commitBody, {
    status: 201,
    requestId: context.requestId,
    allowedOrigin: context.allowedOrigin,
  });
};

export const handleGetCurrentSnapshotForVault = async (
  context: RequestContext,
  vaultId: string,
): Promise<Response> => {
  const row = await context.env.MIRNA_SYNC_DB.prepare(
    `SELECT s.canonical_envelope, s.ciphertext_hash, s.ciphertext_size,
            s.r2_object_key
       FROM vaults v
       JOIN snapshots s
         ON s.vault_id = v.vault_id
        AND s.snapshot_id = v.current_snapshot_id
        AND s.revision = v.current_snapshot_revision
        AND s.state = 'committed'
      WHERE v.vault_id = ?1
        AND v.status = 'active'
      LIMIT 1`,
  )
    .bind(vaultId)
    .first<{
      canonical_envelope: string | null;
      ciphertext_hash: ArrayBuffer;
      ciphertext_size: number;
      r2_object_key: string;
    }>();
  if (!row) {
    throw new HttpError(404, 'SNAPSHOT_NOT_FOUND', 'Snapshot was not found.');
  }
  if (!row.canonical_envelope) {
    throw new HttpError(503, 'SNAPSHOT_STATE_UNAVAILABLE', 'Snapshot state is unavailable.');
  }
  const envelope = encryptedSnapshotEnvelopeSchema.parse(
    JSON.parse(row.canonical_envelope) as unknown,
  );
  const object = await context.env.MIRNA_SYNC_BUCKET.get(row.r2_object_key);
  if (
    !object ||
    object.size !== row.ciphertext_size ||
    object.size !== envelope.ciphertextLength ||
    !object.checksums.sha256 ||
    !timingSafeEqual(bytes(object.checksums.sha256), bytes(row.ciphertext_hash))
  ) {
    throw new HttpError(503, 'SNAPSHOT_STORAGE_UNAVAILABLE', 'Snapshot storage is unavailable.');
  }
  return binaryResponse(object.body, {
    requestId: context.requestId,
    allowedOrigin: context.allowedOrigin,
    contentLength: object.size,
    headers: {
      [SNAPSHOT_ENVELOPE_HEADER]: encodedEnvelopeHeader(row.canonical_envelope),
    },
  });
};

export const handleGetCurrentSnapshot = async (context: RequestContext): Promise<Response> => {
  const authenticated = await authenticateRequest(context);
  return handleGetCurrentSnapshotForVault(context, authenticated.vaultId);
};
