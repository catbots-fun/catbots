// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StrategyRevision } from '@catbots/contracts';

const flow = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }));
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: Record<string, unknown>) => {
    flow.props = props;
    const StrategyNode = (props.nodeTypes as { strategy: React.ComponentType<{ data: Record<string, unknown> }> }).strategy;
    return <>
      <button onClick={() => (props.onNodeClick as Function)?.({}, (props.nodes as unknown[])[0])}>Flow canvas</button>
      {(props.nodes as Array<{ id: string; data: Record<string, unknown> }>).map((node) => <StrategyNode key={node.id} data={node.data} />)}
      {props.children as React.ReactNode}
    </>;
  },
  Background: () => <div data-testid="flow-background" />,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => <div data-testid="flow-controls" />,
  Handle: () => null,
  MiniMap: () => <div data-testid="flow-minimap" />,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Left: 'left', Right: 'right' },
}));

import { buildStrategyGraph, readableRule } from '../src/renderer/workbench/graph-model';
import { StrategyGraph } from '../src/renderer/workbench/StrategyGraph';

const revision: StrategyRevision = {
  botId: '018f3f75-89ab-7def-8123-456789abcdef',
  strategyId: 'strategy',
  version: 1,
  name: 'ETF momentum',
  schemaVersion: '2.0',
  marketScope: { type: 'dex_universe' },
  status: 'draft',
  createdAt: '2026-09-04T00:00:00.000Z',
  approvedAt: null,
  nodes: [
    { id: 'trigger', kind: 'trigger', type: 'trigger.interval', version: 1, title: 'Interval', summary: 'Every 1h' },
    { id: 'condition', kind: 'condition', type: 'predicate.compare', version: 1, title: 'Compare', summary: 'ETF flow > 0' },
    { id: 'condition-2', kind: 'condition', type: 'predicate.position', version: 1, title: 'Position', summary: 'Current market is flat' },
    { id: 'combine', kind: 'condition', type: 'combine.all', version: 1, title: 'All conditions', summary: 'Both conditions must pass' },
    { id: 'action', kind: 'action', type: 'execution.open_position', version: 1, title: 'Open position', summary: 'Open long' },
  ],
  edges: [
    { id: 'e1', source: 'trigger', sourcePort: 'activation', target: 'condition', targetPort: 'activation' },
    { id: 'e2', source: 'trigger', sourcePort: 'activation', target: 'condition-2', targetPort: 'activation' },
    { id: 'e3', source: 'condition', sourcePort: 'result', target: 'combine', targetPort: 'condition' },
    { id: 'e4', source: 'condition-2', sourcePort: 'result', target: 'combine', targetPort: 'condition' },
    { id: 'e5', source: 'combine', sourcePort: 'result', target: 'action', targetPort: 'condition' },
  ],
};

afterEach(() => { cleanup(); flow.props = undefined; });

