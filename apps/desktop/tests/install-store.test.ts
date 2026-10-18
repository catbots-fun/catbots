import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createNodeProcessIncarnationProvider, InstallStore } from '../src/main/installer/install-store';
import type { InstallJournal } from '../src/main/installer/types';

const directories: string[] = [];

async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'catbots-install-store-'));
  directories.push(directory);
  return { directory, value: new InstallStore(directory) };
}

async function writeStaleLease(directory: string, operationId: string): Promise<void> {
  const locks = join(directory, 'install-locks');
  await mkdir(locks, { recursive: true });
  await writeFile(join(locks, 'stale.lease'), `${JSON.stringify({
    operationId,
    pid: 2_147_483_647,
    token: 'stale',
    processIncarnation: 'stale-incarnation',
  })}\n`, { mode: 0o600 });
}

function journal(overrides: Partial<InstallJournal> = {}): InstallJournal {
  const home = '/Users/tester';
  return {
    schemaVersion: 1,
    operationId: 'operation-1',
    phase: 'prepared',
    desiredReleaseId: '0.2.0+abc123',
    previousInstallation: { kind: 'absent' },
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
  it('uses an absolute process executable and fixed locale/timezone for stable incarnation tokens', async () => {
    const calls: Array<Readonly<{
      executable: string;
      args: readonly string[];
      env: Readonly<Record<string, string>>;
    }>> = [];
    const provider = createNodeProcessIncarnationProvider({
      platform: 'darwin',
      pid: 4242,
      execute: async (executable, args, options) => {
        calls.push({ executable, args, env: options.env });
        return executable === '/usr/sbin/sysctl'
          ? { stdout: '{ sec = 123, usec = 0 }\n' }
          : { stdout: `${options.env.TZ} Mon Jan  1 00:00:00 2024 /Applications/Catbots.app\n` };
      },
    });

    await expect(provider.current()).resolves.toEqual({
      pid: 4242,
      incarnation: 'darwin:{ sec = 123, usec = 0 }\nUTC Mon Jan  1 00:00:00 2024 /Applications/Catbots.app',
    });
    expect(calls).toEqual([
      {
        executable: '/usr/sbin/sysctl',
        args: ['-n', 'kern.boottime'],
        env: { LC_ALL: 'C', TZ: 'UTC' },
      },
      {
        executable: '/bin/ps',
        args: ['-o', 'lstart=', '-o', 'comm=', '-p', '4242'],
        env: { LC_ALL: 'C', TZ: 'UTC' },
      },
    ]);
  });

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
    const next = await value.lock('operation-2');
    await next.release();
  });

  it('persists the process incarnation in every electable lease', async () => {
    const { directory, value } = await store();
    const lock = await value.lock('operation-1');
    const locks = join(directory, 'install-locks');
    const [lease] = (await readdir(locks)).filter((name) => name.endsWith('.lease'));
    if (lease === undefined) throw new Error('test lease missing');

    expect(JSON.parse(await readFile(join(locks, lease), 'utf8'))).toMatchObject({
      processIncarnation: expect.any(String),
    });
    await lock.release();
  });

  it('ignores a live PID lease from a different process incarnation', async () => {
    const { directory } = await store();
    const locks = join(directory, 'install-locks');
    await mkdir(locks);
    await writeFile(join(locks, 'reused-pid.lease'), `${JSON.stringify({
      operationId: 'old-operation',
      pid: 4242,
      token: 'old-token',
      processIncarnation: 'old-incarnation',
    })}\n`);
    const value = new InstallStore(directory, {
      processes: {
        current: async () => ({ pid: 9001, incarnation: 'installer-incarnation' }),
        isAlive: () => true,
        incarnation: async (pid: number) => pid === 4242 ? 'new-incarnation' : 'installer-incarnation',
      },
    });

    const lock = await value.lock('new-operation');
    await lock.release();
  });

  it('fails conservatively when process identity cannot be established', async () => {
    const { directory } = await store();
    const value = new InstallStore(directory, {
      processes: {
        current: async () => { throw new Error('INSTALL_PROCESS_IDENTITY_UNAVAILABLE'); },
        isAlive: () => true,
        incarnation: async () => undefined,
      },
    });

    await expect(value.lock('operation-1')).rejects.toThrow('INSTALL_PROCESS_IDENTITY_UNAVAILABLE');
    await expect(readdir(join(directory, 'install-locks'))).resolves.toEqual([]);
  });

  it('treats an unverifiable live incarnation as locked', async () => {
    const { directory } = await store();
    const locks = join(directory, 'install-locks');
    await mkdir(locks);
    await writeFile(join(locks, 'unknown.lease'), `${JSON.stringify({
      operationId: 'unknown-operation',
      pid: 4242,
      token: 'unknown-token',
      processIncarnation: 'unknown-incarnation',
    })}\n`);
    const value = new InstallStore(directory, {
      processes: {
        current: async () => ({ pid: 9001, incarnation: 'installer-incarnation' }),
        isAlive: () => true,
        incarnation: async (pid: number) => pid === 4242 ? undefined : 'installer-incarnation',
      },
    });

    await expect(value.lock('new-operation')).rejects.toThrow('INSTALL_LOCKED');
  });

  it('ignores crash-partial non-electable temporary lease records', async () => {
    const { directory, value } = await store();
    const locks = join(directory, 'install-locks');
    await mkdir(locks);
    await writeFile(join(locks, 'partial.tmp'), '{partially-written');

    const lock = await value.lock('operation-1');
    await lock.release();
    await expect(readFile(join(locks, 'partial.tmp'), 'utf8')).resolves.toBe('{partially-written');
  });

  it('reclaims a crashed owner lock only for recovery of the journaled operation', async () => {
    const { directory, value } = await store();
    await value.writeJournal(journal());
    await writeStaleLease(directory, 'operation-1');

    const recovered = await value.lockForRecovery('operation-1');
    await expect(value.lock('operation-2')).rejects.toThrow('INSTALL_LOCKED');
    const activeLease = (await Promise.all((await readdir(join(directory, 'install-locks')))
      .filter((name) => name.endsWith('.lease'))
      .map(async (name) => JSON.parse(await readFile(join(directory, 'install-locks', name), 'utf8')))))
      .find((owner) => owner.token !== 'stale');
    if (activeLease === undefined) throw new Error('active test lease missing');
    await recovered.release();

    await writeFile(join(directory, 'install-locks', 'other-live.lease'), `${JSON.stringify({
      operationId: 'another-operation',
      pid: process.pid,
      token: 'other-live',
      processIncarnation: activeLease.processIncarnation,
    })}\n`, { mode: 0o600 });
    await expect(value.lockForRecovery('operation-1')).rejects.toThrow('INSTALL_OPERATION_CONFLICT');
  });

  it('elects only one owner when two contenders reclaim the same crashed lease', async () => {
    const { directory, value } = await store();
    await value.writeJournal(journal());
    await writeStaleLease(directory, 'operation-1');

    const results = await Promise.allSettled([
      value.lockForRecovery('operation-1'),
      new InstallStore(directory).lockForRecovery('operation-1'),
    ]);
    const acquired = results.filter((result) => result.status === 'fulfilled');
    expect(acquired).toHaveLength(1);
    if (acquired[0]?.status === 'fulfilled') await acquired[0].value.release();
  });

  it('does not unlink a replacement lease when an old owner releases', async () => {
    const { directory, value } = await store();
    const lock = await value.lock('operation-1');
    const locks = join(directory, 'install-locks');
    const [lease] = (await readdir(locks)).filter((name) => name.endsWith('.lease'));
    if (lease === undefined) throw new Error('test lease missing');
    const leasePath = join(locks, lease);
    const serialized = await readFile(leasePath, 'utf8');
    await rm(leasePath);
    await writeFile(leasePath, serialized);

    await expect(lock.release()).rejects.toThrow('INSTALL_LOCK_OWNERSHIP_LOST');
    await expect(readFile(leasePath, 'utf8')).resolves.toBe(serialized);
  });

  it('cleans up its own lease record when initialization cannot inspect the lease set', async () => {
    const { directory, value } = await store();
    const locks = join(directory, 'install-locks');
    await mkdir(locks);
    await writeFile(join(locks, 'corrupt.lease'), '{broken');

    await expect(value.lock('operation-1')).rejects.toThrow('INSTALL_LOCK_CORRUPT');
    await expect(readdir(locks)).resolves.toEqual(['corrupt.lease']);
  });

  it('reclaims a crashed lock left before the first journal write', async () => {
    const { directory, value } = await store();
    await writeStaleLease(directory, 'abandoned-operation');

    const next = await value.lock('operation-2');
    await next.release();
    await expect(readFile(join(directory, 'install-locks', 'stale.lease'), 'utf8'))
      .resolves.toContain('abandoned-operation');
  });

  it('rejects malformed journals, operation conflicts, phase regression, and secret-shaped fields', async () => {
    const { directory, value } = await store();
    await value.writeJournal(journal({ phase: 'release-verified' }));
    await expect(value.writeJournal(journal({ operationId: 'operation-2' }))).rejects.toThrow('INSTALL_OPERATION_CONFLICT');
    await expect(value.writeJournal(journal({ phase: 'prepared' }))).rejects.toThrow('INSTALL_PHASE_REGRESSION');
    await expect(value.writeJournal({ ...journal({ phase: 'maintenance-prepared' }), apiKey: 'secret' } as InstallJournal)).rejects.toThrow('INSTALL_JOURNAL_SECRET_FIELD');
    await expect(value.writeJournal({
      ...journal({ phase: 'maintenance-prepared' }),
      previousInstallation: { kind: 'absent', releaseId: 'impossible' },
    } as InstallJournal)).rejects.toThrow('INSTALL_JOURNAL_INVALID');

    await writeFile(join(directory, 'install-journal.json'), '{broken', { mode: 0o600 });
    await expect(value.readJournal()).rejects.toThrow('INSTALL_JOURNAL_CORRUPT');
    await expect(value.clearJournal('operation-2')).rejects.toThrow('INSTALL_JOURNAL_CORRUPT');
  });

  it('releases its lease when journal inspection fails so a repaired retry can proceed', async () => {
    const { directory, value } = await store();
    await writeFile(join(directory, 'install-journal.json'), '{broken', { mode: 0o600 });

    await expect(value.lock('operation-1')).rejects.toThrow('INSTALL_JOURNAL_CORRUPT');
    expect((await readdir(join(directory, 'install-locks'))).filter((name) => name.endsWith('.lease'))).toEqual([]);

    await rm(join(directory, 'install-journal.json'));
    const retry = await value.lock('operation-1');
    await retry.release();
  });
});
