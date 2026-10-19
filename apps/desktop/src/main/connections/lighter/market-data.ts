import { z } from 'zod';
import type { MarketSnapshot } from '@catbots/contracts';
import { LighterClient } from './client';
import { markets } from './accounts';
const positive = z.coerce.number().finite().positive();
const durations: Record<string, number> = { '1m':60, '5m':300, '15m':900, '30m':1800, '1h':3600, '4h':14400, '1d':86400 };
export async function lighterSnapshot(client: LighterClient, symbol: string, timeframes: string[]): Promise<MarketSnapshot> {
  const market = (await markets(client)).find(item => `${item.symbol}-PERP` === symbol);
  if (!market || Number(market.multiplier) !== 1) throw new Error('LIGHTER_MARKET_UNAVAILABLE');
  const details = z.object({ order_book_details: z.array(z.object({ market_id: z.number(), mark_price: positive })) }).parse(await client.get('orderBookDetails',{market_id:market.market_id}));
  const detail=details.order_book_details.find(item=>item.market_id===market.market_id);
  if (!detail) throw new Error('LIGHTER_MARKET_UNAVAILABLE');
  const candles: MarketSnapshot['candles']={}; const at=Date.now();
  for (const timeframe of new Set(timeframes)) {
    const seconds=durations[timeframe]; if (!seconds) throw new Error('LIGHTER_TIMEFRAME_UNSUPPORTED');
    const response=z.object({c:z.array(z.object({t:z.number().int(),o:positive,h:positive,l:positive,c:positive,v:z.number().finite().nonnegative()}))}).parse(await client.get('candles',{market_id:market.market_id,resolution:timeframe,start_timestamp:Math.floor(at/1000)-seconds*500,end_timestamp:Math.floor(at/1000),count_back:500}));
    const rows=response.c.filter(row=>row.t+seconds*1000<=at).sort((a,b)=>a.t-b.t);
    if (!rows.length || at-rows.at(-1)!.t>seconds*2000 || rows.some((row,i)=>row.h<Math.max(row.o,row.c,row.l)||row.l>Math.min(row.o,row.c)||(i>0&&row.t!==rows[i-1].t+seconds*1000))) throw new Error('LIGHTER_CANDLES_INVALID');
    candles[timeframe]=rows.map(row=>({closedAt:row.t+seconds*1000,open:row.o,high:row.h,low:row.l,close:row.c,volume:row.v}));
  }
  return {market:symbol,source:client.environment==='production'?'Lighter mainnet':'Lighter testnet',fetchedAt:new Date(at).toISOString(),price:detail.mark_price,funding:null,candles};
}
