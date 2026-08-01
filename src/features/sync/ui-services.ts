import QRCode from 'qrcode';
import { db } from '@/db/database';
import { probeIndexedDbCryptoKeyPersistence } from '@/db/sync/capability';
import { disableSyncOnThisDevice, readLocalSyncSetup } from '@/db/sync/repository';
import type { LocalSyncSetup, SyncConflictRecord } from '@/db/sync/records';
import {
  SyncConflictRepository,
  type ConflictResolutionSelection,
} from '@/db/sync/conflict-repository';
import { MirnaSyncApi } from './api';
import { readSyncClientConfig } from './config';
import {
  EnableSyncLifecycle,
  ExistingDevicePairingLifecycle,
  NewDevicePairingLifecycle,
  RecoverDeviceLifecycle,
  type ExistingPairingPreparation,
  type PairingCodePresentation,
  type PairingPollResult,
  type RecoveryCodePresentation,
  type RecoveryConfirmationValue,
  type RecoveryStartResult,
} from './lifecycle';
import { SnapshotSyncService } from './snapshot-service';
import { OperationSyncService } from './operation-service';
import { ContinuousSyncService, type ContinuousSyncResult } from './continuous-service';
import { SyncOperationRepository } from '@/db/sync/operation-repository';
import { DeviceSecurityService } from './device-security-service';

type CryptoCapability = Awaited<ReturnType<typeof probeIndexedDbCryptoKeyPersistence>>;

export interface EnableLifecyclePort {
  begin(displayName: string): Promise<RecoveryCodePresentation>;
  confirmRecoveryCode(values: readonly RecoveryConfirmationValue[]): Promise<void>;
  activate(): Promise<LocalSyncSetup>;
}

export interface NewDevicePairingLifecyclePort {
  readonly state?: string;
  start(displayName: string): Promise<PairingCodePresentation>;
  poll(): Promise<PairingPollResult>;
  confirmSas(sas: string): Promise<LocalSyncSetup>;
  cancel(): Promise<void>;
}

export interface ExistingDevicePairingLifecyclePort {
  prepare(codeOrQrPayload: string): Promise<ExistingPairingPreparation>;
  approve(confirmedSas: string): Promise<void>;
  reject(): void;
}

export interface RecoverDeviceLifecyclePort {
  begin(recoveryCode: string, displayName: string): Promise<RecoveryStartResult>;
  confirmNewRecoveryCode(values: readonly RecoveryConfirmationValue[]): Promise<LocalSyncSetup>;
}

export interface SyncUiLocalStatus {
  readonly setup?: LocalSyncSetup;
  readonly pendingConflictCount: number;
  readonly pendingLocalOperationCount: number;
  readonly pendingConflicts: readonly SyncConflictRecord[];
}

export interface SyncUiServices {
  readonly probeCapability: () => Promise<CryptoCapability>;
  readonly loadLocalStatus: () => Promise<SyncUiLocalStatus>;
  readonly disableLocalDevice: () => Promise<void>;
  readonly clearSession: () => void;
  readonly resolveConflictGroup: (
    vaultId: string,
    mutationGroupId: string,
    selection: ConflictResolutionSelection,
  ) => Promise<void>;
  readonly synchronize: (
    allowInitialUpload?: boolean,
    forceCompaction?: boolean,
  ) => Promise<ContinuousSyncResult>;
  readonly renewDevice: (deviceId: string) => Promise<void>;
  readonly secureRevokeDevice: (deviceId: string, recoveryCode: string) => Promise<void>;
  readonly deleteCloudVault: (recoveryCode: string, typedConfirmation: string) => Promise<void>;
  readonly createEnableLifecycle: () => EnableLifecyclePort;
  readonly createNewDevicePairingLifecycle: () => NewDevicePairingLifecyclePort;
  readonly createExistingDevicePairingLifecycle: () => ExistingDevicePairingLifecyclePort;
  readonly createRecoveryLifecycle: () => RecoverDeviceLifecyclePort;
  readonly createQrDataUrl: (payload: string) => Promise<string>;
  readonly copySecret: (secret: string) => Promise<void>;
  readonly downloadSecret: (filename: string, secret: string) => void;
  readonly printSecret: () => void;
}

