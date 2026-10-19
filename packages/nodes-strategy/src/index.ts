import { directionalDefinition, composableDirectionalDefinition } from './directional';
import { z } from 'zod';
import { definePackage, ready, type FlowContext, type OrderPlan, type FlowDefinition } from '@catbots/node-kit';

const common = {
  side:z.enum(['long','short']).default('long'),
  quotePerOrder:z.number().finite().positive(),
  takeProfitPercent:z.number().finite().positive().max(100),
  stopLossPercent:z.number().finite().positive().max(100),
  maxNotional:z.number().finite().positive(),
};
const DcaConfig=z.object({...common,extraStepPercent:z.number().positive().max(100),maxExtraOrders:z.number().int().min(0).max(100),volumeMultiplier:z.number().min(1).max(10).default(1),repeat:z.boolean().default(false)}).strict();
const GridConfig=z.object({...common,levels:z.number().int().min(1).max(50),stepPercent:z.number().positive().max(50),repeat:z.boolean().default(true)}).strict();
const SmartConfig=z.object({side:z.enum(['long','short']).default('long'),quantity:z.number().finite().positive(),sliceQuantity:z.number().finite().positive(),maxNotional:z.number().finite().positive()}).strict();
type Pending = { order:OrderPlan; filled:number };
type Lot = { quantity:number; cost:number; entryPrice:number; pending?:Pending; closed:boolean };
type StrategyState = { scope:string; configKey:string; closeReason?:string; sequence:number; seenFillIds:string[]; lots:Lot[]; anchor:number; stage:'idle'|'active'|'closing'|'completed'|'stopped'; cycle:number };
const stateSchema=z.object({scope:z.string(),configKey:z.string(),closeReason:z.string().optional(),sequence:z.number().int().nonnegative(),seenFillIds:z.array(z.string()),lots:z.array(z.object({quantity:z.number().nonnegative(),cost:z.number().finite(),entryPrice:z.number().positive(),pending:z.object({order:z.object({clientOrderId:z.string(),side:z.enum(['buy','sell']),quantity:z.number().positive(),limitPrice:z.number().positive().optional(),reduceOnly:z.boolean(),purpose:z.enum(['entry','exit'])}),filled:z.number().nonnegative()}).optional(),closed:z.boolean()})),anchor:z.number().positive(),stage:z.enum(['idle','active','closing','completed','stopped']),cycle:z.number().int().nonnegative()});

