// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatFlowDraft } from '@catbots/contracts';
import { useFlowWorkspaceState } from '../src/renderer/workbench/flow-workspace-state';
import { ChatFlowGraph } from '../src/renderer/workbench/ChatFlowGraph';
import { runLiveNode } from '../src/renderer/workbench/live-node-run';
vi.mock('../src/renderer/workbench/live-node-run', async original => {
  const actual = await original<typeof import('../src/renderer/workbench/live-node-run')>();
  return { ...actual, runLiveNode: vi.fn() };
});
vi.mock('../src/renderer/workbench/StrategyGraph', () => ({ StrategyNodeCard: () => null }));
vi.mock('@xyflow/react', () => ({
  MarkerType: { ArrowClosed: 'arrow' }, BackgroundVariant: { Dots: 'dots' }, Background: () => null,
  ReactFlow: ({ nodes, onNodeClick }: any) => <div>{nodes.map((node: any) => <button key={node.id} onClick={() => onNodeClick(null,node)}>Select {node.id}</button>)}</div>,
}));
const draft: ChatFlowDraft = { botId: '018f3f75-89ab-7def-8123-456789abcdef', version: 1, status: 'valid', updatedAt: '2026-09-06T00:00:00.000Z', document: {
  schemaVersion: '3.0', nodes: ['first','second'].map(id => ({ id, type: 'process.number', version: 1, config: { value: 14 } })), edges: [],
} };
let changeMarket: (market: string) => void;
let currentMarket: string;
function Harness() {
  const workspace = useFlowWorkspaceState();
  changeMarket = workspace.setMarket; currentMarket = workspace.market;
  const [visible, show] = useState(true);
  const [saved, setSaved] = useState(draft);
  return <><button onClick={() => show(!visible)}>Toggle flow tab</button><button onClick={() => setSaved(previous => ({ ...previous, version: 2, document: { ...previous.document, nodes: previous.document.nodes.map(node => ({ ...node, config: { value: 99 } })) } }))}>External edit</button>
    {visible && <ChatFlowGraph draft={saved} workspace={workspace} onSave={async updated => setSaved(previous => ({ ...previous, version: previous.version + 1, document: { ...previous.document, nodes: previous.document.nodes.map(node => node.id === updated.id ? updated : node) } }))} />}</>;
}
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function select(id: string) { const back = screen.queryByRole('button', {name: 'Back to canvas'}); if (back) fireEvent.click(back); fireEvent.click(screen.getByRole('button',{name:'Select '+id})); }
it('retains unsaved config and shared market across nodes, close and tabs, then saves only selected config', async () => {
  render(<Harness />); select('first');
  fireEvent.change(screen.getByRole('spinbutton',{name:'Value'}), {target:{value:'15'}});
  act(() => changeMarket('SOL-PERP'));
  select('second'); select('first');
  expect((screen.getByRole('spinbutton',{name:'Value'}) as HTMLInputElement).value).toBe('15');
  fireEvent.click(screen.getByRole('button',{name:'Back to canvas'})); select('first');
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Back to canvas'})); fireEvent.click(screen.getByRole('button',{name:'Toggle flow tab'})); fireEvent.click(screen.getByRole('button',{name:'Toggle flow tab'})); select('first');
  expect(currentMarket).toBe('SOL-PERP');
  expect((screen.getByRole('spinbutton',{name:'Value'}) as HTMLInputElement).value).toBe('15');
  fireEvent.click(screen.getByRole('button',{name:'Save configuration'}));
  await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
  select('second'); expect((screen.getByRole('spinbutton',{name:'Value'}) as HTMLInputElement).value).toBe('14');
});
const result = {
 snapshot: { source: 'Hyperliquid mainnet' as const, market: 'SOL-PERP', fetchedAt: '2026-09-06T00:00:00.000Z', price: 100, funding:0, candles:{} },
 run: { runId:'run-sol',market:'SOL-PERP',at:0,state:{},orders:[],cancelOrderIds:[],trace:['first','second'].map(nodeId => ({nodeId,status:'executed' as const,inputs:{},outputs:{value:{type:'number' as const,quality:'ready' as const,value:42}}})) },
};
it('retains run provenance and upstream outputs without refetching; marks changed context stale', async () => {
  vi.mocked(runLiveNode).mockResolvedValue(result);
  render(<Harness/>); act(() => changeMarket('SOL-PERP')); select('second');
  fireEvent.click(screen.getByRole('button',{name:'Execute step'})); await screen.findByText('Run ID: run-sol');
  select('first');
  expect(screen.getByText('42')).toBeTruthy(); expect(screen.getByText('Run ID: run-sol')).toBeTruthy();
  expect(runLiveNode).toHaveBeenCalledTimes(1);
  act(() => changeMarket('ETH-PERP'));
  expect(screen.getByText('Previous run · stale')).toBeTruthy();
  expect(screen.getByText(/Hyperliquid mainnet · SOL-PERP/)).toBeTruthy();
});
it('preserves in-flight results after switching selection', async () => {
  let finish!: (value: typeof result) => void;
  vi.mocked(runLiveNode).mockImplementation(() => new Promise(resolve => { finish=resolve; }));
  render(<Harness/>); select('first'); fireEvent.click(screen.getByRole('button',{name:'Execute step'})); select('second');
  await act(async () => finish(result));
   expect(screen.getByText('Run ID: run-sol')).toBeTruthy();
});
it('keeps local edits on remote changes and requires explicit reset before overwrite', () => {
  render(<Harness/>); select('first'); fireEvent.change(screen.getByRole('spinbutton',{name:'Value'}),{target:{value:'15'}});
  fireEvent.click(screen.getByRole('button',{name:'External edit',hidden:true}));
  expect((screen.getByRole('spinbutton',{name:'Value'}) as HTMLInputElement).value).toBe('15');
  expect(screen.getByText('Saved configuration changed')).toBeTruthy();
  expect((screen.getByRole('button',{name:'Save configuration'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Reset'}));
  expect((screen.getByRole('spinbutton',{name:'Value'}) as HTMLInputElement).value).toBe('99');
});
it('imports a sandbox into a shared bot and reuses that bot when retrying a failed import', async () => {
  const { PackageNodeExample } = await import('../src/renderer/workbench/PackageNodeExample');
  localStorage.setItem('catbots.flow-programming-draft.v1', JSON.stringify({ document: draft.document }));
  const created = { id: draft.botId, name: 'Flow from sandbox', dex: 'hyperliquid' as const, status: 'draft' as const, createdAt: draft.updatedAt, updatedAt: draft.updatedAt };
  const createDraft = vi.fn().mockResolvedValue(created);
  const command = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ packages: [], flowDraft: draft });
  const onOpenBot = vi.fn();
  render(<PackageNodeExample bots={{ createDraft, list: vi.fn() }} nodeApi={{ command }} onOpenBot={onOpenBot} />);
  fireEvent.click(screen.getByRole('button', { name: 'Import into new bot' }));
  await screen.findByText(/Import failed/);
  fireEvent.click(screen.getByRole('button', { name: 'Import into new bot' }));
  await waitFor(() => expect(onOpenBot).toHaveBeenCalledWith(created));
  expect(createDraft).toHaveBeenCalledTimes(1);
  expect(command).toHaveBeenLastCalledWith({ action: 'import_flow', botId: draft.botId, document: draft.document });
  localStorage.clear();
});
it('keeps a bounded execution history and selects one run for all node panels', () => {
  function History() {
    const workspace = useFlowWorkspaceState();
    return <><button onClick={() => { for (let i=0;i<25;i++) workspace.record({ ...result, run: {...result.run,runId:`run-${i}`},documentKey:'doc' }); }}>Record runs</button><output>{workspace.history.length}:{workspace.selectedRunId}:{workspace.history.at(-1)?.run.runId}</output></>;
  }
  render(<History />); fireEvent.click(screen.getByRole('button',{name:'Record runs'}));
  expect(screen.getByText('20:run-24:run-5')).toBeTruthy();
});
it('does not substitute another run when the selected execution lacks the current node', async () => {
  vi.mocked(runLiveNode).mockResolvedValue({ ...result, run: { ...result.run, trace: result.run.trace.slice(0,1) } });
  render(<Harness />); select('first'); fireEvent.click(screen.getByRole('button',{name:'Execute step'}));
  await screen.findByText('Run ID: run-sol'); select('second');
  expect(screen.getByText('This node was not evaluated in the selected execution.')).toBeTruthy();
  expect(screen.queryByText('42')).toBeNull();
});
