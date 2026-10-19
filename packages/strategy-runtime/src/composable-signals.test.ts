import { expect, it } from 'vitest';
import { ready, unavailable, type FlowContext } from '@catbots/node-kit';
import { strategyPackage } from '@catbots/nodes-strategy';
import { conditionPackage } from '@catbots/nodes-condition';
import { evaluatePackagedFlow, type FlowDocument } from './node-packages';

const context = (at = 0): FlowContext => ({ runId: String(at), deploymentId: 'test', market: 'ETH-PERP', at, price: 100, equity: 1000, candles: {}, fills: [], cancelledOrderIds: [] });
const signals = (long: boolean, short: boolean) => ({ long: ready('condition', long), short: ready('condition', short), atr: ready('number', 1) });
function controller() {
  const node = strategyPackage.definitions.find(node => node.type === 'strategy.directional' && node.version === 2);
  expect(node, 'composable signal controller must be registered').toBeDefined();
  return node!;
}
const config = () => controller().config.parse({ quotePerOrder: 100, minAtrPercent: 0, cooldownMinutes: 0, stopAtr: 2, rewardRisk: 2 }) as Record<string, unknown>;

it('keeps a rearmed signal pending until the confirmed-close cooldown expires', () => {
  const node = controller(), settings = { ...config(), cooldownMinutes: 5 };
  const entry = node.evaluate(signals(true, false), settings, context(), undefined, 'position');
  const exit = node.evaluate({}, settings, { ...context(60000), price: 90, fills: [{ id: 'entry', clientOrderId: entry.orders![0].clientOrderId, side: 'buy', quantity: 1, price: 100, fee: 0 }] }, entry.state, 'position');
  const flat = node.evaluate(signals(false, false), settings, { ...context(120000), fills: [{ id: 'close', clientOrderId: exit.orders![0].clientOrderId, side: 'sell', quantity: 1, price: 90, fee: 0 }] }, exit.state, 'position');
  const waiting = node.evaluate(signals(false, true), settings, context(180000), flat.state, 'position');
  expect(waiting.orders).toEqual([]);
  expect(node.evaluate(signals(false, true), settings, context(420000), waiting.state, 'position').orders).toEqual([expect.objectContaining({ side: 'sell', reduceOnly: false })]);
});

it('executes a compiled nested AND/OR/NOT graph into the signal controller', () => {
  const document: FlowDocument = { schemaVersion: '3.0', nodes: [
    { id: 'one', type: 'process.number', version: 1, config: { value: 1 } },
    { id: 'yes', type: 'condition.compare', version: 1, config: { operator: 'eq' } },
    { id: 'no', type: 'condition.not', version: 1, config: {} },
    { id: 'or', type: 'condition.combine', version: 1, config: { operator: 'any' } },
    { id: 'and', type: 'condition.combine', version: 1, config: { operator: 'all' } },
    { id: 'position', type: 'strategy.directional', version: 2, config: config() },
  ], edges: [
    ['one', 'value', 'yes', 'left'], ['one', 'value', 'yes', 'right'],
    ['yes', 'result', 'no', 'condition'], ['yes', 'result', 'or', 'left'], ['no', 'result', 'or', 'right'],
    ['or', 'result', 'and', 'left'], ['yes', 'result', 'and', 'right'],
    ['and', 'result', 'position', 'long'], ['no', 'result', 'position', 'short'], ['one', 'value', 'position', 'atr'],
  ].map(([source, sourcePort, target, targetPort]) => ({ source, sourcePort, target, targetPort })) };
  expect(evaluatePackagedFlow(document, context()).orders).toEqual([expect.objectContaining({ side: 'buy', quantity: 1 })]);
});

it.each([[true, false, 'buy'], [false, true, 'sell']] as const)('uses explicit long=%s short=%s without hardcoded indicator signals', (long, short, side) => {
  expect(controller().evaluate(signals(long, short), config(), context(), undefined, 'position').orders).toEqual([expect.objectContaining({ side, quantity: 1, reduceOnly: false })]);
});
it('does not enter on conflicting, missing or unavailable conditions', () => {
  for (const input of [signals(true, true), signals(false, false), {}, { ...signals(true, false), short: unavailable('condition', 'warming up') }]) {
    expect(controller().evaluate(input, config(), context(), undefined, 'position').orders).toEqual([]);
  }
});
it('persists single-fire behavior through cancellation and serialized restart until both signals reset', () => {
  const node = controller(), settings = config();
  const first = node.evaluate(signals(true, false), settings, context(), undefined, 'position');
  const cancelled = node.evaluate(signals(true, false), settings, { ...context(60000), cancelledOrderIds: [first.orders![0].clientOrderId] }, JSON.parse(JSON.stringify(first.state)), 'position');
  expect(cancelled.orders).toEqual([]);
  const conflict = node.evaluate(signals(true, true), settings, context(120000), cancelled.state, 'position');
  expect(node.evaluate(signals(false, true), settings, context(180000), conflict.state, 'position').orders).toEqual([]);
  const reset = node.evaluate(signals(false, false), settings, context(240000), conflict.state, 'position');
  expect(node.evaluate(signals(false, true), settings, context(300000), reset.state, 'position').orders).toEqual([expect.objectContaining({ side: 'sell' })]);
});
it('risk ticks neither open nor rearm but still close confirmed partial inventory with signals unavailable', () => {
  const node = controller(), settings = config();
  expect(node.evaluate(signals(true, false), settings, { ...context(), evaluationMode: 'risk' }, undefined, 'position').orders).toEqual([]);
  const first = node.evaluate(signals(true, false), settings, context(), undefined, 'position');
  const order = first.orders![0];
  const exit = node.evaluate({}, settings, { ...context(60000), evaluationMode: 'risk', price: 90, fills: [{ id: 'partial', clientOrderId: order.clientOrderId, side: 'buy', quantity: 0.4, price: 100, fee: 0 }], cancelledOrderIds: [order.clientOrderId] }, first.state, 'position');
  expect(exit.orders).toEqual([expect.objectContaining({ side: 'sell', quantity: 0.4, reduceOnly: true })]);
  const flat = node.evaluate(signals(false, false), settings, { ...context(120000), evaluationMode: 'risk', fills: [{ id: 'close', clientOrderId: exit.orders![0].clientOrderId, side: 'sell', quantity: 0.4, price: 90, fee: 0 }] }, exit.state, 'position');
  expect(node.evaluate(signals(true, false), settings, context(180000), flat.state, 'position').orders).toEqual([]);
});
it('NOT preserves missing data rather than enabling a trade', () => {
  const node = conditionPackage.definitions.find(node => node.type === 'condition.not');
  expect(node).toBeDefined();
  for (const value of [true, false]) expect(node!.evaluate({ condition: ready('condition', value) }, {}, context(), undefined, 'not').outputs.result.value).toBe(!value);
  expect(node!.evaluate({ condition: unavailable('condition', 'stale') }, {}, context(), undefined, 'not').outputs.result.quality).toBe('unavailable');
});
