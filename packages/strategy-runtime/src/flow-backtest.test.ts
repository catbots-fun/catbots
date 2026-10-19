import { describe,it,expect } from 'vitest';
import type { FlowDocument } from '@catbots/node-kit';
import type { FlowBacktestSettings } from '@catbots/contracts';
import { replayFlowBacktest,type HistoricalFlowData } from './flow-backtest';
const hour=3600000;
const settings:FlowBacktestSettings={market:'ETH-PERP',from:new Date(0).toISOString(),to:new Date(3*hour).toISOString(),timeframe:'1h',startingCapital:1000,feeBps:10,slippageBps:0};
const n=(id:string,type:string,config={})=>({id,type,version:1,config});
const e=(source:string,target:string,sourcePort='main',targetPort='main')=>({source,target,sourcePort,targetPort});
const flow:FlowDocument={schemaVersion:'3.0',nodes:[n('price','data.price'),n('items','process.number_to_items',{field:'price'}),n('if','condition.if_items',{field:'price',operator:'lt',valueJson:'105'}),n('size','process.edit_fields',{field:'quantity',valueJson:'1'}),n('exitSize','process.edit_fields',{field:'quantity',valueJson:'1'}),n('buy','action.item_order',{side:'buy'}),n('sell','action.item_order',{side:'sell',reduceOnly:true})],edges:[e('price','items','value','value'),e('items','if'),e('if','size','true'),e('size','buy'),e('if','exitSize','false'),e('exitSize','sell')]};
function dataset():HistoricalFlowData { return {source:'test-fixture',fetchedAt:new Date(4*hour).toISOString(),funding:[0,hour,2*hour].map(at=>({at,rate:0.001})),candles:{'1h':[-2,-1,0,1,2].map((index)=>{const open=index<1?100:index===1?110:130,close=index<1?100:index===1?120:130;return {closedAt:(index+1)*hour-1,open,close,high:Math.max(open,close),low:Math.min(open,close),volume:1000};})}}; }
describe('historical packaged flow replay',()=>{
  it('replays a complete seven-day 1m dataset without the exchange-specific 5000-bar cap',()=>{
    const minute=60000,end=10080*minute;
    const data:HistoricalFlowData={source:'Lighter fixture',fetchedAt:new Date(end).toISOString(),candles:{'1m':Array.from({length:10082},(_,i)=>({closedAt:(i-1)*minute-1,open:100,high:100,low:100,close:100,volume:1}))},funding:Array.from({length:168},(_,i)=>({at:i*hour,rate:0}))};
    const result=replayFlowBacktest({schemaVersion:'3.0',nodes:[n('price','data.price')],edges:[]},{...settings,timeframe:'1m',to:new Date(end).toISOString()},data);
    expect(result.dataset.bars).toBe(10080);
    expect(result.finalEquity).toBe(1000);
  });
  it('fills next-bar opens, includes fees and funding, and reconciles cash exactly',()=>{
    const result=replayFlowBacktest(flow,settings,dataset());
    expect(result.fills.map(fill=>[fill.at,fill.price,fill.side])).toEqual([[hour,110,'buy'],[2*hour,130,'sell']]);
    expect(result.realizedPnl).toBe(20);expect(result.fees).toBeCloseTo(.24);expect(result.funding).toBeCloseTo(.12);expect(result.finalEquity).toBeCloseTo(1019.64);expect(result.position.quantity).toBe(0);
    expect(result.nodeStats.buy.executed).toBe(1);
  });
  it('does not fill same-bar signals or force close the ending position',()=>{
    const result=replayFlowBacktest(flow,{...settings,to:new Date(2*hour).toISOString()},dataset());
    expect(result.fills).toHaveLength(1);expect(result.position.quantity).toBe(1);expect(result.pendingOrders).toBe(1);expect(result.unrealizedPnl).toBe(10);
  });
  it('future candle changes cannot alter earlier fills or equity',()=>{
    const original=dataset(),changed=dataset();changed.candles['1h'][4]={...changed.candles['1h'][4],open:500,close:500,high:500,low:500};
    const a=replayFlowBacktest(flow,settings,original),b=replayFlowBacktest(flow,settings,changed);
    expect(a.equityCurve.slice(0,3)).toEqual(b.equityCurve.slice(0,3));expect(a.fills[0]).toEqual(b.fills[0]);
  });
  it('rejects gaps, incomplete ranges, missing warm-up and funding',()=>{
    const missing=dataset();missing.candles['1h'].splice(3,1);expect(()=>replayFlowBacktest(flow,settings,missing)).toThrow('gapped');
    const short=dataset();short.candles['1h'].pop();expect(()=>replayFlowBacktest(flow,settings,short)).toThrow('Incomplete');
    const warm=dataset();warm.candles['1h'].shift();expect(()=>replayFlowBacktest(flow,settings,warm)).toThrow('warm-up');
    const funding=dataset();funding.funding.pop();expect(()=>replayFlowBacktest(flow,settings,funding)).toThrow('funding');
  });
  it('applies adverse slippage on both sides and rejects orders above 1x equity',()=>{
    const slipped=replayFlowBacktest(flow,{...settings,slippageBps:100},dataset());expect(slipped.fills.map(fill=>fill.price)).toEqual([111.1,128.7]);
    const large=structuredClone(flow);large.nodes.find(node=>node.id==='size')!.config={field:'quantity',valueJson:'100'};
    const rejected=replayFlowBacktest(large,settings,dataset());expect(rejected.fills).toEqual([]);expect(rejected.rejectedOrders).toBeGreaterThan(0);expect(rejected.finalEquity).toBe(1000);
  });
  it('handles short position PnL and funding direction',()=>{
    const short=structuredClone(flow);short.nodes.find(node=>node.id==='buy')!.config={side:'sell'};short.nodes.find(node=>node.id==='sell')!.config={side:'buy',reduceOnly:true};
    const result=replayFlowBacktest(short,settings,dataset());expect(result.realizedPnl).toBe(-20);expect(result.funding).toBeCloseTo(-.12);expect(result.finalEquity).toBeCloseTo(979.88);
  });
  it('is deterministic and never mutates source candles or flow configs',()=>{
    const data=dataset(),copy=structuredClone(data),doc=structuredClone(flow);
    const a=replayFlowBacktest(flow,settings,data),b=replayFlowBacktest(flow,settings,data);expect({...a,durationMs:0}).toEqual({...b,durationMs:0});expect(data).toEqual(copy);expect(flow).toEqual(doc);
  });
});

