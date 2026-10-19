import { expect, it, vi } from 'vitest';
import { LighterClient } from '../src/main/connections/lighter/client';
import { LighterProtectionVenue } from '../src/main/connections/lighter/protection';
import { LighterFlowVenue } from '../src/main/connections/lighter/venue';
import { installProtection, protectionPlan } from '../src/main/connections/native-protection';
import { clientOrderIndex } from '../src/main/connections/lighter/precision';
import type { ExecutionTarget } from '@catbots/contracts';

const credentials = { accountIndex: 12, apiKeyIndex: 4, apiPrivateKey: 'unused' };
const target: ExecutionTarget = { botId: '00000000-0000-4000-8000-000000000001', connectionId: '00000000-0000-4000-8000-000000000002', accountId: '12', market: 'ETH-PERP', maxOrderUsd: 100, maxPositionUsd: 500 };
const market = { market_id: 0, symbol: 'ETH', market_type: 'perp', status: 'active', supported_size_decimals: 3, supported_price_decimals: 2, min_base_amount: '0.001', min_quote_amount: '10', multiplier: '1' };
function fixture(kind: 'sl' | 'tp' = 'sl') {
  const plan = protectionPlan('deploy', 1, 0.1, 2400, 5, 2).orders.find(order => order.kind === kind)!;
  const trigger = kind === 'sl' ? '2352' : '2520';
  const price = kind === 'sl' ? '2340.24' : '2507.4';
  const row = { client_order_index: clientOrderIndex(plan.cloid), order_id: '281474976710657', market_index: 0, owner_account_index: 12, is_ask: true, status: 'open', initial_base_amount: '0.1', remaining_base_amount: '0.1', filled_base_amount: '0', filled_quote_amount: '0', price, type: kind === 'sl' ? 'stop-loss' : 'take-profit', time_in_force: 'immediate-or-cancel', reduce_only: true, trigger_price: trigger, order_expiry: Date.now() + 86400000, trigger_status: 'mark-price' };
  let rows: unknown[] = [];
  let historical: unknown[] = [];
  let trades: unknown[] = [];
  let broadcastError = false;
  let cancelRace = false;
  let nextRows: unknown[] | undefined;
  const sends: { type: string; tx: Record<string, unknown> }[] = [];
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    let body: object;
    switch (url.pathname.split('/').at(-1)) {
      case 'orderBooks': body = { order_books: [market] }; break;
      case 'accountOrders': body = { orders: rows }; if (nextRows) { rows = nextRows; nextRows = undefined; } break;
      case 'accountInactiveOrders': body = { orders: historical }; break;
      case 'nextNonce': body = { nonce: sends.length }; break;
      case 'trades': body = { trades }; break;
      case 'sendTx': {
        const fields = new URLSearchParams(String(init?.body));
        const type = fields.get('tx_type')!;
        sends.push({ type, tx: JSON.parse(fields.get('tx_info')!) });
        if (type === '14') rows = [{ ...row }];
        else rows = [{ ...row, status: 'canceled', ...(cancelRace ? { filled_base_amount: '0.05', filled_quote_amount: '120', remaining_base_amount: '0.05' } : {}) }];
        if (broadcastError) throw new Error('network lost after acceptance');
        body = {}; break;
      }
      default: throw new Error(`Unexpected endpoint ${url}`);
    }
    return Response.json({ code: 200, ...body });
  });
  const client = new LighterClient('testnet', request);
  const signer = { publicKey: async () => 'key', authToken: async () => 'token', signOrder: async () => '{}', signProtection: async (input: unknown) => JSON.stringify(input), signCancel: async (input: unknown) => JSON.stringify(input) };
  const execution = new LighterFlowVenue(client, signer, credentials, target);
  const venue = new LighterProtectionVenue(client, signer, credentials, target, (order, cloid, evidence) => execution.reconcileEvidence(order, cloid, evidence));
  return { plan, row, venue, sends, request, changeAfterRead: (value: unknown[]) => { nextRows = value; }, setRows: (value: unknown[]) => { rows = value; }, setHistory: (value: unknown[]) => { historical = value; }, setTrades: (value: unknown[]) => { trades = value; }, loseResponse: () => { broadcastError = true; }, race: () => { cancelRace = true; } };
}

it.each(['sl', 'tp'] as const)('submits one verified %s trigger and refuses a duplicate', async kind => {
  const f = fixture(kind);
  await expect(f.venue.submitProtection(f.plan)).resolves.toBe('281474976710657');
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0]).toMatchObject({ type: '14', tx: { market: 0, amount: '100', kind, sell: true, triggerPrice: kind === 'sl' ? '235200' : '252000', price: kind === 'sl' ? '234024' : '250740' } });
  await expect(f.venue.submitProtection(f.plan)).rejects.toThrow();
  expect(f.sends).toHaveLength(1);
});

it.each([{ owner_account_index: 13 }, { market_index: 1 }, { is_ask: false }, { initial_base_amount: '0.2' }, { trigger_price: '2352.001' }, { type: 'limit' }, { reduce_only: false }, { time_in_force: 'good-till-time' }, { price: '1' }, { order_expiry: 0 }, { trigger_status: 'parent-order' }, { remaining_base_amount: '0.05' }])('does not accept mismatched protection evidence %j', async change => {
  const f = fixture(); f.setRows([{ ...f.row, ...change }]);
  await expect(f.venue.inspectProtection(f.plan)).resolves.toMatchObject({ state: 'unknown' });
  await expect(f.venue.cancelProtection(f.plan)).rejects.toThrow();
  expect(f.sends).toHaveLength(0);
});

