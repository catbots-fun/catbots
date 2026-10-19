import { createFlowBacktestTools, flowBacktestNames, runFlowArguments, getFlowArguments, cancelFlowArguments, type BacktestCommand } from './flow-backtest-tools';
import { z } from 'zod';
import {
  ChatFlowEditSchema,
  BacktestAssumptionsViewSchema,
  BacktestMarketUniverseSchema,
  type DexId,
} from '@catbots/contracts';
import {
  createBuiltinRegistry,
  listRuntimePackages, runtimeNodePackages,
  StrategyV2DocumentSchema,
  validateStrategy,
} from '@catbots/strategy-runtime';

import { parseJsonValue, type AgentToolDefinition, type JsonValue } from '../llm/compatible-chat-provider';
import {
  runBundledSampleBacktest,
  legacyStrategyMarketMigrationRequired,
  type BundledSampleDatasetCatalog,
} from '../workbench/sample-backtest-data';
import type { WorkbenchRepository } from '../workbench/workbench-repository';

const allowedToolNames = [
  ...flowBacktestNames,
  'get_flow', 'edit_flow', 'validate_flow',
  'list_nodes',
  'list_data_products',
  'validate_strategy',
  'backtest_strategy',
  'explain_strategy',
  'compare_versions',
] as const;

export type AgentToolName = typeof allowedToolNames[number];
export type AgentToolResult = Readonly<Record<string, JsonValue>>;

export type AgentToolCatalog = Readonly<{
  definitions: readonly AgentToolDefinition[];
  execute(name: string, argumentsValue: unknown): AgentToolResult;
  executeAsync?(name: string, argumentsValue: unknown, signal: AbortSignal): Promise<AgentToolResult>;
}>;

export type AgentToolDependencies = Readonly<{
  botId: string;
  backtestCommand?: BacktestCommand;
  onFlowBacktestProgress?: (job: import('@catbots/contracts').FlowBacktestJob) => void;
  flowStore?: import('../nodes/chat-flow-store').ChatFlowStore;
  onFlowUpdated?: (draft: import('@catbots/contracts').ChatFlowDraft) => void;
  dex: DexId;
  backtestDatasetCatalog: BundledSampleDatasetCatalog;
  repository: WorkbenchRepository;
  catalog?: import('@catbots/strategy-runtime').CommunityNodeCatalog;
  clock?: () => Date;
  idFactory?: () => string;
  shouldCancel?: () => boolean;
  onBacktestProgress?: (completed: number, total: number) => void;
}>;

const noArguments = z.object({}).strict();
const validateArguments = z.object({ strategy: z.unknown() }).strict();
const backtestArguments = z.object({
  revisionVersion: z.number().int().positive(),
  marketUniverse: BacktestMarketUniverseSchema,
  assumptions: BacktestAssumptionsViewSchema,
}).strict();
const explainArguments = z.object({ revisionVersion: z.number().int().positive() }).strict();
const compareArguments = z.object({
  leftVersion: z.number().int().positive(),
  rightVersion: z.number().int().positive(),
}).strict();

function createDefinitions(registry: import('@catbots/strategy-runtime').NodeRegistry) {
const strategyDocumentJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string', const: '2.0' },
    strategy: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 120 },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        version: { type: 'integer', minimum: 1 },
      },
      required: ['id', 'name', 'version'],
      additionalProperties: false,
    },
    marketScope: {
      type: 'object',
      properties: { type: { type: 'string', const: 'dex_universe' } },
      required: ['type'],
      additionalProperties: false,
    },
    nodes: {
      type: 'array',
      minItems: 1,
      items: {
        oneOf: registry.list().map((node) => ({
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 120 },
            kind: { type: 'string', const: node.kind },
            type: { type: 'string', const: node.type },
            version: { type: 'integer', const: node.version },
            config: jsonSchemaFor(node.configSchema),
          },
          required: ['id', 'kind', 'type', 'version', 'config'],
          additionalProperties: false,
        })),
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 120 },
          source: { type: 'string', minLength: 1, maxLength: 120 },
          sourcePort: { type: 'string', minLength: 1, maxLength: 120 },
          target: { type: 'string', minLength: 1, maxLength: 120 },
          targetPort: { type: 'string', minLength: 1, maxLength: 120 },
        },
        required: ['id', 'source', 'sourcePort', 'target', 'targetPort'],
        additionalProperties: false,
      },
    },
  },
  required: ['schemaVersion', 'strategy', 'marketScope', 'nodes', 'edges'],
  additionalProperties: false,
};

