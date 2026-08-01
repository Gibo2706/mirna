import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceDatabase, financeTables } from '@/db/database';
import { BetaDiagnosticsService, createSupportId } from './diagnostics';

const databaseNames: string[] = [];

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)));
});

describe('privacy-safe beta diagnostics', () => {
  it('creates a readable 128-bit Support ID and persists it only in IndexedDB', async () => {
    const name = `mirna-beta-diagnostics-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const database = new FinanceDatabase(name);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ accepted: true }));
    const first = new BetaDiagnosticsService('https://sync.invalid', { database, fetch: fetcher });
    const supportId = await first.supportId();
    expect(supportId).toMatch(/^MIRNA-(?:[0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/u);
    expect(createSupportId()).not.toBe(supportId);

    const reopened = new BetaDiagnosticsService('https://sync.invalid', {
      database,
      fetch: fetcher,
    });
    expect(await reopened.supportId()).toBe(supportId);
    expect(financeTables(database)).not.toContain(database.syncBetaSupport);
    expect(financeTables(database)).not.toContain(database.syncBetaDiagnosticEvents);
  });

  it('keeps only the newest 200 allowlisted local events and clears no Support ID', async () => {
    const name = `mirna-beta-diagnostics-ring-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const database = new FinanceDatabase(name);
    const service = new BetaDiagnosticsService('https://sync.invalid', {
      database,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ accepted: true })),
    });
    const supportId = await service.supportId();
    for (let index = 0; index < 205; index += 1) {
      await service.record({
        eventType: index % 2 === 0 ? 'turnstile_waiting' : 'turnstile_rejected',
        severity: index % 2 === 0 ? 'info' : 'error',
        action: 'mirna_vault_create',
        safeCode: index % 2 === 0 ? 'NONE' : 'HUMAN_VERIFICATION_REJECTED',
      });
    }
    const snapshot = await service.snapshot();
    expect(snapshot.events).toHaveLength(200);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /token|secret|recovery|amount|balance|description/iu,
    );

    await service.clear();
    expect((await service.snapshot()).events).toEqual([]);
    expect(await service.supportId()).toBe(supportId);
  });
});
