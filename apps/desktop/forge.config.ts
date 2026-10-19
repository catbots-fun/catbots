import { execFileSync } from 'node:child_process';
import { cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { assertReleaseTrustFile } from '../../scripts/check-release-trust.mjs';
import { verifyProductionPackage } from '../../scripts/verify-package-contents.mjs';

const workspaceNodeModules = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'node_modules');
const sqliteRuntimeDependencies = ['better-sqlite3', 'bindings', 'file-uri-to-path'];
const releaseTrustFile = process.env.CATBOTS_RELEASE_TRUST_FILE;
const bootstrapInstallerResource = releaseTrustFile === undefined
  ? '../../scripts/install.sh'
  : join(dirname(releaseTrustFile), 'install.sh');
const releaseTrustResource = releaseTrustFile ?? 'assets/release-trust.json';

export async function assertForgeReleaseTrust(
  path = process.env.CATBOTS_RELEASE_TRUST_FILE,
  expectedFingerprint = process.env.CATBOTS_RELEASE_TRUST_FINGERPRINT,
): Promise<void> {
  await assertReleaseTrustFile(path, expectedFingerprint);
}

type ForgeLifecycle = 'start' | 'package' | 'make';

function forgeLifecycleFromArgv(argv: readonly string[]): ForgeLifecycle | undefined {
  return argv.find((argument): argument is ForgeLifecycle => (
    argument === 'start' || argument === 'package' || argument === 'make'
  ));
}

function forgeLifecycleFromString(value: string | undefined): ForgeLifecycle | undefined {
  return value === 'start' || value === 'package' || value === 'make' ? value : undefined;
}

function forgeAncestorPids(startPid = process.ppid): number[] {
  const ancestors: number[] = [];
  let pid = startPid;
  for (let depth = 0; depth < 4 && pid > 1; depth += 1) {
    ancestors.push(pid);
    try {
      const parent = Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
      if (!Number.isSafeInteger(parent) || parent <= 1 || parent === pid) break;
      pid = parent;
    } catch {
      break;
    }
  }
  return ancestors;
}

export async function runForgeReleaseTrustGate({
  argv = process.argv,
  npmLifecycle = process.env.npm_lifecycle_event,
  orchestratorIntent = process.env.CATBOTS_INTERNAL_FORGE_LIFECYCLE,
  orchestratorParentPid = process.env.CATBOTS_INTERNAL_FORGE_PARENT_PID,
  ancestorPids = forgeAncestorPids(),
  trustFile = process.env.CATBOTS_RELEASE_TRUST_FILE,
  expectedFingerprint = process.env.CATBOTS_RELEASE_TRUST_FINGERPRINT,
}: {
  argv?: readonly string[];
  npmLifecycle?: string;
  orchestratorIntent?: string;
  orchestratorParentPid?: string;
  ancestorPids?: readonly number[];
  trustFile?: string;
  expectedFingerprint?: string;
} = {}): Promise<void> {
  const argvLifecycle = forgeLifecycleFromArgv(argv);
  const packageScriptLifecycle = forgeLifecycleFromString(npmLifecycle);
  if (argvLifecycle !== undefined && packageScriptLifecycle !== undefined && argvLifecycle !== packageScriptLifecycle) {
    throw new Error('FORGE_LIFECYCLE_MISMATCH');
  }
  const lifecycle = argvLifecycle ?? packageScriptLifecycle;
  let hasValidatedOrchestratorIntent = false;
  if (orchestratorIntent !== undefined) {
    if (
      forgeLifecycleFromString(orchestratorIntent) === undefined
      || orchestratorIntent !== lifecycle
      || !ancestorPids.includes(Number(orchestratorParentPid))
    ) {
      throw new Error('FORGE_LIFECYCLE_MISMATCH');
    }
    hasValidatedOrchestratorIntent = true;
  }
  if (argvLifecycle === 'start' || (hasValidatedOrchestratorIntent && lifecycle === 'start')) return;
  await assertForgeReleaseTrust(trustFile, expectedFingerprint);
}

export async function assertForgeMakeReady({
  argv = process.argv,
  trustFile = process.env.CATBOTS_RELEASE_TRUST_FILE,
  expectedFingerprint = process.env.CATBOTS_RELEASE_TRUST_FINGERPRINT,
}: {
  argv?: readonly string[];
  trustFile?: string;
  expectedFingerprint?: string;
} = {}): Promise<void> {
  await assertForgeReleaseTrust(trustFile, expectedFingerprint);
  if (argv.some((argument) => argument === '--skip-package' || argument.startsWith('--skip-package='))) {
    throw new Error('FORGE_SKIP_PACKAGE_FORBIDDEN');
  }
}

export async function verifyForgePackageOutputs(outputPaths: string[]): Promise<void> {
  for (const outputPath of outputPaths) await verifyProductionPackage(outputPath);
}

async function stageSqliteRuntimeDependencies(
  _forgeConfig: ForgeConfig,
  buildPath: string,
): Promise<void> {
  await Promise.all(sqliteRuntimeDependencies.map((dependency) => cp(
    join(workspaceNodeModules, dependency),
    join(buildPath, 'node_modules', dependency),
    { dereference: true, recursive: true },
  )));
}

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Catbots',
    executableName: 'Catbots',
    appBundleId: 'com.catbots.desktop',
    appCategoryType: 'public.app-category.finance',
    icon: 'assets/icon.icns',
    asar: true,
    extraResource: [
      'assets/lighter',
      'assets/trayTemplate.png',
      'assets/catbots',
      'assets/fun.catbots.web.plist.template',
      bootstrapInstallerResource,
      releaseTrustResource,
    ],
    // Keep only Vite output in the app bundle. This also excludes local configuration and planning artifacts.
    ignore: (file: string) => {
      // Electron Packager asks about the project root with an empty path; it must never be ignored.
      if (!file) return false;
      return !file.startsWith('/.vite');
    },
  },
  hooks: {
    generateAssets: async () => runForgeReleaseTrustGate(),
    prePackage: async () => runForgeReleaseTrustGate(),
    preMake: async () => assertForgeMakeReady(),
    packageAfterCopy: stageSqliteRuntimeDependencies,
    postPackage: async (_forgeConfig, packageResult) => verifyForgePackageOutputs(packageResult.outputPaths),
  },
  makers: [new MakerZIP({}, ['darwin'])],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'src/main/backtest/flow-backtest-worker.ts', config: 'vite.backtest-worker.config.ts' },
        {
          entry: 'src/main/entrypoint.ts',
          config: 'vite.main.config.ts',
        },
        {
          entry: 'src/preload/index.ts',
          config: 'vite.preload.config.ts',
        },
        {
          entry: 'src/main/runtime/runtime-worker.ts',
          config: 'vite.runtime-worker.config.ts',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
