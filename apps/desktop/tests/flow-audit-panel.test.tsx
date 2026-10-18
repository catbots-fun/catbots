// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CatbotsDesktopApi, ConnectionsView, FlowAuditRecord } from '@catbots/contracts';
import { FlowExecutionResults } from '../src/renderer/workbench/FlowExecutionResults';

afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

function captureDownload() {
  const createObjectURL=vi.fn((_blob:Blob)=>'blob:export');
  vi.stubGlobal('URL',Object.assign(class extends URL {},{createObjectURL,revokeObjectURL:vi.fn()}));
  vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  return createObjectURL;
}
const readBlob=(blob:Blob)=>new Promise<string>((resolve,reject)=>{
  const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsText(blob);
});
it('exports a complete bounded snapshot with manifest and shows retention/storage scope',async()=>{
  const download=captureDownload();
  const connectionApi:NonNullable<CatbotsDesktopApi['connections']>={command:async input=>{
    if(input.action==='get_flow_audit_summary')return {...empty,auditSummary:{count:2,through:3,databaseBytes:4096,retention:'keep_all'}};
    if(input.action==='get_flow_audit')return {...empty,auditPage:input.after===0?{records:[record(1)],nextAfter:1}:{records:[record(3)]}};
    return empty;
  }};
  render(<FlowExecutionResults botId="bot-a" logs api={connectionApi}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Inspect storage'}));
  await screen.findByText(/2 events for this bot/);
  expect(screen.getByText(/No automatic deletion/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Export JSONL'}));
  await screen.findByText(/Download initiated/);
  const lines=(await readBlob(download.mock.calls[0][0])).trim().split('\n').map(line=>JSON.parse(line));
  expect(lines[0]).toMatchObject({type:'manifest',botId:'bot-a',count:2,through:3});
  expect(lines.filter(line=>line.type==='event').map(line=>line.sequence)).toEqual([1,3]);
  expect(lines.at(-1)).toMatchObject({type:'end',count:2});
});

it.each(['missing','foreign','duplicate','beyond_snapshot','count_limit','byte_limit','unsupported'] as const)('never downloads an incomplete or invalid export (%s)',async mode=>{
  const download=captureDownload();
  const connectionApi:NonNullable<CatbotsDesktopApi['connections']>={command:async input=>{
    if(input.action==='get_flow_audit_summary')return mode==='unsupported'?empty:{...empty,auditSummary:{count:mode==='count_limit'?50001:mode==='byte_limit'?30:2,through:30,databaseBytes:4096,retention:'keep_all'}};
    if(input.action==='get_flow_audit' && input.through!==undefined) {
      if(mode==='foreign')return {...empty,auditPage:{records:[record(1,'other-bot')]}};
      if(mode==='duplicate')return {...empty,auditPage:{records:[record(1),record(1)]}};
      if(mode==='beyond_snapshot')return {...empty,auditPage:{records:[record(1),record(31)]}};
      if(mode==='byte_limit')return {...empty,auditPage:{records:Array.from({length:input.after===0?20:10},(_,i)=>({...record(input.after+i+1),details:{text:'x'.repeat(1024*1024-1024)}})),...(input.after===0?{nextAfter:20}:{})}};
      return {...empty,auditPage:{records:[record(1)]}};
    }
    return {...empty,auditPage:{records:[]}};
  }};
  render(<FlowExecutionResults botId="bot-a" logs api={connectionApi}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Export JSONL'}));
  await screen.findByText('Export unavailable');
  expect(download).not.toHaveBeenCalled();
});

it.each(['cancel','switch_bot'] as const)('cancels a pending export and ignores its late response (%s)',async mode=>{
  const download=captureDownload();let finish!:(result:ConnectionsView)=>void;
  const connectionApi:NonNullable<CatbotsDesktopApi['connections']>={command:async input=>{
    if(input.action==='get_flow_audit_summary')return {...empty,auditSummary:{count:1,through:1,databaseBytes:4096,retention:'keep_all'}};
    if(input.action==='get_flow_audit' && input.through!==undefined)return new Promise(resolve=>{finish=resolve;});
    return {...empty,auditPage:{records:[]}};
  }};
  const view=render(<FlowExecutionResults botId="bot-a" logs api={connectionApi}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Export JSONL'}));
  await waitFor(()=>expect(finish).toBeDefined());
  if(mode==='cancel')fireEvent.click(screen.getByRole('button',{name:'Cancel export'}));
  else view.rerender(<FlowExecutionResults botId="bot-b" logs api={connectionApi}/>);
  await act(async()=>finish({...empty,auditPage:{records:[record(1)]}}));
  expect(download).not.toHaveBeenCalled();
  expect(screen.queryByText(/Download initiated/)).toBeNull();
});
it('shows a sticky audit gap warning without replacing the financial error', async()=>{
  const connectionApi:NonNullable<CatbotsDesktopApi['connections']>={command:async input=>input.action==='get_flow_audit'?{...empty,auditPage:{records:[{...record(1),kind:'lifecycle'}]}}:{...empty,deployment:{
    id:'run',botId:'bot-a',version:1,environment:'testnet',target:{botId:'bot-a',connectionId:'connection',accountId:'account',market:'SOL-PERP',maxPositionUsd:100,maxOrderUsd:50},status:'failed',startedAt:'2026-10-19T00:00:00Z',cycles:1,orders:[],events:[],error:'Uncertain order',auditWarning:'Some audit events could not be saved.',
  }}};
  render(<FlowExecutionResults botId="bot-a" logs api={connectionApi}/>);
  await screen.findByText('Audit history may be incomplete');
  expect(screen.getByText('Uncertain order')).toBeTruthy();
  expect(screen.getByText('Lifecycle')).toBeTruthy();
});
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
  expect(screen.queryByText(/No exchange run yet/)).toBeNull();
  expect(screen.getByText('No runtime snapshot available. Audit history is shown separately above.')).toBeTruthy();
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
