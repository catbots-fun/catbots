import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import {
  AuditEventViewSchema,
  AuditConditionResultSchema,
  AuditProposedEffectSchema,
  DeploymentSchema,
  type AuditDataReference,
  type AuditEventView,
  type Deployment,
} from '@catbots/contracts';
import type { NormalizedOrderIntent } from '@catbots/execution-core';
import type {
  AuditEvent,
  CoordinatedEvaluation,
  EvaluationContext,
  MarketUniverseSnapshot,
  ProposedEffect,
  TriggerInput,
} from '@catbots/strategy-runtime';

export type AuditTraceIdentity = Readonly<{
  id: string;
  deploymentId: string;
  triggerEventId: string;
  idempotencyKey: string;
  parentTraceId?: string;
  market?: string;
  dex?: 'hyperliquid' | 'lighter';
  universeRevision?: string;
  contextObservedAt?: string;
  createdAt: string;
}>;

export type CoordinatedTraceMetadata = Readonly<{
  universe: MarketUniverseSnapshot;
  contexts: ReadonlyMap<string, EvaluationContext>;
}>;

export type StoredAuditTrace = Readonly<{
  traceId: string;
  parentTraceId: string | null;
  market: string | null;
  dex: 'hyperliquid' | 'lighter' | null;
  universeRevision: string | null;
  contextObservedAt: string | null;
  dataReferences: readonly AuditDataReference[];
  status: 'open' | 'completed' | 'failed';
  events: readonly AuditEventView[];
}>;

export type TriggerRun = Readonly<{
  parent: StoredAuditTrace;
  children: readonly StoredAuditTrace[];
}>;

export type ExecutionOutboxInput = Readonly<{
  id: string;
  deploymentId: string;
  traceId: string;
  actionNodeId: string;
  idempotencyKey: string;
  clientOrderId: string;
  intent: NormalizedOrderIntent;
  createdAt: string;
}>;

export type ExecutionOutboxItem = ExecutionOutboxInput & Readonly<{
  status: 'pending' | 'claimed' | 'acknowledged' | 'rejected' | 'unknown';
  attempts: number;
  claimedAt: string | null;
  updatedAt: string;
}>;

export type LiveActionProposal = Readonly<{
  trace: AuditTraceIdentity;
  events: readonly [AuditEventView, AuditEventView];
  outbox: ExecutionOutboxInput;
}>;

export type CoordinatedLiveAction = Readonly<{
  childTraceId: string;
  effect: ProposedEffect;
  intent: NormalizedOrderIntent;
  outboxId: string;
  idempotencyKey: string;
  clientOrderId: string;
  createdAt: string;
}>;

export type CoordinatedLiveRunResult = Readonly<{
  duplicate: boolean;
  run: TriggerRun;
  outboxItems: readonly ExecutionOutboxItem[];
}>;

type DeploymentRow = Record<string, unknown>;
type OutboxRow = Record<string, unknown>;
export class ExecutionRepository {
  constructor(private readonly database: Database.Database) {}

