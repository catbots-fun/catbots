import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ManagedPaths } from './types';

const unsafePath = (): never => {
  throw new Error('UNSAFE_MANAGED_PATH');
};

function isInside(path: string, parent: string): boolean {
  const relation = relative(parent, path);
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
}

async function inspectExistingPath(path: string, expectedUid: number): Promise<void> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || status.uid !== expectedUid || (status.mode & 0o022) !== 0) unsafePath();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function inspectPathChain(target: string, home: string, expectedUid: number): Promise<void> {
  const segments = relative(home, target).split('/').filter(Boolean);
  let current = home;
  for (const segment of segments) {
    current = join(current, segment);
    await inspectExistingPath(current, expectedUid);
  }
}

export async function resolveManagedPaths(homeDirectory: string, expectedUid: number): Promise<ManagedPaths> {
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0 || !isAbsolute(homeDirectory)) unsafePath();
  const requestedHome = resolve(homeDirectory);
  if (requestedHome === dirname(requestedHome)) unsafePath();

  try {
    const canonicalHome = await realpath(requestedHome);
    const status = await lstat(requestedHome);
    if (canonicalHome !== requestedHome || !status.isDirectory() || status.isSymbolicLink()
      || status.uid !== expectedUid || (status.mode & 0o022) !== 0) unsafePath();

    const paths: ManagedPaths = Object.freeze({
      home: canonicalHome,
      application: join(canonicalHome, 'Applications', 'Catbots.app'),
      command: join(canonicalHome, '.local', 'bin', 'catbots'),
      launchAgent: join(canonicalHome, 'Library', 'LaunchAgents', 'fun.catbots.web.plist'),
      installerState: join(canonicalHome, 'Library', 'Application Support', 'Catbots Installer'),
      productData: join(canonicalHome, 'Library', 'Application Support', 'Catbots'),
    });
    for (const target of Object.values(paths).slice(1)) {
      if (!isInside(target, canonicalHome)) unsafePath();
      await inspectPathChain(target, canonicalHome, expectedUid);
    }
    return paths;
  } catch (error) {
    if (error instanceof Error && error.message === 'UNSAFE_MANAGED_PATH') throw error;
    return unsafePath();
  }
}
