import { z } from 'zod';
import { ready, type FlowDefinition, type OrderPlan } from '@catbots/node-kit';
const pendingSchema = z.object({ id: z.string(), side: z.enum(['buy','sell']), quantity: z.number().positive(), filled: z.number().nonnegative(), exit: z.boolean() });
const stateSchema = z.object({ scope:z.string(), key:z.string(), position:z.number().finite(), entry:z.number().nonnegative(), openedAt:z.number(), atr:z.number().nonnegative(), cooldownUntil:z.number(), sequence:z.number().int(), seen:z.array(z.string()), pending:pendingSchema.optional() });
/** One controller owns both directions. Confirmed fills alone change position. */
export const directionalDefinition: FlowDefinition = {
  type:'strategy.directional', version:1, category:'strategy', title:'Long / Short momentum',
  config:z.object({quotePerOrder:z.number().positive(),rsiThreshold:z.number().min(50).max(75).default(55),stopAtr:z.number().positive().default(1.5),rewardRisk:z.number().positive().default(2),minAtrPercent:z.number().nonnegative().default(0.1),maxHoldMinutes:z.number().int().positive().default(30),cooldownMinutes:z.number().int().nonnegative().default(5)}).strict(),
  inputs:{fast:'number',slow:'number',rsi:'number',atr:'number'},outputs:{orders:'orders',status:'json'},
  evaluate(input,config,context,previous,nodeId) {
    const scope=JSON.stringify([context.deploymentId,context.market,nodeId]);
    const state=previous===undefined?{scope,key:JSON.stringify(config),position:0,entry:0,openedAt:0,atr:0,cooldownUntil:0,sequence:0,seen:[]} as z.infer<typeof stateSchema>:stateSchema.parse(previous);
    if(state.scope!==scope||state.key!==JSON.stringify(config))throw new Error('Strategy context changed');
    for(const fill of context.fills){
      const pending=state.pending;
      if(!pending||fill.clientOrderId!==pending.id||state.seen.includes(fill.id))continue;
      if(fill.side!==pending.side||!Number.isFinite(fill.quantity)||fill.quantity<=0||pending.filled+fill.quantity>pending.quantity+1e-8||!Number.isFinite(fill.price)||fill.price<=0)throw new Error('Invalid directional fill');
      const sign=fill.side==='buy'?1:-1;
      if(pending.exit){
        if(state.position*sign>=0||fill.quantity>Math.abs(state.position)+1e-8)throw new Error('Exit exceeds strategy position');
        state.position+=sign*fill.quantity;
        if(Math.abs(state.position)<1e-8){state.position=0;state.entry=0;state.cooldownUntil=context.at+config.cooldownMinutes*60000;}
      } else {
        const held=Math.abs(state.position);
        state.entry=(held*state.entry+fill.quantity*fill.price)/(held+fill.quantity);state.position+=sign*fill.quantity;
      }
      pending.filled+=fill.quantity;state.seen.push(fill.id);
      if(pending.filled>=pending.quantity-1e-8)delete state.pending;
    }
    if(state.pending&&context.cancelledOrderIds.includes(state.pending.id))delete state.pending;
    if(state.seen.length>50000)throw new Error('Strategy fill limit exceeded');
    const orders:OrderPlan[]=[];
    // Bound holding time from entry intent; delayed fill recovery must not extend it.
    const submit=(side:'buy'|'sell',quantity:number,exit:boolean)=>{const id=JSON.stringify([scope,++state.sequence]);if(!exit)state.openedAt=context.at;state.pending={id,side,quantity,filled:0,exit};orders.push({clientOrderId:id,side,quantity,reduceOnly:exit,purpose:exit?'exit':'entry'});};
    if(!Number.isFinite(context.price)||context.price<=0)throw new Error('Invalid market price');
    if(!state.pending){
      if(state.position!==0){
        const gain=Math.sign(state.position)*(context.price-state.entry),risk=state.atr*config.stopAtr;
        if(gain<=-risk||gain>=risk*config.rewardRisk||context.at-state.openedAt>=config.maxHoldMinutes*60000)submit(state.position>0?'sell':'buy',Math.abs(state.position),true);
      } else if(context.evaluationMode!=='risk'&&context.at>=state.cooldownUntil&&Object.values(input).every(value=>value.quality==='ready'&&Number.isFinite(value.value))){
        const fast=input.fast.value as number,slow=input.slow.value as number,rsi=input.rsi.value as number,atr=input.atr.value as number;
        if(atr>0&&atr/context.price*100>=config.minAtrPercent){
          if(fast>slow&&rsi>=config.rsiThreshold){state.atr=atr;submit('buy',config.quotePerOrder/context.price,false);}
          else if(fast<slow&&rsi<=100-config.rsiThreshold){state.atr=atr;submit('sell',config.quotePerOrder/context.price,false);}
        }
      }
    }
    return {state,orders,outputs:{orders:ready('orders',orders),status:ready('json',{position:state.position,entry:state.entry,pending:!!state.pending,cooldownUntil:state.cooldownUntil})}};
  },
};