it('rejects a changed persisted exchange identity and ambiguous duplicate rows', async () => {
  const f = fixture(); f.setRows([f.row]); f.plan.exchangeId = '999';
  expect((await f.venue.inspectProtection(f.plan)).state).toBe('unknown');
  delete f.plan.exchangeId; f.setRows([f.row, f.row]);
  expect((await f.venue.inspectProtection(f.plan)).state).toBe('unknown');
});

it('missing orders stay unknown and historical identities prevent resubmission', async () => {
  const f = fixture();
  expect((await f.venue.inspectProtection(f.plan)).state).toBe('unknown');
  f.setHistory([{ ...f.row, status: 'canceled' }]);
  expect((await f.venue.inspectProtection(f.plan)).state).toBe('terminal');
  await expect(f.venue.submitProtection(f.plan)).rejects.toThrow();
  expect(f.sends).toHaveLength(0);
});

it('journals unknown before broadcast and recovers after a lost response without resending', async () => {
  const f = fixture(); f.loseResponse();
  const state = { ...protectionPlan('deploy', 1, 0.1, 2400, 5, 2), orders: [f.plan] };
  const saved: typeof state[] = [];
  await expect(installProtection(state, f.venue, () => saved.push(structuredClone(state)))).rejects.toThrow();
  expect(saved[0].orders[0].state).toBe('unknown');
  const recovered = structuredClone(saved.at(-1)!);
  await installProtection(recovered, f.venue, () => {});
  expect(recovered.orders[0]).toMatchObject({ state: 'open', exchangeId: '281474976710657' });
  expect(f.sends).toHaveLength(1);
});

it('confirms cancellation only after terminal no-fill evidence', async () => {
  const f = fixture(); f.setRows([f.row]);
  await f.venue.cancelProtection(f.plan);
  expect(f.sends).toEqual([{ type: '15', tx: { market: 0, orderIndex: '281474976710657', nonce: 0 } }]);
  await f.venue.cancelProtection(f.plan);
  expect(f.sends).toHaveLength(1);
});

it('keeps a fill during cancellation unresolved', async () => {
  const f = fixture(); f.setRows([f.row]); f.race();
  await expect(f.venue.cancelProtection(f.plan)).rejects.toThrow();
  expect(f.sends).toHaveLength(1);
});

it('requires trade evidence before accepting a cancelled partial fill', async () => {
  const f = fixture(); f.setRows([{ ...f.row, status: 'canceled', filled_base_amount: '0.05', filled_quote_amount: '120', remaining_base_amount: '0.05' }]);
  expect((await f.venue.inspectProtection(f.plan)).state).toBe('unknown');
  f.setTrades([{ trade_id_str: 't1', ask_id_str: f.row.order_id, bid_id_str: 'other', ask_account_id: 12, bid_account_id: 50, is_maker_ask: false, size: '0.05', usd_amount: '120', taker_fee: 300 }]);
  expect(await f.venue.inspectProtection(f.plan)).toMatchObject({ state: 'terminal', exchangeId: f.row.order_id, fill: { quantity: 0.05, price: 2400, fee: 0.036 } });
});

it('rejects unrepresentable quantities before sending', async () => {
  const f = fixture(); f.plan.order.quantity = 0.1001;
  await expect(f.venue.submitProtection(f.plan)).rejects.toThrow();
  expect(f.sends).toHaveLength(0);
});

it.each(['pending', 'open'])('accepts %s mark-price protection but not an already triggered ready order', async status => {
  const f = fixture(); f.setRows([{ ...f.row, status, trigger_status: 'mark-price' }]);
  expect((await f.venue.inspectProtection(f.plan)).state).toBe('open');
  f.setRows([{ ...f.row, trigger_status: 'ready' }]);
  expect((await f.venue.inspectProtection(f.plan)).state).toBe('unknown');
});

it.each(['281474976710657', '281474976710658'])('never discards a known partial fill when a second read regresses evidence (%s)', async order_id => {
  const f = fixture(); f.plan.exchangeId = f.row.order_id;
  f.setRows([{ ...f.row, status: 'canceled', filled_base_amount: '0.05', filled_quote_amount: '120', remaining_base_amount: '0.05' }]);
  f.changeAfterRead([{ ...f.row, order_id, status: 'canceled' }]);
  expect((await f.venue.inspectProtection(f.plan)).state).toBe('unknown');
  expect(f.sends).toHaveLength(0);
});

it('does not accept different nonzero fill totals from a second order read', async () => {
  const f = fixture();
  f.setRows([{ ...f.row, status: 'canceled', filled_base_amount: '0.05', filled_quote_amount: '120', remaining_base_amount: '0.05' }]);
  f.changeAfterRead([{ ...f.row, status: 'canceled', filled_base_amount: '0.04', filled_quote_amount: '96', remaining_base_amount: '0.06' }]);
  f.setTrades([{ trade_id_str: 't1', ask_id_str: f.row.order_id, bid_id_str: 'other', ask_account_id: 12, bid_account_id: 50, is_maker_ask: false, size: '0.04', usd_amount: '96', taker_fee: 300 }]);
  expect((await f.venue.inspectProtection(f.plan)).state).toBe('unknown');
});

it.each(['1', '281474976710655', '1152921504606846976'])('never cancels a non-exchange order ID %s', async order_id => {
  const f = fixture(); f.setRows([{ ...f.row, order_id }]);
  await expect(f.venue.cancelProtection(f.plan)).rejects.toThrow();
  expect(f.sends).toHaveLength(0);
});
