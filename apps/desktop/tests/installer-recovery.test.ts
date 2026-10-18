import { describe, expect, it } from 'vitest';

import { recoverInterruptedInstall } from '../src/main/installer/recovery';
import type { InstallJournal, ManagedPaths, PreviousInstallationState } from '../src/main/installer/types';

const paths: ManagedPaths = {
  home: '/Users/tester',
  application: '/Users/tester/Applications/Catbots.app',
  command: '/Users/tester/.local/bin/catbots',
  launchAgent: '/Users/tester/Library/LaunchAgents/fun.catbots.web.plist',
  installerState: '/Users/tester/Library/Application Support/Catbots Installer',
  productData: '/Users/tester/Library/Application Support/Catbots',
};
const releaseIdentity = {
  product: 'catbots' as const,
  bundleId: 'com.catbots.desktop' as const,
  releaseId: '0.2.0+abc123',
  version: '0.2.0',
  commit: 'abc123',
  architecture: 'arm64' as const,
  protocolVersion: 1,
  dataSchemaVersion: 1,
  resumePolicy: 'manual-only' as const,
};

function interrupted(
  phase: InstallJournal['phase'],
  previousInstallation: PreviousInstallationState = {
    kind: 'installed',
    releaseId: '0.1.0+def456',
    desiredService: 'stopped',
  },
): InstallJournal {
  return {
    schemaVersion: 1,
    operationId: 'operation-1',
    phase,
    desiredReleaseId: '0.2.0+abc123',
    previousInstallation,
    desiredService: 'running',
    preserveData: true,
    paths,
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:01:00.000Z',
  };
}

function fixture(phase: InstallJournal['phase'], previousInstallation?: PreviousInstallationState) {
  let journal: InstallJournal | undefined = interrupted(phase, previousInstallation);
  const events: string[] = [];
  const serviceRestores: unknown[] = [];
  return {
    events,
    serviceRestores,
    journal: () => journal,
    dependencies: {
      store: {
        lock: async () => ({ release: async () => { events.push('lock:release'); } }),
        lockForRecovery: async () => ({ release: async () => { events.push('lock:release'); } }),
        readJournal: async () => journal,
        writeJournal: async (next: InstallJournal) => { journal = next; events.push(`journal:${next.phase}`); },
        clearJournal: async () => { journal = undefined; events.push('journal:clear'); },
      },
      release: {
        stage: async () => '',
        verify: async () => releaseIdentity,
        discard: async () => { events.push('release:discard'); },
      },
      maintenance: {
        acquire: async () => { events.push('maintenance:acquire'); return { operationId: 'operation-1' }; },
        commit: async () => { events.push('maintenance:commit'); },
        rollback: async () => { events.push('maintenance:rollback'); },
      },
      snapshots: {
        create: async () => undefined,
        restore: async () => { events.push('snapshot:restore'); },
        exists: async () => true,
      },
      application: {
        stageCurrent: async () => undefined,
        activate: async () => undefined,
        rollback: async () => { events.push('application:rollback'); },
        commit: async () => { events.push('application:commit'); },
      },
      launchAgent: {
        install: async () => undefined,
        rollback: async () => { events.push('launch-agent:rollback'); },
      },
      candidate: {
        start: async () => { events.push('candidate:start'); },
        verify: async () => ({
          ...releaseIdentity,
          instanceId: 'candidate-instance',
          readiness: 'maintenance' as const,
          maintenanceOperationId: 'operation-1',
        }),
      },
      service: {
        restore: async (input: unknown) => { serviceRestores.push(input); events.push('service:restore'); },
        observe: async () => ({
          ...releaseIdentity,
          instanceId: 'canonical-instance',
          readiness: 'ready' as const,
        }),
      },
      now: () => new Date('2026-10-18T00:02:00.000Z'),
    },
  };
}

