import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { UsageBudgetController } from '../src/budget';
import type { RequestContext } from '../src/context';
import { allowedMethodsForPath } from '../src/router';
import {
  API_ROUTE_REGISTRY,
  ROUTE_BUDGET_REGISTRY_VERSION,
  matchApiRequest,
  matchApiRoute,
  routeRegistryIsConformant,
} from '../src/route-registry';

const requestContext = (method: string, path: string): RequestContext => ({
  request: new Request(`https://sync.invalid${path}`, { method }),
  env,
  accountingEnv: env,
  requestId: crypto.randomUUID(),
  allowedOrigin: 'http://localhost:5173',
  budgetReservationIds: [],
});

describe('route-budget registry conformance', () => {
  it('is the bidirectional inventory for all 27 Worker routes', () => {
    expect(ROUTE_BUDGET_REGISTRY_VERSION).toBe('2026-08-02.1');
    expect(API_ROUTE_REGISTRY).toHaveLength(27);
    expect(routeRegistryIsConformant()).toBe(true);
    expect(new Set(API_ROUTE_REGISTRY.map(({ id }) => id)).size).toBe(27);

    for (const route of API_ROUTE_REGISTRY) {
      const matched = matchApiRoute(route.method, route.samplePath);
      expect(matched?.definition.id, `${route.method} ${route.pathTemplate}`).toBe(route.id);
      expect(
        allowedMethodsForPath(new URL(route.samplePath, 'https://sync.invalid').pathname),
      ).toContain(route.method);
      expect(route.bound.length, route.id).toBeGreaterThan(24);
      expect(route.conformanceCases.length, route.id).toBeGreaterThan(0);
      for (const value of Object.values(route.usage)) {
        expect(Number.isSafeInteger(value), route.id).toBe(true);
        expect(value, route.id).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('has no generic sensitive-route fallback and rejects malformed dynamic paths', () => {
    for (const id of API_ROUTE_REGISTRY.map(({ id }) => id)) {
      expect(['sync-read', 'sync-write', 'pairing-action', 'recovery-action']).not.toContain(id);
    }
    for (const [method, path] of [
      ['GET', '/v1/not-a-route'],
      ['POST', '/v1/pairings/not-22/approve'],
      ['POST', '/v1/pairings/AAAAAAAAAAAAAAAAAAAAAA/unknown'],
      ['PUT', '/v1/snapshots/not-22'],
      ['GET', '/v1/key-epochs/0'],
      ['GET', '/v1/vaults/AAAAAAAAAAAAAAAAAAAAAA/recover'],
    ] as const) {
      expect(matchApiRequest(new Request(`https://sync.invalid${path}`, { method }))).toBeNull();
    }
  });

  it('does not create a route reservation for an unknown route or wrong method', async () => {
    const controller = new UsageBudgetController();
    for (const context of [
      requestContext('GET', '/v1/not-a-route'),
      requestContext('GET', '/v1/pairings'),
    ]) {
      await expect(controller.reserveRoute(context)).rejects.toMatchObject({
        status: 404,
        code: 'ROUTE_NOT_FOUND',
      });
      expect(
        await env.MIRNA_SYNC_DB.prepare(
          'SELECT COUNT(*) AS count FROM usage_reservations WHERE reservation_id = ?1',
        )
          .bind(`${context.requestId}:route`)
          .first<number>('count'),
      ).toBe(0);
    }
  });
});
