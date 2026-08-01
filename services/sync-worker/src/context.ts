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
    kind: 'vault-create';
    committed: true;
    reconciled: boolean;
  }>;
}
