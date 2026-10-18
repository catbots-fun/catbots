import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BacktestSummarySchema,
  BotSummarySchema,
  LocalConfigSchema,
  REDACTED_SECRET,
  TraceDetailSchema,
  WorkbenchStateSchema,
  type AgentToolActivity,
  type Deployment,
  type LivePreflightView,
  type PaperDeploymentView,
  type ProductCapabilities,
  type RiskLimits,
  type RuntimeStatus,
} from '@catbots/contracts';
import { buildWindowOptions } from '../src/main/create-window';
import { denyUnexpectedNavigation } from '../src/main/create-window';
import { ConfigRepository } from '../src/main/config/config-repository';
import { assertTrustedAppSenderUrl } from '../src/main/ipc-security';
import { createIpcHandlers, registerIpcHandlers, type IpcHandlerDependencies } from '../src/main/ipc/register-ipc';
import { getSafeRelativePath } from '../src/main/register-app-protocol';

const electronBridge = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  handle: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeHandler: vi.fn(),
  getAllWebContents: vi.fn<() => unknown[]>(() => []),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronBridge.exposeInMainWorld },
  ipcMain: { handle: electronBridge.handle, removeHandler: electronBridge.removeHandler },
  ipcRenderer: { invoke: electronBridge.invoke, on: electronBridge.on },
  webContents: { getAllWebContents: electronBridge.getAllWebContents },
  net: { fetch: vi.fn() },
  protocol: {
    handle: vi.fn(),
    registerSchemesAsPrivileged: vi.fn(),
  },
}));

beforeEach(() => {
  electronBridge.handle.mockReset();
  electronBridge.removeHandler.mockReset();
  electronBridge.invoke.mockReset();
  electronBridge.getAllWebContents.mockReset();
  electronBridge.getAllWebContents.mockReturnValue([]);
});

describe('buildWindowOptions', () => {
  it('isolates and sandboxes the renderer', () => {
    const options = buildWindowOptions('/app/preload.js');
    expect(options.webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: '/app/preload.js',
    });
  });
});

