// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEventView, CatbotsDesktopApi, PaperDeploymentView, ProductCapabilities, RiskLimits, WorkbenchState } from '@catbots/contracts';

vi.mock('../src/renderer/workbench/StrategyGraph', () => ({
  StrategyGraph: ({ revision, onSelectNode }: { revision: WorkbenchState['currentRevision']; onSelectNode(node: NonNullable<WorkbenchState['currentRevision']>['nodes'][number]): void }) => (
    <button onClick={() => revision && onSelectNode(revision.nodes[1]!)}>Mock strategy graph</button>
  ),
}));

vi.mock('../src/renderer/workbench/ChatFlowGraph', () => ({
  ChatFlowGraph: ({ draft }: { draft: import('@catbots/contracts').ChatFlowDraft }) => <div>Live nodes: {draft.document.nodes.length}</div>,
}));
import { BotWorkbenchScreen } from '../src/renderer/screens/BotWorkbenchScreen';

const state: WorkbenchState = {
  bot: {
    id: '018f3f75-89ab-7def-8123-456789abcdef', name: 'BTC Flow', dex: 'hyperliquid', status: 'draft',
    createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
  },
  currentRevision: {
    botId: '018f3f75-89ab-7def-8123-456789abcdef', strategyId: 'strategy', version: 1, name: 'ETF momentum', status: 'draft',
    schemaVersion: '2.0', marketScope: { type: 'dex_universe' },
    createdAt: '2026-09-04T00:00:00.000Z', approvedAt: null,
    nodes: [
      { id: 'trigger', kind: 'trigger', type: 'trigger.interval', version: 1, title: 'Interval', summary: 'Every 1h' },
      { id: 'condition', kind: 'condition', type: 'predicate.compare', version: 1, title: 'Compare', summary: 'ETF flow > 0' },
      { id: 'action', kind: 'action', type: 'execution.open_position', version: 1, title: 'Open position', summary: 'Open long' },
    ],
    edges: [
      { id: 'e1', source: 'trigger', sourcePort: 'activation', target: 'condition', targetPort: 'activation' },
      { id: 'e2', source: 'condition', sourcePort: 'result', target: 'action', targetPort: 'condition' },
    ],
  },
  revisions: [{ version: 1, status: 'draft', createdAt: '2026-09-04T00:00:00.000Z', approvedAt: null }],
  messages: [
    { id: '018f3f75-89ab-7def-8123-456789abcdea', botId: '018f3f75-89ab-7def-8123-456789abcdef', role: 'assistant', content: 'Describe your entry and exit rules.', createdAt: '2026-09-04T00:00:00.000Z' },
  ],
  backtests: [],
};

const strategyLabCapabilities: ProductCapabilities = {
  release: 'strategy-lab-beta',
  strategyResearch: true,
  paperExecution: false,
  liveExecution: false,
  exchangeConnections: false,
};

function api(): CatbotsDesktopApi['workbench'] {
  return {
    get: vi.fn().mockResolvedValue(state),
    stopAgent: vi.fn(async () => undefined), sendMessage: vi.fn().mockImplementation(async (_input) => ({
      ...state,
      messages: [...state.messages, { id: '018f3f75-89ab-7def-8123-456789abcdeb', botId: state.bot.id, role: 'user' as const, content: 'Use ETF inflow', createdAt: '2026-09-04T00:01:00.000Z' }],
    })),
    runBacktest: vi.fn(),
    approveRevision: vi.fn().mockResolvedValue({ ...state.currentRevision, status: 'approved', approvedAt: '2026-09-04T00:02:00.000Z' }),
    getTrace: vi.fn(),
    subscribeActivity: vi.fn(() => () => undefined),
  };
}

const paperView: PaperDeploymentView = {
  deployment: {
    id: '028f3f75-89ab-7def-8123-456789abcdef', botId: state.bot.id, strategyId: 'strategy', strategyVersion: 1,
    recordVersion: 2, dex: 'hyperliquid', mode: 'paper', executionVenue: 'paper', marketAccess: { mode: 'all_active_perpetuals' }, status: 'running',
    riskLimits: {
      maxOrderUsd: '1000', maxPositionUsd: '2500', maxTotalExposureUsd: '5000', maxLeverage: 3, maxDailyLossUsd: '300',
      maxDrawdownPercent: 12, allowedSides: ['long', 'short'], maxOrdersPerMinute: 4,
    },
    createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
  },
  state: { equityUsd: '10000', positions: [], orders: [] },
  auditEvents: [],
};

