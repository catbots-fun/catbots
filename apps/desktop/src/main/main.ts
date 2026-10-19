import { startWalletBridge } from './connections/wallet-bridge';
import { ConnectionAuthorization } from './connections/authorization';
import { ConnectionsService } from './connections/service';
import { NodePackageService } from './nodes/package-service';
import { safeStorage, shell, Notification } from 'electron';
import { createIncidentNotifier } from './connections/incident-notification';
import { ProviderService } from './providers/provider-service';
import { EncryptedCredentialStore } from './providers/credential-store';
import { app, dialog, net, session, utilityProcess, type BrowserWindow } from 'electron';
import { startWebServer } from './web/http-server';
import { webMethods } from './web/methods';
import { createApplicationHandlers, IpcRequestError, type IpcHandlerDependencies } from './ipc/application-handlers';
import { AgentToolActivitySchema, RuntimeStatusSchema } from '@catbots/contracts';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvaluationContext, parseStrategyDocument } from '@catbots/strategy-runtime';
import { BotRepository } from './bots/bot-repository';
import { ConfigRepository } from './config/config-repository';
import { createMainWindow } from './create-window';
import { isUnsignedDevelopmentBuild, isUnsignedE2ETestProcess, resolveApplicationDataDirectory } from './data-directory';
import { registerDatabaseRepairIpcHandlers, registerIpcHandlers } from './ipc/register-ipc';
import { installM0PermissionPolicy } from './install-permission-policy';
import { testLlmConnection } from './llm/test-llm-connection';
import { registerAppProtocol } from './register-app-protocol';
import { RuntimeSupervisor } from './runtime/runtime-supervisor';
import { DeploymentService } from './execution/deployment-service';
import { ExecutionRepository } from './execution/execution-repository';
import { HyperliquidAdapter } from './execution/hyperliquid/hyperliquid-adapter';
import { createHyperliquidPublicClient } from './execution/hyperliquid/hyperliquid-client';
import { MarketUniverseCache } from './execution/market-universe-cache';
import { ApplicationDatabase } from './storage/database';
import { createTray, type TrayController } from './tray/create-tray';
import { WorkbenchRepository } from './workbench/workbench-repository';
import { WorkbenchService } from './workbench/workbench-service';
import { createStaticAssetCatalog } from './web/static-assets';
import { startServiceHost } from './service/service-host';
import { createServiceIdentity, createServiceReleaseIdentity } from './service/runtime-identity';
import { currentDataSchemaVersion } from './storage/migrations';
import { MaintenanceCoordinator } from './maintenance/maintenance-coordinator';
import { strategyLabCapabilities } from '../shared/product-capabilities';
import { compiledReleaseCommit } from './installer/release-trust';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const appOrigin = 'catbots://app';
const ownsApplicationInstance = process.env.CATBOTS_INSTANCE_LOCK_ACQUIRED === '1'
  || app.requestSingleInstanceLock();
let database!: ApplicationDatabase;
let runtime!: RuntimeSupervisor;
if (ownsApplicationInstance) {
  database = new ApplicationDatabase();
  runtime = new RuntimeSupervisor(() => utilityProcess.fork(join(__dirname, 'runtime-worker.js')));
} else {
  app.quit();
}
let disposeFlowConnections: (()=>Promise<void>) | undefined;
let walletBridge: Awaited<ReturnType<typeof startWalletBridge>> | undefined;
let webServer: Awaited<ReturnType<typeof startWebServer>> | undefined;
let disposeIpcHandlers: (() => void) | undefined;
let mainWindow: BrowserWindow | undefined;
let tray: TrayController | undefined;
let shutdownPromise: Promise<void> | undefined;
let marketUniverseRefreshOwner: AbortController | undefined;
let stopMarketUniverseRefresh: (() => boolean) | undefined;
let quitting = false;
let disposeNodeBacktests: (() => void) | undefined;
let e2eQuitResponse: number | undefined;
let startupPhase = 'waiting-for-electron';
const initialMaintenanceOperationId = process.env.CATBOTS_MAINTENANCE_OPERATION_ID;
let serviceReadiness: 'starting' | 'ready' | 'maintenance' | 'repair' = initialMaintenanceOperationId === undefined
  ? 'starting'
  : 'maintenance';