describe('application origin boundaries', () => {
  it('rejects an application authority with a port', () => {
    expect(getSafeRelativePath('catbots://app:123/index.html')).toBeUndefined();
  });

  it('rejects encoded path traversal', () => {
    expect(getSafeRelativePath('catbots://app/%2e%2e%2fsecret.txt')).toBeUndefined();
  });

  it('denies navigation outside the application origin', () => {
    const event = { preventDefault: vi.fn() };

    denyUnexpectedNavigation(event, 'https://example.com');

    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('rejects an IPC sender outside the application entry document', () => {
    expect(() => assertTrustedAppSenderUrl('catbots://app/settings.html')).toThrow('Untrusted IPC sender');
  });

  it.each([
    'catbots://app/%69ndex.html',
    'catbots://app/index.html?next=settings',
    'catbots://app/index.html#settings',
    'catbots://app:443/index.html',
    'catbots://user@app/index.html',
    'CATBOTS://app/index.html',
    undefined,
  ])('rejects non-canonical IPC sender spelling %s', (senderUrl) => {
    expect(() => assertTrustedAppSenderUrl(senderUrl)).toThrow('IPC_SENDER_NOT_ALLOWED');
  });
});

const localEvent = {
  senderFrame: { url: 'catbots://app/index.html' },
} as unknown as Electron.IpcMainInvokeEvent;
const fakeRemoteEvent = {
  senderFrame: { url: 'https://attacker.example/' },
} as unknown as Electron.IpcMainInvokeEvent;
const validConfig = LocalConfigSchema.parse({
  profile: { name: 'My Trading', telemetry: false },
  llm: {
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'secret',
    model: 'provider/model',
  },
  exchanges: {},
});
const settingsPatch = {
  profile: { name: 'My Trading', telemetry: false },
  llm: {
    provider: 'openai-compatible' as const,
    baseUrl: 'https://api.example.com/v1',
    model: 'provider/model',
  },
};
const deploymentId = '028f3f75-89ab-7def-8123-456789abcdef';
const botId = '018f3f75-89ab-7def-8123-456789abcdef';
const riskLimits: RiskLimits = {
  maxOrderUsd: '1000', maxPositionUsd: '2500', maxTotalExposureUsd: '5000', maxLeverage: 3,
  maxDailyLossUsd: '300', maxDrawdownPercent: 12,
  allowedSides: ['long', 'short'], maxOrdersPerMinute: 4,
};
const paperView: PaperDeploymentView = {
  deployment: {
    id: deploymentId, botId, strategyId: 'btc-paper', strategyVersion: 1,
    recordVersion: 2, dex: 'hyperliquid', mode: 'paper', executionVenue: 'paper', marketAccess: { mode: 'all_active_perpetuals' },
    riskLimits, status: 'running', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
  },
  state: { equityUsd: '10000', positions: [], orders: [] },
  auditEvents: [],
};
const livePreflight: LivePreflightView = {
  id: '038f3f75-89ab-7def-8123-456789abcdef', botId, strategyVersion: 1, network: 'testnet',
  maskedAccount: '0x0123…4567', checkedAt: '2026-09-05T00:00:00.000Z', ready: true,
  checks: [{ id: 'connection', label: 'Connection', ok: true, message: 'Connected.' }],
};
const liveDeployment: Deployment = {
  id: deploymentId, botId, strategyId: 'btc-paper', strategyVersion: 1,
  recordVersion: 2, dex: 'hyperliquid', mode: 'live', executionVenue: 'hyperliquid', network: 'testnet', maskedAccount: '0x0123…4567', marketAccess: { mode: 'all_active_perpetuals' },
  riskLimits, status: 'running', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
};
const botSummary = BotSummarySchema.parse({
  id: botId,
  name: 'DEX bot',
  dex: 'hyperliquid',
  status: 'draft',
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
});
const strategyRevision = {
  botId,
  strategyId: 'eth-rsi',
  version: 1,
  name: 'ETH RSI',
  schemaVersion: '2.0' as const,
  marketScope: { type: 'dex_universe' as const },
  status: 'draft' as const,
  createdAt: '2026-09-05T00:00:00.000Z',
  approvedAt: null,
  nodes: [],
  edges: [],
};
const backtestSummary = BacktestSummarySchema.parse({
  id: '048f3f75-89ab-7def-8123-456789abcdef',
  botId,
  revisionVersion: 1,
  status: 'completed',
  dataSource: 'Bundled sample data',
  startedAt: '2026-09-05T00:00:00.000Z',
  completedAt: '2026-09-05T00:01:00.000Z',
  assumptions: {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-09-01T00:00:00.000Z',
    startingCapital: '10000',
    feeRateBps: 3.5,
    slippageBps: 1,
  },
  metrics: {
    returnPercent: 2.5,
    maximumDrawdownPercent: 1,
    sharpeLike: 1.2,
    winRatePercent: 50,
    tradeCount: 2,
    fees: '5',
    funding: '0',
    endingEquity: '10250',
    realizedPnl: '250',
  },
  datasetCoverage: {
    markets: ['BTC-PERP', 'ETH-PERP'],
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-09-01T00:00:00.000Z',
  },
  perMarket: [
    { market: 'BTC-PERP', realizedPnl: '100', tradeCount: 1, winRatePercent: 100, drawdownContributionPercent: 0.4 },
    { market: 'ETH-PERP', realizedPnl: '150', tradeCount: 1, winRatePercent: 100, drawdownContributionPercent: 0.6 },
  ],
  equityCurve: [],
  trades: [],
  warnings: ['Bundled sample data is synthetic and is not live market data.'],
  traces: [],
  artifactHash: `sha256:${'a'.repeat(64)}`,
});
const workbenchState = WorkbenchStateSchema.parse({
  bot: botSummary,
  currentRevision: strategyRevision,
  revisions: [{ version: 1, status: 'draft', createdAt: strategyRevision.createdAt, approvedAt: null }],
  messages: [],
  backtests: [],
});

function createDependencies() {
  const capabilities: ProductCapabilities = {
    release: 'testnet-alpha',
    strategyResearch: true,
    paperExecution: true,
    liveExecution: true,
    exchangeConnections: true,
  };
  return {
    capabilities,
    connections: undefined as IpcHandlerDependencies['connections'],
    app: {
      getVersion: vi.fn(() => '0.1.0'),
      showMainWindow: vi.fn(),
      quitApplication: vi.fn(),
    },
    configRepository: {
      getRedacted: vi.fn(),
      save: vi.fn(),
      patchSettings: vi.fn(),
      resolveSettingsPatch: vi.fn().mockResolvedValue(validConfig),
    },
    botRepository: {
      list: vi.fn(() => []),
      createDraft: vi.fn(() => botSummary),
    },
    workbenchService: {
      get: vi.fn(async () => workbenchState),
      stopAgent: vi.fn(async () => undefined), sendMessage: vi.fn(async () => workbenchState),
      runBacktest: vi.fn(async () => backtestSummary),
      approveRevision: vi.fn(async () => strategyRevision),
      getTrace: vi.fn(async () => TraceDetailSchema.parse({
        traceId: 'child:eth',
        parentTraceId: 'parent:interval:universe:bundled%3Aeth-listed',
        market: 'ETH-PERP',
        outcome: 'executed',
        events: [],
      })),
      subscribeActivity: vi.fn((_listener: (activity: AgentToolActivity) => void) => () => undefined),
    },
    deploymentService: {
      startPaper: vi.fn(async () => paperView.deployment),
      getPaperDeployment: vi.fn(() => paperView),
      pause: vi.fn(() => ({ ...paperView.deployment, status: 'paused' as const })),
      stop: vi.fn(() => ({ ...paperView.deployment, status: 'stopped' as const })),
      prepareLive: vi.fn().mockResolvedValue(livePreflight),
      startLive: vi.fn().mockResolvedValue(liveDeployment),
      getLiveDeployment: vi.fn(() => liveDeployment),
      getActiveDeployment: vi.fn(() => liveDeployment),
    },
    runtime: {
      getStatus: vi.fn(() => ({ state: 'stopped' as const, activeBots: 0 })),
      subscribeStatus: vi.fn((_listener: (status: RuntimeStatus) => void) => () => undefined),
      startDeployment: vi.fn(),
      pauseDeployment: vi.fn(),
      stopDeployment: vi.fn(),
    },
    testLlmConnection: vi.fn(async () => ({ ok: true as const, model: 'provider/model' })),
  };
}

describe('validated IPC handlers', () => {
  it('keeps read-only audit evidence accessible when execution is disabled', async () => {
    const dependencies = createDependencies();
    dependencies.capabilities.exchangeConnections = false;
    const view = { adapters: [], connections: [], auditPage: { records: [] } };
    const command = vi.fn().mockResolvedValue(view);
    dependencies.connections = { command } as never;
    const handlers = createIpcHandlers(dependencies);
    await expect(handlers.connectionCommand(localEvent, { action: 'get_flow_audit', botId })).resolves.toEqual(view);
    expect(command).toHaveBeenCalledExactlyOnceWith({ action: 'get_flow_audit', botId, after: 0, limit: 20 });
    await expect(handlers.connectionCommand(fakeRemoteEvent, { action: 'get_flow_audit', botId })).rejects.toThrow('IPC_SENDER_NOT_ALLOWED');
  });
  it('reports Strategy Lab capabilities and rejects every execution start before service access', async () => {
    const dependencies = createDependencies();
    const connectionCommand = vi.fn().mockResolvedValue({ adapters: [], connections: [] });
    dependencies.connections = { command: connectionCommand } as never;
    dependencies.capabilities = {
      release: 'strategy-lab-beta',
      strategyResearch: true,
      paperExecution: false,
      liveExecution: false,
      exchangeConnections: false,
    };
    const handlers = createIpcHandlers(dependencies);
    const prepare = { botId, strategyVersion: 1, riskLimits, network: 'testnet' as const };
    const start = { ...prepare, preflightId: livePreflight.id, confirmationBotName: 'BTC Live' };

    await expect(handlers.getProductCapabilities(localEvent)).resolves.toEqual(dependencies.capabilities);
    await expect(handlers.startPaperDeployment(localEvent, { botId, strategyVersion: 1, riskLimits }))
      .rejects.toMatchObject({ code: 'EXECUTION_NOT_AVAILABLE' });
    await expect(handlers.prepareLiveDeployment(localEvent, prepare))
      .rejects.toMatchObject({ code: 'EXECUTION_NOT_AVAILABLE' });
    await expect(handlers.startLiveDeployment(localEvent, start))
      .rejects.toMatchObject({ code: 'EXECUTION_NOT_AVAILABLE' });
    await expect(handlers.connectionCommand(localEvent, {
      action: 'connect', adapterId: 'hyperliquid', name: 'Testnet', environment: 'testnet', owner: `0x${'1'.repeat(40)}`,
    })).rejects.toMatchObject({ code: 'EXECUTION_NOT_AVAILABLE' });
    await expect(handlers.patchLocalSettings(localEvent, {
      ...settingsPatch,
      exchanges: { hyperliquid: { network: 'testnet', accountAddress: `0x${'1'.repeat(40)}`, agentPrivateKey: `0x${'2'.repeat(64)}` } },
    })).rejects.toMatchObject({ code: 'EXECUTION_NOT_AVAILABLE' });
    await expect(handlers.connectionCommand(localEvent, { action: 'list' })).resolves.toEqual({ adapters: [], connections: [] });

    expect(dependencies.deploymentService.startPaper).not.toHaveBeenCalled();
    expect(dependencies.deploymentService.prepareLive).not.toHaveBeenCalled();
    expect(dependencies.deploymentService.startLive).not.toHaveBeenCalled();
    expect(dependencies.runtime.startDeployment).not.toHaveBeenCalled();
    expect(connectionCommand).toHaveBeenCalledExactlyOnceWith({ action: 'list' });
    expect(dependencies.configRepository.patchSettings).not.toHaveBeenCalled();
  });

  it('rejects config writes from an unknown sender', async () => {
    const handlers = createIpcHandlers(createDependencies());

    await expect(handlers.patchLocalSettings(fakeRemoteEvent, settingsPatch))
      .rejects.toThrow('IPC_SENDER_NOT_ALLOWED');
  });

  it('patches settings without accepting full exchange or redacted-secret payloads', async () => {
    const dependencies = createDependencies();
    const handlers = createIpcHandlers(dependencies);

    await handlers.patchLocalSettings(localEvent, settingsPatch);
    expect(dependencies.configRepository.patchSettings).toHaveBeenCalledWith(settingsPatch);

    await expect(handlers.patchLocalSettings(localEvent, {
      ...settingsPatch,
      exchanges: validConfig.exchanges,
    })).rejects.toThrow('INVALID_REQUEST');
    await expect(handlers.patchLocalSettings(localEvent, {
      ...settingsPatch,
      llm: { ...settingsPatch.llm, apiKey: REDACTED_SECRET },
    })).rejects.toThrow('INVALID_REQUEST');
    expect(dependencies.configRepository.patchSettings).toHaveBeenCalledTimes(1);
  });

  it('requires the exact packaged entry document', async () => {
    const dependencies = createDependencies();
    const handlers = createIpcHandlers(dependencies);
    const siblingDocument = {
      senderFrame: { url: 'catbots://app/settings.html' },
    } as unknown as Electron.IpcMainInvokeEvent;

    await expect(handlers.listBots(siblingDocument)).rejects.toThrow('IPC_SENDER_NOT_ALLOWED');
    expect(dependencies.botRepository.list).not.toHaveBeenCalled();
  });

  it('accepts the exact DEX draft contract and rejects legacy market-bound input before repository access', async () => {
    const dependencies = createDependencies();
    const handlers = createIpcHandlers(dependencies);

    await expect(handlers.createDraftBot(localEvent, { name: ' DEX bot ', dex: 'hyperliquid' }))
      .resolves.toEqual(botSummary);
    expect(dependencies.botRepository.createDraft).toHaveBeenCalledExactlyOnceWith({ name: 'DEX bot', dex: 'hyperliquid' });

    await expect(handlers.createDraftBot(localEvent, { name: 'Old bot', market: 'ETH-PERP' }))
      .rejects.toThrow('INVALID_REQUEST');
    expect(dependencies.botRepository.createDraft).toHaveBeenCalledOnce();
  });

  it('returns only validated renderer-safe Bot DTOs', async () => {
    const dependencies = createDependencies();
    const secret = 'provider-secret-must-not-cross-ipc';
    dependencies.botRepository.list.mockReturnValueOnce([{
      ...botSummary,
      market: 'ETH-PERP',
      rawProvider: { authorization: secret },
    }] as never);
    const handlers = createIpcHandlers(dependencies);

    const error = await handlers.listBots(localEvent).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'BOT_LIST_FAILED' });
    expect(String(error)).not.toContain(secret);
  });

  it('validates every workbench request before service access', async () => {
    const dependencies = createDependencies();
    const handlers = createIpcHandlers(dependencies);

    await expect(handlers.getWorkbench(localEvent, { botId: 'not-a-uuid' })).rejects.toThrow('INVALID_REQUEST');
    await expect(handlers.sendWorkbenchMessage(localEvent, { botId: 'not-a-uuid', message: '' })).rejects.toThrow('INVALID_REQUEST');
    await expect(handlers.runWorkbenchBacktest(localEvent, {})).rejects.toThrow('INVALID_REQUEST');
    await expect(handlers.approveStrategyRevision(localEvent, {})).rejects.toThrow('INVALID_REQUEST');
    await expect(handlers.getWorkbenchTrace(localEvent, {})).rejects.toThrow('INVALID_REQUEST');
    expect(dependencies.workbenchService.get).not.toHaveBeenCalled();
    expect(dependencies.workbenchService.sendMessage).not.toHaveBeenCalled();
  });

  it('delegates valid workbench requests without widening their payloads', async () => {
    const dependencies = createDependencies();
    const handlers = createIpcHandlers(dependencies);
    const botId = '018f3f75-89ab-7def-8123-456789abcdef';

    await handlers.getWorkbench(localEvent, { botId });
    await handlers.sendWorkbenchMessage(localEvent, { botId, message: 'Build a momentum bot' });
    await handlers.approveStrategyRevision(localEvent, { botId, version: 1 });

    expect(dependencies.workbenchService.get).toHaveBeenCalledWith({ botId });
    expect(dependencies.workbenchService.sendMessage).toHaveBeenCalledWith({ botId, message: 'Build a momentum bot' });
    expect(dependencies.workbenchService.approveRevision).toHaveBeenCalledWith({ botId, version: 1 });
  });

  it('validates the dynamic Backtest request and renderer response at the Main boundary', async () => {
    const dependencies = createDependencies();
    const handlers = createIpcHandlers(dependencies);
    const request = {
      botId,
      revisionVersion: 1,
      marketUniverse: { mode: 'all_available' as const },
      assumptions: backtestSummary.assumptions,
    };

    await expect(handlers.runWorkbenchBacktest(localEvent, request)).resolves.toEqual(backtestSummary);
    expect(dependencies.workbenchService.runBacktest).toHaveBeenCalledExactlyOnceWith(request);
    await expect(handlers.runWorkbenchBacktest(localEvent, {
      ...request,
      market: 'ETH-PERP',
    })).rejects.toThrow('INVALID_REQUEST');

    const secret = 'raw-universe-secret';
    dependencies.workbenchService.runBacktest.mockResolvedValueOnce({
      ...backtestSummary,
      rawUniverse: { markets: ['ETH-PERP'], providerError: secret },
    } as never);
    const error = await handlers.runWorkbenchBacktest(localEvent, request).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'WORKBENCH_BACKTEST_FAILED' });
    expect(String(error)).not.toContain(secret);
  });

  it('projects trace evidence to a semantic allowlist before it reaches the renderer', async () => {
    const dependencies = createDependencies();
    dependencies.workbenchService.getTrace.mockResolvedValueOnce(TraceDetailSchema.parse({
      traceId: 'child:eth',
      parentTraceId: 'parent:interval:universe:bundled%3Aeth-listed',
      market: 'ETH-PERP',
      outcome: 'rejected',
      events: [
        {
          sequence: 1,
          type: 'condition.evaluated',
          occurredAt: '2026-09-05T00:00:00.000Z',
          nodeId: 'eth-entry',
          summary: 'provider-secret-error',
          details: {
            result: 'unknown',
            reason: 'data.stale',
            inputs: [{ ref: 'market.price', field: 'mark', rawPayload: 'provider-secret-payload' }],
            universe: { authorization: 'provider-secret-token' },
          },
        },
        {
          sequence: 2,
          type: 'risk.rejected',
          occurredAt: '2026-09-05T00:00:01.000Z',
          nodeId: 'open-long',
          summary: 'raw provider error',
          details: { violatedRuleIds: ['max-total-exposure-usd'], error: 'provider-secret-error' },
        },
      ],
    }));
    const handlers = createIpcHandlers(dependencies);

    const trace = await handlers.getWorkbenchTrace(localEvent, { botId, traceId: 'child:eth' });

    expect(trace.events).toEqual([
      {
        sequence: 1,
        type: 'condition.evaluated',
        occurredAt: '2026-09-05T00:00:00.000Z',
        nodeId: 'eth-entry',
        summary: 'condition evaluated',
        details: { result: 'unknown', reason: 'data.stale', inputs: [{ ref: 'market.price', field: 'mark' }] },
      },
      {
        sequence: 2,
        type: 'risk.rejected',
        occurredAt: '2026-09-05T00:00:01.000Z',
        nodeId: 'open-long',
        summary: 'risk rejected',
        details: { violatedRuleIds: ['max-total-exposure-usd'] },
      },
    ]);
    expect(JSON.stringify(trace)).not.toContain('provider-secret');
  });

  it('validates Paper deployment requests before service access', async () => {
    const dependencies = createDependencies();
    const handlers = createIpcHandlers(dependencies);

    await expect(handlers.startPaperDeployment(localEvent, { botId, strategyVersion: 1, riskLimits: { ...riskLimits, maxOrderUsd: '0' } }))
      .rejects.toThrow('INVALID_REQUEST');
    await expect(handlers.getPaperDeployment(localEvent, { deploymentId: 'not-a-uuid' })).rejects.toThrow('INVALID_REQUEST');
    await expect(handlers.pausePaperDeployment(localEvent, {})).rejects.toThrow('INVALID_REQUEST');
    await expect(handlers.stopPaperDeployment(fakeRemoteEvent, { deploymentId })).rejects.toThrow('IPC_SENDER_NOT_ALLOWED');
    expect(dependencies.deploymentService.startPaper).not.toHaveBeenCalled();
    expect(dependencies.deploymentService.getPaperDeployment).not.toHaveBeenCalled();
  });

  it('starts, reads, pauses, and stops Paper deployments through renderer-safe views', async () => {
    const dependencies = createDependencies();
    const handlers = createIpcHandlers(dependencies);
    const start = { botId, strategyVersion: 1, riskLimits };

    await expect(handlers.startPaperDeployment(localEvent, start)).resolves.toEqual(paperView);
    await expect(handlers.getPaperDeployment(localEvent, { deploymentId })).resolves.toEqual(paperView);
    await expect(handlers.pausePaperDeployment(localEvent, { deploymentId })).resolves.toEqual(paperView);
    await expect(handlers.stopPaperDeployment(localEvent, { deploymentId })).resolves.toEqual(paperView);

    expect(dependencies.deploymentService.startPaper).toHaveBeenCalledWith(start, expect.any(AbortSignal));
    expect(dependencies.deploymentService.getPaperDeployment).toHaveBeenCalledTimes(4);
    expect(dependencies.deploymentService.pause).toHaveBeenCalledWith(deploymentId);
    expect(dependencies.deploymentService.stop).toHaveBeenCalledWith(deploymentId);
    expect(dependencies.runtime.startDeployment).toHaveBeenCalledWith(deploymentId);
    expect(dependencies.runtime.pauseDeployment).toHaveBeenCalledWith(deploymentId);
    expect(dependencies.runtime.stopDeployment).toHaveBeenCalledWith(deploymentId);
  });

  it('stops a newly persisted Paper deployment when the runtime worker is unavailable', async () => {
    const dependencies = createDependencies();
    dependencies.runtime.startDeployment.mockImplementationOnce(() => { throw new Error('worker secret'); });
    const handlers = createIpcHandlers(dependencies);

    const error = await handlers.startPaperDeployment(localEvent, { botId, strategyVersion: 1, riskLimits })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'PAPER_DEPLOYMENT_START_FAILED' });
    expect(String(error)).not.toContain('worker secret');
    expect(dependencies.deploymentService.stop).toHaveBeenCalledWith(deploymentId);
  });

  it('validates and gates Live preflight, start, read, and Stop through typed IPC', async () => {
    const dependencies = createDependencies();
    const handlers = createIpcHandlers(dependencies);
    const prepare = { botId, strategyVersion: 1, riskLimits, network: 'testnet' as const };
    const start = { ...prepare, preflightId: livePreflight.id, confirmationBotName: 'BTC Live' };

    await expect(handlers.prepareLiveDeployment(localEvent, prepare)).resolves.toEqual(livePreflight);
    await expect(handlers.startLiveDeployment(localEvent, start)).resolves.toEqual(liveDeployment);
    await expect(handlers.getLiveDeployment(localEvent, { deploymentId })).resolves.toEqual(liveDeployment);
    await expect(handlers.stopLiveDeployment(localEvent, { deploymentId })).resolves.toEqual(liveDeployment);
    await expect(handlers.getActiveDeployment(localEvent, { botId })).resolves.toEqual(liveDeployment);
    await expect(handlers.startLiveDeployment(localEvent, { ...start, network: 'mainnet' })).rejects.toThrow('INVALID_REQUEST');

    expect(dependencies.deploymentService.prepareLive).toHaveBeenCalledWith(prepare, expect.any(AbortSignal));
    expect(dependencies.deploymentService.startLive).toHaveBeenCalledWith(start);
    expect(dependencies.runtime.startDeployment).toHaveBeenCalledWith(deploymentId);
    expect(dependencies.runtime.stopDeployment).toHaveBeenCalledWith(deploymentId);
  });

  it('rejects malformed configuration before repository access without exposing its secret', async () => {
    const dependencies = createDependencies();
    const handlers = createIpcHandlers(dependencies);
    const secret = 'must-not-be-in-the-error';

    const error = await handlers.patchLocalSettings(localEvent, {
      ...settingsPatch,
      profile: { ...validConfig.profile, name: '' },
      llm: { ...settingsPatch.llm, apiKey: secret },
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('INVALID_REQUEST');
    expect(String(error)).not.toContain(secret);
    expect(dependencies.configRepository.patchSettings).not.toHaveBeenCalled();
  });

  it('resolves an omitted key inside Main before invoking the connection tester', async () => {
    const dependencies = createDependencies();
    const handlers = createIpcHandlers(dependencies);

    await expect(handlers.testLlmConnection(localEvent, settingsPatch)).resolves.toEqual({
      ok: true,
      model: 'provider/model',
    });
    expect(dependencies.configRepository.resolveSettingsPatch).toHaveBeenCalledWith(settingsPatch);
    expect(dependencies.testLlmConnection).toHaveBeenCalledWith(validConfig.llm);

    await expect(handlers.testLlmConnection(localEvent, {
      ...settingsPatch,
      llm: { ...settingsPatch.llm, apiKey: REDACTED_SECRET },
    })).rejects.toThrow('INVALID_REQUEST');
    await expect(handlers.testLlmConnection(localEvent, { llm: {} })).rejects.toThrow('INVALID_REQUEST');
    expect(dependencies.testLlmConnection).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['provider', { provider: 'anthropic-compatible' as const, baseUrl: validConfig.llm.baseUrl }],
    ['base URL', { provider: validConfig.llm.provider, baseUrl: 'https://other.example/v1' }],
  ])('rejects a changed credential %s before testing or writing with fixed safe results', async (_label, scope) => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'catbots-ipc-scope-'));
    try {
      const repository = new ConfigRepository(dataDirectory);
      const stored = {
        ...validConfig,
        exchanges: {
          hyperliquid: {
            network: 'testnet' as const,
            accountAddress: '0x0123456789abcdef0123456789abcdef01234567',
            agentPrivateKey: 'agent-secret-that-must-not-leak',
          },
        },
      };
      await repository.save(stored);
      const before = await readFile(join(dataDirectory, 'local.env.yaml'), 'utf8');
      const dependencies = { ...createDependencies(), configRepository: repository };
      const handlers = createIpcHandlers(dependencies);
      const patch = {
        profile: { name: 'Must not persist', telemetry: true },
        llm: { ...scope, model: 'replacement-model' },
      };

      await expect(handlers.testLlmConnection(localEvent, patch)).resolves.toEqual({
        ok: false,
        code: 'LLM_CREDENTIAL_REPLACEMENT_REQUIRED',
        message: 'Enter a new API key for this provider location.',
      });
      const saveError = await handlers.patchLocalSettings(localEvent, patch).catch((reason: unknown) => reason);

      expect(dependencies.testLlmConnection).not.toHaveBeenCalled();
      expect(saveError).toMatchObject({ code: 'LLM_CREDENTIAL_REPLACEMENT_REQUIRED' });
      expect(String(saveError)).not.toContain(scope.baseUrl);
      await expect(readFile(join(dataDirectory, 'local.env.yaml'), 'utf8')).resolves.toBe(before);
      await expect(repository.load()).resolves.toEqual(stored);
    } finally {
      await rm(dataDirectory, { force: true, recursive: true });
    }
  });

  it('tests and saves a changed credential scope when the patch supplies a new key', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'catbots-ipc-replacement-'));
    try {
      const repository = new ConfigRepository(dataDirectory);
      const stored = {
        ...validConfig,
        exchanges: {
          hyperliquid: {
            network: 'testnet' as const,
            accountAddress: '0x0123456789abcdef0123456789abcdef01234567',
            agentPrivateKey: 'agent-secret-that-must-not-leak',
          },
        },
      };
      await repository.save(stored);
      const dependencies = { ...createDependencies(), configRepository: repository };
      const handlers = createIpcHandlers(dependencies);
      const patch = {
        profile: { name: 'Replacement scope', telemetry: true },
        llm: {
          provider: 'anthropic-compatible' as const,
          baseUrl: 'https://replacement.example/v2',
          apiKey: 'replacement-llm-secret',
          model: 'replacement-model',
        },
      };

      await expect(handlers.testLlmConnection(localEvent, patch)).resolves.toEqual({
        ok: true,
        model: 'provider/model',
      });
      expect(dependencies.testLlmConnection).toHaveBeenCalledWith(patch.llm);
      await expect(handlers.patchLocalSettings(localEvent, patch)).resolves.toMatchObject({
        llm: { ...patch.llm, apiKey: REDACTED_SECRET },
        exchanges: { hyperliquid: { agentPrivateKey: REDACTED_SECRET } },
      });
      await expect(repository.load()).resolves.toEqual({
        ...patch,
        exchanges: stored.exchanges,
      });
    } finally {
      await rm(dataDirectory, { force: true, recursive: true });
    }
  });

  it('exposes safe typed app and runtime handler behavior', async () => {
    const dependencies = createDependencies();
    const handlers = createIpcHandlers(dependencies);

    await expect(handlers.getVersion(localEvent)).resolves.toBe('0.1.0');
    await expect(handlers.showMainWindow(localEvent)).resolves.toBeUndefined();
    await expect(handlers.quitApplication(localEvent)).resolves.toBeUndefined();
    await expect(handlers.getRuntimeStatus(localEvent)).resolves.toEqual({ state: 'stopped', activeBots: 0 });
    await expect(handlers.getDatabaseState(localEvent)).resolves.toEqual({ status: 'ready' });

    expect(dependencies.app.showMainWindow).toHaveBeenCalledOnce();
    expect(dependencies.app.quitApplication).toHaveBeenCalledOnce();
    expect(dependencies.runtime.getStatus).toHaveBeenCalledOnce();
  });

  it.each([
    ['getVersion', 'APP_VERSION_FAILED'],
    ['showMainWindow', 'APP_SHOW_MAIN_WINDOW_FAILED'],
    ['quitApplication', 'APP_QUIT_APPLICATION_FAILED'],
    ['getRuntimeStatus', 'RUNTIME_STATUS_FAILED'],
  ] as const)('redacts dependency failures from %s', async (handlerName, code) => {
    const secret = `sentinel-secret-${handlerName}`;
    const dependencies = createDependencies();
    const handlers = createIpcHandlers(dependencies);

    if (handlerName === 'getVersion') dependencies.app.getVersion.mockImplementationOnce(() => { throw new Error(secret); });
    if (handlerName === 'showMainWindow') dependencies.app.showMainWindow.mockImplementationOnce(() => { throw new Error(secret); });
    if (handlerName === 'quitApplication') dependencies.app.quitApplication.mockImplementationOnce(() => { throw new Error(secret); });
    if (handlerName === 'getRuntimeStatus') dependencies.runtime.getStatus.mockImplementationOnce(() => { throw new Error(secret); });

    const request = handlerName === 'getVersion'
      ? handlers.getVersion(localEvent)
      : handlerName === 'showMainWindow'
        ? handlers.showMainWindow(localEvent)
        : handlerName === 'quitApplication'
          ? handlers.quitApplication(localEvent)
          : handlers.getRuntimeStatus(localEvent);
    const error = await request.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: unknown }).code).toBe(code);
    expect(String(error)).not.toContain(secret);
  });

  it('returns the fixed no-network M0 connection-test result without an injected tester', async () => {
    const dependencies = createDependencies();
    const { testLlmConnection: _testLlmConnection, ...withoutTester } = dependencies;
    const handlers = createIpcHandlers(withoutTester);

    await expect(handlers.testLlmConnection(localEvent, settingsPatch)).resolves.toEqual({
      ok: false,
      code: 'LLM_CONNECTION_TEST_UNAVAILABLE',
      message: 'LLM connection testing is unavailable in M0.',
    });
    expect(dependencies.configRepository.getRedacted).not.toHaveBeenCalled();
    expect(dependencies.configRepository.patchSettings).not.toHaveBeenCalled();
    expect(dependencies.botRepository.list).not.toHaveBeenCalled();
  });

  it('registers only the named typed IPC channels', () => {
    const remove = registerIpcHandlers(createDependencies());

    expect(electronBridge.handle.mock.calls.map(([channel]) => channel)).toEqual([
      'connections:command',
      'nodes:command',
      'providers:command',
      'app:get-version',
      'app:get-capabilities',
      'app:show-main-window',
      'app:quit-application',
      'config:get-bootstrap-state',
      'config:patch-settings',
      'config:test-llm',
      'bots:remove',
      'bots:list',
      'bots:create-draft',
      'workbench:get',
      'workbench:stop-agent',
      'workbench:send-message',
      'workbench:run-backtest',
      'workbench:configure-node',
      'workbench:approve-revision',
      'workbench:get-trace',
      'deployments:start-paper',
      'deployments:get-paper',
      'deployments:pause-paper',
      'deployments:stop-paper',
      'deployments:prepare-live',
      'deployments:start-live',
      'deployments:get-live',
      'deployments:stop-live',
      'deployments:get-active',
      'runtime:get-status',
      'runtime:get-database-state',
    ]);

    remove();
    expect(electronBridge.removeHandler).toHaveBeenCalledTimes(31);
  });

  it('forwards only validated runtime status to live trusted renderer targets and unsubscribes on cleanup', () => {
    let pushStatus: ((status: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const dependencies = createDependencies();
    dependencies.runtime.subscribeStatus.mockImplementation((listener: (status: RuntimeStatus) => void) => {
      pushStatus = listener as (status: unknown) => void;
      return unsubscribe;
    });
    const trustedTarget = {
      getURL: vi.fn(() => 'catbots://app/index.html'),
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    };
    const destroyedTarget = {
      getURL: vi.fn(() => 'catbots://app/index.html'),
      isDestroyed: vi.fn(() => true),
      send: vi.fn(),
    };
    const untrustedTarget = {
      getURL: vi.fn(() => 'https://attacker.example/'),
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    };
    electronBridge.getAllWebContents.mockReturnValue([trustedTarget, destroyedTarget, untrustedTarget]);

    const remove = registerIpcHandlers(dependencies);
    pushStatus?.({ state: 'ready', activeBots: 0 });
    pushStatus?.({ state: 'ready', activeBots: -1 });

    expect(trustedTarget.send).toHaveBeenCalledExactlyOnceWith('runtime:status', { state: 'ready', activeBots: 0 });
    expect(destroyedTarget.send).not.toHaveBeenCalled();
    expect(untrustedTarget.send).not.toHaveBeenCalled();

    remove();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('forwards only validated workbench activity to trusted renderers', () => {
    let pushActivity: ((activity: unknown) => void) | undefined;
    const dependencies = createDependencies();
    dependencies.workbenchService.subscribeActivity.mockImplementation((listener: (activity: AgentToolActivity) => void) => {
      pushActivity = listener as (activity: unknown) => void;
      return () => undefined;
    });
    const trustedTarget = {
      getURL: vi.fn(() => 'catbots://app/index.html'),
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    };
    electronBridge.getAllWebContents.mockReturnValue([trustedTarget]);
    const remove = registerIpcHandlers(dependencies);
    const activity = {
      botId: '018f3f75-89ab-7def-8123-456789abcdef',
      requestId: '018f3f75-89ab-7def-8123-456789abcdee',
      phase: 'thinking',
      message: 'Designing the strategy.',
    };

    pushActivity?.(activity);
    pushActivity?.({ ...activity, phase: 'unsafe-phase' });

    expect(trustedTarget.send).toHaveBeenCalledExactlyOnceWith('workbench:activity', activity);
    remove();
  });

  it('replaces only its owned registration and makes stale disposers harmless', () => {
    const firstDependencies = createDependencies();
    const secondDependencies = createDependencies();

    const removeFirst = registerIpcHandlers(firstDependencies);
    const removeSecond = registerIpcHandlers(secondDependencies);
    removeFirst();

    expect(firstDependencies.runtime.subscribeStatus).toHaveBeenCalledOnce();
    expect(electronBridge.removeHandler).toHaveBeenCalledTimes(31);
    removeSecond();
    expect(electronBridge.removeHandler).toHaveBeenCalledTimes(62);
  });

  it('restores the previous owned registration after a replacement failure', () => {
    const firstDependencies = createDependencies();
    const secondDependencies = createDependencies();
    const thirdDependencies = createDependencies();
    registerIpcHandlers(firstDependencies);
    let configSaveAttempts = 0;
    electronBridge.handle.mockImplementation((channel: string) => {
      if (channel === 'config:patch-settings' && configSaveAttempts++ === 0) {
        throw new Error('replacement registration failed');
      }
    });

    expect(() => registerIpcHandlers(secondDependencies)).toThrow('replacement registration failed');
    expect(firstDependencies.runtime.subscribeStatus).toHaveBeenCalledTimes(2);

    const removeThird = registerIpcHandlers(thirdDependencies);
    removeThird();
  });

  it('removes owned handlers even when the runtime unsubscriber throws, then permits replacement', () => {
    const firstDependencies = createDependencies();
    const secondDependencies = createDependencies();
    firstDependencies.runtime.subscribeStatus.mockReturnValueOnce(() => {
      throw new Error('runtime unsubscribe failed');
    });
    const removeFirst = registerIpcHandlers(firstDependencies);

    expect(() => removeFirst()).toThrow('runtime unsubscribe failed');
    expect(electronBridge.removeHandler).toHaveBeenCalledTimes(31);

    const removeSecond = registerIpcHandlers(secondDependencies);
    removeSecond();
    expect(electronBridge.removeHandler).toHaveBeenCalledTimes(62);
  });

  it('replaces a registration whose runtime unsubscriber throws without leaving stale handlers', () => {
    const firstDependencies = createDependencies();
    firstDependencies.runtime.subscribeStatus.mockReturnValueOnce(() => {
      throw new Error('runtime unsubscribe failed');
    });
    registerIpcHandlers(firstDependencies);

    const removeReplacement = registerIpcHandlers(createDependencies());
    expect(electronBridge.removeHandler).toHaveBeenCalledTimes(31);
    removeReplacement();
    expect(electronBridge.removeHandler).toHaveBeenCalledTimes(62);
  });

  it('rolls back handlers after an invalid runtime unsubscribe return and permits a later registration', () => {
    const invalidDependencies = createDependencies();
    invalidDependencies.runtime.subscribeStatus.mockReturnValueOnce({} as never);

    expect(() => registerIpcHandlers(invalidDependencies)).toThrow('Invalid runtime subscription');
    expect(electronBridge.removeHandler).toHaveBeenCalledTimes(31);

    const remove = registerIpcHandlers(createDependencies());
    remove();
    expect(electronBridge.removeHandler).toHaveBeenCalledTimes(62);
  });

  it('rolls back only partially registered owned channels when an external handler blocks registration', () => {
    electronBridge.handle.mockImplementation((channel: string) => {
      if (channel === 'config:patch-settings') throw new Error('external handler already registered');
    });

    expect(() => registerIpcHandlers(createDependencies())).toThrow('external handler already registered');
    expect(electronBridge.removeHandler.mock.calls.map(([channel]) => channel)).toEqual([
      'config:get-bootstrap-state',
      'app:quit-application',
      'app:show-main-window',
      'app:get-capabilities',
      'app:get-version',
      'providers:command',
      'nodes:command',
      'connections:command',
    ]);
  });
});

describe('preload bridge', () => {
  it('exposes a deeply frozen named API without generic Electron primitives', async () => {
    await import('../src/preload/index');

    const [, api] = electronBridge.exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>];
    expect(electronBridge.exposeInMainWorld).toHaveBeenCalledWith('catbots', expect.any(Object));
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.app)).toBe(true);
    expect(Object.isFrozen(api.config)).toBe(true);
    expect(Object.isFrozen(api.bots)).toBe(true);
    expect(Object.isFrozen(api.workbench)).toBe(true);
    expect(Object.isFrozen(api.deployments)).toBe(true);
    expect(Object.isFrozen(api.runtime)).toBe(true);
    expect(Object.isFrozen((api.app as { getVersion: unknown }).getVersion)).toBe(true);
    expect(Object.keys(api)).toEqual(['app', 'connections', 'nodes', 'providers', 'config', 'bots', 'workbench', 'deployments', 'runtime']);
    expect(JSON.stringify(api)).not.toContain('ipcRenderer');
    expect(JSON.stringify(api)).not.toContain('process');
    electronBridge.invoke.mockResolvedValueOnce({ status: 'ready' });
    await expect((api.runtime as { getDatabaseState(): Promise<unknown> }).getDatabaseState()).resolves.toEqual({ status: 'ready' });
    expect(electronBridge.invoke).toHaveBeenCalledWith('runtime:get-database-state');
  });

  it('does not call a listener after it unsubscribes before the initial status resolves', async () => {
    await import('../src/preload/index');
    const [, api] = electronBridge.exposeInMainWorld.mock.calls[0] as [string, {
      runtime: { subscribeStatus(listener: (status: { state: string; activeBots: number }) => void): () => void };
    }];
    let resolveStatus: ((status: { state: string; activeBots: number }) => void) | undefined;
    electronBridge.invoke.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStatus = resolve;
    }));
    const listener = vi.fn();

    const unsubscribe = api.runtime.subscribeStatus(listener);
    unsubscribe();
    resolveStatus?.({ state: 'stopped', activeBots: 0 });
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
  });
});
