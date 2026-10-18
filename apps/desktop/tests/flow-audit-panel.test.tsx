// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { CatbotsDesktopApi, ConnectionsView, FlowAuditRecord } from '@catbots/contracts';
import { FlowExecutionResults } from '../src/renderer/workbench/FlowExecutionResults';

afterEach(cleanup);
const empty = { adapters: [], connections: [] };
const record = (sequence: number, botId='bot-a'): FlowAuditRecord => ({
  sequence, botId, deploymentId:`run-${sequence}`, version:sequence,
  kind:'evaluation', at:'2026-10-18T12:00:00Z', details:{orders:[], trace:[{nodeId:`condition-${sequence}`,outputs:{passed:false}}]},
});
type Command = NonNullable<CatbotsDesktopApi['connections']>['command'];
function api(audit: (input: any)=>Promise<ConnectionsView>): CatbotsDesktopApi['connections'] {
  return {command: ((input: any)=>input.action==='get_flow_audit' ? audit(input) : Promise.resolve(empty)) as Command};
}

it('browses stored evaluations even without runtime snapshots and navigates cursor pages', async()=>{
  render(<FlowExecutionResults botId="bot-a" logs api={api(async input=>({
    ...empty,auditPage:input.after===0?{records:[record(1)],nextAfter:1}:{records:[record(3)]},
  }))}/>);
  await screen.findByRole('button',{name:/Event #1/});
  fireEvent.click(screen.getByRole('button',{name:/Event #1/}));
  await screen.findByText(/condition-1/);
  fireEvent.click(screen.getByRole('button',{name:'Next page'}));
  await screen.findByRole('button',{name:/Event #3/});
  expect(screen.queryByRole('button',{name:/Event #1/})).toBeNull();
  expect((screen.getByRole('button',{name:'Next page'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Previous page'}));
  await screen.findByRole('button',{name:/Event #1/});
});

it('distinguishes failure from empty evidence and allows retry',async()=>{
  let fail=true;
  render(<FlowExecutionResults botId="bot-a" logs api={api(async()=>{
    if(fail)throw new Error('sensitive transport failure');
    return {...empty,auditPage:{records:[]}};
  })}/>);
  await screen.findByText('Audit history unavailable');
  expect(screen.queryByText(/sensitive transport failure/)).toBeNull();
  expect(screen.queryByText('No recorded audit events')).toBeNull();
  fail=false;fireEvent.click(screen.getByRole('button',{name:'Retry audit history'}));
  await screen.findByText('No recorded audit events');
});

it('ignores an old bot response after switching bots',async()=>{
  let resolve!: (value:ConnectionsView)=>void;
  const connectionApi=api(input=>input.botId==='bot-a'?new Promise(done=>{resolve=done;}):Promise.resolve({...empty,auditPage:{records:[record(2,'bot-b')]}}));
  const view=render(<FlowExecutionResults botId="bot-a" logs api={connectionApi}/>);
  await screen.findByText('Loading audit history…');
  view.rerender(<FlowExecutionResults botId="bot-b" logs api={connectionApi}/>);
  await screen.findByRole('button',{name:/Event #2/});
  await act(async()=>resolve({...empty,auditPage:{records:[record(1)]}}));
  expect(screen.queryByRole('button',{name:/Event #1/})).toBeNull();
  expect(screen.getByRole('button',{name:/Event #2/})).toBeTruthy();
});

it('does not present unsupported preview responses as an empty journal',async()=>{
  render(<FlowExecutionResults botId="bot-a" logs api={api(async()=>empty)}/>);
  await screen.findByText('Audit history unavailable');
  expect(screen.queryByText('No recorded audit events')).toBeNull();
});

it('refreshes the current page to discover newly appended events',async()=>{
  let count=0;
  render(<FlowExecutionResults botId="bot-a" logs api={api(async()=>({...empty,auditPage:{records:++count===1?[record(1)]:[record(1),record(2)]}}))}/>);
  await screen.findByRole('button',{name:/Event #1/});
  fireEvent.click(screen.getByRole('button',{name:'Refresh audit history'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:/Event #2/})).toBeTruthy());
});
