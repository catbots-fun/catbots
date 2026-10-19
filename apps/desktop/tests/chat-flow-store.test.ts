import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ChatFlowStore } from '../src/main/nodes/chat-flow-store';
import { createAgentToolCatalog, type AgentToolDependencies } from '../src/main/agent/agent-tools';
import { bundledSampleDatasetCatalog } from '../src/main/workbench/sample-backtest-data';
const botId = '018f3f75-89ab-7def-8123-456789abcdef';
const directories: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chat-flow-')); directories.push(dir);
  const path = join(dir, 'flows.json'); return { path, store: new ChatFlowStore(path) };
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const number = { type: 'upsert_node', node: { id: 'number', type: 'process.number', version: 1, config: { value: 30 } } };
const output = { type: 'upsert_node', node: { id: 'output', type: 'output.number', version: 1, config: {} } };
const edge = { source: 'number', sourcePort: 'value', target: 'output', targetPort: 'value' };
it('saves partial drafts, validates complete graphs, reloads and rejects stale edits', () => {
  const { path, store } = fixture();
  store.edit(botId, { baseVersion: 0, operation: output });
  expect(() => store.validate(botId, 1)).toThrow();
  expect(new ChatFlowStore(path).get(botId)?.status).toBe('building');
  store.edit(botId, { baseVersion: 1, operation: number });
  store.edit(botId, { baseVersion: 2, operation: { type: 'connect', edge } });
  expect(store.validate(botId, 3).status).toBe('valid');
  expect(() => store.edit(botId, { baseVersion: 2, operation: number })).toThrow('Flow changed');
  store.edit(botId, { baseVersion: 4, operation: { type: 'disconnect', edge: { targetPort: 'value', target: 'output', sourcePort: 'value', source: 'number' } } });
  expect(store.get(botId)?.document.edges).toHaveLength(0);
  expect(store.get(botId)?.status).toBe('building');
});
it('publishes every accepted operation and preserves earlier changes on batch failure', () => {
  const { store } = fixture();
  const versions: number[] = [];
  const catalog = createAgentToolCatalog({
    botId, flowStore: store, dex: 'hyperliquid',
    repository: {} as AgentToolDependencies['repository'],
    backtestDatasetCatalog: bundledSampleDatasetCatalog,
    onFlowUpdated: draft => { expect(store.get(botId)?.version).toBe(draft.version); versions.push(draft.version); },
  });
  const result = catalog.execute('edit_flow', { baseVersion: 0, operations: [number, output, { type: 'connect', edge: { ...edge, sourcePort: 'missing' } }] });
  expect(result.ok).toBe(false);
  expect(versions).toEqual([1, 2]);
  expect(store.get(botId)?.document.nodes).toHaveLength(2);
  expect(store.get('028f3f75-89ab-7def-8123-456789abcdef')).toBeUndefined();
  expect(catalog.execute('edit_flow', { baseVersion: 2, operations: [{ type: 'connect', edge }] }).ok).toBe(true);
  expect(catalog.execute('validate_flow', { baseVersion: 3 }).ok).toBe(true);
  expect(versions).toEqual([1, 2, 3, 4]);
});
it('imports a validated sandbox atomically and never replaces an existing flow', () => {
  const { store } = fixture();
  const document = { schemaVersion: '3.0', nodes: [number.node, output.node], edges: [edge] };
  expect(() => store.import(botId, { ...document, edges: [] })).toThrow();
  expect(store.get(botId)).toBeUndefined();
  expect(store.import(botId, document).status).toBe('valid');
  expect(() => store.import(botId, document)).toThrow('already has a flow');
  expect(store.get(botId)?.version).toBe(1);
});

it.each([1, 2])('preserves pinned directional v%s while editing wired drafts', version => {
  const { store } = fixture();
  const ports = version === 1 ? ['fast','slow','rsi','atr'] : ['atr'];
  const nodes = [...ports.map(id => ({ id, type: 'process.number', version: 1, config: { value: 30 } })), { id: 'position', type: 'strategy.directional', version, config: { quotePerOrder: 15 } }];
  let revision = 0;
  for (const node of nodes) revision = store.edit(botId, { baseVersion: revision, operation: { type: 'upsert_node', node } }).version;
  for (const port of ports) revision = store.edit(botId, { baseVersion: revision, operation: { type: 'connect', edge: { source: port, sourcePort: 'value', target: 'position', targetPort: port } } }).version;
  expect(store.edit(botId, { baseVersion: revision, operation: { type: 'upsert_node', node: { ...nodes.at(-1)!, config: { quotePerOrder: 20 } } } }).document.nodes.at(-1)).toMatchObject({ version, config: { quotePerOrder: 20 } });
});
