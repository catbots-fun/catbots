import { z } from 'zod';
import { createAllCategoryExample, runtimeNodePackages, type FlowDocument, type FlowEdge } from '@catbots/strategy-runtime/node-examples';
export const editorDefinitions = new Map(runtimeNodePackages.flatMap(pkg => pkg.definitions.map(def => [def.type, { ...def, packageName: pkg.name }] as const)));
export function starterFlow(): FlowDocument {
  const doc = createAllCategoryExample();
  doc.nodes = doc.nodes.filter(node => node.id !== 'strategy');
  doc.edges = doc.edges.filter(edge => edge.target !== 'strategy' && edge.target !== 'order');
  doc.nodes.find(node => node.id === 'order')!.type = 'action.flow_order';
  doc.nodes.push({ id: 'branch', type: 'condition.branch', version: 1, config: {} });
  doc.edges.push(
    { source: 'tick', sourcePort: 'flow', target: 'branch', targetPort: 'flow' },
    { source: 'entry', sourcePort: 'result', target: 'branch', targetPort: 'condition' },
    { source: 'branch', sourcePort: 'true', target: 'order', targetPort: 'flow' },
    { source: 'size', sourcePort: 'quantity', target: 'order', targetPort: 'quantity' },
  );
  return doc;
}
export function connectionError(doc: FlowDocument, edge: FlowEdge): string | null {
  const source = doc.nodes.find(node => node.id === edge.source);
  const target = doc.nodes.find(node => node.id === edge.target);
  const from = source && editorDefinitions.get(source.type)?.outputs[edge.sourcePort];
  const to = target && editorDefinitions.get(target.type)?.inputs[edge.targetPort];
  if (!from || !to || from !== to) return 'Connect matching port types. Flow and Data cannot be mixed.';
  if (doc.edges.some(item => item.target === edge.target && item.targetPort === edge.targetPort)) return 'This input already has a connection. Remove it first.';
  const reachable = new Set([edge.target]);
  for (let index = 0; index < doc.nodes.length; index++) for (const item of doc.edges) if (reachable.has(item.source)) reachable.add(item.target);
  if (reachable.has(edge.source)) return 'This connection creates a cycle. Use a stateful strategy node instead.';
  return null;
}
const draftSchema = z.object({ schemaVersion: z.literal('3.0'), nodes: z.array(z.object({ id: z.string().min(1), type: z.string(), version: z.number().int(), config: z.record(z.string(), z.unknown()) })).max(200), edges: z.array(z.object({ source: z.string(), target: z.string(), sourcePort: z.string(), targetPort: z.string() })).max(1000) });
export function parseDraft(value: unknown): FlowDocument {
  const doc = draftSchema.parse(value);
  if (new Set(doc.nodes.map(node => node.id)).size !== doc.nodes.length || doc.nodes.some(node => editorDefinitions.get(node.type)?.version !== node.version)) throw new Error('Unknown or duplicate node');
  const checked = { ...doc, edges: [] as FlowEdge[] };
  for (const edge of doc.edges) { const issue = connectionError(checked, edge); if (issue) throw new Error(issue); checked.edges.push(edge); }
  return doc;
}
export function configFields(type: string) {
  return z.toJSONSchema(editorDefinitions.get(type)!.config) as { properties?: Record<string, { type?: string; enum?: string[]; default?: unknown; minimum?: number; maximum?: number }> };
}
export function defaultConfig(type: string): Record<string, unknown> {
  const presets: Record<string, Record<string, unknown>> = {
    'process.edit_fields': { field: 'signal', valueJson: 'true' }, 'process.split_out': { field: 'value' }, 'condition.if_items': { field: 'value', operator: 'lt', valueJson: '30' },
    'data.candle_items': { timeframe: '5m' }, 'action.item_order': { quantityField: 'quantity', side: 'buy', reduceOnly: false }, 'data.candles': { timeframe: '5m' }, 'process.number': { value: 30 }, 'process.math': { operator: 'add' },
    'condition.compare': { operator: 'lt' }, 'condition.combine': { operator: 'all' },
    'risk.position_size': { riskPercent: 1, maxNotional: 100 },
    'risk.trailing_exit': { side: 'long', activationPercent: 2, callbackPercent: 1 },
    'action.order': { side: 'buy', reduceOnly: false }, 'action.flow_order': { side: 'buy', reduceOnly: false },
    'strategy.directional': { quotePerOrder: 15 },
    'strategy.mean_reversion': { quotePerOrder: 15 },
    'strategy.dca': { quotePerOrder: 100, takeProfitPercent: 2, stopLossPercent: 10, maxNotional: 500, extraStepPercent: 5, maxExtraOrders: 2 },
    'strategy.grid': { quotePerOrder: 100, takeProfitPercent: 2, stopLossPercent: 10, maxNotional: 500, levels: 3, stepPercent: 5 },
    'strategy.smart_order': { quantity: 2, sliceQuantity: 1, maxNotional: 500 },
  };
  return editorDefinitions.get(type)!.config.parse(presets[type] ?? (type.startsWith('indicator.') ? { period: 14 } : {})) as Record<string, unknown>;
}

/** Native item flow: closed market data stays on the same item all the way to a proposal. */
export function itemFlowExample(prefix = 'items'): FlowDocument {
  const nodes = [
    { id: 'start', type: 'trigger.items', config: {} },
    { id: 'candles', type: 'data.candle_items', config: { timeframe: '5m', count: 200 } },
    { id: 'rsi', type: 'indicator.rsi_items', config: { period: 14 } },
    { id: 'if', type: 'condition.if_items', config: { field: 'rsi', operator: 'lt', valueJson: '30' } },
    { id: 'quantity', type: 'process.edit_fields', config: { field: 'quantity', valueJson: '0.001' } },
    { id: 'order', type: 'action.item_order', config: { side: 'buy', quantityField: 'quantity' } },
  ].map(node => ({ ...node, id: `${prefix}-${node.id}`, version: 1 }));
  return { schemaVersion: '3.0', nodes, edges: nodes.slice(1).map((node, index) => ({ source: nodes[index].id, target: node.id, sourcePort: index === 3 ? 'true' : 'main', targetPort: 'main' })) };
}
