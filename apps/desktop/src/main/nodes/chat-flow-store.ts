import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ChatFlowDocumentSchema, ChatFlowDraftSchema, ChatFlowEditSchema, type ChatFlowDraft } from '@catbots/contracts';
import { prepareFlow } from '@catbots/strategy-runtime';
import { runtimeNodePackages } from '@catbots/strategy-runtime';
const definitions = new Map(runtimeNodePackages.flatMap(pkg => pkg.definitions.map(def => [`${def.type}@${def.version}`, def] as const)));
const definition = (node: { type: string; version: number } | undefined) => node ? definitions.get(`${node.type}@${node.version}`) : undefined;
export class ChatFlowStore {
  constructor(private readonly path: string) {}
  private read(): Record<string, ChatFlowDraft> {
    if (!existsSync(this.path)) return {};
    const text = readFileSync(this.path, 'utf8');
    if (text.length > 20_000_000) throw new Error('Flow storage limit reached');
    return z.record(z.string().uuid(), ChatFlowDraftSchema).parse(JSON.parse(text));
  }
  get(botId: string) { return this.read()[botId]; }
  edit(botId: string, input: unknown) {
    const { baseVersion, operation } = ChatFlowEditSchema.parse(input);
    const all = this.read();
    const previous = all[botId];
    if ((previous?.version ?? 0) !== baseVersion) throw new Error('Flow changed. Call get_flow and retry with its version.');
    const doc = structuredClone(previous?.document ?? { schemaVersion: '3.0' as const, nodes: [], edges: [] });
    if (operation.type === 'upsert_node') {
      const def = definition(operation.node);
      if (!def || def.version !== operation.node.version) throw new Error('Unknown node definition');
      const node = { ...operation.node, config: def.config.parse(operation.node.config) as Record<string, unknown> };
      const index = doc.nodes.findIndex(item => item.id === node.id);
      if (index < 0) doc.nodes.push(node); else doc.nodes[index] = node;
    } else if (operation.type === 'remove_node') {
      doc.nodes = doc.nodes.filter(node => node.id !== operation.nodeId);
      doc.edges = doc.edges.filter(edge => edge.source !== operation.nodeId && edge.target !== operation.nodeId);
    } else if (operation.type === 'connect') doc.edges.push(operation.edge);
    else doc.edges = doc.edges.filter(edge => !(edge.source === operation.edge.source && edge.sourcePort === operation.edge.sourcePort && edge.target === operation.edge.target && edge.targetPort === operation.edge.targetPort));
    // Partial drafts may have unconnected inputs; existing connections must always be valid.
    const inputs = new Set<string>();
    for (const edge of doc.edges) {
      const from = definition(doc.nodes.find(node => node.id === edge.source))?.outputs[edge.sourcePort];
      const to = definition(doc.nodes.find(node => node.id === edge.target))?.inputs[edge.targetPort];
      if (!from || from !== to) throw new Error('Incompatible or missing ports');
      const key = JSON.stringify([edge.target, edge.targetPort]);
      if (inputs.has(key)) throw new Error('Input already connected'); inputs.add(key);
    }
    const visited = new Set<string>(), visiting = new Set<string>();
    const visit = (id: string) => { if (visiting.has(id)) throw new Error('Flow cannot contain cycles'); if (visited.has(id)) return; visiting.add(id); for (const edge of doc.edges.filter(edge => edge.source === id)) visit(edge.target); visiting.delete(id); visited.add(id); };
    doc.nodes.forEach(node => visit(node.id));
    return this.write(all, { botId, version: baseVersion + 1, status: 'building', document: doc, updatedAt: new Date().toISOString() });
  }
  import(botId: string, input: unknown) {
    const all = this.read();
    if (all[botId]) throw new Error('This bot already has a flow. Import into a new bot.');
    const document = ChatFlowDocumentSchema.parse(input);
    if (!document.nodes.length) throw new Error('Add nodes before importing');
    prepareFlow(document, runtimeNodePackages);
    return this.write(all, { botId, version: 1, status: 'valid', document, updatedAt: new Date().toISOString() });
  }
  validate(botId: string, baseVersion: number) {
    const all = this.read(); const draft = all[botId];
    if (!draft || draft.version !== baseVersion) throw new Error('Flow changed. Call get_flow.');
    if (!draft.document.nodes.length) throw new Error('Add nodes before validating');
    prepareFlow(draft.document, runtimeNodePackages);
    return this.write(all, { ...draft, status: 'valid', version: draft.version + 1, updatedAt: new Date().toISOString() });
  }
  private write(all: Record<string, ChatFlowDraft>, input: ChatFlowDraft) {
    const draft = ChatFlowDraftSchema.parse(input); all[draft.botId] = draft;
    const text = JSON.stringify(all); if (text.length > 20_000_000) throw new Error('Flow storage limit reached');
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, text, { mode: 0o600 }); renameSync(`${this.path}.tmp`, this.path);
    return draft;
  }
}
