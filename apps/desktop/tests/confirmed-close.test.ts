import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Fill, FlowDocument, OrderPlan } from '@catbots/strategy-runtime';
import { FlowRunner } from '../src/main/connections/flow-runner';
import { FlowAuditStore } from '../src/main/connections/flow-audit';
import { OrderRejectedError, type FlowVenue } from '../src/main/connections/flow-venue';
const dirs:string[]=[]; const runners:FlowRunner[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(runners.splice(0).map(r=>r.dispose()));vi.useRealTimers();dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});
async function fixture(long=true) {
 vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
 const dir=mkdtempSync(join(tmpdir(),'confirmed-close-'));dirs.push(dir);
 const path=join(dir,'runs');const reopen=()=>{const r=new FlowRunner(path);runners.push(r);return r;};
 const runner=reopen();
 const target={botId:'00000000-0000-4000-8000-000000000001',connectionId:'00000000-0000-4000-8000-000000000002',accountId:'account',market:'SOL-PERP',maxOrderUsd:50,maxPositionUsd:100};
 const flow:FlowDocument={schemaVersion:'3.0',nodes:[
  ...['fast','slow','rsi','atr'].map((id,i)=>({id,type:'process.number',version:1,config:{value:(long?[101,100,65,1]:[99,100,35,1])[i]}})),
  {id:'controller',type:'strategy.directional',version:1,config:{quotePerOrder:20}},
 ],edges:['fast','slow','rsi','atr'].map(id=>({source:id,sourcePort:'value',target:'controller',targetPort:id}))};
 const exchange={position:0,offline:false,openOrders:0};const submitted:OrderPlan[]=[];
 const fill=(order:OrderPlan,quantity=order.quantity):Fill=>{exchange.position+=(order.side==='buy'?1:-1)*quantity;return {id:`fill-${submitted.length}`,clientOrderId:order.clientOrderId,side:order.side,quantity,price:100,fee:.01};};
 let execute:(order:OrderPlan)=>Promise<Fill|null>=async order=>fill(order);
 const venue:FlowVenue={snapshot:async()=>{
  if(exchange.offline)throw new Error('offline');
  return {context:{market:target.market,at:Date.now(),price:100,equity:1000,candles:{},fills:[],cancelledOrderIds:[]},position:exchange.position,available:1000,openOrders:exchange.openOrders,sizeDecimals:2,asset:1};
 },place:async order=>{submitted.push(order);return execute(order);}};
 const started=await runner.start(target.botId,1,flow,target,'testnet',venue);
 await vi.advanceTimersByTimeAsync(1000);
 return {runner,reopen,target,flow,venue,started,exchange,submitted,fill,setExecution:(fn:typeof execute)=>{execute=fn;},close:()=>runner.closePosition(target.botId,started.id,'CLOSE SOL-PERP',venue)};
}
it.each([true,false])('closes confirmed inventory reduce-only and requires a new controller (long=%s)',async long=>{
 const f=await fixture(long);const result=await f.close();
 expect(f.submitted[1]).toMatchObject({side:long?'sell':'buy',quantity:.2,reduceOnly:true});
 expect(result).toMatchObject({status:'stopped',position:0,closeResult:'closed'});
 await f.close();expect(f.submitted).toHaveLength(2);
 const next=await f.runner.start(f.target.botId,1,f.flow,f.target,'testnet',f.venue);
 expect(next.id).not.toBe(f.started.id);
});
it('requires exact confirmation and current deployment before stopping',async()=>{
 const f=await fixture();
 await expect(f.runner.closePosition(f.target.botId,f.started.id,'CLOSE ETH-PERP',f.venue)).rejects.toThrow('confirmation');
 await expect(f.runner.closePosition(f.target.botId,'stale','CLOSE SOL-PERP',f.venue)).rejects.toThrow('changed');
 expect(f.runner.get(f.target.botId)?.status).toBe('running');expect(f.submitted).toHaveLength(1);
});
it('refuses to submit a close without a durable intent audit',async()=>{
 const f=await fixture();await f.runner.stop(f.target.botId);
 vi.spyOn(FlowAuditStore.prototype,'append').mockImplementation(()=>{throw new Error('audit unavailable');});
 await expect(f.close()).rejects.toThrow('audit unavailable');expect(f.submitted).toHaveLength(1);
 expect(f.runner.get(f.target.botId)).toMatchObject({position:.2,closeResult:'needs-attention'});
});
it('does not expose close for arbitrary action workflows',async()=>{
 const f=await fixture();await f.runner.stop(f.target.botId);f.exchange.position=0;
 const flow:FlowDocument={schemaVersion:'3.0',nodes:[{id:'tick',type:'trigger.tick',version:1,config:{}},{id:'size',type:'process.number',version:1,config:{value:.2}},{id:'buy',type:'action.flow_order',version:1,config:{side:'buy',reduceOnly:false}}],edges:[{source:'tick',sourcePort:'flow',target:'buy',targetPort:'flow'},{source:'size',sourcePort:'value',target:'buy',targetPort:'quantity'}]};
 const next=await f.runner.start(f.target.botId,2,flow,f.target,'testnet',f.venue);
 expect(next.closePositionSupported).toBe(false);
 await expect(f.runner.closePosition(f.target.botId,next.id,'CLOSE SOL-PERP',f.venue)).rejects.toThrow('supported');
});
it.each(['position','orders','offline'] as const)('refuses unsafe fresh snapshot: %s',async mode=>{
 const f=await fixture();if(mode==='position')f.exchange.position=.1;else if(mode==='orders')f.exchange.openOrders=1;else f.exchange.offline=true;
 await expect(f.close()).rejects.toThrow();expect(f.submitted).toHaveLength(1);
});
it('preserves uncertain close across restart, blocks same-account starts and never resends',async()=>{
 const f=await fixture();let terminal:Fill|undefined;
 f.setExecution(async order=>{terminal=f.fill(order);throw new Error('timeout');});
 await expect(f.close()).rejects.toThrow('timeout');
 expect(f.runner.get(f.target.botId)).toMatchObject({position:.2,closeResult:'needs-attention'});
 const r=f.reopen();
 await expect(r.closePosition(f.target.botId,f.started.id,'CLOSE SOL-PERP',f.venue)).rejects.toThrow('unresolved');
 const other={...f.target,botId:'00000000-0000-4000-8000-000000000003'};
 await expect(r.start(other.botId,1,f.flow,other,'testnet',f.venue)).rejects.toThrow('unresolved');
 f.venue.reconcile=async()=>undefined;await expect(r.reconcile(f.target.botId,f.venue)).rejects.toThrow('terminal');
 f.venue.reconcile=async()=>terminal;await r.reconcile(f.target.botId,f.venue);
 expect(r.get(f.target.botId)).toMatchObject({position:0,closeResult:'closed'});expect(f.submitted).toHaveLength(2);
});
it('keeps terminal partial close visible and uses a new ID only after another explicit close',async()=>{
 const f=await fixture();f.setExecution(async order=>f.fill(order,.1));
 expect(await f.close()).toMatchObject({position:.1,closeResult:'needs-attention'});
 await expect(f.runner.start(f.target.botId,1,f.flow,f.target,'testnet',f.venue)).rejects.toThrow();
 await vi.advanceTimersByTimeAsync(60000);expect(f.submitted).toHaveLength(2);
 expect(await f.close()).toMatchObject({position:0,closeResult:'closed'});
 expect(f.submitted[2]).toMatchObject({quantity:.1,reduceOnly:true});expect(f.submitted[2].clientOrderId).not.toBe(f.submitted[1].clientOrderId);
});
it('retains pending ownership on malformed fill and handles definitive rejection without reporting flat',async()=>{
 const f=await fixture();f.setExecution(async order=>({...f.fill(order),quantity:1}));
 await expect(f.close()).rejects.toThrow('fill');
 expect(f.runner.get(f.target.botId)?.orders.at(-1)?.status).toBe('uncertain');
});
it('records exchange rejection without auto-retry',async()=>{
 const f=await fixture();f.setExecution(async()=>{throw new OrderRejectedError('rejected');});
 await expect(f.close()).rejects.toThrow('rejected');
 expect(f.runner.get(f.target.botId)?.orders.at(-1)?.status).toBe('rejected');
 expect(f.runner.get(f.target.botId)?.position).toBe(.2);await vi.advanceTimersByTimeAsync(60000);expect(f.submitted).toHaveLength(2);
});
it('does not claim flat if the post-fill snapshot fails and can verify later without resubmission',async()=>{
 const f=await fixture();f.setExecution(async order=>{const result=f.fill(order);f.exchange.offline=true;return result;});
 await expect(f.close()).rejects.toThrow('offline');expect(f.runner.get(f.target.botId)?.closeResult).toBe('needs-attention');
 f.exchange.offline=false;await f.runner.reconcile(f.target.botId,f.venue);
 expect(f.runner.get(f.target.botId)?.closeResult).toBe('closed');expect(f.submitted).toHaveLength(2);
});
it('reserves account during close preflight and rejects concurrent start and duplicate close',async()=>{
 const f=await fixture();const snapshot=f.venue.snapshot;let release!:()=>void;
 f.venue.snapshot=async times=>{await new Promise<void>(resolve=>{release=resolve;});return snapshot(times);};
 const closing=f.close();await vi.advanceTimersByTimeAsync(0);
 try {
  expect(f.runner.connectionRunning(f.target.connectionId)).toBe(true);
  await expect(f.close()).rejects.toThrow('progress');
  const other={...f.target,botId:'00000000-0000-4000-8000-000000000003'};
  await expect(f.runner.start(other.botId,1,f.flow,other,'testnet',f.venue)).rejects.toThrow();
 } finally {f.venue.snapshot=snapshot;release();}
 await closing;expect(f.submitted).toHaveLength(2);
});
it('rejects a stale start preflight after a partial close reserved the account',async()=>{
 const f=await fixture();await f.runner.stop(f.target.botId);
 const snapshot=f.venue.snapshot;let release!:()=>void;
 const delayedVenue:FlowVenue={...f.venue,snapshot:async times=>{const captured=await snapshot(times);await new Promise<void>(resolve=>{release=resolve;});return {...captured,position:0};}};
 const other={...f.target,botId:'00000000-0000-4000-8000-000000000003'};
 const starting=f.runner.start(other.botId,1,f.flow,other,'testnet',delayedVenue).then(value=>({value}),error=>({error}));
 await vi.advanceTimersByTimeAsync(0);
 f.setExecution(async order=>f.fill(order,.1));await f.close();release();
 expect(await starting).toHaveProperty('error');expect(f.submitted).toHaveLength(2);
});
it('waits for a submitted entry to settle before closing its confirmed inventory',async()=>{
 const f=await fixture();await f.runner.stop(f.target.botId);
 // Resume with a pending new directional order is exercised from a second flat bot.
 f.exchange.position=0;
 const other={...f.target,botId:'00000000-0000-4000-8000-000000000003'};
 let release!:()=>void;
 f.setExecution(order=>new Promise(resolve=>{release=()=>resolve(f.fill(order));}));
 const started=await f.runner.start(other.botId,1,f.flow,other,'testnet',f.venue);
 await vi.advanceTimersByTimeAsync(1000);
 const closing=f.runner.closePosition(other.botId,started.id,'CLOSE SOL-PERP',f.venue);
 // Attach rejection handling immediately while testing the asynchronous close.
 const outcome=closing.then(value=>({value}),error=>({error}));
 await vi.advanceTimersByTimeAsync(0);
 try {
  expect(f.submitted).toHaveLength(2);
  await expect(f.runner.reconcile(f.target.botId,f.venue)).rejects.toThrow('account');
 } finally {f.setExecution(async order=>f.fill(order));release();}
 const result=await outcome;
 expect(result).toMatchObject({value:{position:0,closeResult:'closed'}});
 expect(f.submitted[2]).toMatchObject({quantity:.2,reduceOnly:true});
});