function deploymentApi(): CatbotsDesktopApi['deployments'] {
  return {
    startPaper: vi.fn().mockResolvedValue(paperView),
    getPaper: vi.fn().mockResolvedValue(paperView),
    pausePaper: vi.fn().mockResolvedValue({ ...paperView, deployment: { ...paperView.deployment, status: 'paused' } }),
    stopPaper: vi.fn().mockResolvedValue({ ...paperView, deployment: { ...paperView.deployment, status: 'stopped' } }),
    prepareLive: vi.fn(), startLive: vi.fn(), getLive: vi.fn(), stopLive: vi.fn(), getActive: vi.fn().mockResolvedValue(null),
  };
}

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('ResizeObserver', class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('BotWorkbenchScreen', () => {
  it('keeps Chat, Flow, and Backtest while removing execution panels in Strategy Lab Beta', async () => {
    const executionApi = deploymentApi();
    render(<BotWorkbenchScreen bot={state.bot} api={api()} deploymentApi={executionApi} capabilities={strategyLabCapabilities} onBack={vi.fn()} />);

    await screen.findByRole('heading', { name: 'BTC Flow' });
    expect(screen.getByRole('tab', { name: 'Flow' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Backtest' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Deploy' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Performance' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Logs' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run Paper' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review Live' })).toBeNull();
    expect(executionApi.getActive).toHaveBeenCalledWith({ botId: state.bot.id });
  });

  it('groups Paper Logs by trigger parent and market child with bounded decision evidence', async () => {
    const parent = 'paper:interval:one';
    const event = (market: string, sequence: number, type: AuditEventView['type']): AuditEventView => ({
      id: `${market}:${sequence}`, traceId: `${parent}:${market}`, parentTraceId: parent, market,
      dex: 'hyperliquid', universeRevision: 'universe:paper', sequence, type, occurredAt: state.bot.createdAt,
      strategyId: 'strategy', strategyVersion: 1, deploymentId: paperView.deployment.id, mode: 'paper',
      summary: type.replaceAll('.', ' '), riskRuleIds: [],
    });
    const view: PaperDeploymentView = { ...paperView, auditEvents: ['BTC-PERP', 'ETH-PERP'].flatMap((market) => [
      event(market, 1, 'trigger.received'),
      { ...event(market, 2, 'condition.evaluated'), condition: { result: true, reason: 'predicate.matched' } },
      { ...event(market, 3, 'action.proposed'), effect: { type: 'execution.open_position', market,
        nodeId: 'order', version: 1, idempotencyKey: `effect:${market}`,
        config: { side: 'long', size: { type: 'quote', value: 500 }, leverage: 2 } } },
      event(market, 4, 'risk.approved'), event(market, 5, 'execution.filled'), event(market, 6, 'flow.completed'),
    ]) };
    const paperApi = deploymentApi();
    vi.mocked(paperApi.getActive).mockResolvedValue(view.deployment);
    vi.mocked(paperApi.getPaper).mockResolvedValue(view);
    const user = userEvent.setup();
    render(<BotWorkbenchScreen bot={state.bot} api={api()} deploymentApi={paperApi} onBack={vi.fn()} />);
    await screen.findByText('Paper running');
    await user.click(screen.getByRole('tab', { name: 'Logs' }));
    await user.click(screen.getByRole('button', { name: /Interval run/ }));
    expect(screen.getByRole('button', { name: /BTC-PERP/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /ETH-PERP/ }));
    expect(await screen.findByText('ETH-PERP evaluation')).toBeTruthy();
    for (const text of ['universe:paper', 'True', 'predicate.matched', 'Open position', '$500 quote', '2×', 'Approved', 'Filled']) {
      expect(screen.getByText(text)).toBeTruthy();
    }
  });
  it('shows unavailable Paper runtime truthfully after restart and keeps Stop usable', async () => {
    const paperApi = deploymentApi();
    vi.mocked(paperApi.getActive).mockResolvedValue(paperView.deployment);
    vi.mocked(paperApi.getPaper).mockResolvedValue({ ...paperView, state: null });
    vi.mocked(paperApi.stopPaper).mockResolvedValue({ ...paperView, state: null, deployment: { ...paperView.deployment, status: 'stopped' } });
    const user = userEvent.setup();
    render(<BotWorkbenchScreen bot={state.bot} api={api()} deploymentApi={paperApi} onBack={vi.fn()} />);
    expect(await screen.findByText('Paper runtime unavailable')).toBeTruthy();
    expect(screen.queryByText('Paper running')).toBeNull();
    expect((screen.getByRole('button', { name: 'Pause' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('tab', { name: 'Performance' }));
    expect(screen.getByText('Positions and orders were not restored after restart. Open Logs to check for saved events; this page cannot reconstruct current positions.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(paperApi.stopPaper).toHaveBeenCalledWith({ deploymentId: paperView.deployment.id });
    expect(await screen.findByText('Paper deployment is stopped')).toBeTruthy();
  });
  it('preserves the chat draft when hiding and reopening the panel', async () => {
    const user = userEvent.setup();
    render(<BotWorkbenchScreen bot={state.bot} api={api()} deploymentApi={deploymentApi()} onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: 'BTC Flow' });
    await user.type(screen.getByRole('textbox', { name: 'Message Catbots AI' }), 'Keep this draft');
    await user.click(screen.getByRole('button', { name: 'Hide chat' }));
    expect(screen.queryByRole('textbox', { name: 'Message Catbots AI' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show chat' }));
    expect((screen.getByRole('textbox', { name: 'Message Catbots AI' }) as HTMLTextAreaElement).value).toBe('Keep this draft');
  });

  it('loads chat and a visual flow without rendering canonical JSON', async () => {
    render(<BotWorkbenchScreen bot={state.bot} api={api()} deploymentApi={deploymentApi()} onBack={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'BTC Flow' })).toBeTruthy();
    expect(screen.getByText('Hyperliquid · Dynamic markets')).toBeTruthy();
    expect(screen.getByText('Describe your entry and exit rules.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mock strategy graph' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('schemaVersion');
    expect(document.body.textContent).not.toContain('sourcePort');
  });

  it('sends a natural-language requirement and shows safe activity state', async () => {
    const workbenchApi = api();
    const user = userEvent.setup();
    render(<BotWorkbenchScreen bot={state.bot} api={workbenchApi} deploymentApi={deploymentApi()} onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: 'BTC Flow' });

    await user.type(screen.getByLabelText('Message Catbots AI'), 'Use ETF inflow');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(workbenchApi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ botId: state.bot.id, message: 'Use ETF inflow', requestId: expect.any(String) }));
    expect(await screen.findByText('Use ETF inflow')).toBeTruthy();
  });

  it('restores a failed Chat message for review without resending', async () => {
    const workbenchApi = api();
    workbenchApi.sendMessage = vi.fn().mockRejectedValue(new Error('provider secret detail'));
    const user = userEvent.setup();
    render(<BotWorkbenchScreen bot={state.bot} api={workbenchApi} deploymentApi={deploymentApi()} onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: 'BTC Flow' });

    const composer = screen.getByLabelText('Message Catbots AI');
    await user.type(composer, 'Keep this requirement');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('The request did not finish. Review any saved changes before trying again.')).toBeTruthy();
    expect((composer as HTMLTextAreaElement).value).toBe('');
    await user.click(screen.getByRole('button', { name: 'Review & retry' }));
    expect((composer as HTMLTextAreaElement).value).toBe('Keep this requirement');
    expect(workbenchApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('provider secret detail');
  });

  it('selects a node for inspection and requires explicit approval confirmation', async () => {
    const workbenchApi = api();
    const user = userEvent.setup();
    render(<BotWorkbenchScreen bot={state.bot} api={workbenchApi} deploymentApi={deploymentApi()} onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: 'BTC Flow' });

    fireEvent.click(screen.getByRole('button', { name: 'Mock strategy graph' }));
    expect(screen.getByRole('heading', { name: 'Compare' })).toBeTruthy();
    expect(screen.getByText('ETF flow > 0')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back to canvas' }));

    await user.click(screen.getByRole('button', { name: 'Approve v1' }));
    expect(workbenchApi.approveRevision).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
    expect(workbenchApi.approveRevision).toHaveBeenCalledWith({ botId: state.bot.id, version: 1 });
  });

  it('reviews and edits the exact shared limits before starting Paper, and cancel does not start', async () => {
    const workbenchApi = api();
    workbenchApi.get = vi.fn().mockResolvedValue({
      ...state,
      currentRevision: { ...state.currentRevision!, status: 'approved', approvedAt: '2026-09-05T00:00:00.000Z' },
    });
    const paperApi = deploymentApi();
    const user = userEvent.setup();
    render(<BotWorkbenchScreen bot={state.bot} api={workbenchApi} deploymentApi={paperApi} onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: 'BTC Flow' });

    await user.click(screen.getByRole('button', { name: 'Run Paper' }));
    expect(screen.getByRole('heading', { name: 'Review Paper deployment' })).toBeTruthy();
    expect(screen.getByText('DEX: Hyperliquid')).toBeTruthy();
    expect(screen.getByText('Market access: All active perpetual markets')).toBeTruthy();
    expect(screen.getByText('Universe data freshness is unavailable before Paper starts.')).toBeTruthy();
    expect(screen.getByLabelText('Max total exposure (USD)')).toHaveProperty('value', '5000');
    expect(document.body.textContent).not.toContain('credential');
    expect(paperApi.startPaper).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('heading', { name: 'BTC Flow' })).toBeTruthy();
    expect(paperApi.startPaper).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Run Paper' }));
    const leverage = screen.getByLabelText('Max leverage');
    const drawdown = screen.getByLabelText('Max drawdown (%)');
    const orderRate = screen.getByLabelText('Max orders per minute');
    const startPaper = screen.getByRole('button', { name: 'Start Paper' });
    expect(leverage.getAttribute('min')).toBe('1');
    expect(leverage.getAttribute('max')).toBe('50');
    expect(leverage.getAttribute('step')).toBe('1');
    expect(drawdown.getAttribute('max')).toBe('100');
    expect(orderRate.getAttribute('max')).toBe('600');

    await user.clear(leverage);
    await user.type(leverage, '2.5');
    expect(screen.getByText('Max leverage must be a whole number from 1 to 50.')).toBeTruthy();
    expect((startPaper as HTMLButtonElement).disabled).toBe(true);
    await user.click(startPaper);
    expect(paperApi.startPaper).not.toHaveBeenCalled();
    await user.clear(leverage);
    await user.type(leverage, '50');

    await user.clear(drawdown);
    await user.type(drawdown, '101');
    expect(screen.getByText('Max drawdown must be greater than 0 and at most 100.')).toBeTruthy();
    expect((startPaper as HTMLButtonElement).disabled).toBe(true);
    await user.clear(drawdown);
    await user.type(drawdown, '100');

    await user.clear(orderRate);
    await user.type(orderRate, '601');
    expect(screen.getByText('Order rate must be a whole number from 1 to 600.')).toBeTruthy();
    expect(screen.getByText('Review the highlighted risk limits before starting Paper.')).toBeTruthy();
    expect((startPaper as HTMLButtonElement).disabled).toBe(true);
    await user.clear(orderRate);
    await user.type(orderRate, '600');
    await user.clear(screen.getByLabelText('Max total exposure (USD)'));
    await user.type(screen.getByLabelText('Max total exposure (USD)'), '6000');
    expect((startPaper as HTMLButtonElement).disabled).toBe(false);
    await user.click(startPaper);
    expect(paperApi.startPaper).toHaveBeenCalledWith(expect.objectContaining({
      botId: state.bot.id, strategyVersion: 1,
      riskLimits: {
        maxOrderUsd: '1000', maxPositionUsd: '2500', maxTotalExposureUsd: '6000', maxLeverage: 50,
        maxDailyLossUsd: '300', maxDrawdownPercent: 100, allowedSides: ['long', 'short'], maxOrdersPerMinute: 600,
      },
    }));
    expect(await screen.findByText('Paper running')).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: 'Performance' }));
    expect(screen.getByText('$10,000.00')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Logs' }));
    expect(screen.getByText('Waiting for the first trigger.')).toBeTruthy();
  });

  it('restores an active Live deployment and keeps the emergency Stop visible', async () => {
    const workbenchApi = api();
    workbenchApi.get = vi.fn().mockResolvedValue({
      ...state,
      currentRevision: { ...state.currentRevision!, status: 'approved', approvedAt: '2026-09-05T00:00:00.000Z' },
    });
    const liveApi = deploymentApi();
    const liveDeployment = {
      id: '038f3f75-89ab-7def-8123-456789abcdef', botId: state.bot.id, strategyId: 'strategy', strategyVersion: 1,
      recordVersion: 2 as const, dex: 'hyperliquid' as const, mode: 'live' as const, executionVenue: 'hyperliquid' as const, network: 'testnet' as const, maskedAccount: '0x0123…4567',
      marketAccess: { mode: 'all_active_perpetuals' as const }, riskLimits: paperView.deployment.riskLimits as RiskLimits, status: 'running' as const,
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    };
    vi.mocked(liveApi.getActive).mockResolvedValue(liveDeployment);
    vi.mocked(liveApi.stopLive).mockResolvedValue({ ...liveDeployment, status: 'stopped' });
    const user = userEvent.setup();
    render(<BotWorkbenchScreen bot={state.bot} api={workbenchApi} deploymentApi={liveApi} onBack={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Stop Live' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Stop Live' }));
    expect(liveApi.stopLive).toHaveBeenCalledWith({ deploymentId: liveDeployment.id });
  });

  it('requires an approved Strategy 2.0 revision before Paper or Live review', async () => {
    const workbenchApi = api();
    workbenchApi.get = vi.fn().mockResolvedValue({
      ...state,
      currentRevision: {
        ...state.currentRevision!, status: 'approved', approvedAt: '2026-09-05T00:00:00.000Z',
        schemaVersion: '1.0', marketScope: { type: 'legacy_fixed', market: 'BTC-PERP' },
      },
    });
    const deployApi = deploymentApi();
    render(<BotWorkbenchScreen bot={state.bot} api={workbenchApi} deploymentApi={deployApi} onBack={vi.fn()} />);

    expect(await screen.findByText('Upgrade required')).toBeTruthy();
    expect(screen.getByText(/create and approve a Strategy 2.0 dynamic-market revision in Chat/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run Paper' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review Live' })).toBeNull();
    expect(screen.queryByText('All active perpetual markets')).toBeNull();
    expect(deployApi.startPaper).not.toHaveBeenCalled();
    expect(deployApi.prepareLive).not.toHaveBeenCalled();
  });
});