describe('strategy graph', () => {
  it('projects deterministic left-to-right positions without mutating the revision', () => {
    const before = structuredClone(revision);
    const graph = buildStrategyGraph(revision);

    expect(buildStrategyGraph(revision)).toEqual(graph);
    for (const edge of graph.edges) {
      const source = graph.nodes.find((node) => node.id === edge.source)!;
      const target = graph.nodes.find((node) => node.id === edge.target)!;
      expect(target.position.x).toBeGreaterThan(source.position.x + source.width!);
      expect(edge.type).toBe('default');
    }
    for (const [index, node] of graph.nodes.entries()) {
      for (const other of graph.nodes.slice(index + 1)) {
        const separateX = Math.abs(node.position.x - other.position.x) >= 240;
        const separateY = Math.abs(node.position.y - other.position.y) >= 112;
        expect(separateX || separateY).toBe(true);
      }
    }
    expect(graph.edges).toEqual([
      expect.objectContaining({ id: 'e1', source: 'trigger', target: 'condition' }),
      expect.objectContaining({ id: 'e2', source: 'trigger', target: 'condition-2' }),
      expect.objectContaining({ id: 'e3', source: 'condition', target: 'combine' }),
      expect.objectContaining({ id: 'e4', source: 'condition-2', target: 'combine' }),
      expect.objectContaining({ id: 'e5', source: 'combine', target: 'action' }),
    ]);
    expect(revision).toEqual(before);
  });

  it('keeps interleaved independent rule branches together', () => {
    const predicate = revision.nodes[1];
    const combine = revision.nodes[3];
    const nodes = [revision.nodes[0], ...['a1', 'b1', 'a2', 'b2'].map((id) => ({ ...predicate, id })),
      { ...combine, id: 'a' }, { ...combine, id: 'b' }];
    const edges = ['a1', 'b1', 'a2', 'b2'].flatMap((id) => [
      { id: `start-${id}`, source: 'trigger', sourcePort: 'activation', target: id, targetPort: 'activation' },
      { id: `join-${id}`, source: id, sourcePort: 'result', target: id[0], targetPort: 'conditions' },
    ]);
    const graph = buildStrategyGraph({ ...revision, nodes, edges });
    const y = (id: string) => graph.nodes.find((node) => node.id === id)!.position.y;
    const a = [y('a1'), y('a2')];
    const b = [y('b1'), y('b2')];
    expect(Math.max(...a) < Math.min(...b) || Math.max(...b) < Math.min(...a)).toBe(true);
    expect(graph.edges).toHaveLength(edges.length);
  });

  it('preserves actual port IDs including single-input NOT and labels boolean edges truthfully', () => {
    const graph = buildStrategyGraph({ ...revision, nodes: revision.nodes.map((node) => node.id === 'combine' ? { ...node, type: 'combine.not' } : node) });
    expect(graph.nodes.find((node) => node.id === 'combine')?.data.inputPorts).toEqual(['condition']);
    expect(graph.edges.find((edge) => edge.id === 'e3')?.label).toBe('Result');
    expect(graph.edges.find((edge) => edge.id === 'e5')?.label).toBe('If true');
    expect(readableRule('indicator.rsi.14.value < 30')).toBe('RSI (14) < 30');
    expect(readableRule('custom.metric > 5')).toBe('custom.metric > 5');
  });

  it('renders a read-only selectable React Flow canvas with navigation aids', () => {
    const onSelectNode = vi.fn();
    render(<StrategyGraph revision={revision} onSelectNode={onSelectNode} />);

    expect(flow.props).toMatchObject({
      nodesDraggable: true,
      nodesConnectable: false,
      elementsSelectable: true,
      defaultViewport: { x: 24, y: 24, zoom: 1 },
    });
    expect(screen.getByRole('button', { name: 'Fit all' })).toBeTruthy();
    expect(flow.props?.fitView).toBe(true);
    expect(screen.getByTestId('flow-background')).toBeTruthy();
    expect(screen.getByTestId('flow-minimap')).toBeTruthy();
    expect(screen.getByText('All active perpetual markets')).toBeTruthy();
    expect(screen.getAllByTestId('strategy-node').map((node) => node.dataset.kind)).toEqual([
      'trigger', 'condition', 'condition', 'condition', 'action',
    ]);
    expect(screen.queryByText('Market scope', { selector: '[data-testid="strategy-node"] *' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Flow canvas' }));
    expect(onSelectNode).toHaveBeenCalledWith(revision.nodes[0]);
  });

  it('labels dynamic and legacy fixed-market scope truthfully outside the canvas', () => {
    const dynamicRevision = {
      ...revision, schemaVersion: '2.0', marketScope: { type: 'dex_universe' },
    } as unknown as StrategyRevision;
    const legacyRevision = {
      ...revision, schemaVersion: '1.0', marketScope: { type: 'legacy_fixed', market: 'BTC-PERP' },
    } as unknown as StrategyRevision;
    const { rerender } = render(<StrategyGraph revision={dynamicRevision} onSelectNode={vi.fn()} />);

    expect(screen.getByText('All active perpetual markets')).toBeTruthy();
    rerender(<StrategyGraph revision={legacyRevision} onSelectNode={vi.fn()} />);

    expect(screen.getByText('Fixed market · BTC-PERP')).toBeTruthy();
    expect(screen.queryByText('All active perpetual markets')).toBeNull();
  });
});
