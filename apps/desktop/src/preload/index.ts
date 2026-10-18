import { contextBridge, ipcRenderer } from 'electron';
import type { AgentToolActivity, CatbotsDesktopApi, RuntimeStatus } from '@catbots/contracts';

const runtimeListeners = new Set<(status: RuntimeStatus) => void>();
const activityListeners = new Set<(activity: AgentToolActivity) => void>();

ipcRenderer.on('runtime:status', (_event, status: RuntimeStatus) => {
  for (const listener of runtimeListeners) listener(status);
});

ipcRenderer.on('workbench:activity', (_event, activity: AgentToolActivity) => {
  for (const listener of activityListeners) listener(activity);
});

const catbots: CatbotsDesktopApi = deepFreeze({
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
    getCapabilities: () => ipcRenderer.invoke('app:get-capabilities'),
    showMainWindow: (): Promise<void> => ipcRenderer.invoke('app:show-main-window'),
    quitApplication: (): Promise<void> => ipcRenderer.invoke('app:quit-application'),
  },
  connections: { command: (input) => ipcRenderer.invoke('connections:command', input) },
  nodes: { command: (input) => ipcRenderer.invoke('nodes:command', input) },
  providers: { command: (input) => ipcRenderer.invoke('providers:command', input) },
  config: {
    getBootstrapState: () => ipcRenderer.invoke('config:get-bootstrap-state'),
    patchSettings: (input) => ipcRenderer.invoke('config:patch-settings', input),
    testLlmConnection: (input) => ipcRenderer.invoke('config:test-llm', input),
  },
  bots: {
    remove: (input) => ipcRenderer.invoke('bots:remove', input),
    list: () => ipcRenderer.invoke('bots:list'),
    createDraft: (input) => ipcRenderer.invoke('bots:create-draft', input),
  },
  workbench: {
    get: (input) => ipcRenderer.invoke('workbench:get', input),
    stopAgent: (input) => ipcRenderer.invoke('workbench:stop-agent', input),
    sendMessage: (input) => ipcRenderer.invoke('workbench:send-message', input),
    runBacktest: (input) => ipcRenderer.invoke('workbench:run-backtest', input),
    configureNode: (input) => ipcRenderer.invoke('workbench:configure-node', input),
    approveRevision: (input) => ipcRenderer.invoke('workbench:approve-revision', input),
    getTrace: (input) => ipcRenderer.invoke('workbench:get-trace', input),
    subscribeActivity: (listener: (activity: AgentToolActivity) => void): (() => void) => {
      activityListeners.add(listener);
      return () => activityListeners.delete(listener);
    },
  },
  deployments: {
    startPaper: (input) => ipcRenderer.invoke('deployments:start-paper', input),
    getPaper: (input) => ipcRenderer.invoke('deployments:get-paper', input),
    pausePaper: (input) => ipcRenderer.invoke('deployments:pause-paper', input),
    stopPaper: (input) => ipcRenderer.invoke('deployments:stop-paper', input),
    prepareLive: (input) => ipcRenderer.invoke('deployments:prepare-live', input),
    startLive: (input) => ipcRenderer.invoke('deployments:start-live', input),
    getLive: (input) => ipcRenderer.invoke('deployments:get-live', input),
    stopLive: (input) => ipcRenderer.invoke('deployments:stop-live', input),
    getActive: (input) => ipcRenderer.invoke('deployments:get-active', input),
  },
  runtime: {
    getStatus: () => ipcRenderer.invoke('runtime:get-status'),
    getDatabaseState: () => ipcRenderer.invoke('runtime:get-database-state'),
    subscribeStatus: (listener: (status: RuntimeStatus) => void): (() => void) => {
      runtimeListeners.add(listener);
      void ipcRenderer.invoke('runtime:get-status').then((status: RuntimeStatus) => {
        if (runtimeListeners.has(listener)) listener(status);
      }).catch(() => undefined);
      return () => runtimeListeners.delete(listener);
    },
  },
});

contextBridge.exposeInMainWorld('catbots', catbots);

function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
