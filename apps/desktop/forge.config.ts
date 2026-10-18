import { cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';

const workspaceNodeModules = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'node_modules');
const sqliteRuntimeDependencies = ['better-sqlite3', 'bindings', 'file-uri-to-path'];

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
    ],
    // Keep only Vite output in the app bundle. This also excludes local configuration and planning artifacts.
    ignore: (file: string) => {
      // Electron Packager asks about the project root with an empty path; it must never be ignored.
      if (!file) return false;
      return !file.startsWith('/.vite');
    },
  },
  hooks: {
    packageAfterCopy: stageSqliteRuntimeDependencies,
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
