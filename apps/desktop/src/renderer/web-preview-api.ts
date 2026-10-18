import { toRendererSafeTraceDetails } from '../shared/trace-projection';
import {
  CreateDraftBotInputSchema,
  ApproveStrategyRevisionInputSchema,
  GetTraceInputSchema,
  GetActiveDeploymentInputSchema,
  GetWorkbenchInputSchema,
  LocalSettingsPatchSchema,
  GetDeploymentInputSchema,
  PauseDeploymentInputSchema,
  PrepareLiveInputSchema,
  StartLiveInputSchema,
  REDACTED_SECRET,
  RunWorkbenchBacktestInputSchema,
  SendWorkbenchMessageInputSchema,
  StartPaperInputSchema,
  StopDeploymentInputSchema,
  type AgentToolActivity,
  type BacktestMarketUniverse,
  type BacktestSummary,
  type BotSummary,
  type CatbotsDesktopApi,
  type ChatMessage,
  type RedactedLocalConfig,
  type PaperDeploymentView,
  type Deployment,
  type LivePreflightView,
  type StrategyRevision,
  type TraceDetail,
  type WorkbenchState,
} from '@catbots/contracts';
import { strategyLabCapabilities } from '../shared/product-capabilities';
import type { AuditEvent, JsonValue, StrategyDocument } from '@catbots/strategy-runtime';
import { replayBacktest } from '@catbots/strategy-runtime/backtest-replay';
import {
  buildBundledSampleInputs,
  bundledSampleDatasetCatalog,
} from '../shared/bundled-sample-fixture';

type PreviewWorkbench = {
  revisions: StrategyRevision[];
  messages: ChatMessage[];
  backtests: BacktestSummary[];
  traces: Map<string, TraceDetail>;
};

