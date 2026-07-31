import { canonicalizeJson } from './canonical';
import { SYNC_DOMAIN_LABELS, SYNC_LIMITS } from './constants';
import {
  exportPublicEcKey,
  hashDomainSeparatedCanonical,
  importSigningPublicKey,
  isNormalizedP256Signature,
  signDomainSeparatedCanonical,
  verifyDomainSeparatedCanonicalSignature,
  type CryptoRuntime,
} from './crypto';
import { base64UrlToBytes } from './encoding';
import {
  sha256Schema,
  unsignedVaultManifestSchema,
  vaultManifestSchema,
  type ManifestDeviceV1,
  type UnsignedVaultManifestV1,
  type VaultManifestV1,
} from './schemas';

const equal = (left: unknown, right: unknown): boolean =>
  canonicalizeJson(left) === canonicalizeJson(right);

const withoutSignature = (manifest: VaultManifestV1): UnsignedVaultManifestV1 => {
  const { signature: _signature, ...unsigned } = manifest;
  void _signature;
  return unsignedVaultManifestSchema.parse(unsigned);
};

export const manifestBodyHash = (
  manifest: VaultManifestV1 | UnsignedVaultManifestV1,
  runtime?: CryptoRuntime,
): Promise<string> => {
  const unsigned =
    'signature' in manifest
      ? withoutSignature(manifest)
      : unsignedVaultManifestSchema.parse(manifest);
  return hashDomainSeparatedCanonical(SYNC_DOMAIN_LABELS.manifestBody, unsigned, runtime);
};

const assertSortedUniqueDevices = (manifest: UnsignedVaultManifestV1): void => {
  const active = manifest.devices.map((device) => device.deviceId);
  const revoked = manifest.revokedDevices.map((device) => device.deviceId);
  if (!equal(active, active.slice().sort()) || !equal(revoked, revoked.slice().sort())) {
    throw new Error('Uređaji u manifestu moraju biti kanonski sortirani po ID-u.');
  }
  const all = [...active, ...revoked];
  if (new Set(all).size !== all.length) throw new Error('Uređaj se ponavlja u manifestu.');
  for (const device of manifest.devices) {
    const authorizedAt = Date.parse(device.authorizedAt);
    const authorizationExpiresAt = Date.parse(device.authorizationExpiresAt);
    if (
      authorizationExpiresAt <= authorizedAt ||
      authorizationExpiresAt - authorizedAt > SYNC_LIMITS.deviceAuthorizationLifetimeMs
    ) {
      throw new Error('Autorizacija uređaja mora trajati najviše 30 dana od odobrenja.');
    }
  }
};

const byDeviceId = (devices: readonly ManifestDeviceV1[]): Map<string, ManifestDeviceV1> =>
  new Map(devices.map((device) => [device.deviceId, device]));

const assertSameActiveExcept = (
  previous: readonly ManifestDeviceV1[],
  next: readonly ManifestDeviceV1[],
  exceptDeviceId: string,
): void => {
  const previousById = byDeviceId(previous);
  const nextById = byDeviceId(next);
  for (const [deviceId, device] of previousById) {
    if (deviceId !== exceptDeviceId && !equal(device, nextById.get(deviceId))) {
      throw new Error(`Manifest je neočekivano promenio uređaj ${deviceId}.`);
    }
  }
  for (const [deviceId, device] of nextById) {
    if (deviceId !== exceptDeviceId && !equal(device, previousById.get(deviceId))) {
      throw new Error(`Manifest je neočekivano dodao ili promenio uređaj ${deviceId}.`);
    }
  }
};

const assertSameRevokedExcept = (
  previous: UnsignedVaultManifestV1['revokedDevices'],
  next: UnsignedVaultManifestV1['revokedDevices'],
  exceptDeviceId: string,
): void => {
  const previousById = new Map(previous.map((device) => [device.deviceId, device]));
  const nextById = new Map(next.map((device) => [device.deviceId, device]));
  for (const [deviceId, device] of previousById) {
    if (deviceId !== exceptDeviceId && !equal(device, nextById.get(deviceId))) {
      throw new Error(`Manifest je neočekivano promenio opozvani uređaj ${deviceId}.`);
    }
  }
  for (const [deviceId, device] of nextById) {
    if (deviceId !== exceptDeviceId && !equal(device, previousById.get(deviceId))) {
      throw new Error(`Manifest je neočekivano dodao opozvani uređaj ${deviceId}.`);
    }
  }
};