let maintenanceOperationId: string | undefined = initialMaintenanceOperationId;

app.enableSandbox();

if (ownsApplicationInstance) void app.whenReady()
  .then(async () => {
    if (!app.isPackaged && process.platform === 'darwin') {
      try {
        app.dock?.setIcon(join(__dirname, '..', '..', 'assets', 'icon.png'));
      } catch {
        console.error('Catbots development dock icon unavailable');
      }
    }
    startupPhase = 'permission-policy';
    installM0PermissionPolicy(session.defaultSession);
    const e2eRequested = process.env.NODE_ENV === 'test' && process.env.CATBOTS_E2E_DATA_DIR !== undefined;
    const unsignedBuild = e2eRequested && isUnsignedDevelopmentBuild({
      executablePath: process.execPath,
      isDefaultApp: process.defaultApp === true,
      isMacAppStore: process.mas === true,
      isPackaged: app.isPackaged,
      platform: process.platform,
    });
    const e2eAllowed = isUnsignedE2ETestProcess(process.env, unsignedBuild);
    startupPhase = 'data-directory';
    const dataDirectory = await resolveApplicationDataDirectory({
      defaultDirectory: app.getPath('userData'),
      environment: process.env,
      allowE2EDataDirectory: e2eAllowed,
      protectedDirectories: [app.getAppPath(), app.getPath('userData')],
      temporaryRoot: tmpdir(),
    });
    const isolatedE2E = e2eAllowed
      && dataDirectory === process.env.CATBOTS_E2E_DATA_DIR;
    startupPhase = 'database';
    const databaseResult = database.start(dataDirectory);

    startupPhase = 'application-protocol';
    registerAppProtocol({
      rendererDirectory: join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`),
      developmentServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
    });

    if (databaseResult.status === 'repair') {
      startupPhase = 'database-repair-ipc';
      disposeIpcHandlers = registerDatabaseRepairIpcHandlers({
        app: { quitApplication: requestQuit },
      });
      startupPhase = 'tray';
      installTray();
      startupPhase = 'main-window';
      await openMainWindow();
      startupPhase = 'database-repair';
      return;
    }

    startupPhase = 'services';
    const connection = databaseResult.database;
    const configRepository = new ConfigRepository(dataDirectory);
    const botRepository = new BotRepository(connection);
    const nodePackages = new NodePackageService(join(dataDirectory, 'node-packages.json'));
    disposeNodeBacktests = () => nodePackages.dispose();
    const workbenchRepository = new WorkbenchRepository(connection, undefined, undefined, () => nodePackages.catalog());
    const providerService = new ProviderService(new EncryptedCredentialStore(join(dataDirectory, 'provider-auth.enc'), {
      encrypt: (value) => { if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage unavailable'); return safeStorage.encryptString(value); },
      decrypt: (value) => safeStorage.decryptString(value),
    }), join(dataDirectory, 'provider-selection.json'), undefined, (url) => shell.openExternal(url));
    const connections = new ConnectionsService(join(dataDirectory, 'exchange-connections.json'), undefined, new ConnectionAuthorization(join(dataDirectory, 'exchange-credentials.enc'), { encrypt: value => { if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage unavailable'); return safeStorage.encryptString(value); }, decrypt: value => safeStorage.decryptString(value) }), async (id) => {
      if (!id) { if (!webServer) throw new Error('Choose a connection and click Authorize trading'); await shell.openExternal(`${webServer.origin}/#connections`); return; }
      const prepared = await connections.command({ action: 'prepare_authorization', id });
      if (!prepared.authorization) throw new Error('Authorization unavailable');
      await walletBridge?.close();
      walletBridge = await startWalletBridge({
        challenge: prepared.authorization,
        complete: async signature => { await connections.command({ action: 'complete_authorization', id, signature }); },
        asset: async path => {
          const target = new URL(path, MAIN_WINDOW_VITE_DEV_SERVER_URL || 'catbots://app/');
          const base = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL || 'catbots://app/');
          if (target.protocol !== base.protocol || target.host !== base.host) throw new Error('INVALID_ASSET');
          const response = await net.fetch(target.href);
          if (!response.ok) throw new Error('ASSET_NOT_FOUND');
          return { body: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') || 'application/octet-stream' };
        },
      });
      try { await shell.openExternal(walletBridge.origin); }
      catch (error) { await walletBridge.close(); walletBridge = undefined; throw error; }
    }, botId => nodePackages.flowStore().get(botId), botId => botRepository.exists(botId));
    connections.startIncidentMonitoring(createIncidentNotifier(options => {
      if (!Notification.isSupported()) throw new Error('Notification unavailable');
      return new Notification(options);
    }));
    const workbenchService = new WorkbenchService({ repository: workbenchRepository, configRepository, providerService, nodePackages });
    const marketUniverseCache = new MarketUniverseCache({
      adapter: isolatedE2E
        ? e2eMarketUniverseAdapter()
        : new HyperliquidAdapter({ client: createHyperliquidPublicClient() }),
    });
    marketUniverseRefreshOwner = new AbortController();
    try {
      await marketUniverseCache.initialize(marketUniverseRefreshOwner.signal);
    } catch {
      console.error('Catbots universe metadata unavailable');
    }
    stopMarketUniverseRefresh = marketUniverseCache.startPeriodicRefresh(marketUniverseRefreshOwner.signal);
    const executionRepository = new ExecutionRepository(connection);
    const deploymentService = new DeploymentService({
      executionRepository,
      workbenchRepository,
      configRepository,
      marketUniverseCache,
      runtimeReady: () => runtime.getStatus().state === 'ready',
    });
    startupPhase = 'runtime';
    runtime.start();
    startupPhase = 'ipc';
    const serviceDependencies: IpcHandlerDependencies = {
      capabilities: strategyLabCapabilities,
      app: {
        getVersion: () => app.getVersion(),
        showMainWindow: openMainWindow,
        quitApplication: requestQuit,
      },
      configRepository,
      providerService,
      nodePackages,
      connections,
      botRepository,
      workbenchService,
      deploymentService,
      runtime,
      testLlmConnection,
    };
    disposeFlowConnections = () => serviceDependencies.connections!.dispose();
    disposeIpcHandlers = registerIpcHandlers(serviceDependencies);
    if (process.env.CATBOTS_WEB === '1') {
      const releaseIdentity = createServiceReleaseIdentity({
        version: app.getVersion(),
          commit: app.isPackaged ? compiledReleaseCommit() : 'development',
        architecture: process.arch,
        dataSchemaVersion: currentDataSchemaVersion,
      });
      const instanceId = randomUUID();
      const maintenance = new MaintenanceCoordinator({
        blockNewWork: async (operationId) => {
          maintenanceOperationId = operationId;
          serviceReadiness = 'maintenance';
          return async () => {
            maintenanceOperationId = undefined;
            serviceReadiness = 'ready';
          };
        },
        inspect: async () => {
          const deployments = connection.prepare(`
            SELECT id, mode FROM deployments
            WHERE status IN ('preflight', 'running', 'paused', 'stopping', 'recovering', 'suspended', 'error')
            ORDER BY created_at
          `).all().map((row) => {
            const value = row as { id: unknown; mode: unknown };
            if (typeof value.id !== 'string' || (value.mode !== 'paper' && value.mode !== 'live')) {
              throw new Error('MAINTENANCE_DEPLOYMENT_INVALID');
            }
            return { id: value.id, mode: value.mode } as const;
          });
          const unsettled = connection.prepare(`
            SELECT client_order_id, status FROM execution_outbox
            WHERE status IN ('pending', 'claimed', 'unknown')
            ORDER BY created_at
          `).all() as Array<{ client_order_id: unknown; status: unknown }>;
          return {
            deployments,
            inFlightOrderIds: unsettled
              .filter(({ status }) => status !== 'unknown')
              .map(({ client_order_id }) => String(client_order_id)),
            unknownOrderIds: unsettled
              .filter(({ status }) => status === 'unknown')
              .map(({ client_order_id }) => String(client_order_id)),
            databaseRepairRequired: false,
            runtime: runtime.getStatus(),
          };
        },
        stopRuntime: () => runtime.stop(),
        checkpointWal: () => database.checkpointWal(),
      });
      const application = createApplicationHandlers(serviceDependencies);
      const packagedAssets = app.isPackaged
        ? await createStaticAssetCatalog(join(__dirname, '../renderer/main_window'))
        : undefined;
      if (!app.isPackaged && !MAIN_WINDOW_VITE_DEV_SERVER_URL) throw new Error('WEB_DEV_SERVER_REQUIRED');
      webServer = await startServiceHost({
        port: 5180,
        socketPath: join(dataDirectory, 'control', 'catbots.sock'),
        identity: () => createServiceIdentity(
          releaseIdentity,
          instanceId,
          serviceReadiness,
          maintenanceOperationId,
        ),
        maintenance,
        shutdown: async (leaseId) => {
          if (maintenance.current()?.operationId !== leaseId) throw new Error('MAINTENANCE_LEASE_MISMATCH');
          setTimeout(() => { void quitApplication(); }, 25);
        },
        invoke: async (method, input) => {
          if (maintenance.current() !== undefined) throw new IpcRequestError('MAINTENANCE_ACTIVE');
          if (!Object.hasOwn(webMethods, method)) throw new IpcRequestError('UNKNOWN_METHOD');
          const name = webMethods[method as keyof typeof webMethods];
          return (application[name] as (input?: unknown) => Promise<unknown>)(input);
        },
        subscribe: (send) => {
          const runtimeSubscription = runtime.subscribeStatus((status) => {
            const parsed = RuntimeStatusSchema.safeParse(status);
            if (parsed.success) send('runtime', parsed.data);
          });
          const activitySubscription = workbenchService.subscribeActivity((activity) => {
            const parsed = AgentToolActivitySchema.safeParse(activity);
            if (parsed.success) send('activity', parsed.data);
          });
          return () => { runtimeSubscription(); activitySubscription(); };
        },
        asset: async (path) => {
          if (packagedAssets !== undefined) return packagedAssets.resolve(path);
          const target = new URL(path, MAIN_WINDOW_VITE_DEV_SERVER_URL);
          if (target.origin !== new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL!).origin) throw new Error('INVALID_ASSET');
          const response = await net.fetch(target.href, { cache: 'no-store' });
          if (!response.ok) throw new Error('ASSET_NOT_FOUND');
          return { body: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
        },
      });
      if (maintenanceOperationId === undefined) serviceReadiness = 'ready';
      console.log(`Catbots web: ${webServer.origin} (real local backend)`);
    }
    startupPhase = 'tray';
    installTray();
    if (isolatedE2E) {
      Object.assign(globalThis, {
        __catbotsE2E: {
          openMainWindow,
          requestQuit: async (response: number) => {
            e2eQuitResponse = response;
            await requestQuit();
          },
          seedDynamicWorkflow: async (botId: string) => {
            const now = '2026-09-05T08:00:00.000Z';
            const revision = workbenchRepository.createValidatedRevision(botId, e2eDynamicStrategy());
            await workbenchService.runBacktest({
              botId,
              revisionVersion: revision.version,
              marketUniverse: { mode: 'all_available' },
              assumptions: {
                from: '2026-08-01T00:00:00.000Z',
                to: '2026-09-01T00:00:00.000Z',
                startingCapital: '10000',
                feeRateBps: 3.5,
                slippageBps: 1,
              },
            });
            workbenchRepository.approveRevision(botId, revision.version);
            const universe = {
              dex: 'hyperliquid' as const,
              revision: 'e2e:dynamic-universe',
              observedAt: now,
              markets: [
                { symbol: 'BTC-PERP', active: true, sizeDecimals: 5, maximumLeverage: 40 },
                { symbol: 'ETH-PERP', active: true, sizeDecimals: 4, maximumLeverage: 30 },
              ],
            };
            const deterministicPaper = new DeploymentService({
              executionRepository,
              workbenchRepository,
              marketUniverseCache: {
                refresh: async () => universe,
                freshness: () => ({ fresh: true }),
              },
              clock: () => new Date(now),
              idFactory: randomUUID,
            });
            const deployment = await deterministicPaper.startPaper({
              botId,
              strategyVersion: revision.version,
              riskLimits: {
                maxOrderUsd: '1000',
                maxPositionUsd: '2500',
                maxTotalExposureUsd: '5000',
                maxLeverage: 3,
                maxDailyLossUsd: '300',
                maxDrawdownPercent: 12,
                allowedSides: ['long'],
                maxOrdersPerMinute: 4,
              },
            });
            await deterministicPaper.ingest({
              deploymentId: deployment.id,
              triggerNodeId: 'entry-clock',
              triggerInput: { kind: 'interval', occurredAt: now },
              contextFactory: (market) => createEvaluationContext({
                evaluatedAt: now,
                currentMarket: market,
                values: {
                  'market.price': {
                    value: { market, bid: 99, ask: 101, mark: 100 },
                    provider: 'catbots.e2e-fixture',
                    observedAt: now,
                    freshnessSeconds: 0,
                    quality: { status: 'verified' },
                    integrityHash: `sha256:e2e-price:${market}`,
                  },
                  'indicator.rsi.14': {
                    value: { value: market === 'ETH-PERP' ? 15 : 50 },
                    provider: 'catbots.e2e-fixture',
                    observedAt: now,
                    freshnessSeconds: 0,
                    quality: { status: 'verified' },
                    integrityHash: `sha256:e2e-rsi:${market}`,
                  },
                },
              }),
            });
            return e2eDynamicWorkflowSnapshot(botId, workbenchRepository, executionRepository);
          },
          getDynamicWorkflow: async (botId: string) => (
            e2eDynamicWorkflowSnapshot(botId, workbenchRepository, executionRepository)
          ),
        },
      });
    }
    startupPhase = 'main-window';
    if (process.env.CATBOTS_WEB_ONLY !== '1') await openMainWindow();
    startupPhase = 'ready';
  })
  .catch(async () => {
    await shutdown();
    console.error(`Catbots fatal startup error (${startupPhase})`);
    quitting = true;
    app.quit();
  });

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  void requestQuit();
});

