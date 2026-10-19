import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LighterAdapter } from '../src/main/connections/lighter/adapter';
import { LighterCredentialStore } from '../src/main/connections/lighter/credentials';
import { LighterFlowVenue } from '../src/main/connections/lighter/venue';
import { LighterClient } from '../src/main/connections/lighter/client';
import { clientOrderIndex } from '../src/main/connections/lighter/precision';
import type { OrderPlan } from '@catbots/strategy-runtime';
import { OrderRejectedError } from '../src/main/connections/flow-venue';

const key = '1'.repeat(80), pub = '2'.repeat(80), id = '00000000-0000-4000-8000-000000000001';
const signer = () => ({ publicKey: async()=>pub, authToken:async()=> 'token', signOrder:vi.fn(async()=> '{}') });
const credentials = { accountIndex:12, apiKeyIndex:4, apiPrivateKey:key };
const target = { botId:id, connectionId:id, accountId:'12', market:'ETH-PERP', maxPositionUsd:500, maxOrderUsd:100 };
const market = { market_id:0, symbol:'ETH', market_type:'perp', status:'active', supported_size_decimals:4, supported_price_decimals:2, min_base_amount:'0.002', min_quote_amount:'10', multiplier:'1' };
const account = (index:number) => ({ account_index:index,l1_address:'0xabc',collateral:'100',total_asset_value:'100',available_balance:'100',positions:[] });
function store() { const path=join(mkdtempSync(join(tmpdir(),'lighter-test-')),'keys'); return {path,store:new LighterCredentialStore(path,{encrypt:s=>Buffer.from(s).reverse(),decrypt:b=>Buffer.from(b).reverse().toString()})}; }
function transport(handler:(path:string, url:URL)=>unknown) { return vi.fn(async(input: unknown)=>{const url=new URL(String(input)); return new Response(JSON.stringify({code:200,...handler(url.pathname.split('/').at(-1)!,url) as object}));}) as unknown as typeof fetch; }

describe('Lighter connections',()=>{
 it('verifies and stores multiple accounts without returning or persisting plaintext keys',async()=>{
  const storage=store();
  const request=transport((path,url)=>path==='apikeys'?{api_keys:[{account_index:Number(url.searchParams.get('account_index')),api_key_index:4,public_key:pub}]}:path==='account'?{accounts:[account(Number(url.searchParams.get('value')))]}:{orders:[]});
  const adapter=new LighterAdapter(storage.store,'unused',request,signer);
  const one=await adapter.connectApiKey({id,name:'one',environment:'testnet',...credentials});
  const two=await adapter.connectApiKey({id:'00000000-0000-4000-8000-000000000002',name:'two',environment:'testnet',...credentials,accountIndex:13});
  expect(one.accounts[0].id).toBe('12');expect(two.accounts[0].id).toBe('13');
  expect(JSON.stringify([one,two])).not.toContain(key);
  expect(readFileSync(storage.path,'utf8')).not.toContain('apiPrivateKey');
  expect(await adapter.verify(one)).toBe(true);
  expect(storage.store.get(id).accountIndex).toBe(12);
  await expect(adapter.createVenue(one,{...target,accountId:'13'})).rejects.toThrow('MISMATCH');
 });
 it('rejects a registered key mismatch before saving',async()=>{
  const storage=store();
  const adapter=new LighterAdapter(storage.store,'unused',transport(()=>({api_keys:[]})),signer);
  await expect(adapter.connectApiKey({id,name:'one',environment:'testnet',...credentials})).rejects.toThrow('CREDENTIAL_INVALID');
  expect(()=>storage.store.get(id)).toThrow('UNAVAILABLE');
 });
});

