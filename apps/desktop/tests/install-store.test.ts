import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { InstallStore } from '../src/main/installer/install-store';
import type { InstallJournal } from '../src/main/installer/types';

const directories: string[] = [];

async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'catbots-install-store-'));
  directories.push(directory);
  return { directory, value: new InstallStore(directory) };
}

function journal(overrides: Partial<InstallJournal> = {}): InstallJournal {
  const home = '/Users/tester';
  return {
    schemaVersion: 1,
    operationId: 'operation-1',
    phase: 'prepared',
    desiredReleaseId: '0.2.0+abc123',
    desiredService: 'running',
    preserveData: true,
    paths: {
      home,
      application: `${home}/Applications/Catbots.app`,
      command: `${home}/.local/bin/catbots`,
      launchAgent: `${home}/Library/LaunchAgents/fun.catbots.web.plist`,
      installerState: `${home}/Library/Application Support/Catbots Installer`,
      productData: `${home}/Library/Application Support/Catbots`,
    },
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('installer transaction store', () => {
  it('writes, reads, advances, and clears one operation journal', async () => {
    const { directory, value } = await store();
    await value.writeJournal(journal());
    await expect(value.readJournal()).resolves.toEqual(journal());
    await value.writeJournal(journal({ phase: 'release-verified', updatedAt: '2026-10-18T00:01:00.000Z' }));
    await expect(value.readJournal()).resolves.toMatchObject({ phase: 'release-verified' });
    expect(JSON.parse(await readFile(join(directory, 'install-journal.json'), 'utf8'))).toMatchObject({ phase: 'release-verified' });
    await value.clearJournal('operation-1');
    await expect(value.readJournal()).resolves.toBeUndefined();
  });

  it('holds an exclusive lock and releases it idempotently', async () => {
    const { value } = await store();
    const lock = await value.lock('operation-1');
    await expect(value.lock('operation-2')).rejects.toThrow('INSTALL_LOCKED');
    await lock.release();
    await lock.release();
    await expect(value.lock('operation-2')).resolves.toBeDefined();
  });

  it('rejects malformed journals, operation conflicts, phase regression, and secret-shaped fields', async () => {
    const { directory, value } = await store();
    await value.writeJournal(journal({ phase: 'release-verified' }));
    await expect(value.writeJournal(journal({ operationId: 'operation-2' }))).rejects.toThrow('INSTALL_OPERATION_CONFLICT');
    await expect(value.writeJournal(journal({ phase: 'prepared' }))).rejects.toThrow('INSTALL_PHASE_REGRESSION');
    await expect(value.writeJournal({ ...journal({ phase: 'maintenance-prepared' }), apiKey: 'secret' } as InstallJournal)).rejects.toThrow('INSTALL_JOURNAL_SECRET_FIELD');

    await writeFile(join(directory, 'install-journal.json'), '{broken', { mode: 0o600 });
    await expect(value.readJournal()).rejects.toThrow('INSTALL_JOURNAL_CORRUPT');
    await expect(value.clearJournal('operation-2')).rejects.toThrow('INSTALL_JOURNAL_CORRUPT');
  });
});
