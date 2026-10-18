import type { ApplicationOwner } from './application-owner';
import type { ControlCommand, InstallerCommand, ProcessIntent } from './process-intent';

export type BootstrapPlatform = {
  requestSingleInstanceLock(): boolean;
  createApplicationOwner(): Promise<ApplicationOwner>;
  openUi(): Promise<number>;
  runControl(command: ControlCommand): Promise<number>;
  runInstaller(command: InstallerCommand): Promise<number>;
};

export async function bootstrapCatbots(
  intent: ProcessIntent,
  platform: BootstrapPlatform,
): Promise<number> {
  if (intent.kind === 'open-ui') return platform.openUi();
  if (intent.kind === 'control') return platform.runControl(intent.command);
  if (intent.kind === 'installer') return platform.runInstaller(intent.command);
  if (!platform.requestSingleInstanceLock()) return 0;
  await platform.createApplicationOwner();
  return 0;
}
