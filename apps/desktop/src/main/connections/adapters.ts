import { HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { z } from 'zod';
import type { AdapterDescriptor, TradingAccount, ExchangeActivity } from '@catbots/contracts';
import type { ExchangeConnection, ExecutionTarget } from '@catbots/contracts';
import type { ConnectionAuthorization } from './authorization';
import { HyperliquidFlowVenue, type FlowVenue } from './flow-venue';
export interface ExchangeAdapter {
 descriptor: AdapterDescriptor;
 normalizeOwner(owner:string):string;
 activity?(account:string,environment:'production'|'testnet',connection?: ExchangeConnection):Promise<ExchangeActivity>;
 discover(owner:string,environment:'production'|'testnet'):Promise<TradingAccount[]>;
 verify?(connection: ExchangeConnection): Promise<boolean>;
 createVenue?(connection: ExchangeConnection, target: ExecutionTarget): Promise<FlowVenue>;
 connectApiKey?(input: { id: string; name: string; environment: 'production'|'testnet'; accountIndex: number; apiKeyIndex: number; apiPrivateKey: string }): Promise<ExchangeConnection>;
}
const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const amount = z.string().refine(value => value.trim()!==''&&Number.isFinite(Number(value)),'Invalid account amount');
const balance = z.object({marginSummary:z.object({accountValue:amount}),withdrawable:amount,assetPositions:z.array(z.object({position:z.object({szi:amount})}))});
export class HyperliquidAdapter implements ExchangeAdapter {
 descriptor:AdapterDescriptor={id:'hyperliquid',name:'Hyperliquid',environments:['production','testnet'],authentication:['public-address','wallet'],capabilities:{accountDiscovery:true,markets:['perpetual'],trading:true,nativeProtection:true}};
 normalizeOwner(owner:string){return address.parse(owner).toLowerCase();}
 constructor(private request:typeof fetch=fetch, private authorization?: ConnectionAuthorization){}
 async verify(connection: ExchangeConnection) { return !!(await this.authorization?.verify(connection, false)); }
 async createVenue(connection: ExchangeConnection, target: ExecutionTarget) {
  if (!this.authorization) throw new Error('Secure authorization unavailable');
  return new HyperliquidFlowVenue(connection, target, await this.authorization.executionKey(connection));
 }
 async activity(account:string,environment:'production'|'testnet'):Promise<ExchangeActivity> {
  const user=address.parse(account) as `0x${string}`;
  const info=new InfoClient({transport:new HttpTransport({isTestnet:environment==='testnet',timeout:10000})});
  const [state,orders]=await Promise.all([info.clearinghouseState({user}),info.openOrders({user})]);
  return {fetchedAt:new Date().toISOString(),positions:state.assetPositions.filter(({position})=>Number(position.szi)!==0).map(({position})=>({market:`${position.coin}-PERP`,size:position.szi,entryPrice:position.entryPx,unrealizedPnl:position.unrealizedPnl})),orders:orders.map(order=>({id:String(order.oid),market:`${order.coin}-PERP`,side:order.side==='B'?'Buy':'Sell',size:order.sz,price:order.limitPx}))};
 }
 async discover(input:string,environment:'production'|'testnet') {
  const owner=address.parse(input).toLowerCase();
  const url=environment==='production'?'https://api.hyperliquid.xyz/info':'https://api.hyperliquid-testnet.xyz/info';
  const signal=AbortSignal.timeout(20000);
  const info=async(body:unknown)=>{const response=await this.request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});if(!response.ok)throw new Error('Account discovery failed');return response.json();};
  const role=z.object({role:z.string()}).parse(await info({type:'userRole',user:owner}));
  if(role.role!=='user')throw new Error('Use the main account address, not an API wallet or subaccount address');
  const subs=z.array(z.object({name:z.string(),subAccountUser:address})).max(50).nullable().parse(await info({type:'subAccounts',user:owner}));
  const accounts:TradingAccount[]=[];
  for(const account of [{name:'Main account',subAccountUser:owner},...(subs??[])]){
   const mode=z.enum(['unifiedAccount','portfolioMargin','disabled','default','dexAbstraction']).parse(await info({type:'userAbstraction',user:account.subAccountUser}));
   const spot=z.object({balances:z.array(z.object({coin:z.string(),token:z.number().int(),total:amount}))}).parse(await info({type:'spotClearinghouseState',user:account.subAccountUser}));
   const usdc=spot.balances.find(item=>item.token===0&&item.coin==='USDC');
   const state=balance.parse(await info({type:'clearinghouseState',user:account.subAccountUser}));
   accounts.push({accountMode:mode,usdcBalance:usdc?.total??'0',id:account.subAccountUser.toLowerCase(),address:account.subAccountUser,name:account.name,kind:account.subAccountUser.toLowerCase()===owner?'main':'subaccount',equity:state.marginSummary.accountValue,withdrawable:state.withdrawable,positions:state.assetPositions.filter(item=>Number(item.position.szi)!==0).length});
  }
  return accounts;
 }
}
