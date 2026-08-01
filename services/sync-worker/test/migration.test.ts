import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  bytes,
  opaqueId,
  rawP256PublicKey,
  SEEDED_DEVICE_ID,
  SEEDED_VAULT_ID,
  seedVaultAndDevice,
} from './fixtures';

const EXPECTED_TABLES = [
  'access_sessions',
  'auth_challenges',
  'beta_diagnostic_events',
  'beta_diagnostic_totals',
  'deletion_requests',
  'device_acknowledgements',
  'device_grants',
  'device_key_envelopes',
  'device_security_transitions',
  'devices',
  'pairing_envelopes',
  'pairing_requests',
  'recovery_challenges',
  'recovery_records',
  'resource_inventory',
  'resource_totals',
  'service_flags',
  'snapshots',
  'sync_changes',
  'usage_daily_buckets',
  'usage_reservations',
  'usage_rolling_totals',
  'vault_manifests',
  'vault_resource_totals',
  'vaults',
] as const;

describe('D1 migration foundation', () => {
  it('applies idempotently and creates every phase table as a strict table', async () => {
    await applyD1Migrations(env.MIRNA_SYNC_DB, env.TEST_MIGRATIONS, 'mirna_d1_migrations');

    const schema = await env.MIRNA_SYNC_DB.prepare(
      `SELECT name, sql
         FROM sqlite_schema
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE '_cf_%'
          AND name != 'mirna_d1_migrations'
        ORDER BY name`,
    ).all<{ name: string; sql: string }>();

    expect(schema.results.map((table) => table.name)).toEqual(EXPECTED_TABLES);
    expect(schema.results.every((table) => table.sql.endsWith('STRICT'))).toBe(true);

    const migrationCount = await env.MIRNA_SYNC_DB.prepare(
      'SELECT COUNT(*) AS count FROM mirna_d1_migrations',
    ).first<number>('count');
    expect(migrationCount).toBe(9);

    const reservationColumns = await env.MIRNA_SYNC_DB.prepare(
      "PRAGMA table_info('usage_reservations')",
    ).all<{ name: string }>();
    expect(reservationColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'committed_d1_rows_read',
        'released_d1_rows_read',
        'released_r2_class_a',
      ]),
    );

    const snapshotColumns = await env.MIRNA_SYNC_DB.prepare("PRAGMA table_info('snapshots')").all<{
      name: string;
    }>();
    expect(snapshotColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'canonical_envelope',
        'envelope_hash',
        'canonical_commit_response',
        'r2_etag',
      ]),
    );

    const snapshotCommitTrigger = await env.MIRNA_SYNC_DB.prepare(
      `SELECT name
         FROM sqlite_schema
        WHERE type = 'trigger'
          AND name = 'require_current_vault_pointer_before_snapshot_commit'`,
    ).first<string>('name');
    expect(snapshotCommitTrigger).toBe('require_current_vault_pointer_before_snapshot_commit');

    const changeColumns = await env.MIRNA_SYNC_DB.prepare("PRAGMA table_info('sync_changes')").all<{
      name: string;
    }>();
    expect(changeColumns.results.map((column) => column.name)).toContain('canonical_envelope');

    const acknowledgementColumns = await env.MIRNA_SYNC_DB.prepare(
      "PRAGMA table_info('device_acknowledgements')",
    ).all<{ name: string }>();
    expect(acknowledgementColumns.results.map((column) => column.name)).toContain(
      'causal_frontier_hash',
    );
  });

  it('contains no plaintext financial-content columns and enforces foreign keys', async () => {
    const columns = (
      await Promise.all(
        EXPECTED_TABLES.map(async (tableName) => {
          const tableColumns = await env.MIRNA_SYNC_DB.prepare(
            `PRAGMA table_info('${tableName}')`,
          ).all<{ name: string }>();
          return tableColumns.results.map((column) => ({
            table_name: tableName,
            column_name: column.name,
          }));
        }),
      )
    ).flat();

    const forbiddenPlaintextNames =
      /(?:transaction|balance|category|note|goal|debt|planned_event|backup|finance_payload|request_body)/u;
    expect(columns.filter(({ column_name }) => forbiddenPlaintextNames.test(column_name))).toEqual(
      [],
    );

    await expect(
      env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO devices (
           vault_id, device_id, signing_public_key_raw, agreement_public_key_raw,
           added_in_manifest_version, created_at
         ) VALUES (?1, ?2, ?3, ?4, 1, 1)`,
      )
        .bind(opaqueId(40), opaqueId(41), rawP256PublicKey(42), rawP256PublicKey(43))
        .run(),
    ).rejects.toThrow();
  });

  it('creates indexed vault-scoped and expiry request paths', async () => {
    const indexes = await env.MIRNA_SYNC_DB.prepare(
      `SELECT name
         FROM sqlite_schema
        WHERE type = 'index'
          AND name LIKE 'idx_%'
        ORDER BY name`,
    ).all<{ name: string }>();
    const names = new Set(indexes.results.map((index) => index.name));

    for (const requiredIndex of [
      'idx_access_sessions_expiry',
      'idx_auth_challenges_device_audience_expiry',
      'idx_auth_challenges_expiry',
      'idx_pairing_requests_vault_status_expiry',
      'idx_recovery_challenges_lookup_expiry',
      'idx_snapshots_vault_state_revision',
      'idx_sync_changes_vault_cursor',
      'idx_sync_changes_vault_device_sequence',
      'idx_device_acknowledgements_vault_snapshot',
      'idx_device_key_envelopes_recipient_epoch',
      'idx_device_security_transitions_vault_created',
      'idx_usage_daily_window',
      'idx_usage_reservations_state_created',
      'idx_resource_inventory_vault_state',
      'idx_resource_inventory_accounting_reservation',
      'idx_vault_resource_totals_release_reservation',
      'idx_beta_diagnostics_support_created',
      'idx_beta_diagnostics_request',
      'idx_beta_diagnostics_vault_created',
      'idx_beta_diagnostics_expiry',
    ]) {
      expect(names.has(requiredIndex), `${requiredIndex} should exist`).toBe(true);
    }
  });

  it('requires exact device identity and raw keys from the JSON manifest membership', async () => {
    const trigger = await env.MIRNA_SYNC_DB.prepare(
      `SELECT name, sql
         FROM sqlite_schema
        WHERE type = 'trigger'
          AND name = 'require_exact_device_manifest_before_insert'`,
    ).first<{ name: string; sql: string }>();
    expect(trigger?.name).toBe('require_exact_device_manifest_before_insert');
    expect(trigger?.sql).toContain('json_each');
    expect(trigger?.sql).toContain('json_extract');

    const now = 1_100_000;
    const vaultId = opaqueId(50);
    const deviceId = opaqueId(51);
    const signingKey = rawP256PublicKey(52);
    const agreementKey = rawP256PublicKey(53);
    const canonicalManifest = JSON.stringify({
      devices: [
        {
          deviceId,
          publicKeys: {
            signing: { value: signingKey },
            agreement: { value: agreementKey },
          },
        },
      ],
    });
    await env.MIRNA_SYNC_DB.batch([
      env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO vaults (
           vault_id, protocol_version, crypto_suite, status, current_key_epoch,
           current_manifest_version, current_snapshot_revision, created_at, updated_at
         ) VALUES (?1, 1, ?2, 'active', 1, 0, 0, ?3, ?3)`,
      ).bind(vaultId, 'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1', now),
      env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO vault_manifests (
           vault_id, manifest_version, key_epoch, authorization_kind,
           signed_by_device_id, canonical_manifest, manifest_hash,
           previous_manifest_hash, signature, accepted_at
         ) VALUES (?1, 2, 1, 'recovery', NULL, ?2, ?3, NULL, ?4, ?5)`,
      ).bind(vaultId, canonicalManifest, bytes(32, 54), bytes(64, 55), now),
    ]);

    const deviceInsert = (rawSigningKey: string) =>
      env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO devices (
           vault_id, device_id, signing_public_key_raw, agreement_public_key_raw,
           status, added_in_manifest_version, created_at
         ) VALUES (?1, ?2, ?3, ?4, 'active', 2, ?5)`,
      )
        .bind(vaultId, deviceId, rawSigningKey, agreementKey, now)
        .run();
    await expect(deviceInsert(rawP256PublicKey(56))).rejects.toThrow(
      /exact device manifest membership missing/u,
    );
    await deviceInsert(signingKey);
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        'SELECT COUNT(*) AS count FROM devices WHERE vault_id = ?1 AND device_id = ?2',
      )
        .bind(vaultId, deviceId)
        .first<number>('count'),
    ).toBe(1);
  });

  it('binds a pairing envelope to the request vault and new device', async () => {
    const now = 1_000_000;
    await seedVaultAndDevice(env, now);
    await env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO pairing_requests (
         pairing_request_id, vault_id, new_device_id, new_signing_public_key_raw,
         new_agreement_public_key_raw, pairing_salt, pairing_claim_token_hash,
         polling_token_hash, created_at, expires_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(
        opaqueId(10),
        SEEDED_VAULT_ID,
        opaqueId(11),
        rawP256PublicKey(12),
        rawP256PublicKey(13),
        bytes(32, 1),
        bytes(32, 2),
        bytes(32, 3),
        now,
        now + 300_000,
      )
      .run();

    await expect(
      env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO pairing_envelopes (
           envelope_id, pairing_request_id, vault_id, new_device_id,
           authorizing_device_id, key_epoch, crypto_suite,
           canonical_envelope, envelope_hash, candidate_manifest,
           candidate_manifest_hash, created_at, expires_at, retention_expires_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
        .bind(
          opaqueId(14),
          opaqueId(10),
          SEEDED_VAULT_ID,
          opaqueId(15),
          SEEDED_DEVICE_ID,
          'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1',
          '{}',
          bytes(32, 4),
          '{}',
          bytes(32, 5),
          now,
          now + 300_000,
          now + 600_000,
        )
        .run(),
    ).rejects.toThrow();
  });
});
