import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FlowRunner, guardOrder } from "../src/main/connections/flow-runner";
import { FlowAuditStore } from '../src/main/connections/flow-audit';
import type { FlowDocument, OrderPlan } from "@catbots/strategy-runtime";
import type {
  FlowVenue,
  VenueSnapshot,
} from "../src/main/connections/flow-venue";
const paths: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  paths
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true }));
});
const target = {
  botId: "00000000-0000-4000-8000-000000000001",
  connectionId: "00000000-0000-4000-8000-000000000002",
  accountId: "0x" + "1".repeat(40),
  market: "SOL-PERP",
  maxOrderUsd: 50,
  maxPositionUsd: 100,
};
const snapshot: VenueSnapshot = {
  context: {
    market: "SOL-PERP",
    at: Date.now(),
    price: 100,
    equity: 1000,
    candles: {},
    fills: [],
    cancelledOrderIds: [],
  },
  position: 0,
  available: 1000,
  openOrders: 0,
  sizeDecimals: 2,
  asset: 1,
};
const order: OrderPlan = {
  clientOrderId: "test",
  side: "buy",
  quantity: 0.2,
  reduceOnly: false,
  purpose: "entry",
};
const doc: FlowDocument = {
  schemaVersion: "3.0",
  nodes: [
    { id: "tick", type: "trigger.tick", version: 1, config: {} },
    { id: "size", type: "process.number", version: 1, config: { value: 0.2 } },
    {
      id: "buy",
      type: "action.flow_order",
      version: 1,
      config: { side: "buy", reduceOnly: false },
    },
  ],
  edges: [
    { source: "tick", sourcePort: "flow", target: "buy", targetPort: "flow" },
    {
      source: "size",
      sourcePort: "value",
      target: "buy",
      targetPort: "quantity",
    },
  ],
};
function setup(fail = false) {
  const dir = mkdtempSync(join(tmpdir(), "runner-"));
  paths.push(dir);
  let position = 0;
  const venue: FlowVenue = {
    snapshot: vi.fn(async () => ({ ...structuredClone(snapshot), position })),
    place: vi.fn(async (plan) => {
      if (fail) throw new Error("uncertain");
      position += (plan.side === "buy" ? 1 : -1) * plan.quantity;
      return {
        id: "1",
        clientOrderId: plan.clientOrderId,
        quantity: plan.quantity,
        price: 100,
        side: plan.side,
        fee: 0.01,
      };
    }),
  };
  return {
    runner: new FlowRunner(join(dir, "runs")),
    venue,
    path: join(dir, "runs"),
  };
}
it('records start, stop, resume and restart interruption without duplicating interruption on reopen', async () => {
  vi.useFakeTimers();
  const {runner,venue,path}=setup();
  await runner.start(target.botId,1,doc,target,'testnet',venue);
  await runner.stop(target.botId);
  await runner.start(target.botId,1,doc,target,'testnet',venue);
  // Simulate abrupt process loss without invoking graceful stop.
  vi.clearAllTimers();
  const restored=new FlowRunner(path);
  expect(restored.get(target.botId)?.status).toBe('interrupted');
  const events=new FlowRunner(path).auditHistory(target.botId).filter(row=>row.kind==='lifecycle');
  expect(events.map(row=>(row.details as {event:string}).event)).toEqual(['started','stop_requested','stopped','resumed','interrupted']);
});

it('fails closed before scheduling when the start audit cannot be saved',async()=>{
  vi.useFakeTimers();
  const {runner,venue,path}=setup();
  vi.spyOn(FlowAuditStore.prototype,'append').mockImplementation(()=>{throw new Error('private disk path');});
  await expect(runner.start(target.botId,1,doc,target,'testnet',venue)).rejects.toThrow('audit');
  await vi.advanceTimersByTimeAsync(120000);
  expect(venue.place).not.toHaveBeenCalled();
  expect(new FlowRunner(path).get(target.botId)?.status).toBe('failed');
});

it('finishes stop and preserves a sanitized audit warning across restart when journal writes fail',async()=>{
  vi.useFakeTimers();
  const {runner,venue,path}=setup();
  await runner.start(target.botId,1,doc,target,'testnet',venue);
  vi.spyOn(FlowAuditStore.prototype,'append').mockImplementation(()=>{throw new Error('private disk path');});
  await runner.stop(target.botId);
  await vi.advanceTimersByTimeAsync(120000);
  expect(venue.place).not.toHaveBeenCalled();
  const view=new FlowRunner(path).get(target.botId);
  expect(view).toMatchObject({status:'stopped',auditWarning:expect.any(String)});
  expect(JSON.stringify(view)).not.toContain('private disk path');
});

it('waits for an in-flight fill when stopping even if lifecycle writes fail',async()=>{
  vi.useFakeTimers();
  const {runner,venue}=setup();
  let complete!: (fill: import('@catbots/strategy-runtime').Fill)=>void;
  let submitted!: OrderPlan;
  venue.place=vi.fn(async (plan:OrderPlan)=>{submitted=plan;return new Promise<import('@catbots/strategy-runtime').Fill>(resolve=>{complete=resolve;});});
  await runner.start(target.botId,1,doc,target,'testnet',venue);
  await vi.advanceTimersByTimeAsync(1000);
  const append=FlowAuditStore.prototype.append;
  vi.spyOn(FlowAuditStore.prototype,'append').mockImplementation(function(this:FlowAuditStore,event){
    if(event.kind==='lifecycle')throw new Error('disk failure');
    return append.call(this,event);
  });
  const stopped=runner.stop(target.botId);
  expect(runner.get(target.botId)?.status).toBe('stopping');
  complete({id:'confirmed',clientOrderId:submitted.clientOrderId,side:'buy',quantity:0.2,price:100,fee:0.01});
  await stopped;
  expect(runner.get(target.botId)).toMatchObject({status:'stopped',position:0.2,orders:[{status:'filled'}],auditWarning:expect.any(String)});
  await vi.advanceTimersByTimeAsync(120000);
  expect(venue.place).toHaveBeenCalledTimes(1);
});

