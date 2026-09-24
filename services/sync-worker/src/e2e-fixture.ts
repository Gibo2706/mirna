import worker from './index';
import type { Env } from './env';

// This entrypoint is used only by the isolated local E2E Worker. Fixture
// writes use its D1 binding, so no second SQLite writer races workerd.
const fixtureWorker: ExportedHandler<Env> = {
  async fetch(request, env, context) {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/__e2e/query') {
      const payload: unknown = await request.json();
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('sql' in payload) ||
        typeof payload.sql !== 'string' ||
        payload.sql.length > 4_096 ||
        !/^\s*SELECT\b/iu.test(payload.sql) ||
        payload.sql.includes(';')
      )
        return new Response(null, { status: 400 });
      const result = await env.MIRNA_SYNC_DB.prepare(payload.sql).all();
      return Response.json(result.results);
    }
    if (request.method === 'POST' && path === '/__e2e/expire-pairing') {
      const payload: unknown = await request.json();
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('pairingRequestId' in payload) ||
        typeof payload.pairingRequestId !== 'string'
      )
        return new Response(null, { status: 400 });
      const result = await env.MIRNA_SYNC_DB.prepare(
        "UPDATE pairing_requests SET expires_at = created_at + 1 WHERE pairing_request_id = ?1 AND status = 'pending'",
      )
        .bind(payload.pairingRequestId)
        .run();
      return new Response(null, { status: result.meta.changes === 1 ? 204 : 409 });
    }
    if (request.method === 'POST' && path === '/__e2e/expire-grant') {
      const payload: unknown = await request.json();
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('vaultId' in payload) ||
        !('deviceId' in payload) ||
        typeof payload.vaultId !== 'string' ||
        typeof payload.deviceId !== 'string'
      )
        return new Response(null, { status: 400 });
      const result = await env.MIRNA_SYNC_DB.prepare(
        'UPDATE device_grants SET issued_at = 0, expires_at = 1 WHERE vault_id = ?1 AND device_id = ?2 AND revoked_at IS NULL',
      )
        .bind(payload.vaultId, payload.deviceId)
        .run();
      return new Response(null, { status: result.meta.changes === 1 ? 204 : 409 });
    }
    if (!worker.fetch) throw new Error('Production Worker fetch handler is unavailable.');
    return worker.fetch(request, env, context);
  },
  scheduled(controller, env, context) {
    return worker.scheduled?.(controller, env, context);
  },
};

export default fixtureWorker;
