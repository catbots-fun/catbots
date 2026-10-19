import { z } from 'zod';
import type { ExecutionTarget } from '@catbots/contracts';
import type { Fill, OrderPlan } from '@catbots/strategy-runtime';
import { OrderRejectedError, type FlowVenue, type VenueSnapshot } from '../flow-venue';
import { account, decimal, markets } from './accounts';
import { LighterClient } from './client';
import type { LighterCredentials, LighterSignerPort } from './signer';
import { clientOrderIndex, toUnits } from './precision';

const orderSchema = z.object({ client_order_index: z.number().int(), order_id: z.string(), market_index: z.number().int(), owner_account_index: z.number().int(), is_ask: z.boolean(), status: z.string(), filled_base_amount: decimal, filled_quote_amount: decimal, initial_base_amount: decimal, price: decimal });
export const ordersSchema = z.object({ orders: z.array(orderSchema) });
const positive = z.coerce.number().finite().positive();
const durations: Record<string, number> = { '1m':60, '5m':300, '15m':900, '30m':1800, '1h':3600, '4h':14400, '1d':86400 };

export class LighterFlowVenue implements FlowVenue {
  constructor(private client: LighterClient, private signer: LighterSignerPort, private credentials: LighterCredentials, private target: ExecutionTarget, private settlement = {attempts:30,delayMs:1000}) {}
  private async market() {
    const market = (await markets(this.client)).find(item => `${item.symbol}-PERP` === this.target.market);
    if (!market) throw new Error('LIGHTER_MARKET_UNAVAILABLE');
    if (Number(market.multiplier) !== 1) throw new Error('LIGHTER_MARKET_MULTIPLIER_UNSUPPORTED');
    return market;
  }
  async snapshot(timeframes: string[]): Promise<VenueSnapshot> {
    const market = await this.market();
    const [state, details, orders] = await Promise.all([
      account(this.client, this.credentials.accountIndex),
      this.client.get('orderBookDetails', { market_id: market.market_id }),
      this.client.get('accountActiveOrders', { account_index: this.credentials.accountIndex }, await this.signer.authToken()),
    ]);
    const metadata = z.object({ order_book_details: z.array(z.object({ market_id: z.number(), mark_price: positive })) }).parse(details).order_book_details.find(item => item.market_id === market.market_id);
    if (!metadata) throw new Error('LIGHTER_MARKET_UNAVAILABLE');
    const open = ordersSchema.parse(orders).orders;
    const candles: VenueSnapshot['context']['candles'] = {};
    const at = Date.now();
    for (const timeframe of new Set(timeframes)) {
      const seconds = durations[timeframe];
      if (!seconds) throw new Error('LIGHTER_TIMEFRAME_UNSUPPORTED');
      const response = z.object({ c: z.array(z.object({ t: z.number().int(), o: positive, h: positive, l: positive, c: positive, v: z.number().finite().nonnegative() })) }).parse(await this.client.get('candles', { market_id: market.market_id, resolution: timeframe, start_timestamp: Math.floor(at / 1000) - seconds * 500, end_timestamp: Math.floor(at / 1000), count_back: 500 }));
      const rows = response.c.filter(row => row.t + seconds * 1000 <= at).sort((a,b) => a.t-b.t);
      if (!rows.length || at - rows.at(-1)!.t > seconds * 2000 || rows.some((row,i) => row.h < Math.max(row.o,row.c,row.l) || row.l > Math.min(row.o,row.c) || (i > 0 && row.t !== rows[i-1].t + seconds * 1000))) throw new Error('LIGHTER_CANDLES_INVALID');
      candles[timeframe] = rows.map(row => ({ closedAt: row.t + seconds * 1000, open: row.o, high: row.h, low: row.l, close: row.c, volume: row.v }));
    }
    const position = state.positions.find(item => item.market_id === market.market_id);
    return { context: { market: this.target.market, at, price: metadata.mark_price, equity: Number(state.total_asset_value), candles, fills: [], cancelledOrderIds: [] }, position: position ? Number(position.position) * position.sign : 0, available: Number(state.available_balance), openOrders: open.length, openOrderIds: open.map(item => item.order_id), entryPrice: position ? Number(position.avg_entry_price) : 0, sizeDecimals: market.supported_size_decimals, asset: market.market_id };
  }
  async place(order: OrderPlan, cloid: `0x${string}`, snapshot: VenueSnapshot): Promise<Fill | null> {
    let tx: string;
    try { tx = await this.prepareOrder(order, cloid, snapshot); }
    catch (error) {
      if (error instanceof Error && error.message === 'LIGHTER_CLIENT_ID_ALREADY_EXISTS') throw error;
      throw new OrderRejectedError('LIGHTER_ORDER_NOT_SENT');
    }
    // After broadcast, transport failures and incomplete evidence remain uncertain.
    await this.client.submit(14, tx);
    const deadline=Date.now()+30000;
    for (let attempt = 0; attempt < this.settlement.attempts; attempt++) {
      const fill = await this.reconcile(order, cloid);
      if (fill !== undefined) return fill;
      if (Date.now()>=deadline) break;
      if (attempt < this.settlement.attempts-1) await new Promise(resolve => setTimeout(resolve, this.settlement.delayMs));
    }
    throw new Error('EXECUTION_OUTCOME_UNKNOWN');
  }
  private async prepareOrder(order: OrderPlan, cloid: `0x${string}`, snapshot: VenueSnapshot): Promise<string> {
    if (order.limitPrice !== undefined) throw new OrderRejectedError('Resting orders are not supported');
    const market = await this.market();
    const amount = toUnits(order.quantity.toFixed(market.supported_size_decimals), market.supported_size_decimals);
    if (market.market_id !== snapshot.asset || amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new OrderRejectedError('LIGHTER_ORDER_INVALID');
    if (!order.reduceOnly && (order.quantity < Number(market.min_base_amount) || order.quantity * snapshot.context.price < Number(market.min_quote_amount))) throw new OrderRejectedError('LIGHTER_ORDER_BELOW_MINIMUM');
    const reference = toUnits(String(snapshot.context.price), market.supported_price_decimals + 4);
    const bounded = order.side === 'buy' ? reference * 1005n / 1000n : reference * 995n / 1000n;
    const price = bounded / 10000n; // floor buys to stay under cap; ceil sells to stay above floor
    const wirePrice = order.side === 'sell' && bounded % 10000n !== 0n ? price + 1n : price;
    if (wirePrice <= 0n || wirePrice > 4294967295n) throw new OrderRejectedError('LIGHTER_PRICE_INVALID');
    const index = clientOrderIndex(cloid);
    const existing = await this.outcome(index);
    if (existing) throw new Error('LIGHTER_CLIENT_ID_ALREADY_EXISTS');
    const nonce = z.object({ nonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).parse(await this.client.get('nextNonce', { account_index: this.credentials.accountIndex, api_key_index: this.credentials.apiKeyIndex })).nonce;
    return this.signer.signOrder({ market: market.market_id, clientIndex: index, amount: String(amount), price: String(wirePrice), sell: order.side === 'sell', reduceOnly: order.reduceOnly, nonce });
  }
  private async outcome(index: number, history = false) {
    const recent = ordersSchema.parse(await this.client.get('accountOrders', { account_index: this.credentials.accountIndex, client_order_indexes: String(index) }, await this.signer.authToken())).orders.find(item => item.client_order_index === index);
    if (recent || !history) return recent;
    const schema = ordersSchema.extend({ next_cursor: z.string().optional() });
    const cursors = new Set<string>(); let cursor = '';
    do {
      const page = schema.parse(await this.client.get('accountInactiveOrders', { account_index: this.credentials.accountIndex, limit: 100, ...(cursor ? { cursor } : {}) }, await this.signer.authToken()));
      const match = page.orders.find(item => item.client_order_index === index);
      if (match) return match;
      cursor = page.next_cursor ?? '';
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) return undefined;
      cursors.add(cursor);
    } while (cursor);
    return undefined;
  }
  async reconcile(order: OrderPlan, cloid: `0x${string}`): Promise<Fill | null | undefined> {
    const value = await this.outcome(clientOrderIndex(cloid), true);
    if (!value) return undefined;
    const market = await this.market();
    if (value.owner_account_index !== this.credentials.accountIndex || value.market_index !== market.market_id || value.is_ask !== (order.side === 'sell') || Math.abs(Number(value.initial_base_amount) - order.quantity) > 1e-8) throw new Error('LIGHTER_ORDER_IDENTITY_MISMATCH');
    if (value.status !== 'filled' && value.status !== 'canceled' && !value.status.startsWith('canceled-')) return undefined;
    const quantity = Number(value.filled_base_amount);
    if (quantity === 0) return value.status === 'filled' ? undefined : null;
    if (quantity < 0 || quantity > order.quantity) throw new Error('LIGHTER_FILL_INVALID');
    const pageSchema = z.object({ next_cursor: z.string().optional(), trades: z.array(z.object({ trade_id_str: z.string(), ask_id_str: z.string(), bid_id_str: z.string(), ask_account_id: z.number(), bid_account_id: z.number(), is_maker_ask: z.boolean(), size: decimal, usd_amount: decimal, taker_fee: z.number().optional(), maker_fee: z.number().optional() })) });
    const trades: z.infer<typeof pageSchema>['trades'] = [];
    const cursors = new Set<string>(); let cursor = '';
    do {
      const page = pageSchema.parse(await this.client.get('trades', { account_index: this.credentials.accountIndex, market_id: market.market_id, order_index_str: value.order_id, sort_by: 'timestamp', limit: 100, ...(cursor ? {cursor} : {}) }, await this.signer.authToken()));
      trades.push(...page.trades); cursor = page.next_cursor ?? '';
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) return undefined;
      cursors.add(cursor);
    } while (cursor);
    const matched = trades.filter(t => order.side === 'sell' ? t.ask_id_str === value.order_id && t.ask_account_id === this.credentials.accountIndex : t.bid_id_str === value.order_id && t.bid_account_id === this.credentials.accountIndex);
    if (new Set(matched.map(t => t.trade_id_str)).size !== matched.length || Math.abs(matched.reduce((sum,t) => sum+Number(t.size),0) - quantity) > 1e-8) return undefined;
    const fee = matched.reduce((sum,t) => sum + Number(t.usd_amount) * ((t.is_maker_ask === (order.side === 'sell') ? t.maker_fee : t.taker_fee) ?? 0) / 1_000_000, 0);
    const price = Number(value.filled_quote_amount) / quantity;
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(fee)) return undefined;
    return { id: value.order_id, clientOrderId: order.clientOrderId, side: order.side, quantity, price, fee };
  }
}
