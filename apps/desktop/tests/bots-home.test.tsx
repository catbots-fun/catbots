// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotSummary, CatbotsDesktopApi, CreateDraftBotInput, RedactedLocalConfig } from '@catbots/contracts';
import App from '../src/renderer/App';
import { AppShell } from '../src/renderer/components/AppShell';
import { BotsHomeScreen, formatUpdatedAt } from '../src/renderer/screens/BotsHomeScreen';
import { CreateDraftBotDialog } from '../src/renderer/screens/CreateDraftBotDialog';

const draftBot: BotSummary = {
  id: '018f47a2-4a2a-7c5d-9b61-3a83f64406a8',
  name: 'BTC Flow',
  dex: 'hyperliquid',
  status: 'draft',
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
};

const existingBot: BotSummary = {
  ...draftBot,
  id: '018f47a2-4a2a-7c5d-9b61-3a83f64406a9',
  name: 'ETH Flow',
};

const redactedConfig: RedactedLocalConfig = {
  profile: { name: 'My Trading', telemetry: false },
  llm: { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: '••••••••', model: 'provider/model' },
  exchanges: {},
};

function makeApi(overrides: Partial<CatbotsDesktopApi['bots']> = {}): CatbotsDesktopApi['bots'] {
  return {
    list: vi.fn().mockResolvedValue([]),
    createDraft: vi.fn().mockImplementation(async (input: CreateDraftBotInput) => ({ ...draftBot, ...input })),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function makeDesktopApi(bootstrap: Awaited<ReturnType<CatbotsDesktopApi['config']['getBootstrapState']>>): CatbotsDesktopApi {
  return {
    app: { getVersion: vi.fn().mockResolvedValue('0.1.0'), showMainWindow: vi.fn(), quitApplication: vi.fn() },
    config: {
      getBootstrapState: vi.fn().mockResolvedValue(bootstrap),
      patchSettings: vi.fn().mockResolvedValue(redactedConfig),
      testLlmConnection: vi.fn().mockResolvedValue({ ok: true, model: 'provider/model' }),
    },
    bots: makeApi(),
    workbench: {
      get: vi.fn(),
      stopAgent: vi.fn(async () => undefined), sendMessage: vi.fn(),
      runBacktest: vi.fn(),
      approveRevision: vi.fn(),
      getTrace: vi.fn(),
      subscribeActivity: vi.fn(() => () => undefined),
    },
    deployments: {
      startPaper: vi.fn(),
      getPaper: vi.fn(),
      pausePaper: vi.fn(),
      stopPaper: vi.fn(),
      prepareLive: vi.fn(), startLive: vi.fn(), getLive: vi.fn(), stopLive: vi.fn(), getActive: vi.fn().mockResolvedValue(null),
    },
    runtime: { getStatus: vi.fn(), getDatabaseState: vi.fn().mockResolvedValue({ status: 'ready' }), subscribeStatus: vi.fn(() => () => undefined) },
  };
}

async function saveProviderSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Profile name'), 'My Trading');
  await user.type(screen.getByLabelText('Base URL'), 'https://api.example.com/v1');
  await user.type(screen.getByLabelText('API key'), 'renderer-only-secret');
  await user.type(screen.getByLabelText('Model'), 'provider/model');
  await user.click(screen.getByRole('button', { name: 'Test connection' }));
  await screen.findByText('Connection successful');
  await user.click(screen.getByRole('button', { name: /Create local profile|Save settings/ }));
}

async function connectFirstLaunchProvider(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Profile name'), 'My Trading');
  await user.type(screen.getByLabelText('Base URL'), 'https://api.example.com/v1');
  await user.type(screen.getByLabelText('API key'), 'renderer-only-secret');
  await user.type(screen.getByLabelText('Model'), 'provider/model');
  await user.click(screen.getByRole('button', { name: 'Connect & continue' }));
}

describe('BotsHomeScreen', () => {
  afterEach(cleanup);

  it('combines name and status filters and clears an empty result', async () => {
    const user = userEvent.setup();
    render(<BotsHomeScreen api={makeApi({ list: vi.fn().mockResolvedValue([draftBot, { ...existingBot, status: 'paper' }]) })} />);
    await screen.findByRole('button', { name: 'BTC Flow' });
    await user.type(screen.getByRole('textbox', { name: 'Search bots' }), 'eth');
    expect(screen.queryByRole('button', { name: 'BTC Flow' })).toBeNull();
    expect(screen.getByRole('button', { name: 'ETH Flow' })).toBeTruthy();
    await user.click(screen.getByRole('combobox', { name: 'Filter by status' }));
    await user.click(await screen.findByRole('option', { name: 'Draft' }));
    expect(screen.getByRole('heading', { name: 'No matching bots' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('button', { name: 'BTC Flow' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ETH Flow' })).toBeTruthy();
  });

  it('keeps navigation accessible while the sidebar is collapsed', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    render(<AppShell destination="bots" onNavigate={navigate}>Workspace content</AppShell>);
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(navigate).toHaveBeenCalledWith('settings');
  });

  it('shows only the approved accessible fields and submits the selected DEX from the keyboard', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    render(<CreateDraftBotDialog api={api} open onOpenChange={vi.fn()} onCreated={vi.fn()} />);

    const nameInput = screen.getByLabelText('Bot name');
    const dexSelect = screen.getByRole('combobox', { name: 'DEX' });
    expect(nameInput).toBeTruthy();
    expect(dexSelect.textContent).toContain('Hyperliquid');
    expect(screen.queryByLabelText('Market')).toBeNull();
    expect(document.body.textContent).not.toMatch(/coming soon|future DEX|later milestones/i);

    dexSelect.focus();
    await user.keyboard('{Enter}');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain('Hyperliquid');
    await user.keyboard('{Escape}');

    nameInput.focus();
    await user.type(nameInput, 'ETH RSI{Enter}');
    expect(api.createDraft).toHaveBeenCalledWith({ name: 'ETH RSI', dex: 'hyperliquid' });
  });

  it('labels and renders Bot DEX identity without a Market column', async () => {
    render(<BotsHomeScreen api={makeApi({ list: vi.fn().mockResolvedValue([existingBot]) })} />);

    const table = await screen.findByRole('table', { name: 'Local bots' });
    expect(within(table).getByRole('columnheader', { name: 'DEX' })).toBeTruthy();
    expect(within(table).getByText('Hyperliquid')).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: 'Market' })).toBeNull();
  });

  it('creates a local draft and shows it on Bots Home', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    render(<BotsHomeScreen api={api} />);

    await user.click(await screen.findByRole('button', { name: 'Create new bot' }));
    await user.type(screen.getByLabelText('Bot name'), 'BTC Flow');
    await user.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(await screen.findByText('BTC Flow')).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Local bots' })).getByText('Draft')).toBeTruthy();
    expect(api.createDraft).toHaveBeenCalledWith({ name: 'BTC Flow', dex: 'hyperliquid' });
    expect(screen.getByRole('columnheader', { name: 'Account position' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Account orders' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Local bots' }).parentElement?.className).toContain('ring-kumo-line');
  });

  it('renders an accessible loading state before the local list arrives', () => {
    const pending = deferred<BotSummary[]>();
    render(<BotsHomeScreen api={makeApi({ list: vi.fn().mockReturnValue(pending.promise) })} />);

    expect(screen.getByRole('status').textContent).toContain('Loading local bots…');
  });

  it('renders an accessible empty state and a fixed safe list failure', async () => {
    const user = userEvent.setup();
    const list = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('database /Users/secret/db.sqlite')).mockResolvedValueOnce([]);
    const { rerender } = render(<BotsHomeScreen api={makeApi({ list })} />);
    await screen.findByRole('heading', { name: /One idea\.\s*Every rule visible\./ });
    expect(screen.getByRole('region', { name: /One idea\.\s*Every rule visible\./ })).toBeTruthy();
    expect(screen.getByText('No bots yet')).toBeTruthy();

    rerender(<BotsHomeScreen api={makeApi({ list })} />);
    expect((await screen.findByRole('alert')).textContent).toContain('We could not load local bots. Try again.');
    expect(document.body.textContent).not.toContain('/Users/secret/db.sqlite');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(list).toHaveBeenCalledTimes(3);
    expect(await screen.findByRole('heading', { name: /One idea\.\s*Every rule visible\./ })).toBeTruthy();
  });

  it('merges a draft created while the initial list request is pending', async () => {
    const user = userEvent.setup();
    const list = deferred<BotSummary[]>();
    render(<BotsHomeScreen api={makeApi({ list: vi.fn().mockReturnValue(list.promise) })} />);

    await user.click(screen.getByRole('button', { name: 'Create new bot' }));
    await user.type(screen.getByLabelText('Bot name'), 'BTC Flow');
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    await screen.findByText('BTC Flow');
    await act(async () => list.resolve([existingBot]));

    expect(await screen.findByText('ETH Flow')).toBeTruthy();
    expect(screen.getAllByText('BTC Flow')).toHaveLength(1);
  });

  it('retains a confirmed draft when a pending list request fails, then reconciles it without duplicates on retry', async () => {
    const user = userEvent.setup();
    const initialList = deferred<BotSummary[]>();
    const list = vi.fn().mockReturnValueOnce(initialList.promise).mockResolvedValueOnce([draftBot]);
    render(<BotsHomeScreen api={makeApi({ list })} />);

    await user.click(screen.getByRole('button', { name: 'Create new bot' }));
    await user.type(screen.getByLabelText('Bot name'), 'BTC Flow');
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    await screen.findByText('BTC Flow');
    await act(async () => initialList.reject(new Error('dependency detail /Users/secret/catbots.db')));

    expect(screen.getByText('BTC Flow')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('We could not load local bots. Try again.');
    expect(document.body.textContent).not.toContain('dependency detail /Users/secret/catbots.db');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(list).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('BTC Flow')).toBeTruthy();
    expect(screen.getAllByText('BTC Flow')).toHaveLength(1);
  });

  it('prevents duplicate draft requests, uses fixed failure copy, and keeps field values after failure', async () => {
    const user = userEvent.setup();
    const pending = deferred<BotSummary>();
    const createDraft = vi.fn().mockReturnValue(pending.promise);
    render(<BotsHomeScreen api={makeApi({ createDraft })} />);

    await user.click(await screen.findByRole('button', { name: 'Create new bot' }));
    await user.type(screen.getByLabelText('Bot name'), 'BTC Flow');
    fireEvent.submit(screen.getByRole('button', { name: 'Create draft' }).closest('form')!);
    fireEvent.submit(screen.getByRole('button', { name: /Create draft/ }).closest('form')!);
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Bot name') as HTMLInputElement).disabled).toBe(true);

    await act(async () => pending.reject(new Error('hostile dependency detail')));
    expect(screen.getByRole('alert').textContent).toContain('We could not create this draft. Review the local values and try again.');
    expect((screen.getByLabelText('Bot name') as HTMLInputElement).value).toBe('BTC Flow');
    expect(document.body.textContent).not.toContain('hostile dependency detail');
  });

  it('does not call onCreated when a draft request settles after its dialog unmounts', async () => {
    const user = userEvent.setup();
    const createDraft = deferred<BotSummary>();
    const onCreated = vi.fn();
    const view = render(<CreateDraftBotDialog api={makeApi({ createDraft: vi.fn().mockReturnValue(createDraft.promise) })} open onOpenChange={vi.fn()} onCreated={onCreated} />);
    await user.type(screen.getByLabelText('Bot name'), 'BTC Flow');
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    view.unmount();
    await act(async () => createDraft.resolve(draftBot));

    expect(onCreated).not.toHaveBeenCalled();
  });

  it('does not let an obsolete list request overwrite a newer observable screen state', async () => {
    const staleList = deferred<BotSummary[]>();
    const currentList = deferred<BotSummary[]>();
    const { rerender } = render(<BotsHomeScreen api={makeApi({ list: vi.fn().mockReturnValue(staleList.promise) })} />);
    rerender(<BotsHomeScreen api={makeApi({ list: vi.fn().mockReturnValue(currentList.promise) })} />);
    await act(async () => currentList.resolve([existingBot]));
    await screen.findByText('ETH Flow');
    await act(async () => staleList.resolve([draftBot]));

    expect(screen.getByText('ETH Flow')).toBeTruthy();
    expect(screen.queryByText('BTC Flow')).toBeNull();
  });

  it('formats updated timestamps with a deterministic locale, date, and time-zone label', () => {
    expect(formatUpdatedAt('2026-09-03T12:34:00.000Z', 'en-US', 'UTC')).toBe('Updated Sep 3, 2026, 12:34 PM UTC');
  });
});

