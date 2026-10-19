import { expect, it } from 'vitest';
import { loadLighterHistory } from '../src/main/backtest/lighter-history';

it.runIf(process.env.CATBOTS_LIGHTER_PUBLIC_SMOKE==='1')('verifies seven days against the public Lighter API without credentials or trading', async () => {
  const to=Math.floor(Date.now()/3600000)*3600000,from=to-7*86400000;
  const result=await loadLighterHistory('SOL-PERP',from,to,{'1m':15},AbortSignal.timeout(60000));
  expect(result.candles['1m']).toHaveLength(10095);
  expect(result.funding).toHaveLength(168);
},65000);

it('loads seven days of minute candles plus warmup with signed hourly funding', async () => {
  const from = Date.UTC(2026, 9, 1), to = from + 7 * 86400000;
  const request: typeof fetch = async input => {
    const url = new URL(String(input));
    const start = Number(url.searchParams.get('start_timestamp')) * 1000;
    const end = Number(url.searchParams.get('end_timestamp')) * 1000;
    if (url.pathname.endsWith('orderBooks')) return Response.json({ code:200, order_books:[{ market_id:2, symbol:'SOL', market_type:'perp', status:'active' }] });
    const step = url.pathname.endsWith('candles') ? 60000 : 3600000;
    const timestamps = Array.from({length:Math.min(500, Math.ceil((end-start)/step))}, (_,i)=>start+i*step);
    return Response.json(url.pathname.endsWith('candles') ? {code:200,c:timestamps.map(t=>({t,o:100,h:101,l:99,c:100,v:1}))} : {code:200,fundings:timestamps.map(t=>({timestamp:t/1000,rate:'0.001',direction:'short'}))});
  };
  const result = await loadLighterHistory('SOL-PERP', from, to, {'1m':15}, new AbortController().signal, request);
  expect(result.candles['1m']).toHaveLength(10095);
  expect(result.candles['1m'][0].closedAt).toBe(from-14*60000-1);
  expect(result.candles['1m'].at(-1)?.closedAt).toBe(to-1);
  expect(result.funding).toHaveLength(168);
  expect(result.funding[0].rate).toBe(-0.00001);
  expect(result.source).toContain('Lighter');
});

it('rejects missing candles instead of inventing or interpolating prices', async () => {
  const request: typeof fetch = async input => Response.json(String(input).includes('orderBooks') ? {code:200,order_books:[{market_id:2,symbol:'SOL',market_type:'perp',status:'active'}]} : {code:200,c:[]});
  await expect(loadLighterHistory('SOL-PERP',0,60000,{'1m':0},new AbortController().signal,request)).rejects.toThrow('incomplete');
});
