import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ToastProvider';
import type { LocalSyncSetup, SyncDeviceKind } from '@/db/sync/records';
import { MorePage } from '@/pages/MorePage';
import { emptyFinanceData, settings } from '@/tests/factories';
import { CLOUD_VAULT_DELETE_CONFIRMATION } from './device-security-service';
import { SyncManager } from './SyncManager';
import type {
  NewDevicePairingLifecyclePort,
  SyncUiLocalStatus,
  SyncUiServices,
} from './ui-services';
import * as syncUiServices from './ui-services';
import { SyncApiError } from './api';

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
      bootstrapMode: 'creator-upload',
      firstUploadConsent: 'pending',
      lastServerCursor: 0,
      lastSnapshotServerCursor: 0,
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
  initialStatus: SyncUiLocalStatus = {
    pendingConflictCount: 0,
    pendingLocalOperationCount: 0,
    pendingConflicts: [],
    pendingPairingFinalization: false,
    deviceAliases: [],
  },
): SyncUiServices => ({
  probeCapability: vi.fn(() => Promise.resolve(supportedCapability)),
  loadLocalStatus: vi.fn(() => Promise.resolve(initialStatus)),
  disableLocalDevice: vi.fn(() => Promise.resolve()),
  clearSession: vi.fn(),
  synchronize: vi.fn(() => Promise.resolve({ kind: 'up-to-date' as const, revision: 1 })),
  renewDevice: vi.fn(() => Promise.resolve()),
  saveDeviceAlias: vi.fn(() => Promise.resolve()),
  secureRevokeDevice: vi.fn(() => Promise.resolve()),
  deleteCloudVault: vi.fn(() => Promise.resolve()),
  resolveConflictGroup: vi.fn(() => Promise.resolve()),
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
  it('shows Turnstile only inside a protected setup action', async () => {
    const listeners = new Set<(state: { phase: 'idle' }) => void>();
    const attach = vi.fn();
    const services = baseServices({
      turnstile: {
        state: { phase: 'idle' },
        attach,
        subscribe: (listener) => {
          listeners.add(listener);
          listener({ phase: 'idle' });
          return () => listeners.delete(listener);
        },
      },
    });

    renderManager(services);
    expect(screen.queryByText('Kratka bezbednosna provera')).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /Poveži ovaj uređaj/i }));
    expect(await screen.findByText('Kratka bezbednosna provera')).toBeVisible();
    expect(screen.getByText(/štiti anonimne radnje od zloupotrebe/u)).toBeVisible();
    expect(screen.getByTestId('sync-turnstile-widget')).toBeVisible();
    expect(attach).toHaveBeenCalledWith(expect.any(HTMLDivElement));
  });

  it('keeps opaque diagnostics compact and refreshes the latest Request ID live', async () => {
    const supportId = 'MIRNA-EMPZ-S5ZF-5VDE-VF3P-X024-D675-9R';
    const firstRequestId = '7663c8e6-e4ab-4eef-89ab-ce96201126b7';
    const nextRequestId = '123e4567-e89b-42d3-a456-426614174000';
    const workerBuild = 'c091e36822db7add6974cf913336ce733b1f3942a44864778d08a1370d754621';
    let notify: (() => void) | undefined;
    let events = [
      {
        id: crypto.randomUUID(),
        createdAt: '2026-08-01T17:00:00.000Z',
        eventType: 'turnstile_rejected',
        severity: 'error' as const,
        requestId: firstRequestId,
        safeCode: 'HUMAN_VERIFICATION_REJECTED',
        verificationReason: 'INVALID_INPUT_RESPONSE',
        build: '2.4.0-beta.1',
      },
    ];
    const snapshotDiagnostics = vi.fn(() => Promise.resolve({ supportId, events }));
    const healthDiagnostics = vi.fn(() =>
      Promise.resolve({
        protocolVersion: 1 as const,
        status: 'ok' as const,
        environment: 'staging' as const,
        buildCommit: workerBuild,
        writesEnabled: true,
        services: { d1: 'ok' as const, r2: 'ok' as const },
      }),
    );
    const services = baseServices({
      diagnostics: {
        supportId: vi.fn(() => Promise.resolve(supportId)),
        snapshot: snapshotDiagnostics,
        subscribe: (listener) => {
          notify = listener;
          return () => {
            notify = undefined;
          };
        },
        clear: vi.fn(() => Promise.resolve()),
        health: healthDiagnostics,
      },
    });

    renderManager(services);
    expect(snapshotDiagnostics).not.toHaveBeenCalled();
    expect(healthDiagnostics).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByText('Pomoć i dijagnostika'));
    const card = await screen.findByTestId('sync-beta-diagnostics');
    expect(card).toHaveClass('min-w-0', 'overflow-hidden');
    expect(await screen.findByText('MIRNA-EM…675-9R')).toBeVisible();
    expect((await screen.findAllByText('7663c8e6…1126b7')).length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText('c091e368…754621')).toBeVisible();
    const eventsDisclosure = screen.getByText('Poslednji tehnički događaji').closest('details');
    expect(eventsDisclosure).not.toHaveAttribute('open');

    await userEvent.click(screen.getByRole('button', { name: /Support ID:/i }));
    expect(screen.getByText(supportId)).toBeVisible();

    events = [
      {
        ...events[0],
        id: crypto.randomUUID(),
        requestId: nextRequestId,
        createdAt: '2026-08-01T17:01:00.000Z',
      },
      ...events,
    ];
    act(() => notify?.());
    expect((await screen.findAllByText('123e4567…174000')).length).toBeGreaterThanOrEqual(1);
  });

  it('requires recovery group verification and a separate explicit activation', async () => {
    const user = userEvent.setup();
    let status: SyncUiLocalStatus = {
      pendingConflictCount: 0,
      pendingLocalOperationCount: 0,
      pendingConflicts: [],
      pendingPairingFinalization: false,
      deviceAliases: [],
    };
    const confirmRecoveryCode = vi.fn(() => Promise.resolve());
    const activate = vi.fn(() => {
      const setup = localSetup();
      status = {
        setup,
        pendingConflictCount: 0,
        pendingLocalOperationCount: 0,
        pendingConflicts: [],
        pendingPairingFinalization: false,
        deviceAliases: [],
      };
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

    await user.click(await screen.findByRole('button', { name: /Pripremi sinhronizaciju/i }));
    await waitFor(() => expect(activate).toHaveBeenCalledOnce());
    expect(await screen.findByText('Sinhronizacija je uključena')).toBeVisible();
    expect(screen.queryByTestId('sync-recovery-code')).not.toBeInTheDocument();
  });

  it('prevents parallel activation and retries with the confirmed recovery setup', async () => {
    const user = userEvent.setup();
    let rejectFirst!: (error: unknown) => void;
    const firstAttempt = new Promise<LocalSyncSetup>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const activate = vi
      .fn<() => Promise<LocalSyncSetup>>()
      .mockImplementationOnce(() => firstAttempt)
      .mockResolvedValue(localSetup());
    const services = baseServices({
      createEnableLifecycle: () => ({
        begin: vi.fn(() =>
          Promise.resolve({
            recoveryCode: 'MR1-AAAA-BBBB-CCCC-DDDD',
            confirmationGroupNumbers: [2, 4],
          }),
        ),
        confirmRecoveryCode: vi.fn(() => Promise.resolve()),
        activate,
      }),
    });

    renderManager(services);
    await user.click(await screen.findByRole('button', { name: /Uključi na prvom uređaju/i }));
    await screen.findByText(/Pregledač je prošao lokalnu proveru/i);
    await user.click(screen.getByRole('button', { name: /Napravi recovery kod/i }));
    await user.type(screen.getByTestId('sync-recovery-confirmation-2'), 'BBBB');
    await user.type(screen.getByTestId('sync-recovery-confirmation-4'), 'DDDD');
    await user.click(screen.getByRole('button', { name: /Potvrdi sačuvani kod/i }));

    const activateButton = await screen.findByRole('button', {
      name: /Pripremi sinhronizaciju/i,
    });
    await user.dblClick(activateButton);
    expect(activate).toHaveBeenCalledOnce();

    await act(async () => {
      rejectFirst(
        new SyncApiError(
          'HUMAN_VERIFICATION_REJECTED',
          403,
          '123e4567-e89b-42d3-a456-426614174000',
          'INVALID_INPUT_RESPONSE',
        ),
      );
      await firstAttempt.catch(() => undefined);
    });
    expect(await screen.findByText(/Provera nije prihvaćena/u)).toBeVisible();
    expect(screen.getByTestId('sync-recovery-code')).toHaveTextContent('MR1-AAAA-BBBB-CCCC-DDDD');

    await user.click(screen.getByRole('button', { name: 'Pokušaj ponovo' }));
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
  });

  it('shows accounting reason, phase, route and Request ID immediately before a safe retry', async () => {
    const user = userEvent.setup();
    const requestId = '123e4567-e89b-42d3-a456-426614174000';
    const activate = vi
      .fn<() => Promise<LocalSyncSetup>>()
      .mockRejectedValueOnce(
        new SyncApiError('USAGE_ACCOUNTING_UNAVAILABLE', 503, requestId, null, {
          category: 'USAGE_ACCOUNTING_UNAVAILABLE',
          reason: 'USAGE_RESERVATION_UNDERESTIMATED',
          phase: 'route-reservation',
          route: 'vault-create',
          businessCommitted: false,
          serviceFlagsChanged: false,
          workerBuild: 'abcdef1',
        }),
      )
      .mockResolvedValue(localSetup());
    const services = baseServices({
      createEnableLifecycle: () => ({
        begin: vi.fn(() =>
          Promise.resolve({
            recoveryCode: 'MR1-AAAA-BBBB-CCCC-DDDD',
            confirmationGroupNumbers: [2, 4],
          }),
        ),
        confirmRecoveryCode: vi.fn(() => Promise.resolve()),
        activate,
      }),
    });

    renderManager(services);
    await user.click(await screen.findByRole('button', { name: /Uključi na prvom uređaju/i }));
    await screen.findByText(/Pregledač je prošao lokalnu proveru/i);
    await user.click(screen.getByRole('button', { name: /Napravi recovery kod/i }));
    await user.type(screen.getByTestId('sync-recovery-confirmation-2'), 'BBBB');
    await user.type(screen.getByTestId('sync-recovery-confirmation-4'), 'DDDD');
    await user.click(screen.getByRole('button', { name: /Potvrdi sačuvani kod/i }));
    await user.click(await screen.findByRole('button', { name: /Pripremi sinhronizaciju/i }));

    const details = await screen.findByTestId('sync-activation-accounting-error');
    expect(details).toHaveTextContent('Accounting razlog: USAGE_RESERVATION_UNDERESTIMATED');
    expect(details).toHaveTextContent('Faza: route-reservation');
    expect(details).toHaveTextContent('Ruta: vault-create');
    expect(details).toHaveTextContent(`Request ID: ${requestId}`);
    expect(screen.getByTestId('sync-recovery-code')).toHaveTextContent('MR1-AAAA-BBBB-CCCC-DDDD');

    await user.click(screen.getByRole('button', { name: 'Pokušaj ponovo' }));
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
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
        resumeFinalization: vi.fn(() => Promise.resolve(localSetup())),
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

  it('offers and completes a durable pairing finalization after reload', async () => {
    const user = userEvent.setup();
    let resumed = false;
    const setup = localSetup();
    const resumeFinalization = vi.fn(() => {
      resumed = true;
      return Promise.resolve(setup);
    });
    const cancel = vi.fn(() => Promise.resolve());
    const lifecycle = {
      get state() {
        return resumed ? 'active' : 'idle';
      },
      start: vi.fn(),
      poll: vi.fn(),
      confirmSas: vi.fn(),
      resumeFinalization,
      cancel,
    } as NewDevicePairingLifecyclePort;
    const services = baseServices({
      loadLocalStatus: vi.fn(() =>
        Promise.resolve(
          resumed
            ? {
                setup,
                pendingConflictCount: 0,
                pendingLocalOperationCount: 0,
                pendingConflicts: [],
                pendingPairingFinalization: false,
                deviceAliases: [],
              }
            : {
                pendingConflictCount: 0,
                pendingLocalOperationCount: 0,
                pendingConflicts: [],
                pendingPairingFinalization: true,
                deviceAliases: [],
              },
        ),
      ),
      createNewDevicePairingLifecycle: () => lifecycle,
    });

    renderManager(services);
    await user.click(await screen.findByRole('button', { name: /Dovrši započeto povezivanje/i }));
    await waitFor(() => expect(resumeFinalization).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Sinhronizacija je uključena/i)).toBeVisible();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('requires an explicit action before the first encrypted upload', async () => {
    const user = userEvent.setup();
    const setup = localSetup();
    const synchronize = vi.fn((allowInitialUpload?: boolean) =>
      Promise.resolve(
        allowInitialUpload
          ? { kind: 'uploaded' as const, revision: 1 }
          : { kind: 'awaiting-upload-consent' as const, revision: 0 as const },
      ),
    );
    const services = baseServices(
      { synchronize },
      {
        setup,
        pendingConflictCount: 0,
        pendingLocalOperationCount: 0,
        pendingConflicts: [],
        pendingPairingFinalization: false,
        deviceAliases: [],
      },
    );

    renderManager(services);
    const consentButton = await screen.findByRole('button', {
      name: /Saglasan sam — pošalji prve šifrovane podatke/i,
    });
    expect(consentButton.closest('div')).toHaveTextContent(
      /servis ne dobija čitljive finansijske podatke/i,
    );
    await user.click(consentButton);
    await waitFor(() => expect(synchronize).toHaveBeenCalledWith(true, false));
  });

  it('uses ordinary synchronization for the primary manual button', async () => {
    const user = userEvent.setup();
    const setup = localSetup();
    setup.metadata.bootstrapMode = 'complete';
    setup.metadata.firstUploadConsent = 'accepted';
    setup.metadata.lastSnapshotRevision = 1;
    setup.metadata.lastSuccessfulSyncAt = '2026-08-19T10:00:00.000Z';
    const synchronize = vi.fn(() =>
      Promise.resolve({
        kind: 'synchronized' as const,
        revision: 1,
        uploadedOperations: 0,
        downloadedOperations: 0,
        appliedGroups: 0,
        conflictedGroups: 0,
        pendingLocalOperations: 0,
        acknowledgedServerCursor: 0,
        compacted: false,
      }),
    );
    const services = baseServices(
      { synchronize },
      {
        setup,
        pendingConflictCount: 0,
        pendingLocalOperationCount: 0,
        pendingConflicts: [],
        pendingPairingFinalization: false,
        deviceAliases: [],
      },
    );

    renderManager(services);
    await user.click(await screen.findByRole('button', { name: 'Sinhronizuj sada' }));

    await waitFor(() => expect(synchronize).toHaveBeenCalledWith(false, false));
    expect(synchronize).not.toHaveBeenCalledWith(false, true);
  });

  it('shows a human fallback and persists a local alias for a remote device', async () => {
    const user = userEvent.setup();
    const setup = localSetup();
    const remoteDeviceId = 'DDDDDDDDDDDDDDDDDDDDDD';
    setup.vault.manifest.devices.push({
      ...setup.vault.manifest.devices[0],
      deviceId: remoteDeviceId,
    });
    setup.metadata.bootstrapMode = 'complete';
    setup.metadata.firstUploadConsent = 'accepted';
    setup.metadata.lastSnapshotRevision = 1;
    let deviceAliases: SyncUiLocalStatus['deviceAliases'] = [];
    const saveDeviceAlias = vi.fn(
      (vaultId: string, deviceId: string, label: string, kind?: SyncDeviceKind) => {
        deviceAliases = [
          {
            id: `${vaultId}:${deviceId}`,
            vaultId,
            deviceId,
            label,
            kind,
            updatedAt: new Date().toISOString(),
          },
        ];
        return Promise.resolve();
      },
    );
    const services = baseServices({
      loadLocalStatus: vi.fn(() =>
        Promise.resolve({
          setup,
          pendingConflictCount: 0,
          pendingLocalOperationCount: 0,
          pendingConflicts: [],
          pendingPairingFinalization: false,
          deviceAliases,
        }),
      ),
      saveDeviceAlias,
    });

    renderManager(services);
    expect(await screen.findByText('Drugi uređaj')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Promeni naziv' }));
    await user.clear(screen.getByLabelText('Naziv uređaja'));
    await user.type(screen.getByLabelText('Naziv uređaja'), 'Laptop');
    await user.selectOptions(screen.getByLabelText('Vrsta uređaja'), 'computer');
    await user.click(screen.getByRole('button', { name: 'Sačuvaj naziv' }));

    await waitFor(() =>
      expect(saveDeviceAlias).toHaveBeenCalledWith(
        setup.vault.vaultId,
        remoteDeviceId,
        'Laptop',
        'computer',
      ),
    );
    expect(await screen.findByText('Laptop')).toBeVisible();
  });

  it('requires recovery and typed confirmation before secure remote-device revocation', async () => {
    const user = userEvent.setup();
    const setup = localSetup();
    const remoteDeviceId = 'DDDDDDDDDDDDDDDDDDDDDD';
    setup.vault.manifest.devices.push({
      ...setup.vault.manifest.devices[0],
      deviceId: remoteDeviceId,
    });
    setup.metadata.firstUploadConsent = 'accepted';
    const secureRevokeDevice = vi.fn(() => Promise.resolve());
    const services = baseServices(
      { secureRevokeDevice },
      {
        setup,
        pendingConflictCount: 0,
        pendingLocalOperationCount: 0,
        pendingConflicts: [],
        pendingPairingFinalization: false,
        deviceAliases: [],
      },
    );

    renderManager(services);
    const revokeButtons = await screen.findAllByRole('button', { name: /Bezbedno opozovi/i });
    expect(revokeButtons).toHaveLength(1);
    await user.click(revokeButtons[0]);
    expect(screen.getByText(/ne može obrisati čitljive podatke ili stare ključeve/i)).toBeVisible();
    const confirm = screen.getByRole('button', { name: /Opozovi i rotiraj ključ/i });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText('Recovery kod'), 'MR1-AAAA-BBBB-CCCC-DDDD');
    await user.type(screen.getByLabelText(/Za potvrdu unesite: OPOZOVI UREĐAJ/i), 'OPOZOVI UREĐAJ');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() =>
      expect(secureRevokeDevice).toHaveBeenCalledWith(remoteDeviceId, 'MR1-AAAA-BBBB-CCCC-DDDD'),
    );
    expect(screen.queryByLabelText('Recovery kod')).not.toBeInTheDocument();
  });

  it('requires both recovery and exact confirmation before deleting only the cloud vault', async () => {
    const user = userEvent.setup();
    const setup = localSetup();
    setup.metadata.firstUploadConsent = 'accepted';
    const deleteCloudVault = vi.fn(() => Promise.resolve());
    const services = baseServices(
      { deleteCloudVault },
      {
        setup,
        pendingConflictCount: 0,
        pendingLocalOperationCount: 0,
        pendingConflicts: [],
        pendingPairingFinalization: false,
        deviceAliases: [],
      },
    );

    renderManager(services);
    expect(await screen.findByText(/Lokalni Mirna finansijski podaci se ne brišu/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Pripremi cloud brisanje/i }));
    const confirm = screen.getByRole('button', { name: /Trajno obriši cloud trezor/i });
    expect(confirm).toBeDisabled();

    await user.type(
      screen.getByLabelText('Recovery kod za cloud brisanje'),
      'MR1-AAAA-BBBB-CCCC-DDDD',
    );
    await user.type(
      screen.getByLabelText(`Za potvrdu unesite: ${CLOUD_VAULT_DELETE_CONFIRMATION}`),
      'pogrešna potvrda',
    );
    expect(confirm).toBeDisabled();
    await user.clear(
      screen.getByLabelText(`Za potvrdu unesite: ${CLOUD_VAULT_DELETE_CONFIRMATION}`),
    );
    await user.type(
      screen.getByLabelText(`Za potvrdu unesite: ${CLOUD_VAULT_DELETE_CONFIRMATION}`),
      CLOUD_VAULT_DELETE_CONFIRMATION,
    );
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() =>
      expect(deleteCloudVault).toHaveBeenCalledWith(
        'MR1-AAAA-BBBB-CCCC-DDDD',
        CLOUD_VAULT_DELETE_CONFIRMATION,
      ),
    );
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
