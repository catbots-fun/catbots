// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectionCommand, FlowDeployment } from '@catbots/contracts';
import { ExecutionTargetPanel } from '../src/renderer/workbench/ExecutionTargetPanel';
afterEach(()=>{cleanup();vi.useRealTimers();});
it('shows global incident storage failure even before a bot has a deployment',async()=>{
 const command=async()=>({adapters:[],connections:[],incidentWarning:'Incident history unavailable.'});
 render(<ExecutionTargetPanel botId="bot" api={{command}}/>);
 expect(await screen.findByText('Incident monitoring unavailable')).toBeTruthy();
});
it('shows health evidence and withdraws responsive status when runtime polling hangs',async()=>{
 vi.useFakeTimers();
 const deployment:FlowDeployment={id:'deployment',botId:'bot',version:1,environment:'testnet',target:{botId:'bot',connectionId:'connection',accountId:'account',market:'SOL-PERP',maxOrderUsd:50,maxPositionUsd:100},status:'running',startedAt:new Date().toISOString(),cycles:1,orders:[],events:[],health:{state:'responsive',recovery:'not-assessed',heartbeatAt:'2026-10-19T00:00:00Z',snapshotReceivedAt:'2026-10-19T00:00:00Z'}};
 let hang=false;let release!:()=>void;
 const command=async(input:ConnectionCommand)=>{
  if(hang && input.action==='get_flow_runtime')await new Promise<void>(resolve=>{release=resolve;});
  return {adapters:[],connections:[],deployment,incidents:[{id:'incident',botId:'bot',deploymentId:'deployment',code:'runtime_failed' as const,phase:'detected' as const,at:'2026-10-19T00:00:00Z',delivery:'unavailable' as const,attempts:3}]};
 };
 render(<ExecutionTargetPanel botId="bot" api={{command}}/>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
 expect(screen.getByText('Responsive')).toBeTruthy();
 expect(screen.getByText('Snapshot received')).toBeTruthy();
 expect(screen.getByText('Not assessed')).toBeTruthy();
 expect(screen.getByText('Runtime failed')).toBeTruthy();
 expect(screen.getByText('Desktop notification unavailable')).toBeTruthy();
 hang=true;
 await act(async()=>{await vi.advanceTimersByTimeAsync(7000);});
 expect(screen.queryByText('Responsive')).toBeNull();
 expect(screen.getByText('Unavailable')).toBeTruthy();
 await act(async()=>{hang=false;release();await vi.advanceTimersByTimeAsync(0);});
 expect(screen.queryByText('Responsive')).toBeNull();
 await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
 expect(screen.getByText('Responsive')).toBeTruthy();
});
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
