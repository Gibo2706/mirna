import QRCode from 'qrcode';
import { db } from '@/db/database';
import { probeIndexedDbCryptoKeyPersistence } from '@/db/sync/capability';
import { disableSyncOnThisDevice, readLocalSyncSetup } from '@/db/sync/repository';
import type { LocalSyncSetup } from '@/db/sync/records';
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
}

export interface SyncUiServices {
  readonly probeCapability: () => Promise<CryptoCapability>;
  readonly loadLocalStatus: () => Promise<SyncUiLocalStatus>;
  readonly disableLocalDevice: () => Promise<void>;
  readonly clearSession: () => void;
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

  return {
    probeCapability: probeIndexedDbCryptoKeyPersistence,
    loadLocalStatus: async () => {
      const setup = await readLocalSyncSetup();
      const pendingConflictCount = setup
        ? await db.syncConflicts
            .where('vaultId')
            .equals(setup.vault.vaultId)
            .filter((conflict) => conflict.resolutionState === 'pending')
            .count()
        : 0;
      return { setup, pendingConflictCount };
    },
    disableLocalDevice: disableSyncOnThisDevice,
    clearSession: () => api.clearSession(),
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