it('recovers interrupted state despite unavailable audit storage',async()=>{
  vi.useFakeTimers();
  const {runner,venue,path}=setup();
  await runner.start(target.botId,1,doc,target,'testnet',venue);
  vi.clearAllTimers();
  vi.spyOn(FlowAuditStore.prototype,'append').mockImplementation(()=>{throw new Error('disk failure');});
  const restored=new FlowRunner(path);
  expect(restored.get(target.botId)).toMatchObject({status:'interrupted',auditWarning:expect.any(String)});
  expect(venue.place).not.toHaveBeenCalled();
});

it.each(['missing','partial'] as const)('blocks production DCA before exchange access when native protection is %s',async mode=>{
  vi.useFakeTimers();
  const {runner,venue}=setup();
  if(mode==='partial')venue.protection={submitProtection:async()=> 'id'} as never;
  const flow:FlowDocument={schemaVersion:'3.0',nodes:[{id:'dca',type:'strategy.dca',version:1,config:{quotePerOrder:20,maxNotional:50,takeProfitPercent:10,stopLossPercent:5,maxExtraOrders:0,extraStepPercent:2,repeat:true}}],edges:[]};
  flow.nodes.push({id:'n',type:'process.number',version:1,config:{value:1}},{id:'yes',type:'condition.compare',version:1,config:{operator:'eq'}});
  flow.edges.push({source:'n',sourcePort:'value',target:'yes',targetPort:'left'},{source:'n',sourcePort:'value',target:'yes',targetPort:'right'},{source:'yes',sourcePort:'result',target:'dca',targetPort:'signal'});
  await expect(runner.start(target.botId,1,flow,target,'production',venue)).rejects.toThrow('Native protection');
  expect(venue.snapshot).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  expect(venue.place).not.toHaveBeenCalled();
  expect(runner.get(target.botId)).toBeUndefined();
});

