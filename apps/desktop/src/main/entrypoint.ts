import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app, shell } from 'electron';
import { runRuntimeEntrypoint } from './application/runtime-entrypoint';
import type { CliCommand, ControlCommand } from './application/process-intent';
import { createControlClient } from './control/socket-client';
import {
  formatCliOutcome,
  runCliCommand,
  type CliOutcome,
} from './service/cli-command';
import { createCliRuntimeDependencies } from './service/cli-runtime';
import { DesiredStateStore } from './service/desired-state';
import { createHealthClient } from './service/health-client';
import { LaunchAgentController, loadLaunchAgentTemplate } from './service/launch-agent';
import { createServiceReleaseIdentity } from './service/runtime-identity';
import { currentDataSchemaVersion } from './storage/migrations';

const origin = 'http://127.0.0.1:5180';
let ownerStarted = false;

void runRuntimeEntrypoint({
  argv: process.argv,
  packaged: app.isPackaged,
  requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
  startOwner: async () => {
    ownerStarted = true;
    process.env.CATBOTS_INSTANCE_LOCK_ACQUIRED = '1';
    process.env.CATBOTS_WEB = '1';
    const nativeE2E = process.env.NODE_ENV === 'test'
      && process.env.CATBOTS_E2E_NATIVE === '1'
      && process.env.CATBOTS_E2E_DATA_DIR !== undefined;
    process.env.CATBOTS_WEB_ONLY = nativeE2E ? '0' : '1';
    await import('./main');
    return { close: async () => undefined };
  },
  openUi: async () => {
    if (!app.isPackaged) {
      ownerStarted = true;
      await import('./main');
      return 0;
    }
    return executeCli('open');
  },
  runCli: executeCli,
  runControl: executeControl,
  runInstaller: async () => {
    throw new Error('INSTALLER_NOT_AVAILABLE');
  },
}).then((exitCode) => {
  if (ownerStarted) return;
  process.exitCode = exitCode;
  app.quit();
}).catch(() => {
  process.stderr.write('Catbots could not complete the requested command.\n');
  process.exitCode = 1;
  app.quit();
});

async function executeCli(command: CliCommand): Promise<number> {
  const dependencies = await createInstalledCliDependencies();
  const outcome = await runCliCommand(command, dependencies);
  process.stdout.write(`${formatCliOutcome(outcome)}\n`);
  return outcome.kind === 'blocked' ? 2 : 0;
}

async function executeControl(command: ControlCommand): Promise<number> {
  const dependencies = await createInstalledCliDependencies();
  await dependencies.control.execute(command);
  return 0;
}

async function createInstalledCliDependencies() {
  await app.whenReady();
  const home = app.getPath('home');
  const dataDirectory = app.getPath('userData');
  const logDirectory = join(home, 'Library', 'Logs', 'Catbots');
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const health = createHealthClient({ origin });
  const expectedRelease = createServiceReleaseIdentity({
    version: app.getVersion(),
    commit: process.env.CATBOTS_RELEASE_COMMIT ?? 'development',
    architecture: process.arch,
    dataSchemaVersion: currentDataSchemaVersion,
  });
  const template = await loadLaunchAgentTemplate(join(
    process.resourcesPath,
    'fun.catbots.web.plist.template',
  ));
  return createCliRuntimeDependencies({
    desiredState: new DesiredStateStore(join(dataDirectory, 'service-state.json')),
    launchAgent: new LaunchAgentController({
      uid: process.getuid?.() ?? (() => { throw new Error('USER_ID_UNAVAILABLE'); })(),
      executablePath: process.execPath,
      plistPath: join(home, 'Library', 'LaunchAgents', 'fun.catbots.web.plist'),
      stdoutPath: join(logDirectory, 'service.log'),
      stderrPath: join(logDirectory, 'service.error.log'),
      template,
    }),
    health,
    expectedRelease,
    socketPath: join(dataDirectory, 'control', 'catbots.sock'),
    createControl: createControlClient,
    openExternal: (url) => shell.openExternal(url),
    operationId: randomUUID,
    origin,
  });
}

export type { CliOutcome };
