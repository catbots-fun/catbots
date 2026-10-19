import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { FlowDeployment } from '@catbots/contracts';
import { RuntimeIncidents } from '../src/main/connections/runtime-incidents';
import { ConnectionsService } from '../src/main/connections/service';
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const run:FlowDeployment={id:'run',botId:'bot',version:1,environment:'testnet',target:{botId:'bot',connectionId:'conn',accountId:'secret-wallet',market:'ETH-PERP',maxOrderUsd:50,maxPositionUsd:100},status:'failed',startedAt:new Date(0).toISOString(),cycles:0,orders:[],events:[],error:'secret-api-key'};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'runtime-incidents-'));dirs.push(dir);return join(dir,'incidents.json');}
it('records and deduplicates incidents across restart without retaining raw account or error data',async()=>{
 const path=fixture();let deliveries=0;const notify=async()=>{deliveries++;};
 const monitor=new RuntimeIncidents(path,notify);
 await monitor.scan([run],1000);await monitor.scan([run],2000);
 const reopened=new RuntimeIncidents(path,notify);await reopened.scan([run],3000);
 expect(deliveries).toBe(1);expect(reopened.list('bot')).toHaveLength(1);
 expect(reopened.list('bot')[0]).toMatchObject({code:'runtime_failed',phase:'detected',delivery:'shown'});
 expect(readFileSync(path,'utf8')).not.toContain('secret');
});
it('records clearing and a new occurrence rather than flooding unchanged state',async()=>{
 const monitor=new RuntimeIncidents(fixture(),async()=>{});
 await monitor.scan([run],1000);
 const recovered={...run,status:'running' as const,health:{state:'responsive' as const,recovery:'not-assessed' as const}};
 await monitor.scan([recovered],2000);await monitor.scan([recovered],3000);await monitor.scan([run],4000);
 expect(monitor.list('bot').map(event=>event.phase)).toEqual(['detected','cleared','detected']);
});
it('bounds failed delivery retries and preserves the budget across restart',async()=>{
 const path=fixture();let attempts=0;const notify=async()=>{attempts++;throw new Error('secret destination error');};
 let monitor=new RuntimeIncidents(path,notify);
 await monitor.scan([run],1000);await monitor.scan([run],2000);expect(attempts).toBe(1);
 monitor=new RuntimeIncidents(path,notify);
 await monitor.scan([run],31000);await monitor.scan([run],61000);await monitor.scan([run],91000);
 expect(attempts).toBe(3);expect(monitor.list('bot')[0].delivery).toBe('unavailable');
 expect(readFileSync(path,'utf8')).not.toContain('secret');
});
it('does not clear an observed incident merely because a deployment is missing',async()=>{
 const monitor=new RuntimeIncidents(fixture(),async()=>{});await monitor.scan([run],1000);await monitor.scan([],2000);
 expect(monitor.list('bot')).toHaveLength(1);
});
it('serializes overlapping scans and does not notify before durable recording',async()=>{
 const path=fixture();let release!:()=>void;let deliveries=0;
 const monitor=new RuntimeIncidents(path,async()=>{deliveries++;expect(readFileSync(path,'utf8')).toContain('runtime_failed');await new Promise<void>(resolve=>{release=resolve;});});
 const first=monitor.scan([run],1000);await Promise.resolve();await monitor.scan([run],1000);
 expect(deliveries).toBe(1);release();await first;
});
it('marks an exhausted attempt interrupted by process exit as unavailable without resending',async()=>{
 const path=fixture();const monitor=new RuntimeIncidents(path,async()=>{throw new Error('offline');});await monitor.scan([run],1000);
 const saved=JSON.parse(readFileSync(path,'utf8'));saved.events[0].attempts=3;writeFileSync(path,JSON.stringify(saved));
 let deliveries=0;const reopened=new RuntimeIncidents(path,async()=>{deliveries++;});await reopened.scan([run],100000);
 expect(reopened.list('bot')[0].delivery).toBe('unavailable');expect(deliveries).toBe(0);
});
it('integrates background monitoring and the runtime API without a UI poll driving detection',async()=>{
 const path=fixture();const botId='00000000-0000-4000-8000-000000000001';
 const view={...run,botId};
 writeFileSync(`${path}.runtime`,JSON.stringify({[botId]:{view,target:view.target,document:{nodes:[],edges:[]}}}));
 const service=new ConnectionsService(path);let delivered=0;
 try {
  service.startIncidentMonitoring(async()=>{delivered++;});
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(delivered).toBe(1);
  const result=await service.command({action:'get_flow_runtime',botId});
  expect(result.incidents?.[0]).toMatchObject({code:'runtime_failed',delivery:'shown'});
 } finally {await service.dispose();}
});
it('does not deliver if durable incident recording fails',async()=>{
 const path=fixture();writeFileSync(path,'not a directory');let delivered=0;
 const monitor=new RuntimeIncidents(join(path,'blocked'),async()=>{delivered++;});
 await expect(monitor.scan([run],1000)).rejects.toThrow();expect(delivered).toBe(0);expect(monitor.list('bot')).toHaveLength(0);
});
it('does not report close recovery while a retry is still pending verification',async()=>{
 const monitor=new RuntimeIncidents(fixture(),async()=>{});
 const closing={...run,status:'stopped' as const,closeResult:'needs-attention' as const};
 await monitor.scan([closing],1000);
 await monitor.scan([{...closing,status:'stopping',closeResult:'pending'}],6000);
 expect(monitor.list('bot').filter(event=>event.code==='close_unverified').map(event=>event.phase)).toEqual(['detected']);
 await monitor.scan([{...closing,closeResult:'closed'}],11000);
 expect(monitor.list('bot').filter(event=>event.code==='close_unverified')[0].phase).toBe('cleared');
});
it('does not deliver a queued recovery from a superseded deployment',async()=>{
 const delivered:{deploymentId:string;phase:string}[]=[];
 const monitor=new RuntimeIncidents(fixture(),async event=>{delivered.push(event);});
 await monitor.scan([run],1000);
 await monitor.scan([{...run,status:'running'}],2000);
 await monitor.scan([{...run,id:'replacement'}],31000);
 expect(delivered.map(event=>[event.deploymentId,event.phase])).toEqual([['run','detected'],['replacement','detected']]);
});
it.each(['snapshot_unavailable','position_mismatch'] as const)('records a typed %s incident through stop until the cause is cleared',async failureCode=>{
 const monitor=new RuntimeIncidents(fixture(),async()=>{});
 await monitor.scan([{...run,failureCode}],1000);
 const code=failureCode==='snapshot_unavailable'?'exchange_snapshot_unavailable':'position_mismatch';
 expect(monitor.list('bot').some(event=>event.code===code&&event.phase==='detected')).toBe(true);
 await monitor.scan([{...run,status:'stopped',failureCode}],2000);
 expect(monitor.list('bot').filter(event=>event.code===code)).toHaveLength(1);
 await monitor.scan([{...run,status:'running'}],3000);
 expect(monitor.list('bot').find(event=>event.code===code)?.phase).toBe('cleared');
});
