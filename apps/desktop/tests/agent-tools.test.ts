import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseStrategyDocument } from '@catbots/strategy-runtime';

import { BotRepository } from '../src/main/bots/bot-repository';
import { createAgentToolCatalog } from '../src/main/agent/agent-tools';
import { openDatabase } from '../src/main/storage/database';
import { migrateDatabase } from '../src/main/storage/migrations';
import { bundledSampleDatasetCatalog } from '../src/main/workbench/sample-backtest-data';
import { WorkbenchRepository } from '../src/main/workbench/workbench-repository';

let database: Database.Database;
let botId: string;
let repository: WorkbenchRepository;

const validStrategy = {
  schemaVersion: '2.0',
  strategy: { id: 'momentum', name: 'Momentum', version: 1 },
  marketScope: { type: 'dex_universe' },
  nodes: [
    { id: 'clock', kind: 'trigger', type: 'trigger.interval', version: 1, config: { every: '1h', alignment: 'utc' } },
    { id: 'price', kind: 'condition', type: 'predicate.compare', version: 1, config: { left: { ref: 'market.price', field: 'mark' }, operator: 'gt', right: { literal: 90 } } },
    { id: 'buy', kind: 'action', type: 'execution.open_position', version: 1, config: { side: 'long', size: { type: 'quote', value: 1000 } } },
  ],
  edges: [
    { id: 'e1', source: 'clock', sourcePort: 'activation', target: 'price', targetPort: 'activation' },
    { id: 'e2', source: 'price', sourcePort: 'result', target: 'buy', targetPort: 'condition' },
  ],
};

const { marketScope: _dynamicMarketScope, ...dynamicStrategyFields } = validStrategy;
const legacyStrategy = {
  ...dynamicStrategyFields,
  schemaVersion: '1.0',
};

function createCatalog() {
  return createAgentToolCatalog({
    botId,
    dex: 'hyperliquid',
    backtestDatasetCatalog: bundledSampleDatasetCatalog,
    repository,
  });
}

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database);
  botId = new BotRepository(database, () => new Date('2026-09-04T00:00:00.000Z')).createDraft({ name: 'Bot', market: 'BTC-PERP' }).id;
  repository = new WorkbenchRepository(database, () => new Date('2026-09-04T00:00:00.000Z'), randomUUID);
});

afterEach(() => database.close());

