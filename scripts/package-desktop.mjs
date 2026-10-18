import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertReleaseEnvironment } from './check-release-node.mjs';
import { assertReleaseTrustFile } from './check-release-trust.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(root, 'apps/desktop');
assertReleaseEnvironment(process.versions.node, process.platform);

export function createRunner(spawnCommand = spawn) {
  return function run(command, args, cwd = desktop, onSpawn, processOptions = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawnCommand(command, args, { cwd, env: process.env, stdio: 'inherit', ...processOptions });
    onSpawn?.(child);
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
  };
}

export function waitForChildExit(child) {
  if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve();
  if (child.signalCode !== null && child.signalCode !== undefined) return Promise.resolve();
  return new Promise((resolveExit) => child.once('exit', resolveExit));
}

export async function runPackaging({ rebuildElectron, forge, restoreHost, signalOptions }) {
  let activeChild;
  let restorationChild;
  let restorePromise;
  const restoreOnce = () => restorePromise ??= restoreHost((child) => { restorationChild = child; });
  const controller = signalOptions === undefined ? undefined : createSignalController({
    ...signalOptions,
    terminate: (signal) => activeChild?.kill(signal),
    waitForExit: () => activeChild !== undefined
      ? waitForChildExit(activeChild)
      : restorationChild === undefined ? Promise.resolve() : waitForChildExit(restorationChild),
    restoreHost: restoreOnce,
  });
  const runStage = async (stage) => {
    try {
      await stage((child) => { activeChild = child; });
    } finally {
      activeChild = undefined;
    }
  };
  let primary;
  try {
    await runStage(rebuildElectron);
    await runStage(forge);
  } catch (error) {
    primary = error;
  }
  try {
    await restoreOnce();
  } catch (restoreError) {
    if (primary !== undefined) {
      controller?.remove();
      throw new Error('Catbots packaging and host ABI restoration failed');
    }
    controller?.remove();
    throw restoreError;
  }
  controller?.remove();
  if (primary !== undefined) throw primary;
}

export function createSignalController({ on, off, exit, terminate, waitForExit, restoreHost, report = () => undefined }) {
  let restored = false;
  let handling = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    await restoreHost();
  };
  const handle = (signal) => async () => {
    if (handling) return;
    handling = true;
    const childExit = waitForExit();
    terminate(signal);
    try {
      await childExit;
      await restore();
      exit(signal === 'SIGINT' ? 130 : 143);
    } catch {
      report('Catbots host ABI restoration failed after interruption.');
      exit(1);
    } finally {
      off('SIGINT', handlers.SIGINT);
      off('SIGTERM', handlers.SIGTERM);
    }
  };
  const handlers = { SIGINT: handle('SIGINT'), SIGTERM: handle('SIGTERM') };
  on('SIGINT', handlers.SIGINT);
  on('SIGTERM', handlers.SIGTERM);
  return { remove: () => { off('SIGINT', handlers.SIGINT); off('SIGTERM', handlers.SIGTERM); } };
}

export async function runForgeWithSignalHandling({ runCommand, command, args, on, off, exit, restoreHost, report }) {
  let controller;
  try {
    await runCommand(command, args, desktop, (child) => {
      controller = createSignalController({
        on,
        off,
        exit,
        terminate: (signal) => child.kill(signal),
        waitForExit: () => waitForChildExit(child),
        restoreHost,
        report,
      });
    });
  } finally {
    controller?.remove();
  }
}

const run = createRunner();

export function restoreProcessOptions(platform = process.platform) {
  return platform === 'win32'
    ? { detached: true, stdio: 'ignore', windowsHide: true }
    : { detached: true, stdio: 'ignore' };
}

const nativePath = resolve(root, 'node_modules/better-sqlite3');
export async function runDesktopCommand(command, options = {}) {
  const runCommand = options.run ?? run;
  if (command !== 'start' && command !== 'package' && command !== 'make') {
    throw new Error(`Unsupported Forge lifecycle: ${command}`);
  }
  if (command === 'package' || command === 'make') {
    await (options.assertTrust ?? assertReleaseTrustFile)(
      process.env.CATBOTS_RELEASE_TRUST_FILE,
      process.env.CATBOTS_RELEASE_TRUST_FINGERPRINT,
    );
  }
  await runPackaging({
    rebuildElectron: (onSpawn) => runCommand(resolve(root, 'node_modules/.bin/electron-rebuild'), ['-f', '-w', 'better-sqlite3'], desktop, onSpawn),
    forge: (onSpawn) => runCommand(
      resolve(root, 'node_modules/.bin/electron-forge'),
      [command],
      desktop,
      onSpawn,
      {
        env: {
          ...process.env,
          CATBOTS_INTERNAL_FORGE_LIFECYCLE: command,
          CATBOTS_INTERNAL_FORGE_PARENT_PID: String(process.pid),
        },
      },
    ),
    restoreHost: (onSpawn) => runCommand(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'install', '--prefix', nativePath],
      root,
      onSpawn,
      restoreProcessOptions(),
    ),
    signalOptions: options.signalOptions,
  });
}

async function main() {
  await runDesktopCommand(process.argv[2] ?? 'package', {
    signalOptions: {
      on: process.on.bind(process),
      off: process.off.bind(process),
      exit: (code) => process.exit(code),
      report: (message) => console.error(message),
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
