export interface SyncEnvironment {
  readonly VITE_MIRNA_SYNC_ENABLED?: string;
  readonly VITE_MIRNA_SYNC_API_URL?: string;
}

export type SyncClientConfig =
  | Readonly<{
      enabled: false;
      apiOrigin: null;
    }>
  | Readonly<{
      enabled: true;
      apiOrigin: string;
    }>;

export class SyncConfigurationError extends Error {
  constructor() {
    super('Podešavanje beta sinhronizacije nije ispravno.');
    this.name = 'SyncConfigurationError';
  }
}

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
  if (apiUrl === undefined) throw new SyncConfigurationError();
  return Object.freeze({ enabled: true, apiOrigin: parseSyncApiOrigin(apiUrl) });
};
