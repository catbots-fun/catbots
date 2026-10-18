import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionsService } from '../src/main/connections/service';
import { HyperliquidAdapter, type ExchangeAdapter } from '../src/main/connections/adapters';
const directories:string[]=[];
afterEach(()=>directories.splice(0).forEach(path=>rmSync(path,{recursive:true,force:true})));
const file=()=>{const path=mkdtempSync(join(tmpdir(),'connections-'));directories.push(path);return join(path,'saved.json');};
const owner='0x'+'1'.repeat(40),sub='0x'+'2'.repeat(40);
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

it('prunes a persisted target for a deleted bot after restart and removes its connection immediately', async () => {
 const adapter:ExchangeAdapter={descriptor:{id:'test',name:'Test',environments:['testnet'],authentication:['public-address'],capabilities:{accountDiscovery:true,markets:['perpetual'],trading:false}},normalizeOwner:v=>v,discover:async()=>[{id:'sub',address:'sub',name:'Sub',kind:'subaccount',equity:'100',withdrawable:'100',positions:0}]};
 const path=file(),botId='00000000-0000-4000-8000-000000000011';
 const initial=new ConnectionsService(path,[adapter],undefined,undefined,undefined,()=>true);
 const connected=await initial.command({action:'connect',adapterId:'test',name:'A',environment:'testnet',owner:'owner'});
 await initial.command({action:'save_target',target:{botId,connectionId:connected.connections[0].id,accountId:'sub',market:'ETH-PERP',maxPositionUsd:500,maxOrderUsd:100}});
 await initial.dispose();

 const restarted=new ConnectionsService(path,[adapter],undefined,undefined,undefined,()=>false);
 await expect(restarted.command({action:'remove',id:connected.connections[0].id})).resolves.toMatchObject({connections:[]});
 expect(JSON.parse(readFileSync(`${path}.targets`,'utf8'))).toEqual({});
 expect(statSync(`${path}.targets`).mode & 0o777).toBe(0o600);
 await restarted.dispose();
});

it('keeps a connection selected by a real bot and remains conservative without a bot source of truth', async () => {
 const adapter:ExchangeAdapter={descriptor:{id:'test',name:'Test',environments:['testnet'],authentication:['public-address'],capabilities:{accountDiscovery:true,markets:['perpetual'],trading:false}},normalizeOwner:v=>v,discover:async()=>[{id:'sub',address:'sub',name:'Sub',kind:'subaccount',equity:'100',withdrawable:'100',positions:0}]};
 const path=file(),botId='00000000-0000-4000-8000-000000000012';
 const service=new ConnectionsService(path,[adapter],undefined,undefined,undefined,()=>true);
 const connected=await service.command({action:'connect',adapterId:'test',name:'A',environment:'testnet',owner:'owner'});
 await service.command({action:'save_target',target:{botId,connectionId:connected.connections[0].id,accountId:'sub',market:'ETH-PERP',maxPositionUsd:500,maxOrderUsd:100}});
 await expect(service.command({action:'remove',id:connected.connections[0].id})).rejects.toThrow('selected by a bot');
 await service.dispose();

 const conservative=new ConnectionsService(path,[adapter]);
 await expect(conservative.command({action:'remove',id:connected.connections[0].id})).rejects.toThrow('selected by a bot');
 await conservative.dispose();
});

it.each([
 ['active','running',[]],
 ['unresolved','failed',[{id:'order',status:'uncertain',at:'2026-10-18T00:00:00.000Z'}]],
] as const)('never removes a connection with an %s persisted runner binding', async (_label,status,orders) => {
 const adapter:ExchangeAdapter={descriptor:{id:'test',name:'Test',environments:['testnet'],authentication:['public-address'],capabilities:{accountDiscovery:true,markets:['perpetual'],trading:false}},normalizeOwner:v=>v,discover:async()=>[{id:'sub',address:'sub',name:'Sub',kind:'subaccount',equity:'100',withdrawable:'100',positions:0}]};
 const path=file(),botId='00000000-0000-4000-8000-000000000013';
 const setup=new ConnectionsService(path,[adapter],undefined,undefined,undefined,()=>false);
 const connected=await setup.command({action:'connect',adapterId:'test',name:'A',environment:'testnet',owner:'owner'});
 const target={botId,connectionId:connected.connections[0].id,accountId:'sub',market:'ETH-PERP',maxPositionUsd:500,maxOrderUsd:100};
 await setup.dispose();
 writeFileSync(`${path}.runtime`,JSON.stringify({[botId]:{view:{id:'deployment',botId,version:1,environment:'testnet',target,status,startedAt:'2026-10-18T00:00:00.000Z',cycles:0,orders,events:[]},document:{nodes:[],edges:[]},target,state:{},fills:[],lastBucket:-1}}));

 const restarted=new ConnectionsService(path,[adapter],undefined,undefined,undefined,()=>false);
 await expect(restarted.command({action:'remove',id:connected.connections[0].id})).rejects.toThrow('active or unresolved');
 expect((await restarted.command({action:'list'})).connections).toHaveLength(1);
 await restarted.dispose();
});

