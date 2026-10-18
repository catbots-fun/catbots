import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { verifyRelease } from '../src/main/installer/release-verifier';
import type { ReleaseManifest } from '../src/main/installer/types';

const archive = Buffer.from('fixture Catbots archive');
const artifact = {
  url: 'https://github.com/catbots-fun/catbots/releases/download/v0.2.0/Catbots-darwin-arm64.zip',
  sha256: createHash('sha256').update(archive).digest('hex'),
  bytes: archive.byteLength,
};
const manifest: ReleaseManifest = {
  schemaVersion: 1,
  releaseId: '0.2.0+abc123',
  version: '0.2.0',
  commit: 'abc123',
  publishedAt: '2026-10-18T00:00:00.000Z',
  minimumMacOS: '13.0.0',
  bundleId: 'com.catbots.desktop',
  teamId: 'CATB0TTEAM',
  protocolVersion: 1,
  dataSchemaVersion: 7,
  artifacts: { arm64: artifact, x64: { ...artifact, url: artifact.url.replace('arm64', 'x64') } },
};

function signed(value: unknown = manifest) {
  const bytes = Buffer.from(JSON.stringify(value));
  const keys = generateKeyPairSync('ed25519');
  return {
    manifestBytes: bytes,
    signatureBytes: sign(null, bytes, keys.privateKey),
    trustedPublicKeys: [keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()],
  };
}

function platform(overrides: Partial<Parameters<typeof verifyRelease>[1]> = {}) {
  return {
    inspectApplication: vi.fn(async () => ({
      bundleId: 'com.catbots.desktop',
      teamId: 'CATB0TTEAM',
      architectures: ['arm64'] as const,
      codeSignatureValid: true,
      gatekeeperAccepted: true,
      notarized: true,
    })),
    ...overrides,
  };
}

describe('release verifier', () => {
  it('verifies exact manifest bytes, immutable artifact bytes, and staged app trust', async () => {
    const verified = await verifyRelease({
      ...signed(),
      architecture: 'arm64',
      archiveBytes: archive,
      finalArtifactUrl: artifact.url,
      stagedAppPath: '/private/tmp/Catbots.app',
      installedVersion: '0.1.0',
      currentMacOS: '14.0.0',
      pinnedTeamId: 'CATB0TTEAM',
    }, platform());

    expect(verified).toMatchObject({ releaseId: '0.2.0+abc123', version: '0.2.0', architecture: 'arm64' });
  });

  it('rejects a changed signature, digest, size, redirect host, and downgrade', async () => {
    const valid = signed();
    const base = {
      ...valid,
      architecture: 'arm64' as const,
      archiveBytes: archive,
      finalArtifactUrl: artifact.url,
      stagedAppPath: '/private/tmp/Catbots.app',
      currentMacOS: '14.0.0',
      pinnedTeamId: 'CATB0TTEAM',
    };

    await expect(verifyRelease({ ...base, signatureBytes: Buffer.alloc(64) }, platform())).rejects.toThrow('RELEASE_SIGNATURE_INVALID');
    await expect(verifyRelease({ ...base, archiveBytes: Buffer.from('changed') }, platform())).rejects.toThrow('RELEASE_ARTIFACT_SIZE_MISMATCH');
    await expect(verifyRelease({ ...base, finalArtifactUrl: 'https://attacker.example/Catbots.zip' }, platform())).rejects.toThrow('RELEASE_ARTIFACT_REDIRECT_DENIED');
    await expect(verifyRelease({ ...base, finalArtifactUrl: 'not a URL' }, platform())).rejects.toThrow('RELEASE_ARTIFACT_REDIRECT_DENIED');
    await expect(verifyRelease({ ...base, installedVersion: '0.3.0' }, platform())).rejects.toThrow('RELEASE_DOWNGRADE_DENIED');
    await expect(verifyRelease({ ...base, currentMacOS: '12.6.0' }, platform())).rejects.toThrow('RELEASE_MACOS_UNSUPPORTED');

    const otherTeamManifest = { ...manifest, teamId: 'EVILTEAM' };
    const otherTeam = signed(otherTeamManifest);
    await expect(verifyRelease({ ...base, ...otherTeam }, platform())).rejects.toThrow('RELEASE_TEAM_ID_MISMATCH');
  });

  it('rejects unknown manifest fields and every failed staged-app trust check', async () => {
    const withUnknown = signed({ ...manifest, unexpected: true });
    const input = {
      ...withUnknown,
      architecture: 'arm64' as const,
      archiveBytes: archive,
      finalArtifactUrl: artifact.url,
      stagedAppPath: '/private/tmp/Catbots.app',
      currentMacOS: '14.0.0',
      pinnedTeamId: 'CATB0TTEAM',
    };
    await expect(verifyRelease(input, platform())).rejects.toThrow('RELEASE_MANIFEST_INVALID');

    for (const [field, code] of [
      ['bundleId', 'RELEASE_BUNDLE_ID_MISMATCH'],
      ['teamId', 'RELEASE_TEAM_ID_MISMATCH'],
      ['architectures', 'RELEASE_ARCHITECTURE_MISMATCH'],
      ['codeSignatureValid', 'RELEASE_CODE_SIGNATURE_INVALID'],
      ['gatekeeperAccepted', 'RELEASE_GATEKEEPER_REJECTED'],
      ['notarized', 'RELEASE_NOTARIZATION_MISSING'],
    ] as const) {
      const inspection = {
        bundleId: 'com.catbots.desktop',
        teamId: 'CATB0TTEAM',
        architectures: ['arm64'] as readonly ('arm64' | 'x64')[],
        codeSignatureValid: true,
        gatekeeperAccepted: true,
        notarized: true,
      };
      if (field === 'bundleId') inspection.bundleId = 'evil.bundle';
      else if (field === 'teamId') inspection.teamId = 'EVILTEAM';
      else if (field === 'architectures') inspection.architectures = ['x64'];
      else inspection[field] = false;
      await expect(verifyRelease({
        ...signed(), architecture: 'arm64', archiveBytes: archive,
        finalArtifactUrl: artifact.url, stagedAppPath: '/private/tmp/Catbots.app',
        currentMacOS: '14.0.0', pinnedTeamId: 'CATB0TTEAM',
      }, platform({ inspectApplication: vi.fn(async () => inspection) }))).rejects.toThrow(code);
    }
  });

  it('accepts normal macOS versions and rejects non-canonical release versions', async () => {
    const base = {
      architecture: 'arm64' as const,
      archiveBytes: archive,
      finalArtifactUrl: artifact.url,
      stagedAppPath: '/private/tmp/Catbots.app',
      pinnedTeamId: 'CATB0TTEAM',
    };
    await expect(verifyRelease({ ...base, ...signed(), currentMacOS: '14.0' }, platform())).resolves.toMatchObject({ version: '0.2.0' });
    await expect(verifyRelease({
      ...base,
      ...signed({ ...manifest, minimumMacOS: '13.0' }),
      currentMacOS: '14.0',
    }, platform())).resolves.toMatchObject({ version: '0.2.0' });

    for (const version of ['01.0.0', '1.00.0', '1.0', '1.0.0-beta']) {
      const invalid = { ...manifest, version, releaseId: `${version}+abc123` };
      await expect(verifyRelease({ ...base, ...signed(invalid), currentMacOS: '14.0' }, platform())).rejects.toThrow('RELEASE_MANIFEST_INVALID');
    }
    await expect(verifyRelease({ ...base, ...signed(), installedVersion: '01.0.0', currentMacOS: '14.0' }, platform())).rejects.toThrow('RELEASE_INSTALLED_VERSION_INVALID');
  });
});