// Subscribing preserves the process after the final window closes. Tray controls own explicit exit.
app.on('window-all-closed', () => undefined);
app.on('second-instance', () => {
  void openMainWindow();
});

function e2eMarketUniverseAdapter() {
  return {
    getMarkets: async () => Object.freeze([
      Object.freeze({ market: 'BTC-PERP', baseAsset: 'BTC', quoteAsset: 'USDC', active: true, sizeDecimals: 5, maximumLeverage: 40 }),
      Object.freeze({ market: 'ETH-PERP', baseAsset: 'ETH', quoteAsset: 'USDC', active: true, sizeDecimals: 4, maximumLeverage: 30 }),
    ]),
  };
}

function e2eDynamicStrategy() {
  return parseStrategyDocument({
    schemaVersion: '2.0',
    strategy: { id: 'e2e-eth-rsi', name: 'E2E ETH RSI', version: 1 },
    marketScope: { type: 'dex_universe' },
    nodes: [
      { id: 'entry-clock', kind: 'trigger', type: 'trigger.interval', version: 1, config: { every: '1h', alignment: 'utc' } },
      { id: 'entry-symbol', kind: 'condition', type: 'predicate.compare', version: 1, config: { left: { ref: 'market.symbol' }, operator: 'eq', right: { literal: 'ETH-PERP' } } },
      { id: 'entry-rsi', kind: 'condition', type: 'predicate.compare', version: 1, config: { left: { ref: 'indicator.rsi.14', field: 'value' }, operator: 'lt', right: { literal: 20 } } },
      { id: 'entry-all', kind: 'condition', type: 'combine.all', version: 1, config: {} },
      { id: 'entry-long', kind: 'action', type: 'execution.open_position', version: 1, config: { side: 'long', size: { type: 'quote', value: 100 } } },
      { id: 'exit-clock', kind: 'trigger', type: 'trigger.interval', version: 1, config: { every: '1h', alignment: 'utc' } },
      { id: 'exit-symbol', kind: 'condition', type: 'predicate.compare', version: 1, config: { left: { ref: 'market.symbol' }, operator: 'eq', right: { literal: 'ETH-PERP' } } },
      { id: 'exit-rsi', kind: 'condition', type: 'predicate.compare', version: 1, config: { left: { ref: 'indicator.rsi.14', field: 'value' }, operator: 'gt', right: { literal: 80 } } },
      { id: 'exit-long', kind: 'condition', type: 'predicate.position_state', version: 2, config: { state: 'long' } },
      { id: 'exit-all', kind: 'condition', type: 'combine.all', version: 1, config: {} },
      { id: 'exit-close', kind: 'action', type: 'execution.close_position', version: 1, config: { side: 'long', percent: 100 } },
    ],
    edges: [
      { id: 'e1', source: 'entry-clock', sourcePort: 'activation', target: 'entry-symbol', targetPort: 'activation' },
      { id: 'e2', source: 'entry-clock', sourcePort: 'activation', target: 'entry-rsi', targetPort: 'activation' },
      { id: 'e3', source: 'entry-symbol', sourcePort: 'result', target: 'entry-all', targetPort: 'conditions' },
      { id: 'e4', source: 'entry-rsi', sourcePort: 'result', target: 'entry-all', targetPort: 'conditions' },
      { id: 'e5', source: 'entry-all', sourcePort: 'result', target: 'entry-long', targetPort: 'condition' },
      { id: 'e6', source: 'exit-clock', sourcePort: 'activation', target: 'exit-symbol', targetPort: 'activation' },
      { id: 'e7', source: 'exit-clock', sourcePort: 'activation', target: 'exit-rsi', targetPort: 'activation' },
      { id: 'e8', source: 'exit-clock', sourcePort: 'activation', target: 'exit-long', targetPort: 'activation' },
      { id: 'e9', source: 'exit-symbol', sourcePort: 'result', target: 'exit-all', targetPort: 'conditions' },
      { id: 'e10', source: 'exit-rsi', sourcePort: 'result', target: 'exit-all', targetPort: 'conditions' },
      { id: 'e11', source: 'exit-long', sourcePort: 'result', target: 'exit-all', targetPort: 'conditions' },
      { id: 'e12', source: 'exit-all', sourcePort: 'result', target: 'exit-close', targetPort: 'condition' },
    ],
  });
}

