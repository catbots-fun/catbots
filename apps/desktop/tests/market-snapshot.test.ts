import { afterEach, expect, it, vi } from 'vitest';
import { fetchMarketSnapshot } from '../src/main/nodes/market-snapshot';
import { runLiveNode } from '../src/renderer/workbench/live-node-run';
const meta = [{ universe: [{ name: 'ETH' }] }, [{ markPx: '2500.5', funding: '0.00001' }]];
afterEach(()=>vi.useRealTimers());
it.each([{completedAt:239999,accepted:true},{completedAt:179999,accepted:false}])('handles freshness boundary and clock rollback ($completedAt)',async({completedAt,accepted})=>{
  vi.useFakeTimers();vi.setSystemTime(180000);
  const request:typeof fetch=async(_url,init)=>{
    if(JSON.parse(String(init?.body)).type==='metaAndAssetCtxs')return Response.json(meta);
    vi.setSystemTime(completedAt);
    return Response.json([{t:60000,T:119999,s:'ETH',i:'1m',o:2500,h:2502,l:2499,c:2501,v:20}]);
  };
  const result=fetchMarketSnapshot({action:'market_snapshot',market:'ETH-PERP',timeframes:['1m']},request);
  if(accepted)expect((await result).candles['1m']).toHaveLength(1);
  else await expect(result).rejects.toMatchObject({name:'StaleMarketDataError'});
});
it.each([['1m'],['1m','5m']])('rejects candles that expire before the complete snapshot returns (%j)',async (...timeframes)=>{
  vi.useFakeTimers();vi.setSystemTime(180000);
  const request:typeof fetch=async (_url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(body.type==='metaAndAssetCtxs')return Response.json(meta);
    const interval=body.req.interval;
    if(interval===timeframes.at(-1))vi.setSystemTime(240000);
    const t=interval==='1m'?60000:-300000;
    return Response.json([{t,T:t+(interval==='1m'?59999:299999),s:'ETH',i:interval,o:2500,h:2502,l:2499,c:2501,v:20}]);
  };
  await expect(fetchMarketSnapshot({action:'market_snapshot',market:'ETH-PERP',timeframes},request)).rejects.toMatchObject({name:'StaleMarketDataError'});
});
it('returns exchange price and only closed candles with provenance', async () => {
  const now = Date.now(); const open = Math.floor(now / 300000) * 300000;
  const row = (t: number) => ({ t, T: t + 299999, s: 'ETH', i: '5m', o: '2500', h: '2502', l: '2499', c: '2501', v: '20' });
  const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(meta))).mockResolvedValueOnce(new Response(JSON.stringify([row(open-300000),row(open)])));
  const snapshot = await fetchMarketSnapshot({ action: 'market_snapshot', market: 'ETH-PERP', timeframes: ['5m'] }, request);
  expect(snapshot.price).toBe(2500.5);
  expect(snapshot.candles['5m']).toHaveLength(1);
  expect(snapshot.source).toBe('Hyperliquid mainnet');
});
it('rejects network errors without manufacturing data', async () => {
  await expect(fetchMarketSnapshot({ action: 'market_snapshot', market: 'ETH-PERP' }, vi.fn().mockResolvedValue(new Response('', { status: 503 })))).rejects.toThrow();
});
it('evaluates actual supplied price and leaves equity unavailable', async () => {
  const snapshot = { market: 'ETH-PERP', source: 'Hyperliquid mainnet' as const, fetchedAt: new Date().toISOString(), price: 2500.5, funding: 0, candles: {} };
  const api = { command: vi.fn().mockResolvedValue({ packages: [], marketSnapshot: snapshot }) };
  const document = { schemaVersion: '3.0' as const, nodes: [{ id: 'price', type: 'data.price', version: 1, config: {} }, { id: 'equity', type: 'data.equity', version: 1, config: {} }], edges: [] };
  expect((await runLiveNode(document,'price',api,'ETH-PERP')).run.trace[0]?.outputs.value?.value).toBe(2500.5);
  expect((await runLiveNode(document,'equity',api,'ETH-PERP')).run.trace[0]?.outputs.value?.quality).toBe('unavailable');
});
