import { z } from 'zod';
import { intervalMs, type HistoricalFlowData } from '@catbots/strategy-runtime';

const price = z.coerce.number().finite().positive();
const candle = z.object({ t:z.number().int(), o:price, h:price, l:price, c:price, v:z.coerce.number().finite().nonnegative() });

/** Public Mainnet history for simulation, independent of the execution account's network. */
export async function loadLighterHistory(market:string, from:number, to:number, counts:Record<string,number>, signal:AbortSignal, request:typeof fetch=fetch):Promise<HistoricalFlowData> {
  const get = async (endpoint:string, params:Record<string,string|number>) => {
    const url = new URL(`https://mainnet.zklighter.elliot.ai/api/v1/${endpoint}`);
    for (const [key,value] of Object.entries(params)) url.searchParams.set(key,String(value));
    for (let attempt=0;attempt<3;attempt++) {
      signal.throwIfAborted();
      const response = await request(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),redirect:'error',credentials:'omit'});
      if ((response.status===429 || response.status>=500) && attempt<2) { await new Promise(resolve=>setTimeout(resolve,250*2**attempt)); continue; }
      if (!response.ok) throw new Error('Lighter historical data unavailable');
      const value:unknown = await response.json();
      if (z.object({code:z.number()}).parse(value).code!==200) throw new Error('Lighter historical request rejected');
      return value;
    }
    throw new Error('Lighter history retry limit reached');
  };
  const books = z.object({order_books:z.array(z.object({market_id:z.number().int(),symbol:z.string(),market_type:z.string(),status:z.string()}))}).parse(await get('orderBooks',{}));
  const book=books.order_books.find(item=>`${item.symbol}-PERP`===market && item.market_type==='perp' && item.status==='active');
  if (!book) throw new Error('Lighter historical market unavailable');
  const candles:HistoricalFlowData['candles']={};
  for (const [timeframe,warmup] of Object.entries(counts)) {
    if (!['1m','5m','15m','30m','1h','4h','1d'].includes(timeframe)) throw new Error(`Lighter interval unsupported: ${timeframe}`);
    const duration=intervalMs(timeframe),start=Math.floor(from/duration)*duration-warmup*duration,end=Math.floor(to/duration)*duration;
    if ((end-start)/duration>100000) throw new Error('Lighter history exceeds 100000 candles per interval');
    const rows = new Map<number,z.infer<typeof candle>>();
    for (let cursor=start;cursor<end;cursor+=499*duration) {
      const last=Math.min(end,cursor+499*duration);
      const page=z.object({c:z.array(candle).max(501)}).parse(await get('candles',{market_id:book.market_id,resolution:timeframe,start_timestamp:cursor/1000,end_timestamp:last/1000,count_back:500}));
      for (const bar of page.c) {
        if (bar.t<start || bar.t>=end) continue;
        if (bar.t%duration!==0 || bar.h<Math.max(bar.o,bar.c,bar.l) || bar.l>Math.min(bar.o,bar.c)) throw new Error('Lighter invalid historical candle');
        const prior=rows.get(bar.t);
        if (prior && JSON.stringify(prior)!==JSON.stringify(bar)) throw new Error('Lighter conflicting historical candles');
        rows.set(bar.t,bar);
      }
    }
    const selected=[];
    for (let at=start;at<end;at+=duration) {
      const bar=rows.get(at);if(!bar)throw new Error(`${timeframe}: Lighter history incomplete at ${new Date(at).toISOString()}`);
      selected.push({closedAt:at+duration-1,open:bar.o,high:bar.h,low:bar.l,close:bar.c,volume:bar.v});
    }
    candles[timeframe]=selected;
  }
  const fundingMap=new Map<number,number>();
  const hour=3600000,first=Math.ceil(from/hour)*hour;
  const fundingSchema=z.object({fundings:z.array(z.object({timestamp:z.number().int(),rate:z.coerce.number().finite().nonnegative(),direction:z.enum(['long','short'])})).max(501)});
  for (let cursor=first;cursor<to;cursor+=499*hour) {
    const page=fundingSchema.parse(await get('fundings',{market_id:book.market_id,resolution:'1h',start_timestamp:cursor/1000,end_timestamp:Math.floor(Math.min(to-1,cursor+499*hour)/1000),count_back:500}));
    for (const entry of page.fundings) {
      const at=entry.timestamp*1000;if(at<first||at>=to)continue;
      if(at%hour!==0)throw new Error('Lighter funding timestamp invalid');
      const rate=entry.rate/100*(entry.direction==='long'?1:-1);
      if(fundingMap.has(at)&&fundingMap.get(at)!==rate)throw new Error('Lighter conflicting funding history');
      fundingMap.set(at,rate);
    }
  }
  const funding:HistoricalFlowData['funding']=[];
  for(let at=first;at<to;at+=hour){const rate=fundingMap.get(at);if(rate===undefined)throw new Error('Lighter hourly funding history incomplete');funding.push({at,reportedAt:at,rate});}
  return {source:'Lighter mainnet OHLCV + historical funding',fetchedAt:new Date().toISOString(),candles,funding};
}
