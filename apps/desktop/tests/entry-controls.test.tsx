// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectionCommand, FlowDeployment } from '@catbots/contracts';
import { ExecutionTargetPanel } from '../src/renderer/workbench/ExecutionTargetPanel';
afterEach(cleanup);
it('requires typed confirmation before sending a deployment-bound close', async () => {
 const deployment:FlowDeployment={id:'00000000-0000-4000-8000-000000000004',botId:'00000000-0000-4000-8000-000000000001',version:1,environment:'testnet',target:{botId:'00000000-0000-4000-8000-000000000001',connectionId:'',accountId:'',market:'SOL-PERP',maxOrderUsd:50,maxPositionUsd:100},status:'running',startedAt:new Date().toISOString(),cycles:1,orders:[],events:[],closePositionSupported:true,position:.2};
 const command=vi.fn(async(_input:ConnectionCommand)=>({adapters:[],connections:[],deployment}));
 render(<ExecutionTargetPanel botId={deployment.botId} api={{command}}/>);
 const button=await screen.findByRole('button',{name:'Close position & stop'});
 expect((button as HTMLButtonElement).disabled).toBe(true);
 expect(command).not.toHaveBeenCalledWith(expect.objectContaining({action:'close_flow_position'}));
 await userEvent.type(screen.getByLabelText('Close confirmation'),'CLOSE SOL-PERP');
 await userEvent.click(button);
 expect(command).toHaveBeenCalledWith({action:'close_flow_position',botId:deployment.botId,deploymentId:deployment.id,confirmation:'CLOSE SOL-PERP'});
});
it('separates pause entries from stop runtime and binds changes to the deployment', async () => {
  let deployment:FlowDeployment={id:'00000000-0000-4000-8000-000000000004',botId:'00000000-0000-4000-8000-000000000001',version:1,environment:'testnet',target:{botId:'00000000-0000-4000-8000-000000000001',connectionId:'',accountId:'',market:'SOL-PERP',maxOrderUsd:50,maxPositionUsd:100},status:'running',startedAt:new Date().toISOString(),cycles:1,orders:[],events:[],entryPauseSupported:true};
  const command=vi.fn(async(input:ConnectionCommand)=>{
    if(input.action==='set_flow_entries_paused') deployment={...deployment,entriesPaused:input.paused};
    return {adapters:[],connections:[],deployment};
  });
  render(<ExecutionTargetPanel botId={deployment.botId} api={{command}}/>);
  await userEvent.click(await screen.findByRole('button',{name:'Pause entries'}));
  expect(command).toHaveBeenCalledWith({action:'set_flow_entries_paused',botId:deployment.botId,deploymentId:deployment.id,paused:true});
  expect(await screen.findByRole('button',{name:'Resume entries'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'Stop runtime'})).toBeTruthy();
  expect(command).not.toHaveBeenCalledWith(expect.objectContaining({action:'stop_flow'}));
  await userEvent.click(screen.getByRole('button',{name:'Resume entries'}));
  expect(command).toHaveBeenCalledWith(expect.objectContaining({action:'set_flow_entries_paused',paused:false}));
});