export function createWebPreviewApi(): CatbotsDesktopApi {
  let config: RedactedLocalConfig | undefined;
  const bots: BotSummary[] = [];
  const workbenches = new Map<string, PreviewWorkbench>();
  const activityListeners = new Set<(activity: AgentToolActivity) => void>();
  const deployments = new Map<string, PaperDeploymentView>();
  const liveDeployments = new Map<string, Deployment>();
  const livePreflights = new Map<string, LivePreflightView>();

  const getWorkbench = (botId: string, version?: number): WorkbenchState => {
    const bot = bots.find(({ id }) => id === botId);
    const workbench = workbenches.get(botId);
    if (bot === undefined || workbench === undefined) throw new Error('Preview bot not found');
    const revision = version === undefined
      ? workbench.revisions.at(-1) ?? null
      : workbench.revisions.find((candidate) => candidate.version === version) ?? null;
    if (version !== undefined && revision === null) throw new Error('Preview revision not found');
    return structuredClone({
      bot,
      currentRevision: revision,
      revisions: [...workbench.revisions].reverse().map(({ version: itemVersion, status, createdAt, approvedAt }) => ({ version: itemVersion, status, createdAt, approvedAt })),
      messages: workbench.messages,
      backtests: workbench.backtests,
    });
  };

  const emit = (activity: AgentToolActivity) => {
    for (const listener of activityListeners) listener(activity);
  };

  return {
    app: {
      getVersion: async () => 'web-preview',
      getCapabilities: async () => strategyLabCapabilities,
      showMainWindow: async () => undefined,
      quitApplication: async () => undefined,
    },
    config: {
      getBootstrapState: async () => config === undefined
        ? { state: 'first-launch' }
        : { state: 'ready', config },
      patchSettings: async (input) => {
        const parsed = LocalSettingsPatchSchema.parse(input);
        config = {
          profile: parsed.profile,
          llm: {
            provider: parsed.llm.provider,
            baseUrl: parsed.llm.baseUrl,
            model: parsed.llm.model,
            apiKey: REDACTED_SECRET,
          },
          exchanges: parsed.exchanges?.hyperliquid == null ? {} : {
            hyperliquid: {
              network: 'testnet',
              accountAddress: parsed.exchanges.hyperliquid.accountAddress,
              agentPrivateKey: REDACTED_SECRET,
            },
          },
        };
        return config;
      },
      testLlmConnection: async (input) => {
        const parsed = LocalSettingsPatchSchema.parse(input);
        return { ok: true, model: parsed.llm.model };
      },
    },
    bots: {
      list: async () => [...bots],
      createDraft: async (input) => {
        const parsed = CreateDraftBotInputSchema.parse(input);
        const timestamp = new Date().toISOString();
        const draft: BotSummary = {
          ...parsed,
          id: crypto.randomUUID(),
          status: 'draft',
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        bots.push(draft);
        workbenches.set(draft.id, {
          revisions: [],
          messages: [{ id: crypto.randomUUID(), botId: draft.id, role: 'assistant', content: 'Tell me your trigger, conditions, and action. I will build and validate the visual flow.', createdAt: timestamp }],
          backtests: [],
          traces: new Map(),
        });
        return draft;
      },
    },
    workbench: {
      get: async (input) => {
        const request = GetWorkbenchInputSchema.parse(input);
        return getWorkbench(request.botId, request.version);
      },
      stopAgent: async () => undefined,
      sendMessage: async (input) => {
        const request = SendWorkbenchMessageInputSchema.parse(input);
        const workbench = workbenches.get(request.botId);
        if (workbench === undefined) throw new Error('Preview bot not found');
        const requestId = crypto.randomUUID();
        emit({ botId: request.botId, requestId, phase: 'thinking', message: 'Designing the strategy.' });
        const timestamp = new Date().toISOString();
        workbench.messages.push({ id: crypto.randomUUID(), botId: request.botId, role: 'user', content: request.message, createdAt: timestamp });
        const version = workbench.revisions.length + 1;
        workbench.revisions.push(previewRevision(request.botId, version, timestamp));
        workbench.messages.push({
          id: crypto.randomUUID(),
          botId: request.botId,
          role: 'assistant',
          content: `Draft v${version} is valid. It evaluates the dynamic Hyperliquid perpetual universe hourly, with an ETH-PERP symbol guard. When RSI 14 is below 20 it opens an ETH long; when RSI 14 is above 80 it closes that long. It does not open short positions. Run the sample Backtest to inspect performance and every execution trace.`,
          createdAt: timestamp,
        });
        emit({ botId: request.botId, requestId, phase: 'completed', message: 'Agent response completed.' });
        return getWorkbench(request.botId);
      },
      runBacktest: async (input) => {
        const request = RunWorkbenchBacktestInputSchema.parse(input);
        const workbench = workbenches.get(request.botId);
        if (workbench === undefined || !workbench.revisions.some(({ version }) => version === request.revisionVersion)) throw new Error('Preview revision not found');
        const requestId = crypto.randomUUID();
        emit({ botId: request.botId, requestId, phase: 'backtest_progress', tool: 'backtest_strategy', message: 'Backtest is running.', progress: 0.5 });
        const result = previewBacktest(
          request.botId,
          request.revisionVersion,
          request.marketUniverse,
          request.assumptions,
        );
        workbench.backtests.unshift(result.summary);
        for (const trace of result.traces) workbench.traces.set(trace.traceId, trace);
        emit({ botId: request.botId, requestId, phase: 'completed', tool: 'backtest_strategy', message: 'Backtest completed.', progress: 1 });
        return structuredClone(result.summary);
      },
      approveRevision: async (input) => {
        const request = ApproveStrategyRevisionInputSchema.parse(input);
        const workbench = workbenches.get(request.botId);
        const index = workbench?.revisions.findIndex(({ version }) => version === request.version) ?? -1;
        if (workbench === undefined || index < 0) throw new Error('Preview revision not found');
        const approved = { ...workbench.revisions[index]!, status: 'approved' as const, approvedAt: new Date().toISOString() };
        workbench.revisions[index] = approved;
        return structuredClone(approved);
      },
      getTrace: async (input) => {
        const request = GetTraceInputSchema.parse(input);
        const trace = workbenches.get(request.botId)?.traces.get(request.traceId);
        if (trace === undefined) throw new Error('Preview trace not found');
        return structuredClone(trace);
      },
      subscribeActivity: (listener) => {
        activityListeners.add(listener);
        return () => activityListeners.delete(listener);
      },
    },
    deployments: {
      startPaper: async (input) => {
        const request = StartPaperInputSchema.parse(input);
        const workbench = workbenches.get(request.botId);
        const revision = workbench?.revisions.find(({ version }) => version === request.strategyVersion);
        const bot = bots.find(({ id }) => id === request.botId);
        if (revision?.status !== 'approved' || bot === undefined) throw new Error('Preview strategy must be approved');
        const timestamp = new Date().toISOString();
        const id = crypto.randomUUID();
        const view: PaperDeploymentView = {
          deployment: {
            id, botId: request.botId, strategyId: revision.strategyId, strategyVersion: request.strategyVersion,
            recordVersion: 2, dex: bot.dex, mode: 'paper', executionVenue: 'paper', marketAccess: { mode: 'all_active_perpetuals' }, riskLimits: request.riskLimits,
            status: 'running', createdAt: timestamp, updatedAt: timestamp,
          },
          state: { equityUsd: '10000', positions: [], orders: [] },
          auditEvents: [],
        };
        deployments.set(id, view);
        return structuredClone(view);
      },
      getPaper: async (input) => {
        const request = GetDeploymentInputSchema.parse(input);
        const view = deployments.get(request.deploymentId);
        if (view === undefined) throw new Error('Preview deployment not found');
        return structuredClone(view);
      },
      pausePaper: async (input) => {
        const request = PauseDeploymentInputSchema.parse(input);
        return updatePreviewDeployment(deployments, request.deploymentId, 'paused');
      },
      stopPaper: async (input) => {
        const request = StopDeploymentInputSchema.parse(input);
        return updatePreviewDeployment(deployments, request.deploymentId, 'stopped');
      },
      prepareLive: async (input) => {
        const request = PrepareLiveInputSchema.parse(input);
        const connected = config?.exchanges.hyperliquid !== undefined;
        const timestamp = new Date().toISOString();
        const makeCheck = (id: LivePreflightView['checks'][number]['id'], label: string, ok: boolean, message: string, repairTarget?: LivePreflightView['checks'][number]['repairTarget']) => ({
          id, label, ok, message, ...(!ok && repairTarget !== undefined ? { repairTarget } : {}),
        });
        const checks: LivePreflightView['checks'] = [
          makeCheck('connection', 'Connection', connected, connected ? 'Simulated testnet connection is ready.' : 'Configure Hyperliquid testnet first.', 'settings'),
          makeCheck('network', 'Network', true, 'Hyperliquid testnet selected.'),
          makeCheck('agent-wallet', 'Agent wallet', connected, connected ? 'Simulated Agent wallet is approved.' : 'Use an approved Agent/API Wallet.', 'settings'),
          makeCheck('account-balance', 'Account balance', connected, connected ? 'Simulated balance is available.' : 'Connect a testnet account.', 'settings'),
          makeCheck('risk-limits', 'Risk limits', true, 'Risk limits are valid.'),
          makeCheck('strategy', 'Strategy', true, 'Strategy revision is approved.'),
          makeCheck('backtest', 'Backtest', true, 'A completed Backtest is available.'),
          makeCheck('data-freshness', 'Data freshness', true, 'Preview data is fresh.'),
          makeCheck('audit-storage', 'Audit storage', true, 'Preview audit storage is writable.'),
          makeCheck('runtime', 'Runtime', true, 'Preview runtime is ready.'),
          makeCheck('reconciliation', 'Reconciliation', true, 'Reconciliation is healthy.'),
        ];
        const view: LivePreflightView = {
          id: crypto.randomUUID(), botId: request.botId, strategyVersion: request.strategyVersion,
          network: 'testnet', maskedAccount: config?.exchanges.hyperliquid?.accountAddress ?? 'Not configured',
          checkedAt: timestamp, ready: checks.every(({ ok }) => ok), checks,
        };
        livePreflights.set(view.id, view);
        return structuredClone(view);
      },
      startLive: async (input) => {
        const request = StartLiveInputSchema.parse(input);
        const preflight = livePreflights.get(request.preflightId);
        const bot = bots.find(({ id }) => id === request.botId);
        const revision = workbenches.get(request.botId)?.revisions.find(({ version }) => version === request.strategyVersion);
        if (preflight?.ready !== true || bot === undefined || revision?.status !== 'approved' || request.confirmationBotName !== bot.name) throw new Error('Preview Live gate blocked');
        const timestamp = new Date().toISOString();
        const deployment: Deployment = {
          id: crypto.randomUUID(), botId: bot.id, strategyId: revision.strategyId, strategyVersion: revision.version,
          recordVersion: 2, dex: bot.dex, mode: 'live', executionVenue: 'hyperliquid', network: 'testnet', maskedAccount: preflight.maskedAccount,
          marketAccess: { mode: 'all_active_perpetuals' }, riskLimits: request.riskLimits, status: 'running', createdAt: timestamp, updatedAt: timestamp,
        };
        liveDeployments.set(deployment.id, deployment);
        return structuredClone(deployment);
      },
      getLive: async (input) => {
        const request = GetDeploymentInputSchema.parse(input);
        const deployment = liveDeployments.get(request.deploymentId);
        if (deployment === undefined) throw new Error('Preview Live deployment not found');
        return structuredClone(deployment);
      },
      stopLive: async (input) => {
        const request = StopDeploymentInputSchema.parse(input);
        const deployment = liveDeployments.get(request.deploymentId);
        if (deployment === undefined || deployment.mode !== 'live') throw new Error('Preview Live deployment not found');
        const stopped: Deployment = { ...deployment, status: 'stopped', updatedAt: new Date().toISOString() };
        liveDeployments.set(stopped.id, stopped);
        return structuredClone(stopped);
      },
      getActive: async (input) => {
        const request = GetActiveDeploymentInputSchema.parse(input);
        const candidates = [
          ...[...deployments.values()].map(({ deployment }) => deployment),
          ...liveDeployments.values(),
        ].filter((deployment) => deployment.botId === request.botId && deployment.status !== 'stopped');
        return structuredClone(candidates.at(-1) ?? null);
      },
    },
    runtime: {
      getStatus: async () => ({ state: 'stopped', activeBots: 0 }),
      getDatabaseState: async () => ({ status: 'ready' }),
      subscribeStatus: () => () => undefined,
    },
  };
}

function updatePreviewDeployment(
  deployments: Map<string, PaperDeploymentView>,
  deploymentId: string,
  status: 'paused' | 'stopped',
): PaperDeploymentView {
  const current = deployments.get(deploymentId);
  if (current === undefined) throw new Error('Preview deployment not found');
  const next: PaperDeploymentView = {
    ...current,
    deployment: { ...current.deployment, status, updatedAt: new Date().toISOString() },
  };
  deployments.set(deploymentId, next);
  return structuredClone(next);
}

function previewRevision(botId: string, version: number, createdAt: string): StrategyRevision {
  return {
    botId,
    strategyId: 'preview-eth-rsi',
    version,
    name: 'ETH RSI',
    schemaVersion: '2.0',
    marketScope: { type: 'dex_universe' },
    status: 'draft',
    createdAt,
    approvedAt: null,
    nodes: [
      { id: 'entry-hourly', kind: 'trigger', type: 'trigger.interval', version: 1, title: 'Interval', summary: 'Every 1h' },
      { id: 'entry-eth', kind: 'condition', type: 'predicate.compare', version: 1, title: 'Compare', summary: 'Market symbol = ETH-PERP' },
      { id: 'rsi-low', kind: 'condition', type: 'predicate.compare', version: 1, title: 'Compare', summary: 'RSI 14 < 20' },
      { id: 'entry-rules', kind: 'condition', type: 'combine.all', version: 1, title: 'ALL', summary: 'All conditions must pass' },
      { id: 'open-long', kind: 'action', type: 'execution.open_position', version: 1, title: 'Open position', summary: 'Open current-market long at 10% equity' },
      { id: 'exit-hourly', kind: 'trigger', type: 'trigger.interval', version: 1, title: 'Interval', summary: 'Every 1h' },
      { id: 'exit-eth', kind: 'condition', type: 'predicate.compare', version: 1, title: 'Compare', summary: 'Market symbol = ETH-PERP' },
      { id: 'rsi-high', kind: 'condition', type: 'predicate.compare', version: 1, title: 'Compare', summary: 'RSI 14 > 80' },
      { id: 'exit-long', kind: 'condition', type: 'predicate.position_state', version: 2, title: 'Position state', summary: 'Current market position is long' },
      { id: 'exit-rules', kind: 'condition', type: 'combine.all', version: 1, title: 'ALL', summary: 'All conditions must pass' },
      { id: 'close-long', kind: 'action', type: 'execution.close_position', version: 1, title: 'Close position', summary: 'Close current-market long' },
    ],
    edges: [
      { id: 'e1', source: 'entry-hourly', sourcePort: 'activation', target: 'entry-eth', targetPort: 'activation' },
      { id: 'e2', source: 'entry-hourly', sourcePort: 'activation', target: 'rsi-low', targetPort: 'activation' },
      { id: 'e3', source: 'entry-eth', sourcePort: 'result', target: 'entry-rules', targetPort: 'conditions' },
      { id: 'e4', source: 'rsi-low', sourcePort: 'result', target: 'entry-rules', targetPort: 'conditions' },
      { id: 'e5', source: 'entry-rules', sourcePort: 'result', target: 'open-long', targetPort: 'condition' },
      { id: 'e6', source: 'exit-hourly', sourcePort: 'activation', target: 'exit-eth', targetPort: 'activation' },
      { id: 'e7', source: 'exit-hourly', sourcePort: 'activation', target: 'rsi-high', targetPort: 'activation' },
      { id: 'e8', source: 'exit-hourly', sourcePort: 'activation', target: 'exit-long', targetPort: 'activation' },
      { id: 'e9', source: 'exit-eth', sourcePort: 'result', target: 'exit-rules', targetPort: 'conditions' },
      { id: 'e10', source: 'rsi-high', sourcePort: 'result', target: 'exit-rules', targetPort: 'conditions' },
      { id: 'e11', source: 'exit-long', sourcePort: 'result', target: 'exit-rules', targetPort: 'conditions' },
      { id: 'e12', source: 'exit-rules', sourcePort: 'result', target: 'close-long', targetPort: 'condition' },
    ],
  };
}

function previewBacktest(
  botId: string,
  revisionVersion: number,
  marketUniverse: BacktestMarketUniverse,
  assumptions: BacktestSummary['assumptions'],
): { summary: BacktestSummary; traces: TraceDetail[] } {
  const startedAt = new Date().toISOString();
  const selectedMarkets = marketUniverse.mode === 'all_available'
    ? bundledSampleDatasetCatalog.markets
    : marketUniverse.markets;
  if (selectedMarkets.some((market) => !bundledSampleDatasetCatalog.markets.includes(market))) {
    throw new Error('Preview Backtest dataset does not cover the requested market');
  }
  const strategy = previewStrategyDocument(revisionVersion);
  const result = replayBacktest({
    strategy,
    marketUniverse,
    datasetCoverage: {
      markets: bundledSampleDatasetCatalog.markets,
      from: bundledSampleDatasetCatalog.from,
      to: bundledSampleDatasetCatalog.to,
    },
    range: { from: assumptions.from, to: assumptions.to },
    assumptions: {
      startingCapital: assumptions.startingCapital,
      feeRateBps: assumptions.feeRateBps,
      slippageBps: assumptions.slippageBps,
      latencyMs: 100,
      partialFillRatio: 1,
      maintenanceMarginRate: 0.05,
      riskLimits: assumptions.riskLimits,
    },
    inputs: buildBundledSampleInputs(strategy, assumptions, (identity) => `preview:${identity}`),
  }, (identity) => `preview:${identity}`);
  const childTraces = result.traces.flatMap(({ children }) => children.map(({ evaluation }) => evaluation.trace));
  const traces = result.traces.flatMap(({ parentTraceId, children }) => children.map(({ market, evaluation }) => (
    toPreviewTraceDetail(evaluation.trace, parentTraceId, market)
  )));
  return {
    traces,
    summary: {
      id: crypto.randomUUID(),
      botId,
      revisionVersion,
      status: result.status,
      dataSource: 'Bundled sample data',
      startedAt,
      completedAt: new Date().toISOString(),
      assumptions,
      metrics: result.metrics,
      datasetCoverage: { ...result.datasetCoverage, markets: [...result.datasetCoverage.markets] },
      perMarket: [...result.perMarket],
      equityCurve: [...result.equityCurve],
      trades: toPreviewBacktestTrades(result.trades, childTraces),
      warnings: [
        bundledSampleDatasetCatalog.limitations,
        'Bundled sample data is synthetic and is not live market data.',
        ...result.warnings,
      ],
      traces: traces.map(({ traceId, parentTraceId: parentId, market, outcome, events }) => ({
        traceId,
        parentTraceId: parentId,
        market,
        outcome,
        universeRevision: childTraces.find((trace) => trace[0]?.traceId === traceId)?.[0]?.universeRevision,
        occurredAt: events[0]?.occurredAt ?? assumptions.from,
        summary: events.at(-1)?.summary ?? 'flow completed',
      })),
      artifactHash: `sha256:${'b'.repeat(64)}`,
    },
  };
}

function previewStrategyDocument(version: number): StrategyDocument {
  return {
    schemaVersion: '2.0',
    strategy: { id: 'preview-eth-rsi', name: 'ETH RSI', version },
    marketScope: { type: 'dex_universe' },
    nodes: [
      { id: 'entry-hourly', kind: 'trigger', type: 'trigger.interval', version: 1, config: { every: '1h', alignment: 'utc' } },
      { id: 'entry-eth', kind: 'condition', type: 'predicate.compare', version: 1, config: { left: { ref: 'market.symbol' }, operator: 'eq', right: { literal: 'ETH-PERP' } } },
      { id: 'rsi-low', kind: 'condition', type: 'predicate.compare', version: 1, config: { left: { ref: 'indicator.rsi.14', field: 'value' }, operator: 'lt', right: { literal: 20 } } },
      { id: 'entry-rules', kind: 'condition', type: 'combine.all', version: 1, config: {} },
      { id: 'open-long', kind: 'action', type: 'execution.open_position', version: 1, config: { side: 'long', size: { type: 'equity_percent', value: 10 } } },
      { id: 'exit-hourly', kind: 'trigger', type: 'trigger.interval', version: 1, config: { every: '1h', alignment: 'utc' } },
      { id: 'exit-eth', kind: 'condition', type: 'predicate.compare', version: 1, config: { left: { ref: 'market.symbol' }, operator: 'eq', right: { literal: 'ETH-PERP' } } },
      { id: 'rsi-high', kind: 'condition', type: 'predicate.compare', version: 1, config: { left: { ref: 'indicator.rsi.14', field: 'value' }, operator: 'gt', right: { literal: 80 } } },
      { id: 'exit-long', kind: 'condition', type: 'predicate.position_state', version: 2, config: { state: 'long' } },
      { id: 'exit-rules', kind: 'condition', type: 'combine.all', version: 1, config: {} },
      { id: 'close-long', kind: 'action', type: 'execution.close_position', version: 1, config: { side: 'long', percent: 100 } },
    ],
    edges: [
      { id: 'e1', source: 'entry-hourly', sourcePort: 'activation', target: 'entry-eth', targetPort: 'activation' },
      { id: 'e2', source: 'entry-hourly', sourcePort: 'activation', target: 'rsi-low', targetPort: 'activation' },
      { id: 'e3', source: 'entry-eth', sourcePort: 'result', target: 'entry-rules', targetPort: 'conditions' },
      { id: 'e4', source: 'rsi-low', sourcePort: 'result', target: 'entry-rules', targetPort: 'conditions' },
      { id: 'e5', source: 'entry-rules', sourcePort: 'result', target: 'open-long', targetPort: 'condition' },
      { id: 'e6', source: 'exit-hourly', sourcePort: 'activation', target: 'exit-eth', targetPort: 'activation' },
      { id: 'e7', source: 'exit-hourly', sourcePort: 'activation', target: 'rsi-high', targetPort: 'activation' },
      { id: 'e8', source: 'exit-hourly', sourcePort: 'activation', target: 'exit-long', targetPort: 'activation' },
      { id: 'e9', source: 'exit-eth', sourcePort: 'result', target: 'exit-rules', targetPort: 'conditions' },
      { id: 'e10', source: 'rsi-high', sourcePort: 'result', target: 'exit-rules', targetPort: 'conditions' },
      { id: 'e11', source: 'exit-long', sourcePort: 'result', target: 'exit-rules', targetPort: 'conditions' },
      { id: 'e12', source: 'exit-rules', sourcePort: 'result', target: 'close-long', targetPort: 'condition' },
    ],
  };
}

function toPreviewTraceDetail(trace: readonly AuditEvent[], parentTraceId: string, market: string): TraceDetail {
  const types = new Set(trace.map(({ type }) => type));
  const outcome = types.has('flow.failed') ? 'failed'
    : types.has('execution.rejected') ? 'rejected'
      : types.has('flow.skipped') ? 'skipped'
        : types.has('flow.completed') ? 'executed'
          : 'unknown';
  return {
    traceId: trace[0]?.traceId ?? 'unknown-trace',
    parentTraceId,
    market,
    outcome,
    events: trace.map((event) => ({
      sequence: event.sequence,
      type: event.type,
      occurredAt: event.createdAt,
      ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
      summary: event.type.replaceAll('.', ' '),
      details: toRendererSafeTraceDetails(event.type, event.details),
    })),
  };
}

function toPreviewBacktestTrades(
  trades: readonly Readonly<Record<string, JsonValue>>[],
  traces: readonly (readonly AuditEvent[])[],
): BacktestSummary['trades'] {
  const traceIdsByEffect = new Map<string, string>();
  for (const trace of traces) {
    for (const event of trace) {
      const effectIdempotencyKey = event.details.effectIdempotencyKey;
      if (event.type === 'execution.queued' && typeof effectIdempotencyKey === 'string') {
        traceIdsByEffect.set(effectIdempotencyKey, event.traceId);
      }
    }
  }
  return trades.map((trade, index) => ({
    traceId: typeof trade.effectIdempotencyKey === 'string'
      ? traceIdsByEffect.get(trade.effectIdempotencyKey) ?? `trade:${index + 1}`
      : `trade:${index + 1}`,
    market: requiredPreviewTradeString(trade.market),
    side: trade.positionSide === 'short' ? 'short' as const : 'long' as const,
    openedAt: requiredPreviewTradeString(trade.openedAt ?? trade.timestamp),
    closedAt: requiredPreviewTradeString(trade.timestamp),
    entryPrice: requiredPreviewTradeString(trade.entryPrice ?? trade.price),
    exitPrice: requiredPreviewTradeString(trade.price),
    realizedPnl: requiredPreviewTradeString(trade.realizedPnl ?? '0'),
  }));
}

function requiredPreviewTradeString(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Preview Backtest trade is invalid');
  return value;
}