describe('AppShell', () => {
  afterEach(cleanup);

  it('exposes only the approved global navigation destinations with a non-color active indicator', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<AppShell destination="bots" onNavigate={onNavigate}><p>Workspace</p></AppShell>);

    expect(screen.getByRole('list', { name: 'Global navigation' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Global navigation' }).querySelectorAll('button').length).toBe(6);
    expect(screen.getByRole('button', { name: 'Bots' }).getAttribute('data-active')).toBe('true');
    for (const destination of ['Bots', 'Nodes', 'Data', 'Activity', 'Settings']) {
      expect(screen.getByRole('button', { name: destination })).toBeTruthy();
    }
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onNavigate).toHaveBeenCalledWith('settings');
  });
});

describe('App', () => {
  afterEach(() => { cleanup(); delete (window as Partial<Window>).catbots; });

  it('renders from an injected preview API without an Electron preload global', async () => {
    delete (window as Partial<Window>).catbots;

    render(<App api={makeDesktopApi({ state: 'ready', config: redactedConfig })} preview />);

    expect(await screen.findByRole('heading', { name: 'Bots' })).toBeTruthy();
    expect(screen.getByText('Web preview · simulated API · simulated data')).toBeTruthy();
    expect(document.body.textContent).not.toContain('temporary');
  });

  it('renders a ready profile in the shell and keeps one main landmark when Settings is selected', async () => {
    const user = userEvent.setup();
    window.catbots = makeDesktopApi({ state: 'ready', config: redactedConfig });
    render(<App api={window.catbots} />);

    await screen.findByRole('heading', { name: 'Bots' });
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.getAllByRole('main').length).toBe(1);
    expect(screen.getByRole('region', { name: 'Local settings' }).className).toContain('ring-kumo-line');
  });

  it('tests, saves, and moves first launch into the shell with one primary action', async () => {
    const user = userEvent.setup();
    window.catbots = makeDesktopApi({ state: 'first-launch' });
    render(<App api={window.catbots} />);

    await screen.findByRole('heading', { name: 'Connect your AI provider' });
    await connectFirstLaunchProvider(user);
    expect(await screen.findByRole('heading', { name: 'Bots' })).toBeTruthy();
  });

  it('moves configuration repair into the shell after saving repaired settings', async () => {
    const user = userEvent.setup();
    window.catbots = makeDesktopApi({ state: 'repair', issues: [{ path: 'config', message: 'safe copy only' }] });
    render(<App api={window.catbots} />);

    await screen.findByText('Configuration repair');
    await saveProviderSettings(user);
    expect(await screen.findByRole('heading', { name: 'Bots' })).toBeTruthy();
  });

  it('shows fixed database repair guidance and exposes only Quit when migration failed', async () => {
    const user = userEvent.setup();
    const api = makeDesktopApi({ state: 'ready', config: redactedConfig });
    vi.mocked(api.runtime.getDatabaseState).mockResolvedValue({
      status: 'repair', code: 'DATABASE_MIGRATION_FAILED',
    });
    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: 'Local database needs repair' })).toBeTruthy();
    expect(screen.getByText('Your local records were left unchanged.')).toBeTruthy();
    expect(api.config.getBootstrapState).not.toHaveBeenCalled();
    expect(screen.queryByRole('navigation', { name: 'Global navigation' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Quit Catbots' }));
    expect(api.app.quitApplication).toHaveBeenCalledOnce();
  });
});
