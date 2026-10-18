import {
  executeInstallTransaction,
  type InstallTransactionInput,
  type InstallerTransactionDependencies,
  type InstallTransactionResult,
} from './install-transaction';
import { recoverInterruptedInstall, type InstallerRecoveryResult } from './recovery';
import type { InstallerCommand } from '../application/process-intent';
import type { UninstallOutcome } from './uninstall';
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
  recover?: (dependencies: InstallerTransactionDependencies) => Promise<InstallerRecoveryResult>;
  transact?: (
    input: InstallTransactionInput,
    dependencies: InstallerTransactionDependencies,
  ) => Promise<InstallTransactionResult>;
  uninstall?: (purgeData: boolean) => Promise<UninstallOutcome>;
}>;

const requestSchema = z.strictObject({
  operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/),
  desiredReleaseId: z.string().min(1).max(160),
  previousInstallation: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('absent') }),
    z.strictObject({
      kind: z.literal('installed'),
      releaseId: z.string().min(1).max(160),
      desiredService: z.enum(['running', 'stopped']),
    }),
  ]),
  desiredService: z.enum(['running', 'stopped']),
  preserveData: z.boolean(),
  requiredSnapshotBytes: z.number().int().nonnegative(),
  paths: z.strictObject({
    home: z.string().startsWith('/'),
    application: z.string().startsWith('/'),
    command: z.string().startsWith('/'),
    launchAgent: z.string().startsWith('/'),
    installerState: z.string().startsWith('/'),
    productData: z.string().startsWith('/'),
  }),
});

export function createInstaller(dependencies: InstallerDependencies): CatbotsInstaller {
  const recover = dependencies.recover ?? recoverInterruptedInstall;
  const transact = dependencies.transact ?? executeInstallTransaction;
  return Object.freeze({
    reconcile: async (requestFile) => {
      await recover(dependencies.transactionDependencies);
      const parsed = requestSchema.safeParse(await dependencies.requests.read(requestFile));
      if (!parsed.success) throw new Error('INSTALL_REQUEST_INVALID');
      const request: InstallTransactionInput = parsed.data;
      return transact(request, dependencies.transactionDependencies);
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
    return createInstallerCommandRunner({ loadDependencies: platform.loadDependencies })(command);
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
