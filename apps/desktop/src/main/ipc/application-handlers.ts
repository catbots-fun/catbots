import { fetchMarketSnapshot, fetchMarketCatalog } from '../nodes/market-snapshot';
import { ConnectionCommandSchema, NodePackageCommandSchema } from '@catbots/contracts';
import { toRendererSafeTraceDetails } from '../../shared/trace-projection';
import {
  CreateDraftBotInputSchema,
  ConfigureLegacyNodeInputSchema,
  AgentToolActivitySchema,
  AuditEventTypeSchema,
  ApproveStrategyRevisionInputSchema,
  BacktestSummarySchema,
  BotSummarySchema,
  GetTraceInputSchema,
  GetActiveDeploymentInputSchema,
  GetDeploymentInputSchema,
  GetWorkbenchInputSchema,
  LocalSettingsPatchSchema,
  RunWorkbenchBacktestInputSchema,
  LivePreflightViewSchema,
  PaperDeploymentViewSchema,
  ProductCapabilitiesSchema,
  PauseDeploymentInputSchema,
  PrepareLiveInputSchema,
  StartLiveInputSchema,
  DeploymentSchema,
  DatabaseStateSchema,
  RuntimeStatusSchema,
  SendWorkbenchMessageInputSchema,
  StopWorkbenchAgentInputSchema,
  StartPaperInputSchema,
  StrategyRevisionSchema,
  StopDeploymentInputSchema,
  TraceDetailSchema,
  WorkbenchStateSchema,
  type AgentToolActivity,
  type BootstrapState,
  type ConnectionTestResult,
  type DatabaseState,
  type LocalConfig,
  type LocalSettingsPatch,
  type ProductCapabilities,
  type RuntimeStatus,
  type TraceDetail,
} from '@catbots/contracts';
import { BotRepository } from '../bots/bot-repository';
import {
  ConfigParseError,
  ConfigRepository,
  HyperliquidCredentialReplacementRequiredError,
  LlmCredentialReplacementRequiredError,
} from '../config/config-repository';
import type { WorkbenchService } from '../workbench/workbench-service';
import type { DeploymentService } from '../execution/deployment-service';

export class IpcRequestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'IpcRequestError';
    this.code = code;
  }
}

type RuntimePort = {
  getStatus(): RuntimeStatus;
  subscribeStatus(listener: (status: RuntimeStatus) => void): () => void;
  startDeployment(deploymentId: string): void;
  pauseDeployment(deploymentId: string): void;
  stopDeployment(deploymentId: string): void;
};

type ApplicationPort = {
  getVersion(): string;
  showMainWindow(): void | Promise<void>;
  quitApplication(): void | Promise<void>;
};

export type IpcHandlerDependencies = {
  capabilities: ProductCapabilities;
  app: ApplicationPort;
  connections?: import('../connections/service').ConnectionsService;
  nodePackages?: Pick<import('../nodes/package-service').NodePackageService, 'command'>;
  providerService?: Pick<import('../providers/provider-service').ProviderService, 'command'>;
  configRepository: Pick<ConfigRepository, 'getRedacted' | 'patchSettings' | 'resolveSettingsPatch'>;
  botRepository: Pick<BotRepository, 'list' | 'createDraft'> & Partial<Pick<BotRepository, 'remove'>>;
  workbenchService: Pick<WorkbenchService, 'get' | 'stopAgent' | 'sendMessage' | 'runBacktest' | 'approveRevision' | 'getTrace' | 'subscribeActivity'> & Partial<Pick<WorkbenchService, 'configureNode'>>;
  deploymentService: Pick<DeploymentService, 'startPaper' | 'getPaperDeployment' | 'pause' | 'stop' | 'prepareLive' | 'startLive' | 'getLiveDeployment' | 'getActiveDeployment'>;
  runtime: RuntimePort;
  testLlmConnection?: (provider: LocalConfig['llm']) => Promise<ConnectionTestResult>;
};

export type ApplicationHandlers = ReturnType<typeof createApplicationHandlers>;