it('shows persisted node updates while the chat request is still pending', async () => {
  const workbenchApi = api();
  let listener!: Parameters<typeof workbenchApi.subscribeActivity>[0];
  let finish!: (value: WorkbenchState) => void;
  vi.mocked(workbenchApi.subscribeActivity).mockImplementation(callback => { listener = callback; return () => undefined; });
  vi.mocked(workbenchApi.sendMessage).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<BotWorkbenchScreen bot={state.bot} api={workbenchApi} deploymentApi={deploymentApi()} onBack={() => undefined} />);
  const input = await screen.findByRole('textbox');
  fireEvent.change(input, { target: { value: 'Create an RSI flow' } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  const requestId = vi.mocked(workbenchApi.sendMessage).mock.calls[0]![0].requestId!;
  const flowDraft: import('@catbots/contracts').ChatFlowDraft = {
    botId: state.bot.id, version: 1, status: 'building', updatedAt: state.bot.updatedAt,
    document: { schemaVersion: '3.0', nodes: [{ id: 'tick', type: 'trigger.tick', version: 1, config: {} }], edges: [] },
  };
  act(() => listener({ botId: state.bot.id, requestId: 'wrong-request', phase: 'flow_updated', message: 'Saved', flowDraft }));
  expect(screen.queryByText('Live nodes: 1')).toBeNull();
  act(() => listener({ botId: state.bot.id, requestId, phase: 'flow_updated', message: 'Saved', flowDraft }));
  expect(screen.getByText('Live nodes: 1')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve v1' })).toBeNull();
  await act(async () => finish({ ...state, flowDraft }));
  expect(screen.getByText('Live nodes: 1')).toBeTruthy();
});
