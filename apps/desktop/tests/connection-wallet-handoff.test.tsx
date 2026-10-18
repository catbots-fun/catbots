// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectionsView } from '@catbots/contracts';
import { ConnectionsScreen } from '../src/renderer/screens/ConnectionsScreen';
afterEach(cleanup);
it('opens a scoped signing page without an injected wallet and picks up approval automatically', async()=>{
 const connection={id:'00000000-0000-4000-8000-000000000001',name:'Test wallet',adapterId:'hyperliquid',environment:'testnet',owner:'0x'+'1'.repeat(40),permission:'view-only',accounts:[],updatedAt:new Date().toISOString()} as ConnectionsView['connections'][number];
 let opened=false;
 const command=vi.fn(async(input:{action:string})=>{
  if(input.action==='open_wallet_browser')opened=true;
  return {adapters:[],connections:[opened?{...connection,permission:'trading-authorized' as const,authorizationCheckedAt:new Date().toISOString()}:connection]};
 });
 render(<ConnectionsScreen api={{command}}/>);
 await userEvent.click(await screen.findByRole('button',{name:'Manage connection'}));
 await userEvent.click(screen.getByRole('button',{name:'Authorize trading'}));
 expect(command).toHaveBeenCalledWith({action:'open_wallet_browser',id:connection.id});
 await waitFor(()=>expect(screen.getByText('Authorized')).toBeTruthy());
 expect(screen.queryByText('Waiting for wallet approval')).toBeNull();
 expect(command).not.toHaveBeenCalledWith(expect.objectContaining({action:'start_flow'}));
});
