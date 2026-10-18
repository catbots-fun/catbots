import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  CommandWrapperTransaction,
  acquireCurrentMaintenance,
  ensurePrivateDirectory,
  stopCandidate,
} from '../src/main/installer/production-installer';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'catbots-production-installer-'));
  temporaryDirectories.push(root);
  return root;
}

describe('production installer filesystem assembly', () => {
  it('refreshes the current service identity when acquiring maintenance after recovery', async () => {
    const controls: string[] = [];
    const current = { ...releaseIdentity, instanceId: 'restored-instance', readiness: 'ready' as const };
    const result = await acquireCurrentMaintenance({
      operationId: 'operation-new',
      releaseId: '0.2.0+new',
      socketPath: '/private/control.sock',
      health: { current: async () => current },
      createControl: (options: { socketPath: string; expectedInstanceId: string }) => {
        controls.push(`instance:${options.expectedInstanceId}`);
        return { execute: async (command: { kind: string; operationId?: string; targetRelease?: string }) => {
          controls.push(`${command.kind}:${command.operationId ?? ''}:${command.targetRelease ?? ''}`);
          return command.kind === 'prepare-maintenance'
            ? { kind: 'ready', lease: { operationId: 'operation-new' } }
            : { kind: 'ok' };
        } };
      },
      stopLaunchAgent: async () => { controls.push('launch-agent:stop'); },
      waitForStopped: async () => { controls.push('health:stopped'); },
    });

    expect(result).toEqual({ operationId: 'operation-new' });
    expect(controls).toEqual([
      'instance:restored-instance',
      'prepare-maintenance:operation-new:0.2.0+new',
      'shutdown::',
      'launch-agent:stop',
      'health:stopped',
    ]);
  });

  it('does not signal a candidate that has already exited by signal', async () => {
    let killed = false;
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: 'SIGTERM',
      kill: () => { killed = true; return true; },
    });
    await stopCandidate(child as never);
    expect(killed).toBe(false);
  });

  it('registers the exit listener before signalling the candidate', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill(this: EventEmitter) { this.emit('exit', null, 'SIGTERM'); return true; },
    });
    await expect(stopCandidate(child as never)).resolves.toBeUndefined();
  });

  it('creates and tightens the private log directory before LaunchAgent use', async () => {
    const root = await temporaryRoot();
    const logs = join(root, 'Library', 'Logs', 'Catbots');
    await mkdir(logs, { recursive: true, mode: 0o777 });
    await chmod(logs, 0o777);

    await ensurePrivateDirectory(logs, process.getuid!());

    expect((await stat(logs)).mode & 0o777).toBe(0o700);
  });

  it('removes a fresh command wrapper when the install rolls back', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'source');
    const command = join(root, 'bin', 'catbots');
    await writeFile(source, 'new-wrapper');
    const wrapper = new CommandWrapperTransaction();

    await wrapper.install({ operationId: 'operation-1', source, command });
    await wrapper.rollback({ operationId: 'operation-1', command });

    await expect(readFile(command, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores old command wrapper bytes and mode on update rollback', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'source');
    const command = join(root, 'bin', 'catbots');
    await mkdir(join(root, 'bin'));
    await writeFile(source, 'new-wrapper');
    await writeFile(command, 'old-wrapper', { mode: 0o711 });
    const wrapper = new CommandWrapperTransaction();

    await wrapper.install({ operationId: 'operation-1', source, command });
    await wrapper.rollback({ operationId: 'operation-1', command });

    expect(await readFile(command, 'utf8')).toBe('old-wrapper');
    expect((await lstat(command)).mode & 0o777).toBe(0o711);
  });

  it('removes the wrapper backup only on commit', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'source');
    const command = join(root, 'bin', 'catbots');
    await mkdir(join(root, 'bin'));
    await writeFile(source, 'new-wrapper');
    await writeFile(command, 'old-wrapper');
    const wrapper = new CommandWrapperTransaction();

    await wrapper.install({ operationId: 'operation-1', source, command });
    await wrapper.commit({ operationId: 'operation-1', command });

    expect(await readFile(command, 'utf8')).toBe('new-wrapper');
    await expect(readFile(`${command}.rollback-operation-1`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

const releaseIdentity = {
  product: 'catbots' as const,
  bundleId: 'com.catbots.desktop' as const,
  releaseId: '0.1.0+old', version: '0.1.0', commit: 'old123', architecture: 'arm64' as const,
  protocolVersion: 1, dataSchemaVersion: 1, resumePolicy: 'manual-only' as const,
};
