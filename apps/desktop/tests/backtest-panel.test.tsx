// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BacktestSummary, CatbotsDesktopApi, StrategyRevision, TraceDetail, TraceSummary } from '@catbots/contracts';

import { BacktestPanel } from '../src/renderer/workbench/BacktestPanel';
import { TraceTimeline } from '../src/renderer/workbench/TraceTimeline';

const botId = '018f3f75-89ab-7def-8123-456789abcdef';
const revision = {
  botId, strategyId: 's', version: 1, name: 'Momentum', status: 'draft', createdAt: '2026-09-04T00:00:00.000Z', approvedAt: null,
  schemaVersion: '2.0', marketScope: { type: 'dex_universe' },
  nodes: [{ id: 't', kind: 'trigger', type: 'trigger.interval', version: 1, title: 'Interval', summary: 'Every 1h' }], edges: [],
} satisfies StrategyRevision;
const backtest = {
  id: '018f3f75-89ab-7def-8123-456789abcdea', botId, revisionVersion: 1, status: 'completed', dataSource: 'Bundled sample data',
  startedAt: '2026-09-04T00:00:00.000Z', completedAt: '2026-09-04T00:01:00.000Z',
  assumptions: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z', startingCapital: '10000', feeRateBps: 3.5, slippageBps: 1 },
  metrics: { returnPercent: 4.2, maximumDrawdownPercent: 1.1, sharpeLike: 1.4, winRatePercent: 60, tradeCount: 5, fees: '12.34', funding: '-1.25', endingEquity: '10420', realizedPnl: '420' },
  datasetCoverage: { markets: ['BTC-PERP', 'ETH-PERP'], from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
  perMarket: [
    { market: 'BTC-PERP', realizedPnl: '300', tradeCount: 3, winRatePercent: 66.67, drawdownContributionPercent: 0.7 },
    { market: 'ETH-PERP', realizedPnl: '120', tradeCount: 2, winRatePercent: 50, drawdownContributionPercent: 0.4 },
  ],
  equityCurve: [{ timestamp: '2026-08-01T00:00:00.000Z', equity: '10000' }, { timestamp: '2026-09-01T00:00:00.000Z', equity: '10420' }],
  trades: [], warnings: ['Bundled sample data is synthetic and is not live market data.'],
  traces: [
    {
      traceId: 'trace-1',
      parentTraceId: 'trace:s:v1:deployment:d:trigger:interval:2026-08-02T00%3A00%3A00.000Z:dex:hyperliquid:universe:bundled%3Aeth-listed',
      market: 'BTC-PERP', outcome: 'executed', occurredAt: '2026-08-02T00:00:00.000Z', summary: 'flow completed',
    },
    {
      traceId: 'trace-2',
      parentTraceId: 'trace:s:v1:deployment:d:trigger:interval:2026-08-02T00%3A00%3A00.000Z:dex:hyperliquid:universe:bundled%3Aeth-listed',
      market: 'ETH-PERP', outcome: 'executed', occurredAt: '2026-08-02T00:00:00.000Z', summary: 'flow completed',
    },
  ],
  artifactHash: `sha256:${'a'.repeat(64)}`,
} satisfies BacktestSummary;
const legacyBacktest = {
  ...backtest,
  traces: [{ ...backtest.traces[0], parentTraceId: 'run-1' }],
} satisfies BacktestSummary;

function api(): CatbotsDesktopApi['workbench'] {
  return {
    get: vi.fn(), stopAgent: vi.fn(async () => undefined), sendMessage: vi.fn(), approveRevision: vi.fn(), subscribeActivity: vi.fn(() => () => undefined),
    runBacktest: vi.fn().mockResolvedValue(backtest),
    getTrace: vi.fn().mockImplementation(async ({ traceId }) => ({
      traceId,
      parentTraceId: backtest.traces[0].parentTraceId,
      market: traceId === 'trace-2' ? 'ETH-PERP' : 'BTC-PERP',
      outcome: 'executed' as const,
      events: [
        {
          sequence: 1, type: 'condition.evaluated', occurredAt: '2026-08-02T00:00:00.000Z', nodeId: 'condition', summary: 'condition evaluated',
          details: {
            result: 'unknown', reason: 'data.stale',
            inputs: [
              { ref: 'market.price', field: 'mark', value: { raw: 'secret-value' }, provider: 'raw-provider-payload', integrityHash: 'secret-integrity' },
              { ref: 'privateKey', field: 'value' },
            ],
            rawPayload: 'raw-provider-payload',
          },
        },
        {
          sequence: 2, type: 'action.proposed', occurredAt: '2026-08-02T00:00:00.100Z', nodeId: 'action', summary: 'action proposed',
          details: { effect: { type: 'execution.open_position', market: 'ETH-PERP', config: { side: 'long', size: { type: 'quote', value: 1000 }, leverage: 2 }, idempotencyKey: 'secret-effect-key' } },
        },
        {
          sequence: 3, type: 'risk.rejected', occurredAt: '2026-08-02T00:00:00.200Z', nodeId: 'action', summary: 'risk evaluated',
          details: { violatedRuleIds: ['max-total-exposure-usd'], error: 'provider-error' },
        },
        {
          sequence: 4, type: 'execution.rejected', occurredAt: '2026-08-02T00:00:01.000Z', nodeId: 'action', summary: 'execution completed',
          details: { code: 'NO_PRICE', privateKey: 'private-key-value' },
        },
      ],
    })),
  };
}

afterEach(cleanup);

describe('BacktestPanel', () => {
  it('runs the selected revision and shows provenance, assumptions, and performance', async () => {
    const workbenchApi = api();
    const user = userEvent.setup();
    render(<BacktestPanel botId={botId} revision={revision} backtests={[]} api={workbenchApi} onCompleted={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Run backtest' }));

    expect(workbenchApi.runBacktest).toHaveBeenCalledWith(expect.objectContaining({ botId, revisionVersion: 1 }));
    expect(await screen.findByText('Bundled sample data')).toBeTruthy();
    expect(screen.getByText('+4.20%')).toBeTruthy();
    expect(screen.getByText('1.10%')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Portfolio performance' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Dataset coverage (UTC)' })).toBeTruthy();
    expect(screen.getByText('BTC-PERP, ETH-PERP')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'By market' })).toBeTruthy();
    const ethRow = screen.getByRole('row', { name: /ETH-PERP/ });
    expect(within(ethRow).getByText('$120.00')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Equity curve' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('not live market data');
  });

  it('drills from a parent interval run into a market child and its decision timeline', async () => {
    const workbenchApi = api();
    const user = userEvent.setup();
    render(<BacktestPanel botId={botId} revision={revision} backtests={[backtest]} api={workbenchApi} onCompleted={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /interval run/i }));

    expect(screen.getByText('Universe revision')).toBeTruthy();
    expect(screen.getByText('bundled:eth-listed')).toBeTruthy();
    const marketChildren = screen.getByRole('group', { name: 'Market evaluations' });
    expect(within(marketChildren).getByRole('button', { name: /BTC-PERP/ })).toBeTruthy();
    await user.click(within(marketChildren).getByRole('button', { name: /ETH-PERP/ }));

    expect(workbenchApi.getTrace).toHaveBeenCalledWith({ botId, traceId: 'trace-2' });
    expect(await screen.findByRole('heading', { name: 'ETH-PERP evaluation' })).toBeTruthy();
    expect(screen.getByText('Condition')).toBeTruthy();
    expect(screen.getByText('Action')).toBeTruthy();
    expect(screen.getByText('Risk')).toBeTruthy();
    expect(screen.getByText('Execution')).toBeTruthy();
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.getByText('data.stale')).toBeTruthy();
    expect(screen.getByText('market.price.mark')).toBeTruthy();
    expect(screen.getByText('Long')).toBeTruthy();
    expect(screen.getByText('$1,000 quote')).toBeTruthy();
    expect(screen.getByText('2×')).toBeTruthy();
    expect(screen.getByText('max-total-exposure-usd')).toBeTruthy();
    expect(screen.getAllByText('Rejected')).toHaveLength(2);
    expect(screen.getByText('Node condition')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/raw-provider-payload|secret-value|secret-integrity|secret-effect-key|provider-error|private-key-value|privateKey/);

    await user.click(screen.getByRole('button', { name: /interval run/i }));
    expect(screen.queryByRole('heading', { name: 'ETH-PERP evaluation' })).toBeNull();
  });

  it('keeps historical parent trace identifiers readable without inventing scope metadata', async () => {
    const user = userEvent.setup();
    render(<BacktestPanel botId={botId} revision={revision} backtests={[legacyBacktest]} api={api()} onCompleted={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /trigger run/i }));

    expect(screen.getByText('Not recorded')).toBeTruthy();
    expect(screen.getByRole('button', { name: /BTC-PERP/ })).toBeTruthy();
  });

  it('resets parent, child, and pending detail state when the trace set changes', async () => {
    let resolveTrace: ((detail: TraceDetail) => void) | undefined;
    const pendingTrace = new Promise<TraceDetail>((resolve) => { resolveTrace = resolve; });
    const traceApi = { getTrace: vi.fn(() => pendingTrace) };
    const firstTraces = backtest.traces;
    const nextTraces: TraceSummary[] = [{
      traceId: 'trace-next',
      parentTraceId: 'trace:s:v1:deployment:d:trigger:event:event-2:dex:hyperliquid:universe:bundled%3Anext',
      market: 'SOL-PERP', outcome: 'skipped', occurredAt: '2026-08-03T00:00:00.000Z', summary: 'flow skipped',
    }];
    const { rerender } = render(<TraceTimeline backtestId="backtest-1" botId={botId} revisionVersion={1} traces={firstTraces} api={traceApi} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /interval run/i }));
    await user.click(screen.getByRole('button', { name: /ETH-PERP/ }));
    rerender(<TraceTimeline backtestId="backtest-1" botId={botId} revisionVersion={1} traces={nextTraces} api={traceApi} />);

    expect(screen.getByRole('button', { name: /event run/i }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /ETH-PERP/ })).toBeNull();

    await act(async () => resolveTrace?.({
      traceId: 'trace-2', parentTraceId: firstTraces[0]!.parentTraceId, market: 'ETH-PERP', outcome: 'executed', events: [],
    }));
    expect(screen.queryByRole('heading', { name: 'ETH-PERP evaluation' })).toBeNull();
  });

  it('resets trace navigation and ignores deferred responses when identical summaries belong to another Backtest', async () => {
    let resolveTrace: ((detail: TraceDetail) => void) | undefined;
    const pendingTrace = new Promise<TraceDetail>((resolve) => { resolveTrace = resolve; });
    const traceApi = { getTrace: vi.fn()
      .mockRejectedValueOnce(new Error('old run failed'))
      .mockReturnValueOnce(pendingTrace) };
    const { rerender } = render(<TraceTimeline backtestId="backtest-a" botId={botId} revisionVersion={1} traces={backtest.traces} api={traceApi} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /interval run/i }));
    await user.click(screen.getByRole('button', { name: /BTC-PERP/ }));
    expect(await screen.findByText('This trace could not be loaded.')).toBeTruthy();

    rerender(<TraceTimeline backtestId="backtest-b" botId={botId} revisionVersion={1} traces={backtest.traces} api={traceApi} />);
    expect(screen.getByRole('button', { name: /interval run/i }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('This trace could not be loaded.')).toBeNull();

    await user.click(screen.getByRole('button', { name: /interval run/i }));
    await user.click(screen.getByRole('button', { name: /ETH-PERP/ }));
    rerender(<TraceTimeline backtestId="backtest-c" botId={botId} revisionVersion={1} traces={backtest.traces} api={traceApi} />);
    await act(async () => resolveTrace?.({
      traceId: 'trace-2', parentTraceId: backtest.traces[0]!.parentTraceId, market: 'ETH-PERP', outcome: 'executed', events: [],
    }));

    expect(screen.getByRole('button', { name: /interval run/i }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('heading', { name: 'ETH-PERP evaluation' })).toBeNull();
    expect(screen.queryByText('This trace could not be loaded.')).toBeNull();
  });
});
