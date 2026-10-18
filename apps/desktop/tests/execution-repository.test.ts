import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEventView, Deployment } from '@catbots/contracts';
import {
  coordinateEvaluation,
  createBuiltinRegistry,
  createEvaluationContext,
  parseStrategyDocument,
  validateStrategy,
} from '@catbots/strategy-runtime';

import { BotRepository } from '../src/main/bots/bot-repository';
import { ExecutionRepository, type LiveActionProposal } from '../src/main/execution/execution-repository';
import { openDatabase } from '../src/main/storage/database';
import { migrateDatabase } from '../src/main/storage/migrations';
import { WorkbenchRepository } from '../src/main/workbench/workbench-repository';

const now = '2026-09-05T00:00:00.000Z';
const deploymentId = '028f3f75-89ab-7def-8123-456789abcdef';
const traceId = 'trace:btc-risk:v1:event-1';

let database: Database.Database;
let botId: string;
let repository: ExecutionRepository;

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database);
  botId = new BotRepository(database, () => new Date(now)).createDraft({ name: 'BTC Risk', market: 'BTC-PERP' }).id;
  const workbench = new WorkbenchRepository(database, () => new Date(now), randomUUID);
  workbench.createValidatedRevision(botId, parseStrategyDocument({
    schemaVersion: '1.0',
    strategy: { id: 'btc-risk', name: 'BTC Risk', version: 99 },
    nodes: [
      { id: 'clock', kind: 'trigger', type: 'trigger.interval', version: 1, config: { every: '15m', alignment: 'utc' } },
      { id: 'flat', kind: 'condition', type: 'predicate.position_state', version: 1, config: { state: 'flat', market: 'BTC-PERP' } },
      { id: 'open', kind: 'action', type: 'execution.open_position', version: 1, config: { side: 'long', size: { type: 'quote', value: 500 }, leverage: 2 } },
    ],
    edges: [
      { id: 'e1', source: 'clock', sourcePort: 'activation', target: 'flat', targetPort: 'activation' },
      { id: 'e2', source: 'flat', sourcePort: 'result', target: 'open', targetPort: 'condition' },
    ],
  }));
  workbench.approveRevision(botId, 1);
  repository = new ExecutionRepository(database);
});

afterEach(() => database.close());

function liveDeployment(): Deployment {
  return {
    id: deploymentId,
    botId,
    strategyId: 'btc-risk',
    strategyVersion: 1,
    recordVersion: 2,
    dex: 'hyperliquid',
    mode: 'live',
    executionVenue: 'hyperliquid',
    network: 'testnet',
    maskedAccount: '0x1234…cdef',
    marketAccess: { mode: 'all_active_perpetuals' },
    riskLimits: {
      maxOrderUsd: '1000', maxPositionUsd: '2500', maxTotalExposureUsd: '5000', maxLeverage: 3,
      maxDailyLossUsd: '300', maxDrawdownPercent: 12,
      allowedSides: ['long', 'short'], maxOrdersPerMinute: 4,
    },
    status: 'preflight',
    createdAt: now,
    updatedAt: now,
  };
}

function dynamicPaperDeployment(): Deployment {
  return {
    id: deploymentId,
    botId,
    strategyId: 'btc-risk',
    strategyVersion: 1,
    recordVersion: 2,
    dex: 'hyperliquid',
    mode: 'paper',
    executionVenue: 'paper',
    marketAccess: { mode: 'all_active_perpetuals' },
    riskLimits: {
      maxOrderUsd: '1000', maxPositionUsd: '2500', maxTotalExposureUsd: '5000', maxLeverage: 3,
      maxDailyLossUsd: '300', maxDrawdownPercent: 12,
      allowedSides: ['long', 'short'], maxOrdersPerMinute: 4,
    },
    status: 'preflight',
    createdAt: now,
    updatedAt: now,
  };
}

function event(id: string, sequence: number, type: AuditEventView['type']): AuditEventView {
  return {
    id,
    traceId,
    sequence,
    type,
    occurredAt: now,
    strategyId: 'btc-risk',
    strategyVersion: 1,
    deploymentId,
    mode: 'live',
    parentTraceId: 'parent:interval-1',
    market: 'BTC-PERP',
    dex: 'hyperliquid',
    universeRevision: 'sha256:fixture',
    contextObservedAt: now,
    nodeId: 'open',
    nodeType: 'execution.open_position',
    summary: type === 'action.proposed' ? 'Open long proposed.' : 'Risk limits approved.',
    riskRuleIds: [],
  };
}