function e2eDynamicWorkflowSnapshot(
  botId: string,
  workbenchRepository: WorkbenchRepository,
  executionRepository: ExecutionRepository,
) {
  const state = workbenchRepository.getState(botId);
  const revision = state.currentRevision;
  const backtest = state.backtests[0];
  const deployment = executionRepository.getActiveDeploymentForBot(botId);
  if (revision === null || backtest === undefined || deployment === null) {
    throw new Error('E2E dynamic workflow is incomplete');
  }
  return {
    revision: {
      version: revision.version,
      schemaVersion: revision.schemaVersion,
      status: revision.status,
      ...(revision.schemaVersion === '2.0' ? { marketScope: revision.marketScope } : {}),
    },
    backtest: {
      status: backtest.status,
      datasetCoverage: backtest.datasetCoverage,
      traces: backtest.traces.map(({ market }) => ({ market })),
    },
    deployment,
    auditEvents: executionRepository.listDeploymentAuditEvents(deployment.id).map((event) => ({
      id: event.id,
      traceId: event.traceId,
      sequence: event.sequence,
      type: event.type,
      summary: event.summary,
      ...(event.parentTraceId === undefined ? {} : { parentTraceId: event.parentTraceId }),
      ...(event.market === undefined ? {} : { market: event.market }),
      ...(event.dex === undefined ? {} : { dex: event.dex }),
      ...(event.universeRevision === undefined ? {} : { universeRevision: event.universeRevision }),
    })),
  };
}

