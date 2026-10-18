import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SnapshotStore } from '../src/main/installer/snapshot-store';

const directories: string[] = [];

async function fixture(availableBytes = 1_000_000) {
  const root = await mkdtemp(join(tmpdir(), 'catbots-snapshot-store-'));
  directories.push(root);
  const data = join(root, 'product-data');
  const state = join(root, 'installer-state');
  await mkdir(data, { recursive: true, mode: 0o700 });
  return {
    root,
    data,
    state,
    store: new SnapshotStore(state, data, { availableBytes: async () => availableBytes }),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('installer data snapshots', () => {
  it('creates a completed snapshot and restores the exact product data', async () => {
    const { data, store } = await fixture();
    await writeFile(join(data, 'config.yaml'), 'profile: before\n', { mode: 0o600 });
    const snapshot = await store.create({ operationId: 'operation-1', requiredBytes: 100 });
    expect(snapshot).toMatchObject({ operationId: 'operation-1', complete: true });

    await writeFile(join(data, 'config.yaml'), 'profile: after\n', { mode: 0o600 });
    await store.restore('operation-1');
    await expect(readFile(join(data, 'config.yaml'), 'utf8')).resolves.toBe('profile: before\n');
  });

  it('stops before copying when free space is insufficient and rejects source symlinks', async () => {
    const insufficient = await fixture(99);
    await writeFile(join(insufficient.data, 'config.yaml'), 'safe');
    await expect(insufficient.store.create({ operationId: 'operation-1', requiredBytes: 100 })).rejects.toThrow('INSTALL_DISK_SPACE_INSUFFICIENT');

    const unsafe = await fixture();
    const external = join(unsafe.root, 'external.txt');
    await writeFile(external, 'outside');
    await symlink(external, join(unsafe.data, 'linked-secret'));
    await expect(unsafe.store.create({ operationId: 'operation-2', requiredBytes: 100 })).rejects.toThrow('SNAPSHOT_SOURCE_UNSAFE');
  });

  it('keeps the newest successful snapshot and every unresolved snapshot', async () => {
    const { state, store } = await fixture();
    await store.create({ operationId: 'old-success', requiredBytes: 1 });
    await store.create({ operationId: 'new-success', requiredBytes: 1 });
    await store.create({ operationId: 'unresolved', requiredBytes: 1 });

    await store.prune({ newestSuccessfulOperationId: 'new-success', unresolvedOperationIds: ['unresolved'] });

    await expect(readFile(join(state, 'snapshots', 'new-success', 'snapshot.json'), 'utf8')).resolves.toContain('new-success');
    await expect(readFile(join(state, 'snapshots', 'unresolved', 'snapshot.json'), 'utf8')).resolves.toContain('unresolved');
    await expect(readFile(join(state, 'snapshots', 'old-success', 'snapshot.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves and reports an incomplete snapshot instead of replacing its evidence', async () => {
    const { state, store } = await fixture();
    const incomplete = join(state, 'snapshots', 'operation-1');
    await mkdir(join(incomplete, 'data'), { recursive: true });
    await writeFile(join(incomplete, 'data', 'evidence.txt'), 'partial');

    await expect(store.create({ operationId: 'operation-1', requiredBytes: 1 })).rejects.toThrow('SNAPSHOT_CORRUPT');
    await expect(readFile(join(incomplete, 'data', 'evidence.txt'), 'utf8')).resolves.toBe('partial');
  });
});
