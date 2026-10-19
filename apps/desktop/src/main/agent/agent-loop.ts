import { runAgentLoopContinue, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import type { Message, TSchema, Model, Api } from '@earendil-works/pi-ai';
import { compatiblePiStream, piTransportModel, assistantMessage } from './pi-provider';
import { AgentToolActivitySchema, type AgentToolActivity, type WorkbenchState } from '@catbots/contracts';

import type { AgentToolCatalog, AgentToolName } from './agent-tools';
import type { CompatibleChatProvider } from '../llm/compatible-chat-provider';
import type { WorkbenchRepository } from '../workbench/workbench-repository';
import { bundledSampleDatasetCatalog } from '../workbench/sample-backtest-data';

export type AgentLoopErrorCode = 'AGENT_ABORTED' | 'AGENT_TOOL_ROUND_LIMIT' | 'AGENT_FAILED';

export class AgentLoopError extends Error {
  constructor(readonly code: AgentLoopErrorCode) {
    super(code === 'AGENT_ABORTED'
      ? 'Agent request was cancelled.'
      : code === 'AGENT_TOOL_ROUND_LIMIT'
        ? 'Agent exceeded the tool round limit.'
        : 'Agent request failed.');
    this.name = 'AgentLoopError';
  }
}

export type RunAgentTurnInput = Readonly<{
  botId: string;
  message: string;
  signal: AbortSignal;
}>;

export type NativeAgentTransport = { model: Model<Api>; stream: StreamFn };

export type RunAgentTurnDependencies = Readonly<{
  provider: CompatibleChatProvider | NativeAgentTransport;
  repository: WorkbenchRepository;
  tools: AgentToolCatalog;
  requestId: string;
  flowDraft?: import('@catbots/contracts').ChatFlowDraft;
  onActivity?: (activity: AgentToolActivity) => void;
}>;

const MAX_TOOL_ROUNDS = 8;
const toolNames = new Set<AgentToolName>([
  'run_flow_backtest', 'get_flow_backtest', 'cancel_flow_backtest',
  'get_flow', 'edit_flow', 'validate_flow', 'list_nodes', 'list_data_products', 'validate_strategy', 'backtest_strategy', 'explain_strategy', 'compare_versions',
]);

export async function runAgentTurn(input: RunAgentTurnInput, dependencies: RunAgentTurnDependencies): Promise<WorkbenchState> {
  if (input.signal.aborted) throw new AgentLoopError('AGENT_ABORTED');
  const initial = { ...dependencies.repository.getState(input.botId), flowDraft: dependencies.flowDraft };
  dependencies.repository.appendChatMessage(input.botId, 'user', input.message);
  // A greeting is not authorization to resume old strategy work. Keep this
  // narrow: mixed messages such as “hi, change RSI to 30” still reach the agent.
  const greeting = greetingResponse(input.message);
  if (greeting !== null) {
    dependencies.repository.appendChatMessage(input.botId, 'assistant', greeting);
    emit(dependencies, input.botId, { phase: 'completed', message: 'Agent response completed.' });
    return dependencies.repository.getState(input.botId);
  }
  const messages: Message[] = [
    ...initial.messages.map(({ role, content }): Message => role === 'user'
      ? { role, content, timestamp: Date.now() }
      : assistantMessage(content)),
    { role: 'user', content: input.message, timestamp: Date.now() },
  ];
  let toolRounds = 0;
  let historicalBacktestUsed = false;
  let completedBacktest = false;
  let failure: AgentLoopError | undefined;
  let response = '';
  const tools: AgentTool[] = dependencies.tools.definitions.filter(({ name }) => toolNames.has(name as AgentToolName)).map((definition) => ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.inputSchema as TSchema,
    execute: async (_id, args) => {
      assertNotAborted(input.signal);
      if (definition.name === 'run_flow_backtest') historicalBacktestUsed = true;
      // A successful backtest is a review boundary, including within one tool batch.
      if (completedBacktest) return { content: [{ type: 'text', text: 'Review the completed backtest before continuing.' }], details: {}, terminate: true };
      const result = dependencies.tools.executeAsync
        ? await dependencies.tools.executeAsync(definition.name, args, input.signal)
        : dependencies.tools.execute(definition.name, args);
      if (definition.name === 'backtest_strategy' && result.ok === true) completedBacktest = true;
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  }));

  try {
    await runAgentLoopContinue({ systemPrompt: systemPrompt(initial), messages, tools }, {
      model: 'stream' in dependencies.provider ? dependencies.provider.model : piTransportModel,
      convertToLlm: (history) => history as Message[],
      toolExecution: 'sequential',
      maxTokens: 4096,
      beforeToolCall: async () => failure || input.signal.aborted
        ? { block: true, reason: 'Agent stopped.', terminate: true }
        : undefined,
      shouldStopAfterTurn: () => completedBacktest || failure !== undefined || input.signal.aborted,
    }, (event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        const delta = event.assistantMessageEvent.delta;
        for (let offset = 0; offset < delta.length; offset += 4096) emit(dependencies, input.botId, { phase: 'text_delta', message: 'Writing response.', delta: delta.slice(offset, offset + 4096) });
      }
      if (event.type === 'turn_start') {
        emit(dependencies, input.botId, { phase: 'thinking', message: 'Thinking…' });
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const message = event.message;
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          failure = new AgentLoopError(message.stopReason === 'aborted' ? 'AGENT_ABORTED' : 'AGENT_FAILED');
        } else if (message.content.some((part) => part.type === 'toolCall')) {
          if (++toolRounds > (historicalBacktestUsed ? 24 : MAX_TOOL_ROUNDS)) failure = new AgentLoopError('AGENT_TOOL_ROUND_LIMIT');
        } else {
          response = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
        }
      }
      if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
        const known = toolNames.has(event.toolName as AgentToolName) ? event.toolName as AgentToolName : undefined;
        const started = event.type === 'tool_execution_start';
        emit(dependencies, input.botId, {
          phase: started ? 'tool_started' : 'tool_completed',
          ...(known === undefined ? {} : { tool: known }),
          message: known === undefined ? 'Unavailable tool rejected.' : `${known} ${started ? 'started' : 'completed'}.`,
        });
      }
    }, input.signal, 'stream' in dependencies.provider ? dependencies.provider.stream : compatiblePiStream(dependencies.provider));
    assertNotAborted(input.signal);
    if (failure) throw failure;
    dependencies.repository.appendChatMessage(input.botId, 'assistant', completedBacktest
      ? 'Backtest completed. Review the performance, trades, warnings, and execution trace before approving this draft.'
      : response);
    emit(dependencies, input.botId, { phase: 'completed', message: 'Agent response completed.' });
    return dependencies.repository.getState(input.botId);
  } catch (error) {
    const normalized = input.signal.aborted ? new AgentLoopError('AGENT_ABORTED')
      : error instanceof AgentLoopError ? error
        : new AgentLoopError('AGENT_FAILED');
    emit(dependencies, input.botId, { phase: 'failed', message: normalized.message });
    throw normalized;
  }
}

