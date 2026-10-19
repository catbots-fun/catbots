import { z } from 'zod';
import type { FlowBacktestSettings } from '@catbots/contracts';
import { flowHistoryRequirements, intervalMs, type HistoricalFlowData, type FlowDocument } from '@catbots/strategy-runtime';
import { BacktestCache, hash } from './cache';
import { loadLighterHistory } from './lighter-history';
const numeric=z.union([z.string().min(1),z.number()]).transform(Number).pipe(z.number().finite());
const price=numeric.pipe(z.number().positive());
const row=z.object({t:z.number().int(),T:z.number().int(),s:z.string(),i:z.string(),o:price,h:price,l:price,c:price,v:numeric.pipe(z.number().nonnegative())});
export class HistoricalFlowLoader {
  private inflight = new Map<string, Promise<HistoricalFlowData>>();
  constructor(private cache:BacktestCache,private request:typeof fetch=fetch,private dex:'hyperliquid'|'lighter'='hyperliquid') {}
  async load(document:FlowDocument,settings:FlowBacktestSettings,signal:AbortSignal,refresh=false):Promise<HistoricalFlowData> {
    signal.throwIfAborted();
    const key=hash({market:settings.market,from:settings.from,to:settings.to,counts:flowHistoryRequirements(document,settings),refresh});
    let task=this.inflight.get(key);
    if(!task){task=this.fetchData(document,settings,AbortSignal.timeout(60000),refresh).finally(()=>this.inflight.delete(key));this.inflight.set(key,task);}
    let abort=()=>{};
    const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(new Error('History loading cancelled'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
    try{return await Promise.race([task,cancelled]);}finally{signal.removeEventListener('abort',abort);}
  }
  private async fetchData(document:FlowDocument,settings:FlowBacktestSettings,signal:AbortSignal,refresh=false):Promise<HistoricalFlowData> {
    const counts=flowHistoryRequirements(document,settings), from=Date.parse(settings.from),to=Date.parse(settings.to),coin=settings.market.replace(/-PERP$/,'');
    if(to>Date.now()) throw new Error('Backtest end must be in the past');
    const key=hash({provider:`${this.dex}-history-v1`,market:settings.market,from,to,counts});
    if(!refresh){const cached=await this.cache.get<HistoricalFlowData>(key,3600000);if(cached) return cached;}
    if(this.dex==='lighter') {
      const data=await loadLighterHistory(settings.market,from,to,counts,signal,this.request);
      signal.throwIfAborted();await this.cache.set(key,data).catch(()=>{});return data;
    }
    const info=async(body:unknown):Promise<unknown>=>{
      for(let attempt=0;attempt<3;attempt++){
        signal.throwIfAborted();
        const response=await this.request('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
        if(response.ok)return response.json();
        if((response.status===429 || response.status>=500)&&attempt<2){await new Promise(resolve=>setTimeout(resolve,250*2**attempt));continue;}
        throw new Error(`Historical market request failed (${response.status})`);
      }
      throw new Error('Historical request retry limit reached');
    };
    const candles:HistoricalFlowData['candles']={};
    // Sequential bounded requests respect provider limits; duplicate jobs are joined by the host.
    for(const [timeframe,count] of Object.entries(counts)){
      const duration=intervalMs(timeframe), start=Math.floor(from/duration)*duration-count*duration;
      if((to-start)/duration>5000) throw new Error(`${timeframe}: requested range plus warm-up exceeds 5000 candles; shorten the range`);
      const rows=z.array(row).max(5001).parse(await info({type:'candleSnapshot',req:{coin,interval:timeframe,startTime:start,endTime:to-1}}));
      const selected=rows.filter(bar=>bar.t>=start&&bar.T<to).sort((a,b)=>a.t-b.t);
      if(!selected.length || selected[0].t!==start || selected.at(-1)!.T!==Math.floor(to/duration)*duration-1) throw new Error(`${timeframe}: history is incomplete or outside Hyperliquid's latest 5000 candles; choose a more recent range`);
      if(selected.some((bar,index)=>bar.s!==coin||bar.i!==timeframe||bar.T!==bar.t+duration-1||bar.h<Math.max(bar.o,bar.c,bar.l)||bar.l>Math.min(bar.o,bar.c)||index>0&&bar.t!==selected[index-1].t+duration)) throw new Error(`${timeframe}: invalid or missing candles`);
      candles[timeframe]=selected.map(bar=>({closedAt:bar.T,open:bar.o,high:bar.h,low:bar.l,close:bar.c,volume:bar.v}));
    }
    const funding:HistoricalFlowData['funding']=[];
    let cursor=Math.ceil(from/3600000)*3600000;
    while(cursor<to){
      const records=z.array(z.object({coin:z.string(),fundingRate:numeric,time:z.number().int()})).max(1000).parse(await info({type:'fundingHistory',coin,startTime:cursor,endTime:to-1}));
      if(!records.length) break;
      const sorted=records.sort((a,b)=>a.time-b.time);
      if(sorted.some(record=>record.coin!==coin||record.time<cursor||record.time>=to||record.time%3600000>=60000))throw new Error('Unexpected funding history');
      funding.push(...sorted.map(record=>({at:Math.floor(record.time/3600000)*3600000,reportedAt:record.time,rate:record.fundingRate})));
      cursor=sorted.at(-1)!.time+1;
      if(sorted.at(-1)!.time>=Math.floor((to-1)/3600000)*3600000)break;
      if(funding.length>10000)throw new Error('Funding history limit exceeded');
    }
    const actual=new Map(funding.map(value=>[value.at,value.rate]));
    if(actual.size!==funding.length)throw new Error('Duplicate funding history');
    for(let at=Math.ceil(from/3600000)*3600000;at<to;at+=3600000)if(!actual.has(at))throw new Error('Hourly funding history is incomplete');
    const result:HistoricalFlowData={source:'Hyperliquid mainnet OHLCV + historical funding',fetchedAt:new Date().toISOString(),candles,funding};
    signal.throwIfAborted();await this.cache.set(key,result).catch(()=>{});return result;
  }
}
