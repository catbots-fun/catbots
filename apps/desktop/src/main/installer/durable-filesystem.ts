import { access, open } from 'node:fs/promises';

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function pathExists(
  path: string,
  accessPath: (path: string) => Promise<unknown> = access,
): Promise<boolean> {
  try {
    await accessPath(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
