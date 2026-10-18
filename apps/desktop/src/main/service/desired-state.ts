import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export type DesiredServiceState = 'running' | 'stopped';

type StoredDesiredState = Readonly<{
  schemaVersion: 1;
  state: DesiredServiceState;
}>;

export class DesiredStateStore {
  constructor(private readonly path: string) {}

  async read(): Promise<DesiredServiceState> {
    let contents: string;
    try {
      contents = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return 'stopped';
      throw error;
    }

    try {
      const value = JSON.parse(contents) as Partial<StoredDesiredState>;
      if (value.schemaVersion !== 1 || (value.state !== 'running' && value.state !== 'stopped')) {
        throw new Error('invalid');
      }
      return value.state;
    } catch {
      throw new Error('DESIRED_STATE_INVALID');
    }
  }

  async write(state: DesiredServiceState): Promise<void> {
    const parent = dirname(this.path);
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(parent, { recursive: true, mode: 0o700 });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, state } satisfies StoredDesiredState)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);
      const directory = await open(parent, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
