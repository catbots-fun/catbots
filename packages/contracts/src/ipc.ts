import type { BotSummary, CreateDraftBotInput } from './bots';
import type { LocalSettingsPatch, RedactedLocalConfig } from './config';
import type {
  Deployment,
  GetActiveDeploymentInput,
  GetDeploymentInput,
  LivePreflightView,
  PaperDeploymentView,
  PauseDeploymentInput,
  PrepareLiveInput,
  StartLiveInput,
  StartPaperInput,
  StopDeploymentInput,
} from './execution';
import type {
  AgentToolActivity,
  ApproveStrategyRevisionInput,
  BacktestSummary,
  GetTraceInput,
  GetWorkbenchInput,
  RunWorkbenchBacktestInput,
  SendWorkbenchMessageInput,
  StopWorkbenchAgentInput,
  StrategyRevision,
  TraceDetail,
  WorkbenchState,
} from './workbench';
import { z } from 'zod';

export const RuntimeStatusSchema = z.object({
  state: z.enum(['starting', 'ready', 'stopping', 'stopped', 'error']),
  activeBots: z.number().int().nonnegative(),
}).strict();

export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

export const DatabaseStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready') }).strict(),
  z.object({ status: z.literal('repair'), code: z.literal('DATABASE_MIGRATION_FAILED') }).strict(),
]);

export type DatabaseState = z.infer<typeof DatabaseStateSchema>;

export type BootstrapState =
  | { state: 'first-launch' }
  | { state: 'ready'; config: RedactedLocalConfig }
  | { state: 'repair'; issues: Array<{ path: string; message: string }> };

export type ConnectionTestResult =
  | { ok: true; model: string }
  | { ok: false; code: string; message: string };

export const ProductCapabilitiesSchema = z.object({
  release: z.enum(['strategy-lab-beta', 'testnet-alpha']),
  strategyResearch: z.boolean(),
  paperExecution: z.boolean(),
  liveExecution: z.boolean(),
  testnetExecution: z.boolean().optional(),
  exchangeConnections: z.boolean(),
}).strict();

export type ProductCapabilities = z.infer<typeof ProductCapabilitiesSchema>;

export interface CatbotsDesktopApi {
  connections?: { command(input: import('./connections').ConnectionCommand): Promise<import('./connections').ConnectionsView> };
  nodes?: { command(input: import('./node-packages').NodePackageCommand): Promise<import('./node-packages').NodePackageStatus> };
  providers?: { command(input: import('./providers').ProviderCommand): Promise<import('./providers').ProviderStatus> };
  app: {
    getVersion(): Promise<string>;
    getCapabilities(): Promise<ProductCapabilities>;
    showMainWindow(): Promise<void>;
    quitApplication(): Promise<void>;
  };
  config: {
    getBootstrapState(): Promise<BootstrapState>;
    patchSettings(input: LocalSettingsPatch): Promise<RedactedLocalConfig>;
    testLlmConnection(input: LocalSettingsPatch): Promise<ConnectionTestResult>;
  };
  bots: {
    list(): Promise<BotSummary[]>;
    remove?(input: { botId: string }): Promise<void>;
    createDraft(input: CreateDraftBotInput): Promise<BotSummary>;
  };
  workbench: {
    get(input: GetWorkbenchInput): Promise<WorkbenchState>;
    stopAgent(input: StopWorkbenchAgentInput): Promise<void>;
    sendMessage(input: SendWorkbenchMessageInput): Promise<WorkbenchState>;
    runBacktest(input: RunWorkbenchBacktestInput): Promise<BacktestSummary>;
    configureNode?(input: import('./workbench').ConfigureLegacyNodeInput): Promise<WorkbenchState>;
    approveRevision(input: ApproveStrategyRevisionInput): Promise<StrategyRevision>;
    getTrace(input: GetTraceInput): Promise<TraceDetail>;
    subscribeActivity(listener: (activity: AgentToolActivity) => void): () => void;
  };
  deployments: {
    startPaper(input: StartPaperInput): Promise<PaperDeploymentView>;
    getPaper(input: GetDeploymentInput): Promise<PaperDeploymentView>;
    pausePaper(input: PauseDeploymentInput): Promise<PaperDeploymentView>;
    stopPaper(input: StopDeploymentInput): Promise<PaperDeploymentView>;
    prepareLive(input: PrepareLiveInput): Promise<LivePreflightView>;
    startLive(input: StartLiveInput): Promise<Deployment>;
    getLive(input: GetDeploymentInput): Promise<Deployment>;
    stopLive(input: StopDeploymentInput): Promise<Deployment>;
    getActive(input: GetActiveDeploymentInput): Promise<Deployment | null>;
  };
  runtime: {
    getStatus(): Promise<RuntimeStatus>;
    getDatabaseState(): Promise<DatabaseState>;
    subscribeStatus(listener: (status: RuntimeStatus) => void): () => void;
  };
}
