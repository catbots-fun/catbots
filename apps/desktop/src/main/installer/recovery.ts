import type { InstallerTransactionDependencies } from './install-transaction';
import type { InstallJournal } from './types';

export type InstallerRecoveryResult =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'rolled-back';
      operationId: string;
      evidence: RecoveryEvidence;
    }>
  | Readonly<{
      kind: 'completed';
      operationId: string;
      evidence: RecoveryEvidence;
    }>;

export type RecoveryEvidence = Readonly<{
  action: 'rollback' | 'complete' | 'acknowledge';
  fromPhase: InstallJournal['phase'];
  resultPhase: 'rolled-back' | 'complete';
}>;

export async function recoverInterruptedInstall(
  dependencies: InstallerTransactionDependencies,
): Promise<InstallerRecoveryResult> {
  const observed = await dependencies.store.readJournal();
  if (observed === undefined) return { kind: 'none' };
  const lock = await dependencies.store.lockForRecovery(observed.operationId);
  try {
    const journal = await dependencies.store.readJournal();
    if (journal === undefined) return { kind: 'none' };
    if (journal.operationId !== observed.operationId) throw new Error('INSTALL_OPERATION_CONFLICT');
    if (journal.phase === 'complete') {
      await dependencies.store.clearJournal(journal.operationId);
      return {
        kind: 'completed',
        operationId: journal.operationId,
        evidence: { action: 'acknowledge', fromPhase: 'complete', resultPhase: 'complete' },
      };
    }
    if (journal.phase === 'rolled-back') {
      await dependencies.store.clearJournal(journal.operationId);
      return {
        kind: 'rolled-back',
        operationId: journal.operationId,
        evidence: { action: 'acknowledge', fromPhase: 'rolled-back', resultPhase: 'rolled-back' },
      };
    }
    if (journal.phase === 'committed') return await finishInterruptedCommit(journal, dependencies);
    if (isStagingOnly(journal)) return await discardInterruptedStage(journal, dependencies);
    return await rollbackInterruptedInstall(journal, dependencies);
  } finally {
    await lock.release();
  }
}

function isStagingOnly(journal: InstallJournal): boolean {
  const phase = journal.phase === 'rolling-back' ? journal.rollbackFromPhase : journal.phase;
  return phase === 'prepared' || phase === 'release-verified';
}

async function discardInterruptedStage(
  journal: InstallJournal,
  dependencies: InstallerTransactionDependencies,
): Promise<InstallerRecoveryResult> {
  const rollingBack: InstallJournal = journal.phase === 'rolling-back'
    ? journal
    : {
        ...journal,
        phase: 'rolling-back',
        rollbackFromPhase: journal.phase,
        updatedAt: dependencies.now().toISOString(),
      };
  if (journal.phase !== 'rolling-back') await dependencies.store.writeJournal(rollingBack);
  await dependencies.release.discard({ operationId: journal.operationId });
  await dependencies.store.writeJournal({
    ...rollingBack,
    phase: 'rolled-back',
    updatedAt: dependencies.now().toISOString(),
  });
  return {
    kind: 'rolled-back',
    operationId: journal.operationId,
    evidence: { action: 'rollback', fromPhase: recoveryOrigin(journal), resultPhase: 'rolled-back' },
  };
}

async function rollbackInterruptedInstall(
  journal: InstallJournal,
  dependencies: InstallerTransactionDependencies,
): Promise<InstallerRecoveryResult> {
  const rollingBack: InstallJournal = {
    ...journal,
    phase: 'rolling-back',
    rollbackFromPhase: journal.phase === 'rolling-back' ? journal.rollbackFromPhase : journal.phase,
    updatedAt: dependencies.now().toISOString(),
  };
  if (journal.phase !== 'rolling-back') await dependencies.store.writeJournal(rollingBack);

  const lease = await dependencies.maintenance.acquire({ operationId: journal.operationId, reason: 'upgrade' });
  if (lease.operationId !== journal.operationId) throw new Error('MAINTENANCE_LEASE_MISMATCH');

  const failures: unknown[] = [];
  const attempt = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  };
  await attempt(() => dependencies.launchAgent.rollback({ operationId: journal.operationId, paths: journal.paths }));
  await attempt(() => dependencies.application.rollback({
    operationId: journal.operationId,
    applicationPath: journal.paths.application,
    installerStatePath: journal.paths.installerState,
  }));
  let snapshotExists = false;
  await attempt(async () => { snapshotExists = await dependencies.snapshots.exists(journal.operationId); });
  if (snapshotExists) await attempt(() => dependencies.snapshots.restore(journal.operationId));
  await attempt(() => dependencies.release.discard({ operationId: journal.operationId }));
  await attempt(() => dependencies.service.restore(
    journal.previousInstallation.kind === 'absent'
      ? { operationId: journal.operationId, desiredService: 'stopped' }
      : {
          operationId: journal.operationId,
          desiredService: journal.previousInstallation.desiredService,
          releaseId: journal.previousInstallation.releaseId,
        },
  ));
  await attempt(() => dependencies.maintenance.rollback(journal.operationId));
  if (failures.length > 0) throw new AggregateError(failures, 'INSTALL_ROLLBACK_FAILED');
  await dependencies.store.writeJournal({
    ...rollingBack,
    phase: 'rolled-back',
    updatedAt: dependencies.now().toISOString(),
  });
  return {
    kind: 'rolled-back',
    operationId: journal.operationId,
    evidence: { action: 'rollback', fromPhase: recoveryOrigin(journal), resultPhase: 'rolled-back' },
  };
}

async function finishInterruptedCommit(
  journal: InstallJournal,
  dependencies: InstallerTransactionDependencies,
): Promise<InstallerRecoveryResult> {
  const lease = await dependencies.maintenance.acquire({ operationId: journal.operationId, reason: 'upgrade' });
  if (lease.operationId !== journal.operationId) throw new Error('MAINTENANCE_LEASE_MISMATCH');
  await dependencies.maintenance.commit(journal.operationId);
  await dependencies.application.commit({
    operationId: journal.operationId,
    applicationPath: journal.paths.application,
    installerStatePath: journal.paths.installerState,
  });
  await dependencies.store.writeJournal({
    ...journal,
    phase: 'complete',
    updatedAt: dependencies.now().toISOString(),
  });
  return {
    kind: 'completed',
    operationId: journal.operationId,
    evidence: { action: 'complete', fromPhase: 'committed', resultPhase: 'complete' },
  };
}

function recoveryOrigin(journal: InstallJournal): InstallJournal['phase'] {
  return journal.phase === 'rolling-back' ? journal.rollbackFromPhase ?? journal.phase : journal.phase;
}
