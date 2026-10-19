import { expect, it } from 'vitest';
import { connectionError, defaultConfig, editorDefinitions, parseDraft, starterFlow, itemFlowExample } from '../src/renderer/workbench/flow-editor-model';
import { evaluatePackagedFlow, exampleContext } from '@catbots/strategy-runtime/node-examples';
it('starter uses explicit flow activation and emits only one proposal', () => {
  const draft = starterFlow();
  expect(parseDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
  const result = evaluatePackagedFlow(draft, exampleContext('editor', 0, 100));
  expect(result.orders).toHaveLength(1);
  expect(result.trace.find(node => node.nodeId === 'branch')?.outputs.true.value).toBe(true);
});
it('rejects type mismatch, duplicate input and cycles before connecting', () => {
  const draft = starterFlow();
  expect(connectionError(draft, { source: 'tick', sourcePort: 'flow', target: 'entry', targetPort: 'left' })).toMatch(/matching/);
  expect(connectionError(draft, { source: 'threshold', sourcePort: 'value', target: 'entry', targetPort: 'right' })).toMatch(/already/);
  draft.nodes.push({ id: 'echo', type: 'output.number', version: 1, config: {} });
  expect(connectionError(draft, { source: 'echo', sourcePort: 'value', target: 'echo', targetPort: 'value' })).toMatch(/cycle/);
});
it('every palette entry starts with valid config', () => {
  for (const definition of editorDefinitions.values()) expect(definition.config.safeParse(defaultConfig(definition.type, definition.version)).success, definition.type).toBe(true);
});

it('item example validates and preserves typed drafts without migration', () => {
  const draft = itemFlowExample();
  expect(parseDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
  const result = evaluatePackagedFlow(draft, exampleContext('items-editor', 0, 100));
  expect(result.trace).toHaveLength(6);
  expect(result.trace[0].outputs.main.type).toBe('items');
  expect(starterFlow().schemaVersion).toBe('3.0');
});