function proposal(): LiveActionProposal {
  database.prepare(`
    INSERT OR IGNORE INTO audit_traces (
      id, deployment_id, trigger_event_id, idempotency_key, status, created_at, updated_at,
      parent_trace_id, market, dex, universe_revision, context_observed_at
    ) VALUES ('parent:interval-1', ?, 'event-1', 'parent:key', 'completed', ?, ?, NULL, NULL, 'hyperliquid', 'sha256:fixture', NULL)
  `).run(deploymentId, now, now);
  return {
    trace: {
      id: traceId,
      deploymentId,
      triggerEventId: 'event-1',
      idempotencyKey: 'trigger-key-1',
      parentTraceId: 'parent:interval-1',
      market: 'BTC-PERP',
      dex: 'hyperliquid',
      universeRevision: 'sha256:fixture',
      contextObservedAt: now,
      createdAt: now,
    },
    events: [
      event('038f3f75-89ab-7def-8123-456789abcdef', 1, 'action.proposed'),
      event('048f3f75-89ab-7def-8123-456789abcdef', 2, 'risk.approved'),
    ],
    outbox: {
      id: '058f3f75-89ab-7def-8123-456789abcdef',
      deploymentId,
      traceId,
      actionNodeId: 'open',
      idempotencyKey: 'sha256:action-1',
      clientOrderId: 'cb_action_1',
      intent: {
        type: 'open_position', market: 'BTC-PERP', side: 'long', orderType: 'market',
        notionalUsd: '500', leverage: 2, clientOrderId: 'cb_action_1',
      },
      createdAt: now,
    },
  };
}