it("enforces notional, collateral, position, reduce-only and existing-order constraints", () => {
  expect(guardOrder(order, snapshot, target).quantity).toBe(0.2);
  expect(() => guardOrder({ ...order, quantity: 1 }, snapshot, target)).toThrow(
    "configured",
  );
  expect(() =>
    guardOrder(order, { ...snapshot, available: 1 }, target),
  ).toThrow("collateral");
  expect(() => guardOrder(order, { ...snapshot, position: 1 }, target)).toThrow(
    "Position",
  );
  expect(() =>
    guardOrder({ ...order, reduceOnly: true }, snapshot, target),
  ).toThrow("Reduce-only");
  expect(() =>
    guardOrder(order, { ...snapshot, openOrders: 1 }, target),
  ).toThrow("open orders");
  expect(() =>
    guardOrder({ ...order, limitPrice: 99 }, snapshot, target),
  ).toThrow("IOC");
});
it("evaluates once per interval, records a confirmed fill, and stops scheduling", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T00:00:00Z"));
  const { runner, venue } = setup();
  await runner.start(target.botId, 3, doc, target, "testnet", venue);
  await vi.advanceTimersByTimeAsync(1000);
  expect(venue.place).toHaveBeenCalledTimes(1);
  expect(runner.get(target.botId)).toMatchObject({
    version: 3,
    cycles: 1,
    orders: [{ status: "filled", quantity: 0.2 }],
  });
  await vi.advanceTimersByTimeAsync(10000);
  expect(venue.place).toHaveBeenCalledTimes(1);
  await runner.stop(target.botId);
  await vi.advanceTimersByTimeAsync(120000);
  expect(venue.place).toHaveBeenCalledTimes(1);
  expect(runner.get(target.botId)?.status).toBe("stopped");
});
it("keeps every evaluation and correlated order event after restart", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
  const { runner, venue, path } = setup();
  await runner.start(target.botId, 3, doc, target, 'testnet', venue);
  await vi.advanceTimersByTimeAsync(61000);
  await runner.stop(target.botId);
  const rows = new FlowRunner(path).auditHistory(target.botId);
  expect(rows.filter(row => row.kind === 'evaluation')).toHaveLength(2);
  expect(rows.filter(row => row.kind === 'order_intent')).toHaveLength(2);
  const outcomes = rows.filter(row => row.kind === 'order_outcome');
  expect(outcomes).toHaveLength(2);
  expect(outcomes[0].details).toMatchObject({ status: 'filled' });
  const intent = rows.find(row => row.kind === 'order_intent')!;
  expect(outcomes[0].details).toMatchObject({ cloid: (intent.details as { cloid: string }).cloid });
  expect(rows.every(row => row.deploymentId === runner.get(target.botId)!.id)).toBe(true);
});
it("retains skipped no-trade evaluations rather than only evaluations with orders", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
  const { runner, venue } = setup();
  const noSignal = structuredClone(doc);
  noSignal.nodes.push(
    { id: 'false', type: 'condition.compare', version: 1, config: { operator: 'gt' } },
    { id: 'branch', type: 'condition.branch', version: 1, config: {} },
  );
  noSignal.edges = [
    ...noSignal.edges.filter(edge => edge.source !== 'tick'),
    { source: 'size', sourcePort: 'value', target: 'false', targetPort: 'left' },
    { source: 'size', sourcePort: 'value', target: 'false', targetPort: 'right' },
    { source: 'false', sourcePort: 'result', target: 'branch', targetPort: 'condition' },
    { source: 'tick', sourcePort: 'flow', target: 'branch', targetPort: 'flow' },
    { source: 'branch', sourcePort: 'true', target: 'buy', targetPort: 'flow' },
  ];
  await runner.start(target.botId, 3, noSignal, target, 'testnet', venue);
  await vi.advanceTimersByTimeAsync(61000);
  await runner.stop(target.botId);
  expect(venue.place).not.toHaveBeenCalled();
  const rows = runner.auditHistory(target.botId).filter(row=>row.kind==='evaluation');
  expect(rows).toHaveLength(2);
  expect(rows[0].details).toMatchObject({ orders: [], trace: expect.arrayContaining([expect.objectContaining({ nodeId: 'buy', status: 'skipped' })]) });
});
it("does not submit when the audit store cannot persist an evaluation", async () => {
  vi.useFakeTimers();
  const { runner, venue } = setup();
  const append=FlowAuditStore.prototype.append;
  vi.spyOn(FlowAuditStore.prototype,'append').mockImplementation(function(this:FlowAuditStore,event){
    if(event.kind==='evaluation') throw new Error('AUDIT_UNAVAILABLE');
    return append.call(this,event);
  });
  await runner.start(target.botId, 3, doc, target, 'testnet', venue);
  await vi.advanceTimersByTimeAsync(2000);
  expect(venue.place).not.toHaveBeenCalled();
  expect(runner.get(target.botId)?.status).toBe('failed');
});
it("does not submit when only the guarded intent write fails", async () => {
  vi.useFakeTimers();
  const append = FlowAuditStore.prototype.append;
  vi.spyOn(FlowAuditStore.prototype, 'append').mockImplementation(function(this: FlowAuditStore, event) {
    if (event.kind === 'order_intent') throw new Error('INTENT_AUDIT_UNAVAILABLE');
    return append.call(this, event);
  });
  const { runner, venue, path } = setup();
  await runner.start(target.botId, 3, doc, target, 'testnet', venue);
  await vi.advanceTimersByTimeAsync(2000);
  expect(venue.place).not.toHaveBeenCalled();
  expect(new FlowRunner(path).get(target.botId)).toMatchObject({ status: 'failed', orders: [] });
});
it("preserves uncertain recovery state when failure-event persistence also fails", async () => {
  vi.useFakeTimers();
  const append = FlowAuditStore.prototype.append;
  vi.spyOn(FlowAuditStore.prototype, 'append').mockImplementation(function(this: FlowAuditStore, event) {
    if (event.kind === 'failure') throw new Error('FAILURE_AUDIT_UNAVAILABLE');
    return append.call(this, event);
  });
  const { runner, venue, path } = setup(true);
  await runner.start(target.botId, 3, doc, target, 'testnet', venue);
  await vi.advanceTimersByTimeAsync(2000);
  const restored = new FlowRunner(path);
  expect(restored.get(target.botId)).toMatchObject({ status: 'failed', error: 'uncertain', orders: [{ status: 'uncertain' }] });
  await expect(restored.start(target.botId, 3, doc, target, 'testnet', venue)).rejects.toThrow('unresolved');
  expect(venue.place).toHaveBeenCalledTimes(1);
});
it("halts on ambiguous submission and never retries or permits a blind restart", async () => {
  vi.useFakeTimers();
  const { runner, venue } = setup(true);
  await runner.start(target.botId, 1, doc, target, "testnet", venue);
  await vi.advanceTimersByTimeAsync(2000);
  expect(runner.get(target.botId)?.status).toBe("failed");
  expect(runner.auditHistory(target.botId).map(row => row.kind)).toEqual(['lifecycle', 'evaluation', 'order_intent', 'failure']);
  expect(runner.auditHistory(target.botId).at(-1)?.details).toMatchObject({ status: 'failed', pending: expect.any(String) });
  await vi.advanceTimersByTimeAsync(120000);
  expect(venue.place).toHaveBeenCalledTimes(1);
  await expect(
    runner.start(target.botId, 1, doc, target, "testnet", venue),
  ).rejects.toThrow("unresolved");
});
it("locks an account to one bot and pins its target and workflow", async () => {
  vi.useFakeTimers();
  const { runner, venue } = setup();
  const mutable = structuredClone(target);
  await runner.start(target.botId, 2, doc, mutable, "production", venue);
  mutable.market = "ETH-PERP";
  expect(runner.get(target.botId)?.target.market).toBe("SOL-PERP");
  await expect(
    runner.start("another", 2, doc, target, "production", venue),
  ).rejects.toThrow("account");
  await runner.dispose();
});
it("does not automatically resume persisted deployments after a restart", async () => {
  vi.useFakeTimers();
  const { runner, venue, path } = setup();
  await runner.start(target.botId, 1, doc, target, "testnet", venue);
  const restored = new FlowRunner(path);
  expect(restored.get(target.botId)?.status).toBe("interrupted");
  await runner.dispose();
});
it("reconciles rounded IOC fills before advancing a DCA controller", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T00:00:00Z"));
  const { runner, venue } = setup();
  const flow: FlowDocument = {
    schemaVersion: "3.0",
    nodes: [
      {
        id: "number",
        type: "process.number",
        version: 1,
        config: { value: 1 },
      },
      {
        id: "yes",
        type: "condition.compare",
        version: 1,
        config: { operator: "eq" },
      },
      {
        id: "dca",
        type: "strategy.dca",
        version: 1,
        config: {
          side: "long",
          quotePerOrder: 20.5,
          takeProfitPercent: 5,
          stopLossPercent: 5,
          maxNotional: 50,
          extraStepPercent: 2,
          maxExtraOrders: 1,
          volumeMultiplier: 1,
          repeat: false,
        },
      },
    ],
    edges: [
      {
        source: "number",
        sourcePort: "value",
        target: "yes",
        targetPort: "left",
      },
      {
        source: "number",
        sourcePort: "value",
        target: "yes",
        targetPort: "right",
      },
      {
        source: "yes",
        sourcePort: "result",
        target: "dca",
        targetPort: "signal",
      },
    ],
  };
  await runner.start(target.botId, 1, flow, target, "testnet", venue);
  await vi.advanceTimersByTimeAsync(61000);
  expect(runner.get(target.botId)?.status).toBe("running");
  expect(venue.place).toHaveBeenCalledTimes(1);
  await runner.dispose();
});
it("rejects invalid snapshots instead of bypassing risk checks with NaN", () => {
  expect(() =>
    guardOrder(order, { ...snapshot, available: NaN }, target),
  ).toThrow("Invalid");
  expect(() =>
    guardOrder(
      order,
      { ...snapshot, context: { ...snapshot.context, market: "ETH-PERP" } },
      target,
    ),
  ).toThrow("Invalid");
});
it("allows reducing exposure above the entry ceiling and below entry minimum", () => {
  expect(
    guardOrder(
      { ...order, side: "sell", quantity: 0.49, reduceOnly: true },
      {
        ...snapshot,
        position: 0.49,
        context: { ...snapshot.context, price: 110 },
      },
      { ...target, maxOrderUsd: 50 },
    ).quantity,
  ).toBe(0.49);
  expect(
    guardOrder(
      { ...order, side: "sell", quantity: 0.01, reduceOnly: true },
      { ...snapshot, position: 0.01 },
      target,
    ).quantity,
  ).toBe(0.01);
});
it("resumes the original deployment without losing fills or reentering the same bucket", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T00:00:10Z"));
  const { runner, venue } = setup();
  const first = await runner.start(
    target.botId,
    1,
    doc,
    target,
    "testnet",
    venue,
  );
  await vi.advanceTimersByTimeAsync(2000);
  await runner.stop(target.botId);
  const resumed = await runner.start(
    target.botId,
    1,
    doc,
    target,
    "testnet",
    venue,
  );
  expect(resumed.id).toBe(first.id);
  expect(resumed.orders).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(venue.place).toHaveBeenCalledTimes(1);
  await runner.dispose();
});
it("rejects a new revision with an existing position and retains archived runs once flat", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T00:00:10Z'));
  const { runner, venue } = setup();
  await runner.start(target.botId, 1, doc, target, "testnet", venue);
  await vi.advanceTimersByTimeAsync(2000);
  await runner.stop(target.botId);
  await expect(
    runner.start(target.botId, 2, doc, target, "testnet", venue),
  ).rejects.toThrow("flat");
  vi.mocked(venue.snapshot).mockResolvedValue(structuredClone(snapshot));
  await runner.start(target.botId, 2, doc, target, "testnet", venue);
  expect(runner.history(target.botId)[0].orders).toHaveLength(1);
  await runner.dispose();
});
it("checks a daily DCA stop loss intraday without creating new entry signals", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T01:00:00Z"));
  const { runner, venue } = setup();
  let price = 100;
  const original = venue.snapshot;
  venue.snapshot = async (times) => {
    const value = await original(times);
    return { ...value, context: { ...value.context, price } };
  };
  const daily: FlowDocument = {
    schemaVersion: "3.0",
    nodes: [
      { id: "tick", type: "trigger.tick", version: 1, config: {} },
      {
        id: "candles",
        type: "data.candles",
        version: 1,
        config: { timeframe: "1d", count: 30 },
      },
      {
        id: "number",
        type: "process.number",
        version: 1,
        config: { value: 1 },
      },
      {
        id: "yes",
        type: "condition.compare",
        version: 1,
        config: { operator: "eq" },
      },
      {
        id: "deal",
        type: "strategy.dca",
        version: 1,
        config: {
          quotePerOrder: 20,
          takeProfitPercent: 5,
          stopLossPercent: 5,
          maxNotional: 50,
          extraStepPercent: 2,
          maxExtraOrders: 0,
          repeat: true,
        },
      },
    ],
    edges: [
      {
        source: "tick",
        sourcePort: "tick",
        target: "candles",
        targetPort: "tick",
      },
      {
        source: "number",
        sourcePort: "value",
        target: "yes",
        targetPort: "left",
      },
      {
        source: "number",
        sourcePort: "value",
        target: "yes",
        targetPort: "right",
      },
      {
        source: "yes",
        sourcePort: "result",
        target: "deal",
        targetPort: "signal",
      },
    ],
  };
  await runner.start(target.botId, 1, daily, target, "testnet", venue);
  await vi.advanceTimersByTimeAsync(2000);
  price = 90;
  await vi.advanceTimersByTimeAsync(6000);
  expect(venue.place).toHaveBeenCalledTimes(2);
  expect(vi.mocked(venue.place).mock.calls[1][0]).toMatchObject({
    side: "sell",
    reduceOnly: true,
  });
  await vi.advanceTimersByTimeAsync(10000);
  expect(venue.place).toHaveBeenCalledTimes(2);
  await runner.dispose();
});
it.each([false,true])("reconciles an uncertain fill without resubmitting it despite audit failure (%s)", async (auditFails) => {
  vi.useFakeTimers();
  const { runner, venue } = setup(true);
  await runner.start(target.botId, 1, doc, target, "testnet", venue);
  await vi.advanceTimersByTimeAsync(2000);
  venue.reconcile=vi.fn(async()=>undefined);
  await expect(runner.reconcile(target.botId,venue)).rejects.toThrow('terminal outcome');
  expect(runner.auditHistory(target.botId).filter(row=>row.kind==='reconciliation').map(row=>(row.details as {event:string}).event)).toEqual(['requested','failed']);
  if(auditFails) vi.spyOn(FlowAuditStore.prototype,'append').mockImplementation(()=>{throw new Error('private disk path');});
  venue.reconcile = vi.fn(async (plan) => ({
    id: "exchange-1",
    clientOrderId: plan.clientOrderId,
    side: plan.side,
    quantity: plan.quantity,
    price: 100,
    fee: 0.01,
  }));
  await runner.reconcile(target.botId, venue);
  expect(runner.get(target.botId)).toMatchObject({
    status: "stopped",
    position: 0.2,
    orders: [{ status: "filled", exchangeOrderId: "exchange-1" }],
  });
  expect(venue.place).toHaveBeenCalledTimes(1);
  if(auditFails) expect(runner.get(target.botId)?.auditWarning).toBeTruthy();
  else expect(runner.auditHistory(target.botId).filter(row=>row.kind==='reconciliation').at(-1)?.details).toMatchObject({event:'completed',pending:expect.any(String),order:{status:'filled',exchangeOrderId:'exchange-1'}});
  await runner.reconcile(target.botId, venue);
  expect(venue.reconcile).toHaveBeenCalledTimes(1);
});
it("blocks static DCA sizing that exceeds the saved target before any snapshot or order", async () => {
  const { runner, venue } = setup();
  const invalid: FlowDocument = {
    schemaVersion: "3.0",
    nodes: [
      {
        id: "number",
        type: "process.number",
        version: 1,
        config: { value: 1 },
      },
      {
        id: "yes",
        type: "condition.compare",
        version: 1,
        config: { operator: "eq" },
      },
      {
        id: "deal",
        type: "strategy.dca",
        version: 1,
        config: {
          quotePerOrder: 1000,
          maxNotional: 1000,
          takeProfitPercent: 10,
          stopLossPercent: 5,
          maxExtraOrders: 0,
          extraStepPercent: 2,
        },
      },
    ],
    edges: [
      {
        source: "number",
        sourcePort: "value",
        target: "yes",
        targetPort: "left",
      },
      {
        source: "number",
        sourcePort: "value",
        target: "yes",
        targetPort: "right",
      },
      {
        source: "yes",
        sourcePort: "result",
        target: "deal",
        targetPort: "signal",
      },
    ],
  };
  await expect(
    runner.start(target.botId, 1, invalid, target, "testnet", venue),
  ).rejects.toThrow("exceeds target");
  expect(venue.snapshot).not.toHaveBeenCalled();
});
it.each([false, 'order_outcome', 'protection', 'position_mismatch'] as const)("preserves DCA native protection through fault scenario (%s)", async (auditFails) => {
  if (auditFails === 'order_outcome' || auditFails === 'protection') {
    const append = FlowAuditStore.prototype.append;
    vi.spyOn(FlowAuditStore.prototype, 'append').mockImplementation(function(this: FlowAuditStore, event) {
      if (event.kind === auditFails) throw new Error('AUDIT_DISK_FAILURE');
      return append.call(this, event);
    });
  }
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T00:00:10Z"));
  const { runner, venue, path } = setup();
  let position = 0;
  let nativeClosed = false;
  const statuses = new Map<
    string,
    {
      state: "open" | "terminal";
      exchangeId: string;
      fill?: import("@catbots/strategy-runtime").Fill;
    }
  >();
  venue.snapshot = vi.fn(async () => ({
    ...structuredClone(snapshot),
    position,
    entryPrice: position ? 100 : 0,
    openOrders: [...statuses.values()].filter((s) => s.state === "open").length,
    openOrderIds: [...statuses.values()]
      .filter((s) => s.state === "open")
      .map((s) => s.exchangeId),
  }));
  venue.place = vi.fn(async (plan) => {
    position += plan.quantity;
    return {
      id: "entry",
      clientOrderId: plan.clientOrderId,
      side: plan.side,
      quantity: plan.quantity,
      price: 100,
      fee: 0.01,
    };
  });
  venue.protection = {
    submitProtection: vi.fn(async (plan) => {
      statuses.set(plan.cloid, { state: "open", exchangeId: plan.cloid });
      return plan.cloid;
    }),
    inspectProtection: vi.fn(
      async (
        plan: import("../src/main/connections/native-protection").ProtectiveOrder,
      ): Promise<
        import("../src/main/connections/native-protection").ProtectionStatus
      > => {
        if (nativeClosed && plan.kind === "sl")
          return {
            state: "terminal",
            exchangeId: plan.cloid,
            fill: {
              id: "stop-fill",
              clientOrderId: plan.order.clientOrderId,
              side: "sell",
              quantity: 0.2,
              price: 95,
              fee: 0.01,
            },
          };
        return statuses.get(plan.cloid) ?? { state: "unknown" };
      },
    ),
    cancelProtection: vi.fn(async (plan) => {
      statuses.set(plan.cloid, { state: "terminal", exchangeId: plan.cloid });
    }),
  };
  const flow: FlowDocument = {
    schemaVersion: "3.0",
    nodes: [
      { id: "n", type: "process.number", version: 1, config: { value: 1 } },
      {
        id: "yes",
        type: "condition.compare",
        version: 1,
        config: { operator: "eq" },
      },
      {
        id: "dca",
        type: "strategy.dca",
        version: 1,
        config: {
          quotePerOrder: 20,
          maxNotional: 50,
          takeProfitPercent: 10,
          stopLossPercent: 5,
          maxExtraOrders: 0,
          extraStepPercent: 2,
          repeat: true,
        },
      },
    ],
    edges: [
      { source: "n", sourcePort: "value", target: "yes", targetPort: "left" },
      { source: "n", sourcePort: "value", target: "yes", targetPort: "right" },
      {
        source: "yes",
        sourcePort: "result",
        target: "dca",
        targetPort: "signal",
      },
    ],
  };
  await runner.start(target.botId, 1, flow, target, "testnet", venue);
  await vi.advanceTimersByTimeAsync(2000);
  expect(runner.get(target.botId)?.protection?.status).toBe("protected");
  expect(venue.protection.submitProtection).toHaveBeenCalledTimes(2);
  if(auditFails==='position_mismatch') {
    position=.1;
    await vi.advanceTimersByTimeAsync(6000);
    expect(runner.get(target.botId)).toMatchObject({status:'failed',failureCode:'position_mismatch',position:.2});
    expect(venue.place).toHaveBeenCalledTimes(1);
    expect(venue.protection.cancelProtection).not.toHaveBeenCalled();
    expect(runner.auditHistory(target.botId).filter(event=>event.kind==='failure').at(-1)?.details).toMatchObject({failureCode:'position_mismatch'});
    const restored=new FlowRunner(path);
    try {
      expect(restored.get(target.botId)?.failureCode).toBe('position_mismatch');
      expect(restored.auditHistory(target.botId).filter(event=>event.kind==='failure').at(-1)?.details).toMatchObject({failureCode:'position_mismatch'});
    } finally {await restored.dispose();}
    await expect(runner.reconcile(target.botId,venue)).rejects.toThrow('differs');
    expect(runner.get(target.botId)?.failureCode).toBe('position_mismatch');
    position=.2;
    await runner.start(target.botId,1,flow,target,'testnet',venue);
    expect(runner.get(target.botId)?.failureCode).toBeUndefined();
    await runner.dispose();
    return;
  }
  if(auditFails===false){
    await runner.stop(target.botId);
    const saved=runner.get(target.botId);
    const unsupported:FlowVenue={snapshot:vi.fn(async times=>venue.snapshot(times)),place:vi.fn(async (plan,id,state)=>venue.place(plan,id,state))};
    await expect(runner.start(target.botId,1,flow,target,'testnet',unsupported)).rejects.toThrow('Native protection');
    await expect(runner.reconcile(target.botId,unsupported)).rejects.toThrow('Native protection');
    expect(unsupported.snapshot).not.toHaveBeenCalled();
    expect(runner.get(target.botId)).toEqual(saved);
    expect(runner.get(target.botId)?.protection?.status).toBe('protected');
    await runner.start(target.botId,1,flow,target,'testnet',venue);
  }
  const protectionCount=runner.auditHistory(target.botId).filter(row=>row.kind==='protection').length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(runner.auditHistory(target.botId).filter(row=>row.kind==='protection')).toHaveLength(protectionCount);
  if (auditFails === 'order_outcome') {
    expect(runner.get(target.botId)).toMatchObject({ status: 'failed', error: 'AUDIT_DISK_FAILURE', position: 0.2, protection: { status: 'protected' } });
    await vi.advanceTimersByTimeAsync(120000);
    expect(venue.place).toHaveBeenCalledTimes(1);
    await runner.dispose();
    return;
  }
  nativeClosed = true;
  position = 0;
  await vi.advanceTimersByTimeAsync(6000);
  expect(runner.get(target.botId)).toMatchObject({
    status: "stopped",
    position: 0,
    protection: { status: "flat" },
  });
  expect(venue.place).toHaveBeenCalledTimes(1);
  expect(venue.protection.cancelProtection).toHaveBeenCalledTimes(1);
  if(auditFails==='protection') expect(runner.get(target.botId)?.auditWarning).toBeTruthy();
  else {
    const events=runner.auditHistory(target.botId).filter(row=>row.kind==='protection');
    expect(events.some(row=>(row.details as any).protection?.status==='protected')).toBe(true);
    expect(events.at(-1)?.details).toMatchObject({protection:{status:'flat'},position:0});
    expect(JSON.stringify(events)).toContain('planned');
    expect(JSON.stringify(events)).toContain('unknown');
    expect(JSON.stringify(events)).toContain('stop-fill');
  }
  expect(runner.get(target.botId)?.orders.at(-1)?.exchangeOrderId).toBe(
    "stop-fill",
  );
  const completedId=runner.get(target.botId)!.id;const oldProtectionIds=[...statuses.keys()];statuses.clear();nativeClosed=false;
  await runner.start(target.botId,1,flow,target,'testnet',venue);await vi.advanceTimersByTimeAsync(2000);
  expect(runner.get(target.botId)!.id).not.toBe(completedId);expect([...statuses.keys()].some(id=>oldProtectionIds.includes(id))).toBe(false);expect(runner.history(target.botId)).toHaveLength(1);

  await runner.dispose();
});

