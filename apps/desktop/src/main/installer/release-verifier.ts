import { createHash, verify } from 'node:crypto';
import { z } from 'zod';
import type {
  ReleaseArchitecture,
  ReleaseManifest,
  VerifiedRelease,
} from './types';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const macOSVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{6,64}$/;

const artifactSchema = z.strictObject({
  url: z.string().url(),
  sha256: z.string().regex(sha256Pattern),
  bytes: z.number().int().positive(),
});

const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  releaseId: z.string().min(1),
  version: z.string().regex(versionPattern),
  commit: z.string().regex(commitPattern),
  publishedAt: z.string().datetime({ offset: true }),
  minimumMacOS: z.string().regex(macOSVersionPattern),
  bundleId: z.literal('com.catbots.desktop'),
  teamId: z.string().regex(/^[A-Z0-9]{5,16}$/),
  protocolVersion: z.number().int().positive(),
  dataSchemaVersion: z.number().int().nonnegative(),
  artifacts: z.strictObject({ arm64: artifactSchema, x64: artifactSchema }),
});

type ReleaseVerificationInput = Readonly<{
  manifestBytes: Uint8Array;
  signatureBytes: Uint8Array;
  trustedPublicKeys: readonly string[];
  architecture: ReleaseArchitecture;
  archiveBytes: Uint8Array;
  finalArtifactUrl: string;
  stagedAppPath: string;
  installedVersion?: string;
  currentMacOS: string;
  pinnedTeamId: string;
}>;

export type ApplicationInspection = Readonly<{
  bundleId: string;
  teamId: string;
  architectures: readonly ReleaseArchitecture[];
  codeSignatureValid: boolean;
  hardenedRuntime: boolean;
  gatekeeperAccepted: boolean;
  notarized: boolean;
}>;

export type ReleaseVerificationPlatform = Readonly<{
  inspectApplication(path: string): Promise<ApplicationInspection>;
}>;

const fail = (code: string): never => { throw new Error(code); };

export async function verifyRelease(
  input: ReleaseVerificationInput,
  platform: ReleaseVerificationPlatform,
): Promise<VerifiedRelease> {
  if (input.trustedPublicKeys.length === 0 || !input.trustedPublicKeys.some((key) => {
    try {
      return verify(null, input.manifestBytes, key, input.signatureBytes);
    } catch {
      return false;
    }
  })) fail('RELEASE_SIGNATURE_INVALID');

  const manifest = parseManifest(input.manifestBytes);
  if (manifest.releaseId !== `${manifest.version}+${manifest.commit}`) fail('RELEASE_MANIFEST_INVALID');
  if (manifest.teamId !== input.pinnedTeamId) fail('RELEASE_TEAM_ID_MISMATCH');
  if (!macOSVersionPattern.test(input.currentMacOS)
    || compareVersions(input.currentMacOS, manifest.minimumMacOS) < 0) fail('RELEASE_MACOS_UNSUPPORTED');
  const artifact = manifest.artifacts[input.architecture];
  assertImmutableReleaseUrl(artifact.url);
  assertApprovedRedirect(input.finalArtifactUrl);
  if (input.archiveBytes.byteLength !== artifact.bytes) fail('RELEASE_ARTIFACT_SIZE_MISMATCH');
  const digest = createHash('sha256').update(input.archiveBytes).digest('hex');
  if (digest !== artifact.sha256) fail('RELEASE_ARTIFACT_DIGEST_MISMATCH');
  if (input.installedVersion !== undefined) {
    if (!versionPattern.test(input.installedVersion)) fail('RELEASE_INSTALLED_VERSION_INVALID');
    if (compareVersions(manifest.version, input.installedVersion) < 0) fail('RELEASE_DOWNGRADE_DENIED');
  }

  const inspection = await platform.inspectApplication(input.stagedAppPath);
  if (inspection.bundleId !== manifest.bundleId) fail('RELEASE_BUNDLE_ID_MISMATCH');
  if (inspection.teamId !== manifest.teamId) fail('RELEASE_TEAM_ID_MISMATCH');
  if (!inspection.architectures.includes(input.architecture)) fail('RELEASE_ARCHITECTURE_MISMATCH');
  if (!inspection.codeSignatureValid) fail('RELEASE_CODE_SIGNATURE_INVALID');
  if (!inspection.hardenedRuntime) fail('RELEASE_HARDENED_RUNTIME_MISSING');
  if (!inspection.gatekeeperAccepted) fail('RELEASE_GATEKEEPER_REJECTED');
  if (!inspection.notarized) fail('RELEASE_NOTARIZATION_MISSING');

  return Object.freeze({
    releaseId: manifest.releaseId,
    version: manifest.version,
    commit: manifest.commit,
    architecture: input.architecture,
    artifact,
    protocolVersion: manifest.protocolVersion,
    dataSchemaVersion: manifest.dataSchemaVersion,
    stagedAppPath: input.stagedAppPath,
  });
}

function parseManifest(bytes: Uint8Array): ReleaseManifest {
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(Buffer.from(bytes).toString('utf8')));
    if (!parsed.success) return fail('RELEASE_MANIFEST_INVALID');
    return parsed.data;
  } catch (error) {
    if (error instanceof Error && error.message === 'RELEASE_MANIFEST_INVALID') throw error;
    return fail('RELEASE_MANIFEST_INVALID');
  }
}

function assertImmutableReleaseUrl(value: string): void {
  const url = new URL(value);
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '' || parts.length < 6
    || parts[0] !== 'catbots-fun' || parts[1] !== 'catbots' || parts[2] !== 'releases'
    || parts[3] !== 'download' || parts.slice(4).some((part) => part === '.' || part === '..')) {
    fail('RELEASE_ARTIFACT_URL_INVALID');
  }
}

function assertApprovedRedirect(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('RELEASE_ARTIFACT_REDIRECT_DENIED');
  }
  if (url.protocol !== 'https:' || ![
      'github.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
    ].includes(url.hostname) || url.username !== '' || url.password !== '') {
    fail('RELEASE_ARTIFACT_REDIRECT_DENIED');
  }
}

function compareVersions(left: string, right: string): number {
  const values = [left, right].map((version) => {
    const parts = version.split('.').map(Number);
    return [parts[0]!, parts[1]!, parts[2] ?? 0];
  });
  for (let index = 0; index < 3; index += 1) {
    const difference = values[0]![index]! - values[1]![index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
