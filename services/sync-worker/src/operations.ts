import { canonicalizeJson } from '../../../src/domain/sync/canonical';
import { SYNC_CRYPTO_SUITE, SYNC_LIMITS } from '../../../src/domain/sync/constants';
import {
  importSigningPublicKey,
  verifyDomainSeparatedCanonicalSignature,
} from '../../../src/domain/sync/crypto';
import { base64UrlToBytes, timingSafeEqual, utf8 } from '../../../src/domain/sync/encoding';
import {
  deviceAcknowledgementRequestSchema,
  deviceAcknowledgementResponseSchema,
  operationChangesResponseSchema,
  operationEnvelopeSignatureBody,
  operationUploadRequestSchema,
  operationUploadResponseSchema,
  parseOperationEnvelope,
  SYNC_OPERATION_ENVELOPE_SIGNATURE_DOMAIN,
  type OperationEnvelopeV1,
} from '../../../src/domain/sync/operation';
import { authenticateRequest, type AuthenticatedDevice } from './auth';
import { STAGING_BUDGETS } from './config/staging-budgets';
import type { RequestContext } from './context';
import { conflict, forbidden, HttpError } from './errors';
import { jsonResponse } from './http';
import { canonicalText, toDatabaseBlob } from './server-crypto';
import { readCanonicalJson } from './validation';

const CHANGE_RETENTION_AFTER_COMPACTION_MS = 7 * 24 * 60 * 60 * 1_000;
const EXPIRED_DEVICE_ACK_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

interface StoredChangeRow {
  server_cursor: number;
  operation_id: string;
  device_id: string;
  device_sequence: number;
  canonical_envelope: string | null;
}

const findExistingChange = (
  database: D1Database,
  vaultId: string,
  operationId: string,
  deviceId: string,
  deviceSequence: number,
): Promise<StoredChangeRow | null> =>
  database
    .prepare(
      `SELECT server_cursor, operation_id, device_id, device_sequence,
              canonical_envelope
         FROM sync_changes
        WHERE vault_id = ?1
          AND (operation_id = ?2 OR (device_id = ?3 AND device_sequence = ?4))
        LIMIT 1`,
    )
    .bind(vaultId, operationId, deviceId, deviceSequence)
    .first<StoredChangeRow>();

const exactRetryResponse = (
  context: RequestContext,
  row: StoredChangeRow,
  envelope: OperationEnvelopeV1,
): Response => {
  const canonicalEnvelope = canonicalText(envelope);
  if (
    row.operation_id !== envelope.operationId ||
    row.device_id !== envelope.deviceId ||
    row.device_sequence !== envelope.deviceSequence ||
    row.canonical_envelope !== canonicalEnvelope
  ) {
    throw conflict('OPERATION_ID_REUSED', 'Operation identity was already used.');
  }
  return jsonResponse(
    operationUploadResponseSchema.parse({
      protocolVersion: 1,
      operationId: envelope.operationId,
      serverCursor: row.server_cursor,
      accepted: true,
    }),
    {
      requestId: context.requestId,
      allowedOrigin: context.allowedOrigin,
    },
  );
};

const verifyEnvelope = async (
  envelope: OperationEnvelopeV1,
  authenticated: AuthenticatedDevice,
): Promise<void> => {
  if (envelope.vaultId !== authenticated.vaultId || envelope.deviceId !== authenticated.deviceId) {
    throw forbidden('OPERATION_CONTEXT_MISMATCH', 'Operation context is invalid.');
  }
  const ciphertext = base64UrlToBytes(envelope.ciphertext);
  const actualHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array(ciphertext)),
  );
  if (!timingSafeEqual(actualHash, base64UrlToBytes(envelope.ciphertextHash))) {
    throw forbidden('OPERATION_CIPHERTEXT_INVALID', 'Operation ciphertext is invalid.');
  }
  const signingKey = await importSigningPublicKey({
    format: 'raw-p256',
    value: authenticated.signingPublicKeyRaw,
  });
  if (
    !(await verifyDomainSeparatedCanonicalSignature(
      SYNC_OPERATION_ENVELOPE_SIGNATURE_DOMAIN,
      operationEnvelopeSignatureBody(envelope),
      envelope.signature,
      signingKey,
    ))
  ) {
    throw forbidden('OPERATION_SIGNATURE_INVALID', 'Operation signature is invalid.');
  }
};