it.each([
  {side:'long',price:98}, {side:'long',price:104},
  {side:'short',price:102}, {side:'short',price:96},
])('checks directional $side exits at $price between signal evaluations', async ({side,price:exitPrice}) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T00:00:00Z'));
  const {runner}=setup();
  const flow: FlowDocument = {schemaVersion:'3.0',nodes:[
    ...['fast','slow','rsi','atr'].map((id,index)=>({id,type:'process.number',version:1,config:{value:(side==='long'?[101,100,65,1]:[99,100,35,1])[index]}})),
    {id:'controller',type:'strategy.directional',version:1,config:{quotePerOrder:15,cooldownMinutes:0}},
  ],edges:['fast','slow','rsi','atr'].map(id=>({source:id,sourcePort:'value',target:'controller',targetPort:id}))};
  let price=100, position=0;
  const orders:OrderPlan[]=[];
  const venue:FlowVenue={
    snapshot:async()=>({...structuredClone(snapshot),position,context:{...structuredClone(snapshot.context),price,at:Date.now()}}),
    place:async plan=>{
      orders.push(plan);
      position+=(plan.side==='buy'?1:-1)*plan.quantity;
      return {id:String(orders.length),clientOrderId:plan.clientOrderId,quantity:plan.quantity,price,side:plan.side,fee:.01};
    },
  };
  await runner.start(target.botId,1,flow,target,'testnet',venue);
  await vi.advanceTimersByTimeAsync(1000);
  expect(orders).toHaveLength(1);
  price=exitPrice;
  await vi.advanceTimersByTimeAsync(4000);
  expect(orders).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(orders).toHaveLength(2);
  expect(orders[1]).toMatchObject({side:side==='long'?'sell':'buy',reduceOnly:true,quantity:.15});
  expect(position).toBe(0);
  await vi.advanceTimersByTimeAsync(10000);
  expect(orders).toHaveLength(2); // No re-entry from risk checks, even with zero cooldown.
  expect(runner.get(target.botId)?.status).toBe('running');
  expect(runner.auditHistory(target.botId).filter(event=>event.kind==='evaluation').map(event=>event.details)).toContainEqual(expect.objectContaining({source:'risk'}));
  await runner.dispose();
});

