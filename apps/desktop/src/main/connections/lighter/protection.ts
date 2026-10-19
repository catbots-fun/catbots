import { z } from 'zod';
import type { ExecutionTarget } from '@catbots/contracts';
import type { Fill, OrderPlan } from '@catbots/strategy-runtime';
import type { ProtectionStatus, ProtectionVenue, ProtectiveOrder } from '../native-protection';
import { decimal, markets } from './accounts';
import { LighterClient } from './client';
import { clientOrderIndex, toUnits } from './precision';
import type { LighterCredentials, LighterProtectionSignerPort } from './signer';

const evidence = z.object({
  client_order_index: z.number().int().safe(), order_id: z.string().regex(/^[1-9]\d*$/),
  market_index: z.number().int(), owner_account_index: z.number().int(), is_ask: z.boolean(),
  status: z.string(), initial_base_amount: decimal, remaining_base_amount: decimal,
  filled_base_amount: decimal, filled_quote_amount: decimal, price: decimal,
  type: z.string(), time_in_force: z.string(), reduce_only: z.boolean(), trigger_price: decimal,
  order_expiry: z.number().int().safe(), trigger_status: z.string(),
});
type Evidence = z.infer<typeof evidence>;
const pageSchema = z.object({ orders: z.array(evidence), next_cursor: z.string().optional() });
type Reconcile = (order: OrderPlan, cloid: `0x${string}`) => Promise<Fill | null | undefined>;

function exactUnits(value: string, decimals: number): bigint {
  const units = toUnits(value, decimals);
  if ((value.split('.')[1]?.length ?? 0) > 18 || toUnits(value, 18) !== units * 10n ** BigInt(18 - decimals)) throw new Error('LIGHTER_PROTECTION_PRECISION');
  return units;
}

/** Transport for journaled protection only. Deliberately not advertised by the
 * execution adapter until protected-entry and fault acceptance are complete. */
export class LighterProtectionVenue implements ProtectionVenue {
  constructor(
    private client: LighterClient,
    private signer: LighterProtectionSignerPort,
    private credentials: LighterCredentials,
    private target: ExecutionTarget,
    private reconcile: Reconcile,
  ) {}

