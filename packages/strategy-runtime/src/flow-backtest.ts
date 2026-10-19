import { compileFlow, prepareFlow, type Candle, type Fill, type FlowDocument, type OrderPlan } from '@catbots/node-kit';
import { FlowBacktestSettingsSchema, type FlowBacktestResult, type FlowBacktestSettings, type FlowBacktestTrade } from '@catbots/contracts';
import { runtimeNodePackages } from './node-packages';
export const FLOW_BACKTEST_ENGINE = 'ohlcv-next-bar-v2';
export const intervalMs = (timeframe: string) => {
  if (!/^[1-9]\d*[mhd]$/.test(timeframe)) throw new Error('Unsupported candle interval');
  return Number.parseInt(timeframe) * (timeframe.endsWith('m') ? 60000 : timeframe.endsWith('h') ? 3600000 : 86400000);
};
export type HistoricalFlowData = { source: string; fetchedAt: string; candles: Record<string, Candle[]>; funding: { at: number; rate: number; reportedAt?: number }[] };
export function flowHistoryRequirements(document: FlowDocument, settings: FlowBacktestSettings) {
  const { parsed } = prepareFlow(document, runtimeNodePackages);
  if (!document.nodes.length) throw new Error('Flow has no nodes');
  const counts: Record<string, number> = { [settings.timeframe]: 2 };
  for (const node of document.nodes.filter(node => ['data.candles', 'data.candle_items'].includes(node.type))) {
    const config = parsed.get(node.id)!.config as { timeframe: string; count: number };
    const reachable = new Set([node.id]);
    for (let index=0; index<document.nodes.length; index++) for (const edge of document.edges) if(reachable.has(edge.source)) reachable.add(edge.target);
    const warmup = Math.max(2, ...document.nodes.filter(item => reachable.has(item.id) && item.type.startsWith('indicator.')).map(item => Number((parsed.get(item.id)!.config as {period:number}).period) + (/indicator\.(rsi|atr)/.test(item.type) ? 1 : 0)));
    if (config.count < warmup) throw new Error(`Increase ${node.id} candle count to at least ${warmup}`);
    counts[config.timeframe] = Math.max(counts[config.timeframe] ?? 0, config.count);
  }
  const steps = (Date.parse(settings.to) - Date.parse(settings.from)) / intervalMs(settings.timeframe);
  if (!Number.isInteger(steps) || steps < 2 || steps > 100000) throw new Error('Choose between 2 and 100000 complete replay bars');
  if (Date.parse(settings.from) % intervalMs(settings.timeframe) || Date.parse(settings.to) % intervalMs(settings.timeframe)) throw new Error('Dates must align with the replay interval');
  if (Object.keys(counts).length > 4) throw new Error('At most four candle intervals are supported');
  if (steps * document.nodes.length * Math.max(...Object.values(counts)) > 100_000_000) throw new Error('Replay work limit exceeded; reduce the range, candle count or nodes');
  return counts;
}
export function replayFlowBacktest(document: FlowDocument, settingsInput: FlowBacktestSettings, data: HistoricalFlowData, onProgress?: (progress: number) => void): FlowBacktestResult {
  const started = performance.now();
  const settings = FlowBacktestSettingsSchema.parse(settingsInput);
  const counts = flowHistoryRequirements(document, settings);
  const from = Date.parse(settings.from), to = Date.parse(settings.to), step = intervalMs(settings.timeframe);
  for (const [timeframe, count] of Object.entries(counts)) {
    const series = data.candles[timeframe], duration = intervalMs(timeframe);
    if (!series?.length || series.filter(bar => bar.closedAt < from).length < count) throw new Error(`Missing warm-up candles for ${timeframe}`);
    if (series.some((bar, index) => ![bar.closedAt,bar.open,bar.high,bar.low,bar.close,bar.volume].every(Number.isFinite) || bar.low <= 0 || bar.volume < 0 || bar.high < Math.max(bar.open,bar.close,bar.low) || bar.low > Math.min(bar.open,bar.close) || (bar.closedAt + 1) % duration || index > 0 && bar.closedAt - series[index-1].closedAt !== duration)) throw new Error(`Invalid or gapped ${timeframe} candles`);
    if (series.at(-1)!.closedAt < Math.floor(to / duration) * duration - 1) throw new Error(`Incomplete ${timeframe} history`);
  }
  const bars = data.candles[settings.timeframe].filter(bar => bar.closedAt >= from && bar.closedAt < to);
  if (bars.length !== (to-from)/step || bars[0].closedAt !== from+step-1 || bars.at(-1)!.closedAt !== to-1) throw new Error('Replay candle coverage does not match requested range');
  const rates = new Map<number, number>();
  for (const row of data.funding) { if (!Number.isFinite(row.rate) || row.at % 3600000 || rates.has(row.at)) throw new Error('Invalid funding history'); rates.set(row.at,row.rate); }
  for (let at=Math.ceil(from/3600000)*3600000; at<to; at+=3600000) if (!rates.has(at)) throw new Error('Missing hourly funding history');
  const evaluate = compileFlow(document, runtimeNodePackages, false);
  const cursors = Object.fromEntries(Object.keys(counts).map(key => [key, 0]));
  let state: Record<string, unknown> = {}, cash = settings.startingCapital, quantity = 0, entryPrice = 0, fees = 0, funding = 0, realizedPnl = 0, peak = cash, drawdown = 0, rejectedOrders = 0;
  let priorPrice = data.candles[settings.timeframe].find(bar => bar.closedAt === from-1)!.close;
  const pending = new Map<string, OrderPlan>();
  const seen = new Set<string>();
  const fills: FlowBacktestTrade[] = [];
  const equityCurve = [{ at: from, equity: cash }];
  const nodeStats: FlowBacktestResult['nodeStats'] = {};
  let nextCancelled: string[] = [];
  for (let index=0; index<bars.length; index++) {
    const bar=bars[index], at=bar.closedAt-step+1;
    const acknowledged: Fill[] = [], cancelled: string[] = nextCancelled;
    nextCancelled = [];
    if (rates.has(at)) { const charge=quantity*priorPrice*rates.get(at)!; cash-=charge; funding+=charge; }
    let reducible = Math.abs(quantity);
    for (const order of pending.values()) {
      if (order.limitPrice !== undefined && !(order.side==='buy' ? bar.low<=order.limitPrice : bar.high>=order.limitPrice)) continue;
      const sign=order.side==='buy'?1:-1;
      const slippedOpen=bar.open*(1+sign*settings.slippageBps/10000);
      const price=order.limitPrice===undefined ? slippedOpen : order.side==='buy' ? Math.min(order.limitPrice,slippedOpen) : Math.max(order.limitPrice,slippedOpen);
      const amount=order.reduceOnly ? quantity*sign<0 ? Math.min(order.quantity,Math.abs(quantity),reducible) : 0 : order.quantity;
      const fee=amount*price*settings.feeBps/10000;
      const markedEquity=cash+quantity*(price-entryPrice);
      if (!amount || !order.reduceOnly && Math.abs(quantity+sign*amount)*price > Math.max(0,markedEquity-fee)) { cancelled.push(order.clientOrderId); pending.delete(order.clientOrderId); rejectedOrders++; continue; }
      const closing=quantity*sign<0 ? Math.min(amount,Math.abs(quantity)) : 0;
      const pnl=closing*(price-entryPrice)*Math.sign(quantity);
      const next=quantity+sign*amount;
      if (Math.abs(next)<1e-12) { quantity=0; entryPrice=0; }
      else { entryPrice = !quantity || quantity*next<0 ? price : quantity*sign>0 ? (Math.abs(quantity)*entryPrice+amount*price)/(Math.abs(quantity)+amount) : entryPrice; quantity=next; }
      reducible=Math.max(0,reducible-closing); cash+=pnl-fee; realizedPnl+=pnl; fees+=fee;
      fills.push({ at, orderId: order.clientOrderId, side: order.side, quantity: amount, price, fee, realizedPnl: pnl, reduceOnly: order.reduceOnly });
      acknowledged.push({ id: `${order.clientOrderId}:fill`, clientOrderId: order.clientOrderId, side: order.side, quantity: amount, price, fee });
      pending.delete(order.clientOrderId);
      if (amount<order.quantity) cancelled.push(order.clientOrderId);
      if (fills.length>20000) throw new Error('Fill limit exceeded; shorten the backtest');
    }
    const equity=cash+quantity*(bar.close-entryPrice);
    if (!Number.isFinite(equity) || equity<=0) throw new Error('Account depleted; leveraged/liquidation modeling is not supported');
    const candles: Record<string,Candle[]> = {};
    for (const [timeframe,count] of Object.entries(counts)) {
      const series=data.candles[timeframe];
      while(cursors[timeframe]<series.length && series[cursors[timeframe]].closedAt<=bar.closedAt) cursors[timeframe]++;
      candles[timeframe]=series.slice(Math.max(0,cursors[timeframe]-count),cursors[timeframe]);
    }
    const run=evaluate({ runId: `bar:${bar.closedAt}`, deploymentId:'historical-replay', market:settings.market, at:bar.closedAt, price:bar.close, equity, candles, fills:acknowledged, cancelledOrderIds:cancelled },state);
    state=run.state;
    // Cancellation acknowledgement is delivered on the next evaluation, like fills.
    for (const id of run.cancelOrderIds) { if(pending.delete(id)) nextCancelled.push(id); }
    for (const order of run.orders) { if(seen.has(order.clientOrderId)) throw new Error('Repeated client order ID'); seen.add(order.clientOrderId); pending.set(order.clientOrderId,order); }
    if(pending.size>1000) throw new Error('Too many pending orders');
    // The next bar consumes explicit cancel acknowledgements before new evaluation.
    for(const trace of run.trace) { const stats=nodeStats[trace.nodeId]??={executed:0,skipped:0,unavailable:0}; stats[trace.status??'executed']++; }
    peak=Math.max(peak,equity); drawdown=Math.max(drawdown,(peak-equity)/peak*100); equityCurve.push({at:bar.closedAt,equity}); priorPrice=bar.close;
    if(index%25===0) onProgress?.((index+1)/bars.length);
  }
  const finalEquity=equityCurve.at(-1)!.equity;
  onProgress?.(1);
  return { document:structuredClone(document), engineVersion:FLOW_BACKTEST_ENGINE, dataHash:'', flowHash:'', settings, dataset:{source:data.source,fetchedAt:data.fetchedAt,from,to,bars:bars.length},durationMs:performance.now()-started,finalEquity,returnPercent:(finalEquity/settings.startingCapital-1)*100,maxDrawdownPercent:drawdown,fees,funding,realizedPnl,unrealizedPnl:quantity*(priorPrice-entryPrice),position:{quantity,entryPrice},fills,rejectedOrders,pendingOrders:pending.size,equityCurve,nodeStats,warnings:[
    'OHLCV simulation: signals use closed candles; orders can fill only from the next bar. Marketable limits use the next open with slippage bounded by their limit; other touched limits fill at the limit. Newly opened inventory cannot be reduced intrabar. Intrabar ordering and queue priority are not modeled.',
    'Net position, at most 1× exposure. No leverage, liquidation, hedge mode, lot-size/minimum-notional enforcement or order-book liquidity model.',
    'Historical funding is assigned to its hourly settlement bucket (exchange publication can lag by milliseconds), using the preceding close as a mark-price proxy before same-boundary orders. Fees apply to each fill.',
    'Open positions are marked to the last close, not forcibly closed. Ending pending orders remain unfilled.',
    ...(Object.values(nodeStats).some(stats=>stats.unavailable) ? ['Some nodes produced unavailable data; inspect node coverage before interpreting results.'] : []),
  ] };
}
