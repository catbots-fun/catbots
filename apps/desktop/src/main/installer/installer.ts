import {
  executeInstallTransaction,
  type InstallTransactionInput,
  type InstallerTransactionDependencies,
  type InstallTransactionResult,
} from './install-transaction';
import { recoverInterruptedInstall, type InstallerRecoveryResult } from './recovery';
import type { InstallerCommand } from '../application/process-intent';
import { z } from 'zod';

export type CatbotsInstaller = Readonly<{
  reconcile(requestFile: string): Promise<InstallTransactionResult>;
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
  platform?: Readonly<{ loadDependencies(): Promise<InstallerDependencies> }>,
): (command: InstallerCommand) => Promise<number> {
  if (platform === undefined) {
    return async () => { throw new Error('INSTALLER_PLATFORM_UNAVAILABLE'); };
  }
  return createInstallerCommandRunner(platform);
}

export async function runInstallerCommand(
  command: InstallerCommand,
  factory: () => CatbotsInstaller,
): Promise<number> {
  if (command.kind !== 'reconcile') throw new Error('INSTALLER_COMMAND_NOT_IMPLEMENTED');
  await factory().reconcile(command.requestFile);
  return 0;
}