it('treats open native protection as unresolved when deleting its bot', async () => {
 const path=file(),botId='00000000-0000-4000-8000-000000000015';
 const target={botId,connectionId:'00000000-0000-4000-8000-000000000025',accountId:'sub',market:'ETH-PERP',maxPositionUsd:500,maxOrderUsd:100};
 writeFileSync(`${path}.runtime`,JSON.stringify({[botId]:{view:{id:'deployment',botId,version:1,environment:'testnet',target,status:'failed',startedAt:'2026-10-18T00:00:00.000Z',cycles:0,orders:[],events:[]},document:{nodes:[],edges:[]},target,state:{},fills:[],lastBucket:-1,protection:{orders:[{cloid:'protection',kind:'stop',triggerPrice:100,state:'open'}],retiring:[],quantity:1,entry:100,generation:1}}}));
 const service=new ConnectionsService(path,[]);

 expect(()=>service.assertBotRemovable(botId)).toThrow('BOT_UNRESOLVED');

 await service.dispose();
});

it.each([
 ['stopped expected position','stopped',{expectedPosition:0.25},true],
 ['failed expected position','failed',{expectedPosition:-0.25},true],
 ['legacy view position','stopped',{viewPosition:0.25},true],
 ['pending native exit','failed',{expectedPosition:0,nativeExitPending:true},true],
 ['partial native exit','stopped',{expectedPosition:0,nativePartial:true},true],
 ['flat terminal record','stopped',{expectedPosition:0,viewPosition:0,nativeExitPending:false,nativePartial:false},false],
] as const)('%s is classified by exposure safety before bot or connection removal', async (_label,status,state,blocked) => {
 const adapter:ExchangeAdapter={descriptor:{id:'test',name:'Test',environments:['testnet'],authentication:['public-address'],capabilities:{accountDiscovery:true,markets:['perpetual'],trading:false}},normalizeOwner:v=>v,discover:async()=>[{id:'sub',address:'sub',name:'Sub',kind:'subaccount',equity:'100',withdrawable:'100',positions:0}]};
 const path=file(),botId='00000000-0000-4000-8000-000000000016';
 const setup=new ConnectionsService(path,[adapter],undefined,undefined,undefined,()=>false);
 const connected=await setup.command({action:'connect',adapterId:'test',name:'A',environment:'testnet',owner:'owner'});
 const target={botId,connectionId:connected.connections[0].id,accountId:'sub',market:'ETH-PERP',maxPositionUsd:500,maxOrderUsd:100};
 await setup.command({action:'save_target',target});
 await setup.dispose();
 const {viewPosition,...storedState}=state as typeof state & {viewPosition?:number};
 writeFileSync(`${path}.runtime`,JSON.stringify({[botId]:{view:{id:'deployment',botId,version:1,environment:'testnet',target,status,startedAt:'2026-10-18T00:00:00.000Z',cycles:0,orders:[],events:[],...(viewPosition===undefined?{}:{position:viewPosition})},document:{nodes:[],edges:[]},target,state:{},fills:[],lastBucket:-1,...storedState}}));
 const restarted=new ConnectionsService(path,[adapter],undefined,undefined,undefined,()=>false);

 if(blocked) {
  expect(()=>restarted.assertBotRemovable(botId)).toThrow('BOT_UNRESOLVED');
  await expect(restarted.command({action:'remove',id:connected.connections[0].id})).rejects.toThrow('active or unresolved');
  expect((await restarted.command({action:'list'})).connections).toHaveLength(1);
 } else {
  expect(()=>restarted.assertBotRemovable(botId)).not.toThrow();
  await expect(restarted.command({action:'remove',id:connected.connections[0].id})).resolves.toMatchObject({connections:[]});
 }
 await restarted.dispose();
});

