import type { AgentToolActivity, CatbotsDesktopApi, RuntimeStatus } from '@catbots/contracts';

export async function createWebApi(): Promise<CatbotsDesktopApi> {
  const session = await fetch('/api/session', { headers: { 'x-catbots-client': '1' }, credentials: 'same-origin' });
  if (!session.ok) throw new Error('WEB_BACKEND_UNAVAILABLE');
  const invoke = async <T,>(method: string, input?: unknown): Promise<T> => {
    const response = await fetch('/api/rpc', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-catbots-client': '1' },
      body: JSON.stringify({ method, input }),
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error ?? 'WEB_REQUEST_FAILED');
    return data.result as T;
  };
  const activity = new Set<(value: AgentToolActivity) => void>();
  const runtime = new Set<(value: RuntimeStatus) => void>();
  const events = new EventSource('/api/events');
  events.addEventListener('activity', (event) => {
    try { const value = JSON.parse(event.data); for (const listener of activity) listener(value); } catch { /* Invalid event is ignored. */ }
  });
  events.addEventListener('runtime', (event) => {
    try { const value = JSON.parse(event.data); for (const listener of runtime) listener(value); } catch { /* Invalid event is ignored. */ }
  });
  window.addEventListener('pagehide', () => events.close(), { once: true });
  return {
    app: {
      getVersion: () => invoke('app:get-version'),
      getCapabilities: () => invoke('app:get-capabilities'),
      showMainWindow: () => invoke('app:show-main-window'),
      quitApplication: () => invoke('app:quit-application'),
    },
    connections: { command: (input) => invoke('connections:command', input) },
  nodes: { command: (input) => invoke('nodes:command', input) },
  providers: { command: (input) => invoke('providers:command', input) },
  config: {
      getBootstrapState: () => invoke('config:get-bootstrap-state'),
      patchSettings: (input) => invoke('config:patch-settings', input),
      testLlmConnection: (input) => invoke('config:test-llm', input),
    },
    bots: { remove: (input) => invoke('bots:remove', input), list: () => invoke('bots:list'), createDraft: (input) => invoke('bots:create-draft', input) },
    workbench: {
      get: (input) => invoke('workbench:get', input),
      stopAgent: (input) => invoke('workbench:stop-agent', input),
    sendMessage: (input) => invoke('workbench:send-message', input),
      runBacktest: (input) => invoke('workbench:run-backtest', input),
      configureNode: (input) => invoke('workbench:configure-node', input),
    approveRevision: (input) => invoke('workbench:approve-revision', input),
      getTrace: (input) => invoke('workbench:get-trace', input),
      subscribeActivity: (listener) => { activity.add(listener); return () => { activity.delete(listener); }; },
    },
    deployments: {
      startPaper: (input) => invoke('deployments:start-paper', input),
      getPaper: (input) => invoke('deployments:get-paper', input),
      pausePaper: (input) => invoke('deployments:pause-paper', input),
      stopPaper: (input) => invoke('deployments:stop-paper', input),
      prepareLive: (input) => invoke('deployments:prepare-live', input),
      startLive: (input) => invoke('deployments:start-live', input),
      getLive: (input) => invoke('deployments:get-live', input),
      stopLive: (input) => invoke('deployments:stop-live', input),
      getActive: (input) => invoke('deployments:get-active', input),
    },
    runtime: {
      getStatus: () => invoke('runtime:get-status'),
      getDatabaseState: () => invoke('runtime:get-database-state'),
      subscribeStatus: (listener) => {
        runtime.add(listener);
        void invoke<RuntimeStatus>('runtime:get-status').then((value) => { if (runtime.has(listener)) listener(value); }).catch(() => undefined);
        return () => { runtime.delete(listener); };
      },
    },
  };
}
