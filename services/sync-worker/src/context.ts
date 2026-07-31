import type { Env } from './env';

export interface RequestContext {
  request: Request;
  env: Env;
  requestId: string;
  allowedOrigin: string | null;
}
