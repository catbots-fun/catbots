import { it, expect } from 'vitest';
import { ready, type FlowContext } from '@catbots/node-kit';
import { strategyPackage } from '@catbots/nodes-strategy';
const def=strategyPackage.definitions.find(d=>d.type==='strategy.directional')!;
const config=def.config.parse({quotePerOrder:100,rsiThreshold:55,stopAtr:2,rewardRisk:2,minAtrPercent:0,cooldownMinutes:5,maxHoldMinutes:30});
const input=(long=true)=>({fast:ready('number',long?101:99),slow:ready('number',100),rsi:ready('number',long?60:40),atr:ready('number',1)});
const ctx=(at=0):FlowContext=>({runId:String(at),deploymentId:'test',market:'SOL-PERP',at,price:100,equity:1000,candles:{},fills:[],cancelledOrderIds:[]});
it('never opens a position during risk-only evaluation even with ready entry signals',()=>{
 const run=def.evaluate(input(),config,{...ctx(),evaluationMode:'risk'},undefined,'strategy');
 expect(run.orders).toHaveLength(0);
});
it('checks holding-time exits without signal inputs during risk-only evaluation',()=>{
 const first=def.evaluate(input(),config,ctx(),undefined,'strategy'),order=first.orders![0];
 const held=def.evaluate(input(),config,{...ctx(1000),fills:[{id:'entry',clientOrderId:order.clientOrderId,side:'buy',quantity:1,price:100,fee:.01}]},first.state,'strategy');
 const exit=def.evaluate({},config,{...ctx(1801000),evaluationMode:'risk'},held.state,'strategy');
 expect(exit.orders).toEqual([expect.objectContaining({side:'sell',quantity:1,reduceOnly:true})]);
});
for(const long of [true,false])it(`confirms ${long?'long':'short'} fills, exits reduce-only and waits through cooldown`,()=>{
 const first=def.evaluate(input(long),config,ctx(),undefined,'strategy');const order=first.orders![0];expect(order.side).toBe(long?'buy':'sell');
 const pending=def.evaluate(input(!long),config,ctx(60000),first.state,'strategy');expect(pending.orders).toHaveLength(0);
 const fill={id:'entry',clientOrderId:order.clientOrderId,side:order.side,quantity:1,price:100,fee:0.045};
 const exit=def.evaluate(input(long),config,{...ctx(120000),price:long?105:95,fills:[fill]},pending.state,'strategy');expect(exit.orders).toHaveLength(1);expect(exit.orders![0].reduceOnly).toBe(true);expect(exit.orders![0].side).toBe(long?'sell':'buy');
 const close=exit.orders![0];const flat=def.evaluate(input(!long),config,{...ctx(180000),fills:[{id:'exit',clientOrderId:close.clientOrderId,side:close.side,quantity:1,price:105,fee:.045}]},exit.state,'strategy');expect(flat.orders).toHaveLength(0);expect((flat.state as {position:number}).position).toBe(0);
 expect(def.evaluate(input(!long),config,ctx(240000),flat.state,'strategy').orders).toHaveLength(0);
 expect(def.evaluate(input(!long),config,ctx(480000),flat.state,'strategy').orders).toHaveLength(1);
});
it('accepts partial entry cancellation and only exits the confirmed quantity',()=>{
 const first=def.evaluate(input(),config,ctx(),undefined,'strategy'),order=first.orders![0];
 const next=def.evaluate(input(),config,{...ctx(60000),price:90,fills:[{id:'part',clientOrderId:order.clientOrderId,side:'buy',quantity:.4,price:100,fee:.018}],cancelledOrderIds:[order.clientOrderId]},first.state,'strategy');
 expect(next.orders![0]).toMatchObject({quantity:.4,reduceOnly:true,side:'sell'});
});
it('does not restart the holding deadline when an entry fill is recovered late',()=>{
 const first=def.evaluate(input(),config,ctx(60000),undefined,'strategy');
 const order=first.orders![0];
 const recovered=def.evaluate(input(),config,{...ctx(31*60000),fills:[{id:'recovered-entry',clientOrderId:order.clientOrderId,side:'buy',quantity:1,price:100,fee:0}]},JSON.parse(JSON.stringify(first.state)),'strategy');
 expect(recovered.orders).toHaveLength(1);
 expect(recovered.orders![0]).toMatchObject({side:'sell',quantity:1,reduceOnly:true,purpose:'exit'});
});