const assertDeviceAuthorization = (manifest: UnsignedVaultManifestV1): void => {
  const transition = manifest.transition;
  if (transition.authorizationKind === 'device') {
    if (!transition.authorizingDeviceId) {
      throw new Error('Tranzicija uređaja nema autora.');
    }
  } else if (transition.authorizingDeviceId !== null) {
    throw new Error('Recovery tranzicija ne sme tvrditi da ju je potpisao uređaj.');
  }
};

export const validateInitialManifest = (manifest: UnsignedVaultManifestV1): void => {
  const parsed = unsignedVaultManifestSchema.parse(manifest);
  assertSortedUniqueDevices(parsed);
  assertDeviceAuthorization(parsed);
  const device = parsed.devices[0];
  if (
    parsed.manifestVersion !== 1 ||
    parsed.keyEpoch !== 1 ||
    parsed.previousManifestHash !== null ||
    parsed.devices.length !== 1 ||
    parsed.revokedDevices.length !== 0 ||
    parsed.transition.kind !== 'create' ||
    parsed.transition.authorizationKind !== 'device' ||
    parsed.transition.authorizingDeviceId !== device?.deviceId ||
    parsed.transition.affectedDeviceId !== device?.deviceId
  ) {
    throw new Error('Početni manifest nema dozvoljeni genesis oblik.');
  }
};