const definitions: readonly AgentToolDefinition[] = [
  ...[
    ['run_flow_backtest', 'Run a saved packaged flow on real historical market data and wait for results. At most five runs per message. Returns pinned version, metrics, warnings, node coverage and first 20 fills. No real orders.', runFlowArguments],
    ['get_flow_backtest', 'Read job status, metrics and paginated fills for this bot. Use returned job ID; inspect warnings and node coverage before tuning.', getFlowArguments],
    ['cancel_flow_backtest', 'Cancel a historical backtest belonging to this bot.', cancelFlowArguments],
  ].map(([name, description, schema]) => ({ name: name as string, description: description as string, inputSchema: jsonSchemaFor(schema as z.ZodType) as Readonly<Record<string, JsonValue>> })),
  definition('get_flow', 'Read this bot’s saved packaged flow and all available typed node definitions. Call before editing.', {}),
  definition('edit_flow', 'Create or edit this bot’s flow incrementally. Each operation is persisted and immediately displayed in chat’s graph. Missing connections are allowed while building. Operations are sequential; successful operations remain saved if a later one fails. Call get_flow after an error.', {
    baseVersion: { type: 'integer', minimum: 0 }, operations: { type: 'array', minItems: 1, maxItems: 32, items: jsonSchemaFor(ChatFlowEditSchema.shape.operation) },
  }, ['baseVersion', 'operations']),
  definition('validate_flow', 'Validate the complete packaged flow and mark it valid for simulation, never for live deployment.', { baseVersion: { type: 'integer', minimum: 1 } }, ['baseVersion']),
  definition('list_nodes', 'List the available trigger, condition, and action nodes.', {}),
  definition('list_data_products', 'List the data products available to this milestone.', {}),
  definition('validate_strategy', 'Validate a complete candidate strategy and save a draft revision only when valid.', {
    strategy: strategyDocumentJsonSchema,
  }, ['strategy']),
  definition('backtest_strategy', 'Run a saved revision against bundled sample data.', {
    revisionVersion: { type: 'integer', minimum: 1 },
    marketUniverse: jsonSchemaFor(BacktestMarketUniverseSchema),
    assumptions: jsonSchemaFor(BacktestAssumptionsViewSchema),
  }, ['revisionVersion', 'marketUniverse', 'assumptions']),
  definition('explain_strategy', 'Explain a saved strategy revision.', {
    revisionVersion: { type: 'integer', minimum: 1 },
  }, ['revisionVersion']),
  definition('compare_versions', 'Compare two saved strategy revisions.', {
    leftVersion: { type: 'integer', minimum: 1 },
    rightVersion: { type: 'integer', minimum: 1 },
  }, ['leftVersion', 'rightVersion']),
];

return definitions;
}

