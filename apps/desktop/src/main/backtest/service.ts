import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { FlowBacktestCommandSchema, type ChatFlowDraft, type FlowBacktestJob, type FlowBacktestResult, type FlowBacktestSettings } from '@catbots/contracts';
import { FLOW_BACKTEST_ENGINE, flowHistoryRequirements, runtimeNodePackages, type FlowDocument, type HistoricalFlowData } from '@catbots/strategy-runtime';
import { BacktestCache, hash } from './cache';
import { HistoricalFlowLoader } from './history';
type Execute = (document:FlowDocument,settings:FlowBacktestSettings,data:HistoricalFlowData,signal:AbortSignal,progress:(value:number)=>void)=>Promise<FlowBacktestResult>;
export class FlowBacktestService {
  private jobs=new Map<string,{view:FlowBacktestJob;controller:AbortController;key:string}>();
  private cache:BacktestCache;
  private loaders:Record<'hyperliquid'|'lighter',HistoricalFlowLoader>;
  constructor(directory:string,private getDraft:(botId:string)=>ChatFlowDraft|undefined,private execute:Execute=runWorker,request:typeof fetch=fetch,private getDex:(botId:string)=>'hyperliquid'|'lighter'=()=> 'hyperliquid'){this.cache=new BacktestCache(join(directory,'results'));const cache=new BacktestCache(join(directory,'data'));this.loaders={hyperliquid:new HistoricalFlowLoader(cache,request),lighter:new HistoricalFlowLoader(cache,request,'lighter')};}
  command(input:unknown):FlowBacktestJob {
    const command=FlowBacktestCommandSchema.parse(input);
    if(command.action!=='backtest_flow'){
      const job=this.jobs.get(command.jobId);if(!job||job.view.botId!==command.botId)throw new Error('Backtest not found');
      if(command.action==='cancel_backtest'&&['loading','running'].includes(job.view.status)){job.view.status='cancelled';job.controller.abort();}
      return structuredClone(job.view);
    }
    const draft=this.getDraft(command.botId);
    if(!draft||draft.version!==command.version)throw new Error('Flow changed; reload before backtesting');
    const pinned=structuredClone(draft.document);
    const key=hash({botId:command.botId,version:command.version,document:pinned,settings:command.settings,refresh:command.refresh});
    const joined=[...this.jobs.values()].find(job=>job.key===key&&['loading','running'].includes(job.view.status));if(joined)return structuredClone(joined.view);
    if([...this.jobs.values()].filter(job=>['loading','running'].includes(job.view.status)).length>=2)throw new Error('Two backtests are already active');
    if(this.jobs.size>=20){const oldest=[...this.jobs].find(([,job])=>!['loading','running'].includes(job.view.status));if(oldest)this.jobs.delete(oldest[0]);}
    const job={view:{id:randomUUID(),botId:command.botId,version:command.version,status:'loading',progress:0,cacheHit:false} as FlowBacktestJob,controller:new AbortController(),key};
    this.jobs.set(job.view.id,job);
    void this.run(job,pinned,command.settings,command.refresh).catch(error=>{if(job.view.status!=='cancelled'){job.view.status='failed';job.view.error=error instanceof Error?error.message:'Backtest failed';}});
    return structuredClone(job.view);
  }
  private async run(job:{view:FlowBacktestJob;controller:AbortController},document:FlowDocument,settings:FlowBacktestSettings,refresh:boolean){
    flowHistoryRequirements(document,settings);
    const signal=job.controller.signal;
    const data=await this.loaders[this.getDex(job.view.botId)].load(document,settings,signal,refresh);signal.throwIfAborted();
    const dataHash=hash({source:data.source,candles:data.candles,funding:data.funding}),flowHash=hash(document);
    const resultKey=hash({engine:FLOW_BACKTEST_ENGINE,packages:runtimeNodePackages.map(pkg=>({name:pkg.name,version:pkg.version,nodes:pkg.definitions.map(node=>[node.type,node.version])})),dataHash,flowHash,settings});
    const cached=refresh?undefined:await this.cache.get<FlowBacktestResult>(resultKey,24*3600000);signal.throwIfAborted();
    if(cached && cached.engineVersion===FLOW_BACKTEST_ENGINE && cached.flowHash===flowHash && cached.dataHash===dataHash){job.view.result=cached;job.view.cacheHit=true;}else{
      job.view.status='running';
      const result=await this.execute(document,settings,data,signal,progress=>{job.view.progress=Math.max(0,Math.min(1,progress));});signal.throwIfAborted();
      if(result.engineVersion!==FLOW_BACKTEST_ENGINE)throw new Error('Backtest worker version changed; restart the backend before retrying');
      result.dataHash=dataHash;result.flowHash=flowHash;
      await this.cache.set(resultKey,result).catch(()=>{});signal.throwIfAborted();job.view.result=result;
    }
    job.view.status='completed';job.view.progress=1;
  }
  dispose(){for(const job of this.jobs.values())if(['loading','running'].includes(job.view.status)){job.view.status='cancelled';job.controller.abort();}}
}
function runWorker(document:FlowDocument,settings:FlowBacktestSettings,data:HistoricalFlowData,signal:AbortSignal,progress:(value:number)=>void):Promise<FlowBacktestResult>{
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const worker=new Worker(join(__dirname,'flow-backtest-worker.js'),{workerData:{document,settings,data},resourceLimits:{maxOldGenerationSizeMb:256}});
    let settled=false;
    const finish=(error?:Error,result?:FlowBacktestResult)=>{if(settled)return;settled=true;clearTimeout(timeout);signal.removeEventListener('abort',abort);void worker.terminate();error?reject(error):resolve(result!);};
    const abort=()=>finish(new Error('Backtest cancelled'));
    const timeout=setTimeout(()=>finish(new Error('Backtest exceeded 120 seconds; shorten the range')),120000);
    signal.addEventListener('abort',abort,{once:true});
    worker.on('message',message=>{if(message.error)finish(new Error(message.error));else if(message.result)finish(undefined,message.result);else if(typeof message.progress==='number')progress(message.progress);});
    worker.once('error',error=>finish(error));worker.once('exit',()=>{if(!settled)finish(new Error('Backtest worker stopped unexpectedly'));});
  });
}