describe('Agent tool catalog', () => {
  it('exposes custom-signal controller ports and NOT to the flow-building agent', () => {
    const result = createCatalog().execute('get_flow', {});
    expect(result.definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'strategy.directional', version: 2, inputs: { long: 'condition', short: 'condition', atr: 'number' } }),
      expect.objectContaining({ type: 'condition.not', inputs: { condition: 'condition' } }),
    ]));
  });
  it('exposes the approved legacy and packaged flow tools with strict object schemas', () => {
    const catalog = createCatalog();

    expect(catalog.definitions.map(({ name }) => name)).toEqual([
      'run_flow_backtest', 'get_flow_backtest', 'cancel_flow_backtest',
      'get_flow', 'edit_flow', 'validate_flow', 'list_nodes', 'list_data_products', 'validate_strategy', 'backtest_strategy', 'explain_strategy', 'compare_versions',
    ]);
    expect(catalog.definitions.every(({ inputSchema }) => inputSchema.additionalProperties === false)).toBe(true);
  });

  it('describes the complete strategy document, node configs, and graph ports to the model', () => {
    const catalog = createCatalog();
    const validateTool = catalog.definitions.find(({ name }) => name === 'validate_strategy');
    const listed = catalog.execute('list_nodes', {});

    expect(validateTool?.inputSchema).toMatchObject({
      properties: {
        strategy: {
          type: 'object',
          properties: {
            schemaVersion: { const: '2.0' },
            strategy: { type: 'object' },
            marketScope: {
              type: 'object',
              properties: { type: { const: 'dex_universe' } },
              required: ['type'],
              additionalProperties: false,
            },
            nodes: { type: 'array', items: { oneOf: expect.any(Array) } },
            edges: { type: 'array', items: { type: 'object' } },
          },
          required: ['schemaVersion', 'strategy', 'marketScope', 'nodes', 'edges'],
          additionalProperties: false,
        },
      },
    });
    expect(listed).toMatchObject({
      ok: true,
      nodes: expect.arrayContaining([
        expect.objectContaining({
          type: 'trigger.interval',
          configSchema: expect.objectContaining({ type: 'object' }),
          inputs: [],
          outputs: [{ id: 'activation', dataType: 'activation', cardinality: 'many' }],
        }),
      ]),
    });
  });

  it('returns safe document issue paths so the model can repair malformed strategy JSON', () => {
    const catalog = createCatalog();

    const result = catalog.execute('validate_strategy', {
      strategy: { strategy: { id: 'broken' }, nodes: [], edges: [] },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_STRATEGY',
        issues: expect.arrayContaining([
          expect.objectContaining({ path: 'schemaVersion' }),
          expect.objectContaining({ path: 'strategy.name' }),
        ]),
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('describes every bundled data field used by the sample backtest', () => {
    const catalog = createCatalog();

    const result = catalog.execute('list_data_products', {});

    expect(result).toMatchObject({
      ok: true,
      products: expect.arrayContaining([
        expect.objectContaining({ id: 'market.symbol', valueType: 'string' }),
        expect.objectContaining({ id: 'market.price', fields: { mark: 'number', bid: 'number', ask: 'number' } }),
        expect.objectContaining({ id: 'market.funding', fields: { rate: 'number' } }),
        expect.objectContaining({ id: 'market.volume', fields: { notional24h: 'number' } }),
        expect.objectContaining({ id: 'market.rank', fields: { value: 'number' } }),
        expect.objectContaining({ id: 'indicator.rsi.14', fields: { value: 'number' } }),
        expect.objectContaining({ id: 'data.etf_flow.btc.net_daily', fields: { usd: 'number' } }),
      ]),
      dataset: {
        dex: 'hyperliquid',
        markets: ['BTC-PERP', 'ETH-PERP'],
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-09-01T00:00:00.000Z',
        limitations: expect.stringContaining('only BTC-PERP and ETH-PERP'),
      },
    });
  });

  it('returns safe argument issue paths so the model can repair a backtest request', () => {
    const catalog = createCatalog();

    const result = catalog.execute('backtest_strategy', {
      revisionVersion: 1,
      marketUniverse: { mode: 'all_available' },
      assumptions: {
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-09-01T00:00:00.000Z',
        startingCapital: 10_000,
        feeRateBps: 5,
        slippageBps: 5,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_TOOL_ARGUMENTS',
        issues: expect.arrayContaining([
          expect.objectContaining({ path: 'assumptions.startingCapital' }),
        ]),
      },
    });
  });

  it('validates and persists only structurally valid strategies', () => {
    const catalog = createCatalog();

    const invalid = catalog.execute('validate_strategy', { strategy: { ...validStrategy, edges: [] } });
    const valid = catalog.execute('validate_strategy', { strategy: validStrategy });

    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_STRATEGY' } });
    expect(valid).toMatchObject({ ok: true, revision: { version: 1, status: 'draft' } });
    expect(repository.getState(botId).revisions).toHaveLength(1);
  });

  it('rejects new Strategy 1.0 revisions while preserving readable legacy revisions', () => {
    repository.createValidatedRevision(botId, parseStrategyDocument(legacyStrategy));
    const catalog = createCatalog();

    const rejected = catalog.execute('validate_strategy', { strategy: legacyStrategy });
    const explanation = catalog.execute('explain_strategy', { revisionVersion: 1 });

    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_STRATEGY',
        issues: expect.arrayContaining([expect.objectContaining({ path: 'schemaVersion' })]),
      },
    });
    expect(explanation).toMatchObject({ ok: true, explanation: expect.stringContaining('Momentum') });
    expect(repository.getState(botId).revisions).toHaveLength(1);
  });

  it('rejects unknown tools and malformed arguments with stable structured errors', () => {
    const catalog = createCatalog();

    expect(catalog.execute('delete_everything', {})).toEqual({ ok: false, error: { code: 'UNKNOWN_TOOL', message: 'Tool is not available.' } });
    expect(catalog.execute('backtest_strategy', { revisionVersion: -1 })).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_ARGUMENTS' } });
  });

  it('runs a deterministic sample backtest and stores its trace artifact', () => {
    const catalog = createCatalog();
    catalog.execute('validate_strategy', { strategy: validStrategy });

    const result = catalog.execute('backtest_strategy', {
      revisionVersion: 1,
      marketUniverse: { mode: 'all_available' },
      assumptions: {
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-09-01T00:00:00.000Z',
        startingCapital: '10000',
        feeRateBps: 3.5,
        slippageBps: 1,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      backtest: {
        dataSource: 'Bundled sample data',
        revisionVersion: 1,
        status: 'completed',
        datasetCoverage: { markets: ['BTC-PERP', 'ETH-PERP'] },
        perMarket: [
          expect.objectContaining({ market: 'BTC-PERP' }),
          expect.objectContaining({ market: 'ETH-PERP' }),
        ],
      },
    });
    expect(repository.getState(botId).backtests).toHaveLength(1);
  });

  it('explains and compares immutable revisions without exposing config JSON', () => {
    const catalog = createCatalog();
    catalog.execute('validate_strategy', { strategy: validStrategy });
    catalog.execute('validate_strategy', { strategy: { ...validStrategy, strategy: { ...validStrategy.strategy, name: 'Momentum v2' } } });

    const explanation = catalog.execute('explain_strategy', { revisionVersion: 1 });
    const comparison = catalog.execute('compare_versions', { leftVersion: 1, rightVersion: 2 });

    expect(explanation).toMatchObject({ ok: true, explanation: expect.stringContaining('Interval') });
    expect(comparison).toMatchObject({ ok: true, comparison: expect.stringContaining('Momentum v2') });
    expect(JSON.stringify([explanation, comparison])).not.toContain('startingCapital');
  });
});
