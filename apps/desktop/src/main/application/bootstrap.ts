import type { ApplicationOwner } from './application-owner';
import type { CliCommand, ControlCommand, InstallerCommand, ProcessIntent } from './process-intent';

export type BootstrapPlatform = {
  requestSingleInstanceLock(): boolean;
  createApplicationOwner(maintenanceOperationId?: string): Promise<ApplicationOwner>;
  openUi(): Promise<number>;
  runControl(command: ControlCommand): Promise<number>;
  runCli(command: CliCommand): Promise<number>;
  runInstaller(command: InstallerCommand): Promise<number>;
};

export async function bootstrapCatbots(
  intent: ProcessIntent,
  platform: BootstrapPlatform,
): Promise<number> {
  if (intent.kind === 'open-ui') return platform.openUi();
  if (intent.kind === 'control') return platform.runControl(intent.command);
  if (intent.kind === 'cli') return platform.runCli(intent.command);
  if (intent.kind === 'installer') return platform.runInstaller(intent.command);
  if (!platform.requestSingleInstanceLock()) return 0;
  await platform.createApplicationOwner(intent.maintenanceOperationId);
  return 0;
}