function systemPrompt(state: WorkbenchState): string {
  const revision = state.currentRevision === null
    ? 'No strategy revision exists yet.'
    : `Current draft is v${state.currentRevision.version} with nodes: ${state.currentRevision.nodes.map(({ id, title }) => `${id} (${title})`).join(', ')}.`;
  return [
    'You are Catbots, a conversational strategy assistant for a non-coding trader.',
    'Answer the latest user message directly, in the language they use. Previous messages are context, not a request to repeat or continue an earlier task.',
    'For greetings or casual conversation, reply briefly and naturally without calling tools or starting strategy work. For questions, explain what was asked before suggesting next steps.',
    'Create, modify, validate, or backtest a strategy only when the user asks for that work. Ask a concise clarification when their intent or required rules are missing; do not invent them.',
    'Never invent results, prices, performance, or completed changes. Use tool results for factual claims about the saved strategy; use explain_strategy when asked about its current rules.',
    'Use only the provided tools. Never request or reveal credentials, execute code, approve revisions, or enable Paper/Live trading.',
    'For new workflows or requests for flow programming, use get_flow, then edit_flow to build the graph visibly during chat. Add nodes first, then connect typed ports in small meaningful batches. Never wait until your final reply to construct the graph. Finish with validate_flow. This creates a saved, simulation-only flow attached to this bot.',
    'Use only definitions returned by get_flow. Do not fabricate RSI data or silently approximate a missing indicator. For new item workflows use trigger.items → data.candle_items → indicator.rsi_items (or ema_items/sma_items/atr_items), then condition.if_items. Each items wire carries [{json, pairedItem?}]; If forwards the original items on true/false, and an empty branch skips downstream. Use process.edit_fields for literal JSON or safe dotted field mapping, process.split_out, process.aggregate, and process.merge for explicit list operations. action.item_order reads a positive quantityField and only proposes orders. Set quantity deliberately with risk constraints before proposing. All items must keep the execution market. Existing typed workflows remain supported; use explicit process.*_to_items and process.items_to_* adapters when mixing ports. Never silently convert a candle list into one trade per candle. Treat DCA/Grid as independent order controllers, not data feeding a second duplicate order action.',
    'For edits to an existing legacy strategy or explicit legacy backtest requests, retain schema 2.0 and validate_strategy. Do not migrate or replace an existing strategy unless asked. Saved packaged flows can be tested in the Backtest tab using real historical Hyperliquid candles and funding. The legacy backtest_strategy tool is only for schema 2.0 bundled sample data: never use it for a packaged flow. Use run_flow_backtest for packaged flows, get_flow_backtest for status and paginated fills, and cancel_flow_backtest to cancel. Never claim a completed run without completed results. Packaged validation does not enable Paper or Live.',
    'When asked to tune a workflow: inspect get_flow, validate_flow, run a baseline, inspect metrics, warnings, rejected orders and node coverage, then edit_flow and validate_flow before rerunning. Keep the baseline job ID, exact settings and hashes. Include job IDs and versions in your final comparison so later turns can retrieve results. Change a small number of relevant parameters per trial and explain why. At most five runs per message, including baseline and holdout. Stop after the budget and report all tried versions, including regressions; do not silently claim the last draft is the best. Never increase risk or change market/range/cost assumptions just to improve the score. Compare identical settings/data hashes for training comparisons, and reserve a separate chronological holdout when the available history allows. Report overfitting risk and insufficient history honestly. No trades or unavailable nodes are diagnostic findings, not successful optimization. A backtest-only request does not authorize workflow edits.',
    `Current UTC time: ${new Date().toISOString()}. ${state.bot.dex === 'lighter' ? 'Lighter historical data is paginated with a 100000 candle limit per timeframe, including warmup; replay work limits also apply.' : 'Hyperliquid historical data has a recent 5000 candle limit per timeframe including indicator warmup.'} Ask for missing market or risk constraints; state any chosen testing defaults explicitly.`,
    'A legacy 2.0 strategy must follow Trigger → Condition → Action and may combine conditions.',
    'For a named pair in a legacy 2.0 strategy, add a predicate.compare guard with left {"ref":"market.symbol"}, operator "eq", and right {"literal":"ETH-PERP"} (using the named symbol) to every entry and exit Flow for that pair.',
    'For a broad requirement, build a screener from current-market price, funding, volume, rank, or indicator Conditions; explain that it can create positions in multiple markets.',
    'Ordinary “buy” means open/increase a long. Ordinary “sell ETH” means close/reduce an ETH long; opening a short requires explicit short intent.',
    'Validate every complete structural change before describing it as a draft.',
    `Legacy schema 2.0 backtests use Bundled sample data covering only BTC-PERP and ETH-PERP from ${bundledSampleDatasetCatalog.from} through ${bundledSampleDatasetCatalog.to}; never claim broader coverage. They are not investment promises.`,
    `Bot: ${state.bot.name}; DEX: ${state.bot.dex === 'lighter' ? 'Lighter' : 'Hyperliquid'}; market scope: dynamic (dex_universe).`,
    revision,
    state.flowDraft ? `A packaged flow already exists: v${state.flowDraft.version}, ${state.flowDraft.status}. Use get_flow to inspect it and edit_flow for requested changes; do not switch to the legacy strategy. Its market data comes from the simulation snapshot, not a pair selector.` : 'No packaged flow has been saved.',
  ].join('\n');
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentLoopError('AGENT_ABORTED');
}

function emit(
  dependencies: RunAgentTurnDependencies,
  botId: string,
  activity: Omit<AgentToolActivity, 'botId' | 'requestId'>,
): void {
  dependencies.onActivity?.(AgentToolActivitySchema.parse({ botId, requestId: dependencies.requestId, ...activity }));
}

function greetingResponse(message: string): string | null {
  const text = message.normalize('NFKC').trim().replace(/[!！?.。\s]+$/u, '').toLowerCase();
  if (/^(สวัสดี|หวัดดี)(ครับ|ค่ะ|คะ|จ้า|จ้ะ)?$/u.test(text)) return 'สวัสดีครับ มีอะไรให้ช่วยครับ?';
  if (/^(hi|hello|hey|good morning|good afternoon|good evening)$/u.test(text)) return 'Hi! How can I help?';
  return null;
}
