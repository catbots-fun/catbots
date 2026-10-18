import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesiredStateStore } from '../src/main/service/desired-state';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'catbots-desired-state-'));
  directories.push(directory);
  return { directory, path: join(directory, 'service-state.json') };
}

describe('DesiredStateStore', () => {
  it('fails closed to stopped when the state file is missing', async () => {
    const { path } = await fixture();

    await expect(new DesiredStateStore(path).read()).resolves.toBe('stopped');
  });

  it('rejects malformed state instead of guessing', async () => {
    const { path } = await fixture();
    await writeFile(path, '{"schemaVersion":1,"state":"maybe"}', 'utf8');

    await expect(new DesiredStateStore(path).read()).rejects.toThrow('DESIRED_STATE_INVALID');
  });

  it('atomically persists complete states without leaving temporary files', async () => {
    const { directory, path } = await fixture();
    const store = new DesiredStateStore(path);

    await Promise.all(Array.from({ length: 20 }, (_, index) => store.write(
      index % 2 === 0 ? 'running' : 'stopped',
    )));

    await expect(store.read()).resolves.toMatch(/^(running|stopped)$/);
    expect(await readdir(directory)).toEqual(['service-state.json']);
  });

  it('preserves the desired state across a replacement store instance', async () => {
    const { path } = await fixture();
    await new DesiredStateStore(path).write('running');

    await expect(new DesiredStateStore(path).read()).resolves.toBe('running');
  });
});