it('does not remove a connection when atomic orphan-target cleanup fails', async () => {
 const adapter:ExchangeAdapter={descriptor:{id:'test',name:'Test',environments:['testnet'],authentication:['public-address'],capabilities:{accountDiscovery:true,markets:['perpetual'],trading:false}},normalizeOwner:v=>v,discover:async()=>[{id:'sub',address:'sub',name:'Sub',kind:'subaccount',equity:'100',withdrawable:'100',positions:0}]};
 const path=file(),botId='00000000-0000-4000-8000-000000000014';
 const service=new ConnectionsService(path,[adapter],undefined,undefined,undefined,()=>false,()=>{throw new Error('disk full');});
 const connected=await service.command({action:'connect',adapterId:'test',name:'A',environment:'testnet',owner:'owner'});
 const target={botId,connectionId:connected.connections[0].id,accountId:'sub',market:'ETH-PERP',maxPositionUsd:500,maxOrderUsd:100};
 // Seed the stale state directly because this service deliberately fails every target write.
 writeFileSync(`${path}.targets`,JSON.stringify({[botId]:target}),{mode:0o600});

 await expect(service.command({action:'remove',id:connected.connections[0].id})).rejects.toThrow('disk full');
 expect((await service.command({action:'list'})).connections).toHaveLength(1);
 expect(JSON.parse(readFileSync(`${path}.targets`,'utf8'))).toEqual({[botId]:target});
 await service.dispose();
});

it('rejects a stale target and flow draft when the authoritative bot record is deleted', async () => {
 const adapter:ExchangeAdapter={descriptor:{id:'hyperliquid',name:'Hyperliquid',environments:['testnet'],authentication:['wallet'],capabilities:{accountDiscovery:true,markets:['perpetual'],trading:true}},normalizeOwner:v=>v,discover:async()=>[{id:'sub',address:'sub',name:'Sub',kind:'subaccount',equity:'100',withdrawable:'100',positions:0}]};
 const path=file(),botId='00000000-0000-4000-8000-000000000017';
 let exists=true;
 const authorization={executionKey:async()=>{throw new Error('authorization must not run for a deleted bot');}};
 const staleDraft={botId,version:1,status:'valid' as const,document:{nodes:[],edges:[]},updatedAt:'2026-10-18T00:00:00.000Z'};
 const service=new ConnectionsService(path,[adapter],authorization as never,undefined,()=>staleDraft as never,()=>exists);
 const connected=await service.command({action:'connect',adapterId:'hyperliquid',name:'A',environment:'testnet',owner:'owner'});
 await service.command({action:'save_target',target:{botId,connectionId:connected.connections[0].id,accountId:'sub',market:'ETH-PERP',maxPositionUsd:500,maxOrderUsd:100}});
 exists=false;

 await expect(service.command({action:'start_flow',botId,version:1,confirmation:'testnet:ETH-PERP'})).rejects.toThrow('Bot no longer exists');
 expect((await service.command({action:'get_flow_runtime',botId})).deployment).toBeUndefined();
 await service.dispose();
});

it('marks startup active before awaiting authorization so bot deletion cannot race it', async () => {
 const adapter:ExchangeAdapter={descriptor:{id:'hyperliquid',name:'Hyperliquid',environments:['testnet'],authentication:['wallet'],capabilities:{accountDiscovery:true,markets:['perpetual'],trading:true}},normalizeOwner:v=>v,discover:async()=>[{id:'sub',address:'sub',name:'Sub',kind:'subaccount',equity:'100',withdrawable:'100',positions:0}]};
 const path=file(),botId='00000000-0000-4000-8000-000000000018';
 let rejectAuthorization!:(error:Error)=>void;
 const authorization={executionKey:()=>new Promise<never>((_resolve,reject)=>{rejectAuthorization=reject;})};
 const draft={botId,version:1,status:'valid' as const,document:{nodes:[],edges:[]},updatedAt:'2026-10-18T00:00:00.000Z'};
 const service=new ConnectionsService(path,[adapter],authorization as never,undefined,()=>draft as never,()=>true);
 const connected=await service.command({action:'connect',adapterId:'hyperliquid',name:'A',environment:'testnet',owner:'owner'});
 await service.command({action:'save_target',target:{botId,connectionId:connected.connections[0].id,accountId:'sub',market:'ETH-PERP',maxPositionUsd:500,maxOrderUsd:100}});

 const starting=service.command({action:'start_flow',botId,version:1,confirmation:'testnet:ETH-PERP'});
 expect(()=>service.assertBotRemovable(botId)).toThrow('BOT_ACTIVE');
 rejectAuthorization(new Error('stop test startup'));
 await expect(starting).rejects.toThrow('stop test startup');
 expect(()=>service.assertBotRemovable(botId)).not.toThrow();
 await service.dispose();
});