/** Stateful strategy controllers emit order proposals. Fills, not proposals, change inventory. */
function strategyDefinition(type:'dca'|'grid'|'smart_order'):FlowDefinition {
  return {type:`strategy.${type}`,version:1,category:'strategy',title:type==='dca'?'DCA deal':type==='grid'?'Grid strategy':'Smart order',config:type==='dca'?DcaConfig:type==='grid'?GridConfig:SmartConfig,inputs:{signal:'condition'},outputs:{orders:'orders',status:'json'},
    evaluate(input,config,context,previous,nodeId){
      if(!Number.isFinite(context.price)||context.price<=0)throw new Error('A positive execution price is required');
      const scope=JSON.stringify([context.deploymentId,context.market,nodeId]);
      const state:StrategyState=previous===undefined?{scope,configKey:JSON.stringify(config),sequence:0,seenFillIds:[],lots:[],anchor:context.price,stage:'idle',cycle:0}:stateSchema.parse(previous);
      if(state.configKey!==JSON.stringify(config))throw new Error('Configuration is locked to this strategy instance');
      if(state.scope!==scope)throw new Error('Strategy state belongs to another deployment or market');
      const orders:OrderPlan[]=[];const cancelOrderIds:string[]=[];
      const entrySide=config.side==='long'?'buy':'sell';
      const sign=config.side==='long'?1:-1;
      const seen=new Set(state.seenFillIds);
      for(const fill of context.fills){
        if(seen.has(fill.id))continue;
        const lot=state.lots.find(lot=>lot.pending?.order.clientOrderId===fill.clientOrderId);
        if(!lot?.pending)continue;
        if(!Number.isFinite(fill.price)||fill.price<=0||!Number.isFinite(fill.quantity)||fill.quantity<=0||!Number.isFinite(fill.fee)||fill.fee<0)throw new Error('Invalid fill');
        const pending=lot.pending;
        if(fill.side!==pending.order.side||pending.filled+fill.quantity>pending.order.quantity+1e-9)throw new Error('Fill does not match pending order');
        seen.add(fill.id);pending.filled+=fill.quantity;
        if(pending.order.purpose==='entry') {lot.quantity+=fill.quantity;lot.cost+=fill.quantity*fill.price+sign*fill.fee;lot.entryPrice=lot.cost/lot.quantity;}
        else{if(fill.quantity>lot.quantity+1e-9)throw new Error('Exit exceeds owned quantity');const average=lot.quantity?lot.cost/lot.quantity:0;lot.quantity=Math.max(0,lot.quantity-fill.quantity);lot.cost=lot.quantity*average;if(lot.quantity<1e-9){lot.quantity=0;lot.cost=0;lot.closed=true;}}
        if(pending.filled>=pending.order.quantity-1e-9)delete lot.pending;
      }
      state.seenFillIds=[...seen];
      // Durable host journal owns unbounded history; bound a single deal's workload.
      if(state.seenFillIds.length>50000)throw new Error('Deal fill history limit exceeded');
      for(const lot of state.lots)if(lot.pending&&context.cancelledOrderIds.includes(lot.pending.order.clientOrderId))delete lot.pending;
      // A cancelled, completely unfilled DCA entry must not consume an averaging step.
      if(type==='dca')state.lots=state.lots.filter(lot=>lot.quantity>0||lot.pending||lot.closed);
      const exposure=()=>state.lots.reduce((sum,lot)=>sum+lot.quantity*context.price+(lot.pending?.order.purpose==='entry'?(lot.pending.order.quantity-lot.pending.filled)*(lot.pending.order.limitPrice??context.price):0),0);
      const submit=(lot:Lot,purpose:'entry'|'exit',quantity:number,price?:number)=>{
        if(lot.pending||quantity<=1e-9)return;
        if(purpose==='entry'&&exposure()+quantity*(price??context.price)>config.maxNotional+1e-9)return;
        const order:OrderPlan={clientOrderId:JSON.stringify([context.deploymentId,context.market,nodeId,state.cycle,++state.sequence]),side:purpose==='entry'?entrySide:entrySide==='buy'?'sell':'buy',quantity,limitPrice:price,reduceOnly:purpose==='exit',purpose};
        lot.pending={order,filled:0};orders.push(order);
      };
      if(context.evaluationMode!=='risk'&&state.stage==='idle'&&input.signal.quality==='ready'&&input.signal.value===true){state.stage='active';state.anchor=context.price;state.cycle++;}
      if(state.stage==='active'){
        const held=state.lots.reduce((sum,lot)=>sum+lot.quantity,0);
        const cost=state.lots.reduce((sum,lot)=>sum+lot.cost,0);
        if(!context.nativeProtection&&type!=='smart_order'&&held>0&&sign*(context.price-cost/held)/(cost/held)*100<=-config.stopLossPercent){state.stage='closing';state.closeReason='stop_loss';}
        if(!context.nativeProtection&&type==='dca'&&held>0&&sign*(context.price-cost/held)/(cost/held)*100>=config.takeProfitPercent){state.stage='closing';state.closeReason='take_profit';}
      }
      if(state.stage==='closing'){
        for(const lot of state.lots){
          if(lot.pending&&(lot.pending.order.purpose==='entry'||lot.pending.order.limitPrice!==undefined)){cancelOrderIds.push(lot.pending.order.clientOrderId);continue;}
          submit(lot,'exit',lot.quantity);
        }
        if(state.lots.every(lot=>lot.quantity===0&&!lot.pending))state.stage='completed';
      }else if(state.stage==='active'&&context.evaluationMode!=='risk'){
        if(type==='smart_order'){
          const held=state.lots.reduce((sum,lot)=>sum+lot.quantity,0);
          if(held>=config.quantity-1e-9)state.stage='completed';
          else if(!state.lots.some(lot=>lot.pending)) {const lot:Lot={quantity:0,cost:0,entryPrice:context.price,closed:false};state.lots.push(lot);submit(lot,'entry',Math.min(config.sliceQuantity,config.quantity-held));if(!lot.pending)state.lots.pop();}
        }else if(type==='dca'){
          if(!state.lots.some(lot=>lot.pending)&&state.lots.length<=config.maxExtraOrders){
            const index=state.lots.length;const target=state.anchor*(1-sign*config.extraStepPercent/100*index);
            if(index===0||sign*(context.price-target)<=0){const lot:Lot={quantity:0,cost:0,entryPrice:context.price,closed:false};state.lots.push(lot);submit(lot,'entry',config.quotePerOrder*Math.pow(config.volumeMultiplier,index)/context.price);if(!lot.pending)state.lots.pop();}
          }
        }else{
          for(let level=0;level<config.levels;level++){
            const entry=state.anchor*(1-sign*config.stepPercent/100*level);
            if(entry<=0)throw new Error('Grid level must have a positive price');
            const lot=state.lots[level]??(state.lots[level]={quantity:0,cost:0,entryPrice:entry,closed:false});
            if(lot.pending){if(lot.pending.order.purpose==='entry'&&lot.pending.filled>0)cancelOrderIds.push(lot.pending.order.clientOrderId);continue;}
            if(lot.quantity>0)submit(lot,'exit',lot.quantity,lot.entryPrice*(1+sign*config.takeProfitPercent/100));
            else if(!lot.closed||config.repeat){lot.closed=false;submit(lot,'entry',config.quotePerOrder/entry,entry);}
          }
          if(!config.repeat&&state.lots.length===config.levels&&state.lots.every(lot=>lot.closed&&!lot.pending))state.stage='completed';
        }
      }
      if(state.stage==='completed'&&type==='dca'&&config.repeat&&state.closeReason==='take_profit'){state.stage='idle';state.lots=[];delete state.closeReason;}
      return {state,orders,cancelOrderIds,outputs:{orders:ready('orders',orders),status:ready('json',{stage:state.stage,cycle:state.cycle,quantity:state.lots.reduce((sum,lot)=>sum+lot.quantity,0),pending:state.lots.filter(lot=>lot.pending).length})}};
    },
  };
}
export const strategyPackage=definePackage('@catbots/nodes-strategy',[...(['dca','grid','smart_order'] as const).map(strategyDefinition), directionalDefinition, composableDirectionalDefinition]);