describe('ExecutionRepository', () => {
  it('applies migration 6 without changing prior migrations and adds indexed trace identity columns', () => {
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 },
      { version: 7 },
    ]);
    expect(database.prepare("SELECT name FROM pragma_table_info('audit_traces') ORDER BY cid").all()).toEqual(
      expect.arrayContaining([
        { name: 'parent_trace_id' }, { name: 'market' }, { name: 'dex' },
        { name: 'universe_revision' }, { name: 'context_observed_at' },
      ]),
    );
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'audit_traces_by_%'
      ORDER BY name
    `).all()).toEqual([
      { name: 'audit_traces_by_deployment_market_created' },
      { name: 'audit_traces_by_deployment_parent' },
    ]);
  });

  it('atomically persists one parent trace and market children with sanitized context freshness', () => {
    repository.createDeployment({ ...dynamicPaperDeployment(), status: 'running' });
    const document = parseStrategyDocument({
      schemaVersion: '2.0',
      strategy: { id: 'btc-risk', name: 'BTC Risk', version: 1 },
      marketScope: { type: 'dex_universe' },
      nodes: [
        { id: 'clock', kind: 'trigger', type: 'trigger.interval', version: 1, config: { every: '15m', alignment: 'utc' } },
        { id: 'flat', kind: 'condition', type: 'predicate.position_state', version: 2, config: { state: 'flat' } },
        { id: 'open', kind: 'action', type: 'execution.open_position', version: 1, config: { side: 'long', size: { type: 'quote', value: 500 }, leverage: 2 } },
      ],
      edges: [
        { id: 'e1', source: 'clock', sourcePort: 'activation', target: 'flat', targetPort: 'activation' },
        { id: 'e2', source: 'flat', sourcePort: 'result', target: 'open', targetPort: 'condition' },
      ],
    });
    const validation = validateStrategy(document, createBuiltinRegistry());
    if (!validation.valid) throw new Error('fixture must compile');
    const contexts = new Map<string, ReturnType<typeof createEvaluationContext>>();
    const coordinated = coordinateEvaluation({
      compiled: validation.compiled,
      triggerNodeId: 'clock',
      triggerInput: { kind: 'interval', occurredAt: now },
      universe: {
        dex: 'hyperliquid', revision: 'sha256:fixture', observedAt: now,
        markets: [
          { symbol: 'ETH-PERP', active: true, sizeDecimals: 4, maximumLeverage: 20 },
          { symbol: 'BTC-PERP', active: true, sizeDecimals: 5, maximumLeverage: 20 },
          { symbol: 'SOL-PERP', active: true, sizeDecimals: 3, maximumLeverage: 15 },
        ],
      },
      contextFactory: (market) => {
        const context = createEvaluationContext({
          evaluatedAt: now,
          currentMarket: market,
          values: {
            'account.positions': {
              value: market === 'ETH-PERP' ? [{ market: 'ETH-PERP', side: 'long' }] : [],
              provider: market === 'BTC-PERP' ? 'secret provider token' : 'fixture.account',
              observedAt: now, freshnessSeconds: 0,
              quality: { status: market === 'SOL-PERP' ? 'stale' : 'verified' },
              integrityHash: market === 'BTC-PERP' ? 'secret hash material' : `sha256:positions:${market}`,
            },
          },
        });
        contexts.set(market, context);
        return context;
      },
      deployment: { id: deploymentId, mode: 'paper' },
      execution: { execute: () => ({ events: [{ type: 'risk.approved' }, { type: 'execution.filled' }] }) },
    });

    repository.recordCoordinatedTrace(deploymentId, coordinated, {
      universe: {
        dex: 'hyperliquid', revision: 'sha256:fixture', observedAt: now,
        markets: [],
      },
      contexts,
    });

    const run = repository.listTriggerRun(coordinated.parentTraceId);
    expect(run.children.map(({ market }) => market)).toEqual(['BTC-PERP', 'ETH-PERP', 'SOL-PERP']);
    expect(run.children.every(({ universeRevision }) => universeRevision === 'sha256:fixture')).toBe(true);
    expect(run.children.every(({ parentTraceId }) => parentTraceId === coordinated.parentTraceId)).toBe(true);
    expect(repository.listDeploymentAuditEvents(deploymentId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'condition.evaluated', market: 'BTC-PERP', dex: 'hyperliquid',
        condition: { result: true, reason: 'predicate.matched' },
      }),
      expect.objectContaining({
        type: 'condition.evaluated', market: 'ETH-PERP',
        condition: { result: false, reason: 'predicate.not_matched' },
      }),
      expect.objectContaining({
        type: 'condition.evaluated', market: 'SOL-PERP',
        condition: { result: 'unknown', reason: 'data.stale' },
      }),
      expect.objectContaining({
        type: 'action.proposed', market: 'BTC-PERP',
        effect: {
          nodeId: 'open', type: 'execution.open_position', version: 1, market: 'BTC-PERP',
          config: { side: 'long', size: { type: 'quote', value: 500 }, leverage: 2 },
          idempotencyKey: expect.any(String),
        },
      }),
      expect.objectContaining({ type: 'risk.approved', market: 'BTC-PERP', universeRevision: 'sha256:fixture' }),
    ]));
    expect(JSON.stringify(repository.listDeploymentAuditEvents(deploymentId))).not.toContain('"value":[]');
    expect(JSON.stringify(repository.listDeploymentAuditEvents(deploymentId))).not.toContain('secret');
    expect(run.children[0]?.dataReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'account.positions', provider: 'redacted', integrityHash: 'redacted', freshnessSeconds: 0 }),
    ]));
  });

  it('persists explicit version 2 DEX scope without fixed market bindings', () => {
    const created = repository.createDeployment(dynamicPaperDeployment());

    expect(created).toEqual(dynamicPaperDeployment());
    expect(created).not.toHaveProperty('marketBindings');
    expect(database.prepare(`
      SELECT record_version, dex, execution_venue, market_access_json, market_bindings_json
      FROM deployments WHERE id = ?
    `).get(deploymentId)).toEqual({
      record_version: 2,
      dex: 'hyperliquid',
      execution_venue: 'paper',
      market_access_json: '{"mode":"all_active_perpetuals"}',
      market_bindings_json: '[]',
    });
    expect(() => database.prepare('UPDATE deployments SET dex = ? WHERE id = ?').run('hyperliquid', deploymentId))
      .toThrow(/immutable/i);
  });

  it('persists only a deployment bound to an approved immutable strategy revision', () => {
    const created = repository.createDeployment(liveDeployment());

    expect(repository.getDeployment(deploymentId)).toEqual(created);
    expect(() => database.prepare('UPDATE deployments SET strategy_version = 2 WHERE id = ?').run(deploymentId))
      .toThrow(/immutable/i);
  });

  it('atomically writes action, risk decision, and outbox before execution can be claimed', () => {
    repository.createDeployment(liveDeployment());

    const item = repository.proposeLiveAction(proposal());

    expect(item).toMatchObject({ status: 'pending', attempts: 0, clientOrderId: 'cb_action_1' });
    expect(repository.listAuditEvents(traceId).map(({ sequence, type }) => ({ sequence, type }))).toEqual([
      { sequence: 1, type: 'action.proposed' },
      { sequence: 2, type: 'risk.approved' },
      { sequence: 3, type: 'execution.queued' },
    ]);
    expect(repository.listDeploymentAuditEvents(deploymentId, 10).map(({ type }) => type)).toEqual([
      'action.proposed', 'risk.approved', 'execution.queued',
    ]);
    expect(repository.claimOutboxItem('sha256:action-1', '2026-09-05T00:00:01.000Z')).toMatchObject({
      status: 'claimed', attempts: 1,
    });
    expect(repository.claimOutboxItem('sha256:action-1', '2026-09-05T00:00:02.000Z')).toBeNull();
  });

  it('reuses the existing outbox item when the same action is proposed again', () => {
    repository.createDeployment(liveDeployment());

    const first = repository.proposeLiveAction(proposal());
    const second = repository.proposeLiveAction(proposal());

    expect(second).toEqual(first);
    expect(database.prepare('SELECT COUNT(*) AS count FROM execution_outbox').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({ count: 3 });
  });

  it('rejects an idempotency collision whose persisted action identity differs', () => {
    repository.createDeployment(liveDeployment());
    repository.proposeLiveAction(proposal());
    const original = proposal();
    const collision: LiveActionProposal = {
      ...original,
      outbox: {
        ...original.outbox,
        clientOrderId: 'cb_different_order',
        intent: { ...original.outbox.intent, clientOrderId: 'cb_different_order' },
      },
    };

    expect(() => repository.proposeLiveAction(collision)).toThrow(/idempotency collision/i);
    expect(database.prepare('SELECT COUNT(*) AS count FROM execution_outbox').get()).toEqual({ count: 1 });
  });

  it('rolls back the trace and outbox if the durable audit write fails', () => {
    repository.createDeployment(liveDeployment());
    database.exec(`
      CREATE TRIGGER force_audit_failure BEFORE INSERT ON audit_events
      BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END;
    `);

    expect(() => repository.proposeLiveAction(proposal())).toThrow(/forced audit failure/i);
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_traces').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM execution_outbox').get()).toEqual({ count: 0 });
  });

  it('records adapter outcomes and terminal events with contiguous append-only sequence numbers', () => {
    repository.createDeployment({ ...liveDeployment(), status: 'running' });
    repository.proposeLiveAction(proposal());
    repository.claimOutboxItem('sha256:action-1', '2026-09-05T00:00:01.000Z');
    repository.recordAdapterOutcome(
      'sha256:action-1',
      event('068f3f75-89ab-7def-8123-456789abcdef', 4, 'execution.acknowledged'),
      'acknowledged',
    );
    repository.appendTerminalTrace(traceId, [
      event('078f3f75-89ab-7def-8123-456789abcdef', 5, 'execution.filled'),
      { ...event('088f3f75-89ab-7def-8123-456789abcdef', 6, 'flow.completed'), nodeId: undefined, nodeType: undefined },
    ]);

    expect(repository.listAuditEvents(traceId).map(({ sequence, type }) => ({ sequence, type }))).toEqual([
      { sequence: 1, type: 'action.proposed' },
      { sequence: 2, type: 'risk.approved' },
      { sequence: 3, type: 'execution.queued' },
      { sequence: 4, type: 'execution.acknowledged' },
      { sequence: 5, type: 'execution.filled' },
      { sequence: 6, type: 'flow.completed' },
    ]);
    expect(database.prepare('SELECT status FROM audit_traces WHERE id = ?').get(traceId)).toEqual({ status: 'completed' });
    expect(() => database.prepare('DELETE FROM audit_events WHERE trace_id = ?').run(traceId)).toThrow(/append-only/i);
  });

  it('rolls back an outbox outcome update when its audit event cannot be appended', () => {
    repository.createDeployment(liveDeployment());
    repository.proposeLiveAction(proposal());
    repository.claimOutboxItem('sha256:action-1', '2026-09-05T00:00:01.000Z');
    database.exec(`
      CREATE TRIGGER force_outcome_audit_failure BEFORE INSERT ON audit_events
      BEGIN SELECT RAISE(ABORT, 'forced outcome audit failure'); END;
    `);

    expect(() => repository.recordAdapterOutcome(
      'sha256:action-1',
      event('068f3f75-89ab-7def-8123-456789abcdef', 4, 'execution.acknowledged'),
      'acknowledged',
    )).toThrow(/forced outcome audit failure/i);
    expect(database.prepare('SELECT status FROM execution_outbox WHERE idempotency_key = ?').get('sha256:action-1'))
      .toEqual({ status: 'claimed' });
  });

  it('persists Stop intent and lists only deployments that need runtime recovery', () => {
    repository.createDeployment({ ...liveDeployment(), status: 'running' });

    expect(repository.listRecoverableDeployments()).toEqual([expect.objectContaining({ id: deploymentId, status: 'running' })]);
    expect(repository.requestStop(deploymentId, '2026-09-05T00:00:02.000Z')).toMatchObject({ status: 'stopping' });
    expect(repository.listRecoverableDeployments()).toEqual([expect.objectContaining({ id: deploymentId, status: 'stopping' })]);
  });
});
