import { z } from 'zod';
import { opaqueIdSchema, timestampSchema } from '@/domain/sync/schemas';
import { db, type FinanceDatabase } from '../database';
import type { SyncDeviceAliasRecord, SyncDeviceKind } from './records';

const deviceAliasSchema = z.strictObject({
  id: z.string().min(1).max(512),
  vaultId: opaqueIdSchema,
  deviceId: opaqueIdSchema,
  label: z.string().trim().min(1).max(80),
  kind: z.enum(['phone', 'computer', 'tablet', 'other']).optional(),
  updatedAt: timestampSchema,
});

export const syncDeviceAliasId = (vaultId: string, deviceId: string): string =>
  `${vaultId}:${deviceId}`;

export class SyncDeviceAliasRepository {
  constructor(private readonly database: FinanceDatabase = db) {}

  async list(vaultId: string): Promise<readonly SyncDeviceAliasRecord[]> {
    const records = await this.database.syncDeviceAliases
      .where('vaultId')
      .equals(vaultId)
      .toArray();
    return records.map((record) => deviceAliasSchema.parse(record));
  }

  async save(input: {
    readonly vaultId: string;
    readonly deviceId: string;
    readonly label: string;
    readonly kind?: SyncDeviceKind;
  }): Promise<SyncDeviceAliasRecord> {
    const record = deviceAliasSchema.parse({
      id: syncDeviceAliasId(input.vaultId, input.deviceId),
      vaultId: input.vaultId,
      deviceId: input.deviceId,
      label: input.label,
      kind: input.kind,
      updatedAt: new Date().toISOString(),
    });
    await this.database.syncDeviceAliases.put(record);
    return record;
  }
}
