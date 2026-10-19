import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionsService } from '../src/main/connections/service';
import { FlowRunner } from '../src/main/connections/flow-runner';
import type { ExchangeAdapter } from '../src/main/connections/adapters';
import type { FlowVenue } from '../src/main/connections/flow-venue';
import type { FlowDocument, OrderPlan } from '@catbots/strategy-runtime';

const dirs: string[] = [], resources: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(resources.splice(0).map(resource => resource.dispose()));
  vi.useRealTimers();
  dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }));
});
const botId = '00000000-0000-4000-8000-000000000001';
const connectionId = '00000000-0000-4000-8000-000000000002';
const target = { botId, connectionId, accountId: '12', market: 'SOL-PERP', maxOrderUsd: 50, maxPositionUsd: 100 };
const flow: FlowDocument = { schemaVersion: '3.0', nodes: [
  ...['fast', 'slow', 'rsi', 'atr'].map((id, i) => ({ id, type: 'process.number', version: 1, config: { value: [101, 100, 65, 1][i] } })),
  { id: 'controller', type: 'strategy.directional', version: 1, config: { quotePerOrder: 20 } },
], edges: ['fast', 'slow', 'rsi', 'atr'].map(id => ({ source: id, sourcePort: 'value', target: 'controller', targetPort: id })) };
function fixture(environment: 'testnet' | 'production' = 'testnet') {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-routing-')); dirs.push(dir);
  const path = join(dir, 'connections');
  const connection = { id: connectionId, name: 'Fixture', adapterId: 'lighter', owner: '12', apiKeyIndex: 4, environment, permission: 'trading-authorized' as const, updatedAt: new Date().toISOString(), accounts: [{ id: '12', address: '12', name: 'Account 12', kind: 'main' as const, equity: '1000', withdrawable: '1000', positions: 0 }] };
  writeFileSync(path, JSON.stringify([connection]));
  writeFileSync(`${path}.targets`, JSON.stringify({ [botId]: target }));
  let position = 0;
  const submitted: OrderPlan[] = [];
  const venue: FlowVenue = {
    snapshot: async () => ({ context: { market: target.market, at: Date.now(), price: 100, equity: 1000, candles: {}, fills: [], cancelledOrderIds: [] }, position, available: 1000, openOrders: 0, sizeDecimals: 2, asset: 1 }),
    place: async order => { submitted.push(order); position += (order.side === 'buy' ? 1 : -1) * order.quantity; return { id: String(submitted.length), clientOrderId: order.clientOrderId, side: order.side, quantity: order.quantity, price: 100, fee: .01 }; },
  };
  const adapter: ExchangeAdapter = { descriptor: { id: 'lighter', name: 'Lighter', environments: ['testnet', 'production'], authentication: ['api-key'], capabilities: { accountDiscovery: true, markets: ['perpetual'], trading: true } }, normalizeOwner: value => value, discover: async () => connection.accounts, verify: async () => true, createVenue: async () => venue, connectApiKey: async input => ({ ...connection, id: input.id, owner: String(input.accountIndex) }) };
  const draft = { botId, version: 1, status: 'valid' as const, document: flow, updatedAt: new Date().toISOString() };
  const service = (dex = 'lighter', botExists = (_id: string) => true) => { const value = new ConnectionsService(path, [adapter], undefined, undefined, () => draft, botExists, undefined, () => dex, network => network === 'testnet'); resources.push(value); return value; };
  return { path, connection, adapter, venue, submitted, service };
}
it('saves an API-key account through its adapter without returning the input secret', async () => {
  const f = fixture();
  const result = await f.service().command({ action: 'connect_api_key', adapterId: 'lighter', name: 'Second', environment: 'testnet', accountIndex: 13, apiKeyIndex: 4, apiPrivateKey: '1'.repeat(80) });
  expect(result.connections.map(c => c.owner)).toEqual(['12', '13']);
  expect(JSON.stringify(result)).not.toContain('1'.repeat(80));
});
it('rejects a target belonging to a different DEX before saving it', async () => {
  const f = fixture();
  await expect(f.service('hyperliquid').command({ action: 'save_target', target })).rejects.toThrow('belonging');
});
it('blocks production start at the service boundary before constructing any venue', async () => {
  const f = fixture('production'); let venues = 0;
  f.adapter.createVenue = async () => { venues++; return f.venue; };
  await expect(f.service().command({ action: 'start_flow', botId, version: 1, confirmation: 'production:SOL-PERP' })).rejects.toThrow('EXECUTION_NOT_AVAILABLE');
  expect(venues).toBe(0); expect(f.submitted).toEqual([]);
});
it('closes a persisted directional position through its selected adapter without Hyperliquid credentials', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
  const f = fixture(), runner = new FlowRunner(`${f.path}.runtime`); resources.push(runner);
  const started = await runner.start(botId, 1, flow, target, 'testnet', f.venue);
  await vi.advanceTimersByTimeAsync(1000); await runner.dispose();
  expect(f.submitted).toHaveLength(1);
  const result = await f.service().command({ action: 'close_flow_position', botId, deploymentId: started.id, confirmation: 'CLOSE SOL-PERP' });
  expect(result.deployment).toMatchObject({ closeResult: 'closed', position: 0 });
  expect(f.submitted[1]).toMatchObject({ side: 'sell', quantity: .2, reduceOnly: true });
});

