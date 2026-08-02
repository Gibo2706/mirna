import type { MeteredUsage } from './config/staging-budgets';

export const ROUTE_BUDGET_REGISTRY_VERSION = '2026-08-02.1' as const;

export type BudgetAccess = 'read' | 'diagnostic' | 'write' | 'new-vault' | 'pairing-retry';

export type RateLimitBindingName =
  | 'MIRNA_HEALTH_RATE_LIMITER'
  | 'MIRNA_SETUP_RATE_LIMITER'
  | 'MIRNA_PAIRING_CREATE_RATE_LIMITER'
  | 'MIRNA_PAIRING_ACTION_RATE_LIMITER'
  | 'MIRNA_AUTH_CHALLENGE_RATE_LIMITER'
  | 'MIRNA_AUTH_SESSION_RATE_LIMITER'
  | 'MIRNA_RECOVERY_INIT_RATE_LIMITER'
  | 'MIRNA_RECOVERY_ACTION_RATE_LIMITER'
  | 'MIRNA_SYNC_READ_RATE_LIMITER'
  | 'MIRNA_SNAPSHOT_UPLOAD_RATE_LIMITER'
  | 'MIRNA_OPERATION_WRITE_RATE_LIMITER'
  | 'MIRNA_DIAGNOSTICS_RATE_LIMITER';

export type RouteBodyPolicy = 'none' | 'json' | 'binary';

const JSON_BODY_BYTES = 160 * 1_024;
const DIAGNOSTIC_BODY_BYTES = 2_048;
const SNAPSHOT_BODY_BYTES = 8 * 1_024 * 1_024;

const usage = (
  d1RowsRead: number,
  d1RowsWritten: number,
  r2ClassA = 0,
  r2ClassB = 0,
): MeteredUsage =>
  Object.freeze({ workerRequests: 0, d1RowsRead, d1RowsWritten, r2ClassA, r2ClassB });

export interface ApiRouteDefinition {
  readonly id: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly pathTemplate: string;
  readonly samplePath: string;
  readonly matcher: RegExp;
  readonly parameterNames: readonly string[];
  readonly access: BudgetAccess;
  readonly rateLimit: RateLimitBindingName;
  readonly bodyPolicy: RouteBodyPolicy;
  readonly maxBodyBytes: number;
  readonly usage: MeteredUsage;
  readonly bound: string;
  readonly conformanceCases: readonly string[];
}

const exact = (path: string): RegExp =>
  new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u');

const opaqueId = '[A-Za-z0-9_-]{22}';

/**
 * Single source of truth for every public protocol route. Routing, method
 * discovery, edge limiting and accounting all consume these descriptors; a
 * sensitive path can no longer inherit a generic read/write budget.
 */