function installTray(): void {
  tray = createTray({
    iconPath: app.isPackaged
      ? join(process.resourcesPath, 'trayTemplate.png')
      : join(__dirname, '..', '..', 'assets', 'trayTemplate.png'),
    showWindow: openMainWindow,
    quit: requestQuit,
    getRuntimeStatus: () => runtime.getStatus(),
    subscribeRuntimeStatus: (listener) => runtime.subscribeStatus(listener),
  });
}

async function showMainWindow(): Promise<void> {
  if (mainWindow === undefined || mainWindow.isDestroyed()) {
    const candidate = createMainWindow();
    mainWindow = candidate;
    candidate.webContents.on('render-process-gone', () => handleRendererGone(candidate));
    try {
      await candidate.loadURL(`${appOrigin}/index.html`);
    } catch {
      try {
        if (!candidate.isDestroyed()) candidate.destroy();
      } catch {
        // The tray remains the recovery path even if a failed window is already unavailable.
      }
      if (mainWindow === candidate) mainWindow = undefined;
      throw new Error('RENDERER_UNAVAILABLE');
    }
  }
  mainWindow.show();
  mainWindow.focus();
}

async function openMainWindow(): Promise<void> {
  try {
    await showMainWindow();
  } catch {
    // A renderer can be recreated from the native tray; it is not a native startup failure.
    console.error('Catbots renderer unavailable');
  }
}

