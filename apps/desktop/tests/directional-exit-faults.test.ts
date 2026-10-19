import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Fill, FlowDocument, OrderPlan } from '@catbots/strategy-runtime';
import { FlowRunner } from '../src/main/connections/flow-runner';
import { fetchMarketSnapshot } from '../src/main/nodes/market-snapshot';
import { OrderRejectedError, type FlowVenue } from '../src/main/connections/flow-venue';

const dirs: string[] = [];
const runners: FlowRunner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map(runner => runner.dispose()));
  vi.useRealTimers();
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

async function entered(long: boolean) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
  const dir = mkdtempSync(join(tmpdir(), 'directional-faults-'));
  dirs.push(dir);
  const path = join(dir, 'runs');
  const reopen = () => {
    const runner = new FlowRunner(path);
    runners.push(runner);
    return runner;
  };
  const runner = reopen();
  const target = {
    botId: '00000000-0000-4000-8000-000000000001',
    connectionId: '00000000-0000-4000-8000-000000000002',
    accountId: `0x${'1'.repeat(40)}`, market: 'SOL-PERP', maxOrderUsd: 50, maxPositionUsd: 100,
  };
  const flow: FlowDocument = {
    schemaVersion: '3.0',
    nodes: [
      ...['fast', 'slow', 'rsi', 'atr'].map((id, index) => ({
        id, type: 'process.number', version: 1, config: { value: (long ? [101, 100, 65, 1] : [99, 100, 35, 1])[index] },
      })),
      { id: 'controller', type: 'strategy.directional', version: 1, config: { quotePerOrder: 20 } },
    ],
    edges: ['fast', 'slow', 'rsi', 'atr'].map(id => ({ source: id, sourcePort: 'value', target: 'controller', targetPort: id })),
  };
  const exchange = { price: 100, position: 0, offline: false };
  const submitted: OrderPlan[] = [];
  const fill = (order: OrderPlan, quantity = order.quantity): Fill => {
    exchange.position += (order.side === 'buy' ? 1 : -1) * quantity;
    return { id: `fill-${submitted.length}`, clientOrderId: order.clientOrderId, side: order.side, quantity, price: exchange.price, fee: .01 };
  };
  let execute: (order: OrderPlan) => Promise<Fill | null> = async order => fill(order);
  const venue: FlowVenue = {
    snapshot: async () => {
      if (exchange.offline) throw new Error('Exchange unavailable');
      return {
        context: { market: target.market, at: Date.now(), price: exchange.price, equity: 1000, candles: {}, fills: [], cancelledOrderIds: [] },
        position: exchange.position, available: 1000, openOrders: 0, sizeDecimals: 2, asset: 1,
      };
    },
    place: async order => { submitted.push(order); return execute(order); },
  };
  await runner.start(target.botId, 1, flow, target, 'testnet', venue);
  await vi.advanceTimersByTimeAsync(1000);
  expect(submitted).toHaveLength(1);
  expect(runner.get(target.botId)?.position).toBe(long ? .2 : -.2);
  exchange.price = long ? 98 : 102;
  return { runner, reopen, target, flow, venue, exchange, submitted, fill, setExecution: (next: typeof execute) => { execute = next; } };
}

