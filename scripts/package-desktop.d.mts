import type { EventEmitter } from 'node:events';

export type SpawnedChild = EventEmitter & { kill(signal: string): void };
export type ProcessOptions = { detached?: boolean; stdio?: 'ignore' | 'inherit'; windowsHide?: boolean };
export type RunCommand = (command: string, args: string[], cwd?: string, onSpawn?: (child: SpawnedChild) => void, processOptions?: ProcessOptions) => Promise<void>;
export function createRunner(spawnCommand?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'inherit' } & ProcessOptions) => SpawnedChild): RunCommand;
export type SignalOptions = { on(signal: string, handler: () => Promise<void>): void; off(signal: string, handler: () => Promise<void>): void; exit(code: number): void; report?(message: string): void };
export function runPackaging(options: { rebuildElectron(onSpawn?: (child: SpawnedChild) => void): Promise<void>; forge(onSpawn?: (child: SpawnedChild) => void): Promise<void>; restoreHost(onSpawn?: (child: SpawnedChild) => void): Promise<void>; signalOptions?: SignalOptions }): Promise<void>;
export function runDesktopCommand(command: string, options?: {
  run?: ReturnType<typeof createRunner>;
  signalOptions?: SignalOptions;
  assertTrust?(path: string | undefined, expectedFingerprint: string | undefined): Promise<void>;
}): Promise<void>;
export function waitForChildExit(child: SpawnedChild): Promise<void>;
export function createSignalController(options: { on(signal: string, handler: () => Promise<void>): void; off(signal: string, handler: () => Promise<void>): void; exit(code: number): void; terminate(signal: string): void; waitForExit(): Promise<void>; restoreHost(): Promise<void>; report?(message: string): void }): { remove(): void };
export function runForgeWithSignalHandling(options: { runCommand: RunCommand; command: string; args: string[]; on(signal: string, handler: () => Promise<void>): void; off(signal: string, handler: () => Promise<void>): void; exit(code: number): void; restoreHost(): Promise<void>; report?(message: string): void }): Promise<void>;
export function restoreProcessOptions(platform?: NodeJS.Platform): ProcessOptions;
