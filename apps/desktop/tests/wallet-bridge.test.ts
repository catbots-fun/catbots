import { it, expect, vi } from 'vitest';
import { startWalletBridge } from '../src/main/connections/wallet-bridge';
it('scopes signing to one challenge, denies workspace commands and accepts completion once', async () => {
 const complete=vi.fn(async()=>{}), asset=vi.fn(async()=>({body:new Uint8Array(),contentType:'text/html'}));
 const bridge=await startWalletBridge({challenge:{owner:'test',environment:'testnet'},complete,asset});
 try {
  await fetch(bridge.origin);expect(asset).toHaveBeenCalledWith('/wallet.html');
  const session=await fetch(`${bridge.origin}/api/session`,{headers:{'x-catbots-client':'1'}});
  const cookie=session.headers.get('set-cookie')!.split(';')[0];
  const rpc=(method:string,input?:unknown,origin=bridge.origin)=>fetch(`${bridge.origin}/api/rpc`,{method:'POST',headers:{cookie,origin,'x-catbots-client':'1','content-type':'application/json'},body:JSON.stringify({method,input})});
  expect((await rpc('wallet:challenge')).status).toBe(200);
  expect((await rpc('connections:command',{action:'start_flow'})).status).toBe(400);
  expect((await rpc('wallet:complete','0x'+'a'.repeat(130),'https://evil.example')).status).toBe(403);
  expect((await rpc('wallet:complete','invalid')).status).toBe(400);
  expect(complete).not.toHaveBeenCalled();
  expect((await rpc('wallet:complete','0x'+'a'.repeat(130))).status).toBe(200);
  expect(complete).toHaveBeenCalledTimes(1);
  expect((await rpc('wallet:complete','0x'+'a'.repeat(130))).status).toBe(400);
  expect((await (await rpc('wallet:challenge')).json()).result.completed).toBe(true);
 }finally{await bridge.close();await bridge.close();}
});
