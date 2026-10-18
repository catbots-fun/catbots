import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  verifyProductionPackage,
  verifyRequiredEntries,
} from '../../../scripts/verify-package-contents.mjs';
import { verifyForgePackageOutputs } from '../forge.config';

const temporaryDirectories: string[] = [];
const trustPublicKey = generateKeyPairSync('rsa', { modulusLength: 3072 }).publicKey
  .export({ type: 'spki', format: 'pem' }).toString();
const trustMetadata = JSON.stringify({
  schemaVersion: 1, teamId: 'ABCDE12345', publicKey: trustPublicKey, commit: 'abc123',
  fingerprint: createHash('sha256').update(trustPublicKey).digest('hex'),
});
const trustFingerprint = createHash('sha256').update(trustPublicKey).digest('hex');
const trustInstaller = `TEAM_ID='ABCDE12345'\nPUBLIC_KEY_PEM='${trustPublicKey.trim()}\n'\nPUBLIC_KEY_FINGERPRINT='${trustFingerprint}'\nRELEASE_TRUST_STATE='CATBOTS_RELEASE_TRUST_INJECTED'\n`;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

async function packageTree(entries: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'catbots-package-contents-'));
  temporaryDirectories.push(directory);
  for (const entry of entries) {
    const path = join(directory, entry);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry);
  }
  return directory;
}

describe('required package contents', () => {
  it('accepts the production browser entry and one emitted asset', async () => {
    const directory = await packageTree([
      'Catbots.app/Contents/Resources/app/.vite/renderer/main_window/web.html',
      'Catbots.app/Contents/Resources/app/.vite/renderer/main_window/assets/web-main-CATBOTS.js',
    ]);

    await expect(verifyRequiredEntries(directory, [
      { kind: 'exact', path: '.vite/renderer/main_window/web.html' },
      { kind: 'prefix', path: '.vite/renderer/main_window/assets/web-main-' },
    ])).resolves.toBeUndefined();
  });

  it('requires the command wrapper, LaunchAgent template, and bootstrap installer', async () => {
    const directory = await packageTree([
      'Catbots.app/Contents/Resources/app/.vite/renderer/main_window/web.html',
      'Catbots.app/Contents/Resources/catbots',
      'Catbots.app/Contents/Resources/fun.catbots.web.plist.template',
      'Catbots.app/Contents/Resources/install.sh',
      'Catbots.app/Contents/Resources/release-trust.json',
    ]);
    await writeFile(join(directory, 'Catbots.app/Contents/Resources/release-trust.json'), trustMetadata);
    await writeFile(join(directory, 'Catbots.app/Contents/Resources/install.sh'), trustInstaller);

    await expect(verifyProductionPackage(directory)).resolves.toBeUndefined();

    const missing = await packageTree([
      'Catbots.app/Contents/Resources/app/.vite/renderer/main_window/web.html',
      'Catbots.app/Contents/Resources/catbots',
    ]);
    await expect(verifyProductionPackage(missing))
      .rejects.toThrow('Missing required packaged entry: Resources/fun.catbots.web.plist.template');
  });

  it('rejects mismatched bootstrap and signed-app release trust roots', async () => {
    const directory = await packageTree([
      'Catbots.app/Contents/Resources/app/.vite/renderer/main_window/web.html',
      'Catbots.app/Contents/Resources/catbots',
      'Catbots.app/Contents/Resources/fun.catbots.web.plist.template',
      'Catbots.app/Contents/Resources/install.sh',
      'Catbots.app/Contents/Resources/release-trust.json',
    ]);
    await writeFile(join(directory, 'Catbots.app/Contents/Resources/install.sh'), trustInstaller.replace('ABCDE12345', 'ZZZZZ99999'));
    await writeFile(join(directory, 'Catbots.app/Contents/Resources/release-trust.json'), trustMetadata);

    await expect(verifyProductionPackage(directory)).rejects.toThrow('Bootstrap release trust does not match');
    await expect(verifyForgePackageOutputs([directory])).rejects.toThrow('Bootstrap release trust does not match');
  });

  it('rejects a package missing web.html', async () => {
    const directory = await packageTree([
      'Catbots.app/Contents/Resources/app/.vite/renderer/main_window/index.html',
    ]);

    await expect(verifyRequiredEntries(directory, [
      { kind: 'exact', path: '.vite/renderer/main_window/web.html' },
    ])).rejects.toThrow('Missing required packaged entry: .vite/renderer/main_window/web.html');
  });

  it('rejects a package missing the emitted browser asset', async () => {
    const directory = await packageTree([
      'Catbots.app/Contents/Resources/app/.vite/renderer/main_window/web.html',
    ]);

    await expect(verifyRequiredEntries(directory, [
      { kind: 'prefix', path: '.vite/renderer/main_window/assets/web-main-' },
    ])).rejects.toThrow('Missing required packaged entry prefix: .vite/renderer/main_window/assets/web-main-');
  });
});