export function createApplicationHandlers(dependencies: IpcHandlerDependencies) {
  return {
    connectionCommand: async (input: unknown) => {
      const command = parseRequest(ConnectionCommandSchema, input);
      if (!dependencies.capabilities.exchangeConnections && !isExecutionRecoveryCommand(command.action)) {
        throw new IpcRequestError('EXECUTION_NOT_AVAILABLE');
      }
      if (!dependencies.connections) throw new IpcRequestError('NODE_PACKAGE_OPERATION_FAILED');
      return dependencies.connections.command(command);
    },
    nodePackageCommand: async (input: unknown) => {
      try { const command = NodePackageCommandSchema.parse(input); if (command.action === 'market_catalog') return { packages: [], markets: await fetchMarketCatalog() }; if (command.action === 'market_snapshot') return { packages: [], marketSnapshot: await fetchMarketSnapshot(command) }; if (!dependencies.nodePackages) throw new Error(); return dependencies.nodePackages.command(input); } catch { throw new IpcRequestError('NODE_PACKAGE_OPERATION_FAILED'); }
    },
    providerCommand: async (input: unknown) => {
      try { if (!dependencies.providerService) throw new Error(); return await dependencies.providerService.command(input); }
      catch { throw new IpcRequestError('PROVIDER_OPERATION_FAILED'); }
    },
    getVersion: async (): Promise<string> => {
      try {
        const version = dependencies.app.getVersion();
        if (typeof version !== 'string') throw new Error('Invalid version response');
        return version;
      } catch {
        throw new IpcRequestError('APP_VERSION_FAILED');
      }
    },

    getProductCapabilities: async (): Promise<ProductCapabilities> =>
      ProductCapabilitiesSchema.parse(dependencies.capabilities),

    showMainWindow: async (): Promise<void> => {
      try {
        await dependencies.app.showMainWindow();
      } catch {
        throw new IpcRequestError('APP_SHOW_MAIN_WINDOW_FAILED');
      }
    },

    quitApplication: async (): Promise<void> => {
      try {
        await dependencies.app.quitApplication();
      } catch {
        throw new IpcRequestError('APP_QUIT_APPLICATION_FAILED');
      }
    },

    getBootstrapState: async (): Promise<BootstrapState> => {
      try {
        const config = await dependencies.configRepository.getRedacted();
        return config === null ? { state: 'first-launch' } : { state: 'ready', config };
      } catch (error) {
        if (error instanceof ConfigParseError) {
          return { state: 'repair', issues: error.issues.map(toSafeConfigIssue) };
        }
        return { state: 'repair', issues: [{ path: 'config', message: 'Configuration requires repair' }] };
      }
    },

    patchLocalSettings: async (input: unknown) => {
      const patch = parseRequest(LocalSettingsPatchSchema, input);
      if (!dependencies.capabilities.exchangeConnections && patch.exchanges !== undefined) {
        throw new IpcRequestError('EXECUTION_NOT_AVAILABLE');
      }
      try {
        return await dependencies.configRepository.patchSettings(patch);
      } catch (error) {
        if (error instanceof LlmCredentialReplacementRequiredError) {
          throw new IpcRequestError('LLM_CREDENTIAL_REPLACEMENT_REQUIRED');
        }
        if (error instanceof HyperliquidCredentialReplacementRequiredError) {
          throw new IpcRequestError('HYPERLIQUID_CREDENTIAL_REPLACEMENT_REQUIRED');
        }
        if (error instanceof ConfigParseError) throw new IpcRequestError('INVALID_REQUEST');
        throw new IpcRequestError('CONFIG_SAVE_FAILED');
      }
    },

    testLlmConnection: async (input: unknown): Promise<ConnectionTestResult> => {
      const patch = parseRequest<LocalSettingsPatch>(LocalSettingsPatchSchema, input);
      if (dependencies.testLlmConnection === undefined) {
        return {
          ok: false,
          code: 'LLM_CONNECTION_TEST_UNAVAILABLE',
          message: 'LLM connection testing is unavailable in M0.',
        };
      }
      try {
        const config = await dependencies.configRepository.resolveSettingsPatch(patch);
        return await dependencies.testLlmConnection(config.llm);
      } catch (error) {
        if (error instanceof LlmCredentialReplacementRequiredError) {
          return {
            ok: false,
            code: 'LLM_CREDENTIAL_REPLACEMENT_REQUIRED',
            message: 'Enter a new API key for this provider location.',
          };
        }
        if (error instanceof ConfigParseError) {
          return {
            ok: false,
            code: 'LLM_CONNECTION_CONFIGURATION_REQUIRED',
            message: 'Enter an API key before testing this provider.',
          };
        }
        return {
          ok: false,
          code: 'LLM_CONNECTION_TEST_FAILED',
          message: 'LLM connection test failed.',
        };
      }
    },

    listBots: async () => {
      try {
        return BotSummarySchema.array().parse(dependencies.botRepository.list());
      } catch {
        throw new IpcRequestError('BOT_LIST_FAILED');
      }
    },

    removeBot: async (input: unknown) => {
      const request = parseRequest(GetWorkbenchInputSchema, input);
      try {
        dependencies.connections?.assertBotRemovable(request.botId);
        if (!dependencies.botRepository.remove) throw new Error('Unavailable');
        dependencies.botRepository.remove(request.botId);
      } catch (error) {
        throw new IpcRequestError(error instanceof Error && ['BOT_ACTIVE','BOT_UNRESOLVED'].includes(error.message) ? error.message : 'BOT_DELETE_FAILED');
      }
    },

    createDraftBot: async (input: unknown) => {
      const draft = parseRequest(CreateDraftBotInputSchema, input);
      try {
        return BotSummarySchema.parse(dependencies.botRepository.createDraft(draft));
      } catch {
        throw new IpcRequestError('BOT_CREATE_FAILED');
      }
    },

    getWorkbench: async (input: unknown) => {
      const request = parseRequest(GetWorkbenchInputSchema, input);
      try {
        return WorkbenchStateSchema.parse(await dependencies.workbenchService.get(request));
      } catch {
        throw new IpcRequestError('WORKBENCH_GET_FAILED');
      }
    },

    stopWorkbenchAgent: async (input: unknown) => {
      const request = parseRequest(StopWorkbenchAgentInputSchema, input);
      try { await dependencies.workbenchService.stopAgent(request); }
      catch { throw new IpcRequestError('WORKBENCH_STOP_FAILED'); }
    },

    sendWorkbenchMessage: async (input: unknown) => {
      const request = parseRequest(SendWorkbenchMessageInputSchema, input);
      try {
        return WorkbenchStateSchema.parse(await dependencies.workbenchService.sendMessage(request));
      } catch {
        throw new IpcRequestError('WORKBENCH_MESSAGE_FAILED');
      }
    },

    runWorkbenchBacktest: async (input: unknown) => {
      const request = parseRequest(RunWorkbenchBacktestInputSchema, input);
      try {
        return BacktestSummarySchema.parse(await dependencies.workbenchService.runBacktest(request));
      } catch {
        throw new IpcRequestError('WORKBENCH_BACKTEST_FAILED');
      }
    },

    configureLegacyNode: async (input: unknown) => {
      const request = parseRequest(ConfigureLegacyNodeInputSchema, input);
      if (!dependencies.workbenchService.configureNode) throw new IpcRequestError('WORKBENCH_UNAVAILABLE');
      return WorkbenchStateSchema.parse(await dependencies.workbenchService.configureNode(request));
    },

    approveStrategyRevision: async (input: unknown) => {
      const request = parseRequest(ApproveStrategyRevisionInputSchema, input);
      try {
        return StrategyRevisionSchema.parse(await dependencies.workbenchService.approveRevision(request));
      } catch {
        throw new IpcRequestError('WORKBENCH_APPROVAL_FAILED');
      }
    },

    getWorkbenchTrace: async (input: unknown) => {
      const request = parseRequest(GetTraceInputSchema, input);
      try {
        return toRendererSafeTrace(await dependencies.workbenchService.getTrace(request));
      } catch {
        throw new IpcRequestError('WORKBENCH_TRACE_FAILED');
      }
    },

    startPaperDeployment: async (input: unknown) => {
      const request = parseRequest(StartPaperInputSchema, input);
      assertCapability(dependencies.capabilities.paperExecution);
      let deploymentId: string | undefined;
      try {
        const deployment = await dependencies.deploymentService.startPaper(request, new AbortController().signal);
        deploymentId = deployment.id;
        dependencies.runtime.startDeployment(deployment.id);
        return PaperDeploymentViewSchema.parse(dependencies.deploymentService.getPaperDeployment(deployment.id));
      } catch {
        if (deploymentId !== undefined) {
          try {
            dependencies.deploymentService.stop(deploymentId);
          } catch {
            // The fixed IPC failure remains authoritative; startup never proceeds to the renderer.
          }
        }
        throw new IpcRequestError('PAPER_DEPLOYMENT_START_FAILED');
      }
    },

    getPaperDeployment: async (input: unknown) => {
      const request = parseRequest(GetDeploymentInputSchema, input);
      try {
        return PaperDeploymentViewSchema.parse(dependencies.deploymentService.getPaperDeployment(request.deploymentId));
      } catch {
        throw new IpcRequestError('PAPER_DEPLOYMENT_GET_FAILED');
      }
    },

    pausePaperDeployment: async (input: unknown) => {
      const request = parseRequest(PauseDeploymentInputSchema, input);
      try {
        dependencies.deploymentService.pause(request.deploymentId);
        dependencies.runtime.pauseDeployment(request.deploymentId);
        return PaperDeploymentViewSchema.parse(dependencies.deploymentService.getPaperDeployment(request.deploymentId));
      } catch {
        throw new IpcRequestError('PAPER_DEPLOYMENT_PAUSE_FAILED');
      }
    },

    stopPaperDeployment: async (input: unknown) => {
      const request = parseRequest(StopDeploymentInputSchema, input);
      try {
        dependencies.deploymentService.stop(request.deploymentId);
        dependencies.runtime.stopDeployment(request.deploymentId);
        return PaperDeploymentViewSchema.parse(dependencies.deploymentService.getPaperDeployment(request.deploymentId));
      } catch {
        throw new IpcRequestError('PAPER_DEPLOYMENT_STOP_FAILED');
      }
    },

    prepareLiveDeployment: async (input: unknown) => {
      const request = parseRequest(PrepareLiveInputSchema, input);
      assertCapability(dependencies.capabilities.liveExecution);
      try {
        return LivePreflightViewSchema.parse(
          await dependencies.deploymentService.prepareLive(request, new AbortController().signal),
        );
      } catch {
        throw new IpcRequestError('LIVE_PREFLIGHT_FAILED');
      }
    },

    startLiveDeployment: async (input: unknown) => {
      const request = parseRequest(StartLiveInputSchema, input);
      assertCapability(dependencies.capabilities.liveExecution);
      let deploymentId: string | undefined;
      try {
        const deployment = await dependencies.deploymentService.startLive(request);
        deploymentId = deployment.id;
        dependencies.runtime.startDeployment(deployment.id);
        return DeploymentSchema.parse(deployment);
      } catch {
        if (deploymentId !== undefined) {
          try { dependencies.deploymentService.stop(deploymentId); } catch { /* Startup failure remains authoritative. */ }
        }
        throw new IpcRequestError('LIVE_DEPLOYMENT_START_FAILED');
      }
    },

    getLiveDeployment: async (input: unknown) => {
      const request = parseRequest(GetDeploymentInputSchema, input);
      try {
        return DeploymentSchema.parse(dependencies.deploymentService.getLiveDeployment(request.deploymentId));
      } catch {
        throw new IpcRequestError('LIVE_DEPLOYMENT_GET_FAILED');
      }
    },

    stopLiveDeployment: async (input: unknown) => {
      const request = parseRequest(StopDeploymentInputSchema, input);
      try {
        dependencies.deploymentService.stop(request.deploymentId);
        dependencies.runtime.stopDeployment(request.deploymentId);
        return DeploymentSchema.parse(dependencies.deploymentService.getLiveDeployment(request.deploymentId));
      } catch {
        throw new IpcRequestError('LIVE_DEPLOYMENT_STOP_FAILED');
      }
    },

    getActiveDeployment: async (input: unknown) => {
      const request = parseRequest(GetActiveDeploymentInputSchema, input);
      try {
        const deployment = dependencies.deploymentService.getActiveDeployment(request.botId);
        return deployment === null ? null : DeploymentSchema.parse(deployment);
      } catch {
        throw new IpcRequestError('ACTIVE_DEPLOYMENT_GET_FAILED');
      }
    },

    getRuntimeStatus: async (): Promise<RuntimeStatus> => {
      try {
        return RuntimeStatusSchema.parse(dependencies.runtime.getStatus());
      } catch {
        throw new IpcRequestError('RUNTIME_STATUS_FAILED');
      }
    },

    getDatabaseState: async (): Promise<DatabaseState> => {
      return DatabaseStateSchema.parse({ status: 'ready' });
    },
  };
}

function assertCapability(enabled: boolean): void {
  if (!enabled) throw new IpcRequestError('EXECUTION_NOT_AVAILABLE');
}

function isExecutionRecoveryCommand(action: string): boolean {
  return ['list', 'bot_overview', 'get_flow_runtime', 'get_flow_audit', 'get_flow_audit_summary', 'get_target', 'reconcile_flow', 'stop_flow'].includes(action);
}

function parseRequest<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new IpcRequestError('INVALID_REQUEST');
  return result.data as T;
}

function toRendererSafeTrace(candidate: unknown): TraceDetail {
  const trace = TraceDetailSchema.parse(candidate);
  return TraceDetailSchema.parse({
    ...trace,
    events: trace.events.map((event) => {
      const type = AuditEventTypeSchema.parse(event.type);
      return {
        sequence: event.sequence,
        type,
        occurredAt: event.occurredAt,
        ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
        summary: type.replaceAll('.', ' '),
        details: toRendererSafeTraceDetails(type, event.details),
      };
    }),
  });
}


function toSafeConfigIssue(issue: { path: string; message: string }): { path: string; message: string } {
  return { path: issue.path, message: issue.message };
}
