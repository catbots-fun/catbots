import { bootstrapCatbots, type BootstrapPlatform } from './bootstrap';
import { parseProcessIntent, type CliCommand, type ServiceCliCommand } from './process-intent';

export async function dispatchPublicCliCommand(
  command: CliCommand,
  dependencies: Readonly<{
    runService(command: ServiceCliCommand): Promise<number>;
    runUninstall(purgeData: boolean): Promise<number>;
  }>,
): Promise<number> {
  if (typeof command === 'object') return dependencies.runUninstall(command.purgeData);
  return dependencies.runService(command);
}

export type RuntimeEntrypointDependencies = Readonly<{
  argv: readonly string[];
  packaged: boolean;
  requestSingleInstanceLock: BootstrapPlatform['requestSingleInstanceLock'];
  startOwner: BootstrapPlatform['createApplicationOwner'];
  openUi: BootstrapPlatform['openUi'];
  runControl: BootstrapPlatform['runControl'];
  runCli: BootstrapPlatform['runCli'];
  runInstaller: BootstrapPlatform['runInstaller'];
}>;

export async function runRuntimeEntrypoint(
  dependencies: RuntimeEntrypointDependencies,
): Promise<number> {
  const argv = !dependencies.packaged
    && dependencies.argv.length === 2
    && dependencies.argv[1] === '.'
    ? dependencies.argv.slice(0, 1)
    : dependencies.argv;
  const intent = parseProcessIntent(argv, { packaged: dependencies.packaged });
  return bootstrapCatbots(intent, {
    requestSingleInstanceLock: dependencies.requestSingleInstanceLock,
    createApplicationOwner: dependencies.startOwner,
    openUi: dependencies.openUi,
    runControl: dependencies.runControl,
    runCli: dependencies.runCli,
    runInstaller: dependencies.runInstaller,
  });
}
