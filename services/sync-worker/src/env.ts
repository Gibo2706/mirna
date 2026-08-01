/**
 * Wrangler owns the complete binding inventory in worker-configuration.d.ts.
 * Runtime configuration readers validate the string values they consume.
 */
export type Env = SyncWorkerEnv & {
  /** Secret binding set only through `.dev.vars` or `wrangler secret put`. */
  readonly TURNSTILE_SECRET_KEY?: string;
};