export function createAgentToolCatalog(dependencies: AgentToolDependencies): AgentToolCatalog {
  const registry = dependencies.catalog?.registry ?? createBuiltinRegistry();
  const historical = createFlowBacktestTools(dependencies.botId, dependencies.backtestCommand, dependencies.onFlowBacktestProgress);
  return {
    async executeAsync(name, args, signal) {
      if (flowBacktestNames.includes(name as typeof flowBacktestNames[number])) return await historical(name, args, signal) as unknown as AgentToolResult;
      return this.execute(name, args);
    },
    definitions: createDefinitions(registry),
    execute(name, argumentsValue) {
      if (!allowedToolNames.includes(name as AgentToolName)) return failure('UNKNOWN_TOOL', 'Tool is not available.');
      try {
        if (name === 'get_flow') {
          noArguments.parse(argumentsValue);
          return { ok: true, flow: dependencies.flowStore?.get(dependencies.botId) ?? null,
            definitions: runtimeNodePackages.flatMap(pkg => pkg.definitions.map(def => ({ type: def.type, version: def.version, category: def.category, title: def.title, configSchema: jsonSchemaFor(def.config), inputs: def.inputs, outputs: def.outputs, activation: def.activation ?? null }))),
            notice: 'Validation is for simulation, not deployment approval. Selected workflows support user-controlled Testnet execution only after Deploy readiness checks; never infer Paper/Mainnet support. Solid Flow ports control activation. Data ports carry typed snapshot values. Preserve existing nodes and pinned versions when editing.' } as unknown as AgentToolResult;
        }
        if (name === 'edit_flow' || name === 'validate_flow') {
          if (!dependencies.flowStore) return failure('FLOW_STORE_UNAVAILABLE', 'Flow storage unavailable.');
          try {
            let draft;
            if (name === 'edit_flow') {
              const input = z.object({ baseVersion: z.number().int().nonnegative(), operations: z.array(ChatFlowEditSchema.shape.operation).min(1).max(32) }).strict().parse(argumentsValue);
              let version = input.baseVersion;
              for (const operation of input.operations) {
                if (dependencies.shouldCancel?.()) throw new Error('Flow edit cancelled');
                draft = dependencies.flowStore.edit(dependencies.botId, { baseVersion: version, operation });
                version = draft.version; dependencies.onFlowUpdated?.(draft);
              }
            } else {
              const input = z.object({ baseVersion: z.number().int().positive() }).strict().parse(argumentsValue);
              draft = dependencies.flowStore.validate(dependencies.botId, input.baseVersion); dependencies.onFlowUpdated?.(draft);
            }
            return { ok: true, flow: draft } as unknown as AgentToolResult;
          } catch (error) { return { ok: false, error: { code: 'FLOW_EDIT_FAILED', message: error instanceof Error ? error.message.slice(0, 400) : 'Flow edit failed. Call get_flow.' } }; }
        }
        if (name === 'list_nodes') {
          noArguments.parse(argumentsValue);
          return { ok: true, simulationPackages: listRuntimePackages(), simulationNotice: 'Runtime v3 packages are for packaged flows via get_flow/edit_flow. Graph validation does not approve deployment; selected workflows require separate Deploy readiness checks. The nodes array below is the legacy schema used by validate_strategy, not the packaged-flow catalog.', nodes: registry.list().map((node) => ({
            kind: node.kind,
            type: node.type,
            version: node.version,
            title: node.visualization.title,
            summary: node.visualization.summary({}),
            configSchema: jsonSchemaFor(node.configSchema),
            inputs: node.inputs.map(({ id, dataType, cardinality }) => ({ id, dataType, cardinality })),
            outputs: node.outputs.map(({ id, dataType, cardinality }) => ({ id, dataType, cardinality })),
          })) } as AgentToolResult;
        }
        if (name === 'list_data_products') {
          noArguments.parse(argumentsValue);
          return { ok: true, products: [
            { id: 'market.symbol', label: 'Current market symbol', source: 'Runtime-bound market context', valueType: 'string' },
            { id: 'market.price', label: 'Market price', source: 'Bundled sample data', fields: { mark: 'number', bid: 'number', ask: 'number' } },
            { id: 'market.funding', label: 'Perpetual funding rate', source: 'Bundled sample data', fields: { rate: 'number' } },
            { id: 'market.volume', label: '24-hour notional volume', source: 'Bundled sample data', fields: { notional24h: 'number' } },
            { id: 'market.rank', label: 'Market volume rank', source: 'Bundled sample data', fields: { value: 'number' } },
            { id: 'indicator.rsi.14', label: 'RSI 14', source: 'Bundled sample data', fields: { value: 'number' } },
            { id: 'data.etf_flow.btc.net_daily', label: 'BTC ETF net daily flow', source: 'Bundled sample data', fields: { usd: 'number' } },
          ], dataset: {
            dex: dependencies.backtestDatasetCatalog.dex,
            markets: [...dependencies.backtestDatasetCatalog.markets],
            from: dependencies.backtestDatasetCatalog.from,
            to: dependencies.backtestDatasetCatalog.to,
            limitations: dependencies.backtestDatasetCatalog.limitations,
          } } as AgentToolResult;
        }
        if (name === 'validate_strategy') {
          const input = validateArguments.parse(argumentsValue);
          let document;
          try {
            document = dependencies.catalog ? dependencies.catalog.compile(input.strategy) : StrategyV2DocumentSchema.parse(input.strategy);
          } catch (error) {
            if (error instanceof z.ZodError) {
              return {
                ok: false,
                error: {
                  code: 'INVALID_STRATEGY',
                  message: 'Strategy document is malformed.',
                  issues: error.issues.map((issue) => ({
                    code: issue.code,
                    path: issue.path.length === 0 ? 'strategy' : issue.path.join('.'),
                    message: 'Invalid or missing strategy field.',
                  })),
                },
              } as AgentToolResult;
            }
            return failure('INVALID_STRATEGY', 'Strategy document is malformed.');
          }
          const result = validateStrategy(document, createBuiltinRegistry());
          if (!result.valid) {
            return { ok: false, error: { code: 'INVALID_STRATEGY', message: 'Strategy graph is invalid.', issues: result.errors.map(({ code, nodeId, edgeId }) => ({ code, nodeId: nodeId ?? null, edgeId: edgeId ?? null })) } } as AgentToolResult;
          }
          return { ok: true, revision: dependencies.repository.createValidatedRevision(dependencies.botId, document) } as unknown as AgentToolResult;
        }
        if (name === 'backtest_strategy') {
          if (dependencies.flowStore?.get(dependencies.botId)) return failure('USE_HISTORICAL_FLOW_BACKTEST', 'This bot has a packaged flow. Use its Backtest tab for real historical replay; bundled legacy sample results do not apply.');
          const input = backtestArguments.parse(argumentsValue);
          const document = dependencies.repository.getStrategyDocument(dependencies.botId, input.revisionVersion);
          const result = runBundledSampleBacktest(
            dependencies.botId,
            input.revisionVersion,
            document,
            dependencies.dex,
            input.marketUniverse,
            input.assumptions,
            {
              clock: dependencies.clock,
              idFactory: dependencies.idFactory,
              shouldCancel: dependencies.shouldCancel,
              onProgress: dependencies.onBacktestProgress,
              trustedLegacyMarketBinding: document.schemaVersion === '1.0'
                ? dependencies.repository.getStoredIdentity(dependencies.botId).legacyMarketHint
                : null,
            },
          );
          dependencies.repository.createBacktestRun(result.summary, result.artifact);
          return { ok: true, backtest: result.summary } as unknown as AgentToolResult;
        }
        if (name === 'explain_strategy') {
          const input = explainArguments.parse(argumentsValue);
          const document = dependencies.repository.getStrategyDocument(dependencies.botId, input.revisionVersion);
          const labels = document.nodes.map((node) => registry.get(node.kind, node.type, node.version).visualization.title);
          return { ok: true, explanation: `${document.strategy.name}: ${labels.join(' → ')}` };
        }
        const input = compareArguments.parse(argumentsValue);
        const left = dependencies.repository.getStrategyDocument(dependencies.botId, input.leftVersion);
        const right = dependencies.repository.getStrategyDocument(dependencies.botId, input.rightVersion);
        const leftIds = new Set(left.nodes.map(({ id }) => id));
        const rightIds = new Set(right.nodes.map(({ id }) => id));
        const added = [...rightIds].filter((id) => !leftIds.has(id));
        const removed = [...leftIds].filter((id) => !rightIds.has(id));
        return {
          ok: true,
          comparison: `${left.strategy.name} → ${right.strategy.name}; added: ${added.join(', ') || 'none'}; removed: ${removed.join(', ') || 'none'}`,
        };
      } catch (error) {
        if (error instanceof z.ZodError) {
          return {
            ok: false,
            error: {
              code: 'INVALID_TOOL_ARGUMENTS',
              message: 'Tool arguments are invalid.',
              issues: error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.length === 0 ? 'arguments' : issue.path.join('.'),
                message: 'Invalid or missing tool argument.',
              })),
            },
          } as AgentToolResult;
        }
        if (error instanceof Error && error.message === legacyStrategyMarketMigrationRequired) {
          return failure(
            legacyStrategyMarketMigrationRequired,
            'Legacy strategy market binding is unavailable; create and approve a Strategy 2.0 revision before backtesting.',
          );
        }
        return failure('INVALID_TOOL_ARGUMENTS', 'Tool arguments are invalid.');
      }
    },
  };
}

function definition(name: AgentToolName, description: string, properties: Record<string, JsonValue>, required: string[] = []): AgentToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  };
}

function failure(code: string, message: string): AgentToolResult {
  return { ok: false, error: { code, message } };
}

function jsonSchemaFor(schema: z.ZodType): JsonValue {
  const { $schema: _schemaDialect, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
  return parseJsonValue(jsonSchema);
}
