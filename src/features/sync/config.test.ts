import { describe, expect, it } from 'vitest';
import { parseSyncApiOrigin, readSyncClientConfig, SyncConfigurationError } from './config';

describe('sync client configuration', () => {
  it.each([{}, { VITE_MIRNA_SYNC_ENABLED: '' }, { VITE_MIRNA_SYNC_ENABLED: 'false' }])(
    'is disabled by default without requiring an API URL',
    (environment) => {
      expect(readSyncClientConfig(environment)).toEqual({ enabled: false, apiOrigin: null });
    },
  );

  it('accepts only an exact HTTPS staging origin when enabled', () => {
    expect(
      readSyncClientConfig({
        VITE_MIRNA_SYNC_ENABLED: 'true',
        VITE_MIRNA_SYNC_API_URL: 'https://mirna-sync-staging.example.workers.dev',
        VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
        VITE_MIRNA_APP_ENV: 'beta',
        VITE_MIRNA_BETA_ONLY: 'true',
      }),
    ).toEqual({
      enabled: true,
      apiOrigin: 'https://mirna-sync-staging.example.workers.dev',
      turnstileSiteKey: '1x00000000000000000000AA',
      appEnvironment: 'beta',
      betaOnly: true,
    });
  });

  it('allows explicit HTTP only for localhost development', () => {
    expect(parseSyncApiOrigin('http://localhost:8787')).toBe('http://localhost:8787');
    expect(() => parseSyncApiOrigin('http://127.0.0.1:8787')).toThrow(SyncConfigurationError);
    expect(() => parseSyncApiOrigin('http://sync.example.test')).toThrow(SyncConfigurationError);
  });

  it.each([
    'https://user@example.test',
    'https://example.test/path',
    'https://example.test?target=other',
    'https://example.test#fragment',
    'https://example.test/',
    ' https://example.test',
    'ftp://example.test',
  ])('rejects a non-origin or ambiguous API URL: %s', (candidate) => {
    expect(() => parseSyncApiOrigin(candidate)).toThrow(SyncConfigurationError);
  });

  it('fails closed for mistyped flags and a missing URL', () => {
    expect(() => readSyncClientConfig({ VITE_MIRNA_SYNC_ENABLED: 'TRUE' })).toThrow(
      SyncConfigurationError,
    );
    expect(() => readSyncClientConfig({ VITE_MIRNA_SYNC_ENABLED: 'true' })).toThrow(
      SyncConfigurationError,
    );
    expect(() =>
      readSyncClientConfig({
        VITE_MIRNA_SYNC_ENABLED: 'true',
        VITE_MIRNA_SYNC_API_URL: 'https://sync.example.test',
        VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
        VITE_MIRNA_APP_ENV: 'production',
        VITE_MIRNA_BETA_ONLY: 'true',
      }),
    ).toThrow(SyncConfigurationError);
  });
});
