/**
 * Synthetic test data. Not based on any real person's financial records.
 *
 * Deterministic source for public documentation screenshots. Keep the JSON
 * serializable so the asset generator can import it through Mirna's real
 * backup-recovery flow without accessing any developer or production database.
 */
import { z } from 'zod';
import { financeDataSchema } from '@/domain/schemas';
import rawFixture from './readmeDemoFixture.json';

const readmeDemoFixtureSchema = z.object({
  syntheticDataNotice: z.literal(
    "Synthetic test data. Not based on any real person's financial records.",
  ),
  frozenAt: z.iso.datetime(),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  data: financeDataSchema,
});

export const readmeDemoFixture = readmeDemoFixtureSchema.parse(rawFixture);
