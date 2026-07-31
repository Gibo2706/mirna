import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ToastProvider';
import type { LocalSyncSetup } from '@/db/sync/records';
import { MorePage } from '@/pages/MorePage';
import { emptyFinanceData, settings } from '@/tests/factories';
import { SyncManager } from './SyncManager';
import type { SyncUiLocalStatus, SyncUiServices } from './ui-services';
import * as syncUiServices from './ui-services';

const supportedCapability = {
  supported: true,
  signingAfterReopen: true,
  agreementAfterReopen: true,
  encryptionAfterReopen: true,
  privateKeyExportRejected: true,
  localKeyExportRejected: true,
} as const;

const localSetup = (): LocalSyncSetup => {
  const now = '2026-07-31T10:00:00.000Z';
  const expiresAt = '2027-07-31T10:00:00.000Z';
  const deviceId = 'AAAAAAAAAAAAAAAAAAAAAA';
  return {
    vault: {
      id: 'active-sync-vault',
      vaultId: 'VVVVVVVVVVVVVVVVVVVVVV',
      protocolVersion: 1,
      cryptoSuite: 'MIRNA-P1-P256-HKDF-SHA256-AES256GCM-JCS',
      keyEpoch: 1,
      status: 'active',
      manifest: {
        protocolVersion: 1,
        suite: 'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1',
        vaultId: 'VVVVVVVVVVVVVVVVVVVVVV',
        manifestVersion: 1,
        keyEpoch: 1,
        devices: [
          {
            deviceId,
            publicKeys: {
              signing:
                'BAGXNCgB6vzgPi2P5Pq3JAFVxWl1LVn1x1kNjF1RzRrdH7zJwPVdnp8dAEqcRgCwZFd07KG1E6kR3kJhTlzYaqgDz9Y',
              agreement:
                'BAGXNCgB6vzgPi2P5Pq3JAFVxWl1LVn1x1kNjF1RzRrdH7zJwPVdnp8dAEqcRgCwZFd07KG1E6kR3kJhTlzYaqgDz9Y',
            },
            authorizedAt: now,
            authorizationExpiresAt: expiresAt,
          },
        ],
        revokedDevices: [],
        recoveryLookupId: 'RRRRRRRRRRRRRRRRRRRRRR',
        recoverySigningPublicKey:
          'BAGXNCgB6vzgPi2P5Pq3JAFVxWl1LVn1x1kNjF1RzRrdH7zJwPVdnp8dAEqcRgCwZFd07KG1E6kR3kJhTlzYaqgDz9Y',
        previousManifestHash: null,
        transition: {
          transitionId: 'TTTTTTTTTTTTTTTTTTTTTT',
          kind: 'create-vault',
          authorizationKind: 'device',
          authorizingDeviceId: deviceId,
          affectedDeviceId: deviceId,
          occurredAt: now,
        },
        signature:
          'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      } as unknown as LocalSyncSetup['vault']['manifest'],
      createdAt: now,
      updatedAt: now,
    },
    device: {
      id: 'local-sync-device',
      vaultId: 'VVVVVVVVVVVVVVVVVVVVVV',
      deviceId,
      displayName: 'Test uređaj',
      signingPrivateKey: {} as CryptoKey,
      signingPublicKey: {} as CryptoKey,
      agreementPrivateKey: {} as CryptoKey,
      agreementPublicKey: {} as CryptoKey,
      localWrappingKey: {} as CryptoKey,
      authorizationExpiresAt: expiresAt,
      createdAt: now,
      updatedAt: now,
    },
    vaultKey: {
      id: 'key',
      vaultId: 'VVVVVVVVVVVVVVVVVVVVVV',
      keyEpoch: 1,
      purpose: 'vault-master-key',
      encryptedKey: {} as LocalSyncSetup['vaultKey']['encryptedKey'],
      createdAt: now,
    },
    metadata: {
      id: 'sync-metadata',
      vaultId: 'VVVVVVVVVVVVVVVVVVVVVV',
      localSchemaVersion: 1,
      firstUploadConsent: 'pending',
      lastServerCursor: 0,
      lastSnapshotRevision: 0,
      lastSnapshotId: null,
      lastSnapshotHash: null,
      lastSnapshotContentHash: null,
      lastManifestHash: 'M'.repeat(43),
      lastLocalDataHash: null,
      enabledAt: now,
    },
  };
};

const unexpected = (): never => {
  throw new Error('Unexpected lifecycle call in test.');
};

const baseServices = (
  overrides: Partial<SyncUiServices> = {},
  initialStatus: SyncUiLocalStatus = { pendingConflictCount: 0 },
): SyncUiServices => ({
  probeCapability: vi.fn(() => Promise.resolve(supportedCapability)),
  loadLocalStatus: vi.fn(() => Promise.resolve(initialStatus)),
  disableLocalDevice: vi.fn(() => Promise.resolve()),
  clearSession: vi.fn(),
  synchronize: vi.fn(() => Promise.resolve({ kind: 'up-to-date' as const, revision: 1 })),
  createEnableLifecycle: unexpected,
  createNewDevicePairingLifecycle: unexpected,
  createExistingDevicePairingLifecycle: unexpected,
  createRecoveryLifecycle: unexpected,
  createQrDataUrl: vi.fn(() => Promise.resolve('data:image/png;base64,AA==')),
  copySecret: vi.fn(() => Promise.resolve()),
  downloadSecret: vi.fn(),
  printSecret: vi.fn(),
  ...overrides,
});

const renderManager = (services: SyncUiServices) =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <SyncManager services={services} />
      </ToastProvider>
    </MemoryRouter>,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Phase 1 sync UI', () => {
  it('requires recovery group verification and a separate explicit activation', async () => {
    const user = userEvent.setup();
    let status: SyncUiLocalStatus = { pendingConflictCount: 0 };
    const confirmRecoveryCode = vi.fn(() => Promise.resolve());
    const activate = vi.fn(() => {
      const setup = localSetup();
      status = { setup, pendingConflictCount: 0 };
      return Promise.resolve(setup);
    });
    const services = baseServices({
      loadLocalStatus: vi.fn(() => Promise.resolve(status)),
      createEnableLifecycle: () => ({
        begin: vi.fn(() =>
          Promise.resolve({
            recoveryCode: 'MR1-AAAA-BBBB-CCCC-DDDD',
            confirmationGroupNumbers: [2, 4],
          }),
        ),
        confirmRecoveryCode,
        activate,
      }),
    });

    renderManager(services);
    await user.click(await screen.findByRole('button', { name: /Uključi na prvom uređaju/i }));
    await user.click(screen.getByRole('button', { name: /Proveri ovaj uređaj/i }));
    await screen.findByText(/Pregledač je prošao lokalnu proveru/i);
    await user.click(screen.getByRole('button', { name: /Napravi recovery kod/i }));

    expect(await screen.findByTestId('sync-recovery-code')).toHaveTextContent(
      'MR1-AAAA-BBBB-CCCC-DDDD',
    );
    expect(services.copySecret).not.toHaveBeenCalled();
    await user.type(screen.getByTestId('sync-recovery-confirmation-2'), 'bbbb');
    await user.type(screen.getByTestId('sync-recovery-confirmation-4'), 'dddd');
    await user.click(screen.getByRole('button', { name: /Potvrdi sačuvani kod/i }));

    expect(confirmRecoveryCode).toHaveBeenCalledWith([
      { groupNumber: 2, value: 'BBBB' },
      { groupNumber: 4, value: 'DDDD' },
    ]);
    expect(activate).not.toHaveBeenCalled();

    await user.click(
      await screen.findByRole('button', { name: /Aktiviraj šifrovanu sinhronizaciju/i }),
    );
    await waitFor(() => expect(activate).toHaveBeenCalledOnce());
    expect(await screen.findByText('Ovaj uređaj je povezan')).toBeVisible();
    expect(screen.queryByTestId('sync-recovery-code')).not.toBeInTheDocument();
  });

  it('cancels a new-device request when the user reports a SAS mismatch', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn(() => Promise.resolve());
    const services = baseServices({
      createNewDevicePairingLifecycle: () => ({
        start: vi.fn(() =>
          Promise.resolve({
            pairingCode: 'MP1-TEST-CODE',
            qrPayload: 'http://localhost/#/pair/MP1-TEST-CODE',
            expiresAt: '2026-07-31T11:00:00.000Z',
          }),
        ),
        poll: vi.fn(() =>
          Promise.resolve({
            status: 'sas-required' as const,
            sas: 'A1B2-C3D4-E5F6-A7B8',
            expiresAt: '2026-07-31T11:00:00.000Z',
          }),
        ),
        confirmSas: vi.fn(() => Promise.resolve(localSetup())),
        cancel,
      }),
    });

    renderManager(services);
    await user.click(await screen.findByRole('button', { name: /Poveži ovaj uređaj/i }));
    await user.click(screen.getByRole('button', { name: /Napravi zahtev za povezivanje/i }));
    expect(await screen.findByTestId('sync-pairing-code')).toHaveTextContent('MP1-TEST-CODE');
    await user.click(screen.getByRole('button', { name: /Proveri odgovor/i }));
    expect(await screen.findByTestId('sync-new-device-sas')).toHaveTextContent(
      'A1B2-C3D4-E5F6-A7B8',
    );

    await user.click(screen.getByRole('button', { name: /Ne poklapaju se — otkaži/i }));
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(screen.queryByTestId('sync-new-device-sas')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sync-pairing-code')).not.toBeInTheDocument();
  });

  it('requires an explicit action before the first encrypted snapshot upload', async () => {
    const user = userEvent.setup();
    const setup = localSetup();
    const synchronize = vi.fn((allowInitialUpload?: boolean) =>
      Promise.resolve(
        allowInitialUpload
          ? { kind: 'uploaded' as const, revision: 1 }
          : { kind: 'awaiting-upload-consent' as const, revision: 0 as const },
      ),
    );
    const services = baseServices({ synchronize }, { setup, pendingConflictCount: 0 });

    renderManager(services);
    const consentButton = await screen.findByRole('button', {
      name: /Saglasan sam — pošalji prvi šifrovani snapshot/i,
    });
    expect(consentButton.closest('div')).toHaveTextContent(
      /server ne dobija čitljive finansijske podatke/i,
    );
    await user.click(consentButton);
    await waitFor(() => expect(synchronize).toHaveBeenCalledWith(true));
  });

  it('does not expose a sync row or construct sync services while the flag is off', () => {
    const financeData = emptyFinanceData();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const serviceFactory = vi.spyOn(syncUiServices, 'createDefaultSyncUiServices');

    render(
      <MemoryRouter>
        <MorePage snapshot={{ ...financeData, settingsRecord: settings }} syncEnabled={false} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('link', { name: /Sinhronizacija/i })).not.toBeInTheDocument();
    expect(serviceFactory).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
