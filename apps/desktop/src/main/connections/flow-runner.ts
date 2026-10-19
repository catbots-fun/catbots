import {
  protectionPlan,
  installProtection,
  type ProtectionState,
} from "./native-protection";
import { perpSize } from "./hyperliquid-precision";
import { FlowAuditStore, type FlowAuditEvent } from './flow-audit';
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  compileFlow,
  runtimeNodePackages,
  type FlowDocument,
  type Fill,
  type OrderPlan,
  type FlowContext,
  type FlowRun,
} from "@catbots/strategy-runtime";
import type { ExecutionTarget, FlowDeployment } from "@catbots/contracts";
import {
  OrderRejectedError,
  type FlowVenue,
  type VenueSnapshot,
} from "./flow-venue";
export function validateExecutableFlow(document: FlowDocument) {
  compileFlow(document, runtimeNodePackages);
  if (
    document.nodes.some((node) => node.type === "strategy.dca") &&
    document.nodes.filter(
      (node) =>
        node.type.startsWith("strategy.") || node.type.startsWith("action."),
    ).length !== 1
  )
    throw new Error(
      "Native DCA protection requires one execution controller per workflow",
    );
  if (
    !document.nodes.some(
      (node) =>
        node.type.startsWith("action.") ||
        ["strategy.dca", "strategy.smart_order", "strategy.directional"].includes(node.type),
    )
  )
    throw new Error("Workflow needs an order action");
  for (const node of document.nodes)
    if (
      (node.type.startsWith("strategy.") &&
        !["strategy.dca", "strategy.smart_order", "strategy.directional"].includes(node.type)) ||
      node.type.startsWith("process.orders_") ||
      node.type === "output.persist"
    )
      throw new Error(
        `Node ${node.id} (${node.type}) requires a runtime capability not supported yet`,
      );
}
export function validateFlowTarget(
  document: FlowDocument,
  target: ExecutionTarget,
  environment: "production" | "testnet" = "production",
) {
  validateExecutableFlow(document);
  const directional = document.nodes.filter(node => node.type === "strategy.directional");
  if (directional.length) {
    if (environment !== "testnet") throw new Error("Long/Short controller is Testnet only; native exchange protection is not supported yet");
    if (directional.length !== 1 || document.nodes.filter(node => node.type.startsWith("strategy.") || node.type.startsWith("action.")).length !== 1) throw new Error("Long/Short controller must own the only order path");
    for (const node of directional) {
      const quote = Number(node.config.quotePerOrder);
      if (quote < 12) throw new Error("Use at least $12 per order to allow for lot rounding above the $10 minimum");
      if (quote * 1.006 > Math.min(target.maxOrderUsd, target.maxPositionUsd)) throw new Error(`${node.id}: order size including price tolerance exceeds the target limits`);
    }
  }
  for (const node of document.nodes) {
    if (node.type === "strategy.dca") {
      if((node.config.side==='short'&&Number(node.config.takeProfitPercent)>=100)||(node.config.side!=='short'&&Number(node.config.stopLossPercent)>=100))throw new Error(`${node.id}: native trigger must have a positive price`);
      const maximum =
        Number(node.config.quotePerOrder) *
        Math.pow(
          Number(node.config.volumeMultiplier ?? 1),
          Number(node.config.maxExtraOrders ?? 0),
        );
      if (maximum * 1.006 > target.maxOrderUsd)
        throw new Error(
          `${node.id}: order size including price tolerance exceeds target $${target.maxOrderUsd}`,
        );
    }
    if (
      node.type.startsWith("strategy.") &&
      Number(node.config.maxNotional) > target.maxPositionUsd
    )
      throw new Error(
        `${node.id}: maxNotional exceeds target $${target.maxPositionUsd}`,
      );
  }
}
function requireProtectionCapability(document: FlowDocument, environment: 'production' | 'testnet', venue: FlowVenue, savedProtection: boolean) {
  const required = savedProtection || (environment === 'production' && document.nodes.some(node => node.type === 'strategy.dca'));
  if (!required && !venue.protection) return;
  const capability = venue.protection;
  if (!capability || typeof capability.submitProtection !== 'function'
    || typeof capability.inspectProtection !== 'function' || typeof capability.cancelProtection !== 'function') {
    throw new Error('Native protection is required but unsupported by this execution adapter. No exchange request was sent.');
  }
}

function hasRiskEvaluation(node: FlowDocument['nodes'][number]) {
  return node.type === 'strategy.dca' || node.type === 'strategy.directional';
}