  private async intent(plan: ProtectiveOrder) {
    if (this.client.environment !== 'testnet' || this.target.accountId !== String(this.credentials.accountIndex)) throw new Error('LIGHTER_PROTECTION_SCOPE');
    if (!plan.order.reduceOnly || plan.order.purpose !== 'exit' || !['sl', 'tp'].includes(plan.kind) ||
      !['buy', 'sell'].includes(plan.order.side) || !Number.isFinite(plan.triggerPrice) || plan.triggerPrice <= 0 ||
      !Number.isFinite(plan.order.quantity) || plan.order.quantity <= 0 || plan.order.limitPrice !== undefined) throw new Error('LIGHTER_PROTECTION_INVALID');
    const market = (await markets(this.client)).find(value => `${value.symbol}-PERP` === this.target.market);
    if (!market || Number(market.multiplier) !== 1) throw new Error('LIGHTER_MARKET_UNAVAILABLE');
    const amount = exactUnits(String(plan.order.quantity), market.supported_size_decimals);
    const sell = plan.order.side === 'sell';
    const trigger = toUnits(String(plan.triggerPrice), market.supported_price_decimals, sell ? 'up' : 'down');
    // IOC execution bound is 50 bps around the quantized trigger, not today's mark.
    const numerator = trigger * (sell ? 995n : 1005n);
    const price = numerator / 1000n + (sell && numerator % 1000n !== 0n ? 1n : 0n);
    if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER) || trigger <= 0n || trigger > 4294967295n || price <= 0n || price > 4294967295n) throw new Error('LIGHTER_PROTECTION_INVALID');
    return { market, amount, trigger, price, sell, index: clientOrderIndex(plan.cloid) };
  }

  private async lookup(index: number): Promise<Evidence | undefined> {
    const params = { account_index: this.credentials.accountIndex };
    const recent = pageSchema.parse(await this.client.get('accountOrders', { ...params, client_order_indexes: String(index) }, await this.signer.authToken()));
    const found = recent.orders.filter(value => value.client_order_index === index);
    if (found.length > 1 || recent.next_cursor) throw new Error('LIGHTER_PROTECTION_AMBIGUOUS');
    if (found.length === 1) return found[0];
    const cursors = new Set<string>();
    let cursor = '';
    let match: Evidence | undefined;
    do {
      const page = pageSchema.parse(await this.client.get('accountInactiveOrders', { ...params, limit: 100, ...(cursor ? { cursor } : {}) }, await this.signer.authToken()));
      for (const row of page.orders.filter(value => value.client_order_index === index)) {
        if (match) throw new Error('LIGHTER_PROTECTION_AMBIGUOUS');
        match = row;
      }
      cursor = page.next_cursor ?? '';
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error('LIGHTER_PROTECTION_HISTORY_INCOMPLETE');
      cursors.add(cursor);
    } while (cursor);
    return match;
  }

  private async nonce() {
    return z.object({ nonce: z.number().int().nonnegative().safe() }).parse(await this.client.get('nextNonce', { account_index: this.credentials.accountIndex, api_key_index: this.credentials.apiKeyIndex })).nonce;
  }

  private matches(plan: ProtectiveOrder, row: Evidence, intent: Awaited<ReturnType<LighterProtectionVenue['intent']>>) {
    try {
      const { market, amount, trigger, price, sell } = intent;
      return row.owner_account_index === this.credentials.accountIndex && row.market_index === market.market_id &&
        row.is_ask === sell && row.reduce_only && row.type === (plan.kind === 'sl' ? 'stop-loss' : 'take-profit') &&
        row.time_in_force === 'immediate-or-cancel' && (!plan.exchangeId || plan.exchangeId === row.order_id) &&
        BigInt(row.order_id) <= 9223372036854775807n &&
        exactUnits(row.initial_base_amount, market.supported_size_decimals) === amount &&
        exactUnits(row.trigger_price, market.supported_price_decimals) === trigger &&
        exactUnits(row.price, market.supported_price_decimals) === price &&
        exactUnits(row.remaining_base_amount, market.supported_size_decimals) + exactUnits(row.filled_base_amount, market.supported_size_decimals) === amount;
    } catch { return false; }
  }

  async inspectProtection(plan: ProtectiveOrder): Promise<ProtectionStatus> {
    const intent = await this.intent(plan);
    let row: Evidence | undefined;
    try { row = await this.lookup(intent.index); } catch { return { state: 'unknown' }; }
    if (!row || !this.matches(plan, row, intent)) return { state: 'unknown' };
    if (['pending', 'open'].includes(row.status) && row.trigger_status === 'mark-price' && row.order_expiry > Date.now() &&
      Number(row.filled_base_amount) === 0 && Number(row.filled_quote_amount) === 0) return { state: 'open', exchangeId: row.order_id };
    if (row.status !== 'filled' && row.status !== 'canceled' && !row.status.startsWith('canceled-')) return { state: 'unknown' };
    const fill = await this.reconcile(plan.order, plan.cloid);
    if (fill === undefined || (fill && fill.id !== row.order_id)) return { state: 'unknown' };
    return { state: 'terminal', exchangeId: row.order_id, ...(fill ? { fill } : {}) };
  }

  async submitProtection(plan: ProtectiveOrder): Promise<string> {
    const intent = await this.intent(plan);
    if (await this.lookup(intent.index)) throw new Error('LIGHTER_PROTECTION_ALREADY_EXISTS');
    const tx = await this.signer.signProtection({ market: intent.market.market_id, clientIndex: intent.index,
      amount: String(intent.amount), price: String(intent.price), sell: intent.sell, kind: plan.kind,
      triggerPrice: String(intent.trigger), expiresAt: Date.now() + 28 * 86400000, nonce: await this.nonce() });
    // The orchestrator must persist unknown before calling. No retry after broadcast.
    await this.client.submit(14, tx);
    const status = await this.inspectProtection(plan);
    if (status.state !== 'open' || !status.exchangeId) throw new Error('LIGHTER_PROTECTION_UNCONFIRMED');
    return status.exchangeId;
  }

  async cancelProtection(plan: ProtectiveOrder): Promise<void> {
    const before = await this.inspectProtection(plan);
    if (before.state === 'terminal' && !before.fill) return;
    if (before.state !== 'open' || !before.exchangeId) throw new Error('LIGHTER_PROTECTION_CANCEL_UNCONFIRMED');
    const intent = await this.intent(plan);
    const tx = await this.signer.signCancel({ market: intent.market.market_id, orderIndex: before.exchangeId, nonce: await this.nonce() });
    await this.client.submit(15, tx);
    const after = await this.inspectProtection({ ...plan, exchangeId: before.exchangeId });
    if (after.state !== 'terminal' || after.fill) throw new Error('LIGHTER_PROTECTION_CANCEL_UNCONFIRMED');
  }
}