it.each([.2, undefined])('releases verified-flat orphan ownership for a new close after restart (old position %s)', async expectedPosition => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
  const f = fixture(), oldBot = '00000000-0000-4000-8000-000000000009', oldTarget = { ...target, botId: oldBot };
  writeFileSync(`${f.path}.targets`, JSON.stringify({ [oldBot]: oldTarget }));
  writeFileSync(`${f.path}.runtime`, JSON.stringify({ [oldBot]: {
    view: { id: 'old-deployment', botId: oldBot, version: 1, environment: 'testnet', target: oldTarget, status: 'stopped', startedAt: new Date().toISOString(), cycles: 0, orders: [], events: [], position: expectedPosition },
    document: flow, target: oldTarget, state: {}, fills: [], lastBucket: -1, expectedPosition,
  } }));
  f.adapter.activity = async () => ({ fetchedAt: new Date().toISOString(), positions: [], orders: [] });
  const service = f.service('lighter', id => id !== oldBot);
  await service.command({ action: 'remove', id: connectionId });
  const connected = await service.command({ action: 'connect_api_key', adapterId: 'lighter', name: 'Reconnected', environment: 'testnet', accountIndex: 12, apiKeyIndex: 4, apiPrivateKey: '1'.repeat(80) });
  const nextTarget = { ...target, connectionId: connected.connections[0].id };
  await service.command({ action: 'save_target', target: nextTarget });
  const started = await service.command({ action: 'start_flow', botId, version: 1, confirmation: 'testnet:SOL-PERP' });
  await vi.advanceTimersByTimeAsync(1000); await service.dispose();
  const closed = await f.service().command({ action: 'close_flow_position', botId, deploymentId: started.deployment!.id, confirmation: 'CLOSE SOL-PERP' });
  expect(closed.deployment).toMatchObject({ closeResult: 'closed', position: 0 });
  expect(f.submitted).toHaveLength(2);
  expect(f.submitted[1]).toMatchObject({ reduceOnly: true, quantity: .2 });
  const archived = JSON.parse(readFileSync(`${f.path}.runtime.history`, 'utf8'))[0];
  expect(archived.expectedPosition).toBe(expectedPosition);
  expect(archived.orphanAccountVerifiedFlatAt).toBe('2026-10-19T00:00:00.000Z');
});

it('does not release an orphan with uncertain order evidence even if its pending pointer is absent', async () => {
  const f = fixture();
  writeFileSync(`${f.path}.runtime`, JSON.stringify({ [botId]: {
    view: { id: 'uncertain-deployment', botId, version: 1, environment: 'testnet', target, status: 'failed', startedAt: new Date().toISOString(), cycles: 0, orders: [{ status: 'uncertain' }], events: [] },
    document: flow, target, state: {}, fills: [], lastBucket: -1,
  } }));
  f.adapter.activity = async () => ({ fetchedAt: new Date().toISOString(), positions: [], orders: [] });
  const service = f.service('lighter', () => false);
  await expect(service.command({ action: 'remove', id: connectionId })).rejects.toThrow('Cannot remove an active runtime record');
  expect((await service.command({ action: 'list' })).connections).toHaveLength(1);
});