it('persists entry pause, keeps risk exits active, and requires explicit resume', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T00:00:00Z'));
  const {runner,venue,path}=setup();
  const flow:FlowDocument={schemaVersion:'3.0',nodes:[
    ...['fast','slow','rsi','atr'].map((id,index)=>({id,type:'process.number',version:1,config:{value:[101,100,65,1][index]}})),
    {id:'controller',type:'strategy.directional',version:1,config:{quotePerOrder:20}},
  ],edges:['fast','slow','rsi','atr'].map(id=>({source:id,sourcePort:'value',target:'controller',targetPort:id}))};
  const started=await runner.start(target.botId,1,flow,target,'testnet',venue);
  expect(started.entryPauseSupported).toBe(true);
  expect(()=>runner.setEntriesPaused(target.botId,'stale-id',true)).toThrow('changed');
  mkdirSync(`${path}.tmp`);
  expect(()=>runner.setEntriesPaused(target.botId,started.id,true)).toThrow();
  expect(runner.get(target.botId)?.entriesPaused).toBe(true);
  rmSync(`${path}.tmp`,{recursive:true});
  runner.setEntriesPaused(target.botId,started.id,true);
  expect(JSON.parse(readFileSync(path,'utf8'))[target.botId].view.entriesPaused).toBe(true);
  await vi.advanceTimersByTimeAsync(6000);
  expect(venue.place).not.toHaveBeenCalled();
  expect(runner.get(target.botId)).toMatchObject({status:'running',entriesPaused:true});
  await runner.stop(target.botId);
  const recovered=new FlowRunner(path);
  const resumed=await recovered.start(target.botId,1,flow,target,'testnet',venue);
  expect(resumed.entriesPaused).toBe(true);
  await vi.advanceTimersByTimeAsync(6000);
  expect(venue.place).not.toHaveBeenCalled();
  recovered.setEntriesPaused(target.botId,resumed.id,false);
  await vi.advanceTimersByTimeAsync(48000);
  expect(venue.place).toHaveBeenCalledOnce();
  recovered.setEntriesPaused(target.botId,resumed.id,true);
  const original=venue.snapshot;
  venue.snapshot=async times=>{const value=await original(times);return {...value,context:{...value.context,price:90}};};
  await vi.advanceTimersByTimeAsync(5000);
  expect(venue.place).toHaveBeenCalledTimes(2);
  expect(vi.mocked(venue.place).mock.calls[1][0]).toMatchObject({reduceOnly:true,side:'sell',quantity:.2});
  expect(recovered.get(target.botId)?.position).toBe(0);
  expect(recovered.auditHistory(target.botId).map(row=>row.details)).toContainEqual(expect.objectContaining({event:'entries_paused'}));
  await recovered.dispose();
});

