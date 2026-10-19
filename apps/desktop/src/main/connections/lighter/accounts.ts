import { z } from 'zod';
import { LighterClient } from './client';
export const decimal = z.string().regex(/^-?\d+(\.\d+)?$/).refine(value => Number.isFinite(Number(value)));
export const accountSchema = z.object({ account_index: z.number().int(), l1_address: z.string(), collateral: decimal, total_asset_value: decimal, available_balance: decimal, positions: z.array(z.object({ market_id: z.number().int(), symbol: z.string(), sign: z.number().int().min(-1).max(1), position: decimal, avg_entry_price: decimal, unrealized_pnl: decimal })) });
export async function account(client: LighterClient, index: number) {
  const response = z.object({ accounts: z.array(accountSchema) }).parse(await client.get('account', { by: 'index', value: index }));
  const result = response.accounts.find(item => item.account_index === index);
  if (!result) throw new Error('LIGHTER_ACCOUNT_MISMATCH');
  return result;
}
export const marketSchema = z.object({ market_id: z.number().int().nonnegative(), symbol: z.string(), market_type: z.string(), status: z.string(), supported_size_decimals: z.number().int().min(0).max(8), supported_price_decimals: z.number().int().min(0).max(8), min_base_amount: decimal, min_quote_amount: decimal, multiplier: decimal });
export async function markets(client: LighterClient) {
  return z.object({ order_books: z.array(marketSchema) }).parse(await client.get('orderBooks', {})).order_books.filter(item => item.market_type === 'perp' && item.status === 'active' && /^[A-Z0-9]{1,20}$/.test(item.symbol));
}