export const API_ROUTE_REGISTRY = Object.freeze([
  {
    id: 'health',
    method: 'GET',
    pathTemplate: '/v1/health',
    samplePath: '/v1/health',
    matcher: exact('/v1/health'),
    parameterNames: [],
    access: 'read',
    rateLimit: 'MIRNA_HEALTH_RATE_LIMITER',
    bodyPolicy: 'none',
    maxBodyBytes: 0,
    usage: usage(0, 0, 0, 1),
    bound: 'Health bypasses the ledger and performs one D1 reachability read plus one R2 head.',
    conformanceCases: ['healthy', 'accounting-fault', 'storage-unavailable'],
  },
  {
    id: 'beta-diagnostics',
    method: 'POST',
    pathTemplate: '/v1/diagnostics/events',
    samplePath: '/v1/diagnostics/events',
    matcher: exact('/v1/diagnostics/events'),
    parameterNames: [],
    access: 'diagnostic',
    rateLimit: 'MIRNA_DIAGNOSTICS_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: DIAGNOSTIC_BODY_BYTES,
    usage: usage(2_048, 32),
    bound: 'Indexed support/vault counters stop at 200/1,000 daily events; one event is inserted.',
    conformanceCases: ['anonymous', 'authenticated', 'daily-cap'],
  },
  {
    id: 'vault-create',
    method: 'POST',
    pathTemplate: '/v1/vaults',
    samplePath: '/v1/vaults',
    matcher: exact('/v1/vaults'),
    parameterNames: [],
    access: 'new-vault',
    rateLimit: 'MIRNA_SETUP_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(2_048, 128),
    bound: 'Five-row genesis batch, exact retry, capped vault count and two Turnstile events.',
    conformanceCases: ['new', 'exact-retry', 'idempotency-conflict', 'vault-cap'],
  },
  {
    id: 'vault-delete-init',
    method: 'DELETE',
    pathTemplate: '/v1/vault',
    samplePath: '/v1/vault',
    matcher: exact('/v1/vault'),
    parameterNames: [],
    access: 'write',
    rateLimit: 'MIRNA_RECOVERY_ACTION_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(1_024, 256),
    bound: 'Only authenticates and creates a deletion tombstone; bounded cleanup runs on cron.',
    conformanceCases: ['new-job', 'exact-retry', 'authorization-rejected'],
  },
  {
    id: 'auth-challenge',
    method: 'POST',
    pathTemplate: '/v1/auth/challenge',
    samplePath: '/v1/auth/challenge',
    matcher: exact('/v1/auth/challenge'),
    parameterNames: [],
    access: 'write',
    rateLimit: 'MIRNA_AUTH_CHALLENGE_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(128, 32),
    bound: 'One indexed device/grant lookup and at most five active challenges per device.',
    conformanceCases: ['new', 'active-cap', 'unauthorized-device'],
  },
  {
    id: 'auth-session',
    method: 'POST',
    pathTemplate: '/v1/auth/session',
    samplePath: '/v1/auth/session',
    matcher: exact('/v1/auth/session'),
    parameterNames: [],
    access: 'write',
    rateLimit: 'MIRNA_AUTH_SESSION_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(256, 64),
    bound: 'One challenge transition and at most five active sessions per device.',
    conformanceCases: ['new', 'challenge-retry', 'session-cap'],
  },
  {
    id: 'pairing-create',
    method: 'POST',
    pathTemplate: '/v1/pairings',
    samplePath: '/v1/pairings',
    matcher: exact('/v1/pairings'),
    parameterNames: [],
    access: 'pairing-retry',
    rateLimit: 'MIRNA_PAIRING_CREATE_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(2_048, 64),
    bound: 'Indexed device lookup, O(1) total counter, one insert and two Turnstile diagnostics.',
    conformanceCases: ['new', 'exact-retry', 'idempotency-conflict', 'global-cap'],
  },
  {
    id: 'pairing-inspect',
    method: 'POST',
    pathTemplate: '/v1/pairings/{pairingRequestId}/inspect',
    samplePath: '/v1/pairings/AAAAAAAAAAAAAAAAAAAAAA/inspect',
    matcher: new RegExp(`^/v1/pairings/(${opaqueId})/inspect$`, 'u'),
    parameterNames: ['pairingRequestId'],
    access: 'pairing-retry',
    rateLimit: 'MIRNA_PAIRING_ACTION_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(128, 32),
    bound: 'Primary-key lookup and at most one bounded failed-attempt state update.',
    conformanceCases: ['valid', 'wrong-claim', 'locked', 'expired'],
  },
  {
    id: 'pairing-approve',
    method: 'POST',
    pathTemplate: '/v1/pairings/{pairingRequestId}/approve',
    samplePath: '/v1/pairings/AAAAAAAAAAAAAAAAAAAAAA/approve',
    matcher: new RegExp(`^/v1/pairings/(${opaqueId})/approve$`, 'u'),
    parameterNames: ['pairingRequestId'],
    access: 'pairing-retry',
    rateLimit: 'MIRNA_PAIRING_ACTION_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(1_024, 256),
    bound:
      'Ten-device manifest, three active pairings, challenge consume and atomic approval/envelope batch.',
    conformanceCases: ['normal', 'max-devices', 'exact-retry', 'revoked-approver'],
  },
  {
    id: 'pairing-poll',
    method: 'POST',
    pathTemplate: '/v1/pairings/{pairingRequestId}/poll',
    samplePath: '/v1/pairings/AAAAAAAAAAAAAAAAAAAAAA/poll',
    matcher: new RegExp(`^/v1/pairings/(${opaqueId})/poll$`, 'u'),
    parameterNames: ['pairingRequestId'],
    access: 'read',
    rateLimit: 'MIRNA_PAIRING_ACTION_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(128, 8),
    bound: 'One indexed pairing/envelope read; no business write.',
    conformanceCases: ['pending', 'approved', 'consumed', 'cancelled', 'expired'],
  },
  {
    id: 'pairing-cancel',
    method: 'POST',
    pathTemplate: '/v1/pairings/{pairingRequestId}/cancel',
    samplePath: '/v1/pairings/AAAAAAAAAAAAAAAAAAAAAA/cancel',
    matcher: new RegExp(`^/v1/pairings/(${opaqueId})/cancel$`, 'u'),
    parameterNames: ['pairingRequestId'],
    access: 'pairing-retry',
    rateLimit: 'MIRNA_PAIRING_ACTION_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(128, 32),
    bound: 'One indexed token lookup and at most one status update; exact retry is read-only.',
    conformanceCases: ['pending', 'approved', 'exact-retry', 'expired'],
  },
  {
    id: 'pairing-finalize',
    method: 'POST',
    pathTemplate: '/v1/pairings/{pairingRequestId}/finalize',
    samplePath: '/v1/pairings/AAAAAAAAAAAAAAAAAAAAAA/finalize',
    matcher: new RegExp(`^/v1/pairings/(${opaqueId})/finalize$`, 'u'),
    parameterNames: ['pairingRequestId'],
    access: 'pairing-retry',
    rateLimit: 'MIRNA_PAIRING_ACTION_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(1_024, 256),
    bound:
      'Ten-device manifest validation and atomic six-statement device/grant/manifest transition.',
    conformanceCases: ['normal', 'exact-retry', 'payload-conflict', 'stale-manifest'],
  },
  {
    id: 'recovery-challenge',
    method: 'POST',
    pathTemplate: '/v1/recovery/challenge',
    samplePath: '/v1/recovery/challenge',
    matcher: exact('/v1/recovery/challenge'),
    parameterNames: [],
    access: 'write',
    rateLimit: 'MIRNA_RECOVERY_INIT_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(1_024, 64),
    bound: 'Indexed recovery lookup, five-attempt lockout and one challenge insert.',
    conformanceCases: ['new', 'attempt-cap', 'locked'],
  },
  {
    id: 'recovery-bundle',
    method: 'POST',
    pathTemplate: '/v1/recovery/bundle',
    samplePath: '/v1/recovery/bundle',
    matcher: exact('/v1/recovery/bundle'),
    parameterNames: [],
    access: 'write',
    rateLimit: 'MIRNA_RECOVERY_ACTION_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(256, 32),
    bound: 'One indexed recovery challenge and bundle read with bounded attempt update.',
    conformanceCases: ['valid', 'wrong-proof', 'expired'],
  },
  {
    id: 'recovery-snapshot',
    method: 'POST',
    pathTemplate: '/v1/recovery/snapshot',
    samplePath: '/v1/recovery/snapshot',
    matcher: exact('/v1/recovery/snapshot'),
    parameterNames: [],
    access: 'write',
    rateLimit: 'MIRNA_RECOVERY_ACTION_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(256, 32, 0, 1),
    bound: 'One indexed recovery authorization read and at most one R2 snapshot get.',
    conformanceCases: ['with-snapshot', 'without-snapshot', 'invalid-proof'],
  },
  {
    id: 'recovery-complete',
    method: 'POST',
    pathTemplate: '/v1/vaults/{vaultId}/recover',
    samplePath: '/v1/vaults/AAAAAAAAAAAAAAAAAAAAAA/recover',
    matcher: new RegExp(`^/v1/vaults/(${opaqueId})/recover$`, 'u'),
    parameterNames: ['vaultId'],
    access: 'write',
    rateLimit: 'MIRNA_RECOVERY_ACTION_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(2_048, 512),
    bound:
      'Ten devices, at most fifty live sessions, three live pairings and three retained snapshots.',
    conformanceCases: ['normal', 'exact-retry', 'active-row-caps', 'stale-manifest'],
  },
  {
    id: 'operation-upload',
    method: 'POST',
    pathTemplate: '/v1/operations',
    samplePath: '/v1/operations',
    matcher: exact('/v1/operations'),
    parameterNames: [],
    access: 'write',
    rateLimit: 'MIRNA_OPERATION_WRITE_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(8_192, 64),
    bound: 'Indexed sequence/count checks are bounded by 5,000 uncompacted operations.',
    conformanceCases: ['new', 'exact-retry', 'operation-cap', 'sequence-conflict'],
  },
  {
    id: 'changes-read',
    method: 'GET',
    pathTemplate: '/v1/changes',
    samplePath: '/v1/changes',
    matcher: exact('/v1/changes'),
    parameterNames: [],
    access: 'read',
    rateLimit: 'MIRNA_SYNC_READ_RATE_LIMITER',
    bodyPolicy: 'none',
    maxBodyBytes: 0,
    usage: usage(192, 8),
    bound: 'At most 101 indexed change rows plus authentication/session touch.',
    conformanceCases: ['empty', 'limit-100', 'invalid-cursor'],
  },
  {
    id: 'changes-ack',
    method: 'POST',
    pathTemplate: '/v1/acks',
    samplePath: '/v1/acks',
    matcher: exact('/v1/acks'),
    parameterNames: [],
    access: 'write',
    rateLimit: 'MIRNA_OPERATION_WRITE_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(8_192, 5_128),
    bound: 'Compaction is capped at 5,000 operations and ten device acknowledgement frontiers.',
    conformanceCases: ['empty', 'five-thousand-operations', 'stale-ack'],
  },
  {
    id: 'key-envelope-current',
    method: 'GET',
    pathTemplate: '/v1/key-epochs/current',
    samplePath: '/v1/key-epochs/current',
    matcher: exact('/v1/key-epochs/current'),
    parameterNames: [],
    access: 'read',
    rateLimit: 'MIRNA_SYNC_READ_RATE_LIMITER',
    bodyPolicy: 'none',
    maxBodyBytes: 0,
    usage: usage(128, 8),
    bound: 'Authenticated device plus one current-epoch envelope lookup.',
    conformanceCases: ['present', 'missing', 'revoked-device'],
  },
  {
    id: 'key-envelope-by-epoch',
    method: 'GET',
    pathTemplate: '/v1/key-epochs/{keyEpoch}',
    samplePath: '/v1/key-epochs/1',
    matcher: /^\/v1\/key-epochs\/([1-9][0-9]*)$/u,
    parameterNames: ['keyEpoch'],
    access: 'read',
    rateLimit: 'MIRNA_SYNC_READ_RATE_LIMITER',
    bodyPolicy: 'none',
    maxBodyBytes: 0,
    usage: usage(128, 8),
    bound: 'Authenticated device plus one exact epoch envelope lookup.',
    conformanceCases: ['present', 'missing', 'invalid-epoch'],
  },
  {
    id: 'manifest-changes',
    method: 'GET',
    pathTemplate: '/v1/manifests',
    samplePath: '/v1/manifests',
    matcher: exact('/v1/manifests'),
    parameterNames: [],
    access: 'read',
    rateLimit: 'MIRNA_SYNC_READ_RATE_LIMITER',
    bodyPolicy: 'none',
    maxBodyBytes: 0,
    usage: usage(160, 8),
    bound: 'At most 26 indexed manifest rows are inspected and 25 returned.',
    conformanceCases: ['empty', 'page-25', 'invalid-version'],
  },
  {
    id: 'manifest-current',
    method: 'GET',
    pathTemplate: '/v1/vault/manifest',
    samplePath: '/v1/vault/manifest',
    matcher: exact('/v1/vault/manifest'),
    parameterNames: [],
    access: 'read',
    rateLimit: 'MIRNA_SYNC_READ_RATE_LIMITER',
    bodyPolicy: 'none',
    maxBodyBytes: 0,
    usage: usage(128, 8),
    bound: 'Authenticated device and one exact current manifest lookup.',
    conformanceCases: ['present', 'missing', 'revoked-device'],
  },
  {
    id: 'snapshot-current',
    method: 'GET',
    pathTemplate: '/v1/snapshots/current',
    samplePath: '/v1/snapshots/current',
    matcher: exact('/v1/snapshots/current'),
    parameterNames: [],
    access: 'read',
    rateLimit: 'MIRNA_SYNC_READ_RATE_LIMITER',
    bodyPolicy: 'none',
    maxBodyBytes: 0,
    usage: usage(128, 8, 0, 1),
    bound: 'One current snapshot metadata row and at most one R2 get.',
    conformanceCases: ['present', 'missing', 'r2-missing'],
  },
  {
    id: 'snapshot-upload',
    method: 'PUT',
    pathTemplate: '/v1/snapshots/{snapshotId}',
    samplePath: '/v1/snapshots/AAAAAAAAAAAAAAAAAAAAAA',
    matcher: new RegExp(`^/v1/snapshots/(${opaqueId})$`, 'u'),
    parameterNames: ['snapshotId'],
    access: 'write',
    rateLimit: 'MIRNA_SNAPSHOT_UPLOAD_RATE_LIMITER',
    bodyPolicy: 'binary',
    maxBodyBytes: SNAPSHOT_BODY_BYTES,
    usage: usage(512, 128, 1, 1),
    bound:
      'Three retained snapshots, one R2 put/head path and bounded idempotent metadata transition.',
    conformanceCases: ['new', 'exact-retry', 'retention-cap', 'r2-failure'],
  },
  {
    id: 'device-renew',
    method: 'POST',
    pathTemplate: '/v1/devices/{deviceId}/renew',
    samplePath: '/v1/devices/AAAAAAAAAAAAAAAAAAAAAA/renew',
    matcher: new RegExp(`^/v1/devices/(${opaqueId})/renew$`, 'u'),
    parameterNames: ['deviceId'],
    access: 'write',
    rateLimit: 'MIRNA_RECOVERY_ACTION_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(4_096, 512),
    bound: 'Ten-device manifest transition, exact retry and bounded security-envelope publication.',
    conformanceCases: ['normal', 'exact-retry', 'stale-manifest', 'expired-device'],
  },
  {
    id: 'device-revoke',
    method: 'POST',
    pathTemplate: '/v1/devices/{deviceId}/revoke',
    samplePath: '/v1/devices/AAAAAAAAAAAAAAAAAAAAAA/revoke',
    matcher: new RegExp(`^/v1/devices/(${opaqueId})/revoke$`, 'u'),
    parameterNames: ['deviceId'],
    access: 'write',
    rateLimit: 'MIRNA_RECOVERY_ACTION_RATE_LIMITER',
    bodyPolicy: 'json',
    maxBodyBytes: JSON_BODY_BYTES,
    usage: usage(4_096, 1_024),
    bound:
      'Ten devices, fifty live sessions, three live pairings and bounded key-envelope revocation.',
    conformanceCases: ['normal', 'exact-retry', 'active-row-caps', 'last-device-rejected'],
  },
] as const satisfies readonly ApiRouteDefinition[]);