const downloadSecretFile = (filename: string, secret: string): void => {
  const content = [
    'Mirna recovery kod',
    '',
    secret,
    '',
    'Čuvajte ovaj kod van uređaja. Mirna ne može da ga vrati ako ga izgubite.',
  ].join('\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.click();
  URL.revokeObjectURL(url);
};

const copySecretToClipboard = async (secret: string): Promise<void> => {
  if (!navigator.clipboard?.writeText) {
    throw new Error('Kopiranje nije dostupno u ovom pregledaču.');
  }
  await navigator.clipboard.writeText(secret);
};

export const createDefaultSyncUiServices = (): SyncUiServices => {
  const config = readSyncClientConfig();
  if (!config.enabled) throw new Error('Beta sinhronizacija nije uključena.');

  const api = new MirnaSyncApi(config);
  const dependencies = { api, origin: window.location.origin } as const;
  const operationRepository = new SyncOperationRepository();
  const conflictRepository = new SyncConflictRepository();
  const snapshotService = new SnapshotSyncService({
    api,
    origin: window.location.origin,
  });
  const operationService = new OperationSyncService({
    api,
    origin: window.location.origin,
    repository: operationRepository,
  });
  const securityService = new DeviceSecurityService({
    api,
    origin: window.location.origin,
  });
  const continuousService = new ContinuousSyncService({
    operations: operationService,
    snapshots: snapshotService,
    security: securityService,
    repository: operationRepository,
  });

  return {
    probeCapability: probeIndexedDbCryptoKeyPersistence,
    loadLocalStatus: async () => {
      const setup = await readLocalSyncSetup();
      const pendingConflicts = setup
        ? await db.syncConflicts
            .where('vaultId')
            .equals(setup.vault.vaultId)
            .filter((conflict) => conflict.resolutionState === 'pending')
            .sortBy('detectedAt')
        : [];
      const pendingLocalOperationCount = setup
        ? await db.syncOutbox.where('vaultId').equals(setup.vault.vaultId).count()
        : 0;
      return {
        setup,
        pendingConflictCount: pendingConflicts.length,
        pendingLocalOperationCount,
        pendingConflicts,
      };
    },
    disableLocalDevice: disableSyncOnThisDevice,
    clearSession: () => {
      api.clearSession();
    },
    synchronize: (allowInitialUpload = false, forceCompaction = false) =>
      continuousService.synchronize({ allowInitialUpload, forceCompaction }),
    renewDevice: async (deviceId) => {
      await securityService.renewDevice(deviceId);
    },
    secureRevokeDevice: async (deviceId, recoveryCode) => {
      await securityService.secureRevokeDevice(deviceId, recoveryCode);
      const result = await continuousService.synchronize({ forceCompaction: true });
      if (result.kind !== 'synchronized' || !result.compacted) {
        throw new Error(
          'Uređaj je opozvan i ključ je rotiran, ali novi cloud snimak još nije potvrđen. Pokrenite sync ponovo.',
        );
      }
    },
    deleteCloudVault: async (recoveryCode, typedConfirmation) => {
      await securityService.deleteCloudVault(recoveryCode, typedConfirmation);
      api.clearSession();
      await disableSyncOnThisDevice();
    },
    resolveConflictGroup: (vaultId, mutationGroupId, selection) =>
      conflictRepository.resolveOperationGroup(vaultId, mutationGroupId, selection),
    createEnableLifecycle: () => new EnableSyncLifecycle(dependencies),
    createNewDevicePairingLifecycle: () => new NewDevicePairingLifecycle(dependencies),
    createExistingDevicePairingLifecycle: () => new ExistingDevicePairingLifecycle(dependencies),
    createRecoveryLifecycle: () => new RecoverDeviceLifecycle(dependencies),
    createQrDataUrl: (payload) =>
      QRCode.toDataURL(payload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 256,
      }),
    copySecret: copySecretToClipboard,
    downloadSecret: downloadSecretFile,
    printSecret: () => window.print(),
  };
};