it('rejects entry pause for action workflows and stopped deployments', async () => {
  const {runner,venue}=setup();
  const started=await runner.start(target.botId,1,doc,target,'testnet',venue);
  expect(started.entryPauseSupported).toBe(false);
  expect(()=>runner.setEntriesPaused(target.botId,started.id,true)).toThrow('controller');
  await runner.stop(target.botId);
  expect(()=>runner.setEntriesPaused(target.botId,started.id,true)).toThrow('running');
});

it('pauses DCA additions but permits risk exits and refuses resume without audit storage', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-06T00:00:00Z'));
  const {runner,venue}=setup();
  const flow:FlowDocument={schemaVersion:'3.0',nodes:[
    {id:'dca',type:'strategy.dca',version:1,config:{quotePerOrder:20,maxNotional:80,takeProfitPercent:10,stopLossPercent:10,maxExtraOrders:2,extraStepPercent:2,repeat:true}},
    {id:'n',type:'process.number',version:1,config:{value:1}},{id:'yes',type:'condition.compare',version:1,config:{operator:'eq'}},
  ],edges:[{source:'n',sourcePort:'value',target:'yes',targetPort:'left'},{source:'n',sourcePort:'value',target:'yes',targetPort:'right'},{source:'yes',sourcePort:'result',target:'dca',targetPort:'signal'}]};
  const started=await runner.start(target.botId,1,flow,target,'testnet',venue);
  await vi.advanceTimersByTimeAsync(1000);
  runner.setEntriesPaused(target.botId,started.id,true);
  let price=97; const original=venue.snapshot;
  venue.snapshot=async times=>{const value=await original(times);return {...value,context:{...value.context,price}};};
  await vi.advanceTimersByTimeAsync(59000);
  expect(venue.place).toHaveBeenCalledOnce();
  const audit=vi.spyOn(FlowAuditStore.prototype,'append').mockImplementation(()=>{throw new Error('disk unavailable');});
  expect(()=>runner.setEntriesPaused(target.botId,started.id,false)).toThrow('disk unavailable');
  expect(runner.get(target.botId)?.entriesPaused).toBe(true);
  audit.mockRestore(); price=80;
  await vi.advanceTimersByTimeAsync(5000);
  expect(venue.place).toHaveBeenCalledTimes(2);
  expect(vi.mocked(venue.place).mock.calls[1][0]).toMatchObject({reduceOnly:true});
  await runner.dispose();
});

