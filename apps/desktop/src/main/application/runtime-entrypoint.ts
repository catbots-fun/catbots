import { bootstrapCatbots, type BootstrapPlatform } from './bootstrap';
import { parseProcessIntent } from './process-intent';

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