export const validateManifestTransition = async (
  previousManifest: VaultManifestV1,
  nextManifest: VaultManifestV1,
  runtime?: CryptoRuntime,
): Promise<void> => {
  const previous = vaultManifestSchema.parse(previousManifest);
  const next = vaultManifestSchema.parse(nextManifest);
  const nextUnsigned = withoutSignature(next);
  assertSortedUniqueDevices(nextUnsigned);
  assertDeviceAuthorization(nextUnsigned);
  if (
    next.vaultId !== previous.vaultId ||
    next.protocolVersion !== previous.protocolVersion ||
    next.suite !== previous.suite ||
    next.manifestVersion !== previous.manifestVersion + 1 ||
    next.previousManifestHash !== (await manifestBodyHash(previous, runtime))
  ) {
    throw new Error('Manifest nema očekivani prethodni hash ili sledeću verziju.');
  }

  const transition = next.transition;
  const previousActive = byDeviceId(previous.devices);
  let signingPublicKey;
  if (transition.authorizationKind === 'recovery') {
    if (!['recover-device', 'rotate-recovery'].includes(transition.kind)) {
      throw new Error('Recovery ključ nije ovlašćen za ovu tranziciju manifesta.');
    }
    signingPublicKey = previous.recoverySigningPublicKey;
  } else {
    if (transition.kind === 'create' || transition.kind === 'recover-device') {
      throw new Error('Uređaj nije ovlašćen za ovu vrstu tranzicije manifesta.');
    }
    const authorizer = previousActive.get(transition.authorizingDeviceId ?? '');
    if (!authorizer) throw new Error('Autor tranzicije nije aktivan uređaj prethodnog manifesta.');
    if (Date.parse(authorizer.authorizationExpiresAt) <= Date.parse(transition.occurredAt)) {
      throw new Error('Autorizacija autora manifesta je istekla.');
    }
    signingPublicKey = authorizer.publicKeys.signing;
  }
  const importedSigningKey = await importSigningPublicKey(signingPublicKey, runtime);
  if (
    !(await verifyDomainSeparatedCanonicalSignature(
      SYNC_DOMAIN_LABELS.manifestBody,
      nextUnsigned,
      next.signature,
      importedSigningKey,
      runtime,
    ))
  ) {
    throw new Error('Potpis tranzicije manifesta nije validan.');
  }

  const affected = transition.affectedDeviceId;
  switch (transition.kind) {
    case 'add-device': {
      if (
        previousActive.has(affected) ||
        next.devices.length !== previous.devices.length + 1 ||
        !next.devices.some((device) => device.deviceId === affected) ||
        !equal(next.revokedDevices, previous.revokedDevices) ||
        next.recoveryLookupId !== previous.recoveryLookupId ||
        !equal(next.recoverySigningPublicKey, previous.recoverySigningPublicKey) ||
        next.keyEpoch !== previous.keyEpoch
      ) {
        throw new Error('Dodavanje uređaja menja nedozvoljena polja manifesta.');
      }
      assertSameActiveExcept(previous.devices, next.devices, affected);
      break;
    }
    case 'recover-device': {
      const recovered = next.devices.find((device) => device.deviceId === affected);
      const newlyRevoked = next.revokedDevices.filter((device) =>
        previous.devices.some((previousDevice) => previousDevice.deviceId === device.deviceId),
      );
      if (
        previousActive.has(affected) ||
        !recovered ||
        next.devices.length !== 1 ||
        newlyRevoked.length !== previous.devices.length ||
        next.revokedDevices.length !== previous.revokedDevices.length + previous.devices.length ||
        next.recoveryLookupId === previous.recoveryLookupId ||
        equal(next.recoverySigningPublicKey, previous.recoverySigningPublicKey) ||
        next.keyEpoch !== previous.keyEpoch + 1
      ) {
        throw new Error('Recovery mora dodati uređaj i rotirati recovery autoritet i epohu.');
      }
      for (const previousRevoked of previous.revokedDevices) {
        if (
          !equal(
            previousRevoked,
            next.revokedDevices.find((device) => device.deviceId === previousRevoked.deviceId),
          )
        ) {
          throw new Error('Recovery je promenio ranije opozvani uređaj.');
        }
      }
      for (const previousDevice of previous.devices) {
        const revoked = next.revokedDevices.find(
          (device) => device.deviceId === previousDevice.deviceId,
        );
        if (
          !revoked ||
          !equal(revoked.publicKeys, previousDevice.publicKeys) ||
          revoked.revocationAuthority !== 'recovery' ||
          revoked.revokedByDeviceId !== null ||
          revoked.revokedAt !== transition.occurredAt ||
          revoked.lastAuthorizedManifestVersion !== previous.manifestVersion
        ) {
          throw new Error('Recovery mora opozvati svaki prethodno aktivan uređaj.');
        }
      }
      break;
    }
    case 'renew-device': {
      const oldDevice = previousActive.get(affected);
      const renewed = next.devices.find((device) => device.deviceId === affected);
      if (
        !oldDevice ||
        !renewed ||
        next.devices.length !== previous.devices.length ||
        !equal(oldDevice.publicKeys, renewed.publicKeys) ||
        Date.parse(renewed.authorizationExpiresAt) <=
          Date.parse(oldDevice.authorizationExpiresAt) ||
        !equal(next.revokedDevices, previous.revokedDevices) ||
        next.recoveryLookupId !== previous.recoveryLookupId ||
        !equal(next.recoverySigningPublicKey, previous.recoverySigningPublicKey) ||
        next.keyEpoch !== previous.keyEpoch
      ) {
        throw new Error('Obnova uređaja ima nedozvoljenu promenu.');
      }
      assertSameActiveExcept(previous.devices, next.devices, affected);
      break;
    }
    case 'revoke-device': {
      const oldDevice = previousActive.get(affected);
      const revoked = next.revokedDevices.find((device) => device.deviceId === affected);
      if (
        !oldDevice ||
        next.devices.some((device) => device.deviceId === affected) ||
        next.devices.length !== previous.devices.length - 1 ||
        next.revokedDevices.length !== previous.revokedDevices.length + 1 ||
        !revoked ||
        !equal(revoked.publicKeys, oldDevice.publicKeys) ||
        revoked.revocationAuthority !== 'device' ||
        revoked.revokedByDeviceId !== transition.authorizingDeviceId ||
        revoked.revokedAt !== transition.occurredAt ||
        revoked.lastAuthorizedManifestVersion !== previous.manifestVersion ||
        next.recoveryLookupId !== previous.recoveryLookupId ||
        !equal(next.recoverySigningPublicKey, previous.recoverySigningPublicKey) ||
        next.keyEpoch !== previous.keyEpoch + 1
      ) {
        throw new Error('Opoziv uređaja ima nedozvoljenu promenu.');
      }
      assertSameActiveExcept(previous.devices, next.devices, affected);
      assertSameRevokedExcept(previous.revokedDevices, next.revokedDevices, affected);
      break;
    }
    case 'rotate-key':
      if (
        next.keyEpoch !== previous.keyEpoch + 1 ||
        !equal(next.devices, previous.devices) ||
        !equal(next.revokedDevices, previous.revokedDevices) ||
        next.recoveryLookupId !== previous.recoveryLookupId ||
        !equal(next.recoverySigningPublicKey, previous.recoverySigningPublicKey)
      ) {
        throw new Error('Rotacija ključa mora promeniti samo epohu.');
      }
      break;
    case 'rotate-recovery':
      if (
        next.keyEpoch !== previous.keyEpoch ||
        !equal(next.devices, previous.devices) ||
        !equal(next.revokedDevices, previous.revokedDevices) ||
        next.recoveryLookupId === previous.recoveryLookupId ||
        equal(next.recoverySigningPublicKey, previous.recoverySigningPublicKey)
      ) {
        throw new Error('Rotacija recovery ključa mora promeniti samo recovery javni ključ.');
      }
      break;
    case 'create':
      throw new Error('Genesis tranzicija se ne može ponoviti.');
  }
};