export type ApiRouteId = (typeof API_ROUTE_REGISTRY)[number]['id'];

export interface MatchedApiRoute {
  readonly definition: (typeof API_ROUTE_REGISTRY)[number];
  readonly parameters: Readonly<Record<string, string>>;
}

export const matchApiPath = (pathname: string): readonly MatchedApiRoute[] =>
  API_ROUTE_REGISTRY.flatMap((definition) => {
    const match = definition.matcher.exec(pathname);
    if (!match) return [];
    return [
      {
        definition,
        parameters: Object.freeze(
          Object.fromEntries(
            definition.parameterNames.map((name, index) => [name, match[index + 1] ?? '']),
          ),
        ),
      },
    ];
  });

export const matchApiRoute = (method: string, pathname: string): MatchedApiRoute | null =>
  matchApiPath(pathname).find(({ definition }) => definition.method === method) ?? null;

export const matchApiRequest = (request: Request): MatchedApiRoute | null => {
  const pathname = new URL(request.url).pathname;
  return matchApiRoute(request.method, pathname);
};

export const allowedMethodsForRegisteredPath = (pathname: string): readonly string[] | null => {
  const methods = [...new Set(matchApiPath(pathname).map(({ definition }) => definition.method))];
  return methods.length === 0 ? null : Object.freeze(methods);
};

export const routeRegistryIsConformant = (): boolean => {
  const identities = new Set<string>();
  for (const definition of API_ROUTE_REGISTRY) {
    const identity = `${definition.method} ${definition.pathTemplate}`;
    if (
      identities.has(identity) ||
      matchApiRoute(definition.method, definition.samplePath)?.definition.id !== definition.id ||
      (definition.conformanceCases as readonly string[]).length === 0 ||
      definition.maxBodyBytes < 0
    ) {
      return false;
    }
    identities.add(identity);
  }
  return identities.size === API_ROUTE_REGISTRY.length;
};
