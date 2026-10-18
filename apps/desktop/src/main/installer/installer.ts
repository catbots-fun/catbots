import {
  executeInstallTransaction,
  type InstallTransactionInput,
  type InstallerTransactionDependencies,
  type InstallTransactionResult,
} from './install-transaction';
import { recoverInterruptedInstall, type InstallerRecoveryResult } from './recovery';
import type { InstallerCommand } from '../application/process-intent';
import type { UninstallOutcome } from './uninstall';
import type { CanonicalServiceObservation } from './install-transaction';
import type { ServiceIdentity } from '../web/service-identity';
import { z } from 'zod';

export type CatbotsInstaller = Readonly<{
  reconcile(requestFile: string): Promise<InstallTransactionResult>;
  uninstall(purgeData: boolean): Promise<UninstallOutcome>;
}>;

export type InstallerDependencies = Readonly<{
  requests: {
    read(requestFile: string): Promise<unknown>;
  };
  transactionDependencies: InstallerTransactionDependencies;
  verifyRequest?(request: BootstrapInstallRequest): Promise<void>;
  deriveInput(request: BootstrapInstallRequest): Promise<InstallTransactionInput>;
  canonicalHealth?: () => Promise<CanonicalServiceObservation>;
  recover?: (dependencies: InstallerTransactionDependencies) => Promise<InstallerRecoveryResult>;
  transact?: (
    input: InstallTransactionInput,
    dependencies: InstallerTransactionDependencies,
  ) => Promise<InstallTransactionResult>;
  uninstall?: (purgeData: boolean) => Promise<UninstallOutcome>;
}>;

const requestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  manifestPath: z.string().startsWith('/'),
  signaturePath: z.string().startsWith('/'),
  archivePath: z.string().startsWith('/'),
  effectiveArtifactUrl: z.string().url().startsWith('https://'),
});
export type BootstrapInstallRequest = z.infer<typeof requestSchema>;

export function createInstaller(dependencies: InstallerDependencies): CatbotsInstaller {
  const recover = dependencies.recover ?? recoverInterruptedInstall;
  const transact = dependencies.transact ?? executeInstallTransaction;
  return Object.freeze({
    reconcile: async (requestFile) => {
      const parsed = requestSchema.safeParse(await dependencies.requests.read(requestFile));
      if (!parsed.success) throw new Error('INSTALL_REQUEST_INVALID');
      await dependencies.verifyRequest?.(parsed.data);
      await recover(dependencies.transactionDependencies);
      const input = await dependencies.deriveInput(parsed.data);
      return transact(input, dependencies.transactionDependencies);
    },
    uninstall: async (purgeData) => {
      if (dependencies.uninstall === undefined) throw new Error('UNINSTALL_PLATFORM_UNAVAILABLE');
      return dependencies.uninstall(purgeData);
    },
  });
}

export function createInstallerCommandRunner(dependencies: Readonly<{
  loadDependencies(): Promise<InstallerDependencies>;
}>): (command: InstallerCommand) => Promise<number> {
  return async (command) => {
    const loaded = await dependencies.loadDependencies();
    return runInstallerCommand(command, () => createInstaller(loaded));
  };
}

export function createProductionInstallerCommandRunner(
  platform?: Readonly<{
    loadDependencies?(): Promise<InstallerDependencies>;
    uninstall?(purgeData: boolean): Promise<UninstallOutcome>;
    reportUninstall?(outcome: UninstallOutcome): void;
    reportInstall?(outcome: InstallTransactionResult & Readonly<{ health: CanonicalServiceObservation }>): void;
  }>,
): (command: InstallerCommand) => Promise<number> {
  return async (command) => {
    if (command.kind === 'uninstall') {
      if (platform?.uninstall === undefined) throw new Error('UNINSTALL_PLATFORM_UNAVAILABLE');
      const outcome = await platform.uninstall(command.purgeData);
      platform.reportUninstall?.(outcome);
      return outcome.kind === 'blocked' ? 2 : 0;
    }
    if (platform?.loadDependencies === undefined) throw new Error('INSTALLER_PLATFORM_UNAVAILABLE');
    const dependencies = await platform.loadDependencies();
    const outcome = await createInstaller(dependencies).reconcile(command.requestFile);
    if (dependencies.canonicalHealth === undefined) throw new Error('INSTALLER_HEALTH_PLATFORM_UNAVAILABLE');
    const health = await dependencies.canonicalHealth();
    if ('state' in health) {
      if (Object.keys(health).sort().join(',') !== 'bundleId,product,state'
        || health.product !== 'catbots' || health.bundleId !== 'com.catbots.desktop' || health.state !== 'stopped') {
        throw new Error('CANONICAL_STOPPED_STATE_MISMATCH');
      }
    } else if (health.readiness !== 'ready' || health.releaseId !== outcome.releaseId) {
      throw new Error('CANONICAL_HEALTH_IDENTITY_MISMATCH');
    }
    platform.reportInstall?.({ ...outcome, health });
    return 0;
  };
}

export function formatUninstallOutcome(outcome: UninstallOutcome, origin: string): string {
  if (outcome.kind === 'blocked') {
    return `${[
      'Catbots could not uninstall safely.',
      ...outcome.blockers.map((blocker) => `- ${blocker.kind}: ${origin}${blocker.route}`),
      'Resolve every blocker and run catbots uninstall again.',
    ].join('\n')}\n`;
  }
  return outcome.kind === 'purged'
    ? 'Catbots and its application data were removed.\n'
    : 'Catbots was removed. Application data was preserved.\n';
}

export async function runInstallerCommand(
  command: InstallerCommand,
  factory: () => CatbotsInstaller,
): Promise<number> {
  const installer = factory();
  if (command.kind === 'reconcile') await installer.reconcile(command.requestFile);
  else await installer.uninstall(command.purgeData);
  return 0;
}