export const handleUploadOperation = async (context: RequestContext): Promise<Response> => {
  const input = await readCanonicalJson(context.request, operationUploadRequestSchema);
  const envelope = parseOperationEnvelope(input.envelope);
  const authenticated = await authenticateRequest(context);
  await verifyEnvelope(envelope, authenticated);
  const canonicalEnvelope = canonicalText(envelope);

  const existing = await findExistingChange(
    context.env.MIRNA_SYNC_DB,
    authenticated.vaultId,
    envelope.operationId,
    envelope.deviceId,
    envelope.deviceSequence,
  );
  if (existing) return exactRetryResponse(context, existing, envelope);

  const state = await context.env.MIRNA_SYNC_DB.prepare(
    `SELECT current_key_epoch,
            (SELECT COALESCE(MAX(device_sequence), 0)
               FROM sync_changes
              WHERE vault_id = ?1 AND device_id = ?2) AS last_device_sequence,
            (SELECT COUNT(*) FROM sync_changes WHERE vault_id = ?1) AS operation_count
       FROM vaults
      WHERE vault_id = ?1 AND status = 'active'
      LIMIT 1`,
  )
    .bind(authenticated.vaultId, authenticated.deviceId)
    .first<{
      current_key_epoch: number;
      last_device_sequence: number;
      operation_count: number;
    }>();
  if (!state) throw new HttpError(404, 'VAULT_NOT_FOUND', 'Vault was not found.');
  if (envelope.keyEpoch !== state.current_key_epoch) {
    throw conflict('OPERATION_KEY_EPOCH_CONFLICT', 'Operation key epoch is stale.');
  }
  if (envelope.deviceSequence !== state.last_device_sequence + 1) {
    throw conflict('OPERATION_SEQUENCE_CONFLICT', 'Operation device sequence is not contiguous.');
  }
  if (state.operation_count >= STAGING_BUDGETS.perVaultResources.uncompactedOperations) {
    throw new HttpError(429, 'VAULT_QUOTA_EXCEEDED', 'Vault staging quota is exhausted.');
  }

  let cursor: number;
  try {
    const inserted = await context.env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO sync_changes (
         vault_id, operation_id, device_id, device_sequence, key_epoch,
         crypto_suite, nonce, aad, ciphertext, ciphertext_hash, signature,
         previous_operation_hash, accepted_at, canonical_envelope
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?13)
       RETURNING server_cursor`,
    )
      .bind(
        authenticated.vaultId,
        envelope.operationId,
        envelope.deviceId,
        envelope.deviceSequence,
        envelope.keyEpoch,
        SYNC_CRYPTO_SUITE,
        toDatabaseBlob(base64UrlToBytes(envelope.nonce)),
        toDatabaseBlob(utf8(canonicalizeJson(envelope.aad))),
        toDatabaseBlob(base64UrlToBytes(envelope.ciphertext)),
        toDatabaseBlob(base64UrlToBytes(envelope.ciphertextHash)),
        toDatabaseBlob(base64UrlToBytes(envelope.signature)),
        Date.now(),
        canonicalEnvelope,
      )
      .first<number>('server_cursor');
    if (!inserted) throw new Error('Missing operation cursor.');
    cursor = inserted;
  } catch {
    const raced = await findExistingChange(
      context.env.MIRNA_SYNC_DB,
      authenticated.vaultId,
      envelope.operationId,
      envelope.deviceId,
      envelope.deviceSequence,
    );
    if (raced) return exactRetryResponse(context, raced, envelope);
    throw conflict('OPERATION_STATE_CHANGED', 'Operation state changed.');
  }

  const response = operationUploadResponseSchema.parse({
    protocolVersion: 1,
    operationId: envelope.operationId,
    serverCursor: cursor,
    accepted: true,
  });
  return jsonResponse(response, {
    status: 201,
    requestId: context.requestId,
    allowedOrigin: context.allowedOrigin,
  });
};

const queryInteger = (
  url: URL,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw))
    throw new HttpError(400, 'INVALID_REQUEST', 'Query is invalid.');
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, 'INVALID_REQUEST', 'Query is invalid.');
  }
  return parsed;
};

export const handleGetChanges = async (context: RequestContext): Promise<Response> => {
  const authenticated = await authenticateRequest(context);
  const url = new URL(context.request.url);
  const after = queryInteger(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = queryInteger(url, 'limit', 20, 1, SYNC_LIMITS.maxOperationsPerBatch);
  const rows = await context.env.MIRNA_SYNC_DB.prepare(
    `SELECT server_cursor, canonical_envelope
       FROM sync_changes
      WHERE vault_id = ?1 AND server_cursor > ?2
      ORDER BY server_cursor
      LIMIT ?3`,
  )
    .bind(authenticated.vaultId, after, limit + 1)
    .all<{ server_cursor: number; canonical_envelope: string | null }>();
  const page = rows.results.slice(0, limit);
  if (page.some((row) => !row.canonical_envelope)) {
    throw new HttpError(503, 'OPERATION_STATE_UNAVAILABLE', 'Operation state is unavailable.');
  }
  const changes = page.map((row) => {
    if (row.canonical_envelope === null) {
      throw new HttpError(503, 'OPERATION_STATE_UNAVAILABLE', 'Operation state is unavailable.');
    }
    return {
      ...(JSON.parse(row.canonical_envelope) as object),
      serverCursor: row.server_cursor,
    };
  });
  const nextCursor = page.at(-1)?.server_cursor ?? after;
  return jsonResponse(
    operationChangesResponseSchema.parse({
      protocolVersion: 1,
      changes,
      nextCursor,
      hasMore: rows.results.length > page.length,
    }),
    { requestId: context.requestId, allowedOrigin: context.allowedOrigin },
  );
};

export const handleAcknowledgeChanges = async (context: RequestContext): Promise<Response> => {
  const input = await readCanonicalJson(context.request, deviceAcknowledgementRequestSchema);
  const authenticated = await authenticateRequest(context);
  const vault = await context.env.MIRNA_SYNC_DB.prepare(
    `SELECT current_snapshot_id, current_snapshot_revision,
            (SELECT COALESCE(MAX(server_cursor), 0)
               FROM sync_changes WHERE vault_id = ?1) AS maximum_cursor
       FROM vaults WHERE vault_id = ?1 AND status = 'active' LIMIT 1`,
  )
    .bind(authenticated.vaultId)
    .first<{
      current_snapshot_id: string | null;
      current_snapshot_revision: number;
      maximum_cursor: number;
    }>();
  if (
    !vault ||
    input.acknowledgedServerCursor > vault.maximum_cursor ||
    input.acknowledgedSnapshotId !== vault.current_snapshot_id ||
    input.acknowledgedSnapshotRevision !== vault.current_snapshot_revision
  ) {
    throw conflict('ACK_CONTEXT_CONFLICT', 'Acknowledgement context is stale.');
  }
  const now = Date.now();
  const written = await context.env.MIRNA_SYNC_DB.prepare(
    `INSERT INTO device_acknowledgements (
       vault_id, device_id, acknowledged_server_cursor,
       acknowledged_snapshot_id, acknowledged_snapshot_revision,
       acknowledged_at, causal_frontier_hash
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(vault_id, device_id) DO UPDATE SET
       acknowledged_server_cursor = excluded.acknowledged_server_cursor,
       acknowledged_snapshot_id = excluded.acknowledged_snapshot_id,
       acknowledged_snapshot_revision = excluded.acknowledged_snapshot_revision,
       acknowledged_at = excluded.acknowledged_at,
       causal_frontier_hash = excluded.causal_frontier_hash
     WHERE excluded.acknowledged_server_cursor >= device_acknowledgements.acknowledged_server_cursor`,
  )
    .bind(
      authenticated.vaultId,
      authenticated.deviceId,
      input.acknowledgedServerCursor,
      input.acknowledgedSnapshotId,
      input.acknowledgedSnapshotRevision,
      now,
      toDatabaseBlob(base64UrlToBytes(input.causalFrontierHash)),
    )
    .run();
  if ((written.meta.changes ?? 0) !== 1) {
    throw conflict('ACK_ROLLBACK_DETECTED', 'Acknowledgement cursor cannot move backwards.');
  }

  if (vault.current_snapshot_id !== null) {
    const frontier = await context.env.MIRNA_SYNC_DB.prepare(
      `SELECT COUNT(*) AS active_devices,
              SUM(CASE WHEN a.device_id IS NOT NULL THEN 1 ELSE 0 END) AS acknowledged_devices,
              MIN(a.acknowledged_server_cursor) AS compact_cursor
         FROM devices d
         LEFT JOIN device_acknowledgements a
           ON a.vault_id = d.vault_id
          AND a.device_id = d.device_id
          AND a.acknowledged_snapshot_id = ?2
          AND a.acknowledged_snapshot_revision = ?3
        WHERE d.vault_id = ?1
          AND d.status = 'active'
          AND EXISTS (
            SELECT 1 FROM device_grants g
             WHERE g.vault_id = d.vault_id
               AND g.device_id = d.device_id
               AND g.revoked_at IS NULL
               AND g.expires_at > ?4
          )`,
    )
      .bind(
        authenticated.vaultId,
        vault.current_snapshot_id,
        vault.current_snapshot_revision,
        now - EXPIRED_DEVICE_ACK_GRACE_MS,
      )
      .first<{
        active_devices: number;
        acknowledged_devices: number;
        compact_cursor: number | null;
      }>();
    if (
      frontier &&
      frontier.active_devices > 0 &&
      frontier.active_devices === frontier.acknowledged_devices &&
      frontier.compact_cursor !== null
    ) {
      await context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE sync_changes
            SET compacted_at = ?3, cleanup_after = ?4
          WHERE vault_id = ?1
            AND server_cursor <= ?2
            AND compacted_at IS NULL`,
      )
        .bind(
          authenticated.vaultId,
          frontier.compact_cursor,
          now,
          now + CHANGE_RETENTION_AFTER_COMPACTION_MS,
        )
        .run();
    }
  }

  return jsonResponse(
    deviceAcknowledgementResponseSchema.parse({
      protocolVersion: 1,
      acknowledgedServerCursor: input.acknowledgedServerCursor,
      accepted: true,
    }),
    { requestId: context.requestId, allowedOrigin: context.allowedOrigin },
  );
};
