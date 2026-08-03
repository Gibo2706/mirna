export interface SyncEnvironment {
  readonly VITE_MIRNA_SYNC_ENABLED?: string;
  readonly VITE_MIRNA_SYNC_API_URL?: string;
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  readonly VITE_MIRNA_APP_ENV?: string;
  readonly VITE_MIRNA_BETA_ONLY?: string;
}

export type SyncClientConfig =
  | Readonly<{
      enabled: false;
      apiOrigin: null;
    }>
  | Readonly<{
      enabled: true;
      apiOrigin: string;
      turnstileSiteKey: string;
      appEnvironment: 'beta' | 'local-beta';
      betaOnly: true;
    }>;

export class SyncConfigurationError extends Error {
  constructor() {
    super('Podešavanje beta sinhronizacije nije ispravno.');
    this.name = 'SyncConfigurationError';
  }
}

export const isBetaApplication = (
  environment: SyncEnvironment = import.meta.env as unknown as SyncEnvironment,
): boolean =>
  environment.VITE_MIRNA_BETA_ONLY === 'true' &&
  (environment.VITE_MIRNA_APP_ENV === 'beta' || environment.VITE_MIRNA_APP_ENV === 'local-beta');

const isLocalhost = (url: URL): boolean => url.hostname === 'localhost';

/**
 * Accepts an origin, not a general URL. Keeping this strict prevents a staging
 * configuration typo from silently moving credentials or request bodies to a
 * different path, origin or URL containing user information.
 */
export const parseSyncApiOrigin = (candidate: string): string => {
  if (candidate.length === 0 || candidate !== candidate.trim()) {
    throw new SyncConfigurationError();
  }

  try {
    const url = new URL(candidate);
    const secureTransport = url.protocol === 'https:';
    const allowedLocalTransport = url.protocol === 'http:' && isLocalhost(url);
    if (
      (!secureTransport && !allowedLocalTransport) ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.origin !== candidate
    ) {
      throw new SyncConfigurationError();
    }
    return url.origin;
  } catch (error) {
    if (error instanceof SyncConfigurationError) throw error;
    throw new SyncConfigurationError();
  }
};

export const readSyncClientConfig = (
  environment: SyncEnvironment = import.meta.env as unknown as SyncEnvironment,
): SyncClientConfig => {
  const enabledValue = environment.VITE_MIRNA_SYNC_ENABLED;
  if (enabledValue === undefined || enabledValue === '' || enabledValue === 'false') {
    return Object.freeze({ enabled: false, apiOrigin: null });
  }
  if (enabledValue !== 'true') throw new SyncConfigurationError();

  const apiUrl = environment.VITE_MIRNA_SYNC_API_URL;
  const siteKey = environment.VITE_TURNSTILE_SITE_KEY;
  const appEnvironment = environment.VITE_MIRNA_APP_ENV;
  if (
    apiUrl === undefined ||
    !siteKey ||
    !/^[A-Za-z0-9_-]{20,128}$/u.test(siteKey) ||
    (appEnvironment !== 'beta' && appEnvironment !== 'local-beta') ||
    environment.VITE_MIRNA_BETA_ONLY !== 'true'
  ) {
    throw new SyncConfigurationError();
  }
  return Object.freeze({
    enabled: true,
    apiOrigin: parseSyncApiOrigin(apiUrl),
    turnstileSiteKey: siteKey,
    appEnvironment,
    betaOnly: true,
  });
};