it.each([true, false])('preserves uncertain exit ownership across restart without resending (long=%s)', async long => {
  const f = await entered(long);
  let terminal: Fill | undefined;
  f.setExecution(async order => {
    terminal = f.fill(order); // Exchange filled, but the response was lost.
    throw new Error('Response timed out');
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.exchange.position).toBe(0);
  expect(f.runner.get(f.target.botId)).toMatchObject({ status: 'failed', position: long ? .2 : -.2 });
  expect(f.runner.get(f.target.botId)?.orders.at(-1)?.status).toBe('uncertain');
  const recovered = f.reopen();
  await expect(recovered.start(f.target.botId, 1, f.flow, f.target, 'testnet', f.venue)).rejects.toThrow('unresolved');
  const other = { ...f.target, botId: '00000000-0000-4000-8000-000000000003' };
  await expect(recovered.start(other.botId, 1, f.flow, other, 'testnet', f.venue)).rejects.toThrow('unresolved');
  f.venue.reconcile = async () => undefined;
  await expect(recovered.reconcile(f.target.botId, f.venue)).rejects.toThrow('terminal outcome');
  expect(recovered.get(f.target.botId)?.position).toBe(long ? .2 : -.2);
  f.venue.reconcile = async () => terminal;
  await recovered.reconcile(f.target.botId, f.venue);
  await recovered.reconcile(f.target.botId, f.venue);
  expect(recovered.get(f.target.botId)).toMatchObject({ status: 'stopped', position: 0 });
  expect(recovered.get(f.target.botId)?.orders.at(-1)).toMatchObject({ status: 'filled', exchangeOrderId: terminal!.id });
  expect(f.submitted).toHaveLength(2);
  expect(recovered.auditHistory(f.target.botId).map(event => event.kind)).toContain('failure');
});

it.each([true, false])('does not retry rejected directional exits automatically (long=%s)', async long => {
  const f = await entered(long);
  f.setExecution(async () => { throw new OrderRejectedError('Rejected by exchange'); });
  await vi.advanceTimersByTimeAsync(20000);
  expect(f.runner.get(f.target.botId)).toMatchObject({ status: 'failed', position: long ? .2 : -.2 });
  expect(f.runner.get(f.target.botId)?.orders.at(-1)?.status).toBe('rejected');
  expect(f.submitted).toHaveLength(2);
  expect(f.reopen().get(f.target.botId)?.orders.at(-1)?.status).toBe('rejected');
});

it.each([true, false])('retains residual position after a terminal partial exit (long=%s)', async long => {
  const f = await entered(long);
  f.setExecution(async order => f.fill(order, .1));
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.runner.get(f.target.botId)?.position).toBe(long ? .1 : -.1);
  expect(f.submitted[1]).toMatchObject({ quantity: .2, reduceOnly: true, side: long ? 'sell' : 'buy' });
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.submitted[2]).toMatchObject({ quantity: .1, reduceOnly: true, side: long ? 'sell' : 'buy' });
  expect(f.submitted[2].clientOrderId).not.toBe(f.submitted[1].clientOrderId);
  expect(f.runner.get(f.target.botId)?.position).toBe(0);
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.submitted).toHaveLength(3);
});

it.each(['network', 'manual-position'] as const)('stops before an exit on %s failure', async failure => {
  const f = await entered(true);
  if (failure === 'network') f.exchange.offline = true;
  else f.exchange.position = .1;
  await vi.advanceTimersByTimeAsync(20000);
  expect(f.submitted).toHaveLength(1);
  expect(f.runner.get(f.target.botId)).toMatchObject({ status: 'failed', position: .2 });
  expect(f.runner.get(f.target.botId)?.error).toContain(failure === 'network' ? 'unavailable' : 'position changed');
  expect(f.runner.get(f.target.botId)?.failureCode).toBe(failure === 'network' ? 'snapshot_unavailable' : 'position_mismatch');
  expect(f.reopen().get(f.target.botId)?.failureCode).toBe(failure === 'network' ? 'snapshot_unavailable' : 'position_mismatch');
});

it('retains observation failure until a validated restart rather than no-op reconciliation',async()=>{
 const f=await entered(true);const snapshot=f.venue.snapshot;
 f.venue.snapshot=async()=>{throw new Error('SECRET wallet and endpoint');};
 await vi.advanceTimersByTimeAsync(5000);
 expect(f.runner.get(f.target.botId)).toMatchObject({failureCode:'snapshot_unavailable'});
 expect(f.runner.get(f.target.botId)?.error).not.toContain('SECRET');
 expect(JSON.stringify(f.runner.auditHistory(f.target.botId))).not.toContain('SECRET');
 await f.runner.stop(f.target.botId);await f.runner.reconcile(f.target.botId,f.venue);
 expect(f.runner.get(f.target.botId)?.failureCode).toBe('snapshot_unavailable');
 f.venue.snapshot=snapshot;
 await f.runner.start(f.target.botId,1,f.flow,f.target,'testnet',f.venue);
 expect(f.runner.get(f.target.botId)?.failureCode).toBeUndefined();
});

