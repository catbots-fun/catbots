import { z } from 'zod';
import { lighterSnapshot } from '../connections/lighter/market-data';
import { LighterClient } from '../connections/lighter/client';
import { StaleMarketDataError } from './market-data-error';
import { MarketSnapshotRequestSchema, type MarketSnapshot } from '@catbots/contracts';
const numeric = z.union([z.string().min(1), z.number()]).transform(Number).pipe(z.number().finite());
const positive = numeric.pipe(z.number().positive());
const candle = z.object({ t: z.number().int(), T: z.number().int(), s: z.string(), i: z.string(), o: positive, h: positive, l: positive, c: positive, v: numeric.pipe(z.number().nonnegative()) });
export async function fetchMarketSnapshot(input: unknown, request: typeof fetch = fetch): Promise<MarketSnapshot> {
  const args = MarketSnapshotRequestSchema.parse(input);
  if (args.dex === 'lighter') return lighterSnapshot(new LighterClient(args.environment ?? 'production', request), args.market, args.timeframes);
  const coin = args.market.replace(/-PERP$/, '');
  const at = Date.now();
  async function info(body: unknown): Promise<unknown> {
    const response = await request('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Market request failed');
    return response.json();
  }
  const raw = z.tuple([z.object({ universe: z.array(z.object({ name: z.string(), isDelisted: z.boolean().optional() })) }), z.array(z.object({ markPx: positive, funding: numeric }))]).parse(await info({ type: 'metaAndAssetCtxs' }));
  const index = raw[0].universe.findIndex(item => item.name === coin && !item.isDelisted);
  const context = raw[1][index];
  if (!context) throw new Error('Market unavailable');
  const candles: MarketSnapshot['candles'] = {};
  for (const interval of [...new Set(args.timeframes)]) {
    const duration = Number.parseInt(interval) * (interval.endsWith('m') ? 60000 : interval.endsWith('h') ? 3600000 : 86400000);
    const rows = z.array(candle).max(5001).parse(await info({ type: 'candleSnapshot', req: { coin, interval, startTime: at - duration * 5000, endTime: at } }));
    const closed = rows.filter(row => row.T < at).sort((a,b) => a.t-b.t);
    if (!closed.length || at - closed.at(-1)!.T > duration * 2) throw new StaleMarketDataError();
    if (closed.some((row,i) => row.s !== coin || row.i !== interval || row.T < row.t || row.h < Math.max(row.o,row.c,row.l) || row.l > Math.min(row.o,row.c) || (i > 0 && row.t !== closed[i-1]!.t + duration))) throw new Error('Invalid or incomplete candles');
    candles[interval] = closed.map(row => ({ closedAt: row.T, open: row.o, high: row.h, low: row.l, close: row.c, volume: row.v }));
  }
  const completedAt = Date.now();
  if (completedAt < at) throw new StaleMarketDataError();
  for (const [interval, rows] of Object.entries(candles)) {
    const duration = Number.parseInt(interval) * (interval.endsWith('m') ? 60000 : interval.endsWith('h') ? 3600000 : 86400000);
    if (completedAt - rows.at(-1)!.closedAt > duration * 2) throw new StaleMarketDataError();
  }
  if (completedAt - at > 60000) throw new Error('Snapshot fetch took too long');
  return { market: args.market, source: 'Hyperliquid mainnet', fetchedAt: new Date(at).toISOString(), price: context.markPx, funding: context.funding, candles };
}

let catalogCache: { expires: number; markets: string[] } | undefined;
export async function fetchMarketCatalog(): Promise<string[]> {
  if (catalogCache && catalogCache.expires > Date.now()) return catalogCache.markets;
  const response = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'meta' }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Market catalog unavailable');
  const meta = z.object({ universe: z.array(z.object({ name: z.string(), isDelisted: z.boolean().optional() })) }).parse(await response.json());
  const markets = meta.universe.filter(item => !item.isDelisted && /^[A-Z0-9]{1,20}$/.test(item.name)).map(item => `${item.name}-PERP`).sort();
  catalogCache = { expires: Date.now() + 300000, markets };
  return markets;
}