  createDeployment(input: Deployment): Deployment {
    const deployment = DeploymentSchema.parse(input);
    const revision = this.database.prepare(`
      SELECT strategy_id, status FROM strategy_revisions
      WHERE bot_id = ? AND version = ?
    `).get(deployment.botId, deployment.strategyVersion) as { strategy_id: unknown; status: unknown } | undefined;
    if (revision?.status !== 'approved' || revision.strategy_id !== deployment.strategyId) {
      throw new Error('Deployment requires the matching approved strategy revision');
    }
    this.database.prepare(`
      INSERT INTO deployments (
        id, bot_id, strategy_id, strategy_version, record_version, dex, mode, venue, execution_venue,
        network, masked_account, market_bindings_json, market_access_json, risk_limits_json,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deployment.id,
      deployment.botId,
      deployment.strategyId,
      deployment.strategyVersion,
      deployment.recordVersion,
      deployment.recordVersion === 2 ? deployment.dex : null,
      deployment.mode,
      deployment.recordVersion === 1 ? deployment.venue : deployment.executionVenue,
      deployment.recordVersion === 2 ? deployment.executionVenue : null,
      deployment.recordVersion === 1 ? deployment.network : deployment.mode === 'live' ? deployment.network : 'paper',
      deployment.mode === 'live' ? deployment.maskedAccount : null,
      JSON.stringify(deployment.recordVersion === 1 ? deployment.marketBindings : []),
      deployment.recordVersion === 2 ? JSON.stringify(deployment.marketAccess) : null,
      JSON.stringify(deployment.riskLimits),
      deployment.status,
      deployment.createdAt,
      deployment.updatedAt,
    );
    return this.getDeployment(deployment.id);
  }

  getDeployment(id: string): Deployment {
    const row = this.database.prepare('SELECT * FROM deployments WHERE id = ?').get(id) as DeploymentRow | undefined;
    if (row === undefined) throw new Error('Deployment not found');
    return toDeployment(row);
  }

  getActiveDeploymentForBot(botId: string): Deployment | null {
    const row = this.database.prepare(`
      SELECT * FROM deployments
      WHERE bot_id = ? AND status IN ('preflight', 'running', 'paused', 'stopping', 'recovering', 'suspended', 'error')
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(botId) as DeploymentRow | undefined;
    return row === undefined ? null : toDeployment(row);
  }

  recordCoordinatedTrace(
    deploymentId: string,
    source: CoordinatedEvaluation,
    metadata: CoordinatedTraceMetadata,
  ): TriggerRun {
    if (this.hasTrace(source.parentTraceId)) return this.listTriggerRun(source.parentTraceId);
    return this.database.transaction(() => {
      this.insertCoordinatedTrace(deploymentId, source, metadata, new Set());
      return this.listTriggerRun(source.parentTraceId);
    }).immediate();
  }

  recordCoordinatedLiveRun(
    deploymentId: string,
    source: CoordinatedEvaluation,
    metadata: CoordinatedTraceMetadata,
    actions: readonly CoordinatedLiveAction[],
  ): CoordinatedLiveRunResult {
    if (this.hasTrace(source.parentTraceId)) {
      return Object.freeze({ duplicate: true, run: this.listTriggerRun(source.parentTraceId), outboxItems: [] });
    }
    return this.database.transaction(() => {
      requireCompleteLiveActions(source, actions);
      const pendingTraceIds = new Set(actions.map(({ childTraceId }) => childTraceId));
      this.insertCoordinatedTrace(deploymentId, source, metadata, pendingTraceIds);
      const actionByIdentity = new Map(actions.map((action) => [
        `${action.childTraceId}\0${action.effect.nodeId}`, action,
      ]));
      const outboxItems: ExecutionOutboxItem[] = [];
      for (const child of source.children.filter(({ evaluation }) => pendingTraceIds.has(evaluation.traceId))) {
        const context = metadata.contexts.get(child.market);
        const references = context === undefined ? [] : toDataReferences(context);
        const observedAt = observedContextTime(context, references);
        if (observedAt === null) throw new Error('Coordinated Live context is required');
        const identity = {
          parentTraceId: source.parentTraceId,
          market: child.market,
          dex: metadata.universe.dex,
          universeRevision: metadata.universe.revision,
          contextObservedAt: observedAt,
          dataReferences: references,
        } satisfies PersistedAuditIdentity;
        for (const effect of child.evaluation.effects) {
          const proposed = child.evaluation.trace.find((event) => event.type === 'action.proposed' && event.nodeId === effect.nodeId);
          if (proposed === undefined) throw new Error('Coordinated Live action evidence is incomplete');
          const approved = child.evaluation.trace.find((event) => event.type === 'risk.approved' && event.nodeId === effect.nodeId);
          const rejected = child.evaluation.trace.find((event) => event.type === 'risk.rejected' && event.nodeId === effect.nodeId);
          const next = this.nextAuditSequence(child.evaluation.traceId);
          const proposedView = toAuditEventView(proposed, identity);
          if (approved !== undefined) {
            const action = actionByIdentity.get(`${child.evaluation.traceId}\0${effect.nodeId}`);
            if (action === undefined || child.market !== action.effect.market) {
              throw new Error('Coordinated Live child identity does not match');
            }
            const approvedView = toAuditEventView(approved, identity);
            outboxItems.push(this.proposeLiveAction({
              trace: {
                id: child.evaluation.traceId, deploymentId,
                triggerEventId: triggerEventId(child.evaluation.trace),
                idempotencyKey: `child:${source.parentTraceId}:${child.market}`,
                parentTraceId: source.parentTraceId, market: child.market, dex: metadata.universe.dex,
                universeRevision: metadata.universe.revision, contextObservedAt: observedAt,
                createdAt: traceCreatedAt(child.evaluation.trace),
              },
              events: [
                { ...proposedView, id: `${child.evaluation.traceId}:proposal:${effect.nodeId}`, sequence: next },
                { ...approvedView, id: `${child.evaluation.traceId}:risk:${effect.nodeId}`, sequence: next + 1 },
              ],
              outbox: {
                id: action.outboxId, deploymentId, traceId: child.evaluation.traceId,
                actionNodeId: effect.nodeId, idempotencyKey: action.idempotencyKey,
                clientOrderId: action.clientOrderId, intent: action.intent, createdAt: action.createdAt,
              },
            }));
            continue;
          }
          if (rejected === undefined) throw new Error('Coordinated Live risk decision is incomplete');
          const rejectedView = toAuditEventView(rejected, identity);
          this.insertAuditEvent({
            ...proposedView, id: `${child.evaluation.traceId}:proposal:${effect.nodeId}`, sequence: next,
          });
          this.insertAuditEvent({
            ...rejectedView, id: `${child.evaluation.traceId}:risk:${effect.nodeId}`, sequence: next + 1,
          });
        }
      }
      return Object.freeze({
        duplicate: false,
        run: this.listTriggerRun(source.parentTraceId),
        outboxItems: Object.freeze(outboxItems),
      });
    }).immediate();
  }

  listTriggerRun(parentTraceId: string): TriggerRun {
    const parent = this.getStoredTrace(parentTraceId);
    if (parent.parentTraceId !== null) throw new Error('Parent audit trace required');
    const children = this.database.prepare(`
      SELECT id FROM audit_traces WHERE parent_trace_id = ? ORDER BY market, created_at, rowid
    `).all(parentTraceId).map((row) => this.getStoredTrace(String((row as { id: unknown }).id)));
    return Object.freeze({ parent, children: Object.freeze(children) });
  }

  proposeLiveAction(input: LiveActionProposal): ExecutionOutboxItem {
    const existing = this.getOutboxItem(input.outbox.idempotencyKey);
    if (existing !== null) {
      if (!sameOutboxIdentity(existing, input.outbox)) throw new Error('Execution idempotency collision');
      return existing;
    }
    return this.database.transaction(() => {
      const deployment = this.getDeployment(input.outbox.deploymentId);
      validateProposal(input, deployment);
      const traceExists = this.hasTrace(input.trace.id);
      if (traceExists) this.requireStoredLiveTraceIdentity(input.trace);
      else this.insertValidatedLiveTrace(input.trace);
      for (const event of input.events) {
        this.requireNextAuditEvent(input.trace.id, event);
        this.insertAuditEvent(event);
      }
      this.database.prepare(`
        INSERT INTO execution_outbox (
          id, deployment_id, trace_id, action_node_id, idempotency_key, client_order_id,
          intent_json, status, attempts, claimed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
      `).run(
        input.outbox.id,
        input.outbox.deploymentId,
        input.outbox.traceId,
        input.outbox.actionNodeId,
        input.outbox.idempotencyKey,
        input.outbox.clientOrderId,
        JSON.stringify(input.outbox.intent),
        input.outbox.createdAt,
        input.outbox.createdAt,
      );
      const created = this.getOutboxItem(input.outbox.idempotencyKey);
      if (created === null) throw new Error('Created outbox item could not be loaded');
      this.insertAuditEvent({
        ...input.events[1], id: `${input.outbox.id}:queued`, sequence: this.nextAuditSequence(input.trace.id),
        type: 'execution.queued', summary: 'Order intent durably queued.',
      });
      return created;
    }).immediate();
  }

  claimOutboxItem(idempotencyKey: string, claimedAt: string, submissionEvent?: AuditEventView): ExecutionOutboxItem | null {
    return this.database.transaction(() => {
      const pending = this.getOutboxItem(idempotencyKey);
      if (pending === null || pending.status !== 'pending') return null;
      const submittedAt = Date.parse(claimedAt);
      if (!Number.isFinite(submittedAt)) throw new Error('Valid submission timestamp required');
      const deployment = this.getDeployment(pending.deploymentId);
      const items = this.listOutboxItems(pending.deploymentId);
      // Pending intents own FIFO queue slots, not permanent minute slots. Claiming
      // converts the head slot to an actual submission reservation atomically.
      const head = this.database.prepare(`
        SELECT idempotency_key FROM execution_outbox
        WHERE deployment_id = ? AND status = 'pending' ORDER BY rowid LIMIT 1
      `).get(pending.deploymentId) as { idempotency_key: string } | undefined;
      if (head?.idempotency_key !== idempotencyKey) return null;
      const recentClaims = items.filter((item) => item.claimedAt !== null
        && (item.status === 'claimed'
          || Math.max(Date.parse(item.claimedAt), Date.parse(item.updatedAt)) > submittedAt - 60_000)).length;
      if (recentClaims >= deployment.riskLimits.maxOrdersPerMinute) return null;
      if (submissionEvent !== undefined) {
        const event = AuditEventViewSchema.parse(submissionEvent);
        this.requireNextAuditEvent(pending.traceId, event);
        this.insertAuditEvent(event);
      }
      const result = this.database.prepare(`
        UPDATE execution_outbox
        SET status = 'claimed', attempts = attempts + 1, claimed_at = ?, updated_at = ?
        WHERE idempotency_key = ? AND status = 'pending'
      `).run(claimedAt, claimedAt, idempotencyKey);
      return result.changes === 1 ? this.getOutboxItem(idempotencyKey) : null;
    }).immediate();
  }

  recordAdapterOutcome(
    idempotencyKey: string,
    source: AuditEventView,
    status: Extract<ExecutionOutboxItem['status'], 'acknowledged' | 'rejected' | 'unknown'>,
  ): ExecutionOutboxItem {
    return this.database.transaction(() => {
      const item = this.getOutboxItem(idempotencyKey);
      if (item === null || item.status !== 'claimed') throw new Error('Claimed outbox item not found');
      const event = AuditEventViewSchema.parse(source);
      this.requireNextAuditEvent(item.traceId, event);
      const result = this.database.prepare(`
        UPDATE execution_outbox SET status = ?, updated_at = ?
        WHERE idempotency_key = ? AND status = 'claimed'
      `).run(status, event.occurredAt, idempotencyKey);
      if (result.changes !== 1) throw new Error('Outbox outcome could not be recorded');
      this.insertAuditEvent(event);
      const updated = this.getOutboxItem(idempotencyKey);
      if (updated === null) throw new Error('Updated outbox item could not be loaded');
      return updated;
    }).immediate();
  }

  appendTerminalTrace(traceId: string, sources: readonly AuditEventView[]): AuditEventView[] {
    if (sources.length === 0) throw new Error('Terminal trace events are required');
    return this.database.transaction(() => {
      for (const source of sources) {
        const event = AuditEventViewSchema.parse(source);
        this.requireNextAuditEvent(traceId, event);
        this.insertAuditEvent(event);
      }
      const terminal = sources.at(-1)?.type;
      const status = terminal === 'flow.completed' ? 'completed' : terminal === 'flow.failed' ? 'failed' : undefined;
      if (status === undefined) throw new Error('Trace must end with a terminal flow event');
      const completedAt = sources.at(-1)?.occurredAt;
      const result = this.database.prepare(`
        UPDATE audit_traces SET status = ?, updated_at = ? WHERE id = ? AND status = 'open'
      `).run(status, completedAt, traceId);
      if (result.changes !== 1) throw new Error('Open audit trace not found');
      return this.listAuditEvents(traceId);
    }).immediate();
  }

  requestStop(deploymentId: string, requestedAt: string): Deployment {
    const current = this.getDeployment(deploymentId);
    if (current.status === 'stopping') return current;
    const result = this.database.prepare(`
      UPDATE deployments SET status = 'stopping', updated_at = ?
      WHERE id = ? AND status IN ('running', 'paused', 'recovering')
    `).run(requestedAt, deploymentId);
    if (result.changes !== 1) throw new Error('Deployment cannot be stopped from its current state');
    return this.getDeployment(deploymentId);
  }

  pause(deploymentId: string, pausedAt: string): Deployment {
    const result = this.database.prepare(`
      UPDATE deployments SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'running'
    `).run(pausedAt, deploymentId);
    if (result.changes !== 1) throw new Error('Running deployment not found');
    return this.getDeployment(deploymentId);
  }

  listRecoverableDeployments(): Deployment[] {
    return this.database.prepare(`
      SELECT * FROM deployments
      WHERE status IN ('running', 'paused', 'stopping', 'recovering')
      ORDER BY created_at, rowid
    `).all().map((row) => toDeployment(row as DeploymentRow));
  }

  getOutboxItem(idempotencyKey: string): ExecutionOutboxItem | null {
    const row = this.database.prepare(`
      SELECT * FROM execution_outbox WHERE idempotency_key = ?
    `).get(idempotencyKey) as OutboxRow | undefined;
    return row === undefined ? null : toOutboxItem(row);
  }

  listOutboxItems(
    deploymentId: string,
    status?: ExecutionOutboxItem['status'],
  ): ExecutionOutboxItem[] {
    const rows = status === undefined
      ? this.database.prepare('SELECT * FROM execution_outbox WHERE deployment_id = ? ORDER BY created_at, rowid').all(deploymentId)
      : this.database.prepare('SELECT * FROM execution_outbox WHERE deployment_id = ? AND status = ? ORDER BY created_at, rowid').all(deploymentId, status);
    return rows.map((row) => toOutboxItem(row as OutboxRow));
  }

  findTriggerRunId(deploymentId: string, triggerNodeId: string, input: TriggerInput): string | null {
    const occurrence = input.kind === 'event' ? input.event.id : `interval:${input.occurredAt}`;
    const row = this.database.prepare(`
      SELECT traces.id FROM audit_traces AS traces
      JOIN audit_events AS events ON events.trace_id = traces.id
      WHERE traces.deployment_id = ? AND traces.parent_trace_id IS NULL
        AND traces.trigger_event_id = ? AND events.type = 'trigger.received'
        AND json_extract(events.event_json, '$.nodeId') = ?
        AND json_extract(events.event_json, '$.nodeType') = ?
      ORDER BY traces.created_at, traces.rowid LIMIT 1
    `).get(deploymentId, occurrence, triggerNodeId, `trigger.${input.kind}`) as { id: string } | undefined;
    return row?.id ?? null;
  }

  withLiveRiskReservations<T>(deploymentId: string, evaluateAndPersist: (reservations: Readonly<{
    positions: readonly { market: string; side: 'long' | 'short'; notionalUsd: string; settledAt?: string }[];
    recentOrderTimestamps: readonly string[];
  }>) => T): T {
    return this.database.transaction(() => {
      const items = this.listOutboxItems(deploymentId);
      return evaluateAndPersist({
        positions: items.flatMap((item) => {
          if (item.intent.type !== 'open_position') return [];
          const partial = this.listAuditEvents(item.traceId).find((event) => event.nodeId === item.actionNodeId
            && (event.type === 'execution.partially_filled_cancelled' || event.type === 'execution.partially_filled_rejected'));
          if (partial !== undefined) return [{ market: item.intent.market, side: item.intent.side,
            notionalUsd: partial.fill?.notionalUsd ?? item.intent.notionalUsd, settledAt: partial.occurredAt }];
          return item.status !== 'rejected' && !this.hasConfirmedFill(item)
            ? [{ market: item.intent.market, side: item.intent.side, notionalUsd: item.intent.notionalUsd }] : [];
        }),
        recentOrderTimestamps: items.map((item) => item.claimedAt ?? item.createdAt),
      });
    }).immediate();
  }

  hasConfirmedFill(item: ExecutionOutboxItem): boolean {
    return this.listAuditEvents(item.traceId).some((event) => event.type === 'execution.filled' && event.nodeId === item.actionNodeId);
  }

  liveTraceTerminalStatus(traceId: string): 'completed' | 'failed' | null {
    const trace = this.database.prepare('SELECT status FROM audit_traces WHERE id = ?')
      .get(traceId) as { status: unknown } | undefined;
    if (trace?.status !== 'open') return null;
    const items = this.database.prepare('SELECT * FROM execution_outbox WHERE trace_id = ? ORDER BY rowid')
      .all(traceId).map((row) => toOutboxItem(row as OutboxRow));
    if (items.length === 0 || items.some((item) => (
      item.status !== 'rejected' && !this.hasConfirmedFill(item)
    ))) return null;
    const rejectedRisk = this.database.prepare(`
      SELECT 1 FROM audit_events WHERE trace_id = ? AND type = 'risk.rejected' LIMIT 1
    `).get(traceId);
    return rejectedRisk !== undefined || items.some((item) => item.status === 'rejected') ? 'failed' : 'completed';
  }

  recordReconciledOutcome(
    idempotencyKey: string,
    source: AuditEventView,
    status: Extract<ExecutionOutboxItem['status'], 'acknowledged' | 'rejected'>,
  ): ExecutionOutboxItem {
    return this.database.transaction(() => {
      const item = this.getOutboxItem(idempotencyKey);
      if (item?.status === 'rejected') return item;
      if (item === null || !['unknown', 'claimed', 'acknowledged'].includes(item.status)) throw new Error('Unsettled outbox item not found');
      if (this.hasConfirmedFill(item)) return item;
      const event = AuditEventViewSchema.parse(source);
      this.requireNextAuditEvent(item.traceId, event);
      const result = this.database.prepare(`
        UPDATE execution_outbox SET status = ?, updated_at = ?
        WHERE idempotency_key = ? AND status IN ('unknown', 'claimed', 'acknowledged')
      `).run(status, event.occurredAt, idempotencyKey);
      if (result.changes !== 1) throw new Error('Reconciled outbox outcome could not be recorded');
      this.insertAuditEvent(event);
      const updated = this.getOutboxItem(idempotencyKey);
      if (updated === null) throw new Error('Reconciled outbox item could not be loaded');
      return updated;
    }).immediate();
  }

  suspendDeployment(deploymentId: string, suspendedAt: string): Deployment {
    const result = this.database.prepare(`
      UPDATE deployments SET status = 'suspended', updated_at = ?
      WHERE id = ? AND status IN ('running', 'recovering', 'preflight')
    `).run(suspendedAt, deploymentId);
    if (result.changes !== 1) throw new Error('Live deployment cannot be suspended from its current state');
    return this.getDeployment(deploymentId);
  }

  nextAuditSequence(traceId: string): number {
    const row = this.database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM audit_events WHERE trace_id = ?')
      .get(traceId) as { sequence: number } | undefined;
    if (row === undefined) throw new Error('Audit trace not found');
    return row.sequence + 1;
  }

  isWritable(): boolean {
    const row = this.database.prepare('PRAGMA query_only').get() as { query_only?: unknown } | undefined;
    return row?.query_only === 0;
  }

  listAuditEvents(traceId: string): AuditEventView[] {
    return this.database.prepare(`
      SELECT event_json FROM audit_events WHERE trace_id = ? ORDER BY sequence
    `).all(traceId).map((row) => {
      const serialized = (row as { event_json: unknown }).event_json;
      if (typeof serialized !== 'string') throw new Error('Stored audit event is invalid');
      return AuditEventViewSchema.parse(JSON.parse(serialized));
    });
  }

  getAuditTraceContext(traceId: string): PersistedAuditIdentity {
    const trace = this.getStoredTrace(traceId);
    return Object.freeze({
      ...(trace.parentTraceId === null ? {} : { parentTraceId: trace.parentTraceId }),
      ...(trace.market === null ? {} : { market: trace.market }),
      ...(trace.dex === null ? {} : { dex: trace.dex }),
      ...(trace.universeRevision === null ? {} : { universeRevision: trace.universeRevision }),
      ...(trace.contextObservedAt === null ? {} : { contextObservedAt: trace.contextObservedAt }),
      ...(trace.dataReferences.length === 0 ? {} : { dataReferences: [...trace.dataReferences] }),
    });
  }

  listDeploymentAuditEvents(deploymentId: string, limit = 200): AuditEventView[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error('Audit event limit is invalid');
    return this.database.prepare(`
      SELECT audit_events.event_json FROM audit_events
      JOIN audit_traces ON audit_traces.id = audit_events.trace_id
      WHERE audit_traces.deployment_id = ?
      ORDER BY audit_traces.created_at DESC, audit_traces.rowid DESC, audit_events.sequence ASC
      LIMIT ?
    `).all(deploymentId, limit).map((row) => {
      const serialized = (row as { event_json: unknown }).event_json;
      if (typeof serialized !== 'string') throw new Error('Stored audit event is invalid');
      return AuditEventViewSchema.parse(JSON.parse(serialized));
    });
  }

  hasTrace(traceId: string): boolean {
    return this.database.prepare('SELECT 1 FROM audit_traces WHERE id = ?').get(traceId) !== undefined;
  }

  recordPaperTrace(deploymentId: string, sourceEvents: readonly AuditEvent[]): AuditEventView[] {
    if (sourceEvents.length === 0) throw new Error('Paper trace events are required');
    const traceId = sourceEvents[0]?.traceId ?? '';
    if (this.hasTrace(traceId)) return this.listAuditEvents(traceId);
    return this.database.transaction(() => {
      const deployment = this.getDeployment(deploymentId);
      if (deployment.mode !== 'paper' || deployment.status !== 'running') throw new Error('Running Paper deployment not found');
      const events = sourceEvents.map((event) => toAuditEventView(event));
      if (events.some((event, index) => event.deploymentId !== deploymentId || event.sequence !== index + 1 || event.traceId !== traceId)) {
        throw new Error('Paper trace identity or sequence does not match');
      }
      const last = events.at(-1);
      if (last === undefined) throw new Error('Paper trace events are required');
      const status = last?.type === 'flow.completed' ? 'completed' : last?.type === 'flow.failed' ? 'failed'
        : last?.type === 'flow.skipped' ? 'completed' : undefined;
      if (status === undefined) throw new Error('Paper trace must be terminal');
      const first = sourceEvents[0];
      if (first === undefined) throw new Error('Paper trace identity is missing');
      this.database.prepare(`
        INSERT INTO audit_traces (
          id, deployment_id, trigger_event_id, idempotency_key, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        traceId,
        deploymentId,
        first.triggerEventId ?? `interval:${first.evaluationTime}`,
        first.idempotencyKey,
        status,
        first.createdAt,
        last.occurredAt,
      );
      for (const event of events) this.insertAuditEvent(event);
      return events;
    }).immediate();
  }

  completeStop(deploymentId: string, completedAt: string): Deployment {
    const result = this.database.prepare(`
      UPDATE deployments SET status = 'stopped', updated_at = ? WHERE id = ? AND status = 'stopping'
    `).run(completedAt, deploymentId);
    if (result.changes !== 1) throw new Error('Stopping deployment not found');
    return this.getDeployment(deploymentId);
  }

  private requireNextAuditEvent(traceId: string, event: AuditEventView): void {
    const trace = this.database.prepare('SELECT deployment_id, status FROM audit_traces WHERE id = ?')
      .get(traceId) as { deployment_id: unknown; status: unknown } | undefined;
    if (trace === undefined || trace.status !== 'open' || event.traceId !== traceId || event.deploymentId !== trace.deployment_id) {
      throw new Error('Open audit trace identity does not match');
    }
    const row = this.database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM audit_events WHERE trace_id = ?')
      .get(traceId) as { sequence: number };
    if (event.sequence !== row.sequence + 1) throw new Error('Audit event sequence is not contiguous');
  }

  private insertAuditEvent(event: AuditEventView): void {
    this.database.prepare(`
      INSERT INTO audit_events (id, trace_id, sequence, type, event_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.id, event.traceId, event.sequence, event.type, JSON.stringify(event), event.occurredAt);
  }

  private insertValidatedLiveTrace(trace: AuditTraceIdentity): void {
    if (trace.parentTraceId === undefined) throw new Error('Durable parent trace is required');
    const parent = this.database.prepare(`
      SELECT deployment_id, parent_trace_id FROM audit_traces WHERE id = ?
    `).get(trace.parentTraceId) as { deployment_id: unknown; parent_trace_id: unknown } | undefined;
    if (parent === undefined || parent.deployment_id !== trace.deploymentId || parent.parent_trace_id !== null) {
      throw new Error('Durable parent trace identity does not match');
    }
    this.insertTrace({
      id: trace.id, deploymentId: trace.deploymentId, triggerEventId: trace.triggerEventId,
      idempotencyKey: trace.idempotencyKey, status: 'open', createdAt: trace.createdAt, updatedAt: trace.createdAt,
      parentTraceId: trace.parentTraceId, market: trace.market ?? null, dex: trace.dex ?? null,
      universeRevision: trace.universeRevision ?? null, contextObservedAt: trace.contextObservedAt ?? null,
    });
  }

  private requireStoredLiveTraceIdentity(trace: AuditTraceIdentity): void {
    const stored = this.database.prepare(`
      SELECT deployment_id, parent_trace_id, market, dex, universe_revision, context_observed_at
      FROM audit_traces WHERE id = ?
    `).get(trace.id) as Record<string, unknown> | undefined;
    if (stored === undefined || stored.deployment_id !== trace.deploymentId
      || stored.parent_trace_id !== trace.parentTraceId || stored.market !== trace.market
      || stored.dex !== trace.dex || stored.universe_revision !== trace.universeRevision
      || stored.context_observed_at !== trace.contextObservedAt) {
      throw new Error('Persisted Live child trace identity does not match');
    }
    const parent = this.database.prepare(`
      SELECT deployment_id, parent_trace_id FROM audit_traces WHERE id = ?
    `).get(trace.parentTraceId) as { deployment_id: unknown; parent_trace_id: unknown } | undefined;
    if (parent === undefined || parent.deployment_id !== trace.deploymentId || parent.parent_trace_id !== null) {
      throw new Error('Durable parent trace identity does not match');
    }
  }

  private insertCoordinatedTrace(
    deploymentId: string,
    source: CoordinatedEvaluation,
    metadata: CoordinatedTraceMetadata,
    pendingLiveTraceIds: ReadonlySet<string>,
  ): void {
    const deployment = this.getDeployment(deploymentId);
    if (deployment.status !== 'running') throw new Error('Running deployment not found');
    if (deployment.recordVersion !== 2 || deployment.dex !== metadata.universe.dex) {
      throw new Error('Dynamic trace DEX identity does not match');
    }
    this.insertTrace({
      id: source.parentTraceId, deploymentId, triggerEventId: triggerEventId(source.parentTrace),
      idempotencyKey: `parent:${source.parentTraceId}`, status: traceStatus(source.parentTrace),
      createdAt: traceCreatedAt(source.parentTrace), updatedAt: traceUpdatedAt(source.parentTrace),
      parentTraceId: null, market: null, dex: metadata.universe.dex,
      universeRevision: metadata.universe.revision, contextObservedAt: null,
    });
    for (const event of source.parentTrace) {
      this.insertAuditEvent(toAuditEventView(event, {
        dex: metadata.universe.dex, universeRevision: metadata.universe.revision,
      }));
    }
    for (const child of source.children) {
      const context = metadata.contexts.get(child.market);
      const dataReferences = context === undefined ? [] : toDataReferences(context);
      const contextObservedAt = observedContextTime(context, dataReferences);
      const pending = pendingLiveTraceIds.has(child.evaluation.traceId);
      const actionIndex = child.evaluation.trace.findIndex(({ type }) => type === 'action.proposed');
      const persistedEvents = pending && actionIndex >= 0
        ? child.evaluation.trace.slice(0, actionIndex)
        : child.evaluation.trace;
      this.insertTrace({
        id: child.evaluation.traceId, deploymentId,
        triggerEventId: triggerEventId(child.evaluation.trace),
        idempotencyKey: `child:${source.parentTraceId}:${child.market}`,
        status: pending ? 'open' : traceStatus(child.evaluation.trace),
        createdAt: traceCreatedAt(child.evaluation.trace),
        updatedAt: pending ? traceUpdatedAt(persistedEvents) : traceUpdatedAt(child.evaluation.trace),
        parentTraceId: source.parentTraceId, market: child.market, dex: metadata.universe.dex,
        universeRevision: metadata.universe.revision, contextObservedAt,
      });
      for (const event of persistedEvents) {
        this.insertAuditEvent(toAuditEventView(event, {
          parentTraceId: source.parentTraceId, market: child.market, dex: metadata.universe.dex,
          universeRevision: metadata.universe.revision,
          ...(contextObservedAt === null ? {} : { contextObservedAt }), dataReferences,
        }));
      }
    }
  }

  private insertTrace(input: Readonly<{
    id: string;
    deploymentId: string;
    triggerEventId: string;
    idempotencyKey: string;
    status: StoredAuditTrace['status'];
    createdAt: string;
    updatedAt: string;
    parentTraceId: string | null;
    market: string | null;
    dex: 'hyperliquid' | 'lighter' | null;
    universeRevision: string | null;
    contextObservedAt: string | null;
  }>): void {
    this.database.prepare(`
      INSERT INTO audit_traces (
        id, deployment_id, trigger_event_id, idempotency_key, status, created_at, updated_at,
        parent_trace_id, market, dex, universe_revision, context_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.deploymentId, input.triggerEventId, input.idempotencyKey, input.status,
      input.createdAt, input.updatedAt, input.parentTraceId, input.market, input.dex,
      input.universeRevision, input.contextObservedAt,
    );
  }

  private getStoredTrace(traceId: string): StoredAuditTrace {
    const row = this.database.prepare(`
      SELECT id, parent_trace_id, market, dex, universe_revision, context_observed_at, status
      FROM audit_traces WHERE id = ?
    `).get(traceId) as Record<string, unknown> | undefined;
    if (row === undefined || typeof row.id !== 'string'
      || (row.status !== 'open' && row.status !== 'completed' && row.status !== 'failed')) {
      throw new Error('Audit trace not found');
    }
    const events = this.listAuditEvents(traceId);
    return Object.freeze({
      traceId: row.id,
      parentTraceId: typeof row.parent_trace_id === 'string' ? row.parent_trace_id : null,
      market: typeof row.market === 'string' ? row.market : null,
      dex: row.dex === 'hyperliquid' || row.dex === 'lighter' ? row.dex : null,
      universeRevision: typeof row.universe_revision === 'string' ? row.universe_revision : null,
      contextObservedAt: typeof row.context_observed_at === 'string' ? row.context_observed_at : null,
      dataReferences: events.find(({ dataReferences }) => dataReferences !== undefined)?.dataReferences ?? [],
      status: row.status,
      events,
    });
  }
}

function sameOutboxIdentity(existing: ExecutionOutboxItem, proposed: ExecutionOutboxInput): boolean {
  return existing.deploymentId === proposed.deploymentId
    && existing.traceId === proposed.traceId
    && existing.actionNodeId === proposed.actionNodeId
    && existing.clientOrderId === proposed.clientOrderId
    && isDeepStrictEqual(existing.intent, proposed.intent);
}

function requireCompleteLiveActions(
  source: CoordinatedEvaluation,
  actions: readonly CoordinatedLiveAction[],
): void {
  const approved = source.children.flatMap((child) => child.evaluation.effects
    .filter((effect) => child.evaluation.trace.some((event) => (
      event.type === 'risk.approved' && event.nodeId === effect.nodeId
    )))
    .map((effect) => `${child.evaluation.traceId}\0${effect.nodeId}`));
  const supplied = actions.map(({ childTraceId, effect }) => `${childTraceId}\0${effect.nodeId}`);
  if (new Set(approved).size !== approved.length || new Set(supplied).size !== supplied.length
    || approved.length !== supplied.length || approved.some((key) => !supplied.includes(key))) {
    throw new Error('Every approved coordinated Live action requires exactly one outbox intent');
  }
}

function validateProposal(input: LiveActionProposal, deployment: Deployment): void {
  if (deployment.mode !== 'live') throw new Error('Live outbox requires a Live deployment');
  if (deployment.recordVersion !== 2) throw new Error('Strategy 2.0 dynamic deployment is required');
  if (input.trace.deploymentId !== deployment.id || input.outbox.deploymentId !== deployment.id) {
    throw new Error('Proposal deployment does not match');
  }
  if (input.trace.id !== input.outbox.traceId) throw new Error('Proposal trace does not match');
  if (input.events[0].type !== 'action.proposed' || input.events[1].type !== 'risk.approved') {
    throw new Error('Live proposal requires action and approved risk audit events');
  }
  for (const source of input.events) {
    const event = AuditEventViewSchema.parse(source);
    if (event.traceId !== input.trace.id || event.deploymentId !== deployment.id) {
      throw new Error('Proposal audit event identity does not match');
    }
    if (source.parentTraceId !== input.trace.parentTraceId
      || source.market !== input.trace.market
      || source.dex !== input.trace.dex
      || source.universeRevision !== input.trace.universeRevision
      || source.contextObservedAt !== input.trace.contextObservedAt) {
      throw new Error('Proposal market trace identity does not match');
    }
  }
  if (input.outbox.intent.clientOrderId !== input.outbox.clientOrderId) {
    throw new Error('Outbox client order ID does not match its intent');
  }
  if (input.trace.parentTraceId === undefined || input.trace.market === undefined
    || input.trace.dex !== deployment.dex || input.trace.universeRevision === undefined
    || input.trace.contextObservedAt === undefined || input.outbox.intent.market !== input.trace.market) {
    throw new Error('Dynamic outbox market identity does not match');
  }
}

function toDeployment(row: DeploymentRow): Deployment {
  if (row.record_version === 2) {
    const common = {
      id: row.id,
      botId: row.bot_id,
      strategyId: row.strategy_id,
      strategyVersion: row.strategy_version,
      recordVersion: 2,
      dex: row.dex,
      mode: row.mode,
      executionVenue: row.execution_venue,
      marketAccess: parseStoredJson(row.market_access_json),
      riskLimits: parseStoredJson(row.risk_limits_json),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    return DeploymentSchema.parse(row.mode === 'live'
      ? { ...common, network: row.network, maskedAccount: row.masked_account }
      : common);
  }
  const common = {
    id: row.id,
    botId: row.bot_id,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    recordVersion: 1,
    mode: row.mode,
    venue: row.venue,
    network: row.network,
    marketBindings: parseStoredJson(row.market_bindings_json),
    riskLimits: parseStoredJson(row.risk_limits_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return DeploymentSchema.parse(row.mode === 'live' ? { ...common, maskedAccount: row.masked_account } : common);
}

function toOutboxItem(row: OutboxRow): ExecutionOutboxItem {
  if (typeof row.id !== 'string' || typeof row.deployment_id !== 'string' || typeof row.trace_id !== 'string'
    || typeof row.action_node_id !== 'string' || typeof row.idempotency_key !== 'string'
    || typeof row.client_order_id !== 'string' || typeof row.created_at !== 'string'
    || typeof row.updated_at !== 'string' || typeof row.status !== 'string' || typeof row.attempts !== 'number') {
    throw new Error('Stored outbox item is invalid');
  }
  if (!['pending', 'claimed', 'acknowledged', 'rejected', 'unknown'].includes(row.status)) {
    throw new Error('Stored outbox status is invalid');
  }
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    traceId: row.trace_id,
    actionNodeId: row.action_node_id,
    idempotencyKey: row.idempotency_key,
    clientOrderId: row.client_order_id,
    intent: parseStoredJson(row.intent_json) as NormalizedOrderIntent,
    status: row.status as ExecutionOutboxItem['status'],
    attempts: row.attempts,
    claimedAt: typeof row.claimed_at === 'string' ? row.claimed_at : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== 'string') throw new Error('Stored JSON value is invalid');
  return JSON.parse(value);
}

type PersistedAuditIdentity = Readonly<{
  parentTraceId?: string;
  market?: string;
  dex?: 'hyperliquid' | 'lighter';
  universeRevision?: string;
  contextObservedAt?: string;
  dataReferences?: AuditDataReference[];
}>;

function toAuditEventView(event: AuditEvent, identity: PersistedAuditIdentity = {}): AuditEventView {
  const violatedRuleIds = Array.isArray(event.details.violatedRuleIds)
    ? event.details.violatedRuleIds.filter((value): value is string => typeof value === 'string')
    : [];
  const condition = event.type === 'condition.evaluated'
    ? AuditConditionResultSchema.safeParse({ result: event.details.result, reason: event.details.reason })
    : undefined;
  const effect = event.type === 'action.proposed'
    ? AuditProposedEffectSchema.safeParse(event.details.effect)
    : undefined;
  return AuditEventViewSchema.parse({
    id: event.id,
    traceId: event.traceId,
    sequence: event.sequence,
    type: event.type,
    occurredAt: event.createdAt,
    strategyId: event.strategyId,
    strategyVersion: event.strategyVersion,
    deploymentId: event.deploymentId,
    mode: event.mode,
    ...identity,
    ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
    ...(event.nodeType === undefined ? {} : { nodeType: event.nodeType }),
    summary: event.type.replaceAll('.', ' '),
    riskRuleIds: violatedRuleIds,
    ...(condition?.success ? { condition: condition.data } : {}),
    ...(effect?.success ? { effect: effect.data } : {}),
  });
}

function triggerEventId(events: readonly AuditEvent[]): string {
  const first = events[0];
  if (first === undefined) throw new Error('Audit trace events are required');
  return first.triggerEventId ?? `interval:${first.evaluationTime}`;
}

function traceCreatedAt(events: readonly AuditEvent[]): string {
  const first = events[0];
  if (first === undefined) throw new Error('Audit trace events are required');
  return first.createdAt;
}

function traceUpdatedAt(events: readonly AuditEvent[]): string {
  const last = events.at(-1);
  if (last === undefined) throw new Error('Audit trace events are required');
  return last.createdAt;
}

function traceStatus(events: readonly AuditEvent[]): StoredAuditTrace['status'] {
  const terminal = events.at(-1)?.type;
  if (terminal === 'flow.failed') return 'failed';
  if (terminal === 'flow.completed' || terminal === 'flow.skipped') return 'completed';
  return 'open';
}

function toDataReferences(context: EvaluationContext): AuditDataReference[] {
  return Object.entries(context.values).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => ({
    key: sanitizedReferenceText(key, 160),
    provider: sanitizedReferenceText(value.provider, 160),
    observedAt: value.observedAt,
    freshnessSeconds: value.freshnessSeconds,
    qualityStatus: value.quality.status,
    integrityHash: sanitizedReferenceText(value.integrityHash, 240),
  }));
}

function sanitizedReferenceText(value: string, maxLength: number): string {
  return /^[A-Za-z0-9._:%-]+$/.test(value) && value.length <= maxLength ? value : 'redacted';
}

function observedContextTime(
  context: EvaluationContext | undefined,
  references: readonly AuditDataReference[],
): string | null {
  if (context === undefined) return null;
  const timestamps = references.map(({ observedAt }) => Date.parse(observedAt));
  if (timestamps.length === 0 || timestamps.some((value) => !Number.isFinite(value))) return context.evaluatedAt;
  return new Date(Math.max(...timestamps)).toISOString();
}