describe('Lighter execution recovery',()=>{
 const cloid='0xabcd' as const;
 const order={clientOrderId:'intent',side:'buy',quantity:0.01,reduceOnly:false} as OrderPlan;
 it.each(['quote', 'incomplete-filled', 'negative-trade', 'zero-base-nonzero-quote'] as const)('keeps contradictory %s evidence unresolved', async mode => {
  const request = transport(path => path === 'orderBooks' ? { order_books: [market] } : path === 'accountOrders'
   ? { orders: [{ client_order_index: clientOrderIndex(cloid), order_id: '42', market_index: 0, owner_account_index: 12, is_ask: false, status: mode === 'incomplete-filled' ? 'filled' : 'canceled', initial_base_amount: '0.01', filled_base_amount: mode === 'zero-base-nonzero-quote' ? '0' : '0.005', filled_quote_amount: '12', price: '2400' }] }
   : { trades: mode === 'negative-trade'
     ? [{ trade_id_str: '7', ask_id_str: '41', bid_id_str: '42', ask_account_id: 99, bid_account_id: 12, is_maker_ask: true, size: '0.01', usd_amount: '24' }, { trade_id_str: '8', ask_id_str: '41', bid_id_str: '42', ask_account_id: 99, bid_account_id: 12, is_maker_ask: true, size: '-0.005', usd_amount: '-12' }]
     : [{ trade_id_str: '7', ask_id_str: '41', bid_id_str: '42', ask_account_id: 99, bid_account_id: 12, is_maker_ask: true, size: '0.005', usd_amount: mode === 'quote' ? '24' : '12' }] });
  const venue = new LighterFlowVenue(new LighterClient('testnet', request), signer(), credentials, target);
  expect(await venue.reconcile(order, cloid)).toBeUndefined();
  expect(vi.mocked(request).mock.calls.some(([url]) => String(url).includes('sendTx'))).toBe(false);
 });
 it('recovers older orders through paginated inactive history',async()=>{
  const request=transport((path,url)=>path==='orderBooks'?{order_books:[market]}:path==='accountInactiveOrders'?url.searchParams.has('cursor')?{orders:[{client_order_index:clientOrderIndex(cloid),order_id:'42',market_index:0,owner_account_index:12,is_ask:false,status:'canceled',initial_base_amount:'0.01',filled_base_amount:'0',filled_quote_amount:'0',price:'2400'}]}:{orders:[],next_cursor:'older'}:{orders:[]});
  const venue=new LighterFlowVenue(new LighterClient('testnet',request),signer(),credentials,target);
  expect(await venue.reconcile(order,cloid)).toBeNull();
  expect(vi.mocked(request).mock.calls.filter(([url])=>String(url).includes('accountInactiveOrders'))).toHaveLength(2);
 });
 it('waits for indexing without sending the order twice',async()=>{
  const request=transport(path=>path==='orderBooks'?{order_books:[market]}:path==='nextNonce'?{nonce:3}:{orders:[]});
  const venue=new LighterFlowVenue(new LighterClient('testnet',request),signer(),credentials,target,{attempts:30,delayMs:0});
  let reads=0;
  vi.spyOn(venue,'reconcile').mockImplementation(async()=>++reads<10?undefined:null);
  expect(await venue.place(order,cloid,{asset:0,context:{price:2400}} as never)).toBeNull();
  expect(vi.mocked(request).mock.calls.filter(([url])=>String(url).includes('sendTx'))).toHaveLength(1);
 });
 it('classifies pre-broadcast failures as unsent so recovery cannot deadlock',async()=>{
  const request=transport(()=>{throw new Error('network down');});
  const venue=new LighterFlowVenue(new LighterClient('testnet',request),signer(),credentials,target);
  await expect(venue.place(order,cloid,{} as never)).rejects.toBeInstanceOf(OrderRejectedError);
 });
 it('follows fill pagination before declaring a terminal order reconciled',async()=>{
  const request=transport((path,url)=>path==='orderBooks'?{order_books:[market]}:path==='accountOrders'?{orders:[{client_order_index:clientOrderIndex(cloid),order_id:'42',market_index:0,owner_account_index:12,is_ask:false,status:'filled',initial_base_amount:'0.01',filled_base_amount:'0.01',filled_quote_amount:'24',price:'2400'}]}:{next_cursor:url.searchParams.has('cursor')?'':'next',trades:[{trade_id_str:url.searchParams.has('cursor')?'8':'7',ask_id_str:'41',bid_id_str:'42',ask_account_id:99,bid_account_id:12,is_maker_ask:true,size:'0.005',usd_amount:'12'}]});
  const venue=new LighterFlowVenue(new LighterClient('testnet',request),signer(),credentials,target);
  expect(await venue.reconcile(order,cloid)).toMatchObject({quantity:0.01,price:2400});
 });
 it('never broadcasts while reconciling a missing order',async()=>{
  const request=transport(()=>({orders:[]}));
  const venue=new LighterFlowVenue(new LighterClient('testnet',request),signer(),credentials,target);
  expect(await venue.reconcile(order,cloid)).toBeUndefined();
  expect(vi.mocked(request).mock.calls.some(([url])=>String(url).includes('sendTx'))).toBe(false);
 });
 it('accepts terminal partial fills only with matching trade evidence',async()=>{
  const request=transport(path=>path==='orderBooks'?{order_books:[market]}:path==='accountOrders'?{orders:[{client_order_index:clientOrderIndex(cloid),order_id:'42',market_index:0,owner_account_index:12,is_ask:false,status:'canceled',initial_base_amount:'0.01',filled_base_amount:'0.005',filled_quote_amount:'12',price:'2400'}]}:{trades:[{trade_id_str:'7',ask_id_str:'41',bid_id_str:'42',ask_account_id:99,bid_account_id:12,is_maker_ask:true,size:'0.005',usd_amount:'12',taker_fee:280}]});
  const venue=new LighterFlowVenue(new LighterClient('testnet',request),signer(),credentials,target);
  expect(await venue.reconcile(order,cloid)).toMatchObject({id:'42',quantity:0.005,price:2400,fee:0.00336});
 });
 it('submits once then preserves an unknown outcome',async()=>{
  const request=transport(path=>path==='orderBooks'?{order_books:[market]}:path==='nextNonce'?{nonce:3}:{orders:[]});
  const s=signer();
  const venue=new LighterFlowVenue(new LighterClient('testnet',request),s,credentials,target,{attempts:3,delayMs:0});
  const snapshot={asset:0,sizeDecimals:4,position:0,available:100,openOrders:0,context:{market:'ETH-PERP',price:2400,equity:100,at:Date.now(),candles:{},fills:[],cancelledOrderIds:[]}};
  await expect(venue.place(order,cloid,snapshot)).rejects.toThrow('UNKNOWN');
  expect(vi.mocked(request).mock.calls.filter(([url])=>String(url).includes('sendTx'))).toHaveLength(1);
  expect(s.signOrder).toHaveBeenCalledWith(expect.objectContaining({nonce:3,amount:'100',price:'241200',reduceOnly:false}));
 });
});
