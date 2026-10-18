import { ipcMain, webContents, type IpcMainInvokeEvent } from 'electron';
import { AgentToolActivitySchema, DatabaseStateSchema, RuntimeStatusSchema, type AgentToolActivity, type RuntimeStatus } from '@catbots/contracts';
import { assertTrustedAppSenderUrl } from '../ipc-security';
import { createApplicationHandlers, IpcRequestError, type ApplicationHandlers, type IpcHandlerDependencies } from './application-handlers';
export { IpcRequestError } from './application-handlers';
export type { IpcHandlerDependencies } from './application-handlers';
type DatabaseRepairIpcDependencies = { app: { quitApplication(): void | Promise<void> } };
export type IpcHandlers = { [K in keyof ApplicationHandlers]: (event: IpcMainInvokeEvent, ...args: Parameters<ApplicationHandlers[K]>) => ReturnType<ApplicationHandlers[K]> };

type RegisteredIpcHandlers = {
  dependencies: IpcHandlerDependencies;
  dispose(): void;
};

let activeRegistration: RegisteredIpcHandlers | undefined;

export function registerDatabaseRepairIpcHandlers(dependencies: DatabaseRepairIpcDependencies): () => void {
  const channels: ReadonlyArray<readonly [string, (event: IpcMainInvokeEvent) => unknown]> = [
    ['app:quit-application', async (event) => {
      assertTrustedAppSenderUrl(event.senderFrame?.url);
      try {
        await dependencies.app.quitApplication();
      } catch {
        throw new IpcRequestError('APP_QUIT_APPLICATION_FAILED');
      }
    }],
    ['runtime:get-database-state', async (event) => {
      assertTrustedAppSenderUrl(event.senderFrame?.url);
      return DatabaseStateSchema.parse({ status: 'repair', code: 'DATABASE_MIGRATION_FAILED' });
    }],
  ];
  const registeredChannels: string[] = [];
  try {
    for (const [channel, handler] of channels) {
      ipcMain.handle(channel, handler);
      registeredChannels.push(channel);
    }
  } catch (error) {
    removeOwnedHandlers(registeredChannels);
    throw error;
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    removeOwnedHandlers(registeredChannels);
  };
}

export function createIpcHandlers(dependencies: IpcHandlerDependencies): IpcHandlers {
  const application = createApplicationHandlers(dependencies);
  return Object.fromEntries(Object.entries(application).map(([name, handler]) => [name,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      assertTrustedAppSenderUrl(event.senderFrame?.url);
      return (handler as (...input: unknown[]) => unknown)(...args);
    },
  ])) as IpcHandlers;
}

export function registerIpcHandlers(dependencies: IpcHandlerDependencies): () => void {
  const previousRegistration = activeRegistration;
  if (previousRegistration !== undefined) {
    activeRegistration = undefined;
    try {
      previousRegistration.dispose();
    } catch {
      // Its handlers were removed in dispose's finally block; replacement remains safe.
    }
  }

  let registration: RegisteredIpcHandlers;
  try {
    registration = installIpcHandlers(dependencies);
  } catch (error) {
    if (previousRegistration !== undefined) {
      try {
        activeRegistration = installIpcHandlers(previousRegistration.dependencies);
      } catch {
        activeRegistration = undefined;
      }
    }
    throw error;
  }
  activeRegistration = registration;

  return () => {
    if (activeRegistration !== registration) return;
    activeRegistration = undefined;
    registration.dispose();
  };
}