it('keeps EMA state across rolling windows instead of becoming a moving SMA',async()=>{
  const { runtimeNodePackages }=await import('./node-packages');
  const { ready }=await import('@catbots/node-kit');
  const def=runtimeNodePackages.flatMap(pkg=>pkg.definitions).find(def=>def.type==='indicator.ema')!;
  const bars=[1,2,10].map((close,index)=>({closedAt:index,open:close,close,high:close,low:close,volume:1}));
  const context={runId:'a',deploymentId:'d',market:'ETH-PERP',at:2,price:10,equity:1000,candles:{},fills:[],cancelledOrderIds:[]};
  const first=def.evaluate({candles:ready('candles',bars.slice(0,2))},{period:2},context,undefined,'ema');
  const second=def.evaluate({candles:ready('candles',bars.slice(1))},{period:2},context,first.state,'ema');
  expect(first.outputs.value.value).toBe(1.5);expect(second.outputs.value.value).toBeCloseTo(1.5+(10-1.5)*2/3);
});

it('keeps a slower timeframe hidden until its candle closes',()=>{
  const doc:FlowDocument={schemaVersion:'3.0',nodes:[n('start','trigger.items'),n('candles','data.candle_items',{timeframe:'2h',count:2}),n('if','condition.if_items',{field:'candles.1.close',operator:'lt',valueJson:'105'}),n('size','process.edit_fields',{field:'quantity',valueJson:'1'}),n('buy','action.item_order',{side:'buy'})],edges:[e('start','candles'),e('candles','if'),e('if','size','true'),e('size','buy')]};
  const data=dataset();data.candles['2h']=[-2,-1,0].map(index=>({closedAt:(index+1)*2*hour-1,open:100,close:index===0?200:100,high:index===0?200:100,low:100,volume:10}));
  const result=replayFlowBacktest(doc,{...settings,to:new Date(2*hour).toISOString()},data);
  expect(result.fills).toHaveLength(1);expect(result.fills[0].at).toBe(hour);expect(result.nodeStats.buy.executed).toBe(1);
});
it('Grid limit orders wait for a following bar and account for actual fills',async()=>{
  const { createPackageExample }=await import('./package-examples');
  const template=createPackageExample('grid');const doc:FlowDocument={schemaVersion:'3.0',nodes:[n('a','process.number',{value:1}),n('b','process.number',{value:2}),n('entry','condition.compare',{operator:'lt'}),template.nodes.find(node=>node.id==='strategy')!],edges:[e('a','entry','value','left'),e('b','entry','value','right'),e('entry','strategy','result','signal')]};const data=dataset();data.candles['1h'][3].low=90;
  const result=replayFlowBacktest(doc,settings,data);
  expect(result.fills.length).toBe(6);expect(result.fills.filter(fill=>fill.side==='sell').every(fill=>fill.price===130)).toBe(true);expect(result.fills.every(fill=>fill.at>=hour)).toBe(true);
  expect(result.finalEquity).toBeCloseTo(settings.startingCapital+result.realizedPnl+result.unrealizedPnl-result.fees-result.funding);
});
