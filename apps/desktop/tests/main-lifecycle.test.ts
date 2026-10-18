import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  let beforeQuitListener: ((event?: { preventDefault(): void }) => void) | undefined;
  let windowAllClosedListener: (() => void) | undefined;
  const app = {
    enableSandbox: vi.fn(),
    getPath: vi.fn(() => '/test-user-data'),
    getAppPath: vi.fn(() => '/test-app'),
    getVersion: vi.fn(),
    on: vi.fn((eventName: string, listener: (event?: { preventDefault(): void }) => void) => {
      if (eventName === 'window-all-closed') {
        windowAllClosedListener = listener as () => void;
      }
      if (eventName === 'before-quit') {
        beforeQuitListener = listener;
      }

      return app;
    }),
    once: vi.fn((eventName: string, listener: (event?: { preventDefault(): void }) => void) => {
      if (eventName === 'before-quit') {
        beforeQuitListener = listener;
      }

      return app;
    }),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    whenReady: vi.fn(() => new Promise<void>(() => undefined)),
  };
  const removeHandler = vi.fn();
  const handle = vi.fn();
  const showMessageBox = vi.fn();
  const setPermissionRequestHandler = vi.fn();
  const setPermissionCheckHandler = vi.fn();

  return {
    app,
    getBeforeQuitListener: () => beforeQuitListener,
    getWindowAllClosedListener: () => windowAllClosedListener,
    dialog: { showMessageBox },
    getRendererQuitHandler: () => handle.mock.calls.find(([channel]) => channel === 'app:quit-application')?.[1],
    handle,
    removeHandler,
    reset: () => {
      beforeQuitListener = undefined;
      windowAllClosedListener = undefined;
      app.enableSandbox.mockClear();
      app.getPath.mockClear();
      app.getAppPath.mockClear();
      app.on.mockClear();
      app.once.mockClear();
      app.requestSingleInstanceLock.mockReset();
      app.requestSingleInstanceLock.mockReturnValue(true);
      app.quit.mockClear();
      app.whenReady.mockClear();
      handle.mockClear();
      removeHandler.mockClear();
      showMessageBox.mockReset();
      showMessageBox.mockResolvedValue({ response: 1 });
      setPermissionCheckHandler.mockClear();
      setPermissionRequestHandler.mockClear();
    },
    ipcMain: { handle, removeHandler },
    session: { defaultSession: { setPermissionCheckHandler, setPermissionRequestHandler } },
  };
});

const applicationDatabase = vi.hoisted(() => {
  const start = vi.fn();
  const close = vi.fn();

  return {
    ApplicationDatabase: vi.fn(function ApplicationDatabaseMock() {
      return { close, start };
    }),
    close,
    reset: () => {
      start.mockReset();
      start.mockReturnValue({ status: 'ready', database: {} });
      close.mockClear();
    },
    start,
  };
});

const mainWindow = vi.hoisted(() => {
  let firstRenderGone: (() => void) | undefined;
  let replacementRenderGone: (() => void) | undefined;
  const loadURL = vi.fn();
  const first = {
    destroy: vi.fn(),
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    loadURL,
    show: vi.fn(),
    webContents: { on: vi.fn((eventName: string, listener: () => void) => { if (eventName === 'render-process-gone') firstRenderGone = listener; }) },
  };
  const replacement = {
    destroy: vi.fn(),
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(),
    show: vi.fn(),
    webContents: { on: vi.fn((eventName: string, listener: () => void) => { if (eventName === 'render-process-gone') replacementRenderGone = listener; }) },
  };
  const create = vi.fn(() => first);

  return {
    create,
    emitFirstRenderGone: () => firstRenderGone?.(),
    first,
    loadURL,
    replacement,
    reset: () => {
      create.mockReset();
      firstRenderGone = undefined;
      replacementRenderGone = undefined;
      create.mockReturnValue(first);
      loadURL.mockReset();
      first.destroy.mockReset();
      first.focus.mockReset();
      first.isDestroyed.mockReset();
      first.isDestroyed.mockReturnValue(false);
      first.show.mockReset();
      first.webContents.on.mockClear();
      replacement.focus.mockReset();
      replacement.destroy.mockReset();
      replacement.isDestroyed.mockReset();
      replacement.isDestroyed.mockReturnValue(false);
      replacement.loadURL.mockReset();
      replacement.show.mockReset();
      replacement.webContents.on.mockClear();
    },
  };
});

