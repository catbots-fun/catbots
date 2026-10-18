import { chmod, mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveManagedPaths } from '../src/main/installer/managed-paths';

const directories: string[] = [];

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'catbots-installer-home-'));
  directories.push(directory);
  await chmod(directory, 0o700);
  return realpath(directory);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('managed installer paths', () => {
  it('resolves the complete fixed path set below one canonical user home', async () => {
    const directory = await home();

    await expect(resolveManagedPaths(directory, process.getuid!())).resolves.toEqual({
      home: directory,
      application: join(directory, 'Applications', 'Catbots.app'),
      command: join(directory, '.local', 'bin', 'catbots'),
      launchAgent: join(directory, 'Library', 'LaunchAgents', 'fun.catbots.web.plist'),
      installerState: join(directory, 'Library', 'Application Support', 'Catbots Installer'),
      productData: join(directory, 'Library', 'Application Support', 'Catbots'),
    });
  });

  it('rejects root, a symlinked home, and a path owned by another user', async () => {
    await expect(resolveManagedPaths('/', process.getuid!())).rejects.toThrow('UNSAFE_MANAGED_PATH');

    const directory = await home();
    const alias = `${directory}-alias`;
    directories.push(alias);
    await symlink(directory, alias);
    await expect(resolveManagedPaths(alias, process.getuid!())).rejects.toThrow('UNSAFE_MANAGED_PATH');
    await expect(resolveManagedPaths(directory, process.getuid!() + 1)).rejects.toThrow('UNSAFE_MANAGED_PATH');
  });

  it('rejects a symlink or unsafe permissions in an existing managed parent', async () => {
    const symlinkHome = await home();
    const outside = await home();
    await mkdir(join(symlinkHome, 'Library'));
    await symlink(outside, join(symlinkHome, 'Library', 'Application Support'));
    await expect(resolveManagedPaths(symlinkHome, process.getuid!())).rejects.toThrow('UNSAFE_MANAGED_PATH');

    const writableHome = await home();
    await mkdir(join(writableHome, 'Applications'), { mode: 0o777 });
    await chmod(join(writableHome, 'Applications'), 0o777);
    await expect(resolveManagedPaths(writableHome, process.getuid!())).rejects.toThrow('UNSAFE_MANAGED_PATH');
  });
});