describe('installer recovery', () => {
  it('discards an interrupted staged release without stopping the live runtime', async () => {
    const f = fixture('prepared');

    await expect(recoverInterruptedInstall(f.dependencies)).resolves.toEqual({
      kind: 'rolled-back',
      operationId: 'operation-1',
      evidence: { action: 'rollback', fromPhase: 'prepared', resultPhase: 'rolled-back' },
    });

    expect(f.events).toEqual([
      'journal:rolling-back',
      'release:discard',
      'journal:rolled-back',
      'lock:release',
    ]);
  });

  it('reacquires maintenance and idempotently rolls back an interrupted activation', async () => {
    const f = fixture('new-app-installed');

    await expect(recoverInterruptedInstall(f.dependencies)).resolves.toEqual({
      kind: 'rolled-back',
      operationId: 'operation-1',
      evidence: { action: 'rollback', fromPhase: 'new-app-installed', resultPhase: 'rolled-back' },
    });

    expect(f.events).toEqual([
      'journal:rolling-back',
      'maintenance:acquire',
      'launch-agent:rollback',
      'application:rollback',
      'snapshot:restore',
      'release:discard',
      'service:restore',
      'maintenance:rollback',
      'journal:rolled-back',
      'lock:release',
    ]);
    expect(f.journal()?.phase).toBe('rolled-back');
    expect(f.serviceRestores).toEqual([{
      operationId: 'operation-1',
      desiredService: 'stopped',
      releaseId: '0.1.0+def456',
    }]);
  });

  it('continues restoring app and data when one rollback adapter fails', async () => {
    const f = fixture('candidate-verifying');
    let fail = true;
    f.dependencies.launchAgent.rollback = async () => {
      f.events.push('launch-agent:rollback');
      if (fail) {
        fail = false;
        throw new Error('LAUNCH_AGENT_ROLLBACK_FAILED');
      }
    };

    await expect(recoverInterruptedInstall(f.dependencies)).rejects.toThrow('INSTALL_ROLLBACK_FAILED');

    expect(f.events).toContain('application:rollback');
    expect(f.events).toContain('snapshot:restore');
    expect(f.events).toContain('maintenance:rollback');
    expect(f.journal()?.phase).toBe('rolling-back');

    await expect(recoverInterruptedInstall(f.dependencies)).resolves.toMatchObject({
      kind: 'rolled-back',
      evidence: { fromPhase: 'candidate-verifying', resultPhase: 'rolled-back' },
    });
    expect(f.journal()?.phase).toBe('rolled-back');
  });

  it('restores an absent previous installation to an exact stopped service state', async () => {
    const f = fixture('new-app-installed', { kind: 'absent' });

    await expect(recoverInterruptedInstall(f.dependencies)).resolves.toMatchObject({ kind: 'rolled-back' });

    expect(f.serviceRestores).toEqual([{
      operationId: 'operation-1',
      desiredService: 'stopped',
    }]);
  });

  it('preserves the prior phase when writing the rollback intent fails, then retries', async () => {
    const f = fixture('old-app-staged');
    const write = f.dependencies.store.writeJournal;
    let fail = true;
    f.dependencies.store.writeJournal = async (journal) => {
      if (journal.phase === 'rolling-back' && fail) {
        fail = false;
        throw new Error('JOURNAL_FSYNC_FAILED');
      }
      await write(journal);
    };

    await expect(recoverInterruptedInstall(f.dependencies)).rejects.toThrow('JOURNAL_FSYNC_FAILED');
    expect(f.journal()?.phase).toBe('old-app-staged');
    await expect(recoverInterruptedInstall(f.dependencies)).resolves.toMatchObject({
      kind: 'rolled-back',
      evidence: { fromPhase: 'old-app-staged' },
    });
  });

  it.each([
    ['prepared', 'rolled-back', 'rollback'],
    ['release-verified', 'rolled-back', 'rollback'],
    ['maintenance-prepared', 'rolled-back', 'rollback'],
    ['data-snapshotted', 'rolled-back', 'rollback'],
    ['old-app-staged', 'rolled-back', 'rollback'],
    ['new-app-installed', 'rolled-back', 'rollback'],
    ['launch-agent-written', 'rolled-back', 'rollback'],
    ['candidate-verifying', 'rolled-back', 'rollback'],
    ['rolling-back', 'rolled-back', 'rollback'],
    ['committed', 'completed', 'complete'],
    ['rolled-back', 'rolled-back', 'acknowledge'],
    ['complete', 'completed', 'acknowledge'],
  ] as const)('recovers phase %s idempotently to %s', async (phase, kind, action) => {
    const f = fixture(phase);

    await expect(recoverInterruptedInstall(f.dependencies)).resolves.toMatchObject({
      kind,
      evidence: { action },
    });
    await expect(recoverInterruptedInstall(f.dependencies)).resolves.toMatchObject(
      phase === 'rolled-back' || phase === 'complete'
        ? { kind: 'none' }
        : { evidence: { action: 'acknowledge' } },
    );
    await expect(recoverInterruptedInstall(f.dependencies)).resolves.toEqual({ kind: 'none' });
  });

  it('finishes an interrupted commit instead of undoing a verified candidate', async () => {
    const f = fixture('committed');

    await expect(recoverInterruptedInstall(f.dependencies)).resolves.toEqual({
      kind: 'completed',
      operationId: 'operation-1',
      evidence: { action: 'complete', fromPhase: 'committed', resultPhase: 'complete' },
    });

    expect(f.events).toEqual([
      'maintenance:acquire',
      'maintenance:commit',
      'application:commit',
      'journal:complete',
      'lock:release',
    ]);
  });
});