const runtime = vi.hoisted(() => {
  const start = vi.fn();
  const stop = vi.fn(async () => undefined);
  const getStatus = vi.fn(() => ({ state: 'stopped' as const, activeBots: 0 }));
  const subscribeStatus = vi.fn(() => () => undefined);
  const RuntimeSupervisor = vi.fn(function RuntimeSupervisorMock() {
    return { getStatus, start, stop, subscribeStatus };
  });

  return {
    RuntimeSupervisor,
    getStatus,
    start,
    stop,
    subscribeStatus,
    reset: () => {
      RuntimeSupervisor.mockClear();
      getStatus.mockClear();
      start.mockClear();
      stop.mockClear();
      subscribeStatus.mockClear();
    },
  };
});

const tray = vi.hoisted(() => {
  const dispose = vi.fn();
  const create = vi.fn((_options: unknown) => ({ dispose }));
  return {
    create,
    dispose,
    reset: () => {
      dispose.mockReset();
      create.mockReset();
      create.mockReturnValue({ dispose });
    },
  };
});

const llmTester = vi.hoisted(() => ({
  testLlmConnection: vi.fn(async () => ({ ok: true as const, model: 'fixture-model' })),
}));

const dataDirectory = vi.hoisted(() => {
  const isUnsignedDevelopmentBuild = vi.fn(() => false);
  const isUnsignedE2ETestProcess = vi.fn(() => false);
  const resolveApplicationDataDirectory = vi.fn(async (options: Readonly<{
    defaultDirectory: string;
    environment: NodeJS.ProcessEnv;
  }>) => options.defaultDirectory);
  return {
    isUnsignedDevelopmentBuild,
    isUnsignedE2ETestProcess,
    resolveApplicationDataDirectory,
    reset: () => {
      isUnsignedDevelopmentBuild.mockReset();
      isUnsignedDevelopmentBuild.mockReturnValue(false);
      isUnsignedE2ETestProcess.mockReset();
      isUnsignedE2ETestProcess.mockReturnValue(false);
      resolveApplicationDataDirectory.mockReset();
      resolveApplicationDataDirectory.mockImplementation(async (options) => options.defaultDirectory);
    },
  };
});

const hyperliquid = vi.hoisted(() => ({
  createPublicClient: vi.fn(() => ({ getMeta: vi.fn() })),
}));

const hyperliquidAdapter = vi.hoisted(() => {
  const getMarkets = vi.fn(async () => []);
  const HyperliquidAdapter = vi.fn(function HyperliquidAdapterMock() {
    return { getMarkets };
  });
  return { getMarkets, HyperliquidAdapter };
});

const universeCache = vi.hoisted(() => {
  const initialize = vi.fn(async (_signal: AbortSignal) => ({
    dex: 'hyperliquid', revision: 'sha256:lifecycle', observedAt: '2026-09-05T00:00:00.000Z', markets: [],
  }));
  const stopPeriodicRefresh = vi.fn(() => true);
  const startPeriodicRefresh = vi.fn((_signal: AbortSignal) => stopPeriodicRefresh);
  const MarketUniverseCache = vi.fn(function MarketUniverseCacheMock() {
    return { initialize, startPeriodicRefresh };
  });
  return {
    initialize, startPeriodicRefresh, stopPeriodicRefresh, MarketUniverseCache,
    reset: () => {
      initialize.mockClear();
      startPeriodicRefresh.mockClear();
      stopPeriodicRefresh.mockClear();
      MarketUniverseCache.mockClear();
    },
  };
});

vi.mock('electron', () => electron);
vi.mock('../src/main/create-window', () => ({ createMainWindow: mainWindow.create }));
vi.mock('../src/main/register-app-protocol', () => ({ registerAppProtocol: vi.fn() }));
vi.mock('../src/main/storage/database', () => applicationDatabase);
vi.mock('../src/main/runtime/runtime-supervisor', () => ({ RuntimeSupervisor: runtime.RuntimeSupervisor }));
vi.mock('../src/main/tray/create-tray', () => ({ createTray: tray.create }));
vi.mock('../src/main/llm/test-llm-connection', () => llmTester);
vi.mock('../src/main/execution/market-universe-cache', () => ({ MarketUniverseCache: universeCache.MarketUniverseCache }));
vi.mock('../src/main/data-directory', () => dataDirectory);
vi.mock('../src/main/execution/hyperliquid/hyperliquid-client', () => ({
  createHyperliquidPublicClient: hyperliquid.createPublicClient,
}));
vi.mock('../src/main/execution/hyperliquid/hyperliquid-adapter', () => ({
  HyperliquidAdapter: hyperliquidAdapter.HyperliquidAdapter,
}));

