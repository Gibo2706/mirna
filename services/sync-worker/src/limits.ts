import type { Env } from './env';

const parseBoundedInteger = (
  value: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

export interface WorkerLimits {
  challengeLifetimeMs: number;
  accessSessionLifetimeMs: number;
  pairingLifetimeMs: number;
  maxActivePairingsPerVault: number;
  maxDevicesPerVault: number;
  maxRecoveryAttempts: number;
  deviceAuthorizationLifetimeMs: number;
  maxTotalVaults: number;
  maxTotalPairingRequests: number;
  maxActiveAuthChallengesPerDevice: number;
  maxActiveSessionsPerDevice: number;
  maxSnapshotBytes: number;
  maxRetainedSnapshots: number;
  orphanLifetimeMs: number;
  maxOperationsPerVault: number;
}

export const readWorkerLimits = (env: Env): WorkerLimits => ({
  challengeLifetimeMs:
    parseBoundedInteger(env.MIRNA_CHALLENGE_LIFETIME_SECONDS, 120, 30, 300) * 1_000,
  accessSessionLifetimeMs:
    parseBoundedInteger(env.MIRNA_ACCESS_SESSION_LIFETIME_SECONDS, 900, 60, 1_800) * 1_000,
  pairingLifetimeMs: parseBoundedInteger(env.MIRNA_PAIRING_LIFETIME_SECONDS, 300, 60, 600) * 1_000,
  maxActivePairingsPerVault: parseBoundedInteger(env.MIRNA_MAX_ACTIVE_PAIRINGS_PER_VAULT, 3, 1, 5),
  maxDevicesPerVault: parseBoundedInteger(env.MIRNA_MAX_DEVICES_PER_VAULT, 10, 1, 10),
  maxRecoveryAttempts: parseBoundedInteger(env.MIRNA_MAX_RECOVERY_ATTEMPTS, 5, 1, 10),
  deviceAuthorizationLifetimeMs:
    parseBoundedInteger(
      env.MIRNA_DEVICE_AUTHORIZATION_LIFETIME_SECONDS,
      30 * 24 * 60 * 60,
      24 * 60 * 60,
      30 * 24 * 60 * 60,
    ) * 1_000,
  maxTotalVaults: parseBoundedInteger(env.MIRNA_MAX_TOTAL_VAULTS, 1_000, 10, 10_000),
  maxTotalPairingRequests: parseBoundedInteger(
    env.MIRNA_MAX_TOTAL_PAIRING_REQUESTS,
    5_000,
    100,
    50_000,
  ),
  maxActiveAuthChallengesPerDevice: parseBoundedInteger(
    env.MIRNA_MAX_ACTIVE_AUTH_CHALLENGES_PER_DEVICE,
    5,
    1,
    10,
  ),
  maxActiveSessionsPerDevice: parseBoundedInteger(
    env.MIRNA_MAX_ACTIVE_SESSIONS_PER_DEVICE,
    5,
    1,
    10,
  ),
  maxSnapshotBytes: parseBoundedInteger(
    env.MIRNA_MAX_SNAPSHOT_BYTES,
    8 * 1_024 * 1_024,
    1_024,
    8 * 1_024 * 1_024,
  ),
  maxRetainedSnapshots: parseBoundedInteger(env.MIRNA_MAX_RETAINED_SNAPSHOTS, 3, 1, 10),
  orphanLifetimeMs:
    parseBoundedInteger(env.MIRNA_ORPHAN_LIFETIME_SECONDS, 3_600, 60, 86_400) * 1_000,
  maxOperationsPerVault: parseBoundedInteger(
    env.MIRNA_MAX_OPERATIONS_PER_VAULT,
    10_000,
    100,
    100_000,
  ),
});