export const signVaultManifest = async (
  manifest: UnsignedVaultManifestV1,
  privateKey: CryptoKey,
  runtime?: CryptoRuntime,
): Promise<VaultManifestV1> => {
  const parsed = unsignedVaultManifestSchema.parse(manifest);
  const signature = await signDomainSeparatedCanonical(
    SYNC_DOMAIN_LABELS.manifestBody,
    parsed,
    privateKey,
    runtime,
  );
  return vaultManifestSchema.parse({ ...parsed, signature });
};

export const verifyInitialManifest = async (
  manifest: VaultManifestV1,
  runtime?: CryptoRuntime,
): Promise<void> => {
  const parsed = vaultManifestSchema.parse(manifest);
  const unsigned = withoutSignature(parsed);
  validateInitialManifest(unsigned);
  const publicKey = await importSigningPublicKey(parsed.devices[0].publicKeys.signing, runtime);
  if (
    !(await verifyDomainSeparatedCanonicalSignature(
      SYNC_DOMAIN_LABELS.manifestBody,
      unsigned,
      parsed.signature,
      publicKey,
      runtime,
    ))
  ) {
    throw new Error('Početni manifest nema validan self-signature prvog uređaja.');
  }
};

export const createInitialManifest = async (input: {
  vaultId: string;
  recoveryLookupId: string;
  transitionId: string;
  device: ManifestDeviceV1;
  recoverySigningPublicKey: CryptoKey;
  signingPrivateKey: CryptoKey;
  createdAt: string;
  runtime?: CryptoRuntime;
}): Promise<VaultManifestV1> => {
  const recoverySigningPublicKey = await exportPublicEcKey(
    input.recoverySigningPublicKey,
    input.runtime,
  );
  const unsigned = unsignedVaultManifestSchema.parse({
    type: 'mirna-vault-manifest-v1',
    protocolVersion: 1,
    suite: 'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1',
    vaultId: input.vaultId,
    manifestVersion: 1,
    keyEpoch: 1,
    devices: [input.device],
    revokedDevices: [],
    recoveryLookupId: input.recoveryLookupId,
    recoverySigningPublicKey,
    previousManifestHash: null,
    transition: {
      transitionId: input.transitionId,
      kind: 'create',
      authorizationKind: 'device',
      authorizingDeviceId: input.device.deviceId,
      affectedDeviceId: input.device.deviceId,
      occurredAt: input.createdAt,
    },
  });
  validateInitialManifest(unsigned);
  return signVaultManifest(unsigned, input.signingPrivateKey, input.runtime);
};

export interface PinnedManifestState {
  manifestVersion: number;
  manifestHash: string;
}

const validatePinnedManifestState = (pin: PinnedManifestState): void => {
  if (!Number.isSafeInteger(pin.manifestVersion) || pin.manifestVersion < 1) {
    throw new Error('Zakačena verzija manifesta nije validna.');
  }
  sha256Schema.parse(pin.manifestHash);
};

/**
 * Requires the exact manifest version and body hash already accepted locally.
 * This intentionally never accepts a newer version: a hash pointer alone does
 * not prove or validate an omitted transition chain.
 */
export const assertManifestMatchesPin = async (
  candidate: VaultManifestV1,
  pin: PinnedManifestState,
  runtime?: CryptoRuntime,
): Promise<void> => {
  validatePinnedManifestState(pin);
  const parsed = vaultManifestSchema.parse(candidate);
  const hash = await manifestBodyHash(parsed, runtime);
  if (parsed.manifestVersion !== pin.manifestVersion) {
    throw new Error('Manifest nema tačno zakačenu verziju.');
  }
  if (hash !== pin.manifestHash) {
    throw new Error('Server je vratio fork već prihvaćene verzije manifesta.');
  }
};

