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

export interface AccountingFailureDetails {
  readonly category: AccountingCategory;
  readonly phase: 'request-reservation' | 'route-reservation' | 'settlement';
  readonly route: string;
  readonly businessCommitted: boolean;
  readonly serviceFlagsChanged: boolean;
  readonly workerBuild: string;
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