it('does not classify an uncertain submission from its error message',async()=>{
 const f=await entered(true);
 f.setExecution(async()=>{throw new Error('Account position changed outside this deployment');});
 await vi.advanceTimersByTimeAsync(5000);
 expect(f.runner.get(f.target.botId)?.orders.at(-1)?.status).toBe('uncertain');
 expect(f.runner.get(f.target.botId)?.failureCode).toBeUndefined();
});
it('classifies a failed pre-order refresh without submitting the exit',async()=>{
 const f=await entered(true);const snapshot=f.venue.snapshot;let reads=0;
 f.venue.snapshot=async times=>{if(++reads===2)throw new Error('SECRET pre-order response');return snapshot(times);};
 await vi.advanceTimersByTimeAsync(5000);
 expect(f.runner.get(f.target.botId)).toMatchObject({status:'failed',failureCode:'snapshot_unavailable'});
 expect(f.submitted).toHaveLength(1);
 expect(JSON.stringify(f.runner.auditHistory(f.target.botId))).not.toContain('SECRET');
});
it('retains stale-candle classification from the market reader without submitting an exit',async()=>{
 const f=await entered(true);
 f.venue.snapshot=async()=>{
   const request:typeof fetch=async(_url,init)=>JSON.parse(String(init?.body)).type==='metaAndAssetCtxs'
     ? Response.json([{universe:[{name:'SOL'}]},[{markPx:'100',funding:'0'}]]) : Response.json([]);
   await fetchMarketSnapshot({action:'market_snapshot',market:'SOL-PERP',timeframes:['1m']},request);
   throw new Error('Expected missing candles to fail');
 };
 await vi.advanceTimersByTimeAsync(5000);
 expect(f.runner.get(f.target.botId)).toMatchObject({status:'failed',failureCode:'market_data_stale'});
 expect(f.reopen().get(f.target.botId)?.failureCode).toBe('market_data_stale');
 expect(f.submitted).toHaveLength(1);
});
it('clears the mismatch cause only after verified close inventory',async()=>{
 const f=await entered(true);f.exchange.position=.1;await vi.advanceTimersByTimeAsync(5000);
 const deployment=f.runner.get(f.target.botId)!;
 expect(deployment.failureCode).toBe('position_mismatch');
 await expect(f.runner.closePosition(f.target.botId,deployment.id,'CLOSE SOL-PERP',f.venue)).rejects.toThrow('position changed');
 expect(f.runner.get(f.target.botId)?.failureCode).toBe('position_mismatch');
 f.exchange.position=.2;
 const closed=await f.runner.closePosition(f.target.botId,deployment.id,'CLOSE SOL-PERP',f.venue);
 expect(closed.closeResult).toBe('closed');expect(closed.failureCode).toBeUndefined();
});

it('waits for a delayed exit response while stopping and does not submit a duplicate', async () => {
  const f = await entered(true);
  let finish!: () => void;
  f.setExecution(order => new Promise(resolve => { finish = () => resolve(f.fill(order)); }));
  await vi.advanceTimersByTimeAsync(5000);
  let settled = false;
  const stopped = f.runner.stop(f.target.botId).then(result => { settled = true; return result; });
  try {
    expect(f.submitted).toHaveLength(2);
    expect(f.runner.get(f.target.botId)).toMatchObject({ status: 'stopping', position: .2 });
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.submitted).toHaveLength(2);
    expect(settled).toBe(false);
  } finally {
    finish();
  }
  await stopped;
  expect(f.runner.get(f.target.botId)).toMatchObject({ status: 'stopped', position: 0 });
  expect(f.runner.get(f.target.botId)?.orders.at(-1)?.status).toBe('filled');
});