it('cancels an unsent entry when paused during preflight and can resume later', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-06T00:00:00Z'));
  const {runner,venue}=setup();
  const flow:FlowDocument={schemaVersion:'3.0',nodes:[
    ...['fast','slow','rsi','atr'].map((id,index)=>({id,type:'process.number',version:1,config:{value:[101,100,65,1][index]}})),
    {id:'controller',type:'strategy.directional',version:1,config:{quotePerOrder:20}},
  ],edges:['fast','slow','rsi','atr'].map(id=>({source:id,sourcePort:'value',target:'controller',targetPort:id}))};
  const original=venue.snapshot; let snapshots=0;
  venue.snapshot=async times=>{
    if (++snapshots===3) runner.setEntriesPaused(target.botId,runner.get(target.botId)!.id,true);
    return original(times);
  };
  const started=await runner.start(target.botId,1,flow,target,'testnet',venue);
  await vi.advanceTimersByTimeAsync(6000);
  expect(venue.place).not.toHaveBeenCalled();
  runner.setEntriesPaused(target.botId,started.id,false);
  await vi.advanceTimersByTimeAsync(54000);
  expect(venue.place).toHaveBeenCalledOnce();
  await runner.dispose();
});

it('allows a single directional controller on Testnet and enforces its quote budget', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T00:00:00Z'));
  const { validateFlowTarget } = await import('../src/main/connections/flow-runner');
  const flow: FlowDocument = { schemaVersion:'3.0',nodes:[
    ...['fast','slow','rsi','atr'].map((id,index)=>({id,type:'process.number',version:1,config:{value:[101,100,65,1][index]}})),
    {id:'controller',type:'strategy.directional',version:1,config:{quotePerOrder:15}},
  ],edges:['fast','slow','rsi','atr'].map(id=>({source:id,sourcePort:'value',target:'controller',targetPort:id}))};
  expect(()=>validateFlowTarget(flow,target,'testnet')).not.toThrow();
  expect(()=>validateFlowTarget(flow,target,'production')).toThrow('Testnet only');
  expect(()=>validateFlowTarget(flow,{...target,maxOrderUsd:10},'testnet')).toThrow('target limits');
  const {runner,venue}=setup();
  await runner.start(target.botId,1,flow,target,'testnet',venue);
  await vi.advanceTimersByTimeAsync(1000);
  await runner.stop(target.botId);
  expect(venue.place).toHaveBeenCalledOnce();
  expect(vi.mocked(venue.place).mock.calls[0][0]).toMatchObject({side:'buy',reduceOnly:false,quantity:.15});
});
