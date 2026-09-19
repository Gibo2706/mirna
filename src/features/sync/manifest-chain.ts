import { canonicalizeJson } from '@/domain/sync/canonical';
import {
  assertManifestMatchesPin,
  manifestBodyHash,
  validateManifestTransition,
  verifyInitialManifest,
} from '@/domain/sync/manifest';
import { manifestChangesResponseSchema, type VaultManifestV1 } from '@/domain/sync/schemas';

export class ManifestChainError extends Error {
  constructor(
    readonly code: 'manifest-gap' | 'manifest-fork',
    message: string,
  ) {
    super(message);
    this.name = 'ManifestChainError';
  }
}

/** The server supplies evidence; the caller supplies the independently trusted endpoint. */
export async function collectVerifiedManifestChain(input: {
  getManifestChanges: (after: number) => Promise<unknown>;
  previous?: VaultManifestV1;
  expected: VaultManifestV1;
  expectedHash: string;
  allowNewerHistory?: boolean;
}): Promise<VaultManifestV1[]> {
  await assertManifestMatchesPin(input.expected, {
    manifestVersion: input.expected.manifestVersion,
    manifestHash: input.expectedHash,
  });
  const chain: VaultManifestV1[] = [];
  let previous = input.previous;
  let after = previous?.manifestVersion ?? 0;
  for (let page = 0; page < 100; page += 1) {
    const response = manifestChangesResponseSchema.parse(await input.getManifestChanges(after));
    const last = response.manifests.at(-1);
    if (
      !last ||
      response.manifests.some(
        (manifest, index) => manifest.manifestVersion !== after + index + 1,
      ) ||
      (response.nextAfterManifestVersion !== null &&
        response.nextAfterManifestVersion !== last.manifestVersion)
    ) {
      throw new ManifestChainError('manifest-gap', 'Server nije vratio neprekidan manifest lanac.');
    }
    for (const manifest of response.manifests) {
      if (previous) await validateManifestTransition(previous, manifest);
      else await verifyInitialManifest(manifest);
      chain.push(manifest);
      previous = manifest;
      if (manifest.manifestVersion === input.expected.manifestVersion) {
        if (
          (!input.allowNewerHistory &&
            (last.manifestVersion !== manifest.manifestVersion ||
              response.nextAfterManifestVersion !== null)) ||
          (await manifestBodyHash(manifest)) !== input.expectedHash ||
          canonicalizeJson(manifest) !== canonicalizeJson(input.expected)
        ) {
          throw new ManifestChainError(
            'manifest-fork',
            'Manifest lanac ne završava trusted pinom.',
          );
        }
        return chain;
      }
    }
    if (response.nextAfterManifestVersion === null) break;
    after = response.nextAfterManifestVersion;
  }
  throw new ManifestChainError('manifest-gap', 'Manifest istorija nije kompletna ili je preduga.');
}

export async function resolveSnapshotParentManifest(input: {
  getManifestChanges: (after: number) => Promise<unknown>;
  trusted: VaultManifestV1;
  trustedHash: string;
  parentHash: string;
}): Promise<VaultManifestV1> {
  const chain = await collectVerifiedManifestChain({
    getManifestChanges: input.getManifestChanges,
    expected: input.trusted,
    expectedHash: input.trustedHash,
    allowNewerHistory: true,
  });
  const matches: VaultManifestV1[] = [];
  for (const manifest of chain) {
    if ((await manifestBodyHash(manifest)) === input.parentHash) matches.push(manifest);
  }
  if (matches.length !== 1) {
    throw new ManifestChainError('manifest-fork', 'Snapshot manifest nije u dokazanom lancu.');
  }
  return matches[0];
}
