import type { Env } from './env';
import type { RouteUsageMeter } from './metering';

export interface RequestContext {
  request: Request;
  env: Env;
  accountingEnv?: Env;
  requestId: string;
  allowedOrigin: string | null;
  budgetReservationIds?: string[];
  usageMeter?: RouteUsageMeter;
  businessCommit?: Readonly<{
    kind:
      | 'vault-create'
      | 'pairing-create'
      | 'pairing-inspect-lockout'
      | 'pairing-approve'
      | 'pairing-cancel'
      | 'pairing-finalize'
      | 'vault-delete-init';
    committed: true;
    reconciled: boolean;
  }>;
}

export const markBusinessCommit = (
  context: RequestContext,
  kind: NonNullable<RequestContext['businessCommit']>['kind'],
  reconciled = false,
): void => {
  context.businessCommit = Object.freeze({ kind, committed: true, reconciled });
};