async function requestQuit(): Promise<void> {
  if (quitting) return;

  try {
    const result = e2eQuitResponse === undefined
      ? await dialog.showMessageBox({
        type: 'warning',
        title: 'Quit Catbots?',
        message: 'Quit Catbots?',
        detail: 'Catbots will stop its local runtime before quitting.',
        buttons: ['Quit Catbots', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      : { response: e2eQuitResponse };
    e2eQuitResponse = undefined;
    if (result.response !== 0) return;
  } catch {
    console.error('Catbots quit confirmation unavailable');
    return;
  }

  await quitApplication();
}

async function quitApplication(): Promise<void> {
  if (quitting) return;
  quitting = true;
  try {
    await shutdown();
  } finally {
    app.quit();
  }
}

function shutdown(): Promise<void> {
  if (shutdownPromise !== undefined) return shutdownPromise;

  shutdownPromise = (async () => {
    await disposeFlowConnections?.();
    await walletBridge?.close();
    await webServer?.close();
    disposeMarketUniverseRefresh();
    disposeNodeBacktests?.();
    try {
      await runtime.stop();
    } catch {
      console.error('Catbots runtime shutdown failed');
    }
    disposeTray();
    disposeRegisteredIpcHandlers();
    try {
      database.close();
    } catch {
      console.error('Catbots database shutdown failed');
    }
  })();
  return shutdownPromise;
}

function disposeMarketUniverseRefresh(): void {
  marketUniverseRefreshOwner?.abort();
  marketUniverseRefreshOwner = undefined;
  stopMarketUniverseRefresh?.();
  stopMarketUniverseRefresh = undefined;
}

function disposeTray(): void {
  const controller = tray;
  tray = undefined;
  try {
    controller?.dispose();
  } catch {
    console.error('Catbots tray shutdown failed');
  }
}

function disposeRegisteredIpcHandlers(): void {
  const dispose = disposeIpcHandlers;
  disposeIpcHandlers = undefined;
  try {
    dispose?.();
  } catch {
    console.error('Catbots IPC shutdown failed');
  }
}

function handleRendererGone(affectedWindow: BrowserWindow): void {
  if (mainWindow === affectedWindow) mainWindow = undefined;
  try {
    if (!affectedWindow.isDestroyed()) affectedWindow.destroy();
  } catch {
    // Runtime and tray ownership remain in Main even if renderer cleanup races native teardown.
  }
}
