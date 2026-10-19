import { FlowBacktestCommandSchema, type FlowBacktestJob } from './flow-backtest';
import { z } from 'zod';
import { MarketSnapshotRequestSchema, type MarketSnapshot } from './market-snapshot';
import { ChatFlowDocumentSchema, ChatFlowEditSchema, type ChatFlowDraft } from './chat-flow';
const id = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const nodeType = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/).max(100);
const json: z.ZodType<null | boolean | number | string | unknown[] | Record<string, unknown>> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(10000), z.array(json).max(100), z.record(z.string().max(100), json)]));
export const NodeFieldSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('number'), label: z.string().min(1).max(100), default: z.number().finite(), minimum: z.number().finite().optional(), maximum: z.number().finite().optional() }).strict(),
  z.object({ type: z.literal('string'), label: z.string().min(1).max(100), default: z.string().max(500) }).strict(),
  z.object({ type: z.literal('boolean'), label: z.string().min(1).max(100), default: z.boolean() }).strict(),
]);
export const CommunityNodeSchema = z.object({
  type: nodeType, version: z.number().int().min(1), kind: z.enum(['trigger', 'condition', 'action']),
  title: z.string().min(1).max(100), description: z.string().min(1).max(1000),
  fields: z.record(id, NodeFieldSchema).refine((fields) => Object.keys(fields).length <= 20),
  nodes: z.array(z.object({ id, kind: z.enum(['trigger', 'condition', 'action']), type: nodeType, version: z.number().int().min(1), config: z.record(z.string(), json) }).strict()).min(1).max(32),
  edges: z.array(z.object({ id, source: id, sourcePort: id, target: id, targetPort: id }).strict()).max(100),
  inputs: z.array(z.object({ id, dataType: z.enum(['activation', 'condition']), targets: z.array(z.object({ node: id, port: id }).strict()).min(1).max(32) }).strict()).max(8),
  outputs: z.array(z.object({ id, dataType: z.enum(['activation', 'condition']), source: z.object({ node: id, port: id }).strict() }).strict()).max(8),
}).strict();
export const NodePackageSchema = z.object({
  format: z.literal('catbots-subflow'), sdkVersion: z.literal(1),
  name: z.string().regex(/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/).max(120),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).max(40), license: z.string().min(1).max(80),
  nodes: z.array(CommunityNodeSchema).min(1).max(16),
}).strict();
export type NodePackage = z.infer<typeof NodePackageSchema>;
export type CommunityNode = z.infer<typeof CommunityNodeSchema>;
export type InstalledNodePackage = { manifest: NodePackage; integrity: string; enabled: boolean };
export const NodePackageCommandSchema = z.discriminatedUnion('action', [
  MarketSnapshotRequestSchema,
  z.object({ action: z.literal('market_catalog'), dex: z.enum(['hyperliquid','lighter']).optional(), environment: z.enum(['production','testnet']).optional() }).strict(),
  z.object({ action: z.literal('get_workspace_market'), botId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('save_workspace_market'), botId: z.string().uuid(), market: z.string().regex(/^[A-Z0-9]{1,20}-PERP$/) }).strict(),
  ...FlowBacktestCommandSchema.options,
  z.object({ action: z.literal('validate_flow'), botId: z.string().uuid(), baseVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('import_flow'), botId: z.string().uuid(), document: ChatFlowDocumentSchema }).strict(),
  z.object({ action: z.literal('edit_flow'), botId: z.string().uuid(), edit: ChatFlowEditSchema }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('simulate'), example: z.enum(['dca','grid','smart_order']) }).strict(),
  z.object({ action: z.literal('install'), source: z.string().min(1).max(200000) }).strict(),
  z.object({ action: z.literal('enable'), integrity: z.string().regex(/^sha256:[a-f0-9]{64}$/), enabled: z.boolean() }).strict(),
]);
export type NodePackageCommand = z.infer<typeof NodePackageCommandSchema>;
export type RuntimeNodePackageView = { name: string; version: string; mode: 'simulation'; nodes: { type: string; version: number; category: string; role?: 'trigger' | 'action'; title: string; inputs: Record<string,string>; outputs: Record<string,string> }[] };
export type NodePackageStatus = { workspaceMarket?: string; markets?: string[]; backtest?: FlowBacktestJob; marketSnapshot?: MarketSnapshot; flowDraft?: ChatFlowDraft; packages: InstalledNodePackage[]; runtimePackages?: RuntimeNodePackageView[]; simulation?: { example: string; runId: string; steps: { price: number; proposed: number; cancellations: number; state: unknown; outputs: Record<string, unknown> }[] } };
