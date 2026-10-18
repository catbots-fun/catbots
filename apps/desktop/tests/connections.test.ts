import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionsService } from '../src/main/connections/service';
import { FlowAuditStore } from '../src/main/connections/flow-audit';
import { HyperliquidAdapter, type ExchangeAdapter } from '../src/main/connections/adapters';
const directories:string[]=[];
afterEach(()=>directories.splice(0).forEach(path=>rmSync(path,{recursive:true,force:true})));
const file=()=>{const path=mkdtempSync(join(tmpdir(),'connections-'));directories.push(path);return join(path,'saved.json');};
const owner='0x'+'1'.repeat(40),sub='0x'+'2'.repeat(40);
it('reads bounded bot-isolated audit pages without a connection or runtime snapshot', async () => {
 const path=file(),service=new ConnectionsService(path,[]),store=new FlowAuditStore(`${path}.runtime.audit.sqlite`);
 const botId='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
 const event={botId,deploymentId:'old-run',version:1,kind:'evaluation' as const,details:{apiKey:'private-value',orders:[]}};
 store.append(event);store.append({...event,botId:other});store.append({...event,deploymentId:'new-run'});
 const first=await service.command({action:'get_flow_audit',botId,limit:1});
 expect(first.auditPage).toMatchObject({records:[{sequence:1,deploymentId:'old-run',details:{apiKey:'[REDACTED]',orders:[]}}],nextAfter:1});
 expect(first.auditPage?.records).toHaveLength(1);
 const second=await service.command({action:'get_flow_audit',botId,after:1,limit:1});
 expect(second.auditPage).toMatchObject({records:[{sequence:3,deploymentId:'new-run'}]});
 expect(second.auditPage?.nextAfter).toBeUndefined();
 expect((await service.command({action:'get_flow_audit',botId,after:3})).auditPage).toEqual({records:[]});
 expect((await new ConnectionsService(file(),[]).command({action:'get_flow_audit',botId})).auditPage).toEqual({records:[]});
});

it('rejects unbounded or invalid audit requests',async()=>{
 const service=new ConnectionsService(file(),[]),base={action:'get_flow_audit',botId:'00000000-0000-4000-8000-000000000001'};
 for(const invalid of [{after:-1},{after:0.5},{after:Number.MAX_SAFE_INTEGER+1},{limit:0},{limit:51},{botId:'invalid'},{unexpected:true}])
   await expect(service.command({...base,...invalid})).rejects.toThrow();
});
it('discovers main/subaccounts using their real addresses and a fixed environment endpoint',async()=>{
 const request=vi.fn(async(_url:unknown,init:any)=>{const body=JSON.parse(init.body);return {ok:true,json:async()=>body.type==='userAbstraction'?'unifiedAccount':body.type==='spotClearinghouseState'?{balances:[{coin:'USDC',token:0,total:'999.00000000'}]}:body.type==='userRole'?{role:'user'}:body.type==='subAccounts'?[{name:'Trend',subAccountUser:sub}]:{marginSummary:{accountValue:'250'},withdrawable:'200',assetPositions:[{position:{szi:'1'}}]}};});
 const accounts=await new HyperliquidAdapter(request as never).discover(owner,'testnet');
 expect(accounts.map(item=>item.kind)).toEqual(['main','subaccount']);expect(accounts[1]).toMatchObject({equity:'250',withdrawable:'200',positions:1,accountMode:'unifiedAccount',usdcBalance:'999.00000000'});
 expect(request.mock.calls.map(([,init])=>JSON.parse(init.body)).filter(body=>body.type==='clearinghouseState').map(body=>body.user)).toEqual([owner,sub]);
 expect(request.mock.calls.every(([url])=>url==='https://api.hyperliquid-testnet.xyz/info')).toBe(true);
});
it('rejects API-wallet addresses and malformed balances rather than displaying zero',async()=>{
 const request=vi.fn(async()=>({ok:true,json:async()=>({role:'agent'})}));
 await expect(new HyperliquidAdapter(request as never).discover(owner,'production')).rejects.toThrow('main account');
 expect(request).toHaveBeenCalledTimes(1);
});
it('supports another adapter without Hyperliquid address rules and persists across restart',async()=>{
 const adapter:ExchangeAdapter={descriptor:{id:'test-exchange',name:'Test exchange',environments:['production'],authentication:['public-address'],capabilities:{accountDiscovery:true,markets:['spot'],trading:false}},normalizeOwner:value=>value,discover:vi.fn(async()=>[])};
 const path=file(),service=new ConnectionsService(path,[adapter]);
 const input={action:'connect',adapterId:'test-exchange',name:'Personal',environment:'production',owner:'CaseSensitiveAccount'};
 const first=await service.command(input);expect(first.connections[0].owner).toBe('CaseSensitiveAccount');expect(first.connections[0].permission).toBe('view-only');
 const second=await service.command(input);expect(second.connections).toHaveLength(1);
 expect((await new ConnectionsService(path,[adapter]).command({action:'list'})).connections).toEqual(second.connections);
 await expect(service.command({...input,environment:'testnet'})).rejects.toThrow('environment');
});
it('preserves the last successful snapshot when refresh fails',async()=>{
 const adapter:ExchangeAdapter={descriptor:{id:'test',name:'Test',environments:['production'],authentication:['public-address'],capabilities:{accountDiscovery:true,markets:[],trading:false}},normalizeOwner:v=>v,discover:vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('offline'))};
 const service=new ConnectionsService(file(),[adapter]);const saved=await service.command({action:'connect',adapterId:'test',name:'One',environment:'production',owner:'x'});
 await expect(service.command({action:'refresh',id:saved.connections[0].id})).rejects.toThrow('offline');
 expect(await service.command({action:'list'})).toEqual(saved);
});

