export type VerificationReason =
  | 'INVALID_INPUT_RESPONSE'
  | 'TIMEOUT_OR_DUPLICATE'
  | 'HOSTNAME_MISMATCH'
  | 'ACTION_MISMATCH'
  | 'SITEVERIFY_UNAVAILABLE'
  | 'CONFIGURATION_ERROR';

export type AccountingCategory =
  | 'SERVICE_QUOTA_EXHAUSTED'
  | 'VAULT_QUOTA_EXCEEDED'
  | 'SERVICE_MAINTENANCE'
  | 'USAGE_ACCOUNTING_UNAVAILABLE'
  | 'USAGE_RESERVATION_UNDERESTIMATED'
  | 'USAGE_SETTLEMENT_FAILED'
  | 'D1_STORAGE_LIMIT_REACHED';

export type AccountingReason =
  | 'FLAGS_READ_FAILED'
  | 'RESOURCE_TOTALS_READ_FAILED'
  | 'ROLLING_TOTALS_REFRESH_FAILED'
  | 'DAILY_BUCKET_INITIALIZATION_FAILED'
  | 'GLOBAL_RESERVATION_INSERT_FAILED'
  | 'VAULT_RESERVATION_INSERT_FAILED'
  | 'RESERVATION_BATCH_FAILED'
  | 'RESERVATION_CONSTRAINT_FAILED'
  | 'RESERVATION_RESULT_EMPTY'
  | 'RESERVATION_METADATA_INVALID'
  | 'SCHEMA_NOT_READY'
  | 'REQUIRED_ACCOUNTING_ROW_MISSING'
  | 'ACCOUNTING_FAULT_ACTIVE'
  | 'SERVICE_FLAGS_DISABLED'
  | 'HARD_LIMIT_REACHED'
  | 'D1_STORAGE_LIMIT_REACHED'
  | 'USAGE_RESERVATION_UNDERESTIMATED'
  | 'USAGE_SETTLEMENT_FAILED';

export interface AccountingFailureDetails {
  readonly category: AccountingCategory;
  readonly reason: AccountingReason;
  readonly phase: 'request-reservation' | 'route-reservation' | 'settlement';
  readonly route: string;
  readonly businessCommitted: boolean;
  readonly serviceFlagsChanged: boolean;
  readonly workerBuild: string;
  readonly faultRole: 'origin' | 'blocked' | 'none';
  readonly originRequestId?: string;
  readonly originRoute?: string;
  readonly lifecycleOperation: string;
  readonly businessWorkStarted: boolean;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly verificationReason?: VerificationReason,
    readonly accounting?: AccountingFailureDetails,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const conflict = (code: string, message: string): HttpError =>
  new HttpError(409, code, message);

export const forbidden = (code: string, message: string): HttpError =>
  new HttpError(403, code, message);

export const notFound = (): HttpError =>
  new HttpError(404, 'RESOURCE_NOT_FOUND', 'Resource was not found.');

export const unauthorized = (): HttpError =>
  new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