export function guardOrder(
  order: OrderPlan,
  snapshot: VenueSnapshot,
  target: ExecutionTarget,
): OrderPlan {
  if (
    snapshot.context.market !== target.market ||
    !Number.isFinite(snapshot.context.price) ||
    snapshot.context.price <= 0 ||
    ![snapshot.position, snapshot.available].every(Number.isFinite) ||
    !Number.isInteger(snapshot.sizeDecimals) ||
    snapshot.sizeDecimals < 0 ||
    snapshot.sizeDecimals > 6
  )
    throw new Error("Invalid market or account snapshot");
  if (order.limitPrice !== undefined)
    throw new Error("Only market IOC orders are supported");
  const quantity = perpSize(order.quantity, snapshot.sizeDecimals);
  if (!Number.isFinite(quantity) || quantity <= 0)
    throw new Error("Order quantity is below market precision");
  const notional = quantity * snapshot.context.price * 1.006;
  if (
    !order.reduceOnly &&
    (notional > target.maxOrderUsd || quantity * snapshot.context.price < 10)
  )
    throw new Error("Order outside configured limit or exchange minimum");
  const signed = order.side === "buy" ? quantity : -quantity;
  if (order.reduceOnly) {
    if (
      snapshot.position * signed >= 0 ||
      quantity > Math.abs(snapshot.position)
    )
      throw new Error("Reduce-only order does not match current position");
  } else if (
    Math.abs(snapshot.position + signed) * snapshot.context.price * 1.006 >
      target.maxPositionUsd ||
    notional > snapshot.available
  )
    throw new Error("Position or collateral limit exceeded");
  if (snapshot.openOrders)
    throw new Error(
      "Existing open orders must be resolved before running this bot",
    );
  return { ...order, quantity };
}
type Stored = {
  view: FlowDeployment;
  document: FlowDocument;
  target: ExecutionTarget;
  state: Record<string, unknown>;
  fills: Fill[];
  cancelled?: string[];
  lastBucket: number;
  protection?: ProtectionState;
  protectionGeneration?: number;
  protectionSeen?: string[];
  nativePartial?: boolean;
  nativeCompleted?: boolean;
  nativeExitPending?: boolean;
  queued?: string[];
  pending?: string;
  pendingOrder?: OrderPlan;
  expectedPosition?: number;
  lastRiskAt?: number;
  manualClose?: boolean;
};
export class FlowRunner {
  private audit: FlowAuditStore;
  private reconciling = new Set<string>();
  private archives: Stored[] = [];
  private records: Record<string, Stored> = {};
  private active = new Map<
    string,
    {
      venue: FlowVenue;
      timer?: ReturnType<typeof setTimeout>;
      task?: Promise<void>;
      stop: boolean;
      observedSince: number;
      heartbeatAt?: number;
      snapshotReceivedAt?: number;
      evaluate: ReturnType<typeof compileFlow>;
    }
  >();
  constructor(private path: string) {
    this.audit = new FlowAuditStore(`${path}.audit.sqlite`);
    if (existsSync(`${path}.history`))
      this.archives = JSON.parse(readFileSync(`${path}.history`, "utf8"));
    if (existsSync(path)) this.records = JSON.parse(readFileSync(path, "utf8"));
    const interrupted: Stored[] = [];
    for (const item of Object.values(this.records))
      if (item.view.status === "running" || item.view.status === "stopping") {
        item.cancelled = [
          ...new Set([
            ...(item.cancelled ?? []),
            ...(item.queued ?? []).filter(
              (id) => id !== item.pendingOrder?.clientOrderId,
            ),
          ]),
        ];
        item.queued = [];
        item.view.status = "interrupted";
        item.view.error =
          "Backend restarted. Review account orders and positions before starting again.";
        interrupted.push(item);
      }
    this.persist();
    for (const item of interrupted) this.safetyAudit(item, 'lifecycle', { event: 'interrupted', status: item.view.status, pending: item.pending });
  }
  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.records), {
      mode: 0o600,
    });
    renameSync(`${this.path}.tmp`, this.path);
  }
  history(botId: string) {
    return this.archives
      .filter((item) => item.view.botId === botId)
      .map((item) => structuredClone(item.view));
  }
  auditSummary(botId: string) { return this.audit.summary(botId); }
  auditHistory(botId: string, after = 0, limit = 50, through?: number) {
    return this.audit.list(botId, after, limit, through);
  }
  private auditEvent(record: Stored, kind: FlowAuditEvent['kind'], details: unknown) {
    this.audit.append({ botId: record.view.botId, deploymentId: record.view.id, version: record.view.version, kind, details });
  }
  /** Logging must never interrupt a stop, recovery or mandatory protection action. */
  private safetyAudit(record: Stored, kind: FlowAuditEvent['kind'], details: unknown) {
    try { this.auditEvent(record, kind, details); }
    catch {
      record.view.auditWarning = 'Some audit events could not be saved. History may be incomplete; review exchange orders and positions.';
      // Best effort only: an unavailable disk must not replace the financial error.
      try { this.persist(); } catch { /* The warning remains visible in memory. */ }
    }
  }
  get(botId: string) {
    return this.records[botId]
      ? { ...structuredClone(this.records[botId].view), health: this.health(botId), entryPauseSupported: this.records[botId].document.nodes.some(hasRiskEvaluation), closePositionSupported: this.supportsClose(this.records[botId]) }
      : undefined;
  }
  deployments() { return Object.keys(this.records).map(botId => this.get(botId)!); }
  private health(botId: string): NonNullable<FlowDeployment['health']> {
    const record = this.records[botId];
    const active = this.active.get(botId);
    const recovery = this.reconciling.has(botId) || (active && record.pending) ? 'pending'
      : record.pending || (record.manualClose && record.view.closeResult !== 'closed') || ['failed', 'interrupted'].includes(record.view.status) ? 'required' : 'not-assessed';
    if (!active) return { state: 'inactive', recovery };
    const age = Date.now() - (active.heartbeatAt ?? active.observedSince);
    return {
      state: age < 0 || age > 15000 ? 'stalled' : active.snapshotReceivedAt === undefined ? 'waiting' : 'responsive',
      recovery,
      ...(active.heartbeatAt === undefined ? {} : { heartbeatAt: new Date(active.heartbeatAt).toISOString() }),
      ...(active.snapshotReceivedAt === undefined ? {} : { snapshotReceivedAt: new Date(active.snapshotReceivedAt).toISOString() }),
    };
  }
  private supportsClose(record: Stored) {
    return record.view.environment === 'testnet' && !record.protection && record.document.nodes.some(node => node.type === 'strategy.directional');
  }
  private accountReserved(target: ExecutionTarget, environment: string, except: string) {
    return [...new Set([...this.active.keys(), ...this.reconciling])].some(id => {
      const other = this.records[id];
      return id !== except && other && other.view.environment === environment &&
        (other.target.accountId === target.accountId || other.target.connectionId === target.connectionId);
    });
  }
  private accountUnresolved(target: ExecutionTarget, environment: string) {
    return Object.values(this.records).some(other => other.view.environment === environment &&
      (other.target.accountId === target.accountId || other.target.connectionId === target.connectionId) &&
      (other.pending || (other.manualClose && other.view.closeResult !== 'closed')));
  }
  isBusy(botId: string) { return this.active.has(botId) || this.reconciling.has(botId); }
  private acceptCloseResult(record: Stored, fill: Fill | null) {
    const order = record.pendingOrder!;
    if (fill) {
      if (!fill.id || fill.clientOrderId !== order.clientOrderId || fill.side !== order.side ||
          !Number.isFinite(fill.quantity) || fill.quantity <= 0 || fill.quantity > order.quantity + 1e-8 ||
          !Number.isFinite(fill.price) || fill.price <= 0 || !Number.isFinite(fill.fee)) throw new Error('Invalid close fill; reconcile with exchange');
      record.expectedPosition = (record.expectedPosition ?? 0) + (fill.side === 'buy' ? fill.quantity : -fill.quantity);
      if (Math.abs(record.expectedPosition) < 1e-10) record.expectedPosition = 0;
      record.view.position = record.expectedPosition;
    }
    Object.assign(record.view.orders.at(-1)!, { status: fill ? 'filled' : 'cancelled', quantity: fill?.quantity, price: fill?.price, fee: fill?.fee, side: order.side, exchangeOrderId: fill?.id });
    record.pending = undefined; record.pendingOrder = undefined;
    record.view.closeResult = 'needs-attention'; record.view.status = 'stopped';
    this.persist();
    this.safetyAudit(record, 'order_outcome', { source: 'manual_close', order: record.view.orders.at(-1), position: record.view.position });
  }
  private async verifyClose(record: Stored, venue: FlowVenue) {
    const snapshot = await venue.snapshot([]);
    if (snapshot.context.market !== record.target.market || !Number.isFinite(snapshot.position) ||
        !Number.isFinite(record.expectedPosition) || Math.abs(snapshot.position - record.expectedPosition!) > 1e-8 || snapshot.openOrders !== 0)
      throw new Error('Close verification differs from confirmed inventory or has open orders; inspect exchange');
    record.view.closeResult = snapshot.position === 0 ? 'closed' : 'needs-attention';
    record.view.status = 'stopped';
    record.view.error = snapshot.position === 0 ? undefined : 'Position remains open. Review the exchange before confirming another close.';
    this.persist();
    this.safetyAudit(record, 'lifecycle', { event: 'close_verified', result: record.view.closeResult, position: snapshot.position });
  }
  async closePosition(botId: string, deploymentId: string, confirmation: string, venue: FlowVenue) {
    const record = this.records[botId];
    if (!record || record.view.id !== deploymentId) throw new Error('Deployment changed; refresh before closing');
    if (!this.supportsClose(record)) throw new Error('Close position is supported only for directional Testnet deployments without native protection');
    if (confirmation !== `CLOSE ${record.target.market}`) throw new Error('Exact market confirmation required');
    if (this.reconciling.has(botId) || this.accountReserved(record.target, record.view.environment, botId)) throw new Error('Account operation already in progress');
    if (Object.values(this.records).some(other => other.pending && !(other === record && this.active.has(botId)) && other.view.environment === record.view.environment &&
        (other.target.accountId === record.target.accountId || other.target.connectionId === record.target.connectionId))) throw new Error('Account has an unresolved order; reconcile before closing');
    if ([...Object.values(this.records), ...this.archives].some(other => other !== record && other.view.environment === record.view.environment &&
        (other.target.accountId === record.target.accountId || other.target.connectionId === record.target.connectionId) &&
        (other.pending || (other.manualClose && other.view.closeResult !== 'closed') || other.expectedPosition !== 0)))
      throw new Error('Account ownership is ambiguous; inspect other deployments before closing');
    this.reconciling.add(botId);
    try {
      await this.stop(botId);
      if (record.pending) throw new Error('Order outcome unresolved; reconcile before closing');
      const snapshot = await venue.snapshot([]);
      if (!Number.isFinite(record.expectedPosition) || !Number.isFinite(snapshot.position) || Math.abs(snapshot.position - record.expectedPosition!) > 1e-8 || snapshot.context.market !== record.target.market)
        throw new Error('Account position changed outside this deployment');
      if (snapshot.openOrders !== 0) throw new Error('Resolve open orders before closing');
      record.manualClose = true;
      record.view.entriesPaused = true;
      record.view.closeResult = 'needs-attention';
      this.persist();
      if (snapshot.position === 0) {
        await this.verifyClose(record, venue);
        return this.get(botId)!;
      }
      const cloid = `0x${randomUUID().replaceAll('-', '')}` as `0x${string}`;
      const order = guardOrder({ clientOrderId: cloid, side: snapshot.position > 0 ? 'sell' : 'buy', quantity: Math.abs(snapshot.position), reduceOnly: true, purpose: 'exit' }, snapshot, record.target);
      this.auditEvent(record, 'order_intent', { source: 'manual_close', cloid, order });
      record.pending = cloid; record.pendingOrder = order;
      record.view.status = 'stopping'; record.view.closeResult = 'pending';
      record.view.orders.push({ id: cloid, status: 'submitting', at: new Date().toISOString() });
      this.persist();
      const fill = await venue.place(order, cloid, snapshot);
      this.acceptCloseResult(record, fill);
      await this.verifyClose(record, venue);
      return this.get(botId)!;
    } catch (error) {
      if (record.manualClose) {
        if (record.pending) {
          record.view.orders.at(-1)!.status = error instanceof OrderRejectedError ? 'rejected' : 'uncertain';
          if (error instanceof OrderRejectedError) { record.pending = undefined; record.pendingOrder = undefined; }
        }
        record.view.status = 'failed'; record.view.closeResult = 'needs-attention';
        record.view.error = error instanceof Error ? error.message : 'Close failed';
        this.persist();
        this.safetyAudit(record, 'failure', { source: 'manual_close', pending: record.pending, error: record.view.error });
      }
      throw error;
    } finally { this.reconciling.delete(botId); }
  }
  setEntriesPaused(botId: string, deploymentId: string, paused: boolean) {
    const record = this.records[botId];
    if (!record || !this.active.has(botId) || record.view.status !== 'running') throw new Error('Bot must be running');
    if (record.view.id !== deploymentId) throw new Error('Deployment changed; refresh before changing entry controls');
    if (!record.document.nodes.some(hasRiskEvaluation)) throw new Error('Entry pause requires a DCA or directional controller');
    // Resuming can authorize new exposure; require audit storage before changing it.
    if (!paused) this.auditEvent(record, 'lifecycle', { event: 'entries_resume_requested' });
    const previous = record.view.entriesPaused;
    record.view.entriesPaused = paused;
    try { this.persist(); }
    catch (error) {
      if (!paused) record.view.entriesPaused = previous;
      throw error;
    }
    this.safetyAudit(record, 'lifecycle', { event: paused ? 'entries_paused' : 'entries_resumed' });
    return this.get(botId)!;
  }
  async start(
    botId: string,
    version: number,
    document: FlowDocument,
    target: ExecutionTarget,
    environment: "production" | "testnet",
    venue: FlowVenue,
  ) {
    if (this.active.has(botId) || this.reconciling.has(botId))
      throw new Error("Bot is already running or reconciling");
    if (this.accountReserved(target, environment, botId)) throw new Error('Another operation is using this account');
    if (this.accountUnresolved(target, environment)) throw new Error('Account has an unresolved order or close; reconcile before starting');
    if (this.records[botId]?.manualClose && this.records[botId].view.closeResult !== 'closed') throw new Error('Verify the previous close before starting a new deployment');
    if (this.records[botId]?.pending)
      throw new Error(
        "Previous order outcome is unresolved. Exchange reconciliation is required before restart.",
      );
    validateFlowTarget(document, target, environment);
    requireProtectionCapability(document, environment, venue, !!this.records[botId]?.protection);
    for (const other of Object.values(this.records))
      if (
        other.pending &&
        other.view.environment === environment &&
        (other.target.accountId === target.accountId ||
          other.target.connectionId === target.connectionId)
      )
        throw new Error("Account has an unresolved order");
    for (const [id] of this.active) {
      const other = this.records[id];
      if (
        other.view.environment === environment &&
        (other.target.accountId === target.accountId ||
          other.target.connectionId === target.connectionId)
      )
        throw new Error("Another bot is using this account");
    }
    const initial = await venue.snapshot(this.timeframes(document));
    if (this.foreignOrders(botId, initial))
      throw new Error("Resolve unrelated open orders first");
    if (this.records[botId]?.nativePartial && initial.position !== 0)
      throw new Error(
        "Partial native exit requires reconciliation before resuming",
      );
    if (this.records[botId]?.protection && venue.protection) {
      if (!(await this.syncProtection(this.records[botId], venue, initial)))
        return this.get(botId)!;
    }
    if (initial.available <= 0 || !Number.isFinite(initial.available))
      throw new Error("No available collateral");
    // Recheck after asynchronous preflight to prevent duplicate starts.
    if (
      this.active.has(botId) || this.reconciling.has(botId) || this.accountReserved(target, environment, botId) || this.accountUnresolved(target, environment) ||
      [...this.active.keys()].some(
        (id) =>
          this.records[id].view.environment === environment &&
          (this.records[id].target.accountId === target.accountId ||
            this.records[id].target.connectionId === target.connectionId),
      )
    )
      throw new Error("Account already running");
    // Hold the account across the final asynchronous protection initialization.
    // A close must not stop an empty active slot just before start installs it.
    this.reconciling.add(botId);
    try {
    const prior = this.records[botId];
    const same =
      prior &&
      !prior.manualClose &&
      !prior.nativeCompleted &&
      prior.view.version === version &&
      JSON.stringify(prior.document) === JSON.stringify(document) &&
      JSON.stringify(prior.target) === JSON.stringify(target) &&
      prior.view.environment === environment;
    if (same && prior.expectedPosition !== undefined) {
      if (Math.abs(initial.position - prior.expectedPosition) > 1e-8)
        throw new Error(
          "Account position changed outside this deployment. Reconcile before resuming.",
        );
      prior.view.status = "running";
      delete prior.view.error;
    } else {
      if (initial.position !== 0)
        throw new Error(
          "A new workflow requires a flat market position. Resume the original deployment or close the position first.",
        );
      if (prior) {
        this.archives.push(structuredClone(prior));
        writeFileSync(
          `${this.path}.history.tmp`,
          JSON.stringify(this.archives),
          { mode: 0o600 },
        );
        renameSync(`${this.path}.history.tmp`, `${this.path}.history`);
      }
      const view: FlowDeployment = {
        id: randomUUID(),
        botId,
        version,
        environment,
        target: structuredClone(target),
        status: "running",
        startedAt: new Date().toISOString(),
        cycles: 0,
        orders: [],
        events: [],
        position: 0,
      };
      this.records[botId] = {
        view,
        document: structuredClone(document),
        target: structuredClone(target),
        state: {},
        fills: [],
        lastBucket: -1,
        expectedPosition: 0,
      };
    }
    await this.syncProtection(this.records[botId], venue, initial);
    this.persist();
    try {
      this.auditEvent(this.records[botId], 'lifecycle', { event: same ? 'resumed' : 'started', status: 'running', environment, market: target.market });
    } catch {
      this.records[botId].view.status = 'failed';
      this.records[botId].view.error = 'Cannot start: audit journal unavailable.';
      this.persist();
      throw new Error('Cannot start: audit journal unavailable.');
    }
    this.active.set(botId, {
      venue,
      stop: false,
      observedSince: Date.now(),
      evaluate: compileFlow(document, runtimeNodePackages, true),
    });
    this.schedule(botId);
    return this.get(botId)!;
    } finally { this.reconciling.delete(botId); }
  }
  private timeframes(doc: FlowDocument) {
    return [
      ...new Set(
        doc.nodes
          .filter(
            (node) =>
              node.type === "data.candles" || node.type === "data.candle_items",
          )
          .map((node) => String(node.config.timeframe)),
      ),
    ];
  }
  private schedule(botId: string) {
    const active = this.active.get(botId);
    if (!active || active.stop) return;
    active.timer = setTimeout(() => {
      active.task = this.tick(botId)
        .catch(() => {
          active.stop = true;
          this.active.delete(botId);
        })
        .finally(() => {
          active.task = undefined;
          if (!active.stop) this.schedule(botId);
        });
    }, 1000);
  }
  private async tick(botId: string) {
    const active = this.active.get(botId)!;
    active.heartbeatAt = Date.now();
    const record = this.records[botId];
    try {
      const times = this.timeframes(record.document);
      const interval = times.length
        ? Math.min(
            ...times.map(
              (value) =>
                parseInt(value) *
                (value.endsWith("m")
                  ? 60000
                  : value.endsWith("h")
                    ? 3600000
                    : 86400000),
            ),
          )
        : 60000;
      const bucket = Math.floor(Date.now() / interval);
      const signal = record.lastBucket !== bucket;
      if (
        !signal &&
        (Date.now() - (record.lastRiskAt ?? 0) < 5000 ||
          !record.document.nodes.some(hasRiskEvaluation))
      )
        return;
      const snapshot = await active.venue.snapshot(signal ? times : []);
      if (active.stop) return;
      active.snapshotReceivedAt = Date.now();
      active.heartbeatAt = Date.now();
      if (!(await this.syncProtection(record, active.venue, snapshot))) {
        active.stop = true;
        this.active.delete(botId);
        return;
      }
      const context = {
        ...snapshot.context,
        nativeProtection: !!active.venue.protection,
        runId: `${record.view.id}:${bucket}`,
        deploymentId: record.view.id,
        fills: record.fills,
        cancelledOrderIds: record.cancelled ?? [],
      };
      if (
        record.expectedPosition !== undefined &&
        Math.abs(snapshot.position - record.expectedPosition) > 1e-8
      )
        throw new Error("Account position changed outside this deployment");
      const evaluateSignal = signal && !record.view.entriesPaused;
      const run = evaluateSignal
        ? active.evaluate(context, record.state)
        : this.riskRun(record, context);
      this.auditEvent(record, 'evaluation', {
        runId: context.runId, source: evaluateSignal ? 'signal' : 'risk', entriesPaused: !!record.view.entriesPaused,
        market: context.market, evaluatedAt: context.at,
        trace: run.trace, orders: run.orders, cancelOrderIds: run.cancelOrderIds,
      });
      record.lastRiskAt = Date.now();
      record.view.riskCheckedAt = new Date().toISOString();
      if (run.cancelOrderIds.length)
        throw new Error("Resting order controllers are not supported");
      if (run.orders.length > 10)
        throw new Error("Too many orders in one evaluation");
      record.state = run.state;
      record.fills = [];
      record.cancelled = [];
      if (signal) record.lastBucket = bucket;
      record.view.cycles++;
      record.view.lastRunAt = new Date().toISOString();
      record.queued = run.orders.map((order) => order.clientOrderId);
      record.view.trace = run.trace;
      record.view.events = run.trace
        .map((node) => `${node.nodeId}: ${node.status}`)
        .slice(0, 200);
      this.persist();
      for (const proposal of run.orders) {
        if (active.stop) break;
        const fresh = await active.venue.snapshot([]);
        if (active.stop) break;
        if (record.view.entriesPaused && !proposal.reduceOnly) {
          record.cancelled!.push(proposal.clientOrderId);
          record.queued = record.queued?.filter(id => id !== proposal.clientOrderId);
          this.persist();
          this.safetyAudit(record, 'order_outcome', { runId: context.runId, clientOrderId: proposal.clientOrderId, status: 'not_submitted', reason: 'entries_paused' });
          continue;
        }
        const order = guardOrder(
          proposal,
          { ...fresh, openOrders: this.foreignOrders(botId, fresh) },
          record.target,
        );
        const cloid =
          `0x${createHash("sha256").update(proposal.clientOrderId).digest("hex").slice(0, 32)}` as `0x${string}`;
        this.auditEvent(record, 'order_intent', { runId: context.runId, cloid, order, risk: 'passed' });
        record.pending = cloid;
        record.pendingOrder = order;
        record.view.orders.push({
          id: cloid,
          status: "submitting",
          at: new Date().toISOString(),
        });
        this.persist();
        const fill = await active.venue.place(order, cloid, fresh);
        if (fill) {
          record.fills.push(fill);
          record.expectedPosition =
            (record.expectedPosition ?? fresh.position) +
            (fill.side === "buy" ? fill.quantity : -fill.quantity);
          record.view.position = record.expectedPosition;
        }
        record.cancelled!.push(proposal.clientOrderId);
        record.view.orders[record.view.orders.length - 1] = {
          id: cloid,
          status: fill ? "filled" : "cancelled",
          at: new Date().toISOString(),
          quantity: fill?.quantity,
          price: fill?.price,
          fee: fill?.fee,
          side: order.side,
          exchangeOrderId: fill?.id,
        };
        record.pending = undefined;
        record.pendingOrder = undefined;
        record.queued = record.queued?.filter(
          (id) => id !== proposal.clientOrderId,
        );
        this.persist();
        const outcome = { runId: context.runId, cloid, ...record.view.orders[record.view.orders.length - 1] };
        let protectedPosition = true;
        if (active.venue.protection) {
          const after = await active.venue.snapshot([]);
          protectedPosition = await this.syncProtection(record, active.venue, after);
        }
        // Confirmed inventory must receive native protection even if audit storage fails.
        this.auditEvent(record, 'order_outcome', outcome);
        if (!protectedPosition) {
          active.stop = true;
          this.active.delete(botId);
          return;
        }
      }
    } catch (error) {
      record.cancelled = [
        ...new Set([
          ...(record.cancelled ?? []),
          ...(record.queued ?? []).filter(
            (id) => id !== record.pendingOrder?.clientOrderId,
          ),
        ]),
      ];
      record.queued = [];
      record.view.status = "failed";
      if (record.pending && record.view.orders.length) {
        record.view.orders[record.view.orders.length - 1].status =
          error instanceof OrderRejectedError ? "rejected" : "uncertain";
        if (error instanceof OrderRejectedError) {
          record.cancelled ??= [];
          if (record.pendingOrder)
            record.cancelled.push(record.pendingOrder.clientOrderId);
          record.pending = undefined;
          record.pendingOrder = undefined;
        }
      }
      record.view.error =
        error instanceof Error ? error.message : "Runtime failed";
      active.stop = true;
      this.active.delete(botId);
      this.persist();
      // Audit failure must not erase the recovery journal or trigger a resend.
      try { this.auditEvent(record, 'failure', { error: record.view.error, pending: record.pending, status: record.view.status }); } catch { /* Runtime is already stopped; preserve recovery evidence. */ }
    }
  }
  connectionRunning(connectionId: string) {
    return [...new Set([...this.active.keys(), ...this.reconciling])].some(
      (id) => this.records[id].target.connectionId === connectionId,
    );
  }
  foreignOrders(botId: string, snapshot: VenueSnapshot) {
    const protection = this.records[botId]?.protection;
    if (!protection || !snapshot.openOrderIds) return snapshot.openOrders;
    const owned = new Set(
      [...protection.orders, ...protection.retiring].map(
        (order) => order.exchangeId,
      ),
    );
    return snapshot.openOrderIds.filter((id) => !owned.has(id)).length;
  }
  private protectionEvidence(record: Stored) {
    return { protection: record.view.protection, state: record.protection, position: record.view.position,
      status: record.view.status, latestOrder: record.view.orders.at(-1) };
  }
  private async syncProtection(
    record: Stored,
    venue: FlowVenue,
    snapshot: VenueSnapshot,
  ): Promise<boolean> {
    const before = JSON.stringify(this.protectionEvidence(record));
    try {
      const result = await this.syncProtectionState(record, venue, snapshot);
      if (before !== JSON.stringify(this.protectionEvidence(record))) this.safetyAudit(record, 'protection', {
        event: 'synchronized', ...this.protectionEvidence(record),
      });
      return result;
    } catch (error) {
      if (venue.protection && record.document.nodes.some(node => node.type === 'strategy.dca')) this.safetyAudit(record, 'protection', {
        event: 'failed', protection: record.view.protection, state: record.protection,
        position: record.view.position, error: error instanceof Error ? error.message : 'Protection failed',
      });
      throw error;
    }
  }
  private async syncProtectionState(
    record: Stored,
    venue: FlowVenue,
    snapshot: VenueSnapshot,
  ): Promise<boolean> {
    const node = record.document.nodes.find(
      (node) => node.type === "strategy.dca",
    );
    if (!node || !venue.protection) return true;
    let previous = JSON.stringify(this.protectionEvidence(record));
    const persist = () => {
      record.view.protection = {
        mode: "exchange",
        status: record.protection?.orders.every(
          (order) => order.state === "open",
        )
          ? "protected"
          : "needs-attention",
        orders: [
          ...(record.protection?.orders ?? []),
          ...(record.protection?.retiring ?? []),
        ].map((order) => ({
          id: order.cloid,
          kind: order.kind,
          triggerPrice: order.triggerPrice,
          status: order.state,
        })),
      };
      this.persist();
      const next = JSON.stringify(this.protectionEvidence(record));
      if (next !== previous) {
        this.safetyAudit(record, 'protection', { event: 'transition', ...this.protectionEvidence(record) });
        previous = next;
      }
    };
    let executed = record.nativeExitPending ?? false;
    if (record.protection) {
      for (const order of [
        ...record.protection.orders,
        ...record.protection.retiring,
      ]) {
        if (order.state === "planned") continue;
        const status = await venue.protection.inspectProtection(order);
        order.state = status.state;
        order.exchangeId = status.exchangeId ?? order.exchangeId;
        persist();
        if (status.state === "unknown")
          throw new Error(
            "Native protection outcome unknown. Reconcile with exchange.",
          );
        if (status.fill && !record.protectionSeen?.includes(status.fill.id)) {
          const fill = status.fill;
          record.protectionSeen ??= [];
          record.protectionSeen.push(fill.id);
          record.expectedPosition =
            (record.expectedPosition ?? 0) +
            (fill.side === "buy" ? fill.quantity : -fill.quantity);
          record.view.position = record.expectedPosition;
          record.view.orders.push({
            id: order.cloid,
            status: "filled",
            at: new Date().toISOString(),
            quantity: fill.quantity,
            price: fill.price,
            fee: fill.fee,
            side: fill.side,
            exchangeOrderId: fill.id,
          });
          executed = true;
          record.nativeExitPending = true;
          persist();
        }
      }
    }
    if (
      record.expectedPosition !== undefined &&
      Math.abs(snapshot.position - record.expectedPosition) > 1e-8
    )
      throw new Error(
        "Position differs from confirmed native/entry fills. Reconcile before continuing.",
      );
    if (snapshot.position === 0) {
      if (record.protection) {
        for (const order of [
          ...record.protection.orders,
          ...record.protection.retiring,
        ])
          if (order.state === "open")
            await venue.protection.cancelProtection(order);
        record.protection = undefined;
        record.view.protection = {
          mode: "exchange",
          status: "flat",
          orders: [],
        };
      }
      if (executed || record.nativePartial) {
        record.state = {};
        record.fills = [];
        record.cancelled = [];
        record.nativePartial = false;
        record.nativeCompleted = true;
        record.nativeExitPending = false;
        record.lastBucket = -1;
        record.view.status = "stopped";
        record.view.error =
          "Native protection closed the position. Start/resume to begin another cycle.";
        this.persist();
        return false;
      }
      this.persist();
      return true;
    }
    if (
      !Number.isFinite(snapshot.entryPrice) ||
      !snapshot.entryPrice ||
      snapshot.entryPrice <= 0
    )
      throw new Error("Exchange entry price required for native protection");
    if (record.protection?.orders.some((order) => order.state === "planned"))
      await installProtection(record.protection, venue.protection, persist);
    const current = record.protection;
    const changed =
      !current ||
      Math.abs(current.quantity - Math.abs(snapshot.position)) > 1e-8 ||
      Math.abs(current.entry - snapshot.entryPrice) > 1e-8 ||
      current.orders.some((order) => order.state === "terminal");
    if (changed) {
      const next = protectionPlan(
        record.view.id,
        Math.max(record.protectionGeneration ?? 0, current?.generation ?? 0) + 1,
        snapshot.position,
        snapshot.entryPrice,
        Number(node.config.takeProfitPercent),
        Number(node.config.stopLossPercent),
      );
      next.retiring = current
        ? [...current.orders, ...current.retiring].filter(
            (order) => order.state === "open",
          )
        : [];
      record.protectionGeneration = next.generation;
      record.protection = next;
      persist();
      await installProtection(next, venue.protection, persist);
    }
    if (executed) {
      record.nativePartial = true;
      record.nativeExitPending = false;
      record.view.status = "failed";
      record.view.error =
        "Native order partially closed the position. Remaining size is protected; reconcile before resuming.";
      persist();
      return false;
    }
    return true;
  }
  private riskRun(record: Stored, context: FlowContext): FlowRun {
    const run: FlowRun = {
      runId: context.runId,
      market: context.market,
      at: context.at,
      state: structuredClone(record.state),
      orders: [],
      cancelOrderIds: [],
      trace: [],
    };
    for (const node of record.document.nodes.filter(hasRiskEvaluation)) {
      const definition = runtimeNodePackages
        .flatMap((pkg) => pkg.definitions)
        .find((def) => def.type === node.type)!;
      const input: Parameters<typeof definition.evaluate>[0] = node.type === 'strategy.dca' ? {
        signal: {
          type: "condition" as const,
          quality: "ready" as const,
          value: false,
        },
      } : {};
      const result = definition.evaluate(
        input,
        definition.config.parse(node.config),
        { ...context, evaluationMode: "risk" },
        run.state[node.id],
        node.id,
      );
      if (result.state !== undefined) run.state[node.id] = result.state;
      run.orders.push(...(result.orders ?? []));
      run.cancelOrderIds.push(...(result.cancelOrderIds ?? []));
      run.trace.push({
        nodeId: node.id,
        status: "executed",
        inputs: input,
        outputs: result.outputs,
      });
    }
    return run;
  }
  async reconcile(botId: string, venue: FlowVenue) {
    if (this.reconciling.has(botId))
      throw new Error("Reconciliation already in progress");
    const targetRecord = this.records[botId];
    if (targetRecord && this.accountReserved(targetRecord.target, targetRecord.view.environment, botId)) throw new Error('Another operation is using this account');
    this.reconciling.add(botId);
    const record = this.records[botId];
    let accepted = false;
    const pending = record?.pending;
    try {
      if (this.active.has(botId))
        throw new Error("Stop the bot before reconciling");
      accepted = !!record;
      if (record) this.safetyAudit(record, 'reconciliation', { event: 'requested', pending });
      if (record?.manualClose) {
        if (record.pending) {
          if (!record.pendingOrder || !venue.reconcile) throw new Error('Pending close requires exchange reconciliation');
          const fill = await venue.reconcile(record.pendingOrder, record.pending as `0x${string}`);
          if (fill === undefined) throw new Error('Exchange has not confirmed a terminal outcome. No order was resent.');
          this.acceptCloseResult(record, fill);
        }
        await this.verifyClose(record, venue);
        this.safetyAudit(record, 'reconciliation', { event: 'completed', source: 'manual_close', pending, result: record.view.closeResult });
        return this.get(botId);
      }
      if (record) requireProtectionCapability(record.document, record.view.environment, venue, !!record.protection);
      if (record?.protection && venue.protection)
        await this.syncProtection(record, venue, await venue.snapshot([]));
      if (!record?.pending) {
        if (
          record?.view.protection?.status === "protected" &&
          !record.nativePartial
        ) {
          record.view.status = "stopped";
          delete record.view.error;
          this.persist();
        }
        if (record) this.safetyAudit(record, 'reconciliation', { event: 'completed', status: record.view.status, pending, outcome: 'no_pending_order' });
        return this.get(botId);
      }
      if (!record.pendingOrder || !venue.reconcile)
        throw new Error(
          "This legacy pending order requires manual reconciliation",
        );
      const fill = await venue.reconcile(
        record.pendingOrder,
        record.pending as `0x${string}`,
      );
      if (fill === undefined)
        throw new Error(
          "Exchange has not confirmed a terminal outcome. No order was resent.",
        );
      if (fill) {
        record.fills.push(fill);
        record.expectedPosition =
          (record.expectedPosition ?? 0) +
          (fill.side === "buy" ? fill.quantity : -fill.quantity);
        record.view.position = record.expectedPosition;
      }
      record.cancelled ??= [];
      record.cancelled.push(record.pendingOrder.clientOrderId);
      Object.assign(record.view.orders.at(-1)!, {
        status: fill ? "filled" : "cancelled",
        quantity: fill?.quantity,
        price: fill?.price,
        fee: fill?.fee,
        side: record.pendingOrder.side,
        exchangeOrderId: fill?.id,
      });
      record.pending = undefined;
      record.pendingOrder = undefined;
      record.view.status = "stopped";
      delete record.view.error;
      this.persist();
      this.safetyAudit(record, 'reconciliation', { event: 'completed', pending, status: record.view.status, order: record.view.orders.at(-1), position: record.view.position });
      return this.get(botId);
    } catch (error) {
      if (accepted && record) this.safetyAudit(record, 'reconciliation', { event: 'failed', pending: record.pending, status: record.view.status, error: error instanceof Error ? error.message : 'Reconciliation failed' });
      throw error;
    } finally {
      this.reconciling.delete(botId);
    }
  }
  async stop(botId: string) {
    const active = this.active.get(botId);
    if (active) {
      active.stop = true;
      clearTimeout(active.timer);
      this.records[botId].view.status = "stopping";
      this.persist();
      this.safetyAudit(this.records[botId], 'lifecycle', { event: 'stop_requested', status: 'stopping', pending: this.records[botId].pending });
      await active.task;
      const record = this.records[botId];
      record.cancelled = [
        ...new Set([
          ...(record.cancelled ?? []),
          ...(record.queued ?? []).filter(
            (id) => id !== record.pendingOrder?.clientOrderId,
          ),
        ]),
      ];
      record.queued = [];
      this.active.delete(botId);
      if (this.get(botId)?.status !== "failed")
        this.records[botId].view.status = "stopped";
      this.persist();
      this.safetyAudit(record, 'lifecycle', { event: 'stopped', status: record.view.status, pending: record.pending, position: record.view.position });
    }
    return this.get(botId);
  }
  async dispose() {
    await Promise.all([...this.active.keys()].map((id) => this.stop(id)));
  }
}
