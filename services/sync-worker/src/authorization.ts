import type { VaultManifestV1 } from '../../../src/domain/sync/schemas';
import { forbidden } from './errors';
import type { WorkerLimits } from './limits';

const MAX_PAST_SKEW_MS = 10 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1_000;

/** Enforces server-time bounds on the one device affected by a grant transition. */
export const assertFreshDeviceAuthorization = (
  manifest: VaultManifestV1,
  now: number,
  limits: WorkerLimits,
): void => {
  const affected = manifest.devices.find(
    (device) => device.deviceId === manifest.transition.affectedDeviceId,
  );
  const occurredAt = Date.parse(manifest.transition.occurredAt);
  const authorizedAt = affected ? Date.parse(affected.authorizedAt) : Number.NaN;
  const expiresAt = affected ? Date.parse(affected.authorizationExpiresAt) : Number.NaN;
  if (
    !affected ||
    occurredAt !== authorizedAt ||
    authorizedAt < now - MAX_PAST_SKEW_MS ||
    authorizedAt > now + MAX_FUTURE_SKEW_MS ||
    expiresAt <= now ||
    expiresAt - authorizedAt > limits.deviceAuthorizationLifetimeMs ||
    expiresAt > now + limits.deviceAuthorizationLifetimeMs + MAX_FUTURE_SKEW_MS
  ) {
    throw forbidden(
      'AUTHORIZATION_WINDOW_INVALID',
      'Device authorization timestamps are outside the allowed window.',
    );
  }
};