describe('main window lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
    electron.reset();
    applicationDatabase.reset();
    mainWindow.reset();
    runtime.reset();
    tray.reset();
    llmTester.testLlmConnection.mockClear();
    dataDirectory.reset();
    hyperliquid.createPublicClient.mockClear();
    hyperliquidAdapter.HyperliquidAdapter.mockClear();
    hyperliquidAdapter.getMarkets.mockClear();
    universeCache.reset();
    vi.unstubAllEnvs();
  });

  it('exits a losing process before constructing the application database', async () => {
    electron.app.requestSingleInstanceLock.mockReturnValueOnce(false);

    await import('../src/main/main');

    expect(electron.app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(applicationDatabase.ApplicationDatabase).not.toHaveBeenCalled();
    expect(electron.app.quit).toHaveBeenCalledOnce();
  });

  it('acquires ownership before constructing the application database', async () => {
    await import('../src/main/main');

    expect(electron.app.requestSingleInstanceLock.mock.invocationCallOrder[0])
      .toBeLessThan(applicationDatabase.ApplicationDatabase.mock.invocationCallOrder[0]);
  });

  it('keeps the application process alive when the last window closes', async () => {
    await import('../src/main/main');

    const listener = electron.getWindowAllClosedListener();
    expect(listener).toBeTypeOf('function');

    listener?.();

    expect(electron.app.quit).not.toHaveBeenCalled();
  });

  it('installs the deny-all M0 permission policy before opening a renderer', async () => {
    electron.app.whenReady.mockResolvedValueOnce(undefined);

    await import('../src/main/main');
    await vi.waitFor(() => expect(mainWindow.first.show).toHaveBeenCalledOnce());

    expect(electron.session.defaultSession.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(electron.session.defaultSession.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(electron.session.defaultSession.setPermissionRequestHandler.mock.invocationCallOrder[0])
      .toBeLessThan(mainWindow.first.show.mock.invocationCallOrder[0]);
  });

  it('initializes periodic universe refresh at startup and cancels its owner on shutdown', async () => {
    electron.app.whenReady.mockResolvedValueOnce(undefined);
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });

    await import('../src/main/main');
    await vi.waitFor(() => expect(mainWindow.first.show).toHaveBeenCalledOnce());

    expect(universeCache.initialize).toHaveBeenCalledOnce();
    expect(universeCache.startPeriodicRefresh).toHaveBeenCalledOnce();
    const initializedSignal = universeCache.initialize.mock.calls[0]?.[0];
    const periodicSignal = universeCache.startPeriodicRefresh.mock.calls[0]?.[0];
    expect(periodicSignal).toBe(initializedSignal);
    expect(periodicSignal?.aborted).toBe(false);

    const options = tray.create.mock.calls[0]?.[0] as { quit(): Promise<void> };
    await options.quit();

    expect(periodicSignal?.aborted).toBe(true);
    expect(universeCache.stopPeriodicRefresh).toHaveBeenCalledOnce();
  });

  it('uses the public Hyperliquid universe client during normal startup', async () => {
    electron.app.whenReady.mockResolvedValueOnce(undefined);

    await import('../src/main/main');
    await vi.waitFor(() => expect(mainWindow.first.show).toHaveBeenCalledOnce());

    expect(hyperliquid.createPublicClient).toHaveBeenCalledOnce();
    expect(hyperliquidAdapter.HyperliquidAdapter).toHaveBeenCalledOnce();
  });

  it('uses a deterministic local universe without constructing a public client in a validated E2E session', async () => {
    const isolatedDirectory = '/private/tmp/catbots-e2e-abcdef';
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CATBOTS_E2E_DATA_DIR', isolatedDirectory);
    dataDirectory.isUnsignedDevelopmentBuild.mockReturnValue(true);
    dataDirectory.isUnsignedE2ETestProcess.mockReturnValue(true);
    dataDirectory.resolveApplicationDataDirectory.mockResolvedValue(isolatedDirectory);
    electron.app.whenReady.mockResolvedValueOnce(undefined);

    await import('../src/main/main');
    await vi.waitFor(() => expect(mainWindow.first.show).toHaveBeenCalledOnce());

    expect(hyperliquid.createPublicClient).not.toHaveBeenCalled();
    expect(hyperliquidAdapter.HyperliquidAdapter).not.toHaveBeenCalled();
    const cacheOptions = (universeCache.MarketUniverseCache.mock.calls as unknown as Array<[{
      adapter: { getMarkets(signal: AbortSignal): Promise<readonly unknown[]> };
    }]>)[0]![0];
    await expect(cacheOptions.adapter.getMarkets(new AbortController().signal)).resolves.toEqual([
      { market: 'BTC-PERP', baseAsset: 'BTC', quoteAsset: 'USDC', active: true, sizeDecimals: 5, maximumLeverage: 40 },
      { market: 'ETH-PERP', baseAsset: 'ETH', quoteAsset: 'USDC', active: true, sizeDecimals: 4, maximumLeverage: 30 },
    ]);
    expect(universeCache.initialize).toHaveBeenCalledOnce();
    expect(universeCache.startPeriodicRefresh).toHaveBeenCalledOnce();
  });

  it('does not enable the local universe when the requested E2E directory was not accepted', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CATBOTS_E2E_DATA_DIR', '/private/tmp/catbots-e2e-abcdef');
    dataDirectory.isUnsignedDevelopmentBuild.mockReturnValue(true);
    dataDirectory.isUnsignedE2ETestProcess.mockReturnValue(true);
    dataDirectory.resolveApplicationDataDirectory.mockResolvedValue('/test-user-data');
    electron.app.whenReady.mockResolvedValueOnce(undefined);

    await import('../src/main/main');
    await vi.waitFor(() => expect(mainWindow.first.show).toHaveBeenCalledOnce());

    expect(hyperliquid.createPublicClient).toHaveBeenCalledOnce();
    expect(hyperliquidAdapter.HyperliquidAdapter).toHaveBeenCalledOnce();
  });

  it('opens offline, starts periodic universe recovery, and reports no network details', async () => {
    const secret = 'provider network failure api-key=secret-sentinel';
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    universeCache.initialize.mockRejectedValueOnce(new Error(secret));
    electron.app.whenReady.mockResolvedValueOnce(undefined);
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });

    await import('../src/main/main');
    await vi.waitFor(() => expect(mainWindow.first.show).toHaveBeenCalledOnce());

    expect(runtime.start).toHaveBeenCalledOnce();
    expect(universeCache.startPeriodicRefresh).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith('Catbots universe metadata unavailable');
    expect(JSON.stringify(report.mock.calls)).not.toContain(secret);
    expect(electron.app.quit).not.toHaveBeenCalled();

    const periodicSignal = universeCache.startPeriodicRefresh.mock.calls[0]?.[0];
    const options = tray.create.mock.calls[0]?.[0] as { quit(): Promise<void> };
    await options.quit();
    expect(periodicSignal?.aborted).toBe(true);
    expect(universeCache.stopPeriodicRefresh).toHaveBeenCalledOnce();
  });

  it('keeps intercepting native Quit after a cancellation and then performs ordered cleanup', async () => {
    electron.app.whenReady.mockResolvedValueOnce(undefined);
    electron.dialog.showMessageBox
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 0 });

    await import('../src/main/main');
    await vi.waitFor(() => expect(tray.create).toHaveBeenCalledOnce());
    expect(electron.app.on).toHaveBeenCalledWith('before-quit', expect.any(Function));
    const beforeQuit = electron.getBeforeQuitListener();
    const firstEvent = { preventDefault: vi.fn() };
    beforeQuit?.(firstEvent);
    await vi.waitFor(() => expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1));
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(runtime.stop).not.toHaveBeenCalled();

    const secondEvent = { preventDefault: vi.fn() };
    beforeQuit?.(secondEvent);
    await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalledOnce());
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.stop.mock.invocationCallOrder[0]).toBeLessThan(applicationDatabase.close.mock.invocationCallOrder[0]);
    expect(applicationDatabase.close.mock.invocationCallOrder[0]).toBeLessThan(electron.app.quit.mock.invocationCallOrder[0]);
  });

  it('injects the Main-owned compatible-provider connection tester', async () => {
    electron.app.whenReady.mockResolvedValueOnce(undefined);

    await import('../src/main/main');
    await vi.waitFor(() => expect(tray.create).toHaveBeenCalledOnce());
    const testConnection = electron.handle.mock.calls.find(([channel]) => channel === 'config:test-llm')?.[1] as
      | ((event: Electron.IpcMainInvokeEvent, input: unknown) => Promise<unknown>)
      | undefined;
    const input = {
      profile: { name: 'Fixture', telemetry: false },
      llm: {
        provider: 'openai-compatible',
        baseUrl: 'https://provider.example/v1',
        apiKey: 'main-process-only-secret',
        model: 'fixture-model',
      },
    };

    await expect(testConnection?.(
      { senderFrame: { url: 'catbots://app/index.html' } } as Electron.IpcMainInvokeEvent,
      input,
    )).resolves.toEqual({ ok: true, model: 'fixture-model' });
    expect(llmTester.testLlmConnection).toHaveBeenCalledWith(input.llm);
  });

  it('keeps native resources alive when the initial renderer load fails and Open retries it', async () => {
    const secret = 'renderer load failure containing a secret';
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mainWindow.create.mockReturnValueOnce(mainWindow.first).mockReturnValueOnce(mainWindow.replacement);
    mainWindow.loadURL.mockRejectedValueOnce(new Error(secret));
    electron.app.whenReady.mockResolvedValueOnce(undefined);

    await import('../src/main/main');
    await vi.waitFor(() => {
      expect(report).toHaveBeenCalledWith('Catbots renderer unavailable');
    });

    expect(electron.app.quit).not.toHaveBeenCalled();
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(tray.create).toHaveBeenCalledOnce();
    expect(JSON.stringify(report.mock.calls)).not.toContain(secret);

    const options = tray.create.mock.calls[0]?.[0] as { showWindow(): Promise<void> };
    await options.showWindow();

    expect(mainWindow.replacement.loadURL).toHaveBeenCalledWith('catbots://app/index.html');
    expect(mainWindow.replacement.show).toHaveBeenCalledOnce();
  });

  it('requires a native cancellation-safe confirmation for renderer and tray Quit requests', async () => {
    electron.app.whenReady.mockResolvedValueOnce(undefined);

    await import('../src/main/main');
    await vi.waitFor(() => expect(tray.create).toHaveBeenCalledOnce());
    const rendererQuit = electron.getRendererQuitHandler() as (event: Electron.IpcMainInvokeEvent) => Promise<void>;
    const trayOptions = tray.create.mock.calls[0]?.[0] as { quit(): Promise<void> };

    await rendererQuit({ senderFrame: { url: 'catbots://app/index.html' } } as Electron.IpcMainInvokeEvent);
    await trayOptions.quit();

    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(electron.app.quit).not.toHaveBeenCalled();
  });

  it('uses the same native confirmation before a renderer Quit can stop the app', async () => {
    electron.app.whenReady.mockResolvedValueOnce(undefined);
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });

    await import('../src/main/main');
    await vi.waitFor(() => expect(tray.create).toHaveBeenCalledOnce());
    const rendererQuit = electron.getRendererQuitHandler() as (event: Electron.IpcMainInvokeEvent) => Promise<void>;
    await rendererQuit({ senderFrame: { url: 'catbots://app/index.html' } } as Electron.IpcMainInvokeEvent);

    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      buttons: ['Quit Catbots', 'Cancel'],
      cancelId: 1,
      message: 'Quit Catbots?',
    }));
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(electron.app.quit).toHaveBeenCalledOnce();
  });

  it('stops runtime, IPC, and database in order before a confirmed native Quit', async () => {
    electron.app.whenReady.mockResolvedValueOnce(undefined);
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });

    await import('../src/main/main');
    await vi.waitFor(() => expect(tray.create).toHaveBeenCalledOnce());
    const options = tray.create.mock.calls[0]?.[0] as { quit(): Promise<void> };
    await options.quit();

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(tray.dispose).toHaveBeenCalledOnce();
    expect(applicationDatabase.close).toHaveBeenCalledOnce();
    expect(electron.removeHandler).toHaveBeenCalledTimes(24);
    expect(runtime.stop.mock.invocationCallOrder[0]).toBeLessThan(electron.removeHandler.mock.invocationCallOrder[0]);
    expect(runtime.stop.mock.invocationCallOrder[0]).toBeLessThan(tray.dispose.mock.invocationCallOrder[0]);
    expect(tray.dispose.mock.invocationCallOrder[0]).toBeLessThan(electron.removeHandler.mock.invocationCallOrder[0]);
    expect(electron.removeHandler.mock.invocationCallOrder[0]).toBeLessThan(applicationDatabase.close.mock.invocationCallOrder[0]);
    expect(applicationDatabase.close.mock.invocationCallOrder[0]).toBeLessThan(electron.app.quit.mock.invocationCallOrder[0]);
  });

  it('recreates a destroyed window from the tray Open action', async () => {
    electron.app.whenReady.mockResolvedValueOnce(undefined);

    await import('../src/main/main');
    await vi.waitFor(() => expect(tray.create).toHaveBeenCalledOnce());
    mainWindow.first.isDestroyed.mockReturnValue(true);
    mainWindow.create.mockReturnValueOnce(mainWindow.replacement);

    const options = tray.create.mock.calls[0]?.[0] as { showWindow(): Promise<void> };
    await options.showWindow();

    expect(mainWindow.create).toHaveBeenCalledTimes(2);
    expect(mainWindow.replacement.loadURL).toHaveBeenCalledWith('catbots://app/index.html');
    expect(mainWindow.replacement.show).toHaveBeenCalledOnce();
    expect(mainWindow.replacement.focus).toHaveBeenCalledOnce();
  });

  it('destroys and clears a crashed renderer while retaining runtime and tray for Open recovery', async () => {
    electron.app.whenReady.mockResolvedValueOnce(undefined);
    mainWindow.create.mockReturnValueOnce(mainWindow.first).mockReturnValueOnce(mainWindow.replacement);

    await import('../src/main/main');
    await vi.waitFor(() => expect(mainWindow.first.show).toHaveBeenCalledOnce());
    mainWindow.emitFirstRenderGone();

    expect(mainWindow.first.destroy).toHaveBeenCalledOnce();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(tray.create).toHaveBeenCalledOnce();
    expect(electron.app.quit).not.toHaveBeenCalled();

    const options = tray.create.mock.calls[0]?.[0] as { showWindow(): Promise<void> };
    await options.showWindow();
    expect(mainWindow.create).toHaveBeenCalledTimes(2);
    expect(mainWindow.replacement.loadURL).toHaveBeenCalledWith('catbots://app/index.html');
  });

  it('continues to final app quit when IPC disposal and database cleanup throw', async () => {
    const secret = 'cleanup secret';
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    electron.app.whenReady.mockResolvedValueOnce(undefined);
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    electron.removeHandler.mockImplementationOnce(() => { throw new Error(secret); });
    applicationDatabase.close.mockImplementationOnce(() => { throw new Error(secret); });

    await import('../src/main/main');
    await vi.waitFor(() => expect(tray.create).toHaveBeenCalledOnce());
    const options = tray.create.mock.calls[0]?.[0] as { quit(): Promise<void> };
    await options.quit();

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(applicationDatabase.close).toHaveBeenCalledOnce();
    expect(electron.removeHandler).toHaveBeenCalledTimes(24);
    expect(electron.app.quit).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith('Catbots IPC shutdown failed');
    expect(report).toHaveBeenCalledWith('Catbots database shutdown failed');
    expect(JSON.stringify(report.mock.calls)).not.toContain(secret);
  });

  it('closes resources, reports safely, and quits when startup fails', async () => {
    const secret = 'database failure containing a secret';
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    applicationDatabase.start.mockImplementationOnce(() => {
      throw new Error(secret);
    });
    electron.app.whenReady.mockResolvedValueOnce(undefined);

    await import('../src/main/main');
    await vi.waitFor(() => {
      expect(electron.app.quit).toHaveBeenCalledOnce();
    });

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(applicationDatabase.close).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith('Catbots fatal startup error (database)');
    expect(JSON.stringify(report.mock.calls)).not.toContain(secret);
  });

  it('opens a trusted repair renderer with only fixed-status and Quit IPC when migration fails', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    report.mockClear();
    applicationDatabase.start.mockReturnValueOnce({
      status: 'repair', code: 'DATABASE_MIGRATION_FAILED',
    });
    electron.app.whenReady.mockResolvedValueOnce(undefined);

    await import('../src/main/main');
    await vi.waitFor(() => expect(mainWindow.first.show).toHaveBeenCalledOnce());

    expect(electron.app.quit).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(tray.create).toHaveBeenCalledOnce();
    expect(electron.handle.mock.calls.map(([channel]) => channel)).toEqual([
      'app:quit-application',
      'runtime:get-database-state',
    ]);
    const getDatabaseState = electron.handle.mock.calls.find(([channel]) => channel === 'runtime:get-database-state')?.[1] as
      ((event: Electron.IpcMainInvokeEvent) => Promise<unknown>) | undefined;
    await expect(getDatabaseState?.(
      { senderFrame: { url: 'catbots://app/index.html' } } as Electron.IpcMainInvokeEvent,
    )).resolves.toEqual({ status: 'repair', code: 'DATABASE_MIGRATION_FAILED' });
    expect(report).not.toHaveBeenCalledWith(expect.stringContaining('Catbots fatal startup error'));
  });

});