it('persists an explicit target, rejects a cross-account target and never claims runtime readiness',async()=>{
 const account={id:'sub',address:'sub',name:'Sub',kind:'subaccount' as const,equity:'100',withdrawable:'100',positions:0};
 const adapter:ExchangeAdapter={descriptor:{id:'test',name:'Test',environments:['testnet'],authentication:['public-address'],capabilities:{accountDiscovery:true,markets:['perpetual'],trading:false}},normalizeOwner:v=>v,discover:async()=>[account]};
 const path=file(),service=new ConnectionsService(path,[adapter]);const connected=await service.command({action:'connect',adapterId:'test',name:'A',environment:'testnet',owner:'owner'});
 const target={botId:'00000000-0000-4000-8000-000000000001',connectionId:connected.connections[0].id,accountId:'sub',market:'ETH-PERP',maxPositionUsd:500,maxOrderUsd:100};
 await expect(service.command({action:'save_target',target:{...target,accountId:'other'}})).rejects.toThrow('belonging');
 await expect(service.command({action:'save_target',target:{...target,maxOrderUsd:600}})).rejects.toThrow();
 await service.command({action:'save_target',target});
 const restored=await new ConnectionsService(path,[adapter]).command({action:'get_target',botId:target.botId});
 expect(restored.executionTarget).toMatchObject({target,environment:'testnet',accountName:'Sub',ready:false});
 const checked=await service.command({action:'check_target',botId:target.botId});expect(checked.executionTarget?.checks).toEqual(expect.arrayContaining([expect.objectContaining({label:'Trading account',passed:true}),expect.objectContaining({label:'Workflow execution runtime',passed:false})]));
 await expect(service.command({action:'remove',id:target.connectionId})).rejects.toThrow('selected by a bot');
});

it('shares account snapshots across bots without assigning manual orders to a bot and isolates failures',async()=>{
 const activity=vi.fn(async()=>({fetchedAt:new Date().toISOString(),positions:[{market:'SOL-PERP',size:'-0.14',entryPrice:'100',unrealizedPnl:'1'}],orders:[{id:'123',market:'SOL-PERP',side:'Buy',size:'0.14',price:'99'}]}));
 const adapter:ExchangeAdapter={descriptor:{id:'test',name:'Test',environments:['testnet'],authentication:['public-address'],capabilities:{accountDiscovery:true,markets:['perpetual'],trading:false}},normalizeOwner:v=>v,discover:async()=>[{id:'sub',address:'sub',name:'Sub',kind:'subaccount',equity:'100',withdrawable:'100',positions:1}],activity};
 const service=new ConnectionsService(file(),[adapter]);
 const connected=await service.command({action:'connect',adapterId:'test',name:'A',environment:'testnet',owner:'owner'});
 const botIds=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
 for(const botId of botIds)await service.command({action:'save_target',target:{botId,connectionId:connected.connections[0].id,accountId:'sub',market:'SOL-PERP',maxPositionUsd:50,maxOrderUsd:20}});
 const view=await service.command({action:'bot_overview',botIds});
 expect(activity).toHaveBeenCalledTimes(1);
 expect(activity).toHaveBeenCalledWith('sub','testnet');
 expect(view.botOverview?.[0]).toMatchObject({environment:'testnet',activity:{orders:[{id:'123'}]}});
 expect(view.botOverview?.[0].deployment).toBeUndefined();
 await service.command({action:'bot_overview',botIds});expect(activity).toHaveBeenCalledTimes(1);
 const offline=new ConnectionsService(file(),[{...adapter,activity:async()=>{throw new Error('secret upstream error');}}]);
 const c=await offline.command({action:'connect',adapterId:'test',name:'B',environment:'testnet',owner:'owner'});
 await offline.command({action:'save_target',target:{botId:botIds[0],connectionId:c.connections[0].id,accountId:'sub',market:'SOL-PERP',maxPositionUsd:50,maxOrderUsd:20}});
 const failed=await offline.command({action:'bot_overview',botIds});
 expect(failed.botOverview?.[0].activity).toBeUndefined();
 expect(failed.botOverview?.[0].activityError).toBe('Exchange data unavailable. Retry refresh.');
 expect(failed.botOverview?.[1].activityError).toBeUndefined();
});
