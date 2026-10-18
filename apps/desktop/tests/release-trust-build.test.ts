import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { renderBootstrapInstaller } from '../../../scripts/render-bootstrap-installer.mjs';
import { assertReleaseTrustFile } from '../../../scripts/check-release-trust.mjs';

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('release trust build seam', () => {
  const publicKey = generateKeyPairSync('rsa', { modulusLength: 3072 }).publicKey
    .export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = createHash('sha256').update(publicKey).digest('hex');

  it('requires an independently pinned expected fingerprint when generating release assets', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'catbots-release-trust-'));
    temporaryDirectories.push(outputDirectory);
    await expect(renderBootstrapInstaller({
      teamId: 'ABCDE12345', publicKey, commit: 'abc123', outputDirectory,
      expectedFingerprint: '0'.repeat(64),
    })).rejects.toThrow('RELEASE_TRUST_FINGERPRINT_MISMATCH');
  });

  it('checks trust metadata against a separate build-time fingerprint pin', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'catbots-release-trust-'));
    temporaryDirectories.push(outputDirectory);
    const rendered = await renderBootstrapInstaller({
      teamId: 'ABCDE12345', publicKey, commit: 'abc123', outputDirectory, expectedFingerprint: fingerprint,
    });
    await expect(assertReleaseTrustFile(rendered.trustPath, 'f'.repeat(64)))
      .rejects.toThrow('fingerprint does not match the independently pinned value');
    await expect(assertReleaseTrustFile(rendered.trustPath, fingerprint)).resolves.toBeUndefined();
  });

  it('rejects weak RSA release roots in the renderer', async () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
      .export({ type: 'spki', format: 'pem' }).toString();
    const outputDirectory = await mkdtemp(join(tmpdir(), 'catbots-release-trust-'));
    temporaryDirectories.push(outputDirectory);
    await expect(renderBootstrapInstaller({
      teamId: 'ABCDE12345', publicKey: weak,
      expectedFingerprint: createHash('sha256').update(weak).digest('hex'),
      commit: 'abc123', outputDirectory,
    })).rejects.toThrow('RELEASE_TRUST_INVALID');
  });

  it('rejects weak RSA release roots in the production build check', async () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
      .export({ type: 'spki', format: 'pem' }).toString();
    const outputDirectory = await mkdtemp(join(tmpdir(), 'catbots-release-trust-'));
    temporaryDirectories.push(outputDirectory);
    const path = join(outputDirectory, 'release-trust.json');
    const fingerprint = createHash('sha256').update(weak).digest('hex');
    await writeFile(path, JSON.stringify({ schemaVersion: 1, teamId: 'ABCDE12345', publicKey: weak, commit: 'abc123', fingerprint }));
    await expect(assertReleaseTrustFile(path, fingerprint))
      .rejects.toThrow('invalid or sentinel trust roots');
  });
});
