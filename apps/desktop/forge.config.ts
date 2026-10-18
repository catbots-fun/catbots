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
    generateAssets: async () => assertForgeReleaseTrust(),
    prePackage: async () => assertForgeReleaseTrust(),
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
