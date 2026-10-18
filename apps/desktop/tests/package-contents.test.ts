import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyRequiredEntries } from '../../../scripts/verify-package-contents.mjs';

const temporaryDirectories: string[] = [];

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