/**
 * Checks only that a candidate directly references a pin. Callers must still
 * obtain and validate the pinned manifest and run validateManifestTransition;
 * this helper must never be used as a substitute for transition validation.
 */
export const assertManifestIsExactlyNextAfterPin = (
  candidate: VaultManifestV1,
  pin: PinnedManifestState,
): void => {
  validatePinnedManifestState(pin);
  const parsed = vaultManifestSchema.parse(candidate);
  if (
    parsed.manifestVersion !== pin.manifestVersion + 1 ||
    parsed.previousManifestHash !== pin.manifestHash
  ) {
    throw new Error('Manifest nije tačno sledeća verzija zakačenog stanja.');
  }
};

/** Compatibility name retained for current same-version callers. */
export const assertManifestAgainstPin = assertManifestMatchesPin;

export type StandaloneManifestVerification =
  'genesis-self-signature' | 'device-transition-signature' | 'recovery-transition-pin';

/**
 * Verifies every claim that can be proven from one current manifest and an
 * independently authenticated body-hash pin. Recovery transitions are signed
 * by the previous recovery key, which is deliberately absent after rotation;
 * reporting that case explicitly avoids falsely verifying with the new key.
 */
export const verifyStandaloneManifestWithPin = async (
  candidate: VaultManifestV1,
  pin: PinnedManifestState,
  runtime?: CryptoRuntime,
): Promise<StandaloneManifestVerification> => {
  const parsed = vaultManifestSchema.parse(candidate);
  await assertManifestMatchesPin(parsed, pin, runtime);
  if (parsed.manifestVersion === 1) {
    await verifyInitialManifest(parsed, runtime);
    return 'genesis-self-signature';
  }

  const unsigned = withoutSignature(parsed);
  assertSortedUniqueDevices(unsigned);
  assertDeviceAuthorization(unsigned);
  if (parsed.previousManifestHash === null || parsed.transition.kind === 'create') {
    throw new Error('Kasniji manifest nema dozvoljen oblik tranzicije.');
  }

  const transition = parsed.transition;
  if (transition.authorizationKind === 'recovery') {
    if (!['recover-device', 'rotate-recovery'].includes(transition.kind)) {
      throw new Error('Recovery autoritet nije dozvoljen za ovu tranziciju manifesta.');
    }
    if (!isNormalizedP256Signature(base64UrlToBytes(parsed.signature))) {
      throw new Error('Recovery tranzicija nema kanonski P-256 potpis.');
    }
    return 'recovery-transition-pin';
  }

  if (['create', 'recover-device', 'rotate-recovery'].includes(transition.kind)) {
    throw new Error('Uređaj nije dozvoljen autor ove tranzicije manifesta.');
  }
  const authorizingDeviceId = transition.authorizingDeviceId;
  if (!authorizingDeviceId) throw new Error('Tranzicija uređaja nema autora.');

  let authority = parsed.devices.find((device) => device.deviceId === authorizingDeviceId);
  if (!authority && transition.kind === 'revoke-device') {
    const selfRevocation = parsed.revokedDevices.find(
      (device) => device.deviceId === authorizingDeviceId,
    );
    if (
      selfRevocation &&
      transition.affectedDeviceId === authorizingDeviceId &&
      selfRevocation.revocationAuthority === 'device' &&
      selfRevocation.revokedByDeviceId === authorizingDeviceId &&
      selfRevocation.revokedAt === transition.occurredAt &&
      selfRevocation.lastAuthorizedManifestVersion === parsed.manifestVersion - 1
    ) {
      authority = {
        deviceId: selfRevocation.deviceId,
        publicKeys: selfRevocation.publicKeys,
        authorizedAt: transition.occurredAt,
        authorizationExpiresAt: transition.occurredAt,
      };
    }
  }
  if (!authority) {
    throw new Error('Autor potpisa nije dokazivo ovlašćen iz trenutnog manifesta.');
  }

  const publicKey = await importSigningPublicKey(authority.publicKeys.signing, runtime);
  if (
    !(await verifyDomainSeparatedCanonicalSignature(
      SYNC_DOMAIN_LABELS.manifestBody,
      unsigned,
      parsed.signature,
      publicKey,
      runtime,
    ))
  ) {
    throw new Error('Potpis trenutne tranzicije manifesta nije validan.');
  }
  return 'device-transition-signature';
};