function installIpcHandlers(dependencies: IpcHandlerDependencies): RegisteredIpcHandlers {
  const handlers = createIpcHandlers(dependencies);
  const channels: ReadonlyArray<readonly [string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown]> = [
    ['connections:command', handlers.connectionCommand],
    ['nodes:command', handlers.nodePackageCommand],
    ['providers:command', handlers.providerCommand],
    ['app:get-version', handlers.getVersion],
    ['app:get-capabilities', handlers.getProductCapabilities],
    ['app:show-main-window', handlers.showMainWindow],
    ['app:quit-application', handlers.quitApplication],
    ['config:get-bootstrap-state', handlers.getBootstrapState],
    ['config:patch-settings', handlers.patchLocalSettings],
    ['config:test-llm', handlers.testLlmConnection],
    ['bots:remove', handlers.removeBot],
    ['bots:list', handlers.listBots],
    ['bots:create-draft', handlers.createDraftBot],
    ['workbench:get', handlers.getWorkbench],
    ['workbench:stop-agent', handlers.stopWorkbenchAgent],
    ['workbench:send-message', handlers.sendWorkbenchMessage],
    ['workbench:run-backtest', handlers.runWorkbenchBacktest],
    ['workbench:configure-node', handlers.configureLegacyNode],
    ['workbench:approve-revision', handlers.approveStrategyRevision],
    ['workbench:get-trace', handlers.getWorkbenchTrace],
    ['deployments:start-paper', handlers.startPaperDeployment],
    ['deployments:get-paper', handlers.getPaperDeployment],
    ['deployments:pause-paper', handlers.pausePaperDeployment],
    ['deployments:stop-paper', handlers.stopPaperDeployment],
    ['deployments:prepare-live', handlers.prepareLiveDeployment],
    ['deployments:start-live', handlers.startLiveDeployment],
    ['deployments:get-live', handlers.getLiveDeployment],
    ['deployments:stop-live', handlers.stopLiveDeployment],
    ['deployments:get-active', handlers.getActiveDeployment],
    ['runtime:get-status', handlers.getRuntimeStatus],
    ['runtime:get-database-state', handlers.getDatabaseState],
  ];
  const registeredChannels: string[] = [];
  let unsubscribeRuntime: (() => void) | undefined;
  let unsubscribeActivity: (() => void) | undefined;

  try {
    for (const [channel, handler] of channels) {
      ipcMain.handle(channel, handler);
      registeredChannels.push(channel);
    }
    const unsubscribe = dependencies.runtime.subscribeStatus((candidate: RuntimeStatus) => {
      forwardRuntimeStatus(candidate);
    });
    if (typeof unsubscribe !== 'function') throw new Error('Invalid runtime subscription');
    unsubscribeRuntime = unsubscribe;
    const unsubscribeWorkbench = dependencies.workbenchService.subscribeActivity((activity) => {
      forwardWorkbenchActivity(activity);
    });
    if (typeof unsubscribeWorkbench !== 'function') throw new Error('Invalid workbench subscription');
    unsubscribeActivity = unsubscribeWorkbench;
  } catch (error) {
    try {
      unsubscribeAll(unsubscribeActivity, unsubscribeRuntime);
    } finally {
      removeOwnedHandlers(registeredChannels);
    }
    throw error;
  }

  let disposed = false;
  return {
    dependencies,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const unsubscribe = unsubscribeRuntime;
      const unsubscribeWorkbench = unsubscribeActivity;
      unsubscribeRuntime = undefined;
      unsubscribeActivity = undefined;
      try {
        unsubscribeAll(unsubscribeWorkbench, unsubscribe);
      } finally {
        removeOwnedHandlers(registeredChannels);
      }
    },
  };
}

function unsubscribeAll(...subscriptions: Array<(() => void) | undefined>): void {
  let firstFailure: unknown;
  for (const unsubscribe of subscriptions) {
    try {
      unsubscribe?.();
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}

function forwardWorkbenchActivity(candidate: unknown): void {
  const parsed = AgentToolActivitySchema.safeParse(candidate);
  if (!parsed.success) return;
  forwardToTrustedRenderers('workbench:activity', parsed.data);
}

function removeOwnedHandlers(channels: readonly string[]): void {
  let firstFailure: unknown;
  let hasFailure = false;
  for (const channel of [...channels].reverse()) {
    try {
      ipcMain.removeHandler(channel);
    } catch (error) {
      if (!hasFailure) {
        firstFailure = error;
        hasFailure = true;
      }
    }
  }
  if (hasFailure) throw firstFailure;
}

function forwardRuntimeStatus(candidate: unknown): void {
  const parsed = RuntimeStatusSchema.safeParse(candidate);
  if (!parsed.success) return;

  forwardToTrustedRenderers('runtime:status', parsed.data);
}

function forwardToTrustedRenderers(channel: string, payload: RuntimeStatus | AgentToolActivity): void {
  for (const target of webContents.getAllWebContents()) {
    try {
      if (target.isDestroyed()) continue;
      assertTrustedAppSenderUrl(target.getURL());
      target.send(channel, payload);
    } catch {
      // A destroyed, untrusted, or failed renderer target must not affect other targets.
    }
  }
}
