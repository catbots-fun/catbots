import { expect, it } from 'vitest';
import { parseDraft, configFields, defaultConfig, connectionError } from '../src/renderer/workbench/flow-editor-model';
import type { FlowDocument } from '@catbots/strategy-runtime';

it.each([1,2])('editor preserves directional v%s config and port identity', version => {
  const document: FlowDocument = { schemaVersion: '3.0', nodes: [{ id: 'number', type: 'process.number', version: 1, config: { value: 1 } }, { id: 'position', type: 'strategy.directional', version, config: { quotePerOrder: 20 } }], edges: [] };
  expect(parseDraft(document).nodes[1].version).toBe(version);
  expect(configFields('strategy.directional', version).properties?.rsiThreshold !== undefined).toBe(version === 1);
  expect('rsiThreshold' in defaultConfig('strategy.directional', version)).toBe(version === 1);
  expect(connectionError(document, { source: 'number', sourcePort: 'value', target: 'position', targetPort: 'fast' }) === null).toBe(version === 1);
});
